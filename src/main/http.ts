import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getAccessToken } from './auth'
import { API_BASE, API_VERSION } from './config'

export interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  query?: Record<string, string | number | undefined>
  /** Algunas APIs (p. ej. comentarios) solo existen en versión preview. */
  apiVersion?: string
}

export class AzdoHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** 404 (no existe) o 400 (id mal formado, p. ej. SHA corto) significan "no encontrado". */
export function isNotFound(error: unknown): boolean {
  return error instanceof AzdoHttpError && (error.status === 404 || error.status === 400)
}

/**
 * Señal de cancelación de la operación en curso (p. ej. una búsqueda). Se propaga sola por
 * todas las llamadas a `api` que cuelgan de `requestScope.run(signal, …)`.
 */
export const requestScope = new AsyncLocalStorage<AbortSignal>()

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const signal = requestScope.getStore()
  signal?.throwIfAborted()
  const { method = 'GET', body, query, apiVersion = API_VERSION } = options
  const url = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`)
  url.searchParams.set('api-version', apiVersion)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  const token = await getAccessToken()
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new AzdoHttpError(
      response.status,
      `Azure DevOps ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`
    )
  }

  const raw = await response.text()
  // Azure DevOps devuelve HTML de login (con 200) cuando el token no sirve para la organización.
  if (raw.trimStart().startsWith('<')) {
    throw new Error(
      'Azure DevOps devolvió una página de login. Cierra sesión y vuelve a entrar con una cuenta con acceso a la organización.'
    )
  }
  return JSON.parse(raw) as T
}

/** Descarga un recurso binario autenticado (p. ej. una imagen adjunta). Devuelve null si falla. */
export async function fetchBinary(
  url: string,
  maxBytes: number
): Promise<{ contentType: string; data: Buffer } | null> {
  try {
    const token = await getAccessToken()
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') ?? ''
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > maxBytes) return null
    const data = Buffer.from(await response.arrayBuffer())
    return data.length > maxBytes ? null : { contentType, data }
  } catch {
    return null
  }
}

export function identity(field: unknown): { name: string; imageUrl: string | null } {
  const value = field as { displayName?: string; uniqueName?: string; imageUrl?: string } | undefined
  return {
    name: value?.displayName ?? value?.uniqueName ?? '',
    imageUrl: value?.imageUrl ?? null
  }
}

/** Descarga un archivo autenticado directamente a disco, sin cargarlo entero en memoria. */
export async function downloadToFile(url: string, path: string): Promise<void> {
  const token = await getAccessToken()
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok || !response.body) {
    throw new AzdoHttpError(response.status, `No se pudo descargar el archivo (${response.status} ${response.statusText}).`)
  }
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(path))
  } catch (error) {
    await rm(path, { force: true })
    throw error
  }
}
