import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Avatar } from './Avatar'
import { PullRequestList } from './PullRequestList'
import { WorkItemAttachments } from './WorkItemAttachments'
import { WorkItemDetails } from './WorkItemDetails'
import { WorkItemRelatedLinks, relatedPullRequests } from './WorkItemRelatedLinks'
import { WorkItemDiscussion, WorkItemHistory, type Loadable } from './WorkItemActivity'
import {
  BackIcon,
  CommentIcon,
  ExternalIcon,
  HistoryIcon,
  InfoIcon,
  LinkIcon,
  PaperclipIcon,
  PullRequestIcon,
  RefreshIcon
} from './Icons'
import { formatAbsolute, formatRelative } from '../lib/format'
import { typeStyle } from '../lib/workItemType'
import type { IpcResult, WorkItemDetail, WorkItemSummary } from '../../shared/types'

type Tab = 'details' | 'pullRequests' | 'discussion' | 'attachments' | 'relatedLinks' | 'history'

const TABS: Tab[] = ['details', 'pullRequests', 'discussion', 'attachments', 'relatedLinks', 'history']
const TAB_KEY = 'workItemPanel.tab'

function loadTab(): Tab {
  try {
    const stored = localStorage.getItem(TAB_KEY) as Tab | null
    return stored && TABS.includes(stored) ? stored : 'details'
  } catch {
    return 'details'
  }
}

function saveTab(tab: Tab): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // Sin almacenamiento disponible: la pestaña vale solo para esta sesión.
  }
}

/**
 * Carga perezosa ligada a un `detail`: se pide la primera vez que la pestaña está activa y
 * se descarta cuando cambia el work item, se recarga (llega un `detail` nuevo) o se llama a `reload`.
 */
function useLazy<T>(
  detail: WorkItemDetail | null,
  active: boolean,
  load: (id: number) => Promise<IpcResult<T>>
): Loadable<T> & { reload: () => void } {
  const [state, setState] = useState<Loadable<T> & { source: WorkItemDetail | null }>({
    source: null,
    data: null,
    error: null,
    loading: false
  })

  useEffect(() => {
    if (!detail || !active || state.source === detail) return
    setState({ source: detail, data: null, error: null, loading: true })
    load(detail.workItem.id).then((result) =>
      setState((previous) =>
        previous.source !== detail
          ? previous
          : {
              source: detail,
              data: result.ok ? result.data : null,
              error: result.ok ? null : result.error,
              loading: false
            }
      )
    )
  }, [detail, active, state.source, load])

  // Olvida lo cargado: si la pestaña está activa se vuelve a pedir al instante; si no, al abrirla.
  const reload = useCallback(() => setState((previous) => ({ ...previous, source: null })), [])

  if (state.source === detail) return { ...state, reload }
  return { data: null, error: null, loading: active && detail !== null, reload }
}

const loadComments = (id: number) => window.azdo.getWorkItemComments(id)
const loadHistory = (id: number) => window.azdo.getWorkItemHistory(id)

interface WorkItemPanelProps {
  /** Work item abierto; se muestra en la cabecera mientras carga su detalle. */
  selected: WorkItemSummary | null
  detail: WorkItemDetail | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  /** Vuelve al work item anterior (o a la lista en formato widget); null si no hay a dónde. */
  onBack: (() => void) | null
  backLabel: string
  onForward: (() => void) | null
  forwardLabel: string
  /** Muestra el botón adelante (deshabilitado si no hay a dónde) cuando ya se navegó. */
  showForward: boolean
  onOpenWorkItem: (workItem: WorkItemSummary) => void
}

