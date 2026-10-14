import test from 'node:test'
import assert from 'node:assert/strict'

import { CHECKIN_MIN_DAYS, NO_REPLY_DAYS } from './gold.js'
import {
  FOLLOWED_UP_LABEL, SNOOZE_STAGES, actionFlag, appliedAgo, askAgainDay, checkinAnswers, daysSinceUpdate, funnelText, isCheckinDue,
  liveCount, nextLabel, relaxations, replyRate, suggestedStage, weekStart,
} from './tracker.js'

// Local times, so the tests pass in every time zone: Tuesday Oct 13 2026, 10:00
const NOW = new Date(2026, 9, 13, 10, 0).getTime()
const daysBefore = (days, hour = 10) => new Date(2026, 9, 13 - days, hour, 0).toISOString()
const applied = (days, extra = {}) => ({ application_status: 'applied', is_applied: true, applied_at: daysBefore(days), ...extra })

test('appliedAgo counts local calendar days', () => {
  assert.equal(appliedAgo(applied(0), NOW), 'Applied today')
  assert.equal(appliedAgo({ applied_at: new Date(2026, 9, 12, 23, 59).toISOString() }, NOW), 'Applied yesterday')
  assert.equal(appliedAgo(applied(8), NOW), 'Applied 8d ago')
  // early this morning is today, late last night yesterday, whatever the hours between
  assert.equal(appliedAgo({ applied_at: new Date(2026, 9, 13, 0, 1).toISOString() }, NOW), 'Applied today')
  assert.equal(appliedAgo({ applied_at: null }, NOW), null)
  assert.equal(appliedAgo({ applied_at: 'nope' }, NOW), null)
  assert.equal(appliedAgo(null, NOW), null)
})

test('daysSinceUpdate: the status time, else the applied time', () => {
  assert.equal(daysSinceUpdate(applied(20, { status_updated_at: daysBefore(3) }), NOW), 3)
  assert.equal(daysSinceUpdate(applied(20), NOW), 20)
  assert.equal(daysSinceUpdate({}, NOW), null)
})

test('actionFlag puts action_rank into words', () => {
  assert.deepEqual(actionFlag(applied(3, { action_rank: 1, next_action_at: '2026-10-13' }), NOW),
    { label: 'Follow up', title: 'Your follow-up date has come', tone: 'warning' })
  assert.deepEqual(actionFlag({ application_status: 'interviewing', applied_at: daysBefore(30), status_updated_at: daysBefore(9), action_rank: 2 }, NOW),
    { label: 'No update 9d', title: 'Interviewing with no update for 9 days', tone: 'warning' })
  assert.deepEqual(actionFlag(applied(15, { action_rank: 3 }), NOW),
    { label: 'No update 15d', title: 'Applied 15 days ago with no update', tone: 'warning' })
  // from 21 days the flag asks the same question the stage menu suggests
  assert.equal(actionFlag({ ...applied(NO_REPLY_DAYS, { action_rank: 3 }), applied_at: daysBefore(NO_REPLY_DAYS, 8) }, NOW).title, 'Applied 21 days ago with no update. Mark it No reply?')
  assert.equal(actionFlag(applied(30, { action_rank: 0 }), NOW), null)
  assert.equal(actionFlag({ application_status: 'rejected', action_rank: 0 }, NOW), null)
  assert.equal(actionFlag(null, NOW), null)
  // never fewer days than the rule that raised the flag (clock skew, a missing date)
  assert.equal(actionFlag({ application_status: 'applied', action_rank: 3 }, NOW).label, 'No update 14d')
  assert.equal(actionFlag({ application_status: 'interviewing', action_rank: 2 }, NOW).label, 'No update 7d')
  // rows of an older API: only follow_up
  assert.equal(actionFlag(applied(3, { follow_up: true, next_action_at: '2026-10-10' }), NOW).label, 'Follow up')
  assert.equal(actionFlag(applied(16, { follow_up: true }), NOW).label, 'No update 16d')
  assert.equal(actionFlag(applied(16, { follow_up: false }), NOW), null)
})

