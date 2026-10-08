import { marked } from 'marked'
import { ORGANIZATION } from './config'
import { api } from './http'

/**
 * Azure DevOps permite escribir Description, Repro Steps, etc. y los comentarios en Markdown.
 * La app solo pinta HTML, así que ese texto se convierte aquí antes de enviarlo al renderer.
 */

const HTML_TAG = /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i
const MARKDOWN_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)/

/** Texto sin etiquetas HTML pero con sintaxis Markdown (para campos que no indican su formato). */
export function looksLikeMarkdown(text: string): boolean {
  return !HTML_TAG.test(text) && MARKDOWN_HINT.test(text)
}

/** Formato declarado por Azure DevOps (`multilineFieldsFormat` o `format` del comentario). */
export function isMarkdownFormat(format: unknown): boolean {
  return typeof format === 'string' && format.toLowerCase() === 'markdown'
}

const MENTION = /@<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi
const mentionNames = new Map<string, string>()

/** Nombres de las personas mencionadas como `@<guid>` (sintaxis de menciones en Markdown). */
async function resolveMentions(ids: string[]): Promise<void> {
  const missing = ids.filter((id) => !mentionNames.has(id))
  if (missing.length === 0) return
  try {
    const result = await api<{ value?: { id: string; providerDisplayName?: string; customDisplayName?: string }[] }>(
      `https://vssps.dev.azure.com/${encodeURIComponent(ORGANIZATION)}/_apis/identities`,
      { query: { identityIds: missing.join(',') } }
    )
    for (const identity of result.value ?? []) {
      const name = identity.customDisplayName || identity.providerDisplayName
      if (name) mentionNames.set(identity.id.toLowerCase(), name)
    }
  } catch {
    // Sin permiso para leer identidades: la mención se muestra genérica.
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function markdownToHtml(markdown: string): Promise<string> {
  const ids = [...new Set([...markdown.matchAll(MENTION)].map((match) => match[1].toLowerCase()))]
  await resolveMentions(ids)

  // Las menciones pasan como enlace `href="#"`: el renderer las pinta como mención destacada.
  const withMentions = markdown.replace(MENTION, (_match, id: string) => {
    const name = mentionNames.get(id.toLowerCase()) ?? 'usuario'
    return `<a href="#" data-vss-mention="version:2.0,${id}">@${escapeHtml(name)}</a>`
  })

  const html = await marked.parse(withMentions, { gfm: true, breaks: true })
  // Las listas de tareas llegan como <input type="checkbox">, que el saneado elimina.
  return html
    .replace(/<input[^>]*\bchecked\b[^>]*>/gi, '☑')
    .replace(/<input[^>]*type="checkbox"[^>]*>/gi, '☐')
}
