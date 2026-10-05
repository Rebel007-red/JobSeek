import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'

const PAGE_SIZE = 48
const PREFETCH_DISTANCE_PX = 1200 // start loading the next page well before the user reaches the end

// The paged job list for the current filters / scope / sort / tab. The first page reloads whenever they change
// (showing the cached page right away); later pages are appended near the end of the page or via loadMore().
export function useJobList({ filters, scope, sort, tab }) {
  const [jobs, setJobs] = useState([])
  const [page, setPage] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  const fetchJobs = useCallback(async (pageToLoad) => {
    const requestId = ++requestRef.current
    const offset = pageToLoad * PAGE_SIZE
    const isCurrent = () => requestId === requestRef.current
    let showedCache = false

    const applyRows = (rows) => {
      const total = rows.length ? Number(rows[0].total_count) || 0 : offset
      setJobs(prev => {
        if (pageToLoad === 0) return rows
        const seen = new Set(prev.map(job => job.job_key))
        return [...prev, ...rows.filter(job => !seen.has(job.job_key))]
      })
      setTotalCount(total)
      setHasMore(rows.length > 0 && offset + rows.length < total)
    }

    setLoading(true)
    setError('')
    try {
      const rows = await api.jobs(
        { ...filters, scope, sort, tab, limit: PAGE_SIZE, offset },
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
          onWaiting: () => { if (isCurrent()) setWaiting(true) },
        },
      )
      if (isCurrent()) applyRows(rows)
    } catch (err) {
      if (!isCurrent()) return
      setError(err.message)
      if (pageToLoad === 0 && !showedCache) {
        setJobs([])
        setTotalCount(0)
        setHasMore(false)
      }
    } finally {
      if (isCurrent()) {
        setLoading(false)
        setRefreshing(false)
        setWaiting(false)
      }
    }
  }, [filters, scope, sort, tab])

  // Back to the first page (also after the query changes)
  const reload = useCallback(() => {
    setPage(0)
    fetchJobs(0)
  }, [fetchJobs])

  const loadMore = useCallback(() => setPage(prev => prev + 1), [])

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
    totalCount,
    hasMore,
    loading,
    refreshing,
    waiting,
    error,
    reload,
    loadMore,
    retry: () => fetchJobs(page),
    updateJob,
    removeJob,
  }
}
