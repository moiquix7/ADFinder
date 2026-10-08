import { app } from 'electron'
import type { AppConfig } from '../shared/types'

/**
 * Recurso fijo de Azure DevOps en Entra ID. El scope `/.default` pide los permisos
 * ya consentidos para el client id público, sin necesidad de registrar una app propia.
 */
export const AZURE_DEVOPS_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798'
export const AZURE_DEVOPS_SCOPES = [`${AZURE_DEVOPS_RESOURCE_ID}/.default`]

/**
 * Client id público de Visual Studio (public client, redirect `http://localhost`).
 * Se puede sustituir por un App Registration propio vía variables de entorno.
 */
export const CLIENT_ID = process.env.AZDO_CLIENT_ID ?? '872cd9fa-d31f-45e0-9eab-6e460a02d1f1'
export const TENANT = process.env.AZDO_TENANT_ID ?? 'organizations'
export const AUTHORITY = `https://login.microsoftonline.com/${TENANT}`
export const REDIRECT_URI = process.env.AZDO_REDIRECT_URI ?? 'http://localhost/'

export const ORGANIZATION = process.env.AZDO_ORG ?? 'sda-iatec'
export const PROJECT = process.env.AZDO_PROJECT ?? 'Sda.Aasi.Net'
export const WEB_HOST = process.env.AZDO_WEB_HOST ?? `https://${ORGANIZATION}.visualstudio.com`

export const API_BASE = `https://dev.azure.com/${ORGANIZATION}`
export const API_VERSION = '7.1'

/** Únicos tipos de work item que devuelve la búsqueda. */
export const WORK_ITEM_TYPES = (
  process.env.AZDO_WORK_ITEM_TYPES ??
  'Feature,Issue,Failure,User Story,Bug,Task,Test Task,Rework'
)
  .split(',')
  .map((type) => type.trim())
  .filter(Boolean)

export const APP_NAME = 'AD Finder'
export const APP_VERSION = app.getVersion()
/** Título de la ventana (barra de tareas, Alt+Tab): nombre y versión. */
export const WINDOW_TITLE = `${APP_NAME} v${APP_VERSION}`

export const appConfig: AppConfig = {
  version: APP_VERSION,
  organization: ORGANIZATION,
  project: PROJECT,
  webHost: WEB_HOST,
  pullsUrl: `${WEB_HOST}/_pulls`,
  workItemTypes: WORK_ITEM_TYPES
}

/** Dominio de correo de los colaboradores que se pueden mencionar desde el directorio (vacío: todos). */
export const MENTION_EMAIL_DOMAIN = process.env.AZDO_MENTION_DOMAIN ?? 'iatec.com'
