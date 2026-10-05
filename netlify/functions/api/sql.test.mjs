import test from 'node:test'
import assert from 'node:assert/strict'

import { FIT_PARTS, MATCH_MIN_FIT } from '../../../src/utils/gold.js'
import { SHARED_ACTIONS, ValidationError, buildFilterWhere, buildStatement, convertValue, isStatementId, toObjects, validateProfile } from './sql.mjs'

const KEY = 'a'.repeat(64)
const USER = { id: '0b6f3c1e-9a2d-4f7b-8c55-1d2e3f4a5b6c', email: 'me@example.com' }
const userParam = { name: 'user_id', value: USER.id, type: 'STRING' }

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

test('empty filters keep the visibility rule and the "For you" scope', () => {
  const { where, parameters } = buildFilterWhere({ q: '  ', minFit: '', maxYears: null })
  assert.equal(parameters.length, 0)
  assert.ok(where.startsWith('(NOT coalesce(is_hidden, false)'))
  assert.ok(where.includes('(is_applied OR (role_match AND fit_score >= 60))'))
})

test('scope=all drops the role / fit threshold', () => {
  const { where } = buildFilterWhere({ scope: 'all' })
  assert.ok(!where.includes('role_match'))
})

test('per-user reads are scoped to the caller and read the per-user view', () => {
  for (const action of ['jobs', 'summary', 'trend', 'facets', 'hiddenJobs', 'profile']) {
    const { statement, parameters } = buildStatement(action, {}, USER)
    assert.deepEqual(parameters[0], userParam, action)
    assert.ok(statement.includes(':user_id'), action)
  }
  const { statement } = buildStatement('jobs', {}, USER)
  assert.ok(statement.includes('FROM user_jobs'))
  assert.ok(statement.includes('WHERE profile_id = :user_id'))
  assert.ok(statement.includes('WHERE user_id = :user_id'))
})

test('per-user actions need a verified user id', () => {
  assert.throws(() => buildStatement('jobs', {}, null), ValidationError)
  assert.throws(() => buildStatement('profile', {}, { id: "x' OR '1'='1" }), ValidationError)
  assert.throws(() => buildStatement('setHidden', { jobKey: KEY, hidden: true }, {}), ValidationError)
})

test('shared reads do not depend on the user', () => {
  assert.ok(SHARED_ACTIONS.has('refs') && SHARED_ACTIONS.has('job') && !SHARED_ACTIONS.has('jobs'))
  assert.deepEqual(buildStatement('refs').parameters, [])
  assert.ok(buildStatement('refs').statement.includes('FROM ops.ref_roles WHERE in_scope'))
})

test('jobs statement clamps paging and falls back to fit sort', () => {
  const { statement } = buildStatement('jobs', { limit: 5000, offset: -3, sort: 'DROP TABLE' }, USER)
  assert.match(statement, /LIMIT 100 OFFSET 0$/)
  assert.match(statement, /ORDER BY fit_score DESC NULLS LAST/)
})

test('summary ignores the tab so tab counts stay stable', () => {
  const { statement } = buildStatement('summary', { tab: 'applied', role: 'Data Engineer' }, USER)
  assert.ok(statement.includes('role_title = :role'))
  assert.ok(!statement.includes('AND coalesce(is_applied, false)) AS total'))
})

test('mutations validate job keys and booleans and only touch the caller rows', () => {
  assert.throws(() => buildStatement('setApplied', { jobKey: "1' OR '1'='1", applied: true }, USER), ValidationError)
  assert.throws(() => buildStatement('setHidden', { jobKey: KEY, hidden: 'yes' }, USER), ValidationError)
  const { statement, parameters } = buildStatement('setHidden', { jobKey: KEY, hidden: true }, USER)
  assert.ok(statement.startsWith('MERGE INTO gold.user_job_state t'))
  assert.ok(statement.includes('ON t.user_id = s.user_id AND t.job_key = s.job_key'))
  assert.deepEqual(parameters, [
    userParam,
    { name: 'job_key', value: KEY, type: 'STRING' },
    { name: 'hidden', value: 'true', type: 'BOOLEAN' },
  ])
  const restore = buildStatement('restoreHidden', {}, USER)
  assert.ok(restore.statement.includes('WHERE user_id = :user_id'))
})

test('unknown and prototype actions are rejected', () => {
  assert.throws(() => buildStatement('dropEverything'), ValidationError)
  assert.throws(() => buildStatement('toString'), ValidationError)
  assert.throws(() => buildStatement('__proto__'), ValidationError)
})

test('profile validation trims, de-duplicates, enforces 1-2 roles and 1-5 skills', () => {
  const profile = validateProfile({
    target_roles: [' Data Engineer ', 'data engineer', ''],
    skills: ['SQL', 'Python'],
    min_years: '2',
    max_years: 4,
  })
  assert.deepEqual(profile.target_roles, ['Data Engineer'])
  assert.equal(profile.min_years, 2)
  assert.throws(() => validateProfile({ ...profile, min_years: 5, max_years: 2 }), /Minimum years/)
  assert.throws(() => validateProfile({ ...profile, target_roles: ['A', 'B', 'C'] }), /at most 2/)
  assert.throws(() => validateProfile({ ...profile, skills: ['a', 'b', 'c', 'd', 'e', 'f'] }), /at most 5/)
  assert.throws(() => validateProfile({ ...profile, target_roles: [] }), /at least one role/)
  assert.throws(() => validateProfile({ ...profile, skills: [] }), /at least one skill/)
})

test('typed roles and skills are allowed when they look like real names', () => {
  const profile = validateProfile({ target_roles: ['OCI Cloud Admin'], skills: ['C++', '.NET', 'CI/CD', 'Node.js'] })
  assert.deepEqual(profile.skills, ['C++', '.NET', 'CI/CD', 'Node.js'])
  assert.throws(() => validateProfile({ target_roles: ["Data Engineer'; DROP"], skills: ['SQL'] }), /letters, numbers/)
  assert.throws(() => validateProfile({ target_roles: ['Data Engineer'], skills: ['communication'] }), /too general/)
  assert.throws(() => validateProfile({ target_roles: ['Data Engineer'], skills: ['x'.repeat(61)] }), /longer than 60/)
})

test('saveProfile writes only the caller row and rejects roles known to be out of scope', () => {
  const { statement, parameters } = buildStatement('saveProfile', {
    target_roles: ['Data Engineer'], skills: ['SQL'], min_years: null, max_years: 4,
  }, USER)
  assert.ok(statement.includes('SELECT :user_id AS profile_id'))
  assert.ok(statement.includes('FROM ops.ref_roles WHERE NOT in_scope'))
  assert.ok(statement.includes("FROM ops.custom_roles WHERE status = 'rejected'"))
  assert.ok(statement.includes("'We only support data, full stack, backend, DevOps and cloud roles'"))
  assert.deepEqual(parameters[0], userParam)
  assert.deepEqual(parameters.find(p => p.name === 'email'), { name: 'email', value: USER.email, type: 'STRING' })
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

test('fit score uses the weights and "For you" threshold the UI shows', () => {
  const { statement } = buildStatement('jobs', {}, USER)
  const sum = FIT_PARTS.map(part => `${part.weight} * ${part.key}`).join(' + ')
  assert.ok(statement.includes(`CAST(round(100 * (${sum})) AS INT) AS fit_score`))
  assert.ok(statement.includes(`fit_score >= ${MATCH_MIN_FIT})`))
})
