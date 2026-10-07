import { supabase } from './supabase'
import { sessionUser } from './session'
import { MAX_BULK_KEYS } from '../utils/gold'

// The app reads and writes Supabase directly: two RPCs (public.app_read / public.app_write, supabase/app_api.sql)
// run with the signed-in user's session, score the jobs per user in Postgres and return { rows: [...] }.
// Job data is published there by the Databricks pipeline (databricks/jobs/publish_to_supabase.py).
const STORE_PREFIX = 'jobseeker:api:v4:'
const STORE_INDEX = `${STORE_PREFIX}index`
const STORE_MAX_ENTRIES = 25
const WRITE_ACTIONS = new Set(['setApplied', 'setStatus', 'setHidden', 'setNote', 'restoreHidden', 'saveProfile',
  'saveMuteRules', 'setAllowedEmail'])

// v1 cached one shared result per action (single-user era), v2 held results from the old Databricks API, v3 rows lack
// the status, duplicate and mute fields: drop them.
const OLD_PREFIXES = ['jobseeker:api:v1:', 'jobseeker:api:v2:', 'jobseeker:api:v3:']
try {
  Object.keys(localStorage)
    .filter(key => OLD_PREFIXES.some(prefix => key.startsWith(prefix)))
    .forEach(key => localStorage.removeItem(key))
} catch {
  // storage unavailable
}

// ---- persistent cache (localStorage): last result per user + action + params, shown instantly on the next visit ----

const memory = new Map() // key -> { at, rows }
const inflight = new Map() // key -> { generation, promise: Promise<rows> }
let generation = 0 // bumped by every invalidation

const userId = () => sessionUser()?.id || 'anon'
const userPrefix = () => `${userId()}|`

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
  generation += 1
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
  generation += 1
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

// The request never got an answer (supabase-js reports fetch failures as an error without a Postgres code)
function isNetworkError(error) {
  return !error?.code && /fetch|network|load failed/i.test(String(error?.message || error || ''))
}

function offlineMessage() {
  return navigator.onLine === false
    ? 'You are offline. Check your connection and try again.'
    : 'Could not reach the server. Check your connection and try again.'
}

// Right after sign-in the API can see the brand-new token as "issued at future" (clock skew between Supabase's auth and
// API servers); the request is rejected before it runs, so one retry a moment later is safe for reads and writes.
const isFreshTokenSkew = (error) => error?.code === 'PGRST303' || /issued at future/i.test(error?.message || '')

async function callApi(action, params = {}) {
  let result
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Sign in required')
    const call = () => supabase.rpc(WRITE_ACTIONS.has(action) ? 'app_write' : 'app_read', { action, params })
    result = await call()
    if (isFreshTokenSkew(result.error)) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      result = await call()
    }
  } catch (err) {
    if (err?.message === 'Sign in required') throw err
    throw new Error(isNetworkError(err) ? offlineMessage() : (err?.message || 'Request failed'))
  }
  const { data, error } = result
  if (error) throw new Error(isNetworkError(error) ? offlineMessage() : (error.message || 'Request failed'))
  return data || { rows: [] }
}

/**
 * Read with stale-while-revalidate:
 * - onCached(rows) is called right away with the last known result (if any), so the UI renders instantly
 * - if the cached result is younger than maxAge (ms) it is returned without a network call
 * - identical requests in flight are shared (React StrictMode, quick re-renders)
 */
async function query(action, params = {}, { onCached, maxAge = 0, persist = true } = {}) {
  const key = keyFor(action, params)
  const cached = readCache(key)
  if (cached && maxAge && Date.now() - cached.at < maxAge) return cached.rows
  if (cached) onCached?.(cached.rows)

  // A request that started before an invalidation (a write, a new publish) may carry the old data: it is neither shared
  // with later callers nor cached, so the next read after a write always asks the server again.
  const shared = inflight.get(key)
  if (shared && shared.generation === generation) return shared.promise
  const entry = { generation }
  entry.promise = callApi(action, params)
    .then(payload => {
      const rows = payload.rows || []
      if (entry.generation === generation) writeCache(key, rows, persist)
      return rows
    })
    .finally(() => {
      if (inflight.get(key) === entry) inflight.delete(key)
    })
  inflight.set(key, entry)
  return entry.promise
}

