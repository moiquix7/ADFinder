import { useCallback, useState } from 'react'
import type { AccentColor, ThemeMode } from '../../shared/types'

export function applyThemeToDocument(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme
}

export function applyAccentToDocument(accent: AccentColor): void {
  document.documentElement.dataset.accent = accent
}

/** Tema actual y alternador; el main process lo persiste y recolorea la barra nativa. */
export function useTheme(): [ThemeMode, () => void] {
  const [theme, setTheme] = useState<ThemeMode>(window.azdo.theme.initial)

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: ThemeMode = current === 'dark' ? 'light' : 'dark'
      applyThemeToDocument(next)
      window.azdo.theme.set(next)
      return next
    })
  }, [])

  return [theme, toggle]
}

/** Color de acento actual; el CSS deriva de él texto, contornos y cards. */
export function useAccent(): [AccentColor, (accent: AccentColor) => void] {
  const [accent, setAccent] = useState<AccentColor>(window.azdo.accent.initial)

  const change = useCallback((next: AccentColor) => {
    applyAccentToDocument(next)
    window.azdo.accent.set(next)
    setAccent(next)
  }, [])

  return [accent, change]
}
