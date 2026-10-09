import { sessionUser } from '../lib/session.js'
import { DEFAULT_TAB, FRESH_HOURS, POSTED_OPTIONS, SCOPES, defaultSortFor, normalizeTab, sortAllowed } from './filters.js'

// Job list preferences remembered on this device. Storage can be unavailable: the choice just isn't remembered.
function read(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // storage unavailable
  }
}

const user = () => sessionUser()?.id || 'anon'

// Layout ('list' | 'grid'), per device
const VIEW_KEY = 'jobseeker.view'

export const readView = () => (read(VIEW_KEY) === 'grid' ? 'grid' : 'list')
export const saveView = (view) => save(VIEW_KEY, view)

// Scope ('match' = "For you" | 'all'), per user on this device
const scopeKey = () => `jobseeker:scope:${user()}`

export const readScope = () => (read(scopeKey()) === 'all' ? 'all' : 'match')
export const saveScope = (scope) => save(scopeKey(), scope)

// Time window of the Inbox (filters.postedWithin: '24' | '48' | '' = any date), per user on this device. The scope menu
// sets it together with the scope, so "Everything · any date" opens as it was left; nothing stored = the last 24 hours.
const windowKey = () => `jobseeker:window:${user()}`
const POSTED_VALUES = new Set(POSTED_OPTIONS.map(option => option.value))

export const readWindow = () => {
  const value = read(windowKey())
  if (value === 'any') return ''
  return POSTED_VALUES.has(value) ? value : FRESH_HOURS
}
export const saveWindow = (postedWithin) => {
  const value = String(postedWithin ?? '')
  if (!value || POSTED_VALUES.has(value)) save(windowKey(), value || 'any')
}

// Both at once (the scope menu)
export function saveScopeWindow({ scope, postedWithin }) {
  if (SCOPES.includes(scope)) saveScope(scope)
  saveWindow(postedWithin)
}

// Tab ('inbox' | 'saved' | 'applied'), per user on this device; new visits open the Inbox. A tab stored by an older
// version ('pending' = To apply, 'all') reads as 'inbox'.
const tabKey = () => `jobseeker:tab:${user()}`

export const readTab = () => normalizeTab(read(tabKey())) ?? DEFAULT_TAB
export const saveTab = (tab) => save(tabKey(), tab)

// Sort per tab, per user on this device (Applied opens with Applied date, the others with Best fit). The Inbox takes over
// the sort remembered for To apply ('pending') the first time it is read.
const sortKey = (tab) => `jobseeker:sort:${user()}:${tab}`

export const readSort = (tab) => {
  let sort = read(sortKey(tab))
  if (sort === null && tab === 'inbox') {
    sort = read(sortKey('pending'))
    if (sortAllowed(sort, tab)) save(sortKey(tab), sort)
  }
  return sortAllowed(sort, tab) ? sort : defaultSortFor(tab)
}
export const saveSort = (tab, sort) => save(sortKey(tab), sort)

// What a URL without tab / scope / posted / sort means (urlState.js)
export const rememberedListState = () => ({ tab: readTab(), scope: readScope(), postedWithin: readWindow(), sortFor: readSort })

// Move to the next job after marking one applied (Settings → Account), per device, on by default
const AUTO_ADVANCE_KEY = 'jobseeker.autoAdvance'

export const readAutoAdvance = () => read(AUTO_ADVANCE_KEY) !== '0'
export const saveAutoAdvance = (on) => save(AUTO_ADVANCE_KEY, on ? '1' : '0')

// Inbox swipe right marks applied instead of saving (Settings → Account), per device, off by default
const SWIPE_RIGHT_APPLIES_KEY = 'jobseeker.swipeRightApplies'

export const readSwipeRightApplies = () => read(SWIPE_RIGHT_APPLIES_KEY) === '1'
export const saveSwipeRightApplies = (on) => save(SWIPE_RIGHT_APPLIES_KEY, on ? '1' : '0')

