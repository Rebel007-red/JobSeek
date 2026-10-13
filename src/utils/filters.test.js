import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_FILTERS, DEFAULT_SCOPE, DEFAULT_TAB, FRESH_HOURS, LIST_TABS, PANEL_KEYS, POSTED_HOURS, POSTED_OPTIONS, SORT_VALUES,
  TAB_LABELS, normalizeTab, scopeLabel, scopeMenuItems, sortAllowed,
} from './filters.js'

test('three disjoint tabs; the old ones read as the Inbox', () => {
  assert.deepEqual(LIST_TABS, ['inbox', 'saved', 'applied'])
  assert.equal(DEFAULT_TAB, 'inbox')
  assert.deepEqual(LIST_TABS.map(tab => TAB_LABELS[tab]), ['Inbox', 'Saved', 'Applied'])
  assert.equal(normalizeTab('pending'), 'inbox')
  assert.equal(normalizeTab('all'), 'inbox')
  assert.equal(normalizeTab('saved'), 'saved')
  assert.equal(normalizeTab('nope'), null)
  assert.equal(normalizeTab(null), null)
  assert.equal(normalizeTab('constructor'), null) // not an inherited property of the old-tab map
})

test('Expiring first is an Inbox sort; the time window is not a panel filter', () => {
  assert.ok(SORT_VALUES.includes('expiring'))
  assert.equal(sortAllowed('expiring', 'inbox'), true)
  assert.equal(sortAllowed('expiring', 'saved'), false)
  assert.equal(sortAllowed('fit', 'applied'), true)
  assert.equal(sortAllowed('nope', 'inbox'), false)
  assert.equal(PANEL_KEYS.includes('postedWithin'), false)
})

test('the scope menu: four presets, any other state as its own checked item', () => {
  assert.equal(scopeLabel({ scope: 'match', postedWithin: '24' }), 'For you · last 24h')
  assert.equal(scopeLabel({ scope: 'all', postedWithin: '' }), 'Everything · last 7 days')
  assert.equal(scopeLabel({ scope: 'match', postedWithin: '72' }), 'For you · last 3 days')
  const items = scopeMenuItems({ scope: 'match', postedWithin: '24' })
  assert.deepEqual(items.map(item => [item.label, item.checked]), [
    ['For you · last 7 days', false], ['For you · last 3 days', false], ['For you · last 24h', true],
    ['Everything · last 7 days', false],
  ])
  assert.deepEqual(items[3], { scope: 'all', postedWithin: '', label: 'Everything · last 7 days', checked: false })
  // the default (For you, every live job) is the first preset
  assert.equal(scopeMenuItems({ scope: DEFAULT_SCOPE, postedWithin: FRESH_HOURS })[0].checked, true)
  const other = scopeMenuItems({ scope: 'all', postedWithin: '24' })
  assert.equal(other.length, 5)
  assert.deepEqual(other[4], { scope: 'all', postedWithin: '24', label: 'Everything · last 24h', checked: true })
  assert.equal(other.filter(item => item.checked).length, 1)
})

test('the time window: the last 7 days by default (untracked jobs live 7 days), 3 days and 24 hours', () => {
  assert.equal(FRESH_HOURS, '')
  assert.equal(DEFAULT_FILTERS.postedWithin, '')
  assert.deepEqual(POSTED_OPTIONS.map(option => option.value), ['24', '72', ''])
  assert.deepEqual(POSTED_HOURS, ['24', '72'])
  assert.equal(POSTED_OPTIONS.at(-1).label, 'Last 7 days')
})
