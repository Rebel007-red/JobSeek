import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_FILTERS } from './filters.js'
import { isJobKey, jobLink, listStateToParams, parseListState } from './urlState.js'

const KEY = 'a'.repeat(64)

test('an empty URL opens what this device remembers, else To apply / For you / Best fit / last 24h', () => {
  assert.deepEqual(parseListState(''), {
    tab: 'pending', sort: 'fit', scope: 'match', filters: DEFAULT_FILTERS, jobKey: null, sheet: null,
  })
  const remembered = { tab: 'applied', scope: 'all', sortFor: tab => (tab === 'applied' ? 'recent' : 'found') }
  const state = parseListState(new URLSearchParams(''), remembered)
  assert.equal(state.tab, 'applied')
  assert.equal(state.sort, 'recent')
  assert.equal(state.scope, 'all')
  // the Applied tab opens sorted by applied date unless another sort was picked
  assert.equal(parseListState('tab=applied').sort, 'applied')
  assert.equal(parseListState('tab=saved').sort, 'fit')
})

test('the URL overrides what is remembered', () => {
  const remembered = { tab: 'applied', scope: 'all', sortFor: () => 'recent' }
  const state = parseListState('tab=all&sort=found&scope=match', remembered)
  assert.deepEqual([state.tab, state.sort, state.scope], ['all', 'found', 'match'])
})

test('every filter is read, invalid values are dropped', () => {
  const state = parseListState(
    `q=data%20-intern&role=Data%20Engineer&company=Acme&city=Pune&workMode=remote&employment=unknown&maxYears=4&minFit=70`
    + `&stage=interviewing&closed=only&posted=48&skills=1&myCities=1&followUp=1&muted=only&job=${KEY}&sheet=filters`,
  )
  assert.deepEqual(state.filters, {
    ...DEFAULT_FILTERS,
    q: 'data -intern', role: 'Data Engineer', company: 'Acme', city: 'Pune', workMode: 'remote', employment: 'unknown',
    maxYears: '4', minFit: '70', stage: 'interviewing', closed: 'only', postedWithin: '48', matchedOnly: true,
    myCities: true, followUp: true, muteView: 'only',
  })
  assert.equal(state.jobKey, KEY)
  assert.equal(state.sheet, 'filters')

  const bad = parseListState('tab=nope&sort=x&scope=me&workMode=moon&maxYears=99&minFit=0&stage=saved&closed=x'
    + '&posted=72&skills=yes&muted=all&job=123&sheet=menu')
  assert.deepEqual([bad.tab, bad.sort, bad.scope], ['pending', 'fit', 'match'])
  assert.deepEqual(bad.filters, DEFAULT_FILTERS)
  assert.equal(bad.jobKey, null)
  assert.equal(bad.sheet, null)
  assert.equal(parseListState('posted=any').filters.postedWithin, '')
  assert.equal(parseListState(`q=${'x'.repeat(150)}`).filters.q.length, 100)
})

test('defaults are left out, in a stable order', () => {
  assert.equal(listStateToParams({ tab: 'pending', sort: 'fit', scope: 'match', filters: DEFAULT_FILTERS }).toString(), '')
  const params = listStateToParams({
    sheet: 'filters',
    jobKey: KEY,
    filters: { ...DEFAULT_FILTERS, muteView: 'only', matchedOnly: true, city: 'Pune', q: 'spark', postedWithin: '' },
    scope: 'all',
    sort: 'recent',
    tab: 'all',
  })
  assert.equal(params.toString(), `tab=all&sort=recent&scope=all&q=spark&city=Pune&posted=any&skills=1&muted=only&job=${KEY}&sheet=filters`)
  // the sort is left out when it is the tab's default or the one remembered for it
  assert.equal(listStateToParams({ tab: 'applied', sort: 'applied' }).toString(), 'tab=applied')
  assert.equal(listStateToParams({ tab: 'applied', sort: 'fit' }, { tab: 'applied', sortFor: () => 'fit' }).toString(), '')
  // a value the remembered one would hide is written out
  assert.equal(listStateToParams({ tab: 'pending', scope: 'match' }, { tab: 'all', scope: 'all' }).toString(), 'tab=pending&scope=match')
})

test('state round-trips through the URL', () => {
  const remembered = { tab: 'saved', scope: 'all', sortFor: tab => (tab === 'all' ? 'found' : undefined) }
  const states = [
    { tab: 'pending', sort: 'fit', scope: 'match', filters: DEFAULT_FILTERS, jobKey: null, sheet: null },
    { tab: 'saved', sort: 'fit', scope: 'all', filters: { ...DEFAULT_FILTERS, postedWithin: '' }, jobKey: KEY, sheet: null },
    { tab: 'all', sort: 'found', scope: 'all', filters: { ...DEFAULT_FILTERS, workMode: 'unknown', minFit: '60' }, jobKey: null, sheet: 'filters' },
    {
      tab: 'applied',
      sort: 'recent',
      scope: 'match',
      filters: { ...DEFAULT_FILTERS, stage: 'offer', closed: 'hide', followUp: true, location: 'Navi Mumbai', employment: 'contract' },
      jobKey: null,
      sheet: null,
    },
  ]
  for (const state of states) {
    for (const memory of [undefined, remembered]) {
      assert.deepEqual(parseListState(listStateToParams(state, memory), memory), state)
    }
  }
})

test('jobLink and isJobKey', () => {
  assert.equal(jobLink(KEY, 'https://example.org'), `https://example.org/?job=${KEY}`)
  assert.equal(isJobKey(KEY), true)
  assert.equal(isJobKey(KEY.toUpperCase()), false)
  assert.equal(isJobKey('abc'), false)
  assert.equal(isJobKey(null), false)
})
