import test from 'node:test'
import assert from 'node:assert/strict'

import { formatDate, formatRelativeAge, isNewJob } from './job.js'

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
