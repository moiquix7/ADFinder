import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  isAccentColor,
  type AccentColor,
  type AppConfig,
  type AuthState,
  type AzdoApi,
  type Collaborator,
  type IpcResult,
  type SearchResult,
  type ThemeMode,
  type WorkItemComment,
  type WorkItemDetail,
  type WorkItemRevision
} from '../shared/types'

const themeArg = process.argv.find((arg) => arg.startsWith('--azdo-theme='))
const initialTheme: ThemeMode = themeArg?.endsWith('=light') ? 'light' : 'dark'
const accentArg = process.argv.find((arg) => arg.startsWith('--azdo-accent='))?.split('=')[1]
const initialAccent: AccentColor = isAccentColor(accentArg) ? accentArg : 'tokyo'

const api: AzdoApi = {
  getConfig: () => ipcRenderer.invoke('app:config') as Promise<AppConfig>,
  auth: {
    getState: () => ipcRenderer.invoke('auth:state') as Promise<AuthState>,
    signIn: () => ipcRenderer.invoke('auth:signIn') as Promise<IpcResult<AuthState>>,
    signOut: () => ipcRenderer.invoke('auth:signOut') as Promise<IpcResult<AuthState>>,
    onChange: (cb) => {
      const listener = (_event: IpcRendererEvent, state: AuthState) => cb(state)
      ipcRenderer.on('auth:changed', listener)
      return () => ipcRenderer.removeListener('auth:changed', listener)
    }
  },
  search: (term, options, requestId) =>
    ipcRenderer.invoke('azdo:search', term, options, requestId) as Promise<IpcResult<SearchResult>>,
  cancelSearch: (requestId) => ipcRenderer.invoke('azdo:cancelSearch', requestId) as Promise<void>,
  getWorkItemWithPullRequests: (id) =>
    ipcRenderer.invoke('azdo:workItemPullRequests', id) as Promise<IpcResult<WorkItemDetail>>,
  getWorkItemComments: (id) =>
    ipcRenderer.invoke('azdo:workItemComments', id) as Promise<IpcResult<WorkItemComment[]>>,
  getWorkItemHistory: (id) =>
    ipcRenderer.invoke('azdo:workItemHistory', id) as Promise<IpcResult<WorkItemRevision[]>>,
  addWorkItemComment: (id, html) =>
    ipcRenderer.invoke('azdo:addWorkItemComment', id, html) as Promise<IpcResult<null>>,
  getCollaborators: () => ipcRenderer.invoke('azdo:collaborators') as Promise<IpcResult<Collaborator[]>>,
  searchCollaborators: (query) =>
    ipcRenderer.invoke('azdo:searchCollaborators', query) as Promise<IpcResult<Collaborator[]>>,
  downloadAttachment: (url, fileName) =>
    ipcRenderer.invoke('attachment:download', url, fileName) as Promise<IpcResult<string | null>>,
  showItemInFolder: (path) => ipcRenderer.invoke('shell:showItemInFolder', path) as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url) as Promise<void>,
  onExternalReferenceShortcut: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('shortcut:externalReference', listener)
    return () => ipcRenderer.removeListener('shortcut:externalReference', listener)
  },
  theme: {
    initial: initialTheme,
    set: (mode) => ipcRenderer.invoke('theme:set', mode) as Promise<void>
  },
  accent: {
    initial: initialAccent,
    set: (accent) => ipcRenderer.invoke('accent:set', accent) as Promise<void>
  }
}

contextBridge.exposeInMainWorld('azdo', api)
