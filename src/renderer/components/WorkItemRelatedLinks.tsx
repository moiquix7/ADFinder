import type { ReactNode } from 'react'
import { Avatar } from './Avatar'
import { ExternalIcon, PullRequestIcon } from './Icons'
import { typeStyle } from '../lib/workItemType'
import type { RelatedLink, WorkItemDetail, WorkItemSummary } from '../../shared/types'

/** Vínculos que se muestran en la pestaña: solo los pull requests (sin ramas, commits ni enlaces). */
export function relatedPullRequests(detail: WorkItemDetail): RelatedLink[] {
  return detail.relatedLinks.filter((link) => link.kind === 'pullRequest')
}

function PullRequestRow({ link }: { link: RelatedLink }) {
  const open = () => link.url && window.azdo.openExternal(link.url)
  return (
    <div className="relation">
      <span className="relation__kind">{link.relation}</span>
      <button
        className="relation__item"
        onClick={open}
        disabled={!link.url}
        title={link.comment ?? link.url ?? 'No se puede abrir este vínculo'}
      >
        <span className="related__icon">
          <PullRequestIcon />
        </span>
        <span className="relation__title">{link.title}</span>
        {link.detail && <span className="relation__state">{link.detail}</span>}
      </button>
      {link.url ? (
        <button className="btn btn--ghost btn--icon" onClick={open} title="Abrir en el navegador">
          <ExternalIcon />
        </button>
      ) : (
        <span />
      )}
    </div>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="details__section">
      <h3 className="section-title">
        {title} <span className="section-title__count">{count}</span>
      </h3>
      <div className="relations">{children}</div>
    </section>
  )
}

interface WorkItemRelatedLinksProps {
  detail: WorkItemDetail
  onOpenWorkItem: (workItem: WorkItemSummary) => void
}

/** Pestaña «Related links»: work items vinculados (con su asignado) y pull requests. */
export function WorkItemRelatedLinks({ detail, onOpenWorkItem }: WorkItemRelatedLinksProps) {
  const pullRequests = relatedPullRequests(detail)

  if (detail.links.length === 0 && pullRequests.length === 0) {
    return (
      <div className="pane__scroll">
        <div className="empty">
          Este work item no tiene work items ni pull requests vinculados.
          <br />
          <button className="btn btn--ghost btn--sm" onClick={() => window.azdo.openExternal(detail.workItem.url)}>
            Vincular en Azure DevOps
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="pane__scroll details">
      {detail.links.length > 0 && (
        <Section title="Work items" count={detail.links.length}>
          {detail.links.map(({ relation, workItem }) => (
            <div className="relation" key={`${relation}-${workItem.id}`}>
              <span className="relation__kind">{relation}</span>
              <button className="relation__item relation__item--stacked" onClick={() => onOpenWorkItem(workItem)} title="Ver este work item">
                <span className="relation__line">
                  <span className="chip chip--type" style={typeStyle(workItem.type)}>
                    {workItem.type}
                  </span>
                  <span className="wi__id">#{workItem.id}</span>
                  <span className="relation__title">{workItem.title}</span>
                  <span className="relation__state">{workItem.state}</span>
                </span>
                <span className="relation__assignee">
                  {workItem.assignedTo ? (
                    <>
                      <Avatar name={workItem.assignedTo} imageUrl={workItem.assignedToImageUrl} small />
                      {workItem.assignedTo}
                    </>
                  ) : (
                    <span className="relation__unassigned">Sin asignar</span>
                  )}
                </span>
              </button>
              <button
                className="btn btn--ghost btn--icon"
                onClick={() => window.azdo.openExternal(workItem.url)}
                title="Abrir en Azure DevOps"
              >
                <ExternalIcon />
              </button>
            </div>
          ))}
        </Section>
      )}

      {pullRequests.length > 0 && (
        <Section title="Pull requests" count={pullRequests.length}>
          {pullRequests.map((link, index) => (
            <PullRequestRow key={`${link.url ?? link.title}-${index}`} link={link} />
          ))}
        </Section>
      )}
    </div>
  )
}
