import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Avatar } from './Avatar'
import { Paginator } from './Paginator'
import { PullRequestCard } from './PullRequestCard'
import { CloseIcon, CommitIcon, ExternalIcon, FilterIcon, PullRequestIcon, SearchIcon, WorkItemIcon } from './Icons'
import { formatAbsolute, formatRelative, normalizeText } from '../lib/format'
import { Highlight } from '../lib/highlight'
import { typeStyle } from '../lib/workItemType'
import { DEFAULT_FILTER, SearchFilter, toScope, type FilterState } from './SearchFilter'
import {
  EXTERNAL_REFERENCE_PREFIX,
  externalReferenceValue,
  scopedSearch,
  type SearchQuery
} from '../../shared/query'
import type { CommitSummary, SearchResult, WorkItemSummary } from '../../shared/types'

interface WorkItemSearchProps {
  /** Formato widget con un work item abierto: se oculta sin desmontarse para conservar la búsqueda. */
  hidden: boolean
  selectedId: number | null
  onSelect: (workItem: WorkItemSummary) => void
  /** Tipos de work item configurados; null mientras carga la configuración. */
  workItemTypes: string[] | null
  /** Cambia con cada Ctrl+R: deja el campo listo para buscar por External Reference. */
  externalReferenceRequest: number
}

const DEBOUNCE_MS = 400
/** Tras este tiempo buscando se pregunta si se quiere seguir esperando o cancelar. */
const SLOW_SEARCH_MS = 60_000

const PAGE_SIZE_KEY = 'workItemSearch.pageSize'
const DEFAULT_PAGE_SIZE = 25

function loadPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY))
    return Number.isSafeInteger(stored) && stored >= 1 ? stored : DEFAULT_PAGE_SIZE
  } catch {
    return DEFAULT_PAGE_SIZE
  }
}

function savePageSize(size: number): void {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(size))
  } catch {
    // Sin almacenamiento disponible: el tamaño vale solo para esta sesión.
  }
}

// v2: nuevos valores por defecto (Discussion y adjuntos desmarcados); el filtro anterior se descarta.
const FILTER_KEY = 'workItemSearch.filter.v2'

function loadFilter(): FilterState {
  try {
    const stored = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') as Partial<FilterState>
    const filter = { ...DEFAULT_FILTER }
    for (const key of Object.keys(DEFAULT_FILTER) as (keyof FilterState)[]) {
      if (key === 'excludedTypes') {
        if (Array.isArray(stored.excludedTypes)) filter.excludedTypes = stored.excludedTypes.map(String)
      } else if (typeof stored[key] === 'boolean') {
        filter[key] = stored[key] as boolean
      }
    }
    return filter
  } catch {
    return DEFAULT_FILTER
  }
}

function saveFilter(filter: FilterState): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filter))
  } catch {
    // Sin almacenamiento disponible: el filtro vale solo para esta sesión.
  }
}

/** Etiqueta que indica cómo se interpretó el término mientras se escribe. */
function kindLabel(query: SearchQuery): string | null {
  switch (query.kind) {
    case 'workItemId':
      return 'Work item'
    case 'pullRequestId':
      return 'Pull request'
    case 'number':
      return 'WI o PR'
    case 'allPullRequests':
      return 'Todos los PR'
    case 'parentWorkItems':
      return 'WI padre'
    case 'titlePattern':
      return 'Título %'
    case 'commit':
      return 'Commit'
    default:
      return null
  }
}

function WorkItemRow({
  item,
  selected,
  highlight,
  onSelect
}: {
  item: WorkItemSummary
  selected: boolean
  /** Texto del filtro por título (normalizado) que se resalta. */
  highlight: string
  onSelect: (workItem: WorkItemSummary) => void
}) {
  return (
    <button className="wi" aria-selected={selected} onClick={() => onSelect(item)}>
      <div className="wi__top">
        <span className="wi__id">#{item.id}</span>
        <span className="chip chip--type" style={typeStyle(item.type)}>
          {item.type}
        </span>
        <span className="chip chip--neutral">{item.state}</span>
      </div>
      <div className="wi__title">
        <Highlight text={item.title} needle={highlight} />
      </div>
      <div className="wi__meta">
        {item.assignedTo ? (
          <span className="who">
            <Avatar name={item.assignedTo} imageUrl={item.assignedToImageUrl} small />
            {item.assignedTo}
          </span>
        ) : (
          <span>Sin asignar</span>
        )}
        {item.changedDate && <span>· {formatRelative(item.changedDate)}</span>}
      </div>
    </button>
  )
}

