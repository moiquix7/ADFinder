import { basename, join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { currentState, onAuthChange, restoreSession, signIn, signOut } from './auth'
import { getWorkItemWithPullRequests, search } from './azdo'
import { addWorkItemComment, getWorkItemComments, getWorkItemHistory, isOrganizationUrl } from './workItem'
import { downloadToFile, requestScope } from './http'
import { listCollaborators, searchCollaborators } from './people'
import { appConfig, WINDOW_TITLE, WORK_ITEM_TYPES } from './config'
import { getAccent, getTheme, saveAccent, saveTheme, WINDOW_CHROME } from './settings'
import { isAccentColor, type IpcResult, type SearchOptions, type SearchScope, type ThemeMode } from '../shared/types'

/** Lo que llega del renderer no es de fiar: lo que falte cuenta como marcado. */
function sanitizeScope(scope: Partial<SearchScope> | undefined): SearchScope {
  const types = Array.isArray(scope?.workItemTypes) ? scope.workItemTypes : WORK_ITEM_TYPES
  return {
    title: scope?.title !== false,
    description: scope?.description !== false,
    collaborator: scope?.collaborator !== false,
    discussion: scope?.discussion !== false,
    attachments: scope?.attachments !== false,
    pullRequestNumber: scope?.pullRequestNumber !== false,
    commitHash: scope?.commitHash !== false,
    workItemTypes: WORK_ITEM_TYPES.filter((type) => types.includes(type))
  }
}

const isDev = !app.isPackaged

/**
 * En el ejecutable el icono lo incrusta electron-builder desde build/icon.png.
 * En desarrollo hay que pasarlo a mano o Electron usa el suyo por defecto.
 */
const devIcon = join(__dirname, '../../build/icon.png')

let mainWindow: BrowserWindow | null = null

/** Solo se permite abrir http(s) en el navegador; cualquier otro esquema se descarta. */
function isHttpUrl(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol)
  } catch {
    return false
  }
}

async function guard<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function applyTheme(theme: ThemeMode): void {
  nativeTheme.themeSource = theme
  const chrome = WINDOW_CHROME[theme]
  for (const window of BrowserWindow.getAllWindows()) {
    window.setBackgroundColor(chrome.background)
    window.setTitleBarOverlay?.({ color: chrome.bar, symbolColor: chrome.symbols, height: 40 })
  }
}

