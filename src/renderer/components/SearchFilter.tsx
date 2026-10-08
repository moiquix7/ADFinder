import { useEffect, useRef, useState } from 'react'
import { ChevronIcon, FilterIcon } from './Icons'
import { typeStyle } from '../lib/workItemType'
import type { SearchScope } from '../../shared/types'

/** Lugares del filtro que se guardan como sí/no (los tipos van aparte). */
export type FilterFlags = Omit<SearchScope, 'workItemTypes'>

export interface FilterState extends FilterFlags {
  /** Tipos desmarcados: así un tipo nuevo en la configuración aparece marcado. */
  excludedTypes: string[]
}

export const DEFAULT_FILTER: FilterState = {
  title: true,
  description: true,
  collaborator: true,
  discussion: false,
  attachments: false,
  pullRequestNumber: true,
  commitHash: true,
  excludedTypes: []
}

const FLAG_OPTIONS: { key: keyof FilterFlags; label: string; hint?: string }[] = [
  { key: 'title', label: 'Title WorkItem' },
  { key: 'description', label: 'Description WorkItem' },
  { key: 'collaborator', label: 'Nombre Colaborador', hint: 'asignado o creador' },
  { key: 'discussion', label: 'Discussion Section' },
  { key: 'attachments', label: 'Attachments', hint: 'más lento' },
  { key: 'pullRequestNumber', label: 'Número PullRequest' },
  { key: 'commitHash', label: 'Hash commit' }
]

const FLAG_KEYS = FLAG_OPTIONS.map((option) => option.key)

/** Convierte el estado del filtro en el `scope` que entiende la búsqueda. */
export function toScope(filter: FilterState, types: string[]): SearchScope {
  const flags = Object.fromEntries(FLAG_KEYS.map((key) => [key, filter[key]])) as FilterFlags
  return { ...flags, workItemTypes: types.filter((type) => !filter.excludedTypes.includes(type)) }
}

/** Casilla que admite el estado intermedio (algunos hijos marcados). */
function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  children
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <label className="check">
      <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

interface SearchFilterProps {
  filter: FilterState
  types: string[]
  onChange: (filter: FilterState) => void
}

export function SearchFilter({ filter, types, onChange }: SearchFilterProps) {
  const [open, setOpen] = useState(false)
  const [typesOpen, setTypesOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Se cierra al hacer clic fuera o con Escape.
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

  const selectedTypes = types.filter((type) => !filter.excludedTypes.includes(type))
  const allTypes = selectedTypes.length === types.length
  const someTypes = selectedTypes.length > 0 && !allTypes
  const allFlags = FLAG_KEYS.every((key) => filter[key])
  const all = allFlags && allTypes
  const some = !all && (FLAG_KEYS.some((key) => filter[key]) || selectedTypes.length > 0)

  const setAll = (checked: boolean) =>
    onChange({
      ...(Object.fromEntries(FLAG_KEYS.map((key) => [key, checked])) as FilterFlags),
      excludedTypes: checked ? [] : [...types]
    })

  const setFlag = (key: keyof FilterFlags, checked: boolean) => onChange({ ...filter, [key]: checked })

  const setAllTypes = (checked: boolean) => onChange({ ...filter, excludedTypes: checked ? [] : [...types] })

  const setType = (type: string, checked: boolean) =>
    onChange({
      ...filter,
      excludedTypes: checked
        ? filter.excludedTypes.filter((excluded) => excluded !== type)
        : [...filter.excludedTypes, type]
    })

  const flagOption = (key: keyof FilterFlags) => {
    const option = FLAG_OPTIONS.find((o) => o.key === key)!
    return (
      <Checkbox key={key} checked={filter[key]} onChange={(checked) => setFlag(key, checked)}>
        <span>{option.label}</span>
        {option.hint && <span className="check__hint">{option.hint}</span>}
      </Checkbox>
    )
  }

  return (
    <div className="search-filter" ref={rootRef}>
      <button
        className={`btn btn--ghost btn--icon search-filter__toggle${all ? '' : ' search-filter__toggle--active'}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        title={all ? 'Filtrar dónde buscar' : 'Filtrar dónde buscar (hay lugares desmarcados)'}
      >
        <FilterIcon />
        {!all && <span className="search-filter__dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="search-filter__panel" role="dialog" aria-label="Buscar solo en">
          <div className="search-filter__title">Buscar solo en</div>
          <Checkbox checked={all} indeterminate={some} onChange={setAll}>
            <strong>All</strong>
          </Checkbox>
          <div className="search-filter__divider" />
          {flagOption('title')}
          {flagOption('description')}
          {flagOption('collaborator')}

          <div className="check-group">
            <div className="check-group__head">
              <Checkbox checked={allTypes} indeterminate={someTypes} onChange={setAllTypes}>
                <span>WorkItem type</span>
                <span className="check__hint">
                  {selectedTypes.length}/{types.length}
                </span>
              </Checkbox>
              <button
                className="btn btn--ghost btn--icon check-group__expand"
                aria-expanded={typesOpen}
                aria-label={typesOpen ? 'Ocultar tipos de work item' : 'Mostrar tipos de work item'}
                onClick={() => setTypesOpen(!typesOpen)}
              >
                <ChevronIcon />
              </button>
            </div>
            {typesOpen && (
              <div className="check-group__items">
                {types.map((type) => (
                  <Checkbox
                    key={type}
                    checked={!filter.excludedTypes.includes(type)}
                    onChange={(checked) => setType(type, checked)}
                  >
                    <span className="check__type" style={typeStyle(type)} />
                    <span>{type}</span>
                  </Checkbox>
                ))}
              </div>
            )}
          </div>

          {flagOption('discussion')}
          {flagOption('attachments')}
          {flagOption('pullRequestNumber')}
          {flagOption('commitHash')}
        </div>
      )}
    </div>
  )
}
