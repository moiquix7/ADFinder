import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { WorkItemDetail, WorkItemSummary } from '../../shared/types'

/** Detalles recientes que se guardan para que volver atrás sea inmediato. */
const CACHE_LIMIT = 30

interface NavState {
  selected: WorkItemSummary | null
  /** Work items anteriores, el más reciente al final. */
  back: WorkItemSummary[]
  /** Work items de los que se volvió atrás, el más reciente al final. */
  forward: WorkItemSummary[]
}

type NavAction =
  | { type: 'open'; workItem: WorkItemSummary }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'close' }

function reducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'open':
      if (state.selected?.id === action.workItem.id) return state
      return {
        selected: action.workItem,
        back: state.selected ? [...state.back, state.selected] : state.back,
        forward: []
      }
    case 'back': {
      const previous = state.back[state.back.length - 1]
      if (!previous) return state
      return {
        selected: previous,
        back: state.back.slice(0, -1),
        forward: state.selected ? [...state.forward, state.selected] : state.forward
      }
    }
    case 'forward': {
      const next = state.forward[state.forward.length - 1]
      if (!next) return state
      return {
        selected: next,
        back: state.selected ? [...state.back, state.selected] : state.back,
        forward: state.forward.slice(0, -1)
      }
    }
    case 'close':
      return { selected: null, back: [], forward: [] }
  }
}

/**
 * Work item abierto en el panel derecho con historial atrás/adelante, como un navegador.
 * Los detalles ya cargados se reutilizan al volver; «Recargar» siempre pide datos nuevos.
 */
export function useWorkItemNavigation() {
  const [nav, dispatch] = useReducer(reducer, { selected: null, back: [], forward: [] })
  const [detail, setDetail] = useState<WorkItemDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const cache = useRef(new Map<number, WorkItemDetail>())

  const load = useCallback(async (id: number) => {
    const current = ++requestId.current
    setLoading(true)
    setError(null)
    const result = await window.azdo.getWorkItemWithPullRequests(id)
    if (current !== requestId.current) return
    setLoading(false)
    if (result.ok) {
      cache.current.delete(id)
      cache.current.set(id, result.data)
      if (cache.current.size > CACHE_LIMIT) cache.current.delete(cache.current.keys().next().value!)
      setDetail(result.data)
    } else {
      setDetail(null)
      setError(result.error)
    }
  }, [])

  useEffect(() => {
    const { selected } = nav
    if (!selected) {
      requestId.current += 1
      setDetail(null)
      setError(null)
      setLoading(false)
      return
    }
    const cached = cache.current.get(selected.id)
    if (cached) {
      // Cancela una carga en curso de otro work item.
      requestId.current += 1
      setDetail(cached)
      setError(null)
      setLoading(false)
    } else {
      setDetail(null)
      load(selected.id)
    }
  }, [nav.selected, load])

  const previous = nav.back[nav.back.length - 1] ?? null
  const next = nav.forward[nav.forward.length - 1] ?? null

  return {
    selected: nav.selected,
    detail,
    loading,
    error,
    /** Work item al que lleva «Atrás» (null si no hay). */
    previous,
    /** Work item al que lleva «Adelante» (null si no hay). */
    next,
    open: useCallback((workItem: WorkItemSummary) => dispatch({ type: 'open', workItem }), []),
    goBack: useCallback(() => dispatch({ type: 'back' }), []),
    goForward: useCallback(() => dispatch({ type: 'forward' }), []),
    /** Cierra el panel y olvida el historial (formato widget: vuelve a la lista). */
    close: useCallback(() => dispatch({ type: 'close' }), []),
    refresh: useCallback(() => {
      if (nav.selected) load(nav.selected.id)
    }, [nav.selected, load])
  }
}
