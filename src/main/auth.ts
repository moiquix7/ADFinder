import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, safeStorage, session } from 'electron'
import {
  PublicClientApplication,
  CryptoProvider,
  LogLevel,
  type Configuration,
  type ICachePlugin,
  type AccountInfo as MsalAccountInfo
} from '@azure/msal-node'
import { AUTHORITY, AZURE_DEVOPS_SCOPES, CLIENT_ID, REDIRECT_URI } from './config'
import type { AccountInfo, AuthState } from '../shared/types'

const CACHE_FILE = () => join(app.getPath('userData'), 'msal-cache.bin')
const AUTH_PARTITION = 'persist:azdo-auth'

/**
 * Persiste la caché de MSAL cifrada con DPAPI (safeStorage). Si el SO no ofrece
 * cifrado se omite la persistencia: se pierde el SSO, nunca se escribe en claro.
 */
const cachePlugin: ICachePlugin = {
  beforeCacheAccess: async (ctx) => {
    const file = CACHE_FILE()
    if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return
    try {
      ctx.tokenCache.deserialize(safeStorage.decryptString(readFileSync(file)))
    } catch {
      rmSync(file, { force: true })
    }
  },
  afterCacheAccess: async (ctx) => {
    if (!ctx.cacheHasChanged || !safeStorage.isEncryptionAvailable()) return
    writeFileSync(CACHE_FILE(), safeStorage.encryptString(ctx.tokenCache.serialize()))
  }
}

const msalConfig: Configuration = {
  auth: { clientId: CLIENT_ID, authority: AUTHORITY },
  cache: { cachePlugin },
  system: {
    loggerOptions: {
      loggerCallback: (level, message) => {
        if (level <= LogLevel.Error) console.error('[msal]', message)
      },
      piiLoggingEnabled: false,
      logLevel: LogLevel.Error
    }
  }
}

const pca = new PublicClientApplication(msalConfig)
const cryptoProvider = new CryptoProvider()

let activeAccount: MsalAccountInfo | null = null
const listeners = new Set<(state: AuthState) => void>()

function toAccountInfo(account: MsalAccountInfo | null): AccountInfo | null {
  if (!account) return null
  return {
    name: account.name ?? account.username,
    username: account.username,
    tenantId: account.tenantId
  }
}

export function currentState(): AuthState {
  return { signedIn: activeAccount !== null, account: toAccountInfo(activeAccount) }
}

function emit(): void {
  const state = currentState()
  for (const cb of listeners) cb(state)
}

export function onAuthChange(cb: (state: AuthState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Restaura la sesión desde la caché en disco al arrancar. */
export async function restoreSession(): Promise<AuthState> {
  const accounts = await pca.getTokenCache().getAllAccounts()
  activeAccount = accounts[0] ?? null
  if (activeAccount) {
    try {
      await pca.acquireTokenSilent({ account: activeAccount, scopes: AZURE_DEVOPS_SCOPES })
    } catch {
      activeAccount = null
    }
  }
  emit()
  return currentState()
}

/**
 * Espera a que la ventana de login navegue al redirect URI y devuelve el `code`.
 * Se cancela la petición a `http://localhost` porque no hay servidor escuchando.
 */
function waitForAuthCode(win: BrowserWindow): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
      if (!win.isDestroyed()) win.destroy()
    }

    // Patrón `scheme://host/*` exigido por Electron, derivado del redirect URI configurado.
    const redirect = new URL(REDIRECT_URI)
    const pattern = `${redirect.protocol}//${redirect.host}/*`

    win.webContents.session.webRequest.onBeforeRequest(
      { urls: [pattern] },
      (details, callback) => {
        const url = new URL(details.url)
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
        if (code) finish(() => resolve(code))
        else if (error) finish(() => reject(new Error(error)))
        callback({ cancel: Boolean(code || error) })
      }
    )

    win.on('closed', () =>
      finish(() => reject(new Error('Inicio de sesión cancelado por el usuario.')))
    )
  })
}

export async function signIn(parent: BrowserWindow): Promise<AuthState> {
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes()

  const authUrl = await pca.getAuthCodeUrl({
    scopes: AZURE_DEVOPS_SCOPES,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    prompt: 'select_account'
  })

  const authWindow = new BrowserWindow({
    parent,
    modal: true,
    width: 520,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    title: 'Iniciar sesión con Microsoft',
    backgroundColor: '#1a1b26',
    webPreferences: {
      partition: AUTH_PARTITION,
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  authWindow.once('ready-to-show', () => authWindow.show())

  const codePromise = waitForAuthCode(authWindow)
  await authWindow.loadURL(authUrl)
  const code = await codePromise

  const result = await pca.acquireTokenByCode({
    code,
    scopes: AZURE_DEVOPS_SCOPES,
    redirectUri: REDIRECT_URI,
    codeVerifier: verifier
  })

  activeAccount = result.account
  emit()
  return currentState()
}

export async function signOut(): Promise<AuthState> {
  const cache = pca.getTokenCache()
  for (const account of await cache.getAllAccounts()) {
    await cache.removeAccount(account)
  }
  activeAccount = null
  rmSync(CACHE_FILE(), { force: true })
  await session.fromPartition(AUTH_PARTITION).clearStorageData()
  emit()
  return currentState()
}

/** Devuelve un access token válido para Azure DevOps, refrescándolo en silencio. */
export async function getAccessToken(): Promise<string> {
  if (!activeAccount) throw new Error('No hay sesión iniciada.')
  const result = await pca.acquireTokenSilent({
    account: activeAccount,
    scopes: AZURE_DEVOPS_SCOPES
  })
  if (!result?.accessToken) throw new Error('No se pudo obtener el token de Azure DevOps.')
  return result.accessToken
}
