import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyAccentToDocument, applyThemeToDocument } from './lib/theme'
import '@fontsource/jetbrains-mono/latin-300.css'
import '@fontsource/jetbrains-mono/latin-300-italic.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-600.css'
import '@fontsource/jetbrains-mono/latin-700.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('No se encontró el contenedor #root.')

// Antes del primer render, para que no haya parpadeo de tema.
applyThemeToDocument(window.azdo.theme.initial)
applyAccentToDocument(window.azdo.accent.initial)

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
