import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { PUBLISH_LAG_MINUTES, SCHEDULES, caughtUpText, clockLabel, endOfListText, nextJobsAt, nextStart } from './schedule.js'

const at = (iso) => new Date(iso)

test('the schedules match the workflow cron lines', () => {
  const read = (file) => fs.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8')
  const cron = (file) => /cron:\s*'([^']+)'/.exec(read(file))?.[1] ?? null
  assert.equal(cron('databricks-scrapers.yml'), '7 0,6,12,18 * * *')
  assert.deepEqual(SCHEDULES[0].hours, [0, 6, 12, 18])
  assert.equal(SCHEDULES[0].minute, 7)
  assert.equal(cron('publish-supabase.yml'), '50 * * * *')
  assert.equal(SCHEDULES[1].hours.length, 24)
  assert.equal(SCHEDULES[1].minute, 50)
  assert.equal(SCHEDULES.length, 2)
  // LinkedIn is run by hand only: no schedule to show
  assert.equal(cron('linkedin-databricks.yml'), null)
  assert.match(read('linkedin-databricks.yml'), /workflow_dispatch/)
})

test('nextStart: the next start after now, today or tomorrow (UTC)', () => {
  assert.equal(nextStart(SCHEDULES[0], at('2026-10-09T05:00:00Z')).toISOString(), '2026-10-09T06:07:00.000Z')
  assert.equal(nextStart(SCHEDULES[0], at('2026-10-09T06:07:00Z')).toISOString(), '2026-10-09T12:07:00.000Z')
  assert.equal(nextStart(SCHEDULES[0], at('2026-10-09T21:00:00Z')).toISOString(), '2026-10-10T00:07:00.000Z')
  assert.equal(nextStart(SCHEDULES[1], at('2026-10-09T14:50:00Z')).toISOString(), '2026-10-09T15:50:00.000Z')
  assert.equal(nextStart({ hours: [], minute: 0 }, at('2026-10-09T00:00:00Z')), null)
})

test('nextJobsAt: the next board-scrape start whose publish is still ahead, plus the publish lag', () => {
  assert.equal(PUBLISH_LAG_MINUTES, 120)
  assert.equal(nextJobsAt(at('2026-10-09T05:00:00Z')).toISOString(), '2026-10-09T08:07:00.000Z')  // the 06:07 run
  // 07:30: the 06:07 run is still publishing
  assert.equal(nextJobsAt(at('2026-10-09T07:30:00Z')).toISOString(), '2026-10-09T08:07:00.000Z')
  assert.equal(nextJobsAt(at('2026-10-09T08:07:00Z')).toISOString(), '2026-10-09T14:07:00.000Z')
  assert.equal(nextJobsAt(at('2026-10-09T23:59:00Z')).toISOString(), '2026-10-10T02:07:00.000Z')
  // always within the next 6 h
  for (let minute = 0; minute < 24 * 60; minute += 7) {
    const now = new Date(Date.UTC(2026, 9, 9, 0, minute))
    const ahead = nextJobsAt(now) - now
    assert.ok(ahead > 0 && ahead <= 6 * 60 * 60_000, now.toISOString())
  }
})

test('caught-up and end-of-list lines', () => {
  const now = at('2026-10-09T05:00:00Z')
  const time = clockLabel(at('2026-10-09T08:07:00Z'))
  assert.match(time, /^\d{1,2}:\d{2}/)
  assert.equal(caughtUpText({ triaged: 3, applied: 1 }, now), `3 triaged, 1 applied today. Next jobs around ${time}.`)
  assert.equal(caughtUpText({ triaged: 2, applied: 0 }, now), `2 triaged, 0 applied today. Next jobs around ${time}.`)
  assert.equal(caughtUpText({ triaged: 0, applied: 0 }, now), `Next jobs around ${time}.`)
  assert.equal(caughtUpText({}, now), `Next jobs around ${time}.`)
  assert.equal(endOfListText(37, 'inbox', now), `That's all 37. Next jobs around ${time}.`)
  assert.equal(endOfListText(5, 'saved', now), "That's all 5")
})
