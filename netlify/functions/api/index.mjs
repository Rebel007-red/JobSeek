// Netlify Function: authenticated proxy from the UI to Databricks (gold.jobs, gold.user_job_state, ops.user_profile).
// The Databricks token never reaches the browser. Callers must send a valid Supabase session token; every per-user
// statement is scoped to that session's user id.
//
// Environment (Netlify site settings, scope: Functions):
//   DATABRICKS_HOST, DATABRICKS_TOKEN   required
//   DATABRICKS_WAREHOUSE_ID (default: first SQL warehouse), DATABRICKS_CATALOG (default jobseeker)
//   SUPABASE_URL / VITE_SUPABASE_URL, SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY   to verify the login
//   ALLOWED_EMAILS   optional comma-separated allow-list (sign-ups are invite-only in Supabase)
import { createHash } from 'node:crypto'
import { SHARED_ACTIONS, ValidationError, buildStatement, isStatementId, toObjects } from './sql.mjs'

const WAIT_TIMEOUT = '8s' // keep below the function time limit; slower statements are polled by the client
const POLL_BUDGET_MS = 6000 // a poll request waits server-side this long before telling the client to ask again
const POLL_INTERVAL_MS = 400
const MAX_ROWS = 5000

// Per-instance caches (a warm function instance serves many requests).
const AUTH_TTL_MS = 5 * 60_000
const CACHE_MAX_ENTRIES = 200
const READ_TTL_MS = {
  jobs: 30_000, summary: 30_000, job: 5 * 60_000, hiddenJobs: 30_000, profile: 30_000,
  trend: 5 * 60_000, facets: 5 * 60_000, refs: 30 * 60_000,
}
const WRITE_ACTIONS = new Set(['setApplied', 'setHidden', 'restoreHidden', 'saveProfile'])
const authCache = new Map() // sha256(token) -> { expires, user: { id, email } }
const resultCache = new Map() // <user id | 'shared'>|action|params -> { expires, body }
const pendingStatements = new Map() // statement id -> { userId, shared, write, cache: { key, ttl } | null }

function remember(map, key, value) {
  if (map.size >= CACHE_MAX_ENTRIES) map.delete(map.keys().next().value)
  map.set(key, value)
}

// Per-user results are keyed by the user id so one user's jobs / flags / profile are never served to another.
function cacheKey(action, params, user) {
  const scope = SHARED_ACTIONS.has(action) ? 'shared' : user.id
  return `${scope}|${action}|${JSON.stringify(params ?? {})}`
}

function forgetUserResults(userId) {
  const prefix = `${userId}|`
  for (const key of resultCache.keys()) if (key.startsWith(prefix)) resultCache.delete(key)
}

