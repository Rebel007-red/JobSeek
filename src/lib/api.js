import { supabase } from './supabase'
import { sessionUser } from './session'

// Databricks is reached only through the Netlify Function, which holds the token and checks the Supabase session.
const ENDPOINT = import.meta.env.VITE_API_URL || '/.netlify/functions/api'
const MAX_WAIT_MS = 120_000
const STORE_PREFIX = 'jobseeker:api:v2:'
const STORE_INDEX = `${STORE_PREFIX}index`
const STORE_MAX_ENTRIES = 25

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// v1 cached one shared result per action (single-user era); drop it so nobody sees another account's data.
try {
  Object.keys(localStorage).filter(key => key.startsWith('jobseeker:api:v1:')).forEach(key => localStorage.removeItem(key))
} catch {
  // storage unavailable
}

// ---- persistent cache (localStorage): last result per user + action + params, shown instantly on the next visit ----

const memory = new Map() // key -> { at, rows }
const inflight = new Map() // key -> Promise<rows>

const userPrefix = () => `${sessionUser()?.id || 'anon'}|`

function keyFor(action, params) {
  return `${userPrefix()}${action}|${JSON.stringify(params ?? {})}`
}

function readIndex() {
  try {
    return JSON.parse(localStorage.getItem(STORE_INDEX) || '[]')
  } catch {
    return []
  }
}

function readCache(key) {
  if (memory.has(key)) return memory.get(key)
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key)
    if (!raw) return null
    const entry = JSON.parse(raw)
    memory.set(key, entry)
    return entry
  } catch {
    return null
  }
}

function writeCache(key, rows, persist) {
  const entry = { at: Date.now(), rows }
  memory.set(key, entry)
  if (!persist) return
  try {
    const index = readIndex().filter(item => item !== key)
    index.push(key)
    while (index.length > STORE_MAX_ENTRIES) localStorage.removeItem(STORE_PREFIX + index.shift())
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(entry))
    localStorage.setItem(STORE_INDEX, JSON.stringify(index))
  } catch {
    // storage full or unavailable: memory cache still works
  }
}

// Drops the signed-in user's cached results for the given actions (after a write they may be stale).
function invalidate(actions) {
  const prefixes = actions.map(action => `${userPrefix()}${action}|`)
  const matches = (key) => prefixes.some(prefix => key.startsWith(prefix))
  for (const key of memory.keys()) if (matches(key)) memory.delete(key)
  try {
    const index = readIndex()
    index.filter(matches).forEach(key => localStorage.removeItem(STORE_PREFIX + key))
    localStorage.setItem(STORE_INDEX, JSON.stringify(index.filter(key => !matches(key))))
  } catch {
    // ignore
  }
}

export function clearApiCache() {
  memory.clear()
  try {
    readIndex().forEach(key => localStorage.removeItem(STORE_PREFIX + key))
    localStorage.removeItem(STORE_INDEX)
  } catch {
    // ignore
  }
}

// Cached results are dropped first; ProtectedRoute then sends you to /login once the session is gone.
export function signOut() {
  clearApiCache()
  supabase.auth.signOut()
}

// ---- transport ----

async function post(body) {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new Error('Sign in required')

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

  let payload = {}
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }
  if (!response.ok && response.status !== 202) {
    throw new Error(payload.error || `Request failed (${response.status})`)
  }
  return payload
}

// Runs an action; if the SQL warehouse is still starting, keeps polling (the server waits between polls).
async function callApi(action, params = {}, { onWaiting } = {}) {
  let payload = await post({ action, params })
  const started = Date.now()

  while (payload.pending) {
    onWaiting?.()
    if (Date.now() - started > MAX_WAIT_MS) {
      throw new Error('Databricks is taking longer than usual (warehouse starting?). Try again in a minute.')
    }
    await sleep(150)
    payload = await post({ action: 'poll', statementId: payload.statementId })
  }
  return payload
}

/**
 * Read with stale-while-revalidate:
 * - onCached(rows) is called right away with the last known result (if any), so the UI renders instantly
 * - if the cached result is younger than maxAge (ms) it is returned without a network call
 * - identical requests in flight are shared (React StrictMode, quick re-renders)
 */
async function query(action, params = {}, { onCached, maxAge = 0, onWaiting, persist = true } = {}) {
  const key = keyFor(action, params)
  const cached = readCache(key)
  if (cached && maxAge && Date.now() - cached.at < maxAge) return cached.rows
  if (cached) onCached?.(cached.rows)

  if (!inflight.has(key)) {
    const request = callApi(action, params, { onWaiting })
      .then(payload => {
        const rows = payload.rows || []
        writeCache(key, rows, persist)
        return rows
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, request)
  }
  return inflight.get(key)
}

const MINUTE = 60_000
// Free-tier budget: gold.jobs only changes when the pipeline runs (a few times a day) or when you write
// (writes invalidate the affected views), so reads are served from cache for up to an hour instead of waking
// the SQL warehouse and calling the Netlify Function on every visit. The jobs page auto-syncs once data is older.
export const SYNC_MS = 60 * MINUTE
const JOB_VIEWS = ['jobs', 'summary', 'hiddenJobs', 'trend']

async function write(action, params, stale) {
  const payload = await callApi(action, params)
  invalidate(stale)
  return payload.rows || []
}

// For single-row reads: unwrap the row for both the cached callback and the result.
function first(action, params, { onCached, ...options } = {}) {
  const unwrap = (rows) => rows[0] || null
  return query(action, params, { ...options, onCached: onCached && (rows => onCached(unwrap(rows))) }).then(unwrap)
}

// scope: 'match' ("For you": your roles, fit 60+) or 'all'
export const api = {
  jobs: (params, options) => query('jobs', params, { maxAge: SYNC_MS, ...options }),
  summary: (filters, options) => first('summary', filters, { maxAge: SYNC_MS, ...options }).then(row => row || {}),
  trend: (params, options) => query('trend', params, { maxAge: SYNC_MS, ...options }),
  facets: (params, options) => query('facets', params, { maxAge: SYNC_MS, ...options }),
  job: (jobKey) => first('job', { jobKey }, { maxAge: 60 * MINUTE, persist: false }),
  prefetchJob: (jobKey) => { api.job(jobKey).catch(() => {}) },
  hiddenJobs: (options) => query('hiddenJobs', {}, { maxAge: SYNC_MS, ...options }),
  profile: (options) => first('profile', {}, { maxAge: SYNC_MS, ...options }),
  refs: () => query('refs', {}, { maxAge: 60 * MINUTE }),
  // Forget cached job data so the next reads go to Databricks (e.g. after a pipeline run)
  refreshData: () => invalidate([...JOB_VIEWS, 'facets']),
  // When the cached result for this read was fetched (0 = never)
  syncedAt: (action, params) => readCache(keyFor(action, params))?.at || 0,
  setApplied: (jobKey, applied) => write('setApplied', { jobKey, applied }, JOB_VIEWS),
  setHidden: (jobKey, hidden) => write('setHidden', { jobKey, hidden }, JOB_VIEWS),
  restoreHidden: () => write('restoreHidden', {}, JOB_VIEWS),
  // Fit and "For you" are computed from the profile at query time, so every job view changes with it
  saveProfile: (profile) => write('saveProfile', profile, ['profile', ...JOB_VIEWS, 'facets']),
}
