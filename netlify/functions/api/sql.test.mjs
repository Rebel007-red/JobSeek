import test from 'node:test'
import assert from 'node:assert/strict'

import { ValidationError, buildFilterWhere, buildStatement, convertValue, isStatementId, toObjects, validateProfile } from './sql.mjs'

const KEY = 'a'.repeat(64)

test('filters become named parameters, never SQL text', () => {
  const injection = "x' OR 1=1 --"
  const { where, parameters } = buildFilterWhere({ q: injection, role: injection, minFit: '70', maxYears: 3, tab: 'pending' })
  assert.ok(!where.includes(injection))
  assert.ok(where.includes(':q') && where.includes(':role') && where.includes(':min_fit') && where.includes(':max_years'))
  assert.ok(where.includes('NOT coalesce(is_applied, false)'))
  assert.deepEqual(parameters.find(p => p.name === 'q'), { name: 'q', value: injection.toLowerCase(), type: 'STRING' })
  assert.deepEqual(parameters.find(p => p.name === 'min_fit'), { name: 'min_fit', value: '70', type: 'INT' })
})

test('freshness filter is in hours and never hides applied jobs', () => {
  const { where, parameters } = buildFilterWhere({ postedWithin: '24' })
  assert.ok(where.includes('coalesce(is_applied, false) OR CASE'))
  assert.ok(where.includes(':posted_within_hours'))
  assert.deepEqual(parameters, [{ name: 'posted_within_hours', value: '24', type: 'INT' }])
  assert.equal(buildFilterWhere({ postedWithin: '' }).parameters.length, 0)
})

test('empty filters only keep the visibility rule', () => {
  const { where, parameters } = buildFilterWhere({ q: '  ', minFit: '', maxYears: null })
  assert.equal(parameters.length, 0)
  assert.ok(where.startsWith('(NOT coalesce(is_hidden, false)'))
})

test('jobs statement clamps paging and falls back to fit sort', () => {
  const { statement } = buildStatement('jobs', { limit: 5000, offset: -3, sort: 'DROP TABLE' })
  assert.match(statement, /LIMIT 100 OFFSET 0$/)
  assert.match(statement, /ORDER BY fit_score DESC NULLS LAST/)
})

test('summary ignores the tab so tab counts stay stable', () => {
  const { statement } = buildStatement('summary', { tab: 'applied', role: 'Data Engineer' })
  assert.ok(statement.includes('role_title = :role'))
  assert.ok(!statement.includes('AND coalesce(is_applied, false)) AS total'))
})

test('mutations validate job keys and booleans', () => {
  assert.throws(() => buildStatement('setApplied', { jobKey: "1' OR '1'='1", applied: true }), ValidationError)
  assert.throws(() => buildStatement('setHidden', { jobKey: KEY, hidden: 'yes' }), ValidationError)
  const { parameters } = buildStatement('setHidden', { jobKey: KEY, hidden: true })
  assert.deepEqual(parameters, [
    { name: 'job_key', value: KEY, type: 'STRING' },
    { name: 'hidden', value: 'true', type: 'BOOLEAN' },
  ])
})

test('unknown and prototype actions are rejected', () => {
  assert.throws(() => buildStatement('dropEverything'), ValidationError)
  assert.throws(() => buildStatement('toString'), ValidationError)
  assert.throws(() => buildStatement('__proto__'), ValidationError)
})

test('profile validation trims, de-duplicates and checks ranges', () => {
  const profile = validateProfile({
    target_roles: [' Data Engineer ', 'data engineer', ''],
    skills: ['SQL', 'Python'],
    preferred_cities: [],
    min_years: '2',
    max_years: 4,
    weight_role: 0.4, weight_skills: 0.35, weight_experience: 0.15, weight_location: 0.1,
  })
  assert.deepEqual(profile.target_roles, ['Data Engineer'])
  assert.equal(profile.min_years, 2)
  assert.throws(() => validateProfile({ ...profile, min_years: 5, max_years: 2 }), /Minimum years/)
  assert.throws(() => validateProfile({ ...profile, weight_role: 2 }), /between 0 and 1/)
  assert.throws(() => validateProfile({ ...profile, weight_role: 0, weight_skills: 0, weight_experience: 0, weight_location: 0 }), /At least one/)
})

test('saveProfile sends arrays as JSON parameters and nulls without a value', () => {
  const { parameters } = buildStatement('saveProfile', {
    target_roles: ['Data Engineer'], skills: [], preferred_cities: ['Hyderabad'],
    min_years: null, max_years: 4,
    weight_role: 0.4, weight_skills: 0.35, weight_experience: 0.15, weight_location: 0.1,
  })
  assert.deepEqual(parameters.find(p => p.name === 'target_roles'), { name: 'target_roles', value: '["Data Engineer"]', type: 'STRING' })
  assert.deepEqual(parameters.find(p => p.name === 'min_years'), { name: 'min_years', type: 'INT' })
})

test('result conversion follows column types', () => {
  assert.equal(convertValue('42', 'INT'), 42)
  assert.equal(convertValue('true', 'BOOLEAN'), true)
  assert.deepEqual(convertValue('["SQL","Python"]', 'ARRAY'), ['SQL', 'Python'])
  assert.equal(convertValue(null, 'STRING'), null)
  assert.deepEqual(
    toObjects([{ name: 'fit_score', type_name: 'INT' }, { name: 'title', type_name: 'STRING' }], [['81', 'Data Engineer']]),
    [{ fit_score: 81, title: 'Data Engineer' }],
  )
})

test('statement ids are validated before polling', () => {
  assert.ok(isStatementId('01ef1234-5678-9abc-def0-123456789abc'))
  assert.ok(!isStatementId('../../jobs/delete'))
})
