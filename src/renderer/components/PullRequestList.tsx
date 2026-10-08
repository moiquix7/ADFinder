import { useMemo, useState } from 'react'
import { PullRequestCard } from './PullRequestCard'
import { BranchIcon } from './Icons'
import type { PullRequestStatus, WorkItemDetail } from '../../shared/types'

type StatusFilter = 'all' | 'active' | 'completed' | 'abandoned'

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'active', label: 'Activos' },
  { value: 'completed', label: 'Completados' },
  { value: 'abandoned', label: 'Abandonados' }
]

/** Pestaña de pull requests del work item: filtro por rama y por estado. */
export function PullRequestList({ detail }: { detail: WorkItemDetail }) {
  const [branchFilter, setBranchFilter] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')

  const all = detail.pullRequests

  const visible = useMemo(() => {
    const needle = branchFilter.trim().toLowerCase()
    return all.filter((pr) => {
      if (status !== 'all' && (pr.status as PullRequestStatus) !== status) return false
      if (!needle) return true
      return pr.sourceBranch.toLowerCase().includes(needle) || pr.targetBranch.toLowerCase().includes(needle)
    })
  }, [all, branchFilter, status])

  return (
    <>
      <div className="toolbar">
        <div className="field">
          <span className="field__icon">
            <BranchIcon />
          </span>
          <input
            className="input"
            type="search"
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            placeholder="Filtrar por rama…"
            aria-label="Filtrar pull requests por rama"
          />
        </div>

        <div className="filters">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              className="filters__btn"
              aria-pressed={status === filter.value}
              onClick={() => setStatus(filter.value)}
            >
              {filter.label}
            </button>
          ))}
          <span className="count">
            {visible.length}/{all.length}
          </span>
        </div>
      </div>

      {detail.unresolved.length > 0 && (
        <div className="alert alert--warn">
          {detail.unresolved.length} pull request(s) vinculados no se pudieron cargar (repositorio
          eliminado o sin permisos).
        </div>
      )}

      <div className="pane__scroll">
        {all.length === 0 && <div className="empty">Este work item no tiene pull requests vinculados.</div>}

        {all.length > 0 && visible.length === 0 && (
          <div className="empty">Ningún pull request coincide con el filtro aplicado.</div>
        )}

        {visible.length > 0 && (
          <div className="pr-list">
            {visible.map((pr) => (
              <PullRequestCard key={pr.pullRequestId} pr={pr} branchFilter={branchFilter} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}
