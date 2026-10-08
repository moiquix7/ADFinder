import { useEffect, useRef, useState } from 'react'
import { PaletteIcon } from './Icons'
import { ACCENT_COLORS, type AccentColor } from '../../shared/types'

const LABELS: Record<AccentColor, string> = {
  tokyo: 'Tokyo Blue',
  pink: 'Pink',
  'light-green': 'Light Green',
  cyan: 'Cyan',
  'mai-tai': 'Mai Tai',
  'forest-green': 'Forest Green'
}

interface AccentPickerProps {
  accent: AccentColor
  onChange: (accent: AccentColor) => void
}

/** Botón de paleta en la barra de título con los colores de acento del tema. */
export function AccentPicker({ accent, onChange }: AccentPickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Se cierra al hacer clic fuera o con Escape, igual que el filtro de búsqueda.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="accent-picker" ref={rootRef}>
      <button
        className="theme-toggle"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        title={`Color de acento: ${LABELS[accent]}`}
        aria-label="Cambiar color de acento"
      >
        <PaletteIcon />
      </button>

      {open && (
        <div className="accent-picker__panel" role="dialog" aria-label="Color de acento">
          <div className="search-filter__title">Tokyo Night Islands</div>
          <div role="radiogroup" aria-label="Color de acento">
            {ACCENT_COLORS.map((color) => (
              <button
                key={color}
                role="radio"
                aria-checked={color === accent}
                className="accent-picker__option"
                data-swatch={color}
                onClick={() => onChange(color)}
              >
                <span className="accent-picker__swatch" />
                <span>{LABELS[color]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
