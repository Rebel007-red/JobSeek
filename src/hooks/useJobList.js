import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'

const PAGE_SIZE = 48
const PREFETCH_DISTANCE_PX = 1200 // start loading the next page well before the user reaches the end

// The paged job list for the current filters / scope / sort / tab. The first page reloads whenever they change
// (showing the cached page right away); later pages are appended near the end of the page or via loadMore().
// listKey changes only when a different query's rows replace the list (not on a refresh of the same query),
// so the page can mount the new result set instead of moving the old rows around (avoids layout shift).
export function useJobList({ filters, scope, sort, tab }) {
  const [jobs, setJobs] = useState([])
  const [page, setPage] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [listKey, setListKey] = useState(0)
  const requestRef = useRef(0) // bumped by every first-page load; older responses are ignored
  const busyRef = useRef(false) // a page request is in flight, so loadMore() must not skip ahead
  const shownQueryRef = useRef(null)

  const fetchJobs = useCallback(async (pageToLoad) => {
    // Later pages share the first page's request id: a page response is dropped only when the query changed,
    // never because another page request started (that used to lose a whole page while scrolling fast).
    const requestId = pageToLoad === 0 ? ++requestRef.current : requestRef.current
    const offset = pageToLoad * PAGE_SIZE
    const isCurrent = () => requestId === requestRef.current
    const queryKey = JSON.stringify([filters, scope, sort, tab])
    let showedCache = false
    let appended = false

    const applyRows = (rows) => {
      const total = rows.length ? Number(rows[0].total_count) || 0 : offset
      if (pageToLoad === 0 && shownQueryRef.current !== queryKey) {
        shownQueryRef.current = queryKey
        setListKey(key => key + 1)
      }
      setJobs(prev => {
        if (pageToLoad === 0) return rows
        const seen = new Set(prev.map(job => job.job_key))
        return [...prev, ...rows.filter(job => !seen.has(job.job_key))]
      })
      setTotalCount(total)
      setHasMore(rows.length > 0 && offset + rows.length < total)
    }

    busyRef.current = true
    setLoading(true)
    setError('')
    try {
      const rows = await api.jobs(
        // The muted view lists every posting (not groups), so it matches the "N hidden by your rules" count
        { ...filters, scope, sort, tab, limit: PAGE_SIZE, offset, ...(filters.muteView === 'only' ? { collapse: false } : {}) },
        {
          // Show the last known first page immediately; the fresh result replaces it when it arrives
          onCached: pageToLoad === 0
            ? (cached) => {
              if (!isCurrent()) return
              showedCache = true
              applyRows(cached)
              setLoading(false)
              setRefreshing(true)
            }
            : undefined,
        },
      )
      if (!isCurrent()) return
      // An appended page renders as a transition, so React can yield while 48 new rows mount mid-scroll
      if (pageToLoad > 0) {
        appended = true
        startTransition(() => {
          applyRows(rows)
          setLoading(false)
        })
      } else {
        applyRows(rows)
      }
    } catch (err) {
      if (!isCurrent()) return
      setError(err.message)
      // A failed refresh of the list on screen (e.g. pull to refresh while offline) keeps its rows under the error
      if (pageToLoad === 0 && !showedCache && shownQueryRef.current !== queryKey) {
        setJobs([])
        setTotalCount(0)
        setHasMore(false)
      }
    } finally {
      if (isCurrent()) {
        busyRef.current = false
        if (!appended) setLoading(false)
        setRefreshing(false)
      }
    }
  }, [filters, scope, sort, tab])

  // Back to the first page (also after the query changes)
  const reload = useCallback(() => {
    setPage(0)
    fetchJobs(0)
  }, [fetchJobs])

  // One page at a time: a second call before the first page arrives would skip a page
  const loadMore = useCallback(() => {
    if (busyRef.current) return
    busyRef.current = true
    setPage(prev => prev + 1)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (page > 0) fetchJobs(page)
  }, [page])

  useEffect(() => {
    const handleScroll = () => {
      if (loading || !hasMore || error) return
      const distanceFromBottom = document.documentElement.scrollHeight - (window.innerHeight + window.scrollY)
      if (distanceFromBottom <= PREFETCH_DISTANCE_PX) loadMore()
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [loading, hasMore, error, loadMore])

  // Optimistic local edits after a write
  const updateJob = useCallback((jobKey, patch) => {
    setJobs(prev => prev.map(job => (job.job_key === jobKey ? { ...job, ...patch } : job)))
  }, [])

  const removeJob = useCallback((jobKey) => {
    setJobs(prev => prev.filter(job => job.job_key !== jobKey))
    setTotalCount(count => Math.max(count - 1, 0))
  }, [])

  return {
    jobs,
    page,
    listKey,
    totalCount,
    hasMore,
    loading,
    refreshing,
    error,
    reload,
    loadMore,
    retry: () => fetchJobs(page),
    updateJob,
    removeJob,
  }
}
