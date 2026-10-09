import test from 'node:test'
import assert from 'node:assert/strict'

import { setSessionUser } from '../lib/session.js'
import {
  countOpenWithoutSwipe, markSwipeUsed, readExpiringCollapsed, readScope, readSort, readSwipePeekDone, readSwipeRightApplies,
  readSwipeTipShown, readTab, readWindow, rememberedListState, saveExpiringCollapsed, saveScopeWindow, saveSort,
  saveSwipePeekDone, saveSwipeRightApplies, saveSwipeTipShown, saveTab,
} from './viewPref.js'

// A small localStorage for node
const store = new Map()
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
}

test.beforeEach(() => {
  store.clear()
  setSessionUser({ id: 'u1' })
})

test('tabs stored by an older version read as the Inbox', () => {
  assert.equal(readTab(), 'inbox')
  for (const old of ['pending', 'all']) {
    store.set('jobseeker:tab:u1', old)
    assert.equal(readTab(), 'inbox')
  }
  saveTab('applied')
  assert.equal(readTab(), 'applied')
  store.set('jobseeker:tab:u1', 'nope')
  assert.equal(readTab(), 'inbox')
})

test('the Inbox takes over the sort remembered for To apply, once', () => {
  store.set('jobseeker:sort:u1:pending', 'found')
  assert.equal(readSort('inbox'), 'found')
  assert.equal(store.get('jobseeker:sort:u1:inbox'), 'found')
  saveSort('inbox', 'recent')
  assert.equal(readSort('inbox'), 'recent')
  // other tabs do not look at the old key; an Inbox-only sort falls back on them
  assert.equal(readSort('saved'), 'fit')
  store.set('jobseeker:sort:u1:saved', 'expiring')
  assert.equal(readSort('saved'), 'fit')
  assert.equal(readSort('applied'), 'applied')
  saveSort('inbox', 'expiring')
  assert.equal(readSort('inbox'), 'expiring')
})

test('the scope menu remembers the scope and the time window together', () => {
  assert.deepEqual([readScope(), readWindow()], ['match', '24'])
  saveScopeWindow({ scope: 'all', postedWithin: '' })
  assert.deepEqual([readScope(), readWindow()], ['all', ''])
  saveScopeWindow({ scope: 'match', postedWithin: '48' })
  assert.deepEqual([readScope(), readWindow()], ['match', '48'])
  // invalid values are not stored
  saveScopeWindow({ scope: 'me', postedWithin: '72' })
  assert.deepEqual([readScope(), readWindow()], ['match', '48'])
  const remembered = rememberedListState()
  assert.equal(remembered.postedWithin, '48')
  assert.equal(remembered.sortFor('applied'), 'applied')
  // per user
  setSessionUser({ id: 'u2' })
  assert.deepEqual([readScope(), readWindow()], ['match', '24'])
})

test('swipe right marks applied: off by default, per device', () => {
  assert.equal(readSwipeRightApplies(), false)
  saveSwipeRightApplies(true)
  assert.equal(readSwipeRightApplies(), true)
  setSessionUser({ id: 'u2' })
  assert.equal(readSwipeRightApplies(), true)
  saveSwipeRightApplies(false)
  assert.equal(readSwipeRightApplies(), false)
})

test('touch onboarding: peek once, the tip after opens without a swipe, none once you swiped', () => {
  // whoever saw the old hint banner skips the peek
  store.set('jobseeker.swipeHintSeen', '1')
  assert.equal(readSwipePeekDone(), true)
  store.clear()
  assert.equal(readSwipePeekDone(), false)
  saveSwipePeekDone()
  assert.equal(readSwipePeekDone(), true)

  assert.deepEqual([1, 2, 3, 4, 5].map(() => countOpenWithoutSwipe()), [1, 2, 3, 4, 5])
  assert.equal(readSwipeTipShown(), false)
  saveSwipeTipShown()
  assert.equal(readSwipeTipShown(), true)
  markSwipeUsed()
  assert.equal(countOpenWithoutSwipe(), 0)
  assert.equal(countOpenWithoutSwipe(), 0)
})

test('the Expiring strip stays collapsed for the rest of the UTC day', () => {
  const day = Date.parse('2026-10-09T10:00:00Z')
  assert.equal(readExpiringCollapsed(day), false)
  saveExpiringCollapsed(true, day)
  assert.equal(readExpiringCollapsed(day + 3600_000), true)
  assert.equal(readExpiringCollapsed(Date.parse('2026-10-10T00:00:01Z')), false)
  saveExpiringCollapsed(false, day)
  assert.equal(readExpiringCollapsed(day), false)
})
