import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Header } from '../components/layout/Header'
import { JobCard } from '../components/common/JobCard'
import { JobRow } from '../components/common/JobRow'
import { JobDrawer } from '../components/common/JobDrawer'
import { Metrics } from '../components/common/Metrics'
import { ShortcutHelp } from '../components/common/ShortcutHelp'
import { CheckIcon, CloseIcon, SearchIcon } from '../components/common/icons'
import { DEFAULT_FILTERS, EMPTY_FILTERS, FRESH_HOURS, PANEL_KEYS, POSTED_OPTIONS, SearchFilter } from '../components/common/SearchFilter'
import { SYNC_MS, api } from '../lib/api'
import { useProfile } from '../hooks/useProfile'
import { useHotkeys } from '../hooks/useHotkeys'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { buildTrend, facetOptions, jobUrl } from '../utils/gold'
import { readView, saveView } from '../utils/viewPref'

const PAGE_SIZE = 48
const TREND_WINDOW_DAYS = 14
const SEARCH_DEBOUNCE_MS = 350
const TOAST_MS = 6000
const PREFETCH_DISTANCE_PX = 1200 // start loading the next page well before the user reaches the end
const LOAD_AHEAD_ROWS = 5 // keyboard navigation loads the next page this many rows before the end
const AUTO_SYNC_CHECK_MS = 5 * 60_000 // how often an open, visible page checks whether data is older than SYNC_MS

const TOAST_ICONS = { success: CheckIcon, danger: CloseIcon }

const SORTS = [
  { value: 'fit', label: 'Best fit' },
  { value: 'recent', label: 'Newest posted' },
  { value: 'found', label: 'Recently found' },
]

const TABS = [
  { value: 'all', label: 'All', key: '1' },
  { value: 'pending', label: 'To apply', key: '2' },
  { value: 'applied', label: 'Applied', key: '3' },
]

const FILTER_LABELS = {
  q: 'Search',
  role: 'Role',
  category: 'Category',
  source: 'Source',
  company: 'Company',
  location: 'Location',
  maxYears: 'Max years',
  postedWithin: 'Posted',
  minFit: 'Fit',
}

function chipValue(key, value) {
  if (key === 'minFit') return `${value}+`
  if (key === 'postedWithin') return (POSTED_OPTIONS.find(option => option.value === value)?.label || `last ${value}h`).toLowerCase()
  if (key === 'maxYears') return value === '0' ? 'Fresher' : `≤ ${value} yrs`
  return value
}

// Keeps the counters right after a write without another summary query.
function adjustSummary(summary, changes) {
  const next = { ...summary }
  Object.entries(changes).forEach(([key, delta]) => {
    if (next[key] !== undefined && next[key] !== null) next[key] = Math.max(Number(next[key]) + delta, 0)
  })
  return next
}

const todayKey = () => new Date().toISOString().slice(0, 10) // trend days are UTC dates

// Adds delta to today's applied count in the trend rows (keeps "applied today" right without a query).
function bumpAppliedToday(rows, delta) {
  const today = todayKey()
  if (!rows.some(row => String(row.day).slice(0, 10) === today)) {
    return delta > 0 ? [...rows, { day: today, added: 0, applied: delta }] : rows
  }
  return rows.map(row => (String(row.day).slice(0, 10) === today ? { ...row, applied: Math.max(Number(row.applied) + delta, 0) } : row))
}

