import { useEffect, useMemo, useState } from 'react'
import { Avatar } from './Avatar'
import { BranchIcon, CheckIcon, CopyIcon, PullRequestIcon, SearchIcon } from './Icons'
import type { Loadable } from './WorkItemActivity'
import { formatAbsolute, normalizeText } from '../lib/format'
import { Highlight } from '../lib/highlight'
import type {
  PullRequestSummary,
  WorkItemBranch,
  WorkItemCommit,
  WorkItemCommitSource,
  WorkItemCommits
} from '../../shared/types'

const branchKey = (branch: WorkItemBranch) => `${branch.repositoryId.toLowerCase()}/${branch.name}`

const ORIGIN_GROUP: Record<WorkItemBranch['origin'], string> = {
  link: 'Ramas vinculadas al work item',
  pullRequestSource: 'Ramas origen de los PR',
  pullRequestTarget: 'Ramas destino de los PR',
  repositoryDefault: 'Rama por defecto del repositorio'
}

/**
 * Nombre de la última rama elegida: se vuelve a elegir sola en otros work items que la tengan (p. ej. `rc`).
 * Vacío = «Sin rama» elegido a propósito; sin valor guardado se elige una rama por defecto.
 */
const BRANCH_KEY = 'workItemCommits.branch'

function loadBranchName(): string | null {
  try {
    return localStorage.getItem(BRANCH_KEY)
  } catch {
    return null
  }
}

function saveBranchName(name: string): void {
  try {
    localStorage.setItem(BRANCH_KEY, name)
  } catch {
    // Sin almacenamiento disponible: la rama vale solo para esta sesión.
  }
}

function branchLabel(branch: WorkItemBranch, showRepository: boolean): string {
  const prs = branch.pullRequestIds.map((id) => `!${id}`).join(', ')
  return `${branch.name}${showRepository ? ` · ${branch.repositoryName}` : ''}${prs ? ` (${prs})` : ''}`
}

/** Estado de merge del PR (segunda línea de la columna de rama). */
const MERGE_STATUS: Record<string, { text: string; tone: 'ok' | 'bad' | 'muted' }> = {
  succeeded: { text: 'merge correcto', tone: 'ok' },
  conflicts: { text: 'conflictos', tone: 'bad' },
  failure: { text: 'merge fallido', tone: 'bad' },
  rejectedByPolicy: { text: 'rechazado por política', tone: 'bad' },
  queued: { text: 'merge en cola', tone: 'muted' }
}

const TONE_MARK = { ok: '✓', bad: '✗', muted: '…' } as const

type StatusFilter = 'all' | 'in' | 'out'

/** Botón que copia un texto y confirma con un check unos instantes. */
function CopyButton({ text, title, label }: { text: string; title: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (status === 'idle') return
    const timer = setTimeout(() => setStatus('idle'), 1500)
    return () => clearTimeout(timer)
  }, [status])

  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => setStatus('copied'),
      () => setStatus('failed')
    )

  return (
    <button
      className={
        label
          ? `btn btn--ghost btn--sm copy-btn${status === 'copied' ? ' copy-btn--done' : ''}`
          : `ch__copy${status === 'copied' ? ' copy-btn--done' : ''}`
      }
      onClick={copy}
      title={status === 'failed' ? 'No se pudo copiar' : title}
      aria-label={title}
    >
      {status === 'copied' ? <CheckIcon /> : <CopyIcon />}
      {label && (status === 'copied' ? 'Copiado' : status === 'failed' ? 'No se pudo copiar' : label)}
    </button>
  )
}

/** PR por los que el commit está en el historial, sin repetir (un commit puede ser del PR y su merge). */
function commitPullRequests(sources: WorkItemCommitSource[]): { id: number; merge: boolean }[] {
  const byId = new Map<number, boolean>()
  for (const source of sources) {
    if (source.kind === 'link') continue
    byId.set(source.pullRequestId, (byId.get(source.pullRequestId) ?? false) || source.kind === 'merge')
  }
  return [...byId].map(([id, merge]) => ({ id, merge }))
}

interface CommitRowProps {
  commit: WorkItemCommit
  highlight: string
  pullRequests: Map<number, PullRequestSummary>
  /** null: no hay rama elegida o aún se está comprobando. */
  inBranch: boolean | null
  branchName: string | null
}

