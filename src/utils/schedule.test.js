import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { PUBLISH_LAG_MINUTES, SCHEDULES, caughtUpText, clockLabel, endOfListText, nextJobsAt, nextStart } from './schedule.js'

const at = (iso) => new Date(iso)

test('the schedules match the workflow cron lines', () => {
  const cron = (file) => /cron:\s*'([^']+)'/.exec(fs.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'))[1]
  assert.equal(cron('linkedin-databricks.yml'), '0 */4 * * *')
  assert.deepEqual(SCHEDULES[0].hours, [0, 4, 8, 12, 16, 20])
  assert.equal(SCHEDULES[0].minute, 0)
  assert.equal(cron('databricks-scrapers.yml'), '7 2,14 * * *')
  assert.deepEqual([SCHEDULES[1].hours, SCHEDULES[1].minute], [[2, 14], 7])
  assert.equal(cron('publish-supabase.yml'), '50 * * * *')
  assert.equal(SCHEDULES[2].hours.length, 24)
  assert.equal(SCHEDULES[2].minute, 50)
})

test('nextStart: the next start after now, today or tomorrow (UTC)', () => {
  assert.equal(nextStart(SCHEDULES[0], at('2026-10-09T05:00:00Z')).toISOString(), '2026-10-09T08:00:00.000Z')
  assert.equal(nextStart(SCHEDULES[0], at('2026-10-09T08:00:00Z')).toISOString(), '2026-10-09T12:00:00.000Z')
  assert.equal(nextStart(SCHEDULES[0], at('2026-10-09T21:00:00Z')).toISOString(), '2026-10-10T00:00:00.000Z')
  assert.equal(nextStart(SCHEDULES[1], at('2026-10-09T14:07:00Z')).toISOString(), '2026-10-10T02:07:00.000Z')
  assert.equal(nextStart({ hours: [], minute: 0 }, at('2026-10-09T00:00:00Z')), null)
})

test('nextJobsAt: the next LinkedIn start whose publish is still ahead, plus the publish lag', () => {
  assert.equal(PUBLISH_LAG_MINUTES, 20)
  assert.equal(nextJobsAt(at('2026-10-09T05:00:00Z')).toISOString(), '2026-10-09T08:20:00.000Z')
  // 08:10: the 08:00 run is still publishing
  assert.equal(nextJobsAt(at('2026-10-09T08:10:00Z')).toISOString(), '2026-10-09T08:20:00.000Z')
  assert.equal(nextJobsAt(at('2026-10-09T08:20:00Z')).toISOString(), '2026-10-09T12:20:00.000Z')
  assert.equal(nextJobsAt(at('2026-10-09T23:59:00Z')).toISOString(), '2026-10-10T00:20:00.000Z')
  // always within the next 4 h 20 min
  for (let minute = 0; minute < 24 * 60; minute += 7) {
    const now = new Date(Date.UTC(2026, 9, 9, 0, minute))
    const ahead = nextJobsAt(now) - now
    assert.ok(ahead > 0 && ahead <= (4 * 60 + 20) * 60_000, now.toISOString())
  }
})

test('caught-up and end-of-list lines', () => {
  const now = at('2026-10-09T05:00:00Z')
  const time = clockLabel(at('2026-10-09T08:20:00Z'))
  assert.match(time, /^\d{1,2}:\d{2}/)
  assert.equal(caughtUpText({ triaged: 3, applied: 1 }, now), `3 triaged, 1 applied today. Next jobs around ${time}.`)
  assert.equal(caughtUpText({ triaged: 2, applied: 0 }, now), `2 triaged, 0 applied today. Next jobs around ${time}.`)
  assert.equal(caughtUpText({ triaged: 0, applied: 0 }, now), `Next jobs around ${time}.`)
  assert.equal(caughtUpText({}, now), `Next jobs around ${time}.`)
  assert.equal(endOfListText(37, 'inbox', now), `That's all 37. Next jobs around ${time}.`)
  assert.equal(endOfListText(5, 'saved', now), "That's all 5")
})
