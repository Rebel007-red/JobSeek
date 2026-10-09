import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STALE_DATA_MS, dataFreshness, dupLabel, dupPill, expiringStripCopy, expiryHint, followUpDateLabel, followUpTitle, formatDate, formatRelativeAge,
  groupKeys, isExpiring, isNewJob, nextExpiryAt, parseDay, placeLabel, postedAgo, sinceLabel, staleBannerText,
} from './job.js'

const hoursAgo = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString()

test('formatRelativeAge buckets by hours and days', () => {
  assert.equal(formatRelativeAge(hoursAgo(0.2)), 'Now')
  assert.equal(formatRelativeAge(hoursAgo(5)), '5h ago')
  assert.equal(formatRelativeAge(hoursAgo(30)), '1d ago')
  assert.equal(formatRelativeAge(hoursAgo(24 * 3)), '3d ago')
  assert.equal(formatRelativeAge(hoursAgo(24 * 9)), 'Older')
  assert.equal(formatRelativeAge('not a date'), null)
  assert.equal(formatRelativeAge(null), null)
})

test('isNewJob: untracked jobs found since your last visit', () => {
  const since = '2026-10-09T04:00:00.000Z'
  assert.equal(isNewJob({ first_seen_at: '2026-10-09T05:00:00+00:00' }, since), true)
  // the boundary: found exactly at since is not new (the server compares first_seen_at > since)
  assert.equal(isNewJob({ first_seen_at: '2026-10-09T04:00:00+00:00' }, since), false)
  assert.equal(isNewJob({ first_seen_at: '2026-10-09T03:59:59Z' }, since), false)
  // since not known yet (undefined) or a first visit (null): nothing is new
  assert.equal(isNewJob({ first_seen_at: hoursAgo(1) }, undefined), false)
  assert.equal(isNewJob({ first_seen_at: hoursAgo(1) }, null), false)
  // saved and applied jobs never show the dot
  assert.equal(isNewJob({ first_seen_at: '2026-10-09T05:00:00Z', application_status: 'saved' }, since), false)
  assert.equal(isNewJob({ first_seen_at: '2026-10-09T05:00:00Z', is_applied: true }, since), false)
  assert.equal(isNewJob({ first_seen_at: null }, since), false)
  assert.equal(isNewJob(null, since), false)
  assert.equal(isNewJob({ first_seen_at: '2026-10-09T05:00:00Z' }, 'nope'), false)
})

test('sinceLabel: the time today, the weekday and time this week, else the date', () => {
  const now = new Date(2026, 9, 9, 15, 0).getTime()
  const today = new Date(2026, 9, 9, 9, 51)
  assert.match(sinceLabel(today.toISOString(), now), /9:51/)
  assert.doesNotMatch(sinceLabel(today.toISOString(), now), /Oct|Fri/)
  const monday = new Date(2026, 9, 5, 9, 51).toISOString()
  assert.match(sinceLabel(monday, now), /Mon.*9:51/)
  assert.match(sinceLabel(new Date(2026, 8, 20, 9, 51).toISOString(), now), /Sep.*20|20.*Sep/)
  assert.equal(sinceLabel(null, now), null)
  assert.equal(sinceLabel('nope', now), null)
})

test('formatDate returns null for missing or invalid dates', () => {
  assert.equal(formatDate(null), null)
  assert.equal(formatDate('nope'), null)
  assert.ok(formatDate('2026-09-29'))
})

test('dataFreshness labels the publish age and flags data older than 6 hours', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  const at = (hours) => new Date(now - hours * 3600 * 1000).toISOString()
  assert.equal(dataFreshness(at(0.001), now).label, 'Updated just now')
  assert.equal(dataFreshness(at(0.5), now).label, 'Updated 30 min ago')
  assert.equal(dataFreshness(at(2.5), now).label, 'Updated 2 h ago')
  assert.equal(dataFreshness(at(72), now).label, 'Updated 3 d ago')
  assert.equal(STALE_DATA_MS, 6 * 3600 * 1000)
  assert.equal(dataFreshness(at(6), now).stale, false)
  assert.equal(dataFreshness(at(6.1), now).stale, true)
  assert.equal(dataFreshness(at(7.9), now).hours, 7)
  assert.equal(dataFreshness(at(0.5), now).hours, 0)
  assert.equal(dataFreshness('2026-10-06T11:00:00.123456+00:00', now).label, 'Updated 59 min ago')
  assert.equal(dataFreshness(null, now), null)
  assert.equal(dataFreshness('not a date', now), null)
})