function CommitRow({ commit, highlight, pullRequests, inBranch, branchName }: CommitRowProps) {
  const prs = commitPullRequests(commit.sources)
  const linked = commit.sources.some((source) => source.kind === 'link')
  const firstPr = prs.length > 0 ? pullRequests.get(prs[0].id) : undefined
  const merge = firstPr?.mergeStatus ? MERGE_STATUS[firstPr.mergeStatus] : undefined
  const tone = inBranch === null ? 'unknown' : inBranch ? 'in' : 'out'

  return (
    <div className={`ch__row ch__row--${tone}`} role="row">
      <div className="ch__graph" role="cell" aria-hidden="true">
        <span className="ch__dot" />
      </div>

      <div className="ch__commit" role="cell">
        <div className="ch__message" title={commit.comment}>
          {commit.comment ? <Highlight text={commit.comment} needle={highlight} /> : '(sin mensaje)'}
        </div>
        <div className="ch__meta">
          <button
            className="ch__sha"
            onClick={() => window.azdo.openExternal(commit.webUrl)}
            title={`Abrir ${commit.commitId} en Azure DevOps (${commit.repositoryName})`}
          >
            {commit.commitId.slice(0, 8)}
          </button>
          <CopyButton text={commit.commitId} title={`Copiar SHA ${commit.commitId}`} />
          <span className="ch__author">
            <Avatar name={commit.author} imageUrl={null} small />
            {commit.author}
          </span>
          {commit.authorDate && <span className="ch__date">{formatAbsolute(commit.authorDate)}</span>}
          {linked && (
            <span className="ch__tag" title="Commit vinculado directamente al work item">
              vinculado
            </span>
          )}
        </div>
      </div>

      <div className="ch__pr" role="cell">
        {prs.length === 0 ? (
          <span className="ch__none">—</span>
        ) : (
          prs.map(({ id, merge: isMerge }) => {
            const pr = pullRequests.get(id)
            return (
              <span key={id} className="ch__pr-item">
                <PullRequestIcon />
                <button
                  className="ch__link"
                  disabled={!pr}
                  onClick={() => pr && window.azdo.openExternal(pr.webUrl)}
                  title={pr ? `!${id} ${pr.title}` : `!${id}`}
                >
                  {id}
                </button>
                {isMerge && (
                  <span className="ch__tag" title="Commit con el que se completó el PR en la rama destino">
                    merge
                  </span>
                )}
              </span>
            )
          })
        )}
      </div>

      <div className="ch__status" role="cell">
        {inBranch === null ? (
          <span className="ch__none" title={branchName ? 'Comprobando…' : 'Elige una rama para ver si el commit está en ella'}>
            —
          </span>
        ) : (
          <span className={inBranch ? 'ch__ok' : 'ch__bad'}>
            {inBranch ? '✓' : '✗'} {inBranch ? 'en' : 'no en'} {branchName}
          </span>
        )}
        {merge && (
          <span className={`ch__${merge.tone}`} title={`Estado de merge del pull request !${prs[0].id}`}>
            {TONE_MARK[merge.tone]} {merge.text}
          </span>
        )}
      </div>
    </div>
  )
}

type BranchCheck = { loading: true } | { loading: false; ids: Set<string>; error: string | null }

/**
 * Pestaña de historial de commits, del más reciente al más antiguo, en forma de tabla: grafo,
 * commit (mensaje, SHA copiable, autor y fecha), PR y si el commit está en la rama elegida. Se
 * filtra por texto y por estar o no en esa rama (se comprueba en Azure DevOps).
 */