function cachedResult(key) {
  const entry = resultCache.get(key)
  if (!entry) return null
  if (entry.expires < Date.now()) {
    resultCache.delete(key)
    return null
  }
  return entry.body
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function env(name, fallback = '') {
  const value = String(process.env[name] ?? '').trim().replace(/^"|"$/g, '')
  return value || fallback
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

// Returns the signed-in Supabase user as { id, email }.
async function verifyUser(req) {
  const header = req.headers.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) throw new HttpError(401, 'Sign in required')

  const tokenHash = createHash('sha256').update(token).digest('hex')
  const cached = authCache.get(tokenHash)
  if (cached && cached.expires > Date.now()) return cached.user

  const supabaseUrl = env('SUPABASE_URL') || env('VITE_SUPABASE_URL')
  const anonKey = env('SUPABASE_ANON_KEY') || env('VITE_SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) throw new HttpError(500, 'Login verification is not configured on the server')

  const response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new HttpError(401, 'Session expired, sign in again')
  const data = await response.json()
  if (!data?.id) throw new HttpError(401, 'Session expired, sign in again')
  const user = { id: String(data.id), email: String(data.email || '') }

  const allowed = env('ALLOWED_EMAILS').split(',').map(email => email.trim().toLowerCase()).filter(Boolean)
  if (allowed.length && !allowed.includes(user.email.toLowerCase())) {
    throw new HttpError(403, 'This account is not allowed to use the job data')
  }
  remember(authCache, tokenHash, { expires: Date.now() + AUTH_TTL_MS, user })
  return user
}

function databricksConfig() {
  const host = env('DATABRICKS_HOST').replace(/\/+$/, '')
  const token = env('DATABRICKS_TOKEN')
  if (!host.startsWith('https://') || !token) {
    throw new HttpError(500, 'DATABRICKS_HOST and DATABRICKS_TOKEN must be set on the server')
  }
  return { host, token, warehouseId: env('DATABRICKS_WAREHOUSE_ID'), catalog: env('DATABRICKS_CATALOG', 'jobseeker') }
}

let discoveredWarehouseId = ''

// Uses DATABRICKS_WAREHOUSE_ID when set, otherwise the first SQL warehouse in the workspace (cached per instance).
async function warehouseId(config) {
  if (config.warehouseId) return config.warehouseId
  if (!discoveredWarehouseId) {
    const warehouses = (await databricks(config, 'GET', '/api/2.0/sql/warehouses')).warehouses || []
    if (!warehouses.length) throw new HttpError(500, 'No SQL warehouse found; set DATABRICKS_WAREHOUSE_ID')
    discoveredWarehouseId = warehouses[0].id
  }
  return discoveredWarehouseId
}

async function databricks(config, method, path, body) {
  const response = await fetch(`${config.host}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const raw = await response.text()
  let data = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { message: raw.slice(0, 300) }
  }
  if (!response.ok) {
    throw new HttpError(502, `Databricks ${response.status}: ${String(data.message || data.error_code || 'request failed').slice(0, 300)}`)
  }
  return data
}

// Turns a statement into { status, body }; successful reads are cached under `cache.key`.
async function statementResult(config, data, cache) {
  const state = data.status?.state
  if (state === 'PENDING' || state === 'RUNNING') {
    return { status: 202, body: { pending: true, statementId: data.statement_id } }
  }
  if (state !== 'SUCCEEDED') {
    const message = String(data.status?.error?.message || `Statement ${state || 'failed'}`)
    // assert_true(...) in a statement = input the SQL rejected (e.g. a role not in the taxonomy)
    const raised = message.match(/\[USER_RAISED_EXCEPTION\]\s*(.*?)(?:\s*SQLSTATE.*)?$/s)
    if (raised) return { status: 400, body: { error: raised[1].trim().slice(0, 300) } }
    return { status: 502, body: { error: message.slice(0, 500) } }
  }

  const columns = data.manifest?.schema?.columns || []
  const rows = [...(data.result?.data_array || [])]
  let next = data.result?.next_chunk_internal_link
  while (next?.startsWith('/api/2.0/sql/statements/') && rows.length < MAX_ROWS) {
    const chunk = await databricks(config, 'GET', next)
    rows.push(...(chunk.data_array || []))
    next = chunk.next_chunk_internal_link
  }
  const body = { rows: toObjects(columns, rows) }
  if (cache) remember(resultCache, cache.key, { expires: Date.now() + cache.ttl, body })
  return { status: 200, body }
}

async function runStatement(config, action, params, user) {
  const ttl = READ_TTL_MS[action]
  const key = ttl ? cacheKey(action, params, user) : null
  if (key) {
    const hit = cachedResult(key)
    if (hit) return json(200, hit)
  }

  const { statement, parameters } = buildStatement(action, params, user)
  const data = await databricks(config, 'POST', '/api/2.0/sql/statements/', {
    warehouse_id: await warehouseId(config),
    catalog: config.catalog,
    statement,
    parameters,
    wait_timeout: WAIT_TIMEOUT,
    on_wait_timeout: 'CONTINUE',
    disposition: 'INLINE',
    format: 'JSON_ARRAY',
  })
  const write = WRITE_ACTIONS.has(action)
  if (write) forgetUserResults(user.id)
  const cache = key ? { key, ttl } : null
  const result = await statementResult(config, data, cache)
  if (result.status === 202) {
    remember(pendingStatements, data.statement_id, { userId: user.id, shared: SHARED_ACTIONS.has(action), write, cache })
  }
  return json(result.status, result.body)
}

// Waits server-side (short intervals) so the client needs few round trips while the warehouse starts.
// A per-user statement started on this instance can only be polled by the user who started it.
async function pollStatement(config, statementId, user) {
  const started = Date.now()
  const pending = pendingStatements.get(statementId)
  if (pending && !pending.shared && pending.userId !== user.id) throw new HttpError(403, 'Not your request')
  for (;;) {
    const data = await databricks(config, 'GET', `/api/2.0/sql/statements/${statementId}`)
    const result = await statementResult(config, data, pending?.cache)
    if (result.status !== 202) {
      pendingStatements.delete(statementId)
      // Reads cached while this write was running may predate it
      if (pending?.write) forgetUserResults(user.id)
      return json(result.status, result.body)
    }
    if (Date.now() - started > POLL_BUDGET_MS) return json(result.status, result.body)
    await sleep(POLL_INTERVAL_MS)
  }
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  try {
    const user = await verifyUser(req)

    let body
    try {
      body = await req.json()
    } catch {
      throw new ValidationError('Request body must be JSON')
    }
    const action = body?.action
    const config = databricksConfig()

    if (action === 'poll') {
      if (!isStatementId(body.statementId)) throw new ValidationError('Invalid statement id')
      return await pollStatement(config, body.statementId, user)
    }

    // await: errors from the statement must reach the catch below, not escape as a rejected promise
    return await runStatement(config, action, body.params, user)
  } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error(error)
    return json(status, { error: error.message || 'Unexpected error' })
  }
}