function CommitRow({ commit, highlight }: { commit: CommitSummary; highlight: string }) {
  return (
    <div className="commit">
      <span className="commit__icon">
        <CommitIcon />
      </span>
      <div className="commit__body">
        <div className="commit__title">
          <code className="commit__sha" title={commit.commitId}>
            {commit.shortId}
          </code>
          <span className="commit__message">
            {commit.comment ? <Highlight text={commit.comment} needle={highlight} /> : '(sin mensaje)'}
          </span>
        </div>
        <div className="wi__meta">
          <span>{commit.author}</span>
          {commit.authorDate && (
            <span title={formatAbsolute(commit.authorDate)}>· {formatRelative(commit.authorDate)}</span>
          )}
          <span>· {commit.repositoryName}</span>
        </div>
      </div>
      <button
        className="btn btn--ghost btn--icon"
        onClick={() => window.azdo.openExternal(commit.webUrl)}
        title="Abrir commit en Azure DevOps"
      >
        <ExternalIcon />
      </button>
    </div>
  )
}

function SectionTitle({
  icon,
  label,
  count,
  action
}: {
  icon: JSX.Element
  label: string
  count: number
  action?: JSX.Element
}) {
  return (
    <div className="section-title">
      {icon}
      <span>{label}</span>
      <span className="section-title__count">{count}</span>
      {action}
    </div>
  )
}

