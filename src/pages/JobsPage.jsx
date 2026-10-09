import { Fragment, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
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
import { ExpiringStrip } from '../components/list/ExpiringStrip'
import { ReturnPrompt } from '../components/list/ReturnPrompt'
import { ScopeMenu } from '../components/list/ScopeMenu'
import { StageChips } from '../components/list/StageChips'
import {
  APPLIED_TAB_FILTERS, MUTE_KINDS, PROFILE_ANCHORS, TOAST_REASONS, addChanges, adjustSummary, belongsToTab, bumpAppliedToday,
  hideChanges, hideKeys, negate, plural, statusChanges, statusFields, statusOf, statusPatch, summaryParams, swipeActions, todayKey,
} from '../components/list/listState'
import { api, onAccessDenied } from '../lib/api'
import { sessionUser } from '../lib/session'
import { useProfile } from '../hooks/useProfile'
import { useHotkeys } from '../hooks/useHotkeys'
import { useJobList } from '../hooks/useJobList'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { useReturnPrompt } from '../hooks/useReturnPrompt'
import { useSelection } from '../hooks/useSelection'
import { useToast } from '../hooks/useToast'
import { useUrlState } from '../hooks/useUrlState'
import { useVisit } from '../hooks/useVisit'
import {
  APPLIED_STATUSES, EMPLOYMENT_LABELS, MATCH_MIN_FIT, STRONG_FIT, WORK_MODE_LABELS, buildTrend, facetOptions, companyKey, isApplied,
  isTracked, jobUrl, statusLabel,
} from '../utils/gold'
import { dataFreshness, formatDate, isNewJob, parseDay, sinceLabel, staleBannerText } from '../utils/job'
import { DEFAULT_FILTERS, EMPTY_FILTERS, LIST_TABS, PANEL_KEYS, TAB_LABELS, defaultSortFor, sortAllowed } from '../utils/filters'
import { TRACKED_CSV_COLUMNS, downloadCsv, toCsv, trackedCsvFilename } from '../utils/csv'
import { PROFILE_LIMITS } from '../utils/entries'
import { skillCounts as countSkills } from '../utils/fit'
import { caughtUpText, endOfListText } from '../utils/schedule'
import {
  countOpenWithoutSwipe, readAutoAdvance, readExpiringCollapsed, readSwipePeekDone, readSwipeRightApplies, readSwipeTipShown,
  readSwipeUsed, readView, recordOpened, saveExpiringCollapsed, saveSwipePeekDone, saveSwipeTipShown, saveView,
} from '../utils/viewPref'

const TREND_WINDOW_DAYS = 14
const SEARCH_DEBOUNCE_MS = 350
const COUNTS_REFRESH_MS = 700 // after writes, the counters are re-read once things settle (rapid triage = one query)
const LOAD_AHEAD_ROWS = 5 // keyboard navigation loads the next page this many rows before the end
const AUTO_SYNC_CHECK_MS = 5 * 60_000 // how often an open, visible page checks for a new pipeline publish
const AUTO_REFRESH_MS = 60 * 60_000 // an open page also refetches data older than this (e.g. writes from another device)
const PEEK_MS = 1400 // the one-time swipe demo on the first row (the CSS animation takes about 1.2 s)
const SWIPE_TIP_OPENS = 5 // drawer opens without a swipe before the one-off swipe tip

// 'expiring' ("Expiring first") is offered on the Inbox only (sortAllowed)
const SORTS = [
  { value: 'fit', label: 'Best fit' },
  { value: 'recent', label: 'Newest posted' },
  { value: 'found', label: 'Recently found' },
  { value: 'applied', label: 'Applied date' },
  { value: 'expiring', label: 'Expiring first' },
]
const sortsFor = (tab) => SORTS.filter(option => sortAllowed(option.value, tab))

// Inbox · Saved · Applied (disjoint), keys 1-3
const TABS = LIST_TABS.map((value, index) => ({ value, label: TAB_LABELS[value], key: String(index + 1) }))

const isCoarse = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches)
const reducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

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
  minFit: 'Fit',
}

function chipValue(key, value) {
  if (key === 'minFit') return `${value}+`
  if (key === 'maxYears') return value === '0' ? 'Fresher' : `≤ ${value} yrs`
  if (key === 'workMode') return WORK_MODE_LABELS[value] || value
  if (key === 'employment') return EMPLOYMENT_LABELS[value] || value
  return value
}

// { title, text, action } for an empty list (action: 'muted' | 'clear' | 'older' | 'everything' | null). narrowed: filters
// are hiding jobs. caughtUp: the Inbox had jobs in this scope (or you triaged some today) and none is left.
function emptyMessage({ tab, narrowed, scope, postedWithin, muteOnly, caughtUp, expiring, rightApplies, triaged, appliedToday }) {
  if (muteOnly) return { title: 'No muted jobs here', text: 'Nothing in this view matches your mute rules.', action: 'muted' }
  if (!narrowed && tab === 'saved') {
    const how = rightApplies ? 'press s or tap the bookmark' : 'swipe right, press s or tap the bookmark'
    return { title: 'No saved jobs', text: `Save a job (${how}) to keep it after it would disappear.` }
  }
  if (!narrowed && tab === 'applied') {
    return { title: 'No applied jobs yet', text: 'Mark a job applied (press a or tap the check) to track it here.' }
  }
  if (narrowed) return { title: 'No matching jobs', text: 'Try removing a filter or switching tabs.', action: 'clear' }
  if (caughtUp) return { title: "You're caught up", text: caughtUpText({ triaged, applied: appliedToday }), caughtUp: true }
  if (postedWithin) {
    const e = Number(expiring) || 0
    return {
      title: postedWithin === '48' ? 'Nothing new in the last 2 days' : 'Nothing new in the last 24 hours',
      text: e > 0 ? `Older jobs are hidden (${e} disappear tonight).` : 'Older jobs are hidden.',
      action: 'older',
    }
  }
  if (scope === 'match') {
    return {
      title: 'No jobs for your roles yet',
      text: `Nothing in your roles with fit ${MATCH_MIN_FIT}+ right now. New jobs arrive with the next update (every ~4 hours).`,
      action: 'everything',
    }
  }
  return { title: 'No jobs yet', text: 'Jobs appear here after the next update (every ~4 hours).' }
}

