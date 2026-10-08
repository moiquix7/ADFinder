import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeTheme } from 'electron'
import { isAccentColor, type AccentColor, type ThemeMode } from '../shared/types'

interface Settings {
  theme?: ThemeMode
  accent?: AccentColor
}

/** Colores nativos de la ventana (fondo y botones del titleBarOverlay), en Tokyo Night. */
export const WINDOW_CHROME: Record<ThemeMode, { background: string; bar: string; symbols: string }> = {
  dark: { background: '#16161e', bar: '#16161e', symbols: '#c0caf5' },
  light: { background: '#d5d7e1', bar: '#d5d7e1', symbols: '#3760bf' }
}

const settingsFile = () => join(app.getPath('userData'), 'settings.json')

function read(): Settings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as Settings
  } catch {
    return {}
  }
}

function write(changes: Settings): void {
  try {
    writeFileSync(settingsFile(), JSON.stringify({ ...read(), ...changes }, null, 2))
  } catch {
    // Sin permisos de escritura: el ajuste se aplica igual, solo no se recuerda.
  }
}

/** Tema guardado; en el primer arranque se toma el del sistema operativo. */
export function getTheme(): ThemeMode {
  const saved = read().theme
  if (saved === 'light' || saved === 'dark') return saved
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

export function saveTheme(theme: ThemeMode): void {
  write({ theme })
}

/** Color de acento guardado; por defecto el azul de Tokyo Night. */
export function getAccent(): AccentColor {
  const saved = read().accent
  return isAccentColor(saved) ? saved : 'tokyo'
}

export function saveAccent(accent: AccentColor): void {
  write({ accent })
}
