import { Fragment, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Header } from '../components/layout/Header'
import { JobCard } from '../components/common/JobCard'
import { JobRow } from '../components/common/JobRow'
import { JobDrawer } from '../components/common/JobDrawer'
import { Metrics } from '../components/common/Metrics'
import { ShortcutHelp } from '../components/common/ShortcutHelp'
import { Toast } from '../components/common/Toast'
import { SearchIcon } from '../components/common/icons'
import { SearchFilter } from '../components/common/SearchFilter'
import { BulkBar } from '../components/list/BulkBar'
import { ReturnPrompt } from '../components/list/ReturnPrompt'
import { StageChips } from '../components/list/StageChips'
import { SwipeHint } from '../components/list/SwipeHint'
import {
  APPLIED_TAB_FILTERS, MUTE_KINDS, TOAST_REASONS, addChanges, adjustSummary, bumpAppliedToday, hideKeys, negate, plural,
  statusChanges, statusFields, statusOf, statusPatch, summaryParams, todayKey,
} from '../components/list/listState'
import { api } from '../lib/api'
import { useProfile } from '../hooks/useProfile'
import { useHotkeys } from '../hooks/useHotkeys'
import { useJobList } from '../hooks/useJobList'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { useReturnPrompt } from '../hooks/useReturnPrompt'
import { useSelection } from '../hooks/useSelection'
import { useToast } from '../hooks/useToast'
import { useUrlState } from '../hooks/useUrlState'
import {
  APPLIED_STATUSES, EMPLOYMENT_LABELS, HIDE_REASONS, MATCH_MIN_FIT, STRONG_FIT, WORK_MODE_LABELS, buildTrend, facetOptions,
  companyKey, isApplied, isTracked, jobUrl, statusLabel,
} from '../utils/gold'
import { dataFreshness } from '../utils/job'
import { DEFAULT_FILTERS, EMPTY_FILTERS, FRESH_HOURS, PANEL_KEYS, POSTED_OPTIONS, TRACKED_TABS, defaultSortFor } from '../utils/filters'
import { TRACKED_CSV_COLUMNS, downloadCsv, toCsv, trackedCsvFilename } from '../utils/csv'
import { readAutoAdvance, readView, recordOpened, saveView } from '../utils/viewPref'

const TREND_WINDOW_DAYS = 14
const SEARCH_DEBOUNCE_MS = 350
const COUNTS_REFRESH_MS = 700 // after writes, the counters are re-read once things settle (rapid triage = one query)
const LOAD_AHEAD_ROWS = 5 // keyboard navigation loads the next page this many rows before the end
const AUTO_SYNC_CHECK_MS = 5 * 60_000 // how often an open, visible page checks for a new pipeline publish
const AUTO_REFRESH_MS = 60 * 60_000 // an open page also refetches data older than this (e.g. writes from another device)

const SORTS = [
  { value: 'fit', label: 'Best fit' },
  { value: 'recent', label: 'Newest posted' },
  { value: 'found', label: 'Recently found' },
  { value: 'applied', label: 'Applied date' },
]

const TABS = [
  { value: 'pending', label: 'To apply', key: '1' },
  { value: 'saved', label: 'Saved', key: '2' },
  { value: 'applied', label: 'Applied', key: '3' },
  { value: 'all', label: 'All', key: '4' },
]

// "For you" (your roles, fit 60+) or "Show all" (every job by fit); remembered per user on this device
const SCOPES = [
  { value: 'match', label: 'For you', title: `Jobs in your roles (or the same category) with fit ${MATCH_MIN_FIT}+, plus the ones you saved or applied to` },
  { value: 'all', label: 'Show all', title: 'Every job, best fit first' },
]

const FILTER_LABELS = {
  q: 'Search',
  role: 'Role',
  category: 'Category',
  source: 'Source',
  company: 'Company',
  location: 'Location',
  city: 'City',
  workMode: 'Work mode',
  employment: 'Employment',
  maxYears: 'Max years',
  postedWithin: 'Posted',
  minFit: 'Fit',
}

function chipValue(key, value) {
  if (key === 'minFit') return `${value}+`
  if (key === 'postedWithin') return (POSTED_OPTIONS.find(option => option.value === value)?.label || `last ${value}h`).toLowerCase()
  if (key === 'maxYears') return value === '0' ? 'Fresher' : `≤ ${value} yrs`
  if (key === 'workMode') return WORK_MODE_LABELS[value] || value
  if (key === 'employment') return EMPLOYMENT_LABELS[value] || value
  return value
}

// [title, text] for an empty list. narrowed: filters are hiding jobs.
function emptyMessage({ tab, narrowed, scope, onlyFresh, muteOnly }) {
  if (muteOnly) return ['No muted jobs here', 'Nothing in this view matches your mute rules.']
  if (!narrowed && tab === 'saved') return ['No saved jobs', 'Press s or tap the bookmark to keep a job past its 2-day expiry.']
  if (!narrowed && tab === 'applied') return ['No applied jobs yet', 'Press a or tap the check mark on a job you applied to, and track it here.']
  if (narrowed) return ['No matching jobs', 'Try removing a filter or switching tabs.']
  if (scope === 'match') {
    return ['No jobs for your roles yet', `Nothing in your roles with fit ${MATCH_MIN_FIT}+ right now. New jobs arrive after each pipeline run, or see every job.`]
  }
  if (onlyFresh) return ['Nothing new in the last 24 hours', 'Older jobs are hidden. New ones appear after the next pipeline run.']
  return ['No jobs yet', 'Jobs appear here after the next pipeline run.']
}