export function JobsPage() {
  const navigate = useNavigate()
  // Back from Settings ("Back to jobs"): keyboard focus returns to the Settings button instead of <body>
  const fromSettings = useLocation().state?.from === 'settings'
  useEffect(() => {
    if (!fromSettings) return undefined
    const frame = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      document.querySelector('.topbar button[aria-label="Settings"]')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [fromSettings])
  const { profile, loading: profileLoading, error: profileError, save: saveProfile, addMuteRule, removeMuteRule } = useProfile()
  const {
    tab, sort, scope, filters, setTab, setSort, setScopeWindow, setFilters,
    jobKey: urlJobKey, openJob: pushJobUrl, closeJob: closeJobUrl, sheetOpen, setSheetOpen,
  } = useUrlState()
  // "No access yet" (ProtectedRoute shows its page); no pings for a user who is not allowed in
  const [accessDenied, setAccessDenied] = useState(false)
  useEffect(() => onAccessDenied(() => setAccessDenied(true)), [])
  // since: your last visit (ISO), undefined until known, null on a first visit; the new dots and "N new since …"
  const { since, recordOpen, recordPrompt } = useVisit({ enabled: Boolean(profile) && !accessDenied })
  const [searchInput, setSearchInput] = useState(filters.q)
  const [view, setView] = useState(readView)
  const [rightApplies] = useState(readSwipeRightApplies) // Settings → Account; the page remounts after Settings
  const {
    jobs, page, listKey, totalCount, hasMore, loading, refreshing, error,
    reload: reloadJobs, loadMore, retry, updateJob, leaveJob, leaving, sentinelRef,
  } = useJobList({ filters, scope, sort, tab })
  // Start from the cached counters (as the list does), so the header doesn't paint 0s and then widen to the real numbers
  const [summary, setSummary] = useState(() => api.cachedRows('summary', summaryParams(filters, scope, since))?.[0] || {})
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
  // The Expiring strip's rows (api.expiringJobs) and whether it is folded (per user, for the UTC day)
  const [expiringRows, setExpiringRows] = useState([])
  const [stripCollapsed, setStripCollapsed] = useState(() => readExpiringCollapsed())
  const [peekKey, setPeekKey] = useState(null) // the row showing the one-time swipe demo
  const expiringRequestRef = useRef(0)
  const stripRef = useRef(null)
  const scrollToStripRef = useRef(false)
  const pendingSortRef = useRef(null) // a sort to apply once the Inbox tab is on (the header's "new" metric)
  const peekWantedRef = useRef(null)
  const swipeTipRef = useRef(false) // the swipe tip is due when the drawer closes
  const peekTimersRef = useRef([])
  const [scrollTick, setScrollTick] = useState(0) // bumped to bring the Expiring strip into view
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

  const summaryArgs = useMemo(() => summaryParams(filters, scope, since), [filters, scope, since])
  useEffect(() => {
    filtersRef.current = summaryArgs
  }, [summaryArgs])

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

  const summaryKey = JSON.stringify(summaryArgs)
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

  // The Expiring strip: on the Inbox while jobs for you disappear tonight (not in the muted view, nor with the
  // "Expiring first" sort, where the list itself is that). The server ignores the time window, tab and scope for it.
  const muteOnly = filters.muteView === 'only'
  const stripWanted = tab === 'inbox' && !muteOnly && sort !== 'expiring' && Number(summary.expiring) > 0
  const expiringKey = JSON.stringify(summaryParams(filters, scope))
  const fetchExpiring = useCallback(async () => {
    const requestId = ++expiringRequestRef.current
    const isCurrent = () => requestId === expiringRequestRef.current
    try {
      const rows = await api.expiringJobs(JSON.parse(expiringKey), { onCached: cached => { if (isCurrent()) setExpiringRows(cached || []) } })
      if (isCurrent()) setExpiringRows(rows || [])
    } catch (err) {
      console.error('Failed to load the expiring jobs:', err)
    }
  }, [expiringKey])

  useEffect(() => {
    if (stripWanted) fetchExpiring()
  }, [stripWanted, fetchExpiring])

  // After a write: re-read the counters (and the strip) once the burst of writes settles
  const scheduleCounts = useCallback(() => {
    clearTimeout(countsTimerRef.current)
    countsTimerRef.current = setTimeout(() => {
      pageRef.current.fetchSummary()
      if (pageRef.current.stripWanted) pageRef.current.fetchExpiring()
    }, COUNTS_REFRESH_MS)
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
  // How often the listed jobs ask for each skill: the drawer's "Not in your profile" puts the common ones first
  const skillCounts = useMemo(() => countSkills(jobs), [jobs])
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
    setExpiringRows(prev => (prev.some(row => patches.has(row.job_key))
      ? prev.map(row => (patches.has(row.job_key) ? { ...row, ...patches.get(row.job_key) } : row))
      : prev))
  }, [updateJob])

  const patchJob = useCallback((jobKey, patch) => patchJobs(new Map([[jobKey, patch]])), [patchJobs])

  // The drawer's note / follow-up save: a note on an untracked job saves it, so the tab counts are re-read
  const noteChanged = useCallback((jobKey, patch) => {
    patchJob(jobKey, patch)
    if (patch && 'application_status' in patch) scheduleCounts()
  }, [patchJob, scheduleCounts])

  // Rows leave the screen (hidden, or no longer on this tab): list rows (with the exit animation), group postings,
  // expanded groups of departing representatives and the strip's rows
  const dropJobs = useCallback((keys) => {
    const drop = new Set(keys)
    const listed = new Set(pageRef.current.jobs.map(job => job.job_key))
    keys.forEach(key => { if (listed.has(key)) leaveJob(key) })
    setExpiringRows(prev => (prev.some(row => drop.has(row.job_key)) ? prev.filter(row => !drop.has(row.job_key)) : prev))
    setGroups(prev => {
      const next = {}
      for (const [key, group] of Object.entries(prev)) {
        if (drop.has(key)) continue
        next[key] = { ...group, rows: group.rows.filter(row => !drop.has(row.job_key)) }
      }
      return next
    })
  }, [leaveJob])

  const refreshLists = useCallback(() => {
    const { reloadJobs: reload, fetchSummary: summaryNow, fetchFacets: facetsNow, fetchExpiring: stripNow, stripWanted: strip } = pageRef.current
    reload()
    summaryNow()
    facetsNow()
    if (strip) stripNow() // a mute rule or a profile change also changes the Expiring strip
  }, [])

  // ---- opening and moving ----

  // A tap (or Enter) opens the details. On touch screens, the fifth open without ever swiping makes the swipe tip due
  // (shown when the drawer closes, once per device).
  const openJob = useCallback((job) => {
    scrollToActiveRef.current = false
    setActiveKey(job.job_key)
    setSelectedJob(job)
    pushJobUrl(job.job_key)
    recordOpen()
    if (isCoarse() && !readSwipeTipShown() && countOpenWithoutSwipe() >= SWIPE_TIP_OPENS) swipeTipRef.current = true
  }, [pushJobUrl, recordOpen])

  const closeDrawer = useCallback(() => {
    setSelectedJob(null)
    closeJobUrl()
    // Not over another toast (its Undo stays on screen): then the tip waits for a later close
    if (swipeTipRef.current && pageRef.current.tab === 'inbox' && !pageRef.current.toast && !readSwipeTipShown() && !readSwipeUsed()) {
      swipeTipRef.current = false
      saveSwipeTipShown()
      const right = readSwipeRightApplies() ? 'mark it applied' : 'save it'
      pageRef.current.showToast(`Tip: swipe a job right to ${right}, left to hide it`)
    }
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
      if (open.job_key !== job.job_key) recordOpen()
      setSelectedJob(job)
      pushJobUrl(job.job_key)
      const ahead = list[next + 1]
      if (ahead) api.prefetchJob(ahead.job_key)
    }
    if (more && !busy && next >= list.length - LOAD_AHEAD_ROWS) pageRef.current.loadMore()
    return job
  }, [pushJobUrl, recordOpen])

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

  // The highlight (and an open drawer) moves on to the next job that stays when the rows of `gone` leave the list. A job
  // opened from a link may not be in the list: then the drawer just closes.
  const stepOff = useCallback((gone) => {
    const { displayJobs: shown, currentKey: current } = pageRef.current
    if (!current || !gone.has(current)) return
    const index = shown.findIndex(job => job.job_key === current)
    const neighbour = index < 0 ? null : shown.slice(index + 1).find(job => !gone.has(job.job_key))
      || shown.slice(0, index).reverse().find(job => !gone.has(job.job_key)) || null
    scrollToActiveRef.current = true
    setActiveKey(neighbour?.job_key ?? null)
    // Keyboard focus on the departing row (or one of its buttons) goes on to the next row, not back to the page top
    const focusedRow = document.activeElement?.closest?.('[data-job-key]')
    if (neighbour && focusedRow && gone.has(focusedRow.dataset.jobKey)) {
      requestAnimationFrame(() => document.querySelector(`[data-job-key="${CSS.escape(neighbour.job_key)}"]`)?.focus({ preventScroll: true }))
    }
    if (pageRef.current.selectedJob) {
      if (neighbour) {
        setSelectedJob(neighbour)
        pushJobUrl(neighbour.job_key)
      } else {
        closeDrawer()
      }
    }
  }, [closeDrawer, pushJobUrl])

  // Sets status on jobs (optimistic), with one undo that puts each job back to its own previous status. Rows that no
  // longer belong on this tab (Inbox = untracked, Saved, Applied) leave the list, unless the drawer is open (its job
  // stays where it is until the list is read again).
  const changeStatus = useCallback(async (list, status, { message, tone } = {}) => {
    const targets = list.filter(job => statusOf(job) !== status)
    if (!targets.length) return false
    const { since: visitSince, postedWithin, tab: currentTab, jobs: listed, selectedJob: open } = pageRef.current
    const now = new Date().toISOString()
    const before = new Map(targets.map(job => [job.job_key, statusFields(job)]))
    const changes = targets.reduce((total, job) => addChanges(total, statusChanges(job, status, visitSince, postedWithin)), {})
    const appliedDelta = targets.filter(job => APPLIED_STATUSES.includes(status) !== isApplied(job))
      .reduce((sum, job) => sum + (APPLIED_STATUSES.includes(status) ? 1 : String(job.applied_at || '').slice(0, 10) === todayKey() ? -1 : 0), 0)
    const keys = targets.map(job => job.job_key)
    const patches = new Map(targets.map(job => [job.job_key, statusPatch(job, status, now)]))
    const onList = new Set(listed.map(job => job.job_key))
    const left = open ? [] : targets.filter(job => onList.has(job.job_key) && !belongsToTab({ ...job, ...patches.get(job.job_key) }, currentTab))
      .map(job => job.job_key)
    patchJobs(patches)
    setSummary(prev => adjustSummary(prev, changes))
    if (appliedDelta) setTrendRows(prev => bumpAppliedToday(prev || [], appliedDelta))
    if (left.length) {
      stepOff(new Set(left))
      dropJobs(left)
    }

    const restore = () => {
      patchJobs(before)
      setSummary(prev => adjustSummary(prev, negate(changes)))
      if (appliedDelta) setTrendRows(prev => bumpAppliedToday(prev || [], -appliedDelta))
    }
    try {
      await api.setStatus(keys.length === 1 ? keys[0] : keys, status)
    } catch (err) {
      restore()
      if (left.length) pageRef.current.reloadJobs() // the rows that left come back from the server
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
        // The rows that left the list come back (also the ones that left when the drawer closed)
        const listedNow = new Set(pageRef.current.jobs.map(job => job.job_key))
        if (left.length || keys.some(key => onList.has(key) && !listedNow.has(key))) pageRef.current.reloadJobs()
      } catch (err) {
        pageRef.current.reloadJobs() // the rows were put back on screen only: show what the server has
        throw err
      } finally {
        pageRef.current.scheduleCounts()
      }
    }, tone)
    scheduleCounts()
    return true
  }, [patchJobs, dropJobs, stepOff, showToast, scheduleCounts])

  const toggleApplied = useCallback((job, applied) => {
    if (applied) advanceFrom(job)
    return changeStatus([job], applied ? 'applied' : 'not_applied', {
      message: applied ? 'Marked applied' : 'Applied undone',
      tone: applied ? 'success' : undefined,
    })
  }, [advanceFrom, changeStatus])

  const toggleSaved = useCallback((job) => {
    if (isApplied(job)) {
      showToast('Already applied')
      return
    }
    const saved = statusOf(job) === 'saved'
    changeStatus([job], saved ? 'not_applied' : 'saved', saved ? { message: 'Unsaved' } : { message: 'Saved', tone: 'primary' })
  }, [changeStatus, showToast])

  // The status picker (rows, drawer), the drawer's Save button and its AgeNotice stages
  const setJobStatus = useCallback((job, status) => {
    const was = statusOf(job)
    let message
    let tone
    if (status === 'saved' && !isApplied(job)) [message, tone] = ['Saved', 'primary']
    else if (status === 'not_applied' && was === 'saved') message = 'Unsaved'
    else if (status === 'not_applied') message = 'Applied undone'
    else if (status === 'applied' && !isApplied(job)) [message, tone] = ['Marked applied', 'success']
    return changeStatus([job], status, { message, tone })
  }, [changeStatus])

  // A swipe on a row: what it does depends on the tab (listState swipeActions; Settings → Account can make an Inbox
  // swipe right mark applied instead of saving)
  const swipeJob = useCallback((job, direction) => {
    const plan = swipeActions(job, pageRef.current.tab, readSwipeRightApplies())[direction]
    if (!plan) return
    swipeTipRef.current = false // you know the swipes: no tip
    if (plan.action === 'save') changeStatus([job], 'saved', { message: 'Saved', tone: 'primary' })
    else if (plan.action === 'applied') toggleApplied(job, true)
    else if (plan.action === 'unsave') changeStatus([job], 'not_applied', { message: 'Unsaved' })
    else if (plan.action === 'stage') changeStatus([job], plan.status, { message: `Moved to ${statusLabel(plan.status)}`, tone: 'success' })
    else if (plan.action === 'hide') pageRef.current.hideJob(job)
  }, [changeStatus, toggleApplied])

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
    showToast(`Unmuted ${job.muted_value}`, async () => {
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
    const { groups: open } = pageRef.current
    const keys = [...new Set(list.flatMap(job => hideKeys(job, open[job.job_key]?.status === 'expanded')))]
    if (!keys.length) return
    const gone = new Set(keys)
    const reloadAfter = list.some(job => open[job.job_key]?.status === 'expanded') // its group needs a new representative
    stepOff(gone)
    dropJobs(keys)
    // The Inbox counters drop at once (a group counts once: its representative is the judged job)
    setSummary(prev => adjustSummary(prev, hideChanges(list.filter(job => gone.has(job.job_key)), pageRef.current.since, pageRef.current.postedWithin)))
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
      scheduleCounts()
      return
    }
    if (reloadAfter) pageRef.current.reloadJobs()
    scheduleCounts()

    const first = list[0]
    // One lever after a reason, when it fits a single job: a mute rule, or the profile field to fix
    const leverFor = (value) => {
      if (list.length !== 1) return null
      if (value === 'too_senior' && first.experience_level) {
        return { label: `Mute ${first.experience_level} jobs?`, onClick: () => pageRef.current.addRule('levels', first.experience_level, `${first.experience_level} jobs`) }
      }
      if (value === 'company' && first.company_name) {
        return { label: `Mute ${first.company_name}?`, onClick: () => pageRef.current.addRule('companies', first.company_name, first.company_name) }
      }
      if (value === 'wrong_role') return { label: 'Edit my roles', onClick: () => navigate(PROFILE_ANCHORS.roles) }
      if (value === 'location') return { label: 'Set My cities', onClick: () => navigate(PROFILE_ANCHORS.cities) }
      return null
    }
    const giveReason = async (value) => {
      try {
        await api.setHidden(judged.length ? judgedTarget : target, true, value)
      } catch (err) {
        showToast(`Could not save the reason: ${err.message}`)
        return
      }
      const lever = leverFor(value)
      showToast('Saved as feedback', undefined, undefined, lever ? [lever] : undefined, { offerUndo: true })
    }
    const several = keys.length === 1 ? '' : ` ${plural(keys.length, 'posting')}`
    const message = reason ? `Hidden${several}` : `Hidden${several}. Why? (optional)`
    showToast(message, async () => {
      try {
        await api.setHidden(target, false)
      } finally {
        pageRef.current.refreshLists()
      }
    }, 'danger', reason ? undefined : TOAST_REASONS.map(item => ({ label: item.label, onClick: () => giveReason(item.value) })))
  }, [dropJobs, navigate, stepOff, scheduleCounts, showToast])

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
    await changeStatus(targets, 'saved', { message: `Saved ${plural(targets.length, 'job')}`, tone: 'primary' })
  }), [runBulk, changeStatus, showToast])

  const bulkApplied = useCallback(() => runBulk(async (list) => {
    const targets = list.filter(job => !isApplied(job))
    if (!targets.length) {
      showToast('Already applied')
      return
    }
    await changeStatus(targets, 'applied', { message: `Marked ${plural(targets.length, 'job')} applied`, tone: 'success' })
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
    swipe: (job, direction) => pageRef.current.swipeJob(job, direction),
    status: (job, next) => pageRef.current.setJobStatus(job, next),
    select: (job, options) => pageRef.current.selectJob(job, options),
    toggleGroup: job => pageRef.current.toggleGroup(job),
    unmute: job => pageRef.current.unmute(job),
    opened: job => recordOpened(job),
    focus: job => setActiveKey(job.job_key), // Tab onto a row: s / a / x / t then act on that row
    peekDone: () => setPeekKey(null),
  }), [])

  // ---- apply on return (#8) ----

  const trackedState = useCallback((key) => {
    const job = pageRef.current.displayJobs?.find(item => item.job_key === key)
    return job ? isTracked(job) : undefined
  }, [])
  const { prompt, answer } = useReturnPrompt({ trackedState, enabled: Boolean(profile) })

  // reply: 'yes' (Yes, applied), 'saved' (Save for later) or 'no' (Not yet); each answer is counted with the next ping
  const answerPrompt = useCallback((reply) => {
    const asked = prompt
    answer()
    if (!asked) return
    recordPrompt(reply)
    if (reply === 'no') return
    const { displayJobs: shown, selectedJob: open } = pageRef.current
    const known = (open?.job_key === asked.job_key ? open : null) || shown.find(job => job.job_key === asked.job_key)
    const job = known || { ...asked, application_status: 'not_applied', is_applied: false }
    if (reply === 'yes') toggleApplied(job, true)
    else changeStatus([job], 'saved', { message: 'Saved', tone: 'primary' })
  }, [prompt, answer, recordPrompt, toggleApplied, changeStatus])

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
      recordOpen()
      return undefined
    }
    let cancelled = false
    api.jobRow(urlJobKey)
      .then((row) => {
        if (cancelled) return
        if (row) {
          setActiveKey(urlJobKey)
          setSelectedJob(row)
          recordOpen()
        } else {
          showToast("This job has disappeared. Jobs you haven't saved disappear 2 days after posting.")
          closeJobUrl()
        }
      })
      .catch((err) => {
        if (cancelled) return
        showToast(`Could not open the job: ${err.message}`)
        closeJobUrl()
      })
    return () => { cancelled = true }
  }, [urlJobKey, closeJobUrl, showToast, recordOpen])

  // The open job scored again after a profile change (the lists reload on their own). jobRow has no group, so the
  // list's dup_count / dup_keys / dup_locations are kept
  const rescoreOpenJob = useCallback(async () => {
    pageRef.current.refreshLists()
    const key = pageRef.current.selectedJob?.job_key
    if (!key) return
    const row = await api.jobRow(key).catch(() => null)
    if (!row) return
    setSelectedJob(prev => (prev?.job_key === row.job_key
      ? { ...prev, ...row, dup_count: prev.dup_count, dup_keys: prev.dup_keys, dup_locations: prev.dup_locations, total_count: prev.total_count }
      : prev))
  }, [])

  // The drawer's "+ I know this": the skill joins Also know (with Undo) and the job is scored again
  const knowSkill = useCallback(async (skill) => {
    const current = Array.isArray(profile?.also_skills) ? profile.also_skills : []
    if (current.length >= PROFILE_LIMITS.alsoSkills) {
      showToast(`Also know is full (${PROFILE_LIMITS.alsoSkills}). Remove one in Settings → Profile`)
      return false
    }
    if (current.some(item => String(item).toLowerCase() === String(skill).toLowerCase())) return true
    // saveProfile replaces roles, skills and years (only also_skills / preferred_cities left out are kept): send them all
    const withAlso = also_skills => ({
      target_roles: profile?.target_roles || [],
      skills: profile?.skills || [],
      also_skills,
      min_years: profile?.min_years ?? null,
      max_years: profile?.max_years ?? null,
      preferred_cities: profile?.preferred_cities || [],
    })
    try {
      await saveProfile(withAlso([...current, skill]))
    } catch (err) {
      showToast(`Could not add ${skill}: ${err.message}`)
      return false
    }
    await rescoreOpenJob()
    showToast(`Added ${skill} to Also know`, async () => {
      await saveProfile(withAlso(current))
      await rescoreOpenJob()
    })
    return true
  }, [profile, saveProfile, rescoreOpenJob, showToast])

  // The AgeNotice's "No reply yet": the follow-up date moves (the note is kept), with Undo
  const snoozeJob = useCallback(async (job, nextActionAt) => {
    const before = { next_action_at: job.next_action_at ?? null, follow_up: Boolean(job.follow_up) }
    patchJob(job.job_key, { next_action_at: nextActionAt, follow_up: false })
    try {
      const row = await api.snoozeFollowUp(job.job_key, nextActionAt)
      if (row && 'next_action_at' in row) patchJob(job.job_key, { next_action_at: row.next_action_at })
    } catch (err) {
      patchJob(job.job_key, before)
      showToast(`Could not save the date: ${err.message}`)
      return
    }
    scheduleCounts()
    showToast(`OK. We'll ask again on ${formatDate(parseDay(nextActionAt)) || nextActionAt}`, async () => {
      await api.snoozeFollowUp(job.job_key, before.next_action_at)
      patchJob(job.job_key, before)
      pageRef.current.scheduleCounts()
    })
  }, [patchJob, scheduleCounts, showToast])

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
    if (stripWanted) fetchExpiring()
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
  // Opens the search bar (sticky under the top bar on phones) without scrolling the list
  const openSearch = () => {
    setSearchOpen(true)
    requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }))
  }
  // The bottom bar's Search: opens the bar, closes an empty one; with text in it (the bar stays) it focuses the box
  const toggleSearch = () => (searchVisible && !searchInput ? setSearchOpen(false) : openSearch())

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
  // A key the server does not send yet (an older API) also reads '–'
  const summaryReady = summary.total !== undefined && summary.total !== null
  const count = (key) => (summaryReady && summary[key] !== undefined && summary[key] !== null ? Number(summary[key]) : null)
  const tabCounts = { inbox: count('inbox'), saved: count('saved'), applied: count('applied') }
  const mutedCount = count('muted') || 0
  const staleText = staleBannerText(freshness)

  const toggleFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: prev[key] === value ? EMPTY_FILTERS[key] : value }))
  const setFilterValues = (patch) => setFilters(prev => ({ ...prev, ...patch }))
  const clearFilter = (key) => {
    if (key === 'q') setSearchInput('')
    setFilters(prev => ({ ...prev, [key]: EMPTY_FILTERS[key] }))
  }
  // Reset keeps the scope menu's choice (scope and time window are a view, not a filter)
  const clearAll = () => {
    setSearchInput('')
    setFilters(prev => ({ ...DEFAULT_FILTERS, postedWithin: prev.postedWithin }))
  }
  const scopeValue = { scope, postedWithin: filters.postedWithin }

  // "12 new since 9:51 AM" once your last visit is known; else "4 expire tonight" while some do
  const appliedToday = trendRows ? trend[trend.length - 1]?.applied ?? 0 : null
  const sinceText = typeof since === 'string' ? sinceLabel(since) : null
  const newSince = count('new_since')
  const expiringCount = count('expiring')
  const leadMetric = sinceText && newSince > 0
    ? { key: 'new', label: `new since ${sinceText}`, value: newSince, tone: 'success', title: 'Found since your last visit. Tap to sort by Recently found', active: tab === 'inbox' && sort === 'found' }
    : expiringCount > 0
      ? { key: 'expiring', label: 'expire tonight', value: expiringCount, tone: 'warning', title: 'Jobs for you that disappear tonight. Tap to see them', active: undefined }
      : sinceText
        ? { key: 'new', label: `new since ${sinceText}`, value: newSince, tone: 'success', title: 'Found since your last visit. Tap to sort by Recently found', active: tab === 'inbox' && sort === 'found' }
        : null
  const metricItems = [
    ...(leadMetric ? [leadMetric] : []),
    { key: 'strong', label: 'strong fit', value: count('inbox_strong'), tone: 'accent', title: `Fit ${STRONG_FIT}+ in your Inbox. Tap to filter`, active: tab === 'inbox' && filters.minFit === String(STRONG_FIT) },
    { key: 'appliedToday', label: 'applied today', value: appliedToday, tone: 'info', title: 'Tap to switch between your applied jobs and the Inbox', active: tab === 'applied' },
  ]
  const onMetric = (key) => {
    if (key === 'new') {
      if (tab === 'inbox') setSort(sort === 'found' ? defaultSortFor(tab) : 'found')
      else {
        pendingSortRef.current = 'found'
        changeTab('inbox')
      }
    }
    if (key === 'strong') {
      if (tab === 'inbox') toggleFilter('minFit', String(STRONG_FIT))
      else {
        changeTab('inbox')
        setFilterValues({ minFit: String(STRONG_FIT) })
      }
    }
    if (key === 'expiring') {
      if (tab !== 'inbox') changeTab('inbox')
      if (muteOnly) setFilterValues({ muteView: '' })
      if (sort === 'expiring') {
        window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
        return
      }
      setStripCollapsed(false)
      saveExpiringCollapsed(false)
      scrollToStripRef.current = true
      setScrollTick(value => value + 1)
    }
    if (key === 'appliedToday') changeTab(tab === 'applied' ? 'inbox' : 'applied')
  }

  const hasMaxYears = profile?.max_years !== null && profile?.max_years !== undefined
  const cities = profile?.preferred_cities || []
  const coreSkills = profile?.skills || []
  const quickChips = [
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
      jobs, displayJobs, groups, selectedJob, currentKey, currentIndex, hasMore, loading, selectedJobs, selection, tab, since,
      postedWithin: filters.postedWithin, toast,
      stripWanted, loadMore, reloadJobs, fetchSummary, fetchFacets, fetchExpiring, scheduleCounts, refreshLists, showToast,
      openJob, toggleApplied, toggleSaved, hideJob, swipeJob, setJobStatus, selectJob, toggleGroup, unmute, addRule,
    })
  })

  // The header's "new" metric from another tab: the Inbox opens sorted by Recently found
  useEffect(() => {
    if (tab !== 'inbox' || !pendingSortRef.current) return
    const next = pendingSortRef.current
    pendingSortRef.current = null
    setSort(next)
  }, [tab, setSort])

  // The one-time swipe demo: the first Inbox row on a touch screen, once per device (skipped under "reduce motion")
  useEffect(() => {
    if (peekWantedRef.current === null) peekWantedRef.current = isCoarse() && !reducedMotion() && !readSwipePeekDone()
    if (!peekWantedRef.current || tab !== 'inbox' || loading || !jobs.length) return
    peekWantedRef.current = false
    saveSwipePeekDone()
    const key = jobs[0].job_key
    peekTimersRef.current = [
      setTimeout(() => setPeekKey(key), 600), // after the list has settled
      setTimeout(() => setPeekKey(prev => (prev === key ? null : prev)), 600 + PEEK_MS),
    ]
  }, [tab, loading, jobs])

  useEffect(() => () => peekTimersRef.current.forEach(clearTimeout), [])

  // Rows changed while the drawer was open stay in place until it closes (stable j / k); then the ones that no longer
  // belong on this tab (e.g. saved on the Inbox) leave, and the highlight moves on
  const drawerOpenRef = useRef(false)
  useEffect(() => {
    if (selectedJob) {
      drawerOpenRef.current = true
      return
    }
    if (!drawerOpenRef.current) return
    drawerOpenRef.current = false
    const { jobs: listed, tab: current } = pageRef.current
    const stale = listed.filter(job => !belongsToTab(job, current)).map(job => job.job_key)
    if (!stale.length) return
    stepOff(new Set(stale))
    dropJobs(stale)
  }, [selectedJob, stepOff, dropJobs])

  // "expire tonight" tapped: the strip comes into view once it is on screen
  useEffect(() => {
    if (!scrollToStripRef.current || !stripRef.current) return
    scrollToStripRef.current = false
    stripRef.current.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [scrollTick, stripWanted, expiringRows])

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

  // The "Did you apply?" prompt takes a / s while it is about the job in front of you (or no drawer is open)
  const promptOpen = Boolean(prompt && !promptAnswered && (!selectedJob || selectedJob.job_key === prompt.job_key))

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
        if (promptOpen) return answerPrompt('yes')
        if (selection.count && !selectedJob) return bulkApplied()
        if (!currentJob) return false
        toggleApplied(currentJob, !isApplied(currentJob))
      },
      s: () => {
        if (promptOpen) return answerPrompt('saved')
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
        if (prompt) return answerPrompt('no')
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
  // Caught up: the Inbox had jobs in this scope (or you triaged some today) and none is left to look at
  const caughtUp = tab === 'inbox' && (Number(summary.total) > 0 || Number(summary.triaged_today) > 0)
  const empty = emptyMessage({
    tab, narrowed: hasCustomFilters, scope, postedWithin: sort === 'expiring' ? '' : filters.postedWithin, muteOnly, caughtUp, expiring: summary.expiring,
    rightApplies, triaged: summary.triaged_today, appliedToday,
  })
  const selecting = selectMode || selection.count > 0
  const stripRows = useMemo(() => expiringRows.filter(job => !isTracked(job) && !job.is_hidden), [expiringRows])
  const showStrip = stripWanted && (stripRows.length > 0 || stripCollapsed)
  const sorts = sortsFor(tab)

  // "12 new since your last visit" between the last new row and the first older one (Recently found sort only)
  const dividerKey = useMemo(() => {
    if (sort !== 'found' || typeof since !== 'string') return null
    let sawNew = false
    for (const { job, child } of displayRows) {
      if (child) continue
      if (isNewJob(job, since)) sawNew = true
      else return sawNew ? job.job_key : null
    }
    return null
  }, [sort, since, displayRows])
  const dividerCount = newSince ?? displayRows.filter(row => !row.child && isNewJob(row.job, since)).length

  // Phone landscape has no room for these above the list: they move to the top of the Filters sheet (CSS)
  const freshnessNote = (className = '') => freshness && (
    <span className={`data-freshness ${freshness.stale ? 'stale' : ''} ${className}`} title={freshness.title}>{freshness.label}</span>
  )
  const stageChips = tab === 'applied' && (
    <StageChips summary={summary} filters={filters} onChange={setFilterValues} onExport={exportCsv} exporting={exporting} />
  )
  const sheetExtra = (stageChips || freshness) ? <>{stageChips}{freshnessNote()}</> : null

  return (
    <div className={`page-shell ${selection.count ? 'has-bulk' : ''}`}>
      <Header
        metrics={metrics}
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

        {staleText && <div className="hint-banner stale-banner" role="status">{staleText}</div>}

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
              enterKeyHint="search"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              placeholder="Search title, company, role or skill (-word to exclude)"
              aria-label="Search jobs"
            />
            {!searchInput && <kbd className="search-kbd" aria-hidden="true">/</kbd>}
          </label>
          <SearchFilter
            filters={filters}
            facets={facets}
            onChange={setFilters}
            sorts={sorts}
            sort={sort}
            onSortChange={setSort}
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            extra={sheetExtra}
          />
          <select className="sort-select" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort jobs">
            {sorts.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
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
          {tab === 'inbox' && <ScopeMenu value={scopeValue} onChange={setScopeWindow} />}
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
              title="Jobs your mute rules leave out (Settings → Mute rules)"
            >
              {muteOnly ? `Showing ${mutedCount} muted · Back` : `${mutedCount} muted · Show`}
            </button>
          )}
          {(hasCustomFilters || muteOnly) && (
            <button type="button" className="text-button" onClick={clearAll}>Reset</button>
          )}
          {!error && jobs.length > 0 && (
            <span className="result-count" aria-live="polite">
              {jobs.length} of {totalCount}
              {(refreshing || (loading && page === 0)) && <span className="updating"> · updating…</span>}
            </span>
          )}
          {freshnessNote('on-page')}
        </section>

        {stageChips && <div className="on-page">{stageChips}</div>}

        {showStrip && (
          <ExpiringStrip
            ref={stripRef}
            count={summary.expiring}
            strong={summary.expiring_strong}
            rows={stripRows}
            collapsed={stripCollapsed}
            busy={bulkBusy}
            onToggle={() => {
              saveExpiringCollapsed(!stripCollapsed)
              setStripCollapsed(!stripCollapsed)
            }}
            onOpen={openJob}
            onSave={job => changeStatus([job], 'saved', { message: 'Saved', tone: 'primary' })}
            onApplied={job => toggleApplied(job, true)}
            onHide={hideJob}
            onSaveAll={rows => changeStatus(rows, 'saved', { message: `Saved ${plural(rows.length, 'job')}`, tone: 'primary' })}
          />
        )}

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
              <Fragment key={job.job_key}>
                {job.job_key === dividerKey && (
                  <div className="new-divider grid-span">{dividerCount} new since your last visit</div>
                )}
                <ItemComponent
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
                  since={since}
                  tab={tab}
                  rightApplies={rightApplies}
                  peek={job.job_key === peekKey}
                  leaving={leaving.has(job.job_key)}
                />
              </Fragment>
            ))}
          </section>
        )}
        {/* Auto-load: the next page comes when this gets within 1200 px of the screen (Load more below stays) */}
        {jobs.length > 0 && hasMore && <div ref={sentinelRef} className="list-sentinel" aria-hidden="true" />}

        {/* Stays mounted so the first "1 selected" is read out too (BulkBar mounts with its count) */}
        <span className="sr-only" aria-live="polite">{selection.count > 0 ? `${selection.count} selected` : ''}</span>
        {selection.count > 0 && (
          <BulkBar count={selection.count} busy={bulkBusy} onSave={bulkSave} onApplied={bulkApplied} onHide={bulkHide} onClear={selection.clear} />
        )}

        {!loading && !error && jobs.length === 0 && (
          <div className={`state-block ${empty.caughtUp ? 'caught-up' : ''}`} role="status">
            <h3>{empty.title}</h3>
            <p>{empty.text}</p>
            {empty.action && (
              <div className="actions-row">
                {empty.action === 'muted' && <button type="button" onClick={() => setFilterValues({ muteView: '' })} className="btn">Back to your lists</button>}
                {empty.action === 'clear' && <button type="button" onClick={clearAll} className="btn">Clear filters</button>}
                {empty.action === 'older' && (
                  <button type="button" onClick={() => setScopeWindow({ scope, postedWithin: '' })} className="btn">Show them</button>
                )}
                {empty.action === 'everything' && (
                  <button type="button" onClick={() => setScopeWindow({ scope: 'all', postedWithin: '' })} className="btn">Show everything</button>
                )}
              </div>
            )}
          </div>
        )}

        {loading && jobs.length > 0 && <div className="footer-note">Loading more…</div>}

        {!loading && hasMore && !error && (
          <div className="footer-note">
            <button type="button" className="btn" onClick={loadMore}>Load more</button>
          </div>
        )}

        {!loading && !hasMore && !error && jobs.length > 0 && (tab === 'inbox' || jobs.length >= 10) && (
          <div className="footer-note">{endOfListText(jobs.length, tab)}</div>
        )}

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
        <button type="button" className={`nav-item ${searchVisible ? 'active' : ''}`} onClick={toggleSearch} aria-pressed={searchVisible} title="Search (/)">
          <strong><SearchIcon /></strong>
          <span>Search</span>
        </button>
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
          onKnowSkill={knowSkill}
          onSnooze={snoozeJob}
          isAdmin={Boolean(sessionUser()?.isAdmin)}
          since={since}
          statusFocus={focusStatus}
          skillCounts={skillCounts}
        />
      )}

      {prompt && !promptAnswered && (
        <ReturnPrompt
          prompt={prompt}
          autoFocus={!selectedJob}
          onYes={() => answerPrompt('yes')}
          onSave={() => answerPrompt('saved')}
          onNo={() => answerPrompt('no')}
        />
      )}

      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}

      <Toast toast={toast} onUndo={runUndoStep} undoCount={undoCount} />
    </div>
  )
}
