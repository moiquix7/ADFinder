import type { CSSProperties } from 'react'

/** Color por tipo de work item, tomado de la paleta Tokyo Night. */
const TYPE_COLORS: Record<string, string> = {
  'user story': '#7aa2f7', // blue
  bug: '#f7768e', // red
  task: '#e0af68', // yellow
  'test task': '#73daca', // green1
  rework: '#ff9e64', // orange
  feature: '#bb9af7', // magenta
  issue: '#9d7cd8', // purple
  failure: '#db4b4b', // red1
  epic: '#ff9e64' // orange
}

const FALLBACK = '#737aa2' // dark5

/** Estilo para `.chip--type`: expone el color del tipo como variable CSS. */
export function typeStyle(type: string): CSSProperties {
  return { '--type-color': TYPE_COLORS[type.toLowerCase()] ?? FALLBACK } as CSSProperties
}