test('nextLabel: a follow-up date still ahead (or today) when nothing needs action', () => {
  assert.match(nextLabel(applied(3, { next_action_at: '2026-10-20', action_rank: 0 }), NOW), /^Next (Oct 20|20 Oct)$/)
  assert.match(nextLabel({ application_status: 'rejected', next_action_at: '2026-10-13', action_rank: 0 }, NOW), /^Next /)
  // today's date on an open stage is rank 1: the flag shows instead
  assert.equal(nextLabel(applied(3, { next_action_at: '2026-10-13', action_rank: 1 }), NOW), null)
  assert.equal(nextLabel(applied(3, { next_action_at: '2026-10-12', action_rank: 0 }), NOW), null)
  assert.equal(nextLabel(applied(3, { next_action_at: null }), NOW), null)
  // an older API without action_rank
  assert.match(nextLabel(applied(3, { next_action_at: '2026-10-20' }), NOW), /^Next /)
})

test('suggestedStage: No reply from 21 days after applying, for plain applied only', () => {
  const at = (ms) => new Date(NOW - ms).toISOString()
  const day = 86_400_000
  assert.equal(suggestedStage({ application_status: 'applied', applied_at: at(NO_REPLY_DAYS * day) }, NOW), 'no_response')
  assert.equal(suggestedStage({ application_status: 'applied', applied_at: at(NO_REPLY_DAYS * day - 60_000) }, NOW), null)
  assert.equal(suggestedStage({ is_applied: true, applied_at: at(40 * day) }, NOW), 'no_response')
  for (const status of ['interviewing', 'offer', 'no_response', 'rejected', 'withdrawn', 'saved']) {
    assert.equal(suggestedStage({ application_status: status, applied_at: at(40 * day) }, NOW), null, status)
  }
  assert.equal(suggestedStage({ application_status: 'applied' }, NOW), null)
})

test('checkinAnswers fit the stage, hotkeys 1-5, snoozes a week ahead', () => {
  const snoozeDay = '2026-10-20'
  assert.equal(CHECKIN_MIN_DAYS, 7)

  const young = checkinAnswers(applied(8), NOW)
  assert.deepEqual(young.map(a => [a.label, a.kind, a.status ?? a.nextActionAt, a.suggested, a.hotkey]), [
    ['Heard back', 'status', 'interviewing', false, '1'],
    ['Rejected', 'status', 'rejected', false, '2'],
    ['No reply yet', 'snooze', snoozeDay, false, '3'],
    ['Withdrawn', 'status', 'withdrawn', false, '4'],
  ])
  assert.equal(young[0].ariaLabel, 'Heard back: move to Interviewing')
  assert.equal(young[2].title, 'Ask again in 7 days')

  const old = checkinAnswers(applied(25), NOW)
  assert.deepEqual(old.map(a => [a.label, a.kind, a.status ?? a.nextActionAt, a.suggested, a.hotkey]), [
    ['Heard back', 'status', 'interviewing', false, '1'],
    ['Rejected', 'status', 'rejected', false, '2'],
    ['No reply', 'status', 'no_response', true, '3'],
    ['Withdrawn', 'status', 'withdrawn', false, '4'],
    ['Still waiting', 'snooze', snoozeDay, false, '5'],
  ])
  assert.equal(old[2].title, 'No answer in 3 weeks: mark it No reply')
  assert.equal(old[4].title, 'Ask again in 7 days')

  const interviewing = checkinAnswers({ application_status: 'interviewing', applied_at: daysBefore(30) }, NOW)
  assert.deepEqual(interviewing.map(a => [a.label, a.kind, a.status ?? a.nextActionAt, a.hotkey]), [
    ['Offer', 'status', 'offer', '1'],
    ['Rejected', 'status', 'rejected', '2'],
    ['Still interviewing', 'snooze', snoozeDay, '3'],
    ['Withdrawn', 'status', 'withdrawn', '4'],
  ])
  // unique keys
  for (const list of [young, old, interviewing]) assert.equal(new Set(list.map(a => a.key)).size, list.length)
  for (const status of ['saved', 'offer', 'no_response', 'rejected', 'withdrawn', 'not_applied']) {
    assert.deepEqual(checkinAnswers({ application_status: status, applied_at: daysBefore(30) }, NOW), [], status)
  }
  // the snooze date is a local calendar day, across a month end
  const late = new Date(2026, 9, 28, 23, 30).getTime()
  assert.equal(checkinAnswers({ application_status: 'applied', applied_at: new Date(2026, 9, 20).toISOString() }, late)[2].nextActionAt, '2026-11-04')
})

