import { normalizeText } from './format'

/** Resalta en `text` las apariciones de `needle` (ya normalizado), ignorando mayúsculas y tildes. */
export function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>
  // Cada carácter original se normaliza por separado para poder mapear posiciones.
  let normalized = ''
  const origin: number[] = []
  for (let i = 0; i < text.length; i++) {
    const part = normalizeText(text[i])
    normalized += part
    for (let j = 0; j < part.length; j++) origin.push(i)
  }
  const parts: JSX.Element[] = []
  let cursor = 0
  let from = normalized.indexOf(needle)
  while (from !== -1) {
    const start = origin[from]
    const end = origin[from + needle.length - 1] + 1
    if (start > cursor) parts.push(<span key={cursor}>{text.slice(cursor, start)}</span>)
    parts.push(<mark key={`m${start}`}>{text.slice(start, end)}</mark>)
    cursor = end
    from = normalized.indexOf(needle, from + needle.length)
  }
  parts.push(<span key={cursor}>{text.slice(cursor)}</span>)
  return <>{parts}</>
}
