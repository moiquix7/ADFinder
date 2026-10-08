import { useState } from 'react'
import { CheckIcon, DownloadIcon, ExternalIcon, FolderIcon, PaperclipIcon } from './Icons'
import { formatAbsolute, formatRelative, formatSize } from '../lib/format'
import type { AttachmentInfo } from '../../shared/types'

type DownloadState =
  | { status: 'idle' }
  | { status: 'downloading' }
  | { status: 'done'; path: string }
  | { status: 'failed'; error: string }

function AttachmentCard({ attachment }: { attachment: AttachmentInfo }) {
  const [download, setDownload] = useState<DownloadState>({ status: 'idle' })

  const save = async () => {
    setDownload({ status: 'downloading' })
    const result = await window.azdo.downloadAttachment(attachment.url, attachment.name)
    if (!result.ok) setDownload({ status: 'failed', error: result.error })
    // null: se canceló el diálogo de guardar.
    else setDownload(result.data ? { status: 'done', path: result.data } : { status: 'idle' })
  }

  return (
    <article className="entry attachment-card">
      <span className="attachment-card__icon">
        <PaperclipIcon />
      </span>
      <div className="attachment-card__body">
        <div className="attachment-card__name" title={attachment.name}>
          {attachment.name}
        </div>
        <div className="entry__head">
          {attachment.size !== null && <span>{formatSize(attachment.size)}</span>}
          {attachment.addedDate && (
            <span title={formatAbsolute(attachment.addedDate)}>
              {attachment.size !== null && '· '}añadido {formatRelative(attachment.addedDate)}
            </span>
          )}
        </div>
        {attachment.comment && <p className="entry__comment">{attachment.comment}</p>}
        {download.status === 'done' && (
          <div className="attachment-card__saved">
            <CheckIcon /> Guardado en <span className="attachment-card__path">{download.path}</span>
          </div>
        )}
        {download.status === 'failed' && <div className="alert attachment-card__alert">{download.error}</div>}
      </div>
      <div className="attachment-card__actions">
        {download.status === 'done' ? (
          <button
            className="btn btn--ghost btn--icon"
            onClick={() => window.azdo.showItemInFolder(download.path)}
            title="Mostrar en la carpeta"
            aria-label="Mostrar en la carpeta"
          >
            <FolderIcon />
          </button>
        ) : (
          <button
            className="btn btn--ghost btn--icon"
            onClick={save}
            disabled={download.status === 'downloading'}
            title="Descargar"
            aria-label={`Descargar ${attachment.name}`}
          >
            {download.status === 'downloading' ? <span className="spinner" /> : <DownloadIcon />}
          </button>
        )}
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => window.azdo.openExternal(attachment.url)}
          title="Abrir en el navegador"
          aria-label={`Abrir ${attachment.name} en el navegador`}
        >
          <ExternalIcon />
        </button>
      </div>
    </article>
  )
}

/** Archivos de la sección Attachments del work item: se descargan con la sesión de la app. */
export function WorkItemAttachments({ attachments, url }: { attachments: AttachmentInfo[]; url: string }) {
  if (attachments.length === 0) {
    return (
      <div className="pane__scroll">
        <div className="empty">
          Este work item no tiene adjuntos.
          <br />
          <button className="btn btn--ghost btn--sm" onClick={() => window.azdo.openExternal(url)}>
            Adjuntar en Azure DevOps
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="pane__scroll">
      <div className="timeline">
        {attachments.map((attachment) => (
          <AttachmentCard key={attachment.url} attachment={attachment} />
        ))}
      </div>
    </div>
  )
}
