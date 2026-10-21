import { useCallback, useEffect, useState } from 'react'
import { Login } from './components/Login'
import { WorkItemSearch } from './components/WorkItemSearch'
import { WorkItemPanel } from './components/WorkItemPanel'
import { AccentPicker } from './components/AccentPicker'
import { Avatar } from './components/Avatar'
import { ExternalIcon, MoonIcon, SignOutIcon, SunIcon } from './components/Icons'
import { useMediaQuery, WIDE_LAYOUT_QUERY } from './lib/useMediaQuery'
import { useAccent, useTheme } from './lib/theme'
import { useWorkItemNavigation } from './lib/useWorkItemNavigation'
import appIcon from '../../build/icon.svg'
import type { AppConfig, AuthState, WorkItemSummary } from '../shared/types'

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [auth, setAuth] = useState<AuthState | null>(null)
  const navigation = useWorkItemNavigation()
  const { selected, previous, next, goBack, goForward, close } = navigation

  const wide = useMediaQuery(WIDE_LAYOUT_QUERY)
  const [theme, toggleTheme] = useTheme()
  const [accent, setAccent] = useAccent()

  useEffect(() => {
    window.azdo.getConfig().then(setConfig)
    window.azdo.auth.getState().then(setAuth)
    return window.azdo.auth.onChange(setAuth)
  }, [])

  const label = (workItem: WorkItemSummary) => `#${workItem.id} ${workItem.title}`
  // Atrás vuelve al work item anterior; sin anterior, en formato widget vuelve a la lista.
  const canGoBack = previous !== null || (!wide && selected !== null)
  const back = useCallback(() => {
    if (previous) goBack()
    else if (!wide && selected) close()
  }, [previous, wide, selected, goBack, close])

  // Atrás / adelante con los botones laterales del ratón o Alt+←/→, como en el navegador.
  useEffect(() => {
    const onMouse = (event: MouseEvent) => {
      if (event.button === 3) back()
      else if (event.button === 4) goForward()
      else return
      event.preventDefault()
    }
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
      event.preventDefault()
      if (event.key === 'ArrowLeft') back()
      else goForward()
    }
    window.addEventListener('mouseup', onMouse)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mouseup', onMouse)
      window.removeEventListener('keydown', onKey)
    }
  }, [back, goForward])

  // Ctrl+R: búsqueda por External Reference. En formato widget se vuelve antes a la lista.
  const [externalReferenceRequest, setExternalReferenceRequest] = useState(0)
  useEffect(
    () =>
      window.azdo.onExternalReferenceShortcut(() => {
        if (!wide && selected) close()
        setExternalReferenceRequest((count) => count + 1)
      }),
    [wide, selected, close]
  )

  const signOut = async () => {
    await window.azdo.auth.signOut()
    close()
  }

  const signedIn = auth?.signedIn === true
  // En formato widget solo cabe un panel: lista o detalle.
  const showDetail = wide || selected !== null
  const themeLabel = theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar__brand">
          <img className="logo" src={appIcon} alt="" />
          AD Finder
          {config && <span className="titlebar__version">v{config.version}</span>}
        </span>
        <span className="titlebar__spacer" />
        <AccentPicker accent={accent} onChange={setAccent} />
        <button className="theme-toggle" onClick={toggleTheme} title={themeLabel} aria-label={themeLabel}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>

      {auth === null ? (
        <div className="center">
          <span className="spinner spinner--lg" />
        </div>
      ) : !signedIn ? (
        <Login config={config} onSignedIn={() => window.azdo.auth.getState().then(setAuth)} />
      ) : (
        <>
          <div className={`body${wide ? '' : ' body--stacked'}`}>
            {/* Siempre montado: en formato widget solo se oculta, así conserva término y resultados. */}
            <WorkItemSearch
              hidden={!wide && selected !== null}
              selectedId={selected?.id ?? null}
              onSelect={navigation.open}
              workItemTypes={config?.workItemTypes ?? null}
              externalReferenceRequest={externalReferenceRequest}
            />
            {showDetail && (
              <WorkItemPanel
                selected={selected}
                detail={navigation.detail}
                loading={navigation.loading}
                error={navigation.error}
                onRefresh={navigation.refresh}
                onBack={canGoBack ? back : null}
                backLabel={previous ? `Volver a ${label(previous)} (Alt+←)` : 'Volver a la lista (Alt+←)'}
                onForward={next ? goForward : null}
                forwardLabel={next ? `Ir a ${label(next)} (Alt+→)` : ''}
                showForward={previous !== null || next !== null}
                onOpenWorkItem={navigation.open}
              />
            )}
          </div>

          <footer className="statusbar">
            {auth?.account && (
              <span className="who" title={auth.account.username}>
                <Avatar name={auth.account.name} imageUrl={null} small />
                <span className="statusbar__name">{auth.account.name}</span>
              </span>
            )}
            <span className="titlebar__spacer" />
            {config && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => window.azdo.openExternal(config.pullsUrl)}
                title={config.pullsUrl}
              >
                <ExternalIcon /> Todos los PR
              </button>
            )}
            <button className="btn btn--ghost btn--sm" onClick={signOut} title="Cerrar sesión">
              <SignOutIcon />
            </button>
          </footer>
        </>
      )}
    </div>
  )
}
