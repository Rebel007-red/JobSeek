import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_FILTERS } from './filters.js'
import { isJobKey, jobLink, listStateToParams, parseListState } from './urlState.js'

const KEY = 'a'.repeat(64)

test('an empty URL opens what this device remembers, else Inbox / For you / Best fit / last 7 days', () => {
  assert.deepEqual(parseListState(''), {
    tab: 'inbox', sort: 'fit', scope: 'match', filters: DEFAULT_FILTERS, jobKey: null, sheet: null,
  })
  const remembered = { tab: 'applied', scope: 'all', sortFor: tab => (tab === 'applied' ? 'recent' : 'found') }
  const state = parseListState(new URLSearchParams(''), remembered)
  assert.equal(state.tab, 'applied')
  assert.equal(state.sort, 'recent')
  assert.equal(state.scope, 'all')
  // the Applied tab opens with Needs action first unless another sort was picked
  assert.equal(parseListState('tab=applied').sort, 'action')
  assert.equal(parseListState('tab=saved').sort, 'fit')
})

test('the URL overrides what is remembered', () => {
  const remembered = { tab: 'applied', scope: 'all', sortFor: () => 'recent' }
  const state = parseListState('tab=saved&sort=found&scope=match', remembered)
  assert.deepEqual([state.tab, state.sort, state.scope], ['saved', 'found', 'match'])
})

test('old links and remembered tabs (To apply, All) open the Inbox', () => {
  assert.equal(parseListState('tab=pending').tab, 'inbox')
  assert.equal(parseListState('tab=all&sort=found').tab, 'inbox')
  assert.equal(parseListState('tab=all&sort=found').sort, 'found')
  assert.equal(parseListState('', { tab: 'pending' }).tab, 'inbox')
  assert.equal(parseListState('', { tab: 'all' }).tab, 'inbox')
  // the URL written back for an old link is the plain one
  assert.equal(listStateToParams(parseListState('tab=pending&scope=all')).toString(), 'scope=all')
  assert.equal(listStateToParams({ tab: 'all' }).toString(), '')
  assert.equal(listStateToParams({ tab: 'pending' }, { tab: 'saved' }).toString(), 'tab=inbox')
})

test('the time window remembered with the scope is what a URL without posted means', () => {
  // the default is no window (the last 7 days: untracked jobs are deleted after that)
  assert.equal(DEFAULT_FILTERS.postedWithin, '')
  assert.equal(listStateToParams({ filters: DEFAULT_FILTERS }).toString(), '')
  assert.equal(listStateToParams({ filters: { ...DEFAULT_FILTERS, postedWithin: '72' } }).toString(), 'posted=72')
  const remembered = { scope: 'all', postedWithin: '24' }
  assert.equal(parseListState('', remembered).filters.postedWithin, '24')
  assert.equal(parseListState('posted=72', remembered).filters.postedWithin, '72')
  assert.equal(parseListState('posted=any', remembered).filters.postedWithin, '')
  assert.equal(listStateToParams({ scope: 'all', filters: { ...DEFAULT_FILTERS, postedWithin: '24' } }, remembered).toString(), '')
  assert.equal(listStateToParams({ scope: 'all', filters: DEFAULT_FILTERS }, remembered).toString(), 'posted=any')
  // an invalid remembered window (the old '48' = last 2 days) falls back to the default
  assert.equal(parseListState('', { postedWithin: '48' }).filters.postedWithin, '')
  assert.equal(parseListState('posted=48').filters.postedWithin, '')
  assert.equal(parseListState('posted=48', remembered).filters.postedWithin, '24')
})

test('Expiring first is an Inbox sort only', () => {
  assert.equal(parseListState('sort=expiring').sort, 'expiring')
  assert.equal(parseListState('tab=saved&sort=expiring').sort, 'fit')
  assert.equal(parseListState('tab=applied&sort=expiring').sort, 'action')
  assert.equal(listStateToParams({ tab: 'inbox', sort: 'expiring' }).toString(), 'sort=expiring')
  assert.equal(listStateToParams({ tab: 'saved', sort: 'expiring' }).toString(), 'tab=saved')
  // a remembered expiring sort does not carry over to another tab
  assert.equal(parseListState('tab=saved', { sortFor: () => 'expiring' }).sort, 'fit')
})

test('Needs action: needs=1 and the action sort on the Applied tab; old stage links keep working', () => {
  const state = parseListState('tab=applied&needs=1')
  assert.equal(state.filters.needsAction, true)
  assert.equal(state.sort, 'action')
  assert.equal(listStateToParams(state).toString(), 'tab=applied&needs=1')
  assert.equal(parseListState('tab=applied&needs=yes').filters.needsAction, false)
  // the action sort is Applied only; the old default (Applied date) is still a sort you can link to
  assert.equal(parseListState('sort=action').sort, 'fit')
  assert.equal(parseListState('tab=applied&sort=applied').sort, 'applied')
  assert.equal(listStateToParams({ tab: 'applied', sort: 'applied' }).toString(), 'tab=applied&sort=applied')
  assert.equal(listStateToParams({ tab: 'applied', sort: 'action' }).toString(), 'tab=applied')
  // No reply is a stage of the chips; older links
  assert.equal(parseListState('tab=applied&stage=no_response').filters.stage, 'no_response')
  const old = parseListState('tab=applied&followUp=1&closed=only')
  assert.deepEqual([old.filters.followUp, old.filters.closed, old.filters.needsAction], [true, 'only', false])
  assert.equal(listStateToParams(old).toString(), 'tab=applied&closed=only&followUp=1')
})