test('weekStart: the local Monday 00:00', () => {
  assert.equal(weekStart(NOW).getTime(), new Date(2026, 9, 12).getTime()) // Tuesday -> Monday Oct 12
  assert.equal(weekStart(new Date(2026, 9, 12, 0, 0).getTime()).getTime(), new Date(2026, 9, 12).getTime())
  assert.equal(weekStart(new Date(2026, 9, 18, 23, 59).getTime()).getTime(), new Date(2026, 9, 12).getTime()) // Sunday
  assert.equal(weekStart(new Date(2026, 10, 1, 9).getTime()).getTime(), new Date(2026, 9, 26).getTime()) // across a month
})

test('isCheckinDue: something to ask, not shown yet this local week', () => {
  const monday = new Date(2026, 9, 12, 8, 0).getTime()
  assert.equal(isCheckinDue({ lastCheckinAt: null, total: 3 }, monday), true)
  assert.equal(isCheckinDue({ lastCheckinAt: null, total: 0 }, monday), false)
  assert.equal(isCheckinDue({}, monday), false)
  // shown last Friday: due on Monday morning, and on Tuesday when Monday was skipped
  const friday = new Date(2026, 9, 9, 17, 0).toISOString()
  assert.equal(isCheckinDue({ lastCheckinAt: friday, total: 3 }, monday), true)
  assert.equal(isCheckinDue({ lastCheckinAt: friday, total: 3 }, NOW), true)
  // shown this Monday: not again this week (a reload, Wednesday, Sunday night)
  const shown = new Date(2026, 9, 12, 8, 1).toISOString()
  for (const at of [new Date(2026, 9, 12, 9).getTime(), new Date(2026, 9, 14, 9).getTime(), new Date(2026, 9, 18, 23, 59).getTime()]) {
    assert.equal(isCheckinDue({ lastCheckinAt: shown, total: 3 }, at), false)
  }
  // next Monday it is due again; back after weeks away too
  assert.equal(isCheckinDue({ lastCheckinAt: shown, total: 3 }, new Date(2026, 9, 19, 0, 0).getTime()), true)
  assert.equal(isCheckinDue({ lastCheckinAt: new Date(2026, 8, 1).toISOString(), total: 1 }, NOW), true)
  assert.equal(isCheckinDue({ lastCheckinAt: 'nope', total: 1 }, NOW), true)
})

test('funnelText: the copy of the funnel line', () => {
  assert.equal(funnelText({ applied: 138, replied: 4, interviewed: 2, offers: 1, median_reply_days: 6.0 }),
    '138 applied → 4 replies (3%) → 2 interviews → 1 offer · median reply 6 d')
  assert.equal(funnelText({ applied: 10, replied: 1, interviewed: 1, offers: 0, median_reply_days: 2.5 }),
    '10 applied → 1 reply (10%) → 1 interview · median reply 3 d')
  assert.equal(funnelText({ applied: 5, replied: 0, interviewed: 0, offers: 0, median_reply_days: null }), '5 applied → 0 replies (0%)')
  assert.equal(funnelText({ applied: 3, replied: 2, interviewed: 0, offers: 2, median_reply_days: 0.4 }),
    '3 applied → 2 replies (67%) → 2 offers · median reply <1 d')
  assert.equal(funnelText({ applied: 0, replied: 0 }), null)
  assert.equal(funnelText(null), null)
  assert.equal(funnelText(undefined), null)
  assert.equal(replyRate({ applied: 60, replied: 3 }), 5)
  assert.equal(replyRate({ applied: 0, replied: 0 }), null)
})

