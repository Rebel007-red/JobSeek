import test from 'node:test'
import assert from 'node:assert/strict'

import { buildTrend, experienceLabel, fitTone, formatDescription, skillBuckets } from './gold.js'

test('fitTone bands scores', () => {
  assert.equal(fitTone(85), 'strong')
  assert.equal(fitTone(55), 'good')
  assert.equal(fitTone(10), 'low')
  assert.equal(fitTone(null), 'none')
})

test('experienceLabel reads gold experience columns', () => {
  assert.equal(experienceLabel({ experience_min_years: 2, experience_max_years: 5 }), '2–5 yrs')
  assert.equal(experienceLabel({ experience_min_years: 3, experience_max_years: null }), '3+ yrs')
  assert.equal(experienceLabel({ experience_min_years: 0, experience_max_years: 1 }), 'Fresher')
  assert.equal(experienceLabel({ experience_level: 'Senior' }), 'Senior')
  assert.equal(experienceLabel({}), null)
})

test('skillBuckets splits job skills into have / missing, case-insensitively', () => {
  const job = { skills: ['Python', 'PySpark', 'Kafka', 'AWS'], fit_matched_skills: ['python', 'Cloud'] }
  const { have, missing, matchedLabels } = skillBuckets(job, ['PySpark'])
  assert.deepEqual(have, ['Python', 'PySpark'])
  assert.deepEqual(missing, ['Kafka', 'AWS'])
  assert.deepEqual(matchedLabels, ['python', 'Cloud'])
})

test('buildTrend fills missing days oldest first', () => {
  const today = new Date(Date.UTC(2026, 8, 29))
  const trend = buildTrend([{ day: '2026-09-28', added: 5, applied: 1 }], 3, today)
  assert.deepEqual(trend.map(day => [day.key, day.added, day.applied]), [
    ['2026-09-27', 0, 0],
    ['2026-09-28', 5, 1],
    ['2026-09-29', 0, 0],
  ])
})

test('formatDescription puts bullets and glued blocks on new lines', () => {
  assert.equal(
    formatDescription('A better working world for all.Join EY today.Scope:Core duties · Support ops • Monitor data'),
    'A better working world for all.\nJoin EY today.\nScope:\nCore duties\n• Support ops\n• Monitor data',
  )
  // versions, URLs, acronyms and normal sentences stay as they are
  assert.equal(formatDescription('Use Node.js 3.5 at careers.bms.com. See U.S. office.'), 'Use Node.js 3.5 at careers.bms.com. See U.S. office.')
  assert.equal(formatDescription(null), '')
})