test('every filter is read, invalid values are dropped', () => {
  const state = parseListState(
    `q=data%20-intern&role=Data%20Engineer&company=Acme&city=Pune&workMode=remote&employment=unknown&maxYears=4&minFit=70`
    + `&stage=interviewing&closed=only&posted=72&skills=1&myCities=1&followUp=1&muted=only&job=${KEY}&sheet=filters`,
  )
  assert.deepEqual(state.filters, {
    ...DEFAULT_FILTERS,
    q: 'data -intern', role: 'Data Engineer', company: 'Acme', city: 'Pune', workMode: 'remote', employment: 'unknown',
    maxYears: '4', minFit: '70', stage: 'interviewing', closed: 'only', postedWithin: '72', matchedOnly: true,
    myCities: true, followUp: true, muteView: 'only',
  })
  assert.equal(state.jobKey, KEY)
  assert.equal(state.sheet, 'filters')

  const bad = parseListState('tab=nope&sort=x&scope=me&workMode=moon&maxYears=99&minFit=0&stage=saved&closed=x'
    + '&posted=48&skills=yes&muted=all&job=123&sheet=menu')
  assert.deepEqual([bad.tab, bad.sort, bad.scope], ['inbox', 'fit', 'match'])
  assert.deepEqual(bad.filters, DEFAULT_FILTERS)
  assert.equal(bad.jobKey, null)
  assert.equal(bad.sheet, null)
  assert.equal(parseListState('posted=any').filters.postedWithin, '')
  assert.equal(parseListState(`q=${'x'.repeat(150)}`).filters.q.length, 100)
})

test('defaults are left out, in a stable order', () => {
  assert.equal(listStateToParams({ tab: 'inbox', sort: 'fit', scope: 'match', filters: DEFAULT_FILTERS }).toString(), '')
  const params = listStateToParams({
    sheet: 'filters',
    jobKey: KEY,
    filters: { ...DEFAULT_FILTERS, muteView: 'only', matchedOnly: true, city: 'Pune', q: 'spark', postedWithin: '24' },
    scope: 'all',
    sort: 'recent',
    tab: 'saved',
  })
  assert.equal(params.toString(), `tab=saved&sort=recent&scope=all&q=spark&city=Pune&posted=24&skills=1&muted=only&job=${KEY}&sheet=filters`)
  // the sort is left out when it is the tab's default or the one remembered for it
  assert.equal(listStateToParams({ tab: 'applied', sort: 'action' }).toString(), 'tab=applied')
  assert.equal(listStateToParams({ tab: 'applied', sort: 'fit' }, { tab: 'applied', sortFor: () => 'fit' }).toString(), '')
  // a value the remembered one would hide is written out
  assert.equal(listStateToParams({ tab: 'inbox', scope: 'match' }, { tab: 'saved', scope: 'all' }).toString(), 'tab=inbox&scope=match')
})

test('state round-trips through the URL', () => {
  const remembered = { tab: 'saved', scope: 'all', sortFor: tab => (tab === 'inbox' ? 'found' : undefined) }
  const states = [
    { tab: 'inbox', sort: 'fit', scope: 'match', filters: DEFAULT_FILTERS, jobKey: null, sheet: null },
    { tab: 'inbox', sort: 'expiring', scope: 'match', filters: { ...DEFAULT_FILTERS, postedWithin: '72' }, jobKey: null, sheet: null },
    { tab: 'saved', sort: 'fit', scope: 'all', filters: { ...DEFAULT_FILTERS, postedWithin: '' }, jobKey: KEY, sheet: null },
    { tab: 'inbox', sort: 'found', scope: 'all', filters: { ...DEFAULT_FILTERS, workMode: 'unknown', minFit: '60' }, jobKey: null, sheet: 'filters' },
    {
      tab: 'applied',
      sort: 'recent',
      scope: 'match',
      filters: { ...DEFAULT_FILTERS, stage: 'offer', closed: 'hide', followUp: true, location: 'Navi Mumbai', employment: 'contract' },
      jobKey: null,
      sheet: null,
    },
    { tab: 'applied', sort: 'action', scope: 'match', filters: { ...DEFAULT_FILTERS, needsAction: true }, jobKey: null, sheet: null },
    { tab: 'applied', sort: 'applied', scope: 'all', filters: { ...DEFAULT_FILTERS, stage: 'no_response' }, jobKey: null, sheet: null },
  ]
  for (const state of states) {
    for (const memory of [undefined, remembered, { ...remembered, postedWithin: '24' }, { postedWithin: '72' }, { postedWithin: '48' }]) {
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
