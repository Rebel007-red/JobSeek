import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TAB, LIST_TABS, PANEL_KEYS, SORT_VALUES, TAB_LABELS, normalizeTab, scopeLabel, scopeMenuItems, sortAllowed,
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

test('the scope menu: three presets, any other state as its own checked item', () => {
  assert.equal(scopeLabel({ scope: 'match', postedWithin: '24' }), 'For you · last 24h')
  assert.equal(scopeLabel({ scope: 'all', postedWithin: '' }), 'Everything · any date')
  assert.equal(scopeLabel({ scope: 'match', postedWithin: '48' }), 'For you · last 2 days')
  const items = scopeMenuItems({ scope: 'match', postedWithin: '24' })
  assert.deepEqual(items.map(item => [item.label, item.checked]), [
    ['For you · last 24h', true], ['For you · any date', false], ['Everything · any date', false],
  ])
  assert.deepEqual(items[2], { scope: 'all', postedWithin: '', label: 'Everything · any date', checked: false })
  const other = scopeMenuItems({ scope: 'all', postedWithin: '24' })
  assert.equal(other.length, 4)
  assert.deepEqual(other[3], { scope: 'all', postedWithin: '24', label: 'Everything · last 24h', checked: true })
  assert.equal(other.filter(item => item.checked).length, 1)
})