const MINUTE = 60_000
// Supabase answers in well under a second, so cached views are only reused for a few minutes (instant page loads,
// fewer requests). Writes invalidate the views they change, and checkFreshness() drops them after a pipeline publish.
export const SYNC_MS = 5 * MINUTE
const REFS_MS = 6 * 60 * MINUTE
const STATUS_MS = MINUTE
// Reads that change with your applies, saves, hides and notes (dropped after every such write)
const JOB_VIEWS = ['jobs', 'summary', 'hiddenJobs', 'trend', 'jobRow', 'jobGroup', 'trackedJobs']
const PUBLISHED_VIEWS = [...JOB_VIEWS, 'facets', 'refs', 'job']
// The profile and mute rules change scores and lists, and the facets (they leave muted jobs out)
const PROFILE_VIEWS = ['profile', ...JOB_VIEWS, 'facets']
const NOTE_VIEWS = ['jobNote', 'jobs', 'jobRow', 'jobGroup', 'trackedJobs', 'summary']
const MUTE_FIELDS = { companies: 'muted_companies', titleWords: 'muted_title_words', levels: 'muted_levels' }
const EXPIRED_MESSAGE = 'this job was just removed (the posting expired). Refresh to see the current list.'

async function write(action, params, stale) {
  const payload = await callApi(action, params)
  invalidate(stale)
  return payload.rows || []
}

// setApplied only writes for a job that still exists; 0 rows means a publish just removed it (expired posting)
async function writeJobFlag(action, params) {
  const rows = await write(action, params, JOB_VIEWS)
  if (action === 'setApplied' && params.applied && Number(rows[0]?.num_affected_rows) === 0) throw new Error(EXPIRED_MESSAGE)
  return rows
}

// One job key, or an array of keys (sent MAX_BULK_KEYS per request). Several keys resolve to one row with the summed
// num_affected_rows. The job views are dropped even when a later chunk fails (the earlier ones were written).
async function writeJobs(action, jobKeys, params) {
  if (!Array.isArray(jobKeys)) return write(action, { ...params, jobKey: jobKeys }, JOB_VIEWS)
  const keys = [...new Set(jobKeys.filter(Boolean))]
  if (!keys.length) return [{ num_affected_rows: 0 }]
  if (keys.length === 1) return write(action, { ...params, jobKey: keys[0] }, JOB_VIEWS)
  let affected = 0
  try {
    for (let start = 0; start < keys.length; start += MAX_BULK_KEYS) {
      const payload = await callApi(action, { ...params, jobKeys: keys.slice(start, start + MAX_BULK_KEYS) })
      affected += Number(payload.rows?.[0]?.num_affected_rows) || 0
    }
  } finally {
    invalidate(JOB_VIEWS)
  }
  return [{ num_affected_rows: affected }]
}

const isSingleKey = (jobKeys) => !Array.isArray(jobKeys) || new Set(jobKeys.filter(Boolean)).size === 1

// Mute rule edits run one after another, so two quick adds never save over each other
let muteQueue = Promise.resolve()

function muteLists(profile) {
  return Object.fromEntries(Object.entries(MUTE_FIELDS).map(([kind, field]) => [kind, [...(profile?.[field] || [])]]))
}

function editMuteRule(kind, value, add) {
  if (!MUTE_FIELDS[kind]) return Promise.reject(new Error(`Unknown mute rule kind: ${kind}`))
  const text = String(value ?? '').trim()
  const same = (item) => item.toLowerCase() === text.toLowerCase()
  const run = async () => {
    const profile = await api.profile()
    if (!profile) throw new Error('Save your profile first')
    const lists = muteLists(profile)
    if (!text || lists[kind].some(same) === add) return lists
    lists[kind] = add ? [...lists[kind], text] : lists[kind].filter(item => !same(item))
    const rows = await api.saveMuteRules({ [kind]: lists[kind] })
    // The saved lists as the server stored them (trimmed, repeats dropped)
    return rows[0] ? muteLists(rows[0]) : lists
  }
  const result = muteQueue.then(run, run)
  muteQueue = result.catch(() => {})
  return result
}

// For single-row reads: unwrap the row for both the cached callback and the result.
function first(action, params, { onCached, ...options } = {}) {
  const unwrap = (rows) => rows[0] || null
  return query(action, params, { ...options, onCached: onCached && (rows => onCached(unwrap(rows))) }).then(unwrap)
}

// The last published pipeline run this device has seen, per user
const runKey = () => `${STORE_PREFIX}run:${userId()}`
const seenRuns = new Map() // memory fallback when storage is unavailable

function lastSeenRun() {
  try {
    const value = localStorage.getItem(runKey())
    if (value !== null) return value
  } catch {
    // storage unavailable
  }
  return seenRuns.get(runKey()) ?? null
}