test('liveCount: the count of the list the tab shows', () => {
  const summary = {
    inbox: 120, saved: 8, applied: 40, muted: 6, needs_action: 5, follow_up: 3, closed: 30,
    stages: { applied: 20, interviewing: 4, offer: 1, no_response: 2, rejected: 10, withdrawn: 3 },
  }
  assert.equal(liveCount(summary, 'inbox', {}), 120)
  assert.equal(liveCount(summary, 'inbox', { muteView: 'only' }), 6)
  assert.equal(liveCount(summary, 'saved', {}), 8)
  assert.equal(liveCount(summary, 'applied', {}), 40)
  assert.equal(liveCount(summary, 'applied', { needsAction: true }), 5)
  assert.equal(liveCount(summary, 'applied', { stage: 'no_response' }), 2)
  assert.equal(liveCount(summary, 'applied', { stage: 'applied' }), 20)
  assert.equal(liveCount(summary, 'applied', { followUp: true }), 3)
  assert.equal(liveCount(summary, 'applied', { closed: 'only' }), 30)
  assert.equal(liveCount(summary, 'applied', { closed: 'hide' }), 10)
  // two chips at once: no single count covers it
  assert.equal(liveCount(summary, 'applied', { stage: 'offer', needsAction: true }), null)
  // not loaded yet, or an older API without the key
  assert.equal(liveCount({}, 'inbox', {}), null)
  assert.equal(liveCount(null, 'inbox', {}), null)
  assert.equal(liveCount({ applied: 4, stages: { applied: 4 } }, 'applied', { needsAction: true }), null)
  assert.equal(liveCount({ applied: 4, stages: { applied: 4 } }, 'applied', { stage: 'no_response' }), null)
  assert.equal(liveCount({ inbox: 0 }, 'inbox', {}), 0)
  assert.equal(liveCount(summary, 'nope', {}), null)
})

test('relaxations: one filter at a time, in order, only those set', () => {
  const filters = {
    q: 'snowflke', postedWithin: '24', minFit: '70', matchedOnly: true, maxYears: '4', myCities: true, city: 'Pune',
    workMode: 'remote', role: 'Data Engineer', category: 'Data', company: 'Acme', source: 'workday', employment: 'contract',
    location: 'Navi', muteView: '', stage: '', needsAction: false,
  }
  const all = relaxations(filters, 'match', 'inbox')
  assert.deepEqual(all.map(r => r.label), [
    'Clear search', 'Any date', 'Everything', 'Any fit', 'Any skills', 'Any experience', 'Any city', 'Any work mode', 'Any role',
    'Any category', 'Any company', 'Any source', 'Any employment', 'Any location',
  ])
  assert.deepEqual(all[0].patch, { filters: { q: '' } })
  assert.deepEqual(all[1].patch, { filters: { postedWithin: '' } })
  assert.deepEqual(all[2].patch, { scope: 'all' })
  assert.deepEqual(all[4].patch, { filters: { matchedOnly: false } })
  // My cities and City are one "Any city" that clears both
  assert.deepEqual(all.find(r => r.label === 'Any city').patch, { filters: { myCities: false, city: '' } })
  assert.deepEqual(relaxations({ city: 'Pune' }, 'all', 'inbox'), [{ key: 'city', label: 'Any city', patch: { filters: { myCities: false, city: '' } } }])

  // the default Inbox (For you, every date) offers Everything only
  assert.deepEqual(relaxations({ q: '', postedWithin: '', matchedOnly: false }, 'match', 'inbox').map(r => r.label), ['Everything'])
  assert.deepEqual(relaxations({}, 'all', 'inbox'), [])
  // Saved and Applied: no time or scope relaxations
  assert.deepEqual(relaxations({ q: 'spark', postedWithin: '24', minFit: '70' }, 'match', 'saved').map(r => r.label), ['Clear search', 'Any fit'])
  assert.deepEqual(relaxations({ q: '  ' }, 'match', 'applied'), [])
})

test('Followed up: the stage menu snooze asks again on the same day as the check-in', () => {
  assert.equal(askAgainDay(NOW), '2026-10-20')
  assert.equal(askAgainDay(new Date(2026, 11, 28, 23, 30).getTime()), '2027-01-04') // across a year, late evening
  assert.equal(checkinAnswers(applied(8), NOW).find(a => a.kind === 'snooze').nextActionAt, askAgainDay(NOW))
  assert.equal(FOLLOWED_UP_LABEL, 'Followed up · ask again in 7 days')
  // the stages a due follow-up date makes Needs action (app.user_jobs action_rank 1)
  assert.deepEqual(SNOOZE_STAGES, ['applied', 'interviewing', 'offer', 'no_response'])
})
