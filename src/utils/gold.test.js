import test from 'node:test'
import assert from 'node:assert/strict'

import {
  APPLICATION_STATUSES, APPLIED_STATUSES, EXPERIENCE_LEVELS, FIT_PARTS, FIT_WEIGHTS, HIDE_REASONS, LEVEL_YEARS, STATUS_OPTIONS, STRONG_FIT,
  buildTrend, companyKey, experienceLabel, fitTone, formatDescription, isApplied, isTracked, jobUrl, profileSkillList, skillBuckets,
} from './gold.js'

test('fitTone bands scores', () => {
  assert.equal(fitTone(85), 'strong')
  assert.equal(fitTone(55), 'good')
  assert.equal(fitTone(10), 'low')
  assert.equal(fitTone(null), 'none')
  assert.equal(fitTone(STRONG_FIT), 'strong')
  assert.equal(fitTone(STRONG_FIT - 1), 'good')
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

test('fit weights add up to 1 and every part has one', () => {
  const total = Object.values(FIT_WEIGHTS).reduce((sum, weight) => sum + weight, 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
  assert.deepEqual(FIT_PARTS.map(part => part.weight), Object.values(FIT_WEIGHTS))
})

test('statuses: applied ones are a subset, every status has a label', () => {
  assert.deepEqual(STATUS_OPTIONS.map(option => option.value), APPLICATION_STATUSES)
  assert.deepEqual(STATUS_OPTIONS.map(option => option.label), ['Not applied', 'Saved', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn'])
  assert.ok(APPLIED_STATUSES.every(status => APPLICATION_STATUSES.includes(status)))
  assert.deepEqual(HIDE_REASONS.map(reason => reason.value), ['too_senior', 'wrong_role', 'company', 'location', 'duplicate', 'other'])
  assert.deepEqual(EXPERIENCE_LEVELS, Object.keys(LEVEL_YEARS))
  assert.equal(LEVEL_YEARS.Senior, 5)
})

test('isTracked: applied (any stage) or saved', () => {
  assert.equal(isTracked({ is_applied: true }), true)
  assert.equal(isTracked({ application_status: 'saved' }), true)
  assert.equal(isTracked({ application_status: 'offer', is_applied: true }), true)
  assert.equal(isTracked({ application_status: 'not_applied', is_applied: false }), false)
  assert.equal(isTracked({}), false)
  assert.equal(isTracked(null), false)
  assert.equal(isApplied({ application_status: 'saved' }), false)
  assert.equal(isApplied({ application_status: 'rejected' }), true)
})

test('profileSkillList: core skills then also-know, no repeats', () => {
  assert.deepEqual(profileSkillList({ skills: ['Python', 'SQL'], also_skills: ['sql', 'Kafka', ' Kafka '] }), ['Python', 'SQL', 'Kafka'])
  assert.deepEqual(profileSkillList(null), [])
})

test('companyKey matches app.company_key', () => {
  const cases = {
    Barclays: 'barclay',
    Barclay: 'barclay',
    'PwC India': 'pwc',
    PWC: 'pwc',
    'WSP in India': 'wsp',
    'Hewlett Packard Enterprise': 'hpe',
    HPE: 'hpe',
    'Centotech Services Private Limited': 'centotech service',
    India: '',
    'Ernst & Young': 'ey',
    PricewaterhouseCoopers: 'pwc',
    'Tata Consultancy Services': 'tcs',
    'Access': 'access',
  }
  for (const [name, key] of Object.entries(cases)) assert.equal(companyKey(name), key, name)
  assert.equal(companyKey(null), '')
})

test('jobUrl allows only http(s) links', () => {
  assert.equal(jobUrl({ job_url: 'https://x.test/jobs/1' }), 'https://x.test/jobs/1')
  assert.equal(jobUrl({ job_url: ' http://x.test ' }), 'http://x.test')
  for (const job_url of ['#', '', null, 'javascript:alert(1)', 'data:text/html,x', '//x.test', 'ftp://x.test']) {
    assert.equal(jobUrl({ job_url }), null, String(job_url))
  }
  assert.equal(jobUrl(null), null)
})
