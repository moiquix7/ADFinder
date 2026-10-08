import type { ReactNode } from 'react'
import { Avatar } from './Avatar'
import { BranchIcon, ExternalIcon } from './Icons'
import { formatAbsolute, formatRelative } from '../lib/format'
import { Highlight } from '../lib/highlight'
import type { PullRequestStatus, PullRequestSummary } from '../../shared/types'

const STATUS_LABEL: Record<PullRequestStatus, string> = {
  active: 'Activo',
  completed: 'Completado',
  abandoned: 'Abandonado',
  notSet: 'Sin estado',
  all: 'Todos'
}

const VOTE_CLASS: Record<string, string> = {
  '10': 'approved',
  '5': 'suggestions',
  '0': 'none',
  '-5': 'waiting',
  '-10': 'rejected'
}

const VOTE_LABEL: Record<string, string> = {
  '10': 'Aprobado',
  '5': 'Aprobado con sugerencias',
  '0': 'Sin votar',
  '-5': 'En espera del autor',
  '-10': 'Rechazado'
}

/** Resalta el texto del filtro dentro del nombre de la rama. */
function highlight(text: string, needle: string) {
  const trimmed = needle.trim()
  if (!trimmed) return text
  const index = text.toLowerCase().indexOf(trimmed.toLowerCase())
  if (index < 0) return text
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + trimmed.length)}</mark>
      {text.slice(index + trimmed.length)}
    </>
  )
}

interface PullRequestCardProps {
  pr: PullRequestSummary
  branchFilter: string
  /** Texto (normalizado) que se resalta en el título del PR. */
  titleHighlight?: string
  /** Contenido extra al pie de la tarjeta (p. ej. work items vinculados). */
  children?: ReactNode
}

export function PullRequestCard({ pr, branchFilter, titleHighlight = '', children }: PullRequestCardProps) {
  const open = () => window.azdo.openExternal(pr.webUrl)

  return (
    <article className="pr">
      <div className="pr__top">
        <div className="pr__title">
          <button className="pr__link" onClick={open} title={pr.webUrl}>
            <span className="pr__id">!{pr.pullRequestId}</span> <Highlight text={pr.title} needle={titleHighlight} />
          </button>
        </div>
        {pr.isDraft && <span className="chip chip--draft">Borrador</span>}
        <span className={`chip chip--${pr.status}`}>{STATUS_LABEL[pr.status] ?? pr.status}</span>
        <button className="btn btn--ghost btn--icon" onClick={open} title="Abrir en Azure DevOps">
          <ExternalIcon />
        </button>
      </div>

      <div className="pr__branches">
        <span className="branch branch--source" title={pr.sourceBranch}>
          <BranchIcon />
          {highlight(pr.sourceBranch, branchFilter)}
        </span>
        <span className="arrow">&rarr;</span>
        <span className="branch" title={pr.targetBranch}>
          {highlight(pr.targetBranch, branchFilter)}
        </span>
      </div>

      <div className="pr__footer">
        <span className="who">
          <Avatar name={pr.createdBy} imageUrl={pr.createdByImageUrl} small />
          {pr.createdBy}
        </span>
        <span title={formatAbsolute(pr.creationDate)}>creado {formatRelative(pr.creationDate)}</span>
        <span>· {pr.repositoryName}</span>
        {pr.mergeStatus === 'conflicts' && <span className="pr__conflicts">· Conflictos</span>}

        {pr.reviewers.length > 0 && (
          <span className="reviewers">
            {pr.reviewers.map((reviewer) => (
              <span className="reviewer" key={reviewer.displayName}>
                <Avatar
                  name={reviewer.displayName}
                  imageUrl={reviewer.imageUrl}
                  small
                  title={`${reviewer.displayName} — ${VOTE_LABEL[String(reviewer.vote)] ?? 'Sin votar'}`}
                />
                <span
                  className={`reviewer__vote reviewer__vote--${VOTE_CLASS[String(reviewer.vote)] ?? 'none'}`}
                />
              </span>
            ))}
          </span>
        )}
      </div>
      {children}
    </article>
  )
}