export function JobsPage() {
  const navigate = useNavigate()
  const { profile, loading: profileLoading } = useProfile()
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [searchInput, setSearchInput] = useState('')
  const [sort, setSort] = useState('fit')
  const [tab, setTab] = useState('all')
  const [view, setView] = useState(readView)
  const [jobs, setJobs] = useState([])
  const [page, setPage] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState({})
  const [trendRows, setTrendRows] = useState([])
  const [facetRows, setFacetRows] = useState([])
  const [selectedJob, setSelectedJob] = useState(null)
  const [activeKey, setActiveKey] = useState(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const jobsRequestRef = useRef(0)
  const summaryRequestRef = useRef(0)
  const toastTimerRef = useRef(null)
  const searchRef = useRef(null)
  const jobsRef = useRef(jobs)
  const filtersRef = useRef(filters)
  const refreshRef = useRef(null)

  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  const profileSkills = useMemo(() => profile?.skills || [], [profile])

  // tone: 'success' | 'danger' colours the toast like the swipe hint for the same action
  const showToast = useCallback((message, undo, tone) => {
    clearTimeout(toastTimerRef.current)
    setToast({ message, undo, tone })
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  useEffect(() => () => clearTimeout(toastTimerRef.current), [])

  // Debounce the search box into filters.q
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters(prev => (prev.q === searchInput.trim() ? prev : { ...prev, q: searchInput.trim() }))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  const fetchJobs = useCallback(async (pageToLoad) => {
    const requestId = ++jobsRequestRef.current
    const offset = pageToLoad * PAGE_SIZE
    const isCurrent = () => requestId === jobsRequestRef.current
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
        { ...filters, sort, tab, limit: PAGE_SIZE, offset },
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
  }, [filters, sort, tab])

  const fetchSummary = useCallback(async () => {
    const requestId = ++summaryRequestRef.current
    const isCurrent = () => requestId === summaryRequestRef.current
    try {
      const row = await api.summary(filters, { onCached: cached => { if (isCurrent()) setSummary(cached || {}) } })
      if (isCurrent()) setSummary(row)
    } catch (err) {
      console.error('Failed to load summary:', err)
    }
  }, [filters])

  const fetchTrend = useCallback(async () => {
    try {
      setTrendRows(await api.trend({ onCached: setTrendRows }))
    } catch (err) {
      console.error('Failed to load trend:', err)
    }
  }, [])

  const fetchFacets = useCallback(() => {
    api.facets({ onCached: setFacetRows }).then(setFacetRows).catch(err => console.error('Failed to load facets:', err))
  }, [])

  useEffect(() => {
    setPage(0)
    fetchJobs(0)
  }, [fetchJobs])

  useEffect(() => {
    fetchSummary()
  }, [fetchSummary])

  useEffect(() => {
    fetchTrend()
    fetchFacets()
  }, [fetchTrend, fetchFacets])

  useEffect(() => {
    if (page > 0) fetchJobs(page)
  }, [page])

  useEffect(() => {
    const handleScroll = () => {
      if (loading || !hasMore || error) return
      const distanceFromBottom = document.documentElement.scrollHeight - (window.innerHeight + window.scrollY)
      if (distanceFromBottom <= PREFETCH_DISTANCE_PX) setPage(prev => prev + 1)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [loading, hasMore, error])

  const patchJob = useCallback((jobKey, patch) => {
    setJobs(prev => prev.map(job => (job.job_key === jobKey ? { ...job, ...patch } : job)))
    setSelectedJob(prev => (prev?.job_key === jobKey ? { ...prev, ...patch } : prev))
  }, [])

  const openJob = useCallback((job) => {
    setActiveKey(job.job_key)
    setSelectedJob(job)
  }, [])

  const closeDrawer = useCallback(() => setSelectedJob(null), [])

  const handleApplied = useCallback(async (job, applied) => {
    const before = { is_applied: job.is_applied, applied_at: job.applied_at }
    patchJob(job.job_key, { is_applied: applied, applied_at: applied ? job.applied_at || new Date().toISOString() : null })
    try {
      await api.setApplied(job.job_key, applied)
      showToast(
        applied ? 'Marked as applied' : 'Marked as not applied',
        () => handleApplied({ ...job, is_applied: applied }, !applied),
        applied ? 'success' : undefined,
      )
      const delta = applied ? 1 : -1
      setSummary(prev => adjustSummary(prev, { applied: delta, pending: -delta }))
      if (applied || String(job.applied_at || '').slice(0, 10) === todayKey()) setTrendRows(prev => bumpAppliedToday(prev, delta))
    } catch (err) {
      patchJob(job.job_key, before)
      showToast(`Could not update: ${err.message}`)
    }
  }, [patchJob, showToast])

  // Hiding moves the selection (and an open drawer) to the next job so triage can continue.
  const handleHide = useCallback(async (job) => {
    const list = jobsRef.current
    const index = list.findIndex(item => item.job_key === job.job_key)
    const neighbour = index >= 0 ? list[index + 1] || list[index - 1] || null : null
    setActiveKey(prev => (prev === job.job_key ? neighbour?.job_key ?? null : prev))
    setSelectedJob(prev => (prev?.job_key === job.job_key ? neighbour : prev))
    setJobs(prev => prev.filter(item => item.job_key !== job.job_key))
    setTotalCount(count => Math.max(count - 1, 0))
    try {
      await api.setHidden(job.job_key, true)
      showToast('Job hidden', async () => {
        try {
          await api.setHidden(job.job_key, false)
          setPage(0)
          fetchJobs(0)
          fetchSummary()
        } catch (err) {
          showToast(`Could not restore: ${err.message}`)
        }
      }, 'danger')
      setSummary(prev => adjustSummary(prev, {
        total: -1,
        [job.is_applied ? 'applied' : 'pending']: -1,
        ...(Number(job.fit_score) >= 70 ? { strong_fit: -1 } : {}),
      }))
    } catch (err) {
      showToast(`Could not hide: ${err.message}`)
      fetchJobs(0)
    }
  }, [showToast, fetchJobs, fetchSummary])

  const changeView = (next) => {
    setView(next)
    saveView(next)
  }

  const runUndo = () => {
    const undo = toast?.undo
    setToast(null)
    undo?.()
  }

  // Reads are cached (free-tier budget); this forces fresh data from Databricks.
  const refreshAll = () => {
    api.refreshData()
    setPage(0)
    fetchJobs(0)
    fetchSummary()
    fetchTrend()
    fetchFacets()
  }

  useEffect(() => {
    refreshRef.current = refreshAll
  })

  // Mobile: pull down at the top of the list to refresh (not while a job, sheet or dialog is open)
  const [pullBusy, setPullBusy] = useState(false)
  const { pull, armed } = usePullToRefresh(() => {
    setPullBusy(true)
    refreshAll()
  }, !selectedJob && !helpOpen)

  useEffect(() => {
    if (!loading) setPullBusy(false)
  }, [loading])

  // Auto-sync: opening the page already refetches data older than SYNC_MS (cache maxAge). While the page stays
  // open, re-check every few minutes and when the tab becomes visible again, so data is never more than ~1h old.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return
      const syncedAt = api.syncedAt('summary', filtersRef.current)
      if (syncedAt && Date.now() - syncedAt >= SYNC_MS) refreshRef.current?.()
    }
    const timer = setInterval(check, AUTO_SYNC_CHECK_MS)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  const searchVisible = searchOpen || Boolean(searchInput)
  const openSearch = () => {
    setSearchOpen(true)
    requestAnimationFrame(() => searchRef.current?.focus())
  }
  const toggleSearch = () => (searchVisible ? setSearchOpen(false) : openSearch())

  const facets = useMemo(() => ({
    role: facetOptions(facetRows, 'role'),
    category: facetOptions(facetRows, 'category'),
    source: facetOptions(facetRows, 'source'),
    company: facetOptions(facetRows, 'company'),
  }), [facetRows])

  const trend = useMemo(() => buildTrend(trendRows, TREND_WINDOW_DAYS), [trendRows])

  const stats = {
    total: Number(summary.total ?? 0),
    new: Number(summary.new_48h ?? 0),
    strong: Number(summary.strong_fit ?? 0),
    applied: Number(summary.applied ?? 0),
    pending: Number(summary.pending ?? 0),
  }
  const tabCounts = { all: stats.total, pending: stats.pending, applied: stats.applied }

  const toggleFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: prev[key] === value ? EMPTY_FILTERS[key] : value }))
  const clearFilter = (key) => {
    if (key === 'q') setSearchInput('')
    setFilters(prev => ({ ...prev, [key]: EMPTY_FILTERS[key] }))
  }
  const clearAll = () => {
    setSearchInput('')
    setFilters(DEFAULT_FILTERS)
  }
  const showOlderJobs = () => setFilters(prev => ({ ...prev, postedWithin: '' }))
  const onlyFreshFilter = filters.postedWithin === FRESH_HOURS

  const metricItems = [
    { key: 'new', label: 'new', value: stats.new, tone: 'success', title: 'Found in the last 48 hours. Tap to sort by recently found', active: sort === 'found' },
    { key: 'strong', label: 'strong fit', value: stats.strong, tone: 'accent', title: 'Fit score 70+. Tap to filter', active: filters.minFit === '70' },
    { key: 'appliedToday', label: 'applied today', value: trend[trend.length - 1]?.applied ?? 0, tone: 'info', title: 'Tap to show applied jobs', active: tab === 'applied' },
  ]
  const onMetric = (key) => {
    if (key === 'new') setSort(prev => (prev === 'found' ? 'fit' : 'found'))
    if (key === 'strong') toggleFilter('minFit', '70')
    if (key === 'appliedToday') setTab(prev => (prev === 'applied' ? 'all' : 'applied'))
  }

  const hasMaxYears = profile?.max_years !== null && profile?.max_years !== undefined
  const quickChips = [
    { key: 'postedWithin', value: FRESH_HOURS, label: 'Last 24h' },
    { key: 'minFit', value: '70', label: 'Fit 70+' },
    { key: 'matchedOnly', value: true, label: 'Has my skills', disabled: profileSkills.length === 0, reason: 'Add skills to your profile first' },
    {
      key: 'maxYears',
      value: hasMaxYears ? String(profile.max_years) : '',
      label: hasMaxYears ? `≤ ${profile.max_years} yrs` : 'Fits my experience',
      disabled: !hasMaxYears,
      reason: 'Set your experience in Settings → Profile',
    },
  ]

  // Quick-chip values are shown as toggles, so they are not repeated as removable chips
  const activeChips = ['q', ...PANEL_KEYS]
    .filter(key => filters[key] && !quickChips.some(chip => chip.key === key && chip.value === filters[key]))
    .map(key => ({ key, text: `${FILTER_LABELS[key]}: ${chipValue(key, filters[key])}` }))
  const hasCustomFilters = activeChips.length > 0 || filters.matchedOnly || filters.minFit || filters.maxYears

  // Keyboard selection: the drawer's job wins, otherwise the highlighted row
  const currentKey = selectedJob?.job_key ?? activeKey
  const currentIndex = currentKey ? jobs.findIndex(job => job.job_key === currentKey) : -1
  const currentJob = selectedJob || jobs[currentIndex] || null

  const moveSelection = (delta) => {
    if (!jobs.length) return
    const next = currentIndex < 0 ? 0 : Math.min(Math.max(currentIndex + delta, 0), jobs.length - 1)
    const job = jobs[next]
    setActiveKey(job.job_key)
    if (selectedJob) {
      setSelectedJob(job)
      const ahead = jobs[next + delta]
      if (ahead) api.prefetchJob(ahead.job_key)
    }
    if (hasMore && !loading && next >= jobs.length - LOAD_AHEAD_ROWS) setPage(prev => prev + 1)
  }

  const needsJob = (action) => () => {
    if (!currentJob) return false
    return action(currentJob)
  }

  useHotkeys(helpOpen
    ? { '?': () => setHelpOpen(false), Escape: () => setHelpOpen(false) }
    : {
      j: () => moveSelection(1),
      k: () => moveSelection(-1),
      Enter: (e) => {
        if (e.target !== document.body || selectedJob || !currentJob) return false
        openJob(currentJob)
      },
      o: needsJob((job) => {
        const url = jobUrl(job)
        if (!url) return false
        window.open(url, '_blank', 'noopener,noreferrer')
      }),
      a: needsJob(job => { handleApplied(job, !job.is_applied) }),
      x: needsJob(job => { handleHide(job) }),
      u: () => (toast?.undo ? runUndo() : false),
      '/': () => openSearch(),
      r: () => refreshAll(),
      v: () => changeView(view === 'list' ? 'grid' : 'list'),
      '?': () => setHelpOpen(true),
      ...Object.fromEntries(TABS.map(item => [item.key, () => setTab(item.value)])),
      Escape: (e) => {
        if (e.target !== searchRef.current) return false
        searchRef.current.blur()
        if (!searchInput) setSearchOpen(false)
      },
    })

  const ItemComponent = view === 'grid' ? JobCard : JobRow
  const listClass = view === 'grid' ? 'jobs-grid' : 'jobs-list'
  const metrics = <Metrics items={metricItems} trend={trend} onSelect={onMetric} />
  const ToastIcon = toast ? TOAST_ICONS[toast.tone] : null

  return (
    <div className="page-shell">
      <Header
        metrics={metrics}
        onSearch={toggleSearch}
        searchOpen={searchVisible}
        view={view}
        onViewChange={changeView}
        onHelp={() => setHelpOpen(true)}
      />

      <main className="page-content">
        {(pull > 0 || pullBusy) && (
          <div className={`ptr ${armed ? 'armed' : ''}`} style={pull > 0 ? { height: pull } : undefined} aria-live="polite">
            {pullBusy ? <><span className="spinner" /> Refreshing…</> : armed ? 'Release to refresh' : 'Pull to refresh'}
          </div>
        )}

        {!profileLoading && !profile && (
          <div className="hint-banner">
            <span>Set up your fit profile (target roles, skills, experience) to rank jobs for you.</span>
            <button type="button" className="btn primary sm" onClick={() => navigate('/settings?tab=profile')}>Set up profile</button>
          </div>
        )}

        <section className={`toolbar ${searchVisible ? 'search-open' : 'search-closed'}`}>
          <label className="search-box">
            <SearchIcon />
            <input
              ref={searchRef}
              type="search"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search title, company, role or skill"
              aria-label="Search jobs"
            />
            {!searchInput && <kbd className="search-kbd" aria-hidden="true">/</kbd>}
          </label>
          <SearchFilter filters={filters} facets={facets} onChange={setFilters} />
          <select className="sort-select" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort jobs">
            {SORTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <div className="tab-group" role="tablist" aria-label="Application state">
            {TABS.map(({ value, label, key }) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={`tab-button ${tab === value ? 'active' : ''}`}
                onClick={() => setTab(value)}
                title={`${label} (${key})`}
              >
                {label}
                <span className="count-badge">{tabCounts[value] ?? 0}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="chip-row" aria-label="Quick filters">
          {quickChips.map(chip => {
            const active = chip.value !== '' && filters[chip.key] === chip.value
            return (
              <button
                key={chip.key}
                type="button"
                className={`pill-toggle ${active ? 'active' : ''}`}
                onClick={() => toggleFilter(chip.key, chip.value)}
                disabled={chip.disabled}
                title={chip.disabled ? chip.reason : undefined}
                aria-pressed={active}
              >
                {chip.label}
              </button>
            )
          })}
          {activeChips.map(chip => (
            <button key={chip.key} type="button" className="filter-chip" onClick={() => clearFilter(chip.key)} aria-label={`Remove ${chip.text}`}>
              {chip.text} <span aria-hidden="true">×</span>
            </button>
          ))}
          {(hasCustomFilters || !onlyFreshFilter) && (
            <button type="button" className="text-button" onClick={clearAll}>Reset</button>
          )}
          {!error && jobs.length > 0 && (
            <span className="result-count" aria-live="polite">
              {jobs.length} of {totalCount}
              {(refreshing || (loading && page === 0)) && <span className="updating"> · updating…</span>}
            </span>
          )}
        </section>

        {loading && jobs.length === 0 && (
          <section className={listClass} aria-busy="true">
            {waiting && (
              <div className="state-block grid-span">
                <div className="spinner" />
                <h3>Waking up the Databricks warehouse</h3>
                <p>The first query after a pause can take up to a minute.</p>
              </div>
            )}
            {Array.from({ length: view === 'grid' ? 6 : 10 }, (_, index) => (
              <div key={index} className={`${view === 'grid' ? 'job-card' : 'job-row'} skeleton`} aria-hidden="true" />
            ))}
          </section>
        )}

        {error && (
          <div className="state-block">
            <h3>Couldn't load jobs</h3>
            <p>{error}</p>
            <button type="button" onClick={() => fetchJobs(page)} className="btn">Retry</button>
          </div>
        )}

        {jobs.length > 0 && (
          <section className={`${listClass} ${loading && page === 0 ? 'is-stale' : ''}`}>
            {jobs.map(job => (
              <ItemComponent
                key={job.job_key}
                job={job}
                profileSkills={profileSkills}
                active={job.job_key === currentKey}
                onOpen={openJob}
                onHide={handleHide}
                onApplied={handleApplied}
              />
            ))}
          </section>
        )}

        {!loading && !error && jobs.length === 0 && (
          <div className="state-block">
            <h3>
              {hasCustomFilters || tab !== 'all'
                ? 'No matching jobs'
                : onlyFreshFilter ? 'Nothing new in the last 24 hours' : 'No jobs yet'}
            </h3>
            <p>
              {hasCustomFilters || tab !== 'all'
                ? 'Try removing a filter or switching tabs.'
                : onlyFreshFilter
                  ? 'Older jobs are hidden. New ones appear after the next pipeline run.'
                  : 'Jobs appear here after the Databricks pipeline runs.'}
            </p>
            <div className="actions-row">
              {hasCustomFilters && <button type="button" onClick={clearAll} className="btn">Clear filters</button>}
              {filters.postedWithin && <button type="button" onClick={showOlderJobs} className="btn">Show older jobs</button>}
            </div>
          </div>
        )}

        {loading && jobs.length > 0 && <div className="footer-note">Loading more…</div>}

        {!loading && hasMore && !error && (
          <div className="footer-note">
            <button type="button" className="btn" onClick={() => setPage(prev => prev + 1)}>Load more</button>
          </div>
        )}

        {!loading && !hasMore && jobs.length >= 10 && <div className="footer-note">That's all {jobs.length}</div>}

        <p className="footer-note hide-mobile">Press <kbd>?</kbd> for keyboard shortcuts</p>
      </main>

      <nav className="bottom-nav hide-desktop" aria-label="Job lists">
        {TABS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={`nav-item ${tab === value ? 'active' : ''}`}
            onClick={() => setTab(value)}
            aria-pressed={tab === value}
          >
            <strong>{tabCounts[value] ?? 0}</strong>
            <span>{label}</span>
          </button>
        ))}
        <SearchFilter variant="nav" filters={filters} facets={facets} onChange={setFilters} sorts={SORTS} sort={sort} onSortChange={setSort} />
      </nav>

      {selectedJob && (
        <JobDrawer
          job={selectedJob}
          profile={profile}
          position={{ index: currentIndex, total: totalCount, last: jobs.length - 1 }}
          onMove={moveSelection}
          onClose={closeDrawer}
          onApplied={handleApplied}
          onHide={handleHide}
        />
      )}

      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}

      {toast && (
        <div className={`toast ${toast.tone || ''}`} role="status">
          {ToastIcon && <ToastIcon />}
          <span>{toast.message}</span>
          {toast.undo && (
            <button type="button" onClick={runUndo}>Undo <kbd>u</kbd></button>
          )}
        </div>
      )}
    </div>
  )
}