export function WorkItemSearch({
  hidden,
  selectedId,
  onSelect,
  workItemTypes,
  externalReferenceRequest
}: WorkItemSearchProps) {
  const [term, setTerm] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(loadPageSize)
  // Siempre arranca desmarcado: cargar todo es lento y debe pedirse a propósito en cada sesión.
  const [showAll, setShowAll] = useState(false)
  const [filter, setFilter] = useState(loadFilter)
  const [titleFilterOpen, setTitleFilterOpen] = useState(false)
  const [titleFilter, setTitleFilter] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const requestId = useRef(0)
  /** Id de la búsqueda que está en curso en el main process (para poder cancelarla). */
  const inflight = useRef<string | null>(null)
  const [slowPrompt, setSlowPrompt] = useState(false)
  const [keepWaiting, setKeepWaiting] = useState(false)
  const [waitRound, setWaitRound] = useState(0)
  const [cancelled, setCancelled] = useState(false)
  const [retry, setRetry] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const savedScroll = useRef(0)

  // display:none pierde la posición del scroll: se guarda al ocultar y se restaura al volver.
  useLayoutEffect(() => {
    if (!hidden && scrollRef.current) scrollRef.current.scrollTop = savedScroll.current
  }, [hidden])

  const scope = useMemo(() => (workItemTypes ? toScope(filter, workItemTypes) : null), [filter, workItemTypes])
  const query = scopedSearch(term, filter)
  const badge = kindLabel(query)

  // `ExternalReference:` se muestra como token aparte y el input solo contiene el número.
  const externalReference = externalReferenceValue(term)
  const inputRef = useRef<HTMLInputElement>(null)
  const tokenRef = useRef<HTMLSpanElement>(null)
  /** Sangría del texto del input para que empiece justo después del token. */
  const [tokenIndent, setTokenIndent] = useState(0)
  const hasToken = externalReference !== null

  // Se vuelve a medir si el token cambia de tamaño (p. ej. cuando termina de cargar la fuente).
  useLayoutEffect(() => {
    const token = tokenRef.current
    if (!hasToken || !token) {
      setTokenIndent(0)
      return
    }
    const measure = () => setTokenIndent(token.offsetLeft + token.offsetWidth + 8)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(token)
    return () => observer.disconnect()
  }, [hasToken])

  const changeTerm = (value: string) => {
    if (externalReference !== null) {
      setTerm(EXTERNAL_REFERENCE_PREFIX + value.replace(/\D/g, ''))
      return
    }
    // Al escribir (o pegar) la palabra reservada se convierte en token; lo que sigue, solo dígitos.
    const reference = externalReferenceValue(value)
    setTerm(reference !== null ? EXTERNAL_REFERENCE_PREFIX + reference : value)
  }

  useEffect(() => {
    if (externalReferenceRequest === 0) return
    setTerm(EXTERNAL_REFERENCE_PREFIX)
    inputRef.current?.focus()
  }, [externalReferenceRequest])

  const removeExternalReference = () => {
    setTerm(externalReference ?? '')
    inputRef.current?.focus()
  }

  useEffect(() => {
    const trimmed = term.trim()
    if (trimmed.length === 0 || !scope) {
      requestId.current += 1
      setResult(null)
      setError(null)
      setLoading(false)
      return
    }

    // Un número se busca casi de inmediato; texto libre y SHA esperan al debounce.
    // External Reference también espera: es coincidencia exacta y los dígitos a medio escribir no encuentran nada.
    const kind = scopedSearch(trimmed, scope).kind
    // `#` y `!` solos también esperan: suelen ser el inicio de `#123` o `!123`.
    const delay = kind === 'workItemId' || kind === 'pullRequestId' || kind === 'number' ? 150 : DEBOUNCE_MS
    const current = ++requestId.current
    const id = crypto.randomUUID()
    setLoading(true)
    setCancelled(false)

    const timer = setTimeout(async () => {
      inflight.current = id
      const response = await window.azdo.search(trimmed, { allWorkItems: showAll, scope }, id)
      if (inflight.current === id) inflight.current = null
      if (current !== requestId.current) return
      setLoading(false)
      if (response.ok) {
        setResult(response.data)
        setError(null)
      } else {
        setResult(null)
        setError(response.error)
      }
    }, delay)

    return () => {
      clearTimeout(timer)
      // Una búsqueda nueva sustituye a la anterior: no tiene sentido dejarla consumiendo peticiones.
      if (inflight.current === id) {
        window.azdo.cancelSearch(id)
        inflight.current = null
      }
    }
  }, [term, showAll, scope, retry])

  // Si la búsqueda tarda demasiado se pregunta qué hacer; «Esperar» vuelve a preguntar más tarde.
  useEffect(() => {
    if (!loading) {
      setSlowPrompt(false)
      setKeepWaiting(false)
      return
    }
    if (keepWaiting) return
    const timer = setTimeout(() => setSlowPrompt(true), SLOW_SEARCH_MS)
    return () => clearTimeout(timer)
  }, [loading, keepWaiting, waitRound])

  const waitAgain = () => {
    setSlowPrompt(false)
    setWaitRound((round) => round + 1)
  }

  const waitUntilDone = () => {
    setSlowPrompt(false)
    setKeepWaiting(true)
  }

  const cancelSearch = () => {
    if (inflight.current) window.azdo.cancelSearch(inflight.current)
    inflight.current = null
    requestId.current += 1
    setSlowPrompt(false)
    setLoading(false)
    setResult(null)
    setError(null)
    setCancelled(true)
  }

  const changeFilter = (next: FilterState) => {
    setFilter(next)
    saveFilter(next)
  }

  const toggleShowAll = (value: boolean) => {
    setShowAll(value)
  }

  // Filtro local por título sobre lo ya devuelto (work items, PR y commits), sin volver a buscar.
  const titleNeedle = normalizeText(titleFilter.trim())
  const matchesTitle = (text: string) => titleNeedle === '' || normalizeText(text).includes(titleNeedle)
  const titleMatches = useMemo(
    () => (result?.workItems ?? []).filter((item) => matchesTitle(item.title)),
    [result, titleNeedle]
  )
  // Un PR también coincide por su número (`!123`) y un commit por su mensaje o su SHA.
  const pullRequestMatches = useMemo(
    () =>
      (result?.pullRequests ?? []).filter(
        ({ pullRequest }) =>
          matchesTitle(pullRequest.title) || String(pullRequest.pullRequestId).includes(titleNeedle)
      ),
    [result, titleNeedle]
  )
  const commitMatches = useMemo(
    () =>
      (result?.commits ?? []).filter(
        (commit) => matchesTitle(commit.comment) || commit.commitId.startsWith(titleNeedle)
      ),
    [result, titleNeedle]
  )

  // Tipos presentes en los resultados, con su número de work items, en orden de aparición.
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of titleMatches) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
    return [...counts.entries()]
  }, [titleMatches])

  // Si el tipo elegido no aparece en los nuevos resultados, se muestran todos.
  const activeType = typeFilter && typeCounts.some(([type]) => type === typeFilter) ? typeFilter : null
  const visibleWorkItems = useMemo(
    () => titleMatches.filter((item) => activeType === null || item.type === activeType),
    [titleMatches, activeType]
  )

  // Cada búsqueda, cambio de tipo o de filtro por título vuelve a la primera página.
  useEffect(() => setPage(1), [result, activeType, titleNeedle])

  useEffect(() => {
    if (titleFilterOpen) titleInputRef.current?.focus()
  }, [titleFilterOpen])

  const closeTitleFilter = () => {
    setTitleFilter('')
    setTitleFilterOpen(false)
  }

  const pageCount = Math.max(1, Math.ceil(visibleWorkItems.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageItems = visibleWorkItems.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const goToPage = (next: number) => {
    setPage(Math.min(Math.max(1, next), pageCount))
    scrollRef.current?.scrollTo({ top: 0 })
  }

  const changePageSize = (size: number) => {
    // Mantiene visible el primer work item de la página actual.
    const firstIndex = (currentPage - 1) * pageSize
    setPageSize(size)
    setPage(Math.floor(firstIndex / size) + 1)
    savePageSize(size)
  }

  const total = result
    ? result.workItems.length + result.pullRequests.length + result.commits.length
    : 0
  const filteredTotal = titleMatches.length + pullRequestMatches.length + commitMatches.length

  return (
    <div className={`pane pane--left${hidden ? ' pane--hidden' : ''}`}>
      <div className="pane__header">
        <div className="search-row">
          <div className="field">
            <span className="field__icon">
              <SearchIcon />
            </span>
            {externalReference !== null && (
              <span className="search-token" ref={tokenRef} title="Busca por el campo External Reference">
                {EXTERNAL_REFERENCE_PREFIX}
                <button
                  className="search-token__remove"
                  onClick={removeExternalReference}
                  aria-label="Quitar ExternalReference:"
                  title="Quitar ExternalReference:"
                >
                  <CloseIcon />
                </button>
              </span>
            )}
            <input
              ref={inputRef}
              className={`input${badge ? ' input--badge' : ''}`}
              style={tokenIndent ? { paddingLeft: tokenIndent } : undefined}
              type="search"
              value={externalReference ?? term}
              autoFocus
              spellCheck={false}
              inputMode={externalReference !== null ? 'numeric' : undefined}
              onChange={(e) => changeTerm(e.target.value)}
              onKeyDown={(e) => {
                // Retroceso al inicio del número quita el token, como en un campo de etiquetas.
                const input = e.currentTarget
                if (
                  e.key === 'Backspace' &&
                  externalReference !== null &&
                  input.selectionStart === 0 &&
                  input.selectionEnd === 0
                ) {
                  e.preventDefault()
                  removeExternalReference()
                }
              }}
              placeholder={
                externalReference !== null
                  ? 'Número de External Reference…'
                  : 'Id, título, descripción, colaborador, !PR o SHA…'
              }
              aria-label={
                externalReference !== null
                  ? 'Número de External Reference'
                  : 'Buscar work item, pull request o commit'
              }
            />
            {badge && <span className="field__badge">{badge}</span>}
          </div>
          {workItemTypes && <SearchFilter filter={filter} types={workItemTypes} onChange={changeFilter} />}
        </div>
        <label className="switch" title="Sin activar, solo se cargan los 100 work items modificados más recientemente">
          <input
            className="switch__input"
            type="checkbox"
            role="switch"
            checked={showAll}
            onChange={(e) => toggleShowAll(e.target.checked)}
          />
          <span className="switch__track" aria-hidden="true" />
          <span>Mostrar todos los work items</span>
        </label>
      </div>

      <div
        className="pane__scroll"
        ref={scrollRef}
        onScroll={(e) => {
          if (!hidden) savedScroll.current = e.currentTarget.scrollTop
        }}
      >
        {loading && (
          <div className="loading-row">
            <span className="spinner" />
            {query.kind === 'allPullRequests'
              ? 'Cargando pull requests y sus work items…'
              : query.kind === 'parentWorkItems'
                ? 'Cargando work items padre…'
                : query.kind === 'titlePattern'
                  ? 'Buscando en los títulos de work items…'
                  : query.kind === 'commit'
                    ? 'Buscando el commit en los repositorios…'
                    : query.kind === 'externalReference'
                      ? 'Buscando por External Reference…'
                    : query.kind === 'text' && filter.attachments
                      ? 'Buscando… (revisando adjuntos)'
                      : 'Buscando…'}
          </div>
        )}

        {error && <div className="alert">{error}</div>}

        {cancelled && (
          <div className="empty">
            Búsqueda cancelada.
            <br />
            <button className="btn btn--ghost btn--sm" onClick={() => setRetry((count) => count + 1)}>
              Reintentar
            </button>
          </div>
        )}

        {!loading &&
          result?.notes.map((note) => (
            <div className="alert alert--warn" key={note}>
              {note}
            </div>
          ))}

        {!loading && !error && result?.hasMoreWorkItems && (
          <div className="alert alert--info">
            <span>
              Mostrando los {result.workItems.length} work items más recientes; hay más coincidencias.
            </span>
            <button className="btn btn--ghost btn--sm" onClick={() => toggleShowAll(true)}>
              Mostrar todos
            </button>
          </div>
        )}

        {!loading && !error && result?.hasMorePullRequests && (
          <div className="alert alert--info">
            <span>Mostrando los {result.pullRequests.length} pull requests más recientes; hay más.</span>
            <button className="btn btn--ghost btn--sm" onClick={() => toggleShowAll(true)}>
              Mostrar todos
            </button>
          </div>
        )}

        {!loading && !error && result && total === 0 && result.notes.length === 0 && (
          <div className="empty">Sin resultados para «{term.trim()}».</div>
        )}

        {!loading && !error && !result && !cancelled && (
          <div className="help">
            <p className="help__lead">Dime y lo encuentro!.</p>
            <ul className="help__list">
              <li>
                <code>12345</code> <span>work item o pull request con ese número</span>
              </li>
              <li>
                <code>#12345</code> <span>solo el work item</span>
              </li>
              <li>
                <code>!6789</code> <span>solo el pull request</span>
              </li>
              <li>
                <code>!</code> <span>todos los pull requests, del más reciente al más antiguo</span>
              </li>
              <li>
                <code>#</code> <span>work items padre, del modificado más recientemente al más antiguo</span>
              </li>
              <li>
                <code>a1b2c3d…</code> <span>commit (SHA) y los PR que lo contienen</span>
              </li>
              <li>
                <code>%login%</code>{' '}
                <span>
                  solo títulos de work item; <code>%</code> es comodín (<code>login%</code> empieza por,{' '}
                  <code>%login</code> termina en, <code>login%error</code> ambos en orden)
                </span>
              </li>
              <li>
                <code>ExternalRef.</code>{' '}
                <span>Typea el prefijo ExternalReference para activar busqueda solo en ese campo.</span>
              </li>
              <li>
                <code>login</code>{' '}
                <span>texto en los lugares marcados en el filtro (título, descripción, colaborador, Discussion, adjuntos)</span>
              </li>
            </ul>
          </div>
        )}

        {!loading && result && total > 0 && (
          <div className="results-bar">
            <span className="results-bar__count">
              {titleNeedle ? `${filteredTotal} de ${total}` : total} resultado{(titleNeedle ? filteredTotal : total) === 1 ? '' : 's'}
            </span>
            <button
              className={`btn btn--ghost btn--icon title-filter__toggle${titleFilterOpen || titleNeedle ? ' title-filter__toggle--active' : ''}`}
              aria-expanded={titleFilterOpen}
              aria-label="Filtrar resultados por título"
              title="Filtrar estos resultados por título (work items, pull requests y commits)"
              onClick={() => (titleFilterOpen ? closeTitleFilter() : setTitleFilterOpen(true))}
            >
              <FilterIcon />
            </button>
          </div>
        )}

        {!loading && result && total > 0 && titleFilterOpen && (
          <div className="title-filter">
            <div className="field">
              <span className="field__icon">
                <FilterIcon />
              </span>
              <input
                ref={titleInputRef}
                className="input input--sm"
                type="text"
                value={titleFilter}
                spellCheck={false}
                onChange={(e) => setTitleFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') closeTitleFilter()
                }}
                placeholder="Filtrar por título…"
                aria-label="Filtrar resultados por título"
              />
              {titleFilter && (
                <button
                  className="btn btn--ghost btn--icon title-filter__clear"
                  onClick={() => {
                    setTitleFilter('')
                    titleInputRef.current?.focus()
                  }}
                  aria-label="Limpiar filtro"
                  title="Limpiar filtro"
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          </div>
        )}

        {!loading && result && total > 0 && titleNeedle && filteredTotal === 0 && (
          <div className="empty">Ningún título contiene «{titleFilter.trim()}».</div>
        )}

        {!loading && result && commitMatches.length > 0 && (
          <section className="section">
            <SectionTitle icon={<CommitIcon />} label="Commit" count={commitMatches.length} />
            {commitMatches.map((commit) => (
              <CommitRow key={`${commit.repositoryId}:${commit.commitId}`} commit={commit} highlight={titleNeedle} />
            ))}
          </section>
        )}

        {!loading && result && pullRequestMatches.length > 0 && (
          <section className="section">
            <SectionTitle
              icon={<PullRequestIcon />}
              label="Pull requests"
              count={pullRequestMatches.length}
            />
            <div className="pr-list pr-list--compact">
              {pullRequestMatches.map((match) => (
                <PullRequestCard
                  key={match.pullRequest.pullRequestId}
                  pr={match.pullRequest}
                  branchFilter=""
                  titleHighlight={titleNeedle}
                >
                  <div className="linked">
                    <div className="linked__title">
                      {match.workItems.length > 0
                        ? 'Work items vinculados'
                        : 'Sin work items vinculados'}
                    </div>
                    {match.workItems.map((item) => (
                      <button
                        key={item.id}
                        className="linked__item"
                        aria-selected={item.id === selectedId}
                        onClick={() => onSelect(item)}
                        title="Ver todos los pull requests de este work item"
                      >
                        <span className="wi__id">#{item.id}</span>
                        <span className="chip chip--type" style={typeStyle(item.type)}>
                          {item.type}
                        </span>
                        <span className="linked__text">{item.title}</span>
                      </button>
                    ))}
                  </div>
                </PullRequestCard>
              ))}
            </div>
          </section>
        )}

        {!loading && result && titleMatches.length > 0 && (
          <section className="section">
            <SectionTitle
              icon={<WorkItemIcon />}
              label={result.kind === 'parentWorkItems' ? 'Work items padre' : 'Work items'}
              count={visibleWorkItems.length}
            />
            {typeCounts.length > 1 && (
              <div className="filters filters--types" role="group" aria-label="Filtrar por tipo de work item">
                <button
                  className="filters__btn"
                  aria-pressed={activeType === null}
                  onClick={() => setTypeFilter(null)}
                >
                  Todos <span className="filters__count">{titleMatches.length}</span>
                </button>
                {typeCounts.map(([type, count]) => (
                  <button
                    key={type}
                    className="filters__btn filters__btn--type"
                    style={typeStyle(type)}
                    aria-pressed={activeType === type}
                    onClick={() => setTypeFilter(activeType === type ? null : type)}
                  >
                    {type} <span className="filters__count">{count}</span>
                  </button>
                ))}
              </div>
            )}
            {pageItems.map((item) => (
              <WorkItemRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                highlight={titleNeedle}
                onSelect={onSelect}
              />
            ))}
            {visibleWorkItems.length > 1 && (
              <Paginator
                page={currentPage}
                pageCount={pageCount}
                pageSize={pageSize}
                total={visibleWorkItems.length}
                onPageChange={goToPage}
                onPageSizeChange={changePageSize}
              />
            )}
          </section>
        )}
      </div>

      {slowPrompt && (
        <div className="dialog-backdrop">
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="slow-search-title">
            <div className="dialog__icon">
              <span className="spinner spinner--lg" />
            </div>
            <h2 className="dialog__title" id="slow-search-title">
              La búsqueda está tardando
            </h2>
            <p className="dialog__text">
              Lleva más de {SLOW_SEARCH_MS / 1000} segundos buscando «{term.trim()}». ¿Qué quieres hacer?
            </p>
            <div className="dialog__actions">
              <button className="btn" onClick={waitAgain} autoFocus title={`Vuelve a preguntar en ${SLOW_SEARCH_MS / 1000} segundos`}>
                Esperar
              </button>
              <button className="btn" onClick={waitUntilDone} title="No vuelve a preguntar hasta que termine">
                Seguir esperando
              </button>
              <button className="btn btn--danger" onClick={cancelSearch}>
                Cancelar búsqueda
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
