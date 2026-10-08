import { useState } from 'react'
import { Avatar } from './Avatar'
import { CommentComposer } from './CommentComposer'
import { RichHtml } from './RichHtml'
import { fieldText } from './WorkItemDetails'
import { formatAbsolute, formatRelative } from '../lib/format'
import type { FieldChange, WorkItemComment, WorkItemRevision } from '../../shared/types'

export interface Loadable<T> {
  data: T | null
  error: string | null
  loading: boolean
}

function LoadState<T>({ state, label, children }: { state: Loadable<T>; label: string; children: (data: T) => JSX.Element }) {
  if (state.loading) {
    return (
      <div className="loading-row">
        <span className="spinner" /> Cargando {label}…
      </div>
    )
  }
  if (state.error) return <div className="alert">{state.error}</div>
  return state.data ? children(state.data) : null
}

function When({ date }: { date: string }) {
  return <span title={formatAbsolute(date)}>{formatRelative(date)}</span>
}

/* ---------- Discussion ---------- */

export function WorkItemDiscussion({
  state,
  url,
  workItemId,
  onPosted
}: {
  state: Loadable<WorkItemComment[]>
  url: string
  workItemId: number
  onPosted: () => void
}) {
  return (
    <div className="pane__scroll">
      <CommentComposer workItemId={workItemId} onPosted={onPosted} />
      <LoadState state={state} label="comentarios">
        {(comments) =>
          comments.length === 0 ? (
            <div className="empty">
              Este work item aún no tiene comentarios. Escribe el primero arriba.
              <br />
              <button className="btn btn--ghost btn--sm" onClick={() => window.azdo.openExternal(url)}>
                Abrir en Azure DevOps
              </button>
            </div>
          ) : (
            <div className="timeline">
              {comments.map((comment) => (
                <article className="entry" key={comment.id}>
                  <header className="entry__head">
                    <Avatar name={comment.author} imageUrl={comment.authorImageUrl} small />
                    <strong>{comment.author}</strong>
                    <When date={comment.createdDate} />
                    {comment.modifiedDate && (
                      <span className="entry__edited" title={`Editado ${formatAbsolute(comment.modifiedDate)}`}>
                        (editado)
                      </span>
                    )}
                  </header>
                  <RichHtml html={comment.html} className="entry__body" />
                </article>
              ))}
            </div>
          )
        }
      </LoadState>
    </div>
  )
}

/* ---------- Historial ---------- */

/** Revisiones con muchos cambios (p. ej. la creación) se muestran recortadas. */
const COLLAPSED_CHANGES = 6

function ChangeValue({ change, value }: { change: FieldChange; value: string | null }) {
  if (value === null) return <span className="change__empty">vacío</span>
  return <>{fieldText(change.kind, value)}</>
}

function Revision({ revision }: { revision: WorkItemRevision }) {
  const [expanded, setExpanded] = useState(false)
  const created = revision.rev === 1
  const changes = expanded ? revision.changes : revision.changes.slice(0, COLLAPSED_CHANGES)
  const hidden = revision.changes.length - changes.length

  return (
    <article className="entry">
      <header className="entry__head">
        <Avatar name={revision.author} imageUrl={revision.authorImageUrl} small />
        <strong>{revision.author}</strong>
        <span>{created ? 'creó el work item' : 'actualizó'}</span>
        <When date={revision.date} />
        <span className="entry__rev">Rev {revision.rev}</span>
      </header>

      {revision.comment && <blockquote className="entry__comment">{revision.comment}</blockquote>}

      {changes.length > 0 && (
        <ul className="changes">
          {changes.map((change) => (
            <li className="change" key={change.refName}>
              <span className="change__field" title={change.refName}>
                {change.label}
              </span>
              <span className="change__values">
                {!created && change.oldValue !== null && (
                  <>
                    <del className="change__old">
                      <ChangeValue change={change} value={change.oldValue} />
                    </del>
                    <span className="arrow">&rarr;</span>
                  </>
                )}
                <span className="change__new">
                  <ChangeValue change={change} value={change.newValue} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button className="btn btn--ghost btn--sm entry__more" onClick={() => setExpanded(true)}>
          Ver {hidden} cambio(s) más
        </button>
      )}

      {revision.links.length > 0 && (
        <ul className="changes">
          {revision.links.map((link, index) => (
            <li className={`change change--link change--${link.action}`} key={index}>
              <span className="change__sign">{link.action === 'added' ? '+' : '−'}</span>
              <span>{link.text}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

export function WorkItemHistory({ state }: { state: Loadable<WorkItemRevision[]> }) {
  return (
    <div className="pane__scroll">
      <LoadState state={state} label="historial">
        {(revisions) =>
          revisions.length === 0 ? (
            <div className="empty">No hay cambios registrados.</div>
          ) : (
            <div className="timeline">
              {revisions.map((revision) => (
                <Revision key={revision.rev} revision={revision} />
              ))}
            </div>
          )
        }
      </LoadState>
    </div>
  )
}