export function WorkItemCommitHistory({ state }: { state: Loadable<WorkItemCommits> }) {
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [textFilter, setTextFilter] = useState('')
  const [checks, setChecks] = useState<Record<string, BranchCheck>>({})

  const data = state.data

  // Sin elección en este work item: la rama elegida la última vez si está entre las suyas; si no,
  // la rama destino de sus PR (donde acaba el trabajo) o la rama por defecto del repositorio.
  const effectiveBranch = useMemo(() => {
    if (!data) return null
    if (selectedBranch !== null) return data.branches.find((item) => branchKey(item) === selectedBranch) ?? null
    const remembered = loadBranchName()
    if (remembered === '') return null
    return (
      (remembered ? data.branches.find((item) => item.name === remembered) : undefined) ??
      data.branches.find((item) => item.origin === 'pullRequestTarget') ??
      data.branches.find((item) => item.origin === 'repositoryDefault') ??
      null
    )
  }, [data, selectedBranch])
  const branch = effectiveBranch
  const check = branch ? checks[branchKey(branch)] : undefined
  const checking = branch !== null && (!check || check.loading)

  // Datos nuevos (otro work item o recarga): lo comprobado antes ya no vale.
  useEffect(() => setChecks({}), [data])

  useEffect(() => {
    if (!branch || !data || check) return
    const key = branchKey(branch)
    const repositoryId = branch.repositoryId.toLowerCase()
    const ids = data.commits
      .filter((commit) => commit.repositoryId.toLowerCase() === repositoryId)
      .map((commit) => commit.commitId)
    if (ids.length === 0) {
      setChecks((previous) => ({ ...previous, [key]: { loading: false, ids: new Set(), error: null } }))
      return
    }
    setChecks((previous) => ({ ...previous, [key]: { loading: true } }))
    window.azdo.getCommitsInBranch(branch.repositoryId, branch.name, ids).then((result) =>
      setChecks((previous) => ({
        ...previous,
        [key]: result.ok
          ? { loading: false, ids: new Set(result.data.map((id) => id.toLowerCase())), error: null }
          : { loading: false, ids: new Set(), error: result.error }
      }))
    )
  }, [branch, data, check])

  const changeBranch = (key: string) => {
    setSelectedBranch(key)
    const next = data?.branches.find((item) => branchKey(item) === key)
    saveBranchName(next?.name ?? '')
    if (!next) setStatusFilter('all')
  }

  const inBranch = (commit: WorkItemCommit): boolean | null => {
    if (!branch || !check || check.loading || check.error) return null
    return check.ids.has(commit.commitId.toLowerCase())
  }

  const needle = normalizeText(textFilter.trim())
  const visible = useMemo(() => {
    if (!data) return []
    return data.commits.filter((commit) => {
      if (statusFilter !== 'all' && branch) {
        const state = inBranch(commit)
        if (state === null) return false
        if (state !== (statusFilter === 'in')) return false
      }
      if (!needle) return true
      return (
        normalizeText(commit.comment).includes(needle) ||
        normalizeText(commit.author).includes(needle) ||
        commit.commitId.toLowerCase().startsWith(needle)
      )
    })
    // inBranch depende de branch y check.
  }, [data, branch, check, statusFilter, needle])

  const pullRequests = useMemo(
    () => new Map((data?.pullRequests ?? []).map((pr) => [pr.pullRequestId, pr])),
    [data]
  )

  if (state.loading) {
    return (
      <div className="loading-row">
        <span className="spinner" /> Cargando commits de los pull requests…
      </div>
    )
  }
  if (state.error) return <div className="alert">{state.error}</div>
  if (!data) return null

  const showRepository = new Set(data.branches.map((item) => item.repositoryId.toLowerCase())).size > 1
  const groups = (Object.keys(ORIGIN_GROUP) as WorkItemBranch['origin'][])
    .map((origin) => ({ origin, branches: data.branches.filter((item) => item.origin === origin) }))
    .filter((group) => group.branches.length > 0)
  const statusFilters: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: 'Todos' },
    { value: 'in', label: branch ? `En ${branch.name}` : 'En la rama' },
    { value: 'out', label: branch ? `No en ${branch.name}` : 'No en la rama' }
  ]
  const hideRows = checking && statusFilter !== 'all'

  return (
    <>
      <div className="toolbar toolbar--wrap">
        <div className="field">
          <span className="field__icon">
            <BranchIcon />
          </span>
          <select
            className="input select"
            value={branch ? branchKey(branch) : ''}
            onChange={(e) => changeBranch(e.target.value)}
            aria-label="Rama con la que se comparan los commits"
            title="Rama con la que se comparan los commits (columna «En rama»)"
            disabled={data.branches.length === 0}
          >
            <option value="">Sin rama</option>
            {groups.map((group) => (
              <optgroup key={group.origin} label={ORIGIN_GROUP[group.origin]}>
                {group.branches.map((item) => (
                  <option key={branchKey(item)} value={branchKey(item)}>
                    {branchLabel(item, showRepository)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="field__icon">
            <SearchIcon />
          </span>
          <input
            className="input"
            type="search"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="Filtrar por mensaje, SHA o autor…"
            aria-label="Filtrar commits por mensaje, SHA o autor"
          />
        </div>
        <div className="filters">
          {statusFilters.map((filter) => (
            <button
              key={filter.value}
              className="filters__btn"
              aria-pressed={statusFilter === filter.value}
              disabled={filter.value !== 'all' && !branch}
              onClick={() => setStatusFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
          <span className="count">
            {hideRows ? '…' : visible.length}/{data.commits.length}
          </span>
          {visible.length > 0 && !hideRows && (
            <CopyButton
              text={visible.map((commit) => commit.commitId).join('\n')}
              title="Copiar los SHA completos de los commits visibles (uno por línea)"
              label="Copiar SHA"
            />
          )}
        </div>
      </div>

      {data.notes.map((note) => (
        <div className="alert alert--warn" key={note}>
          {note}
        </div>
      ))}

      {branch && check && !check.loading && check.error && <div className="alert">{check.error}</div>}

      <div className="pane__scroll">
        {data.commits.length === 0 ? (
          <div className="empty">
            Este work item no tiene commits: ni pull requests vinculados con commits ni commits vinculados.
          </div>
        ) : (
          <div className="ch" role="table" aria-label="Historial de commits">
            <div className="ch__head" role="row">
              <span role="columnheader">Grafo</span>
              <span role="columnheader">Commit</span>
              <span role="columnheader">Pull request</span>
              <span role="columnheader" className="ch__head-branch">
                {checking && <span className="spinner spinner--sm" />}
                {branch ? `En ${branch.name}` : 'En rama'}
              </span>
            </div>

            {hideRows ? (
              <div className="loading-row">
                <span className="spinner" /> Comprobando qué commits están en {branch?.name}…
              </div>
            ) : visible.length === 0 ? (
              <div className="empty">
                Ningún commit coincide con los filtros aplicados.
              </div>
            ) : (
              visible.map((commit) => (
                <CommitRow
                  key={`${commit.repositoryId}/${commit.commitId}`}
                  commit={commit}
                  highlight={needle}
                  pullRequests={pullRequests}
                  inBranch={inBranch(commit)}
                  branchName={branch?.name ?? null}
                />
              ))
            )}
          </div>
        )}
      </div>
    </>
  )
}
