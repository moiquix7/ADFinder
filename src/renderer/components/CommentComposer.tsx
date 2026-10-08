import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Avatar } from './Avatar'
import { normalizeText } from '../lib/format'
import type { Collaborator } from '../../shared/types'

/** Sugerencias visibles a la vez en la lista de menciones. */
const MAX_SUGGESTIONS = 50
const DIRECTORY_DEBOUNCE_MS = 300

/** Miembros de los equipos: se piden una vez por sesión del renderer y se comparten. */
let collaboratorsPromise: Promise<Collaborator[]> | null = null

function loadCollaborators(): Promise<Collaborator[]> {
  if (!collaboratorsPromise) {
    collaboratorsPromise = window.azdo.getCollaborators().then((result) => {
      if (result.ok) return result.data
      collaboratorsPromise = null
      throw new Error(result.error)
    })
  }
  return collaboratorsPromise
}

/** Mención en curso: el `@` está al inicio o tras un espacio y no hay salto de línea hasta el cursor. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (query.length > 40 || /[\n@]/.test(query) || query.startsWith(' ')) return null
  return { start: at, query }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Convierte el texto a HTML de Azure DevOps. Cada `@Nombre` elegido de la lista se convierte en
 * una mención real (`data-vss-mention`), que notifica a la persona.
 */
function toCommentHtml(text: string, mentions: Map<string, string>): string {
  const used = [...mentions.entries()]
    .filter(([name]) => text.includes(`@${name}`))
    // Los nombres largos primero, para que «@Ana María» no se quede en «@Ana».
    .sort(([a], [b]) => b.length - a.length)

  let marked = text
  used.forEach(([name], index) => {
    marked = marked.split(`@${name}`).join(`\u0000${index}\u0000`)
  })

  const html = escapeHtml(marked)
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
      const [name, id] = used[Number(index)]
      return `<a href="#" data-vss-mention="version:2.0,${id}">@${escapeHtml(name)}</a>`
    })
    .replace(/\r?\n/g, '<br>')
  return `<div>${html}</div>`
}

interface CommentComposerProps {
  workItemId: number
  /** Se llama tras publicar, para recargar la Discussion. */
  onPosted: () => void
}

export function CommentComposer({ workItemId, onPosted }: CommentComposerProps) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [mentions, setMentions] = useState(() => new Map<string, string>())
  const [team, setTeam] = useState<Collaborator[] | null>(null)
  const [directory, setDirectory] = useState<Collaborator[]>([])
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const mention = mentionAt(text, caret)
  const open = mention !== null && dismissed !== mention.start

  // La lista de miembros se pide la primera vez que alguien escribe `@`.
  useEffect(() => {
    if (!open || team) return
    loadCollaborators().then(setTeam, (reason: Error) => {
      setTeam([])
      setError(`No se pudo cargar la lista de colaboradores: ${reason.message}`)
    })
  }, [open, team])

  // Además se consulta el directorio, para quien no está en ningún equipo del proyecto.
  const query = open ? mention.query.trim() : ''
  useEffect(() => {
    if (query.length < 2) {
      setDirectory([])
      return
    }
    let current = true
    const timer = setTimeout(() => {
      window.azdo.searchCollaborators(query).then((result) => {
        if (current) setDirectory(result.ok ? result.data : [])
      })
    }, DIRECTORY_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query])

  const suggestions = useMemo(() => {
    if (!open) return []
    const needle = normalizeText(query)
    const matches = (person: Collaborator) =>
      normalizeText(person.displayName).includes(needle) || normalizeText(person.uniqueName).includes(needle)
    const seen = new Set<string>()
    const list: Collaborator[] = []
    for (const person of [...(team ?? []).filter(matches), ...directory]) {
      if (seen.has(person.id)) continue
      seen.add(person.id)
      list.push(person)
    }
    return list.slice(0, MAX_SUGGESTIONS)
  }, [open, query, team, directory])

  useEffect(() => setActive(0), [query])

  const pick = (person: Collaborator) => {
    if (!mention) return
    const before = text.slice(0, mention.start)
    const after = text.slice(caret)
    const inserted = `@${person.displayName} `
    const next = before + inserted + after
    const position = before.length + inserted.length
    setText(next)
    setCaret(position)
    setMentions((current) => new Map(current).set(person.displayName, person.id))
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(position, position)
    })
  }

  const submit = async () => {
    if (!text.trim() || posting) return
    setPosting(true)
    setError(null)
    const result = await window.azdo.addWorkItemComment(workItemId, toCommentHtml(text.trim(), mentions))
    setPosting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setText('')
    setCaret(0)
    setMentions(new Map())
    onPosted()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && suggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((index) => (index + step + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        pick(suggestions[active])
        return
      }
    }
    if (open && event.key === 'Escape') {
      event.preventDefault()
      setDismissed(mention.start)
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      submit()
    }
  }

  // Mantiene visible la sugerencia activa al moverse con las flechas.
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="composer">
      <div className="composer__field">
        <textarea
          ref={inputRef}
          className="composer__input"
          value={text}
          rows={3}
          placeholder="Escribe un comentario… usa @ para mencionar a un colaborador"
          aria-label="Nuevo comentario"
          disabled={posting}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            setDismissed(null)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setDismissed(mention?.start ?? null), 150)}
          onFocus={() => setDismissed(null)}
        />

        {open && (
          <div className="mention" role="listbox" aria-label="Colaboradores">
            {team === null ? (
              <div className="loading-row">
                <span className="spinner" /> Cargando colaboradores…
              </div>
            ) : suggestions.length === 0 ? (
              <div className="mention__empty">
                {query.length < 2 ? 'Escribe el nombre o el correo…' : `Nadie coincide con «${query}».`}
              </div>
            ) : (
              <ul className="mention__list" ref={listRef}>
                {suggestions.map((person, index) => (
                  <li
                    key={person.id}
                    role="option"
                    aria-selected={index === active}
                    className="mention__option"
                    onMouseDown={(e) => {
                      // Evita que el textarea pierda el foco antes de insertar.
                      e.preventDefault()
                      pick(person)
                    }}
                    onMouseEnter={() => setActive(index)}
                  >
                    <Avatar name={person.displayName} imageUrl={person.imageUrl} small />
                    <span className="mention__name">{person.displayName}</span>
                    <span className="mention__mail">{person.uniqueName}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {error && <div className="alert composer__alert">{error}</div>}

      <div className="composer__actions">
        <span className="composer__hint">@ mencionar · Ctrl+Enter publicar</span>
        <button className="btn btn--primary btn--sm" onClick={submit} disabled={posting || !text.trim()}>
          {posting ? 'Publicando…' : 'Comentar'}
        </button>
      </div>
    </div>
  )
}
