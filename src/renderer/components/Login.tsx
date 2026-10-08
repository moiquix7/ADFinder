import { useState } from 'react'
import { MicrosoftIcon } from './Icons'
import appIcon from '../../../build/icon.svg'
import type { AppConfig } from '../../shared/types'

interface LoginProps {
  config: AppConfig | null
  onSignedIn: () => void
}

export function Login({ config, onSignedIn }: LoginProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signIn = async () => {
    setBusy(true)
    setError(null)
    const result = await window.azdo.auth.signIn()
    setBusy(false)
    if (result.ok) onSignedIn()
    else setError(result.error)
  }

  return (
    <div className="center">
      <img className="logo logo--lg" src={appIcon} alt="" />
      <h2>AD Finder</h2>
      <p>
        Inicia sesión con tu cuenta de Microsoft para consultar los pull requests vinculados a un
        work item de <strong>{config?.project ?? 'Sda.Aasi.Net'}</strong>.
      </p>

      <button className="btn btn--primary btn--lg" onClick={signIn} disabled={busy}>
        {busy ? <span className="spinner" /> : <MicrosoftIcon />}
        {busy ? 'Abriendo ventana de Microsoft…' : 'Iniciar sesión con Microsoft'}
      </button>

      {error && <div className="alert">{error}</div>}

      {config && (
        <p style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
          Organización <code>{config.organization}</code> · Proyecto <code>{config.project}</code>
        </p>
      )}
    </div>
  )
}