function rememberRun(runId) {
  seenRuns.set(runKey(), runId)
  try {
    localStorage.setItem(runKey(), runId)
  } catch {
    // memory copy still works for this tab
  }
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
  refs: () => query('refs', {}, { maxAge: REFS_MS }),
  // { run_id, snapshot_at, published_at, jobs } of the last pipeline publish (all null before the first one)
  status: (options) => first('status', {}, { maxAge: STATUS_MS, ...options }).then(row => row || {}),
  // True (and cached job data dropped) when a pipeline publish happened since this device last looked. published_at is
  // part of the marker because a repaired run is re-published under the same run_id with a newer snapshot.
  checkFreshness: async () => {
    const { run_id: runId, published_at: publishedAt } = await api.status()
    if (runId === null || runId === undefined) return false
    const current = `${runId}|${publishedAt ?? ''}`
    const last = lastSeenRun()
    rememberRun(current)
    // First look on this device: whatever is cached was fetched moments ago under this same prefix
    if (last === null || last === current) return false
    invalidate(PUBLISHED_VIEWS)
    return true
  },
  // Forget cached job data so the next reads go to the server
  refreshData: () => invalidate([...JOB_VIEWS, 'facets', 'status']),
  // When the cached result for this read was fetched (0 = never)
  syncedAt: (action, params) => readCache(keyFor(action, params))?.at || 0,
  // The cached rows for this read (null = none), for a first render that already shows them
  cachedRows: (action, params) => readCache(keyFor(action, params))?.rows ?? null,
  // One job as a list row for this user, whatever the filters (a deep link ?job=, "View it"); null when it is gone
  jobRow: (jobKey, options) => first('jobRow', { jobKey }, { maxAge: SYNC_MS, persist: false, ...options }),
  // Every visible posting of a duplicate group (dup_group), representative first
  jobGroup: (dupGroup, options) => query('jobGroup', { dupGroup }, { maxAge: SYNC_MS, persist: false, ...options }),
  // { job_key, note, next_action_at, application_status, status_updated_at } or null
  jobNote: (jobKey) => first('jobNote', { jobKey }, { persist: false }),
  // Your saved and applied jobs (at most 2000) with their notes, for the CSV export
  trackedJobs: () => query('trackedJobs', {}, { persist: false }),
  setApplied: (jobKey, applied) => writeJobFlag('setApplied', { jobKey, applied }),
  // status: one of APPLICATION_STATUSES (gold.js); jobKeys: a key or an array of keys. restore (an undo): the job's
  // previous { appliedAt, statusUpdatedAt }, put back instead of now, so the follow-up clock does not restart.
  setStatus: async (jobKeys, status, restore) => {
    const times = restore ? { appliedAt: restore.appliedAt || null, statusUpdatedAt: restore.statusUpdatedAt || null } : {}
    const rows = await writeJobs('setStatus', jobKeys, { status, ...times })
    if (status !== 'not_applied' && isSingleKey(jobKeys) && Number(rows[0]?.num_affected_rows) === 0) {
      throw new Error(EXPIRED_MESSAGE)
    }
    return rows
  },
  // jobKeys: a key or an array of keys; reason (optional, when hiding): one of HIDE_REASONS (gold.js), kept as feedback
  setHidden: (jobKeys, hidden, reason) => writeJobs('setHidden', jobKeys, reason ? { hidden, reason } : { hidden }),
  // note: text or null; nextActionAt: 'YYYY-MM-DD' or null. A note or date on an untracked job saves it (kept past the
  // expiry); resolves to the result row, which has the job's application_status.
  setNote: async (jobKey, note, nextActionAt) => {
    const rows = await write('setNote', { jobKey, note: note ?? null, nextActionAt: nextActionAt || null }, NOTE_VIEWS)
    return rows[0] || null
  },
  restoreHidden: () => write('restoreHidden', {}, JOB_VIEWS),
  // Fit and "For you" are computed from the profile at query time, so every job view changes with it
  saveProfile: (profile) => write('saveProfile', profile, PROFILE_VIEWS),
  // { companies, titleWords, levels }: a list left out keeps the saved one
  saveMuteRules: (rules = {}) => {
    const params = Object.fromEntries(Object.keys(MUTE_FIELDS).filter(kind => Array.isArray(rules[kind])).map(kind => [kind, rules[kind]]))
    return write('saveMuteRules', params, PROFILE_VIEWS)
  },
  // kind: 'companies' | 'titleWords' | 'levels' (value compared case-insensitively). Resolve to the new
  // { companies, titleWords, levels }.
  addMuteRule: (kind, value) => editMuteRule(kind, value, true),
  removeMuteRule: (kind, value) => editMuteRule(kind, value, false),
  // Admin only (the server checks): who may use the job data (empty list = any signed-in user)
  allowedEmails: () => query('allowedEmails', {}, { persist: false }),
  setAllowedEmail: (email, allowed) => write('setAllowedEmail', { email, allowed }, ['allowedEmails']),
  // Admin only: latest first_seen_at per lower(company) and source plus the last scrape (last_scraped_at, last_ok_at,
  // jobs_found, last_error, failures), for the scraper health badges
  companyHealth: () => query('companyHealth', {}, { maxAge: SYNC_MS, persist: false }),
  // Admin only: database size, counts, last publish, pipeline runs and scrape results (the System tab)
  systemStatus: () => first('systemStatus', {}, { persist: false }),
}