function createWindow(): BrowserWindow {
  const theme = getTheme()
  const chrome = WINDOW_CHROME[theme]

  const window = new BrowserWindow({
    title: WINDOW_TITLE,
    // Formato widget 10 x 15 (proporción 2:3), no a pantalla completa.
    width: 420,
    height: 630,
    minWidth: 340,
    minHeight: 460,
    show: false,
    ...(isDev ? { icon: devIcon } : {}),
    backgroundColor: chrome.background,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.bar, symbolColor: chrome.symbols, height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // El preload lo lee de forma síncrona para pintar el primer frame con el tema correcto.
      additionalArguments: [`--azdo-theme=${theme}`, `--azdo-accent=${getAccent()}`]
    }
  })

  // `ready-to-show` a veces no llega en una ventana creada oculta (se vio de forma
  // intermitente, en desarrollo y empaquetada), y la app quedaba corriendo sin ventana.
  // Se muestra con el primero que ocurra: ready-to-show, fin de carga o un tiempo máximo.
  const reveal = () => {
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  }
  // Ctrl+R abre la búsqueda por External Reference. Se intercepta aquí porque el menú por
  // defecto de Electron recarga la página con ese atajo (Ctrl+Shift+R sigue recargando).
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.shift || input.alt || input.meta) return
    if (input.key.toLowerCase() !== 'r') return
    event.preventDefault()
    window.webContents.send('shortcut:externalReference')
  })

  // Mantiene nombre + versión: sin esto, el <title> del HTML lo sustituye al cargar.
  window.on('page-title-updated', (event) => event.preventDefault())

  window.once('ready-to-show', reveal)
  window.webContents.once('did-finish-load', reveal)
  setTimeout(reveal, 3000)

  // Electron no trae menú contextual: clic derecho ofrece copiar lo seleccionado en cualquier pestaña.
  window.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      items.push(
        { role: 'cut', label: 'Cortar', enabled: params.editFlags.canCut },
        { role: 'copy', label: 'Copiar', enabled: params.editFlags.canCopy },
        { role: 'paste', label: 'Pegar', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: 'Seleccionar todo' }
      )
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy', label: 'Copiar selección' })
    }
    if (isHttpUrl(params.linkURL)) {
      if (items.length > 0) items.push({ type: 'separator' })
      items.push({ label: 'Copiar enlace', click: () => clipboard.writeText(params.linkURL) })
    }
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window })
  })

  // Cualquier target=_blank o navegación externa se abre en el navegador del sistema.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Un enlace normal dentro del HTML de un work item no debe sacar a la app de su página.
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return
    event.preventDefault()
    if (isHttpUrl(url)) shell.openExternal(url)
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerIpc(): void {
  ipcMain.handle('app:config', () => appConfig)

  ipcMain.handle('auth:state', () => currentState())

  ipcMain.handle('auth:signIn', () =>
    guard(async () => {
      if (!mainWindow) throw new Error('La ventana principal no está disponible.')
      return signIn(mainWindow)
    })
  )

  ipcMain.handle('auth:signOut', () => guard(() => signOut()))

  // Cada búsqueda lleva un id para poder cancelarla: se abortan todas sus peticiones pendientes.
  const searches = new Map<string, AbortController>()

  ipcMain.handle('azdo:search', async (_event, term: string, options?: SearchOptions, requestId?: string) => {
    const controller = new AbortController()
    if (typeof requestId === 'string') searches.set(requestId, controller)
    try {
      return await guard(() =>
        requestScope.run(controller.signal, () =>
          search(term, {
            allWorkItems: options?.allWorkItems === true,
            scope: sanitizeScope(options?.scope)
          })
        )
      )
    } finally {
      if (typeof requestId === 'string') searches.delete(requestId)
    }
  })

  ipcMain.handle('azdo:cancelSearch', (_event, requestId: string) => {
    searches.get(requestId)?.abort()
  })

  ipcMain.handle('azdo:workItemPullRequests', (_event, id: number) =>
    guard(() => getWorkItemWithPullRequests(id))
  )

  ipcMain.handle('azdo:workItemComments', (_event, id: number) => guard(() => getWorkItemComments(id)))

  ipcMain.handle('azdo:workItemHistory', (_event, id: number) => guard(() => getWorkItemHistory(id)))

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (isHttpUrl(url)) await shell.openExternal(url)
  })

  ipcMain.handle('azdo:addWorkItemComment', (_event, id: number, html: string) =>
    guard(() => addWorkItemComment(Number(id), String(html ?? '')))
  )

  ipcMain.handle('azdo:collaborators', () => guard(() => listCollaborators()))

  ipcMain.handle('azdo:searchCollaborators', (_event, query: string) =>
    guard(() => searchCollaborators(String(query ?? '')))
  )

  ipcMain.handle('attachment:download', (_event, url: string, fileName: string) =>
    guard(async () => {
      // Solo URL de la organización: el token no debe salir hacia otros hosts.
      if (!isOrganizationUrl(url)) throw new Error('La URL del adjunto no pertenece a la organización.')
      const safeName = basename(String(fileName || 'adjunto')).replace(/[<>:"/\|?*\u0000-\u001f]/g, '_')
      const options = { defaultPath: join(app.getPath('downloads'), safeName) }
      const target = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options)
      if (target.canceled || !target.filePath) return null
      await downloadToFile(url, target.filePath)
      return target.filePath
    })
  )

  ipcMain.handle('shell:showItemInFolder', (_event, path: string) => {
    if (typeof path === 'string' && path) shell.showItemInFolder(path)
  })

  ipcMain.handle('theme:set', (_event, theme: ThemeMode) => {
    if (theme !== 'light' && theme !== 'dark') return
    saveTheme(theme)
    applyTheme(theme)
  })

  ipcMain.handle('accent:set', (_event, accent: unknown) => {
    if (isAccentColor(accent)) saveAccent(accent)
  })
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = getTheme()
  registerIpc()

  mainWindow = createWindow()
  onAuthChange((state) => mainWindow?.webContents.send('auth:changed', state))

  await restoreSession()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
