import { useEffect, useState } from 'react'

interface PaginatorProps {
  page: number
  pageCount: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

/** Convierte el texto del campo en un entero positivo, o null si no es válido. */
function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1 ? n : null
}

export function Paginator({
  page,
  pageCount,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange
}: PaginatorProps) {
  // Borrador del campo: se aplica al pulsar Enter o al salir del campo.
  const [sizeDraft, setSizeDraft] = useState(String(pageSize))
  useEffect(() => setSizeDraft(String(pageSize)), [pageSize])

  const sizeValid = parsePositiveInt(sizeDraft) !== null

  const commitSize = () => {
    const size = parsePositiveInt(sizeDraft)
    if (size === null) setSizeDraft(String(pageSize))
    else if (size !== pageSize) onPageSizeChange(size)
  }

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)

  return (
    <div className="pager">
      <div className="pager__nav">
        <button
          className="pager__btn"
          onClick={() => onPageChange(1)}
          disabled={page <= 1}
          title="Primera página"
          aria-label="Primera página"
        >
          «
        </button>
        <button
          className="pager__btn"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          title="Página anterior"
          aria-label="Página anterior"
        >
          ‹
        </button>
        <span className="pager__status">
          {page} / {pageCount}
        </span>
        <button
          className="pager__btn"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          title="Página siguiente"
          aria-label="Página siguiente"
        >
          ›
        </button>
        <button
          className="pager__btn"
          onClick={() => onPageChange(pageCount)}
          disabled={page >= pageCount}
          title="Última página"
          aria-label="Última página"
        >
          »
        </button>
      </div>

      <span className="pager__range">
        {first}–{last} de {total}
      </span>

      <label className="pager__size">
        <input
          className={`pager__input${sizeValid ? '' : ' pager__input--invalid'}`}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={sizeDraft}
          onChange={(e) => setSizeDraft(e.target.value)}
          onBlur={commitSize}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitSize()
            if (e.key === 'Escape') setSizeDraft(String(pageSize))
          }}
          aria-label="Work items por página"
          title="Número entero de work items por página (Enter para aplicar)"
        />
        por página
      </label>
    </div>
  )
}
