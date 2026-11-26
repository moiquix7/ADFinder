import type { SearchScope } from './types'

/**
 * Interpretación del término de búsqueda. Se comparte entre main (que decide qué API llamar)
 * y renderer (que ajusta el debounce y el texto de ayuda).
 *
 * - `#123`            → work item por id
 * - `!123`, `PR 123`  → pull request por número (la notación `!` es la de Azure DevOps)
 * - `!` solo          → todos los pull requests, del más reciente al más antiguo
 * - `#` solo          → work items padre (con hijos), del más recientemente modificado al más antiguo
 * - `123`             → ambiguo: work item y pull request con ese número
 * - `login%error`     → solo títulos de work item; `%` es comodín (`%texto%` contiene, `texto%` empieza por)
 * - `a1b2c3d…`        → commit (7–40 caracteres hex con letras y dígitos), o `sha:`/`commit:` + hex
 * - `ExternalReference:123` → work items cuyo campo External Reference es ese número
 * - `123, #456, login` → varios valores separados por coma: se busca cada uno y se unen los resultados
 *                        (`ExternalReference:1, 2` aplica la palabra reservada a cada número)
 * - cualquier otro    → texto libre sobre título, colaborador y descripción
 */
export type SearchQuery =
  | { kind: 'empty' | 'allPullRequests' | 'parentWorkItems' }
  | { kind: 'workItemId' | 'pullRequestId' | 'number'; id: number }
  | { kind: 'commit'; sha: string }
  | { kind: 'text'; text: string }
  | { kind: 'titlePattern'; pattern: string }
  | { kind: 'externalReference'; reference: string }
  | { kind: 'multiple'; terms: string[] }

/** Palabra reservada que limita la búsqueda al campo External Reference. */
export const EXTERNAL_REFERENCE_PREFIX = 'ExternalReference:'

/** Separa los valores de una búsqueda múltiple. */
export const MULTIPLE_SEPARATOR = ','

/** Tope de valores en una búsqueda múltiple: cada uno lanza su propia búsqueda. */
export const MAX_MULTIPLE_TERMS = 50

const EXTERNAL_REFERENCE_REGEX = /^externalreference\s*:(.*)$/is

/**
 * Lo escrito tras `ExternalReference:` (dígitos, y comas y espacios para indicar varios números),
 * o null si el término no empieza por la palabra reservada.
 */
export function externalReferenceValue(term: string): string | null {
  const match = EXTERNAL_REFERENCE_REGEX.exec(term.trimStart())
  return match ? sanitizeExternalReference(match[1]) : null
}

/** Solo dígitos, comas y espacios: lo que admite el número (o la lista de números) de External Reference. */
export function sanitizeExternalReference(value: string): string {
  return value.replace(/[^\d,\s]/g, '').replace(/\s+/g, ' ')
}

/**
 * Valores de un término con comas, sin vacíos ni repetidos (sin distinguir mayúsculas). Con
 * `ExternalReference:` delante, la palabra reservada se aplica a cada número.
 */
export function splitSearchTerms(term: string): string[] {
  const reference = externalReferenceValue(term)
  const parts =
    reference !== null
      ? reference
          .split(MULTIPLE_SEPARATOR)
          .map((part) => part.replace(/\D/g, ''))
          .map((digits) => (digits ? EXTERNAL_REFERENCE_PREFIX + digits : ''))
      : term.split(MULTIPLE_SEPARATOR).map((part) => part.trim())
  const seen = new Set<string>()
  return parts.filter((part) => {
    const key = part.toLowerCase()
    if (!part || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function parseSearch(term: string): SearchQuery {
  const trimmed = term.trim()
  if (!trimmed) return { kind: 'empty' }
  const reference = externalReferenceValue(trimmed)

  // Con un solo valor (p. ej. `123,` mientras se escribe el siguiente) se busca como si no hubiera coma.
  if (trimmed.includes(MULTIPLE_SEPARATOR)) {
    const terms = splitSearchTerms(trimmed)
    if (terms.length > 1) return { kind: 'multiple', terms }
    if (terms.length === 1) return parseSearch(terms[0])
    return reference !== null ? { kind: 'externalReference', reference: '' } : { kind: 'empty' }
  }

  if (reference !== null) return { kind: 'externalReference', reference: reference.replace(/\D/g, '') }
  if (trimmed === '!') return { kind: 'allPullRequests' }
  if (trimmed === '#') return { kind: 'parentWorkItems' }
  if (trimmed.includes('%')) return { kind: 'titlePattern', pattern: trimmed }

  let match = /^#\s*(\d+)$/.exec(trimmed)
  if (match) return { kind: 'workItemId', id: Number(match[1]) }

  match = /^(?:!|pr\s*[:#]?\s*)(\d+)$/i.exec(trimmed)
  if (match) return { kind: 'pullRequestId', id: Number(match[1]) }

  if (/^\d+$/.test(trimmed)) return { kind: 'number', id: Number(trimmed) }

  match = /^(?:sha|commit)\s*:?\s*([0-9a-f]{4,40})$/i.exec(trimmed)
  if (match) return { kind: 'commit', sha: match[1].toLowerCase() }

  // Exigir letras y dígitos evita confundir palabras como "defaced" con un SHA.
  if (/^[0-9a-f]{7,40}$/i.test(trimmed) && /[a-f]/i.test(trimmed) && /\d/.test(trimmed)) {
    return { kind: 'commit', sha: trimmed.toLowerCase() }
  }

  return { kind: 'text', text: trimmed }
}

/**
 * Ajusta la interpretación a los lugares marcados en el filtro: sin «Hash commit» un SHA
 * se busca como texto, y sin «Número PullRequest» un número es solo un id de work item.
 * `!123` se mantiene como pull request para que quien busca vea por qué no hay resultado.
 */
export function scopedSearch(
  term: string,
  scope: Pick<SearchScope, 'pullRequestNumber' | 'commitHash'>
): SearchQuery {
  const query = parseSearch(term)
  if (query.kind === 'commit' && !scope.commitHash) return { kind: 'text', text: term.trim() }
  if (query.kind === 'number' && !scope.pullRequestNumber) return { kind: 'workItemId', id: query.id }
  return query
}

/** Minúsculas y sin tildes, para comparar títulos como lo hace la búsqueda de Azure DevOps. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/** Trozos de texto de un patrón con comodines `%` (sin los espacios de los bordes). */
export function wildcardSegments(pattern: string): string[] {
  return pattern
    .split('%')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

/**
 * Comprueba un título contra un patrón estilo SQL LIKE: `%` equivale a cualquier texto, así que
 * `%login%` busca «contiene», `login%` «empieza por» y `%login` «termina en». Ignora mayúsculas y tildes.
 */
export function titlePatternMatcher(pattern: string): (title: string) => boolean {
  const trimmed = pattern.trim()
  const body = wildcardSegments(trimmed)
    .map((segment) => fold(segment).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  const start = trimmed.startsWith('%') ? '' : '^'
  const end = trimmed.endsWith('%') ? '' : '$'
  const regex = new RegExp(`${start}${body}${end}`, 's')
  return (title) => regex.test(fold(title.trim()))
}