test('staleBannerText shows only for a stale publish', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  assert.equal(staleBannerText(dataFreshness('2026-10-06T05:00:00Z', now)),
    'Job updates are delayed: the last one was 7 h ago. New jobs will appear when they resume.')
  assert.equal(staleBannerText(dataFreshness('2026-10-06T08:00:00Z', now)), null)
  assert.equal(staleBannerText(null), null)
})

test('expiryHint counts down to the first run after UTC midnight of job date + 3 days', () => {
  const at = (iso) => Date.parse(iso)
  // posted Oct 6: deleted from Oct 9 00:00 UTC
  assert.equal(expiryHint({ posted_date: '2026-10-06' }, at('2026-10-07T00:00:00Z')), null) // 72 h left
  assert.deepEqual(expiryHint({ posted_date: '2026-10-06' }, at('2026-10-07T12:00:00Z')), { hours: 36, label: 'Disappears in ~36h' })
  assert.deepEqual(expiryHint({ posted_date: '2026-10-06' }, at('2026-10-08T14:30:00Z')), { hours: 10, label: 'Disappears in ~10h' })
  assert.deepEqual(expiryHint({ posted_date: '2026-10-06' }, at('2026-10-08T23:59:30Z')), { hours: 1, label: 'Disappears in ~1h' })
  assert.deepEqual(expiryHint({ posted_date: '2026-10-06' }, at('2026-10-09T00:00:00Z')), { hours: 0, label: 'Disappears at the next update' })
  // without a posted date the UTC day it was first seen counts (19:00 IST on Oct 6 is Oct 6 UTC; 03:00 IST Oct 7 is Oct 6 UTC)
  assert.equal(expiryHint({ first_seen_at: '2026-10-06T21:30:00Z' }, at('2026-10-08T20:00:00Z')).hours, 4)
  assert.equal(expiryHint({ first_seen_at: '2026-10-06T21:30:00+00:00', posted_date: null }, at('2026-10-08T20:00:00Z')).hours, 4)
  // posted_date wins over first_seen_at
  assert.equal(expiryHint({ posted_date: '2026-10-07', first_seen_at: '2026-10-05T00:00:00Z' }, at('2026-10-08T20:00:00Z')).hours, 28)
  // tracked jobs never expire
  assert.equal(expiryHint({ posted_date: '2026-10-06', is_applied: true }, at('2026-10-08T20:00:00Z')), null)
  assert.equal(expiryHint({ posted_date: '2026-10-06', application_status: 'saved' }, at('2026-10-08T20:00:00Z')), null)
  assert.equal(expiryHint({ posted_date: '2026-10-06', application_status: 'rejected' }, at('2026-10-08T20:00:00Z')), null)
  assert.equal(expiryHint({}, at('2026-10-08T20:00:00Z')), null)
  assert.equal(expiryHint(null), null)
})

