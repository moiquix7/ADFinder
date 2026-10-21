import { useEffect, useState } from 'react'
import { Avatar } from './Avatar'
import { CheckIcon, CopyIcon, ExternalIcon } from './Icons'
import { RichHtml } from './RichHtml'
import { relatedPullRequests } from './WorkItemRelatedLinks'
import { formatAbsolute, formatRelative, formatSize } from '../lib/format'
import type { FieldKind, FieldValue, WorkItemDetail } from '../../shared/types'

/** Texto de un valor según su tipo (las fechas llegan en ISO). */
export function fieldText(kind: FieldKind, value: string): string {
  return kind === 'date' ? formatAbsolute(value) || value : value
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TABLE'])

/** Texto plano de un HTML de Azure DevOps, conservando los saltos de línea de bloques y <br>. */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  let text = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent
    else if (node.nodeName === 'BR') text += '\n'
    else if (node.nodeName === 'LI') text += '• '
    if (node.nodeName !== 'BR') node.childNodes.forEach(walk)
    if (node.nodeName === 'TD' || node.nodeName === 'TH') text += '\t'
    if (BLOCK_TAGS.has(node.nodeName)) text += '\n'
  }
  walk(doc.body)
  return text.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const fieldLines = (fields: FieldValue[]) => fields.map((field) => `${field.label}: ${fieldText(field.kind, field.value)}`)

/** Todo el contenido de la pestaña Detalles como texto plano, listo para pegar en un correo o ticket. */
function detailsToText(detail: WorkItemDetail): string {
  const { workItem } = detail
  const sections: string[] = [
    [`#${workItem.id} · ${workItem.type} · ${workItem.state}`, workItem.title, workItem.url].join('\n')
  ]
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) sections.push([`== ${title} ==`, ...lines].join('\n'))
  }

  for (const group of detail.groups) section(group.title, fieldLines(group.fields))
  for (const field of detail.richText) section(field.label, [htmlToText(field.value)])
  section(
    'Related links: work items',
    detail.links.map(({ relation, workItem: linked }) => `${relation}: #${linked.id} ${linked.type} — ${linked.title} (${linked.state}) · ${linked.assignedTo ?? 'Sin asignar'}`)
  )
  section(
    'Related links: pull requests',
    relatedPullRequests(detail).map((link) =>
      [`${link.relation}: ${link.title}`, link.detail, link.url].filter(Boolean).join(' · ')
    )
  )
  section(
    'Adjuntos',
    detail.attachments.map((attachment) =>
      [attachment.name, formatSize(attachment.size)].filter(Boolean).join(' · ')
    )
  )
  section('Otros campos', fieldLines(detail.otherFields))
  return sections.join('\n\n')
}

function CopyDetailsButton({ detail }: { detail: WorkItemDetail }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (status === 'idle') return
    const timer = setTimeout(() => setStatus('idle'), 1800)
    return () => clearTimeout(timer)
  }, [status])

  const copy = () =>
    navigator.clipboard.writeText(detailsToText(detail)).then(
      () => setStatus('copied'),
      () => setStatus('failed')
    )

  return (
    <button
      className={`btn btn--ghost btn--sm copy-btn${status === 'copied' ? ' copy-btn--done' : ''}`}
      onClick={copy}
      title="Copiar todos los detalles al portapapeles como texto"
    >
      {status === 'copied' ? <CheckIcon /> : <CopyIcon />}
      {status === 'copied' ? 'Copiado' : status === 'failed' ? 'No se pudo copiar' : 'Copiar detalles'}
    </button>
  )
}

function FieldView({ field }: { field: FieldValue }) {
  if (field.url) {
    const url = field.url
    return (
      <button className="field-link" onClick={() => window.azdo.openExternal(url)} title={url}>
        {field.value}
        <ExternalIcon />
      </button>
    )
  }
  switch (field.kind) {
    case 'identity':
      return (
        <span className="who">
          <Avatar name={field.value} imageUrl={field.imageUrl ?? null} small />
          {field.value}
        </span>
      )
    case 'date':
      return <span title={formatRelative(field.value)}>{fieldText('date', field.value)}</span>
    case 'tags':
      return (
        <span className="tags">
          {field.value.split(';').map((tag) => tag.trim()).filter(Boolean).map((tag) => (
            <span key={tag} className="chip chip--neutral">
              {tag}
            </span>
          ))}
        </span>
      )
    case 'path':
      return <span className="field-value--path">{field.value}</span>
    default:
      return <span className="field-value--text">{field.value}</span>
  }
}

function FieldGrid({ fields }: { fields: FieldValue[] }) {
  return (
    <dl className="fields">
      {fields.map((field) => (
        <div
          key={field.refName}
          className={`fields__item${field.kind === 'tags' || field.kind === 'path' ? ' fields__item--wide' : ''}`}
        >
          <dt title={field.refName}>{field.label}</dt>
          <dd>
            <FieldView field={field} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

interface WorkItemDetailsProps {
  detail: WorkItemDetail
}

export function WorkItemDetails({ detail }: WorkItemDetailsProps) {
  const [status, ...otherGroups] = detail.groups
  const showStatusFirst = status?.title === 'Estado'

  return (
    <div className="pane__scroll details">
      <div className="details__toolbar">
        <CopyDetailsButton detail={detail} />
      </div>

      {showStatusFirst && (
        <section className="details__section">
          <h3 className="section-title">{status.title}</h3>
          <FieldGrid fields={status.fields} />
        </section>
      )}

      {detail.richText.map((field) => (
        <section className="details__section" key={field.refName}>
          <h3 className="section-title" title={field.refName}>
            {field.label}
          </h3>
          <RichHtml html={field.value} className="rich--card" />
        </section>
      ))}

      {(showStatusFirst ? otherGroups : detail.groups).map((group) => (
        <section className="details__section" key={group.title}>
          <h3 className="section-title">{group.title}</h3>
          <FieldGrid fields={group.fields} />
        </section>
      ))}

      {detail.otherFields.length > 0 && (
        <details className="details__section details__more">
          <summary className="section-title">
            Otros campos <span className="section-title__count">{detail.otherFields.length}</span>
          </summary>
          <FieldGrid fields={detail.otherFields} />
        </details>
      )}
    </div>
  )
}
