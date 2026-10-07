import { sessionUser } from '../lib/session'
import { DEFAULT_TAB, LIST_TABS, SORT_VALUES, defaultSortFor } from './filters'

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

const user = () => sessionUser()?.id || 'anon'

// Layout ('list' | 'grid'), per device
const VIEW_KEY = 'jobseeker.view'

export const readView = () => (read(VIEW_KEY) === 'grid' ? 'grid' : 'list')
export const saveView = (view) => save(VIEW_KEY, view)

// Scope ('match' = "For you" | 'all'), per user on this device
const scopeKey = () => `jobseeker:scope:${user()}`

export const readScope = () => (read(scopeKey()) === 'all' ? 'all' : 'match')
export const saveScope = (scope) => save(scopeKey(), scope)

// Tab ('pending' = To apply | 'saved' | 'applied' | 'all'), per user on this device; new visits open To apply
const tabKey = () => `jobseeker:tab:${user()}`

export const readTab = () => {
  const tab = read(tabKey())
  return LIST_TABS.includes(tab) ? tab : DEFAULT_TAB
}
export const saveTab = (tab) => save(tabKey(), tab)

// Sort per tab, per user on this device (Applied opens with Applied date, the others with Best fit)
const sortKey = (tab) => `jobseeker:sort:${user()}:${tab}`

export const readSort = (tab) => {
  const sort = read(sortKey(tab))
  return SORT_VALUES.includes(sort) ? sort : defaultSortFor(tab)
}
export const saveSort = (tab, sort) => save(sortKey(tab), sort)

// What a URL without tab / scope / sort means (urlState.js)
export const rememberedListState = () => ({ tab: readTab(), scope: readScope(), sortFor: readSort })

// Move to the next job after marking one applied (Settings → Account), per device, on by default
const AUTO_ADVANCE_KEY = 'jobseeker.autoAdvance'

export const readAutoAdvance = () => read(AUTO_ADVANCE_KEY) !== '0'
export const saveAutoAdvance = (on) => save(AUTO_ADVANCE_KEY, on ? '1' : '0')

// The one-time swipe hint on touch devices, per device
const SWIPE_HINT_KEY = 'jobseeker.swipeHintSeen'

export const readSwipeHintSeen = () => read(SWIPE_HINT_KEY) === '1'
export const saveSwipeHintSeen = () => save(SWIPE_HINT_KEY, '1')

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
