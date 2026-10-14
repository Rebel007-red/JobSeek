import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'

const PAGE_SIZE = 48
const FOLD_KEY = 'jobseeker.finishedOpen' // per tab session: the fold opens as you left it

export function readFoldOpen() {
  try {
    return sessionStorage.getItem(FOLD_KEY) === '1'
  } catch {
    return false
  }
}

export function saveFoldOpen(open) {
  try {
    if (open) sessionStorage.setItem(FOLD_KEY, '1')
    else sessionStorage.removeItem(FOLD_KEY)
  } catch {
    // private mode, storage full: the fold just starts closed next time
  }
}

// The Applied tab's "Finished" fold: its own paged list (api.jobs with stageGroup 'finished' and the main list's
// filters and sort), read only while enabled (expanded), so a closed fold costs nothing. A new query while enabled reads
// page 0 again (the cached page shows at once). Own Load more (loadMore); no auto-load on scroll, the fold sits below
// the main list, which has its own. updateRows / removeRows keep it in line with optimistic writes; reload() re-reads
// it while it is open and has been read (a no-op otherwise).
// -> { rows, total, hasMore, loading, error, loadMore, reload, updateRows, removeRows }
export function useFoldList(params, enabled) {
  const key = JSON.stringify(params)
  const [state, setState] = useState({ key: null, rows: [], total: 0, loading: false, error: '' })
  const requestRef = useRef(0)
  const stateRef = useRef(state)
  const enabledRef = useRef(enabled)

  useLayoutEffect(() => {
    stateRef.current = state
    enabledRef.current = enabled
  })

  const load = useCallback(async (offset) => {
    const requestId = offset === 0 ? ++requestRef.current : requestRef.current
    const isCurrent = () => requestId === requestRef.current
    const apply = (rows, done) => setState(prev => {
      const base = offset === 0 ? [] : prev.rows
      const seen = new Set(base.map(job => job.job_key))
      return {
        key,
        rows: [...base, ...rows.filter(job => !seen.has(job.job_key))],
        total: rows.length ? Number(rows[0].total_count) || 0 : offset,
        loading: !done,
        error: '',
      }
    })
    setState(prev => ({ ...prev, key, loading: true, error: '', ...(prev.key !== key ? { rows: [], total: 0 } : {}) }))
    try {
      const rows = await api.jobs({ ...JSON.parse(key), limit: PAGE_SIZE, offset }, {
        onCached: offset === 0 ? (cached) => { if (isCurrent()) apply(cached || [], false) } : undefined,
      })
      if (isCurrent()) apply(rows || [], true)
    } catch (err) {
      if (isCurrent()) setState(prev => ({ ...prev, loading: false, error: err.message }))
    }
  }, [key])

  useEffect(() => {
    if (enabled) load(0)
  }, [enabled, load])

  const loadMore = useCallback(() => {
    const { loading, rows, total } = stateRef.current
    if (!loading && rows.length < total) load(rows.length)
  }, [load])

  // A closed fold is not read (opening it reads page 0 anyway)
  const reload = useCallback(() => {
    if (enabledRef.current && stateRef.current.key !== null) load(0)
  }, [load])

  // patches: Map job_key -> fields
  const updateRows = useCallback((patches) => {
    setState(prev => (prev.rows.some(job => patches.has(job.job_key))
      ? { ...prev, rows: prev.rows.map(job => (patches.has(job.job_key) ? { ...job, ...patches.get(job.job_key) } : job)) }
      : prev))
  }, [])

  // keys: Set of job_key
  const removeRows = useCallback((keys) => {
    setState(prev => {
      const rows = prev.rows.filter(job => !keys.has(job.job_key))
      return rows.length === prev.rows.length ? prev : { ...prev, rows, total: Math.max(prev.total - (prev.rows.length - rows.length), 0) }
    })
  }, [])

  const current = state.key === key
  const rows = current ? state.rows : []
  const total = current ? state.total : 0
  return {
    rows,
    total,
    hasMore: rows.length < total,
    loading: state.loading,
    error: current ? state.error : '',
    loadMore,
    reload,
    updateRows,
    removeRows,
  }
}