test('isExpiring: on its last UTC day (the server rule job_date <= current_date - 2)', () => {
  const at = (iso) => Date.parse(iso)
  const job = { posted_date: '2026-10-06' }
  assert.equal(isExpiring(job, at('2026-10-07T23:59:00Z')), false) // job_date = today - 1
  assert.equal(isExpiring(job, at('2026-10-08T00:00:00Z')), true) // job_date = today - 2: exactly 24 h left
  assert.equal(isExpiring(job, at('2026-10-08T00:00:01Z')), true)
  assert.equal(isExpiring(job, at('2026-10-09T03:00:00Z')), true) // overdue, gone at the next update
  assert.equal(isExpiring({ ...job, application_status: 'saved' }, at('2026-10-08T12:00:00Z')), false)
  assert.equal(isExpiring({}, at('2026-10-08T12:00:00Z')), false)
  assert.equal(nextExpiryAt(at('2026-10-08T12:00:00Z')).toISOString(), '2026-10-09T00:00:00.000Z')
  assert.equal(nextExpiryAt(at('2026-10-08T00:00:00Z')).toISOString(), '2026-10-09T00:00:00.000Z')
  assert.equal(nextExpiryAt(at('2026-12-31T23:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z')
})

test('expiringStripCopy', () => {
  const now = Date.parse('2026-10-08T12:00:00Z')
  const copy = expiringStripCopy({ count: 12, strong: 2, shown: 10 }, now)
  assert.equal(copy.title, 'Expiring tonight · 12 jobs')
  assert.equal(copy.subtitle, `2 strong fits · disappear after ${copy.time}. Save to keep them.`)
  assert.equal(copy.saveAll, 'Save all 10 shown')
  assert.equal(copy.timeTitle, 'At the first update after midnight UTC')
  const one = expiringStripCopy({ count: 1, strong: 1, shown: 1 }, now)
  assert.equal(one.title, 'Expiring tonight · 1 job')
  assert.equal(one.subtitle, `1 strong fit · disappear after ${one.time}. Save to keep them.`)
  assert.equal(one.saveAll, 'Save all')
  assert.equal(expiringStripCopy({ count: 14, strong: 0, shown: 1 }, now).saveAll, 'Save 1 shown')
  assert.equal(expiringStripCopy({ count: 3, strong: 0 }, now).subtitle, `Disappear after ${copy.time}. Save to keep them.`)
})

test('postedAgo: neutral age of a posting', () => {
  const now = new Date(2026, 9, 9, 10, 0).getTime()
  assert.equal(postedAgo({ posted_date: '2026-10-04' }, now), 'Posted 5 days ago')
  assert.equal(postedAgo({ posted_date: '2026-10-08' }, now), 'Posted yesterday')
  assert.equal(postedAgo({ posted_date: '2026-10-09' }, now), 'Posted today')
  assert.equal(postedAgo({ posted_date: '2026-10-10' }, now), 'Posted today')
  assert.equal(postedAgo({ first_seen_at: new Date(2026, 9, 6, 23, 0).toISOString() }, now), 'Found 3 days ago')
  assert.equal(postedAgo({ posted_date: null, first_seen_at: new Date(2026, 9, 9, 1, 0).toISOString() }, now), 'Found today')
  assert.equal(postedAgo({}, now), null)
  assert.equal(postedAgo(null, now), null)
})

test('follow-up labels', () => {
  assert.equal(parseDay('2026-10-12').getDate(), 12)
  assert.equal(parseDay('nope'), null)
  assert.match(followUpDateLabel('2026-10-12'), /^Follow up .*12/)
  assert.equal(followUpDateLabel(null), null)
  assert.equal(followUpTitle({ next_action_at: '2026-10-01' }), 'Follow-up date reached')
  const now = Date.parse('2026-10-20T00:00:00Z')
  assert.equal(followUpTitle({ status_updated_at: '2026-10-01T00:00:00Z' }, now), 'Applied 19 days ago with no update')
})

test('duplicate groups', () => {
  const job = { job_key: 'a', city: 'Pune', dup_count: 3, dup_keys: ['b', 'c', 'a'], dup_locations: ['Pune', 'Hyderabad', 'hyderabad', 'Chennai', 'Delhi'] }
  assert.deepEqual(groupKeys(job), ['a', 'b', 'c'])
  assert.deepEqual(groupKeys({ job_key: 'a' }), ['a'])
  assert.equal(dupLabel(job), '+3 more · Hyderabad, Chennai, Delhi')
  assert.equal(dupLabel({ ...job, dup_locations: ['Pune'] }), '+3 more')
  assert.equal(dupLabel({ dup_count: 0 }), null)
  assert.equal(dupLabel({}), null)
})

test('dupPill: a compact count titled with the other places', () => {
  const job = { city: 'Mumbai', dup_count: 6, dup_locations: ['Pune', 'Navi Mumbai', 'mumbai', 'Chennai', 'Delhi', 'Pune'] }
  assert.deepEqual(dupPill(job), { label: '+6', title: 'Also posted in Pune, Navi Mumbai, Chennai and 3 more' })
  assert.deepEqual(dupPill({ city: 'Pune', dup_count: 2, dup_locations: ['Hyderabad', 'Chennai'] }),
    { label: '+2', title: 'Also posted in Hyderabad and Chennai' })
  assert.deepEqual(dupPill({ city: 'Pune', dup_count: 1, dup_locations: ['Hyderabad'] }), { label: '+1', title: 'Also posted in Hyderabad' })
  assert.deepEqual(dupPill({ city: 'Pune', dup_count: 2, dup_locations: ['Pune'] }), { label: '+2', title: 'Also posted 2 more times' })
  assert.deepEqual(dupPill({ dup_count: 1 }), { label: '+1', title: 'Also posted 1 more time' })
  assert.equal(dupPill({ dup_count: 0 }), null)
  assert.equal(dupPill(null), null)
})

test('placeLabel shows the city and how many more', () => {
  assert.deepEqual(placeLabel({ city: 'Pune', cities: ['Pune', 'Mumbai'], location: 'Pune / Mumbai, India' }), { label: 'Pune +1', title: 'Pune / Mumbai, India' })
  assert.deepEqual(placeLabel({ city: 'Pune', cities: ['Pune'], location: 'Pune' }), { label: 'Pune', title: 'Pune' })
  assert.deepEqual(placeLabel({ cities: [], location: 'India' }), { label: 'India', title: 'India' })
  assert.equal(placeLabel({}), null)
})