export function JobsPage() {
  const navigate = useNavigate()
  const { profile, loading: profileLoading, error: profileError, addMuteRule, removeMuteRule } = useProfile()
  const {
    tab, sort, scope, filters, setTab, setSort, setScope, setFilters,
    jobKey: urlJobKey, openJob: pushJobUrl, closeJob: closeJobUrl, sheetOpen, setSheetOpen,
  } = useUrlState()
  const [searchInput, setSearchInput] = useState(filters.q)
  const [view, setView] = useState(readView)
  const {
    jobs, page, listKey, totalCount, hasMore, loading, refreshing, error,
    reload: reloadJobs, loadMore, retry, updateJob, removeJob,
  } = useJobList({ filters, scope, sort, tab })
  // Start from the cached counters (as the list does), so the header doesn't paint 0s and then widen to the real numbers
  const [summary, setSummary] = useState(() => api.cachedRows('summary', summaryParams(filters, scope))?.[0] || {})
  const [trendRows, setTrendRows] = useState(() => api.cachedRows('trend', { scope }))
  const [facetRows, setFacetRows] = useState([])
  // Last pipeline publish ({ run_id, published_at, ... }), for the "Updated X ago" note
  const [status, setStatus] = useState(() => api.cachedRows('status', {})?.[0] || {})
  const [selectedJob, setSelectedJob] = useState(null)
  const [activeKey, setActiveKey] = useState(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [focusStatus, setFocusStatus] = useState(0) // bumped by t: the drawer focuses its status picker
  // Expanded near-duplicate groups, by the representative's job_key: { status: 'loading' | 'expanded', rows }
  const [groups, setGroups] = useState({})
  const { toast, showToast, runUndo, undoCount } = useToast()
  const summaryRequestRef = useRef(0)
  const searchRef = useRef(null)
  const filtersRef = useRef(filters)
  const refreshRef = useRef(null)
  const countsTimerRef = useRef(null)
  const scrollToActiveRef = useRef(false) // set by keyboard / drawer moves; a tapped row is already on screen
  const pageRef = useRef({}) // the latest render's values and handlers, for the stable row actions below

  // New users pick their roles and skills first (the list is built from them)
  useEffect(() => {
    if (!profileLoading && !profileError && !profile) navigate('/settings?tab=profile&welcome=1', { replace: true })
  }, [profileLoading, profileError, profile, navigate])

  useEffect(() => {
    filtersRef.current = summaryParams(filters, scope)
  }, [filters, scope])

  // Debounce the search box into filters.q
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters(prev => (prev.q === searchInput.trim() ? prev : { ...prev, q: searchInput.trim() }))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, setFilters])

  // The URL changed the search (Back / Forward, a link): the box follows
  useEffect(() => {
    setSearchInput(prev => (prev.trim() === filters.q ? prev : filters.q))
  }, [filters.q])

  // Expanded groups belong to the result set they were opened in
  useEffect(() => {
    setGroups({})
  }, [listKey])

  const summaryKey = JSON.stringify(summaryParams(filters, scope))
  const fetchSummary = useCallback(async () => {
    const requestId = ++summaryRequestRef.current
    const isCurrent = () => requestId === summaryRequestRef.current
    try {
      const row = await api.summary(JSON.parse(summaryKey), { onCached: cached => { if (isCurrent()) setSummary(cached || {}) } })
      if (isCurrent()) setSummary(row)
    } catch (err) {
      console.error('Failed to load summary:', err)
    }
  }, [summaryKey])

  const fetchTrend = useCallback(async () => {
    try {
      setTrendRows(await api.trend({ scope }, { onCached: setTrendRows }))
    } catch (err) {
      console.error('Failed to load trend:', err)
    }
  }, [scope])

  const fetchFacets = useCallback(() => {
    api.facets({ scope }, { onCached: setFacetRows }).then(setFacetRows).catch(err => console.error('Failed to load facets:', err))
  }, [scope])

  useEffect(() => {
    fetchSummary()
  }, [fetchSummary])

  useEffect(() => {
    fetchTrend()
    fetchFacets()
  }, [fetchTrend, fetchFacets])

  // After a write: re-read the counters once the burst of writes settles
  const scheduleCounts = useCallback(() => {
    clearTimeout(countsTimerRef.current)
    countsTimerRef.current = setTimeout(() => pageRef.current.fetchSummary(), COUNTS_REFRESH_MS)
  }, [])

  useEffect(() => () => clearTimeout(countsTimerRef.current), [])

  // Rows on screen in order: each list row, then the postings of its group when expanded. A posting that is also a
  // list row (a tracked one of the group, loaded by a later page) shows only as that row: one key, one row.
  const displayRows = useMemo(() => {
    const listed = new Set(jobs.map(job => job.job_key))
    const rows = []
    for (const job of jobs) {
      const group = groups[job.job_key]
      rows.push({ job, group: group ? group.status : 'collapsed', child: false })
      if (group?.status !== 'expanded') continue
      group.rows.forEach((child) => {
        if (listed.has(child.job_key)) return
        listed.add(child.job_key)
        rows.push({ job: child, group: null, child: true, parent: job.job_key })
      })
    }
    return rows
  }, [jobs, groups])
  const displayJobs = useMemo(() => displayRows.map(row => row.job), [displayRows])
  const order = useMemo(() => displayJobs.map(job => job.job_key), [displayJobs])
  const selection = useSelection(order)

  // Local edits after a write. patches: Map job_key -> fields
  const patchJobs = useCallback((patches) => {
    if (!patches.size) return
    patches.forEach((patch, key) => updateJob(key, patch))
    setGroups(prev => {
      let changed = false
      const next = {}
      for (const [key, group] of Object.entries(prev)) {
        if (!group.rows.some(row => patches.has(row.job_key))) {
          next[key] = group
          continue
        }
        changed = true
        next[key] = { ...group, rows: group.rows.map(row => (patches.has(row.job_key) ? { ...row, ...patches.get(row.job_key) } : row)) }
      }
      return changed ? next : prev
    })
    setSelectedJob(prev => (prev && patches.has(prev.job_key) ? { ...prev, ...patches.get(prev.job_key) } : prev))
  }, [updateJob])

  const patchJob = useCallback((jobKey, patch) => patchJobs(new Map([[jobKey, patch]])), [patchJobs])

  // The drawer's note / follow-up save: a note on an untracked job saves it, so the tab counts are re-read
  const noteChanged = useCallback((jobKey, patch) => {
    patchJob(jobKey, patch)
    if (patch && 'application_status' in patch) scheduleCounts()
  }, [patchJob, scheduleCounts])

  // Rows leave the screen (hidden): list rows, group postings and expanded groups of hidden representatives
  const dropJobs = useCallback((keys) => {
    const drop = new Set(keys)
    const listed = new Set(pageRef.current.jobs.map(job => job.job_key))
    keys.forEach(key => { if (listed.has(key)) removeJob(key) })
    setGroups(prev => {
      const next = {}
      for (const [key, group] of Object.entries(prev)) {
        if (drop.has(key)) continue
        next[key] = { ...group, rows: group.rows.filter(row => !drop.has(row.job_key)) }
      }
      return next
    })
  }, [removeJob])

  const refreshLists = useCallback(() => {
    const { reloadJobs: reload, fetchSummary: summaryNow, fetchFacets: facetsNow } = pageRef.current
    reload()
    summaryNow()
    facetsNow()
  }, [])

  // ---- opening and moving ----

  const openJob = useCallback((job) => {
    scrollToActiveRef.current = false
    setActiveKey(job.job_key)
    setSelectedJob(job)
    pushJobUrl(job.job_key)
  }, [pushJobUrl])

  const closeDrawer = useCallback(() => {
    setSelectedJob(null)
    closeJobUrl()
  }, [closeJobUrl])

  // Moves the highlight (and an open drawer) to the row at index; returns that job
  const moveTo = useCallback((index) => {
    const { displayJobs: list, selectedJob: open, hasMore: more, loading: busy } = pageRef.current
    if (!list.length) return null
    const next = Math.min(Math.max(index, 0), list.length - 1)
    const job = list[next]
    scrollToActiveRef.current = true
    setActiveKey(job.job_key)
    if (open) {
      setSelectedJob(job)
      pushJobUrl(job.job_key)
      const ahead = list[next + 1]
      if (ahead) api.prefetchJob(ahead.job_key)
    }
    if (more && !busy && next >= list.length - LOAD_AHEAD_ROWS) pageRef.current.loadMore()
    return job
  }, [pushJobUrl])

  const moveSelection = useCallback((delta) => {
    const { currentIndex: index } = pageRef.current
    return moveTo(index < 0 ? 0 : index + delta)
  }, [moveTo])

  // Auto-advance (#8): after marking the current job applied, go on to the next one
  const advanceFrom = useCallback((job) => {
    const { currentKey: current, displayJobs: list } = pageRef.current
    if (!readAutoAdvance() || job.job_key !== current) return
    const index = list.findIndex(item => item.job_key === job.job_key)
    if (index >= 0 && index < list.length - 1) moveTo(index + 1)
  }, [moveTo])

  // ---- writes ----

  const runUndoStep = useCallback(async () => {
    try {
      const label = await runUndo()
      if (label !== null) showToast('Undone')
    } catch (err) {
      showToast(`Could not undo: ${err.message}`)
    }
  }, [runUndo, showToast])

  // Sets status on jobs (optimistic), with one undo that puts each job back to its own previous status
  const changeStatus = useCallback(async (list, status, { message, tone } = {}) => {
    const targets = list.filter(job => statusOf(job) !== status)
    if (!targets.length) return false
    const now = new Date().toISOString()
    const before = new Map(targets.map(job => [job.job_key, statusFields(job)]))
    const changes = targets.reduce((total, job) => addChanges(total, statusChanges(job, status)), {})
    const appliedDelta = targets.filter(job => APPLIED_STATUSES.includes(status) !== isApplied(job))
      .reduce((sum, job) => sum + (APPLIED_STATUSES.includes(status) ? 1 : String(job.applied_at || '').slice(0, 10) === todayKey() ? -1 : 0), 0)
    const keys = targets.map(job => job.job_key)
    patchJobs(new Map(targets.map(job => [job.job_key, statusPatch(job, status, now)])))
    setSummary(prev => adjustSummary(prev, changes))
    if (appliedDelta) setTrendRows(prev => bumpAppliedToday(prev || [], appliedDelta))

    const restore = () => {
      patchJobs(before)
      setSummary(prev => adjustSummary(prev, negate(changes)))
      if (appliedDelta) setTrendRows(prev => bumpAppliedToday(prev || [], -appliedDelta))
    }
    try {
      await api.setStatus(keys.length === 1 ? keys[0] : keys, status)
    } catch (err) {
      restore()
      showToast(`Could not update: ${err.message}`)
      return false
    }
    showToast(message || `Status: ${statusLabel(status)}`, async () => {
      restore()
      // One write per previous status and times (an undo also puts back when you applied and when the stage changed)
      const groups = new Map()
      before.forEach((fields, key) => {
        const id = JSON.stringify([fields.application_status, fields.applied_at, fields.status_updated_at])
        if (!groups.has(id)) groups.set(id, { fields, keys: [] })
        groups.get(id).keys.push(key)
      })
      try {
        for (const { fields, keys: previousKeys } of groups.values()) {
          await api.setStatus(previousKeys.length === 1 ? previousKeys[0] : previousKeys, fields.application_status,
            { appliedAt: fields.applied_at, statusUpdatedAt: fields.status_updated_at })
        }
      } catch (err) {
        pageRef.current.reloadJobs() // the rows were put back on screen only: show what the server has
        throw err
      } finally {
        pageRef.current.scheduleCounts()
      }
    }, tone)
    scheduleCounts()
    return true
  }, [patchJobs, showToast, scheduleCounts])

  const toggleApplied = useCallback((job, applied) => {
    if (applied) advanceFrom(job)
    return changeStatus([job], applied ? 'applied' : 'not_applied', {
      message: applied ? 'Marked as applied' : 'Marked as not applied',
      tone: applied ? 'success' : undefined,
    })
  }, [advanceFrom, changeStatus])

  const toggleSaved = useCallback((job) => {
    if (isApplied(job)) {
      showToast('Already applied')
      return
    }
    const saved = statusOf(job) === 'saved'
    changeStatus([job], saved ? 'not_applied' : 'saved', { message: saved ? 'Removed from saved' : 'Saved' })
  }, [changeStatus, showToast])

  // The status picker (rows, drawer), the drawer's Save button and its closed-posting shortcuts
  const setJobStatus = useCallback((job, status) => {
    const was = statusOf(job)
    let message
    if (status === 'saved' && !isApplied(job)) message = 'Saved'
    else if (status === 'not_applied' && was === 'saved') message = 'Removed from saved'
    else if (status === 'not_applied') message = 'Marked as not applied'
    return changeStatus([job], status, { message, tone: status === 'applied' ? 'success' : undefined })
  }, [changeStatus])

  // Mute rules (#12): the lists reload, since the server leaves muted jobs out
  const addRule = useCallback(async (kind, value, label) => {
    try {
      await addMuteRule(kind, value)
    } catch (err) {
      showToast(`Could not mute: ${err.message}`)
      return
    }
    refreshLists()
    // The open drawer is not part of the reloaded lists: mark it, so its "Mute this company" reads "Company muted"
    const hits = (job) => job && !isTracked(job) && (kind === 'companies'
      ? companyKey(job.company_name) === companyKey(value)
      : kind === 'levels' && job.experience_level === value)
    const muteKind = kind === 'companies' ? 'company' : 'level'
    setSelectedJob(prev => (hits(prev) && !prev.muted_by ? { ...prev, muted_by: muteKind, muted_value: value } : prev))
    showToast(`Muted ${label}. Matching jobs are left out of your lists`, async () => {
      await removeMuteRule(kind, value)
      setSelectedJob(prev => (prev?.muted_by === muteKind && prev.muted_value === value ? { ...prev, muted_by: null, muted_value: null } : prev))
      pageRef.current.refreshLists()
    })
  }, [addMuteRule, removeMuteRule, refreshLists, showToast])

  const unmute = useCallback(async (job) => {
    const kind = MUTE_KINDS[job.muted_by]
    if (!kind || !job.muted_value) return
    try {
      await removeMuteRule(kind, job.muted_value)
    } catch (err) {
      showToast(`Could not unmute: ${err.message}`)
      return
    }
    refreshLists()
    showToast(`Unmuted "${job.muted_value}"`, async () => {
      await addMuteRule(kind, job.muted_value)
      pageRef.current.refreshLists()
    })
  }, [addMuteRule, removeMuteRule, refreshLists, showToast])

  const muteCompany = useCallback((job) => {
    if (job?.company_name) addRule('companies', job.company_name, job.company_name)
  }, [addRule])

  // Hides rows (a collapsed row with its near-duplicates); the highlight and an open drawer move on to the next job.
  // Without a reason, the toast offers the reasons (kept as feedback) and then a matching mute rule. A reason is feedback
  // on the jobs you judged, so their near-duplicates are hidden without one (one feedback row per judged job).
  const hideJobs = useCallback(async (list, reason) => {
    const { displayJobs: shown, groups: open, currentKey: current } = pageRef.current
    const keys = [...new Set(list.flatMap(job => hideKeys(job, open[job.job_key]?.status === 'expanded')))]
    if (!keys.length) return
    const gone = new Set(keys)
    const reloadAfter = list.some(job => open[job.job_key]?.status === 'expanded') // its group needs a new representative
    if (current && gone.has(current)) {
      // A job opened from a link may not be in the list: then the drawer just closes
      const index = shown.findIndex(job => job.job_key === current)
      const neighbour = index < 0 ? null : shown.slice(index + 1).find(job => !gone.has(job.job_key))
        || shown.slice(0, index).reverse().find(job => !gone.has(job.job_key)) || null
      scrollToActiveRef.current = true
      setActiveKey(neighbour?.job_key ?? null)
      if (pageRef.current.selectedJob) {
        if (neighbour) {
          setSelectedJob(neighbour)
          pushJobUrl(neighbour.job_key)
        } else {
          closeDrawer()
        }
      }
    }
    dropJobs(keys)
    const target = keys.length === 1 ? keys[0] : keys
    const judged = [...new Set(list.map(job => job.job_key))].filter(key => gone.has(key))
    const judgedTarget = judged.length === 1 ? judged[0] : judged
    const others = keys.filter(key => !judged.includes(key))
    // The reason (when there is one) goes with the judged jobs only
    const hideWithReason = async (value) => {
      if (!value || !judged.length) return api.setHidden(target, true, value)
      await api.setHidden(judgedTarget, true, value)
      if (others.length) await api.setHidden(others.length === 1 ? others[0] : others, true)
    }
    try {
      await hideWithReason(reason)
    } catch (err) {
      showToast(`Could not hide: ${err.message}`)
      pageRef.current.reloadJobs()
      return
    }
    if (reloadAfter) pageRef.current.reloadJobs()
    scheduleCounts()

    const first = list[0]
    const giveReason = async (value) => {
      try {
        await api.setHidden(judged.length ? judgedTarget : target, true, value)
      } catch (err) {
        showToast(`Could not save the reason: ${err.message}`)
        return
      }
      const followUps = []
      if (value === 'company' && first.company_name && list.length === 1) {
        followUps.push({ label: `Mute ${first.company_name}`, onClick: () => pageRef.current.addRule('companies', first.company_name, first.company_name) })
      }
      if (value === 'too_senior' && first.experience_level && list.length === 1) {
        followUps.push({ label: `Mute ${first.experience_level} jobs`, onClick: () => pageRef.current.addRule('levels', first.experience_level, `${first.experience_level} jobs`) })
      }
      const label = HIDE_REASONS.find(item => item.value === value)?.label || value
      showToast(`Thanks, noted: ${label.toLowerCase()}`, undefined, undefined, followUps, { offerUndo: true })
    }
    const message = keys.length === 1 ? 'Job hidden' : `Hidden ${plural(keys.length, 'posting')}`
    showToast(message, async () => {
      try {
        await api.setHidden(target, false)
      } finally {
        pageRef.current.refreshLists()
      }
    }, 'danger', reason ? undefined : TOAST_REASONS.map(item => ({ label: item.label, onClick: () => giveReason(item.value) })))
  }, [closeDrawer, dropJobs, pushJobUrl, scheduleCounts, showToast])

  const hideJob = useCallback((job, reason) => hideJobs([job], reason), [hideJobs])

  // Near-duplicate postings under a row (#11)
  const toggleGroup = useCallback(async (job) => {
    const key = job.job_key
    if (pageRef.current.groups[key]) {
      setGroups(prev => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      return
    }
    if (!job.dup_group) return
    setGroups(prev => ({ ...prev, [key]: { status: 'loading', rows: [] } }))
    try {
      const rows = await api.jobGroup(job.dup_group)
      const listed = new Set(pageRef.current.jobs.map(item => item.job_key))
      const children = rows.filter(row => !listed.has(row.job_key))
      setGroups(prev => (prev[key] ? { ...prev, [key]: { status: 'expanded', rows: children } } : prev))
    } catch (err) {
      setGroups(prev => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      showToast(`Could not load the similar postings: ${err.message}`)
    }
  }, [showToast])

  // ---- bulk selection (#12) ----

  const selectedJobs = useMemo(() => {
    const byKey = new Map(displayJobs.map(job => [job.job_key, job]))
    return selection.keys.map(key => byKey.get(key)).filter(Boolean)
  }, [selection.keys, displayJobs])

  const runBulk = useCallback(async (action) => {
    const list = pageRef.current.selectedJobs
    if (!list.length) return
    setBulkBusy(true)
    try {
      await action(list)
      pageRef.current.selection.clear()
    } finally {
      setBulkBusy(false)
    }
  }, [])

  const bulkSave = useCallback(() => runBulk(async (list) => {
    const targets = list.filter(job => !isApplied(job) && statusOf(job) !== 'saved')
    if (!targets.length) {
      showToast(list.every(isApplied) ? 'Already applied' : 'Already saved')
      return
    }
    await changeStatus(targets, 'saved', { message: `Saved ${plural(targets.length, 'job')}` })
  }), [runBulk, changeStatus, showToast])

  const bulkApplied = useCallback(() => runBulk(async (list) => {
    const targets = list.filter(job => !isApplied(job))
    if (!targets.length) {
      showToast('Already applied')
      return
    }
    await changeStatus(targets, 'applied', { message: `Marked ${plural(targets.length, 'job')} as applied`, tone: 'success' })
  }), [runBulk, changeStatus, showToast])

  const bulkHide = useCallback(() => runBulk(list => hideJobs(list)), [runBulk, hideJobs])

  const selectJob = useCallback((job, { range = false } = {}) => {
    const { currentKey: current, selection: picked } = pageRef.current
    if (range) picked.extendTo(job.job_key, current ?? undefined)
    else picked.toggle(job.job_key)
    setActiveKey(job.job_key)
  }, [])

  // The row handlers, one stable object (rows are memoized)
  const rowActions = useMemo(() => ({
    open: job => pageRef.current.openJob(job),
    applied: (job, applied) => pageRef.current.toggleApplied(job, applied),
    save: job => pageRef.current.toggleSaved(job),
    hide: job => pageRef.current.hideJob(job),
    status: (job, next) => pageRef.current.setJobStatus(job, next),
    select: (job, options) => pageRef.current.selectJob(job, options),
    toggleGroup: job => pageRef.current.toggleGroup(job),
    unmute: job => pageRef.current.unmute(job),
    opened: job => recordOpened(job),
    focus: job => setActiveKey(job.job_key), // Tab onto a row: s / a / x / t then act on that row
  }), [])

  // ---- apply on return (#8) ----

  const trackedState = useCallback((key) => {
    const job = pageRef.current.displayJobs?.find(item => item.job_key === key)
    return job ? isTracked(job) : undefined
  }, [])
  const { prompt, answer } = useReturnPrompt({ trackedState, enabled: Boolean(profile) })

  const answerPrompt = useCallback((yes) => {
    const asked = prompt
    answer()
    if (!yes || !asked) return
    const known = pageRef.current.displayJobs.find(job => job.job_key === asked.job_key)
    toggleApplied(known || { ...asked, application_status: 'not_applied', is_applied: false }, true)
  }, [prompt, answer, toggleApplied])

  // Marked applied (or saved) some other way meanwhile, e.g. in the drawer: nothing left to ask
  const promptJob = prompt ? (selectedJob?.job_key === prompt.job_key ? selectedJob : displayJobs.find(job => job.job_key === prompt.job_key)) : null
  const promptAnswered = Boolean(promptJob && isTracked(promptJob))
  useEffect(() => {
    if (promptAnswered) answer()
  }, [promptAnswered, answer])

  // ---- the URL's ?job= (deep links, Back / Forward) ----

  useEffect(() => {
    if (!urlJobKey) {
      setSelectedJob(null)
      return undefined
    }
    if (pageRef.current.selectedJob?.job_key === urlJobKey) return undefined
    const known = pageRef.current.displayJobs.find(job => job.job_key === urlJobKey)
    if (known) {
      setActiveKey(urlJobKey)
      setSelectedJob(known)
      return undefined
    }
    let cancelled = false
    api.jobRow(urlJobKey)
      .then((row) => {
        if (cancelled) return
        if (row) {
          setActiveKey(urlJobKey)
          setSelectedJob(row)
        } else {
          showToast('This job is no longer available')
          closeJobUrl()
        }
      })
      .catch((err) => {
        if (cancelled) return
        showToast(`Could not open the job: ${err.message}`)
        closeJobUrl()
      })
    return () => { cancelled = true }
  }, [urlJobKey, closeJobUrl, showToast])

  const changeView = (next) => {
    setView(next)
    saveView(next)
  }

  const changeTab = (next) => {
    if (next !== 'applied' && (filters.stage || filters.followUp || filters.closed)) setFilters(prev => ({ ...prev, ...APPLIED_TAB_FILTERS }))
    selection.clear()
    setTab(next)
  }

  const fetchStatus = useCallback(() => {
    api.status().then(setStatus).catch(err => console.error('Failed to load data status:', err))
  }, [])

  // Reads are cached for a few minutes; this forces fresh data from the server.
  const refreshAll = () => {
    api.refreshData()
    reloadJobs()
    fetchSummary()
    fetchTrend()
    fetchFacets()
    fetchStatus()
  }

  useEffect(() => {
    refreshRef.current = refreshAll
  })

  // Mobile: pull down at the top of the list to refresh (not while a job, sheet or dialog is open)
  const [pullBusy, setPullBusy] = useState(false)
  const { pulling, armed, indicatorRef } = usePullToRefresh(() => {
    setPullBusy(true)
    refreshAll()
  }, !selectedJob && !helpOpen && !sheetOpen)

  useEffect(() => {
    if (!loading) setPullBusy(false)
  }, [loading])

  // Auto-sync: on open and then every few minutes while the tab is visible (and when it becomes visible again), ask
  // whether the pipeline published a new run; if so the cached views were dropped and everything reloads. Data
  // older than AUTO_REFRESH_MS is refetched as well, so changes made on another device show up within the hour.
  useEffect(() => {
    let checking = false
    const check = async () => {
      if (document.visibilityState !== 'visible' || checking) return
      checking = true
      try {
        const published = await api.checkFreshness()
        const syncedAt = api.syncedAt('summary', filtersRef.current)
        if (published || (syncedAt && Date.now() - syncedAt >= AUTO_REFRESH_MS)) refreshRef.current?.()
        else setStatus(await api.status())
      } catch (err) {
        console.error('Failed to check for new data:', err)
      } finally {
        checking = false
      }
    }
    check()
    const timer = setInterval(check, AUTO_SYNC_CHECK_MS)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  const exportCsv = async () => {
    setExporting(true)
    try {
      const rows = await api.trackedJobs()
      downloadCsv(trackedCsvFilename(), toCsv(rows, TRACKED_CSV_COLUMNS))
      showToast(`Exported ${plural(rows.length, 'job')}`, undefined, 'success')
    } catch (err) {
      showToast(`Could not export: ${err.message}`)
    } finally {
      setExporting(false)
    }
  }

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
    city: facetOptions(facetRows, 'city'),
    work_mode: facetOptions(facetRows, 'work_mode'),
    employment: facetOptions(facetRows, 'employment'),
  }), [facetRows])

  const trend = useMemo(() => buildTrend(trendRows || [], TREND_WINDOW_DAYS), [trendRows])
  const freshness = dataFreshness(status.published_at)

  // '–' until the first summary arrives (a "0" that turns into "171" also widens the tabs and shifts the toolbar)
  const summaryReady = summary.total !== undefined && summary.total !== null
  const count = (key) => (summaryReady ? Number(summary[key] ?? 0) : null)
  const tabCounts = { pending: count('pending'), saved: count('saved'), applied: count('applied'), all: count('total') }
  const mutedCount = count('muted') || 0
  const muteOnly = filters.muteView === 'only'

  const toggleFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: prev[key] === value ? EMPTY_FILTERS[key] : value }))
  const setFilterValues = (patch) => setFilters(prev => ({ ...prev, ...patch }))
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
  const trackedTab = TRACKED_TABS.includes(tab)

  const appliedToday = trendRows ? trend[trend.length - 1]?.applied ?? 0 : null
  const metricItems = [
    { key: 'new', label: 'new', value: count('new_48h'), tone: 'success', title: 'Found in the last 48 hours. Tap to sort by recently found', active: sort === 'found' },
    { key: 'strong', label: 'strong fit', value: count('strong_fit'), tone: 'accent', title: `Fit score ${STRONG_FIT}+. Tap to filter`, active: filters.minFit === String(STRONG_FIT) },
    { key: 'appliedToday', label: 'applied today', value: appliedToday, tone: 'info', title: 'Tap to switch between applied jobs and jobs to apply to', active: tab === 'applied' },
  ]
  const onMetric = (key) => {
    if (key === 'new') setSort(sort === 'found' ? defaultSortFor(tab) : 'found')
    if (key === 'strong') toggleFilter('minFit', String(STRONG_FIT))
    if (key === 'appliedToday') changeTab(tab === 'applied' ? 'pending' : 'applied')
  }

  const hasMaxYears = profile?.max_years !== null && profile?.max_years !== undefined
  const cities = profile?.preferred_cities || []
  const coreSkills = profile?.skills || []
  const quickChips = [
    {
      key: 'postedWithin',
      value: FRESH_HOURS,
      label: 'Last 24h',
      disabled: trackedTab,
      reason: 'Saved and applied jobs are listed whatever their date',
    },
    { key: 'minFit', value: String(STRONG_FIT), label: `Fit ${STRONG_FIT}+` },
    { key: 'matchedOnly', value: true, label: 'Has my skills', disabled: coreSkills.length === 0, reason: 'Add skills to your profile first' },
    {
      key: 'maxYears',
      value: hasMaxYears ? String(profile.max_years) : '',
      label: hasMaxYears ? `≤ ${profile.max_years} yrs` : 'Fits my experience',
      disabled: !hasMaxYears,
      reason: 'Set your experience in Settings → Profile',
    },
    {
      key: 'myCities',
      value: true,
      label: 'My cities',
      title: cities.length ? `Jobs in ${cities.join(', ')} or remote` : undefined,
      disabled: cities.length === 0,
      reason: 'Add preferred cities in Settings → Profile',
    },
    { key: 'workMode', value: 'remote', label: 'Remote', title: 'Jobs that say they are remote' },
  ]

  // Quick-chip values are shown as toggles, so they are not repeated as removable chips
  const activeChips = ['q', ...PANEL_KEYS]
    .filter(key => filters[key] && !quickChips.some(chip => chip.key === key && chip.value === filters[key]))
    .map(key => ({ key, text: `${FILTER_LABELS[key]}: ${chipValue(key, filters[key])}` }))
  const hasCustomFilters = activeChips.length > 0 || filters.matchedOnly || filters.minFit || filters.maxYears || filters.myCities
    || filters.workMode || filters.stage || filters.followUp || filters.closed

  // Keyboard selection: the drawer's job wins, otherwise the highlighted row
  const currentKey = selectedJob?.job_key ?? activeKey
  const currentIndex = currentKey ? displayJobs.findIndex(job => job.job_key === currentKey) : -1
  const currentJob = selectedJob || displayJobs[currentIndex] || null

  useLayoutEffect(() => {
    Object.assign(pageRef.current, {
      jobs, displayJobs, groups, selectedJob, currentKey, currentIndex, hasMore, loading, selectedJobs, selection,
      loadMore, reloadJobs, fetchSummary, fetchFacets, scheduleCounts, refreshLists,
      openJob, toggleApplied, toggleSaved, hideJob, setJobStatus, selectJob, toggleGroup, unmute, addRule,
    })
  })

  // Space, J and K act on the row selection only from the page or a row (so buttons and fields keep their keys)
  const onPageOrRow = (e) => e.target === document.body || Boolean(e.target?.dataset?.jobKey)

  const extendSelection = (delta) => {
    if (!currentJob) {
      moveSelection(delta)
      return
    }
    const from = currentJob.job_key
    const next = moveSelection(delta)
    if (next) selection.extendTo(next.job_key, from)
  }

  const openPosting = (job) => {
    const url = jobUrl(job)
    if (!url) return false
    recordOpened(job)
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const needsJob = (action) => () => {
    if (!currentJob) return false
    return action(currentJob)
  }

  // The filter sheet is modal and handles its own Esc: no list keys act behind it
  useHotkeys(sheetOpen ? {} : helpOpen
    ? { '?': () => setHelpOpen(false), Escape: () => setHelpOpen(false) }
    : {
      j: () => { moveSelection(1) },
      k: () => { moveSelection(-1) },
      g: () => { moveTo(0) },
      G: () => { moveTo(displayJobs.length - 1) },
      J: () => extendSelection(1),
      K: () => extendSelection(-1),
      ' ': (e) => {
        if (!onPageOrRow(e) || !currentJob || selectedJob) return false
        selection.toggle(currentJob.job_key)
      },
      Enter: (e) => {
        if (e.target !== document.body || selectedJob || !currentJob) return false
        openJob(currentJob)
      },
      o: needsJob(openPosting),
      a: () => {
        if (prompt && (!selectedJob || selectedJob.job_key === prompt.job_key)) return answerPrompt(true)
        if (selection.count && !selectedJob) return bulkApplied()
        if (!currentJob) return false
        toggleApplied(currentJob, !isApplied(currentJob))
      },
      s: () => {
        if (selection.count && !selectedJob) return bulkSave()
        if (!currentJob) return false
        toggleSaved(currentJob)
      },
      x: () => {
        if (selection.count && !selectedJob) return bulkHide()
        if (!currentJob) return false
        hideJob(currentJob)
      },
      t: needsJob((job) => {
        if (!selectedJob) openJob(job)
        setFocusStatus(value => value + 1)
      }),
      u: () => (undoCount > 0 ? runUndoStep() : false),
      '/': () => openSearch(),
      f: () => (selectedJob ? false : setSheetOpen(true)),
      r: () => refreshAll(),
      v: () => changeView(view === 'list' ? 'grid' : 'list'),
      '?': () => setHelpOpen(true),
      ...Object.fromEntries(TABS.map(item => [item.key, () => changeTab(item.value)])),
      Escape: (e) => {
        if (e.target === searchRef.current) {
          searchRef.current.blur()
          if (!searchInput) setSearchOpen(false)
          return undefined
        }
        if (selectedJob) return false // the drawer closes itself
        if (prompt) return answerPrompt(false)
        if (selection.count) return selection.clear()
        if (selectMode) return setSelectMode(false)
        return false
      },
    })

  // Keyboard / drawer moves keep the selected row on screen (not on tap or click: that row is already visible,
  // and scrolling there would force a layout inside the tap that opens the drawer)
  useEffect(() => {
    if (!scrollToActiveRef.current || !currentKey) return
    scrollToActiveRef.current = false
    const item = document.querySelector(`[data-job-key="${CSS.escape(currentKey)}"]`)
    if (!item) return
    // Focus follows j / k when it is on a row (e.g. restored there after closing the drawer); otherwise Enter
    // would open the focused, previously selected row instead of the highlighted one
    const focused = document.activeElement
    if (focused !== item && focused?.dataset?.jobKey) item.focus({ preventScroll: true })
    item.scrollIntoView({ block: 'nearest' })
  }, [currentKey])

  // The header's Select button: on (taps select rows), or off and the selection cleared
  const toggleSelectMode = () => {
    if (selectMode || selection.count) {
      selection.clear()
      setSelectMode(false)
    } else {
      setSelectMode(true)
    }
  }

  // The header toggle updates at once; the (heavier) list <-> grid re-render runs in the background
  const listView = useDeferredValue(view)
  const ItemComponent = listView === 'grid' ? JobCard : JobRow
  const listClass = listView === 'grid' ? 'jobs-grid' : 'jobs-list'
  const metrics = <Metrics items={metricItems} trend={trend} onSelect={onMetric} />
  const [emptyTitle, emptyText] = emptyMessage({ tab, narrowed: hasCustomFilters, scope, onlyFresh: onlyFreshFilter, muteOnly })
  const selecting = selectMode || selection.count > 0

  return (
    <div className={`page-shell ${selection.count ? 'has-bulk' : ''}`}>
      <Header
        metrics={metrics}
        onSearch={toggleSearch}
        searchOpen={searchVisible}
        view={view}
        onViewChange={changeView}
        onHelp={() => setHelpOpen(true)}
        onSelectMode={toggleSelectMode}
        selectMode={selecting}
      />

      <main className="page-content">
        {(pulling || pullBusy) && (
          <div ref={indicatorRef} className={`ptr ${armed ? 'armed' : ''}`} aria-live="polite">
            {pullBusy ? <><span className="spinner" /> Refreshing…</> : armed ? 'Release to refresh' : 'Pull to refresh'}
          </div>
        )}

        {profileError && (
          <div className="hint-banner">
            <span>Could not load your profile, so fit scores may be missing: {profileError}</span>
            <button type="button" className="btn primary sm" onClick={() => navigate('/settings?tab=profile')}>Open profile</button>
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
              placeholder="Search title, company, role or skill (-word to exclude)"
              aria-label="Search jobs"
            />
            {!searchInput && <kbd className="search-kbd" aria-hidden="true">/</kbd>}
          </label>
          <SearchFilter
            filters={filters}
            facets={facets}
            onChange={setFilters}
            sorts={SORTS}
            sort={sort}
            onSortChange={setSort}
            open={sheetOpen}
            onOpenChange={setSheetOpen}
          />
          <select className="sort-select" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort jobs">
            {SORTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {/* Toggle buttons, as in the bottom nav: the tabs filter the one list below rather than switch panels */}
          <div className="tab-group" role="group" aria-label="Job lists">
            {TABS.map(({ value, label, key }) => (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
                className={`tab-button ${tab === value ? 'active' : ''}`}
                onClick={() => changeTab(value)}
                title={`${label} (${key})`}
              >
                {label}
                <span className="count-badge">{tabCounts[value] ?? '–'}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="chip-row" aria-label="Quick filters">
          <div className="segmented scope-toggle" role="group" aria-label="Which jobs">
            {SCOPES.map(option => (
              <button
                key={option.value}
                type="button"
                className={scope === option.value ? 'active' : ''}
                onClick={() => setScope(option.value)}
                aria-pressed={scope === option.value}
                title={option.title}
              >
                {option.label}
              </button>
            ))}
          </div>
          {/* A chip that cannot apply stays focusable (aria-disabled), so keyboard and screen-reader users reach its reason */}
          {quickChips.map(chip => {
            const active = !chip.disabled && chip.value !== '' && filters[chip.key] === chip.value
            const reasonId = `chip-reason-${chip.key}`
            return (
              <Fragment key={`${chip.key}-${chip.value}`}>
                <button
                  type="button"
                  className={`pill-toggle ${active ? 'active' : ''}`}
                  onClick={() => { if (!chip.disabled) toggleFilter(chip.key, chip.value) }}
                  aria-disabled={chip.disabled || undefined}
                  aria-describedby={chip.disabled ? reasonId : undefined}
                  title={chip.disabled ? chip.reason : chip.title}
                  aria-pressed={active}
                >
                  {chip.label}
                </button>
                {chip.disabled && <span id={reasonId} className="sr-only">{chip.reason}</span>}
              </Fragment>
            )
          })}
          {activeChips.map(chip => (
            <button key={chip.key} type="button" className="filter-chip" onClick={() => clearFilter(chip.key)} aria-label={`Remove ${chip.text}`}>
              {chip.text} <span aria-hidden="true">×</span>
            </button>
          ))}
          {(muteOnly || mutedCount > 0) && (
            <button
              type="button"
              className={`pill-toggle muted-peek ${muteOnly ? 'active' : ''}`}
              onClick={() => setFilterValues({ muteView: muteOnly ? '' : 'only' })}
              aria-pressed={muteOnly}
              title={muteOnly ? 'Back to your lists' : 'Jobs your mute rules leave out (Settings → Mute rules)'}
            >
              {muteOnly ? `Showing ${mutedCount} muted · Back` : `${mutedCount} hidden by your rules · Show`}
            </button>
          )}
          {(hasCustomFilters || !onlyFreshFilter || muteOnly) && (
            <button type="button" className="text-button" onClick={clearAll}>Reset</button>
          )}
          {!error && jobs.length > 0 && (
            <span className="result-count" aria-live="polite">
              {jobs.length} of {totalCount}
              {(refreshing || (loading && page === 0)) && <span className="updating"> · updating…</span>}
            </span>
          )}
          {freshness && (
            <span className={`data-freshness ${freshness.stale ? 'stale' : ''}`} title={freshness.title}>{freshness.label}</span>
          )}
        </section>

        {tab === 'applied' && (
          <StageChips summary={summary} filters={filters} onChange={setFilterValues} onExport={exportCsv} exporting={exporting} />
        )}

        <SwipeHint />

        {loading && jobs.length === 0 && (
          <section className={listClass} aria-busy="true">
            {Array.from({ length: listView === 'grid' ? 6 : 10 }, (_, index) => (
              <div key={index} className={`${listView === 'grid' ? 'job-card' : 'job-row'} skeleton`} aria-hidden="true" />
            ))}
          </section>
        )}

        {error && (
          <div className="state-block">
            <h3>Couldn't load jobs</h3>
            <p>{error}</p>
            <button type="button" onClick={retry} className="btn">Retry</button>
          </div>
        )}

        {jobs.length > 0 && (
          <section key={listKey} className={`${listClass} ${loading && page === 0 ? 'is-stale' : ''} ${selecting ? 'is-selecting' : ''}`}>
            {displayRows.map(({ job, group, child }) => (
              <ItemComponent
                key={job.job_key}
                job={job}
                profile={profile}
                active={job.job_key === currentKey}
                selected={selection.isSelected(job.job_key)}
                selecting={selecting}
                selectMode={selectMode}
                showStatus={tab === 'applied' && isApplied(job)}
                group={group}
                child={child}
                actions={rowActions}
              />
            ))}
          </section>
        )}

        {selection.count > 0 && (
          <BulkBar count={selection.count} busy={bulkBusy} onSave={bulkSave} onApplied={bulkApplied} onHide={bulkHide} onClear={selection.clear} />
        )}

        {!loading && !error && jobs.length === 0 && (
          <div className="state-block">
            <h3>{emptyTitle}</h3>
            <p>{emptyText}</p>
            <div className="actions-row">
              {muteOnly && <button type="button" onClick={() => setFilterValues({ muteView: '' })} className="btn">Back to your lists</button>}
              {!muteOnly && scope === 'match' && !trackedTab && <button type="button" onClick={() => setScope('all')} className="btn">Show all jobs</button>}
              {hasCustomFilters && <button type="button" onClick={clearAll} className="btn">Clear filters</button>}
              {filters.postedWithin && !trackedTab && <button type="button" onClick={showOlderJobs} className="btn">Show older jobs</button>}
            </div>
          </div>
        )}

        {loading && jobs.length > 0 && <div className="footer-note">Loading more…</div>}

        {!loading && hasMore && !error && (
          <div className="footer-note">
            <button type="button" className="btn" onClick={loadMore}>Load more</button>
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
            onClick={() => changeTab(value)}
            aria-pressed={tab === value}
          >
            <strong>{tabCounts[value] ?? '–'}</strong>
            <span>{label}</span>
          </button>
        ))}
        <SearchFilter variant="nav" filters={filters} facets={facets} onChange={setFilters} open={sheetOpen} onOpenChange={setSheetOpen} panel={false} />
      </nav>

      {selectedJob && (
        <JobDrawer
          job={selectedJob}
          profile={profile}
          position={{ index: currentIndex, total: totalCount, last: displayJobs.length - 1 }}
          onMove={moveSelection}
          onClose={closeDrawer}
          onApplied={toggleApplied}
          onHide={hideJob}
          onStatus={setJobStatus}
          onJobChange={noteChanged}
          onMuteCompany={muteCompany}
          onOpenJob={pushJobUrl}
          onToast={showToast}
          statusFocus={focusStatus}
        />
      )}

      {prompt && !promptAnswered && (
        <ReturnPrompt prompt={prompt} autoFocus={!selectedJob} onYes={() => answerPrompt(true)} onNo={() => answerPrompt(false)} />
      )}

      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}

      <Toast toast={toast} onUndo={runUndoStep} undoCount={undoCount} />
    </div>
  )
}
