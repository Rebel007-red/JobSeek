import test from 'node:test'
import assert from 'node:assert/strict'

import { addCount, afterPing, emptyPending, localSince, normalizeVisit, planPing, readVisit, saveVisit, visitKey } from './visit.js'

const MIN = 60_000
const PLAN = { gapMs: 30 * MIN, everyMs: 10 * MIN, maxCount: 500 }
const T0 = Date.parse('2026-10-09T04:00:00Z')

test('normalizeVisit reads broken or missing values as nothing stored', () => {
  assert.deepEqual(normalizeVisit(null), { pingAt: 0, since: undefined, pending: emptyPending() })
  assert.deepEqual(normalizeVisit({ pingAt: 'x', since: 5, pending: { opened: -1, promptYes: 2.5, promptNo: 3 } }),
    { pingAt: 0, since: undefined, pending: { ...emptyPending(), promptNo: 3 } })
  assert.equal(normalizeVisit({ pingAt: T0, since: null }).since, null)
  assert.equal(visitKey('u1'), 'jobseeker:visit:u1')
  assert.equal(visitKey(undefined), 'jobseeker:visit:anon')
})

test('without storage the entry is kept in memory', () => {
  const key = visitKey('memory-only')
  saveVisit(key, { pingAt: T0, since: null, pending: emptyPending() })
  assert.equal(readVisit(key).pingAt, T0)
})

test('the first visit ever: since unknown until the server answers, then null', () => {
  const entry = normalizeVisit(null)
  assert.equal(localSince(entry, T0, PLAN.gapMs), undefined)
  const plan = planPing(entry, T0, PLAN)
  assert.deepEqual(plan, { newVisit: true, sent: emptyPending() })
  const next = afterPing(entry, plan, null, T0)
  assert.deepEqual(next, { pingAt: T0, since: null, pending: emptyPending() })
})

test('a new visit starts from the local estimate, which the server corrects', () => {
  const stored = { pingAt: T0, since: null, pending: emptyPending() }
  const later = T0 + 3 * 60 * MIN
  assert.equal(localSince(stored, later, PLAN.gapMs), new Date(T0).toISOString())
  const plan = planPing(stored, later, PLAN)
  assert.equal(plan.newVisit, true)
  // another device looked at the list an hour ago
  const phone = '2026-10-09T06:00:00.000Z'
  assert.equal(afterPing(stored, plan, phone, later).since, phone)
})

test('one since for the whole visit: reloads, second tabs and the 10-minute pings keep it', () => {
  const since = '2026-10-09T01:00:00.000Z'
  const stored = { pingAt: T0, since, pending: emptyPending() }
  // a reload 5 minutes later: no ping (throttled), same since
  assert.equal(localSince(stored, T0 + 5 * MIN, PLAN.gapMs), since)
  assert.equal(planPing(stored, T0 + 5 * MIN, PLAN), null)
  // 12 minutes later: a ping, still the same visit
  const plan = planPing(stored, T0 + 12 * MIN, PLAN)
  assert.equal(plan.newVisit, false)
  assert.equal(afterPing(stored, plan, '2026-10-09T04:00:00.000Z', T0 + 12 * MIN).since, since)
  // back after 30+ minutes: a new visit
  assert.equal(planPing(stored, T0 + 30 * MIN, PLAN).newVisit, true)
  assert.equal(localSince(stored, T0 + 30 * MIN, PLAN.gapMs), new Date(T0).toISOString())
})

test('counters are sent with the ping and only what was sent is cleared', () => {
  let entry = normalizeVisit({ pingAt: T0 - 20 * MIN, since: null })
  entry = addCount(addCount(addCount(entry, 'opened'), 'opened'), 'promptSaved')
  assert.deepEqual(addCount(entry, 'nope'), entry)
  const plan = planPing(entry, T0, PLAN)
  assert.deepEqual(plan.sent, { opened: 2, promptYes: 0, promptNo: 0, promptSaved: 1 })
  // one more open while the ping was on its way
  const latest = addCount(entry, 'opened')
  assert.deepEqual(afterPing(latest, plan, null, T0).pending, { opened: 1, promptYes: 0, promptNo: 0, promptSaved: 0 })
  // at most maxCount per ping; the rest waits
  const many = normalizeVisit({ pending: { opened: 700 } })
  const big = planPing(many, T0, PLAN)
  assert.equal(big.sent.opened, 500)
  assert.equal(afterPing(many, big, null, T0).pending.opened, 200)
})

test('a pingAt in the future (clock turned back) does not stop the pings', () => {
  const entry = normalizeVisit({ pingAt: 2_000_000_000_000, since: null })
  assert.ok(planPing(entry, 1_900_000_000_000, { gapMs: 30 * 60_000, everyMs: 10 * 60_000, maxCount: 500 }))
})
