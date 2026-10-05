import test from 'node:test'
import assert from 'node:assert/strict'

import handler from './index.mjs'

const USERS = {
  'token-a': { id: '0b6f3c1e-9a2d-4f7b-8c55-1d2e3f4a5b6c', email: 'a@example.com' },
  'token-b': { id: '1c7a4d2f-0b3e-4a8c-9d66-2e3f4a5b6c7d', email: 'b@example.com' },
}
const KEY = 'a'.repeat(64)

Object.assign(process.env, {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_ANON_KEY: 'anon',
  DATABRICKS_HOST: 'https://databricks.test',
  DATABRICKS_TOKEN: 'dapi',
  DATABRICKS_WAREHOUSE_ID: 'wh',
})

// Fake Supabase + Databricks: `statements` maps statement id -> response for polls; `posts` records submitted statements.
const statements = new Map()
const posts = []
let nextPost = null
globalThis.fetch = async (url, init = {}) => {
  const { pathname } = new URL(url)
  if (pathname === '/auth/v1/user') {
    const user = USERS[init.headers.Authorization.slice(7)]
    return user ? Response.json(user) : new Response('{}', { status: 401 })
  }
  if (pathname === '/api/2.0/sql/statements/' && init.method === 'POST') {
    posts.push(JSON.parse(init.body))
    return Response.json(nextPost ?? succeeded([]))
  }
  if (pathname.startsWith('/api/2.0/sql/statements/')) return Response.json(statements.get(pathname.split('/').pop()))
  return new Response('{}', { status: 404 })
}

function succeeded(dataArray) {
  return { status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'n', type_name: 'INT' }] } }, result: { data_array: dataArray } }
}

async function call(token, body, method = 'POST') {
  const response = await handler(new Request('http://localhost/', {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }))
  return { status: response.status, body: await response.json() }
}

test('rejects other methods and missing sessions', async () => {
  assert.equal((await call('token-a', null, 'GET')).status, 405)
  assert.deepEqual(await call(null, { action: 'refs' }), { status: 401, body: { error: 'Sign in required' } })
})

test('validation errors from statement builders come back as 400 JSON', async () => {
  assert.deepEqual(await call('token-a', { action: 'dropEverything' }), { status: 400, body: { error: 'Unknown action: dropEverything' } })
  assert.equal((await call('token-a', { action: 'setHidden', params: { jobKey: 'nope', hidden: true } })).status, 400)
  assert.equal((await call('token-a', { action: 'poll', statementId: '../x' })).status, 400)
})

test('a pending statement can only be polled by the user who started it', async () => {
  nextPost = { statement_id: 'stmt-write-0000000001', status: { state: 'PENDING' } }
  const started = await call('token-a', { action: 'setHidden', params: { jobKey: KEY, hidden: true } })
  nextPost = null
  assert.deepEqual(started, { status: 202, body: { pending: true, statementId: 'stmt-write-0000000001' } })

  statements.set('stmt-write-0000000001', succeeded([]))
  assert.equal((await call('token-b', { action: 'poll', statementId: 'stmt-write-0000000001' })).status, 403)
  assert.deepEqual(await call('token-a', { action: 'poll', statementId: 'stmt-write-0000000001' }), { status: 200, body: { rows: [] } })
})

test('reads cached while a write was running are dropped when it finishes', async () => {
  nextPost = { statement_id: 'stmt-write-0000000002', status: { state: 'PENDING' } }
  await call('token-a', { action: 'setApplied', params: { jobKey: KEY, applied: true } })
  nextPost = succeeded([['1']])
  assert.deepEqual((await call('token-a', { action: 'hiddenJobs' })).body, { rows: [{ n: 1 }] })
  const before = posts.length
  await call('token-a', { action: 'hiddenJobs' })
  assert.equal(posts.length, before, 'second read is served from the cache')

  statements.set('stmt-write-0000000002', succeeded([]))
  await call('token-a', { action: 'poll', statementId: 'stmt-write-0000000002' })
  nextPost = succeeded([['2']])
  assert.deepEqual((await call('token-a', { action: 'hiddenJobs' })).body, { rows: [{ n: 2 }] })
  nextPost = null
})