// Touch onboarding, per device: the one-time peek animation of the first row (the key of the old swipe hint banner, so
// whoever saw the banner skips the peek), drawer opens without a committed swipe, and the one-off tip toast
const SWIPE_PEEK_KEY = 'jobseeker.swipeHintSeen'
const OPENS_WITHOUT_SWIPE_KEY = 'jobseeker.opensWithoutSwipe'
const SWIPE_USED_KEY = 'jobseeker.swipeUsed'
const SWIPE_TIP_KEY = 'jobseeker.swipeTipShown'
let opensWithoutSwipe = 0 // memory copy when storage is unavailable
let swipeUsed = false

export const readSwipePeekDone = () => read(SWIPE_PEEK_KEY) === '1'
export const saveSwipePeekDone = () => save(SWIPE_PEEK_KEY, '1')

// A drawer opened without a swipe -> the new count; 0 from the first committed swipe on, for good
export function countOpenWithoutSwipe() {
  if (readSwipeUsed()) return 0
  const stored = Number(read(OPENS_WITHOUT_SWIPE_KEY))
  const count = Math.max(Number.isInteger(stored) && stored > 0 ? stored : 0, opensWithoutSwipe) + 1
  opensWithoutSwipe = count
  save(OPENS_WITHOUT_SWIPE_KEY, String(count))
  return count
}

export const readSwipeUsed = () => swipeUsed || read(SWIPE_USED_KEY) === '1'

export function markSwipeUsed() {
  swipeUsed = true
  opensWithoutSwipe = 0
  save(SWIPE_USED_KEY, '1')
  remove(OPENS_WITHOUT_SWIPE_KEY)
}

export const readSwipeTipShown = () => read(SWIPE_TIP_KEY) === '1'
export const saveSwipeTipShown = () => save(SWIPE_TIP_KEY, '1')

// The Expiring strip collapsed, per user on this device, for the rest of the UTC day (the day those jobs disappear)
const expiringKey = () => `jobseeker:expiringCollapsed:${user()}`
const utcToday = (now) => new Date(now).toISOString().slice(0, 10)

export const readExpiringCollapsed = (now = Date.now()) => read(expiringKey()) === utcToday(now)
export const saveExpiringCollapsed = (collapsed, now = Date.now()) => {
  if (collapsed) save(expiringKey(), utcToday(now))
  else remove(expiringKey())
}

// The posting you opened last in this tab ({ job_key, title, company_name, at }), for "Applied to …?" on return.
// sessionStorage: it is about this visit only.
const OPENED_KEY = 'jobseeker:opened'
const PROMPTED_KEY = 'jobseeker:prompted'
const PROMPTED_MAX = 50

function readSession(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function saveSession(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable
  }
}

export function recordOpened(job) {
  if (!job?.job_key) return
  saveSession(OPENED_KEY, { job_key: job.job_key, title: job.title || '', company_name: job.company_name || '', at: Date.now(), user: user() })
}

export function readOpened() {
  const entry = readSession(OPENED_KEY)
  if (!entry?.job_key || !Number.isFinite(entry.at) || entry.user !== user()) return null
  const { job_key: jobKey, title, company_name: companyName, at } = entry
  return { job_key: jobKey, title, company_name: companyName, at }
}

export const clearOpened = () => saveSession(OPENED_KEY, null)

// Jobs already asked about in this tab (each job is asked at most once)
export function wasPrompted(jobKey) {
  const keys = readSession(PROMPTED_KEY)
  return Array.isArray(keys) && keys.includes(jobKey)
}

export function markPrompted(jobKey) {
  const keys = readSession(PROMPTED_KEY)
  saveSession(PROMPTED_KEY, [...(Array.isArray(keys) ? keys.filter(key => key !== jobKey) : []), jobKey].slice(-PROMPTED_MAX))
}
