import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dataFreshness, dupLabel, expiryHint, followUpDateLabel, followUpTitle, formatDate, formatRelativeAge, groupKeys, isNewJob,
  parseDay, placeLabel,
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

test('isNewJob is true for jobs first seen in the last 2 days', () => {
  assert.equal(isNewJob(hoursAgo(10)), true)
  assert.equal(isNewJob(hoursAgo(49)), false)
  assert.equal(isNewJob(null), false)
})

test('formatDate returns null for missing or invalid dates', () => {
  assert.equal(formatDate(null), null)
  assert.equal(formatDate('nope'), null)
  assert.ok(formatDate('2026-09-29'))
})

test('dataFreshness labels the publish age and flags data older than 12 hours', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  const at = (hours) => new Date(now - hours * 3600 * 1000).toISOString()
  assert.equal(dataFreshness(at(0.001), now).label, 'Updated just now')
  assert.equal(dataFreshness(at(0.5), now).label, 'Updated 30 min ago')
  assert.equal(dataFreshness(at(2.5), now).label, 'Updated 2 h ago')
  assert.equal(dataFreshness(at(72), now).label, 'Updated 3 d ago')
  assert.equal(dataFreshness(at(12), now).stale, false)
  assert.equal(dataFreshness(at(12.1), now).stale, true)
  assert.equal(dataFreshness('2026-10-06T11:00:00.123456+00:00', now).label, 'Updated 59 min ago')
  assert.equal(dataFreshness(null, now), null)
  assert.equal(dataFreshness('not a date', now), null)
})

test('expiryHint counts down to the first run after UTC midnight of job date + 3 days', () => {
  const at = (iso) => Date.parse(iso)
  // posted Oct 6: deleted from Oct 9 00:00 UTC
  assert.equal(expiryHint({ posted_date: '2026-10-06' }, at('2026-10-07T00:00:00Z')), null) // 72 h left
  assert.deepEqual(expiryHint({ posted_date: '2026-10-06' }, at('2026-10-07T12:00:00Z')), { hours: 36, label: 'Expires in ~36h' })
  assert.deepEqual(expiryHint({ posted_date: '2026-10-06' }, at('2026-10-08T14:30:00Z')), { hours: 10, label: 'Expires in ~10h' })
  assert.deepEqual(expiryHint({ posted_date: '2026-10-06' }, at('2026-10-08T23:59:30Z')), { hours: 1, label: 'Expires in ~1h' })
  assert.deepEqual(expiryHint({ posted_date: '2026-10-06' }, at('2026-10-09T00:00:00Z')), { hours: 0, label: 'Expires at the next run' })
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

test('placeLabel shows the city and how many more', () => {
  assert.deepEqual(placeLabel({ city: 'Pune', cities: ['Pune', 'Mumbai'], location: 'Pune / Mumbai, India' }), { label: 'Pune +1', title: 'Pune / Mumbai, India' })
  assert.deepEqual(placeLabel({ city: 'Pune', cities: ['Pune'], location: 'Pune' }), { label: 'Pune', title: 'Pune' })
  assert.deepEqual(placeLabel({ cities: [], location: 'India' }), { label: 'India', title: 'India' })
  assert.equal(placeLabel({}), null)
})