export function WorkItemPanel({
  selected,
  detail,
  loading,
  error,
  onRefresh,
  onBack,
  backLabel,
  onForward,
  forwardLabel,
  showForward,
  onOpenWorkItem
}: WorkItemPanelProps) {
  const [tab, setTab] = useState<Tab>(loadTab)
  const comments = useLazy(detail, tab === 'discussion', loadComments)
  const history = useLazy(detail, tab === 'history', loadHistory)

  const changeTab = (next: Tab) => {
    setTab(next)
    saveTab(next)
  }

  if (!detail && !loading && !error) {
    return (
      <div className="pane">
        <div className="center">
          <PullRequestIcon width={30} height={30} />
          <h2>Selecciona un work item</h2>
          <p>
            Busca por número, título, colaborador, pull request o commit en el panel izquierdo para ver
            sus campos, pull requests, Discussion, adjuntos e historial.
          </p>
        </div>
      </div>
    )
  }

  const workItem = detail?.workItem ?? selected
  const tabs: { value: Tab; label: string; short?: string; icon: ReactNode; count?: number }[] = [
    { value: 'details', label: 'Detalles', icon: <InfoIcon /> },
    {
      value: 'pullRequests',
      label: 'Pull requests',
      short: 'PRs',
      icon: <PullRequestIcon />,
      count: detail?.pullRequests.length
    },
    {
      value: 'discussion',
      label: 'Discussion',
      icon: <CommentIcon />,
      count: comments.data?.length ?? detail?.commentCount
    },
    {
      value: 'attachments',
      label: 'Adjuntos',
      short: 'Adj.',
      icon: <PaperclipIcon />,
      count: detail?.attachments.length
    },
    {
      value: 'relatedLinks',
      label: 'Related links',
      short: 'Links',
      icon: <LinkIcon />,
      count: detail ? detail.links.length + relatedPullRequests(detail).length : undefined
    },
    { value: 'history', label: 'Historial', icon: <HistoryIcon />, count: history.data?.length }
  ]

  return (
    <div className="pane">
      <header className="wi-header">
        <div className="wi__top">
          {(onBack || showForward) && (
            <span className="nav-buttons">
              <button
                className="btn btn--ghost btn--sm"
                onClick={onBack ?? undefined}
                disabled={!onBack}
                title={backLabel}
                aria-label="Atrás"
              >
                <BackIcon />
              </button>
              {showForward && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={onForward ?? undefined}
                  disabled={!onForward}
                  title={forwardLabel}
                  aria-label="Adelante"
                >
                  <BackIcon className="icon--flip" />
                </button>
              )}
            </span>
          )}
          {workItem && (
            <>
              <span className="wi__id">#{workItem.id}</span>
              <span className="chip chip--type" style={typeStyle(workItem.type)}>
                {workItem.type}
              </span>
              <span className="chip chip--neutral">{workItem.state}</span>
            </>
          )}
          <span className="titlebar__spacer" />
          {workItem && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => window.azdo.openExternal(workItem.url)}
              title="Abrir work item en Azure DevOps"
            >
              <ExternalIcon />
            </button>
          )}
          <button className="btn btn--ghost btn--sm" onClick={onRefresh} disabled={loading} title="Recargar">
            <RefreshIcon />
          </button>
        </div>
        {workItem && (
          <>
            <h1 className="wi-header__title">{workItem.title}</h1>
            <div className="wi__meta">
              {workItem.assignedTo ? (
                <span className="who">
                  <Avatar name={workItem.assignedTo} imageUrl={workItem.assignedToImageUrl} small />
                  {workItem.assignedTo}
                </span>
              ) : (
                <span>Sin asignar</span>
              )}
              {workItem.changedDate && (
                <span title={formatAbsolute(workItem.changedDate)}>
                  · actualizado {formatRelative(workItem.changedDate)}
                </span>
              )}
            </div>
          </>
        )}
      </header>

      <nav className="tabs" role="tablist" aria-label="Secciones del work item">
        {tabs.map((item) => (
          <button
            key={item.value}
            role="tab"
            className="tabs__btn"
            aria-selected={tab === item.value}
            onClick={() => changeTab(item.value)}
          >
            {item.icon}
            {item.short ? (
              <>
                <span className="tabs__label">{item.label}</span>
                <span className="tabs__label tabs__label--short">{item.short}</span>
              </>
            ) : (
              item.label
            )}
            {item.count !== undefined && <span className="tabs__count">{item.count}</span>}
          </button>
        ))}
      </nav>

      {error && <div className="alert">{error}</div>}

      {loading && (
        <div className="loading-row">
          <span className="spinner" /> Cargando work item…
        </div>
      )}

      {!loading && detail && (
        <>
          {tab === 'details' && <WorkItemDetails detail={detail} />}
          {tab === 'pullRequests' && <PullRequestList key={detail.workItem.id} detail={detail} />}
          {tab === 'discussion' && (
            <WorkItemDiscussion
              state={comments}
              url={detail.workItem.url}
              workItemId={detail.workItem.id}
              onPosted={() => {
                comments.reload()
                history.reload()
              }}
            />
          )}
          {tab === 'attachments' && (
            <WorkItemAttachments attachments={detail.attachments} url={detail.workItem.url} />
          )}
          {tab === 'relatedLinks' && <WorkItemRelatedLinks detail={detail} onOpenWorkItem={onOpenWorkItem} />}
          {tab === 'history' && <WorkItemHistory state={history} />}
        </>
      )}
    </div>
  )
}
