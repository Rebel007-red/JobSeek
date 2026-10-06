import test from 'node:test'
import assert from 'node:assert/strict'

import { FIT_PARTS, FIT_WEIGHTS, MATCH_MIN_FIT, STRONG_FIT } from '../../../src/utils/gold.js'
import {
  FIT_TUNING, SHARED_ACTIONS, ValidationError, buildFilterWhere, buildStatement, convertValue, isStatementId, missingPipelineTable, toObjects,
  validateProfile, withoutPipelineTables,
} from './sql.mjs'

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
  assert.ok(where.includes('(is_applied OR (role_match AND fit_score >= 60 AND NOT above_experience))'))
})

test('scope=all drops the role / fit threshold and the experience gap', () => {
  const { where } = buildFilterWhere({ scope: 'all' })
  assert.ok(!where.includes('role_match'))
  assert.ok(!where.includes('above_experience'))
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
  assert.match(statement, /ORDER BY fit_score DESC NULLS LAST, role_score DESC NULLS LAST, coalesce\(posted_date, to_date\(first_seen_at\)\) DESC NULLS LAST, job_key/)
})

test('summary ignores the tab so tab counts stay stable', () => {
  const { statement } = buildStatement('summary', { tab: 'applied', role: 'Data Engineer' }, USER)
  assert.ok(statement.includes('role_title = :role'))
  assert.ok(!statement.includes('AND coalesce(is_applied, false)) AS total'))
  assert.ok(statement.includes(`coalesce(fit_score, 0) >= ${STRONG_FIT}) AS strong_fit`))
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
  assert.ok(statement.includes(`(role_match AND fit_score >= ${MATCH_MIN_FIT} AND NOT above_experience)`))
})

test('role fit: your roles first, then embedding similarity, with the category fallback before the pipeline ran', () => {
  const { statement } = buildStatement('jobs', {}, USER)
  assert.ok(statement.includes('FROM ops.role_similarity s\n    JOIN profile p ON array_contains(p.roles, s.role_a)'))
  // the 2nd role keeps its 0.95 rank weight on related roles: 0.85 * clamp((sim - 0.75) / 0.11, 0, 1)
  assert.ok(statement.includes('max(CASE WHEN array_position(p.roles, s.role_a) = 1 THEN 1.0 ELSE 0.95 END\n        * 0.85 * least(1.0, greatest(0.0, (s.sim - 0.75) / 0.11)))'))
  assert.ok(statement.includes('WHEN role_rank = 1 THEN 1.0\n      WHEN role_rank > 1 THEN 0.95'))
  assert.ok(statement.includes('WHEN related_ready THEN coalesce(related.score, 0.0)\n      WHEN alternative_is_role THEN 0.5\n      WHEN category_is_role THEN 0.3'))
  assert.ok(statement.includes('WHEN related_ready THEN coalesce(related.sim >= 0.86, false)\n      ELSE alternative_is_role OR category_is_role'))
  assert.ok(statement.includes('SELECT count(*) > 0 AS ready'))
})

test('related-role ramp reaches its full score exactly where a related role starts to match', () => {
  const { ROLE_SIM_FLOOR, ROLE_SIM_MATCH, ROLE_SIM_SPAN } = FIT_TUNING
  assert.ok(ROLE_SIM_FLOOR < ROLE_SIM_MATCH && ROLE_SIM_MATCH < 1)
  assert.equal(ROLE_SIM_SPAN, Number((ROLE_SIM_MATCH - ROLE_SIM_FLOOR).toFixed(2)))
  // a short literal in the SQL, not 0.10999999999999999
  assert.ok(String(ROLE_SIM_SPAN).length <= 4)
})

test('skill fit: rarity-weighted, out of at least 3 skills, neutral for jobs without skills', () => {
  const { statement } = buildStatement('jobs', {}, USER)
  assert.ok(statement.includes('FROM ops.skill_stats'))
  assert.ok(statement.includes('coalesce(try_element_at(si.m, lower(s)), 3)'))
  assert.ok(statement.includes('greatest(3, size(skill_weights)) / greatest(1, size(skill_weights))'))
  assert.ok(statement.includes('WHEN NOT has_profile_skills THEN 0.0\n      WHEN no_job_skills THEN 0.3'))
  assert.ok(statement.includes('least(1.0, aggregate(matched_weights, 0D, (total, ps) -> total + ps.idf) / skill_idf_total)'))
  // the matched list is still profile labels
  assert.ok(statement.includes('coalesce(transform(matched_weights, ps -> ps.skill), CAST(array() AS ARRAY<STRING>)) AS fit_matched_skills'))
})

test('a job with no skills found can be "For you" but never a strong fit', () => {
  const fit = (role, skills, experience) =>
    Math.round(100 * (FIT_WEIGHTS.role * role + FIT_WEIGHTS.skills * skills + FIT_WEIGHTS.experience * experience))
  const { NEUTRAL_SKILLS } = FIT_TUNING
  // your first role with the best experience score still stays below STRONG_FIT without skill evidence
  assert.ok(fit(1, NEUTRAL_SKILLS, 1) < STRONG_FIT)
  // your first role with unknown experience (0.7) is still "For you"
  assert.ok(fit(1, NEUTRAL_SKILLS, 0.7) >= MATCH_MIN_FIT)
})

test('experience fit uses both ends of the profile range and the level when years are unknown', () => {
  const { statement } = buildStatement('jobs', {}, USER)
  assert.ok(statement.includes('coalesce(j.experience_min_years, CASE j.experience_level'))
  assert.ok(statement.includes("WHEN 'Senior' THEN 5"))
  assert.ok(statement.includes('coalesce(j.experience_max_years, j.experience_min_years + 3,'))
  assert.ok(statement.includes('WHEN exp_min > profile_max_years THEN greatest(0.0, 1.0 - 0.3 * (exp_min - profile_max_years))'))
  assert.ok(statement.includes('WHEN exp_top < profile_min_years THEN greatest(0.5, 1.0 - 0.15 * (profile_min_years - exp_top))'))
  // "For you" hides jobs asking for more than 2 years above your maximum
  assert.ok(statement.includes('coalesce(j.experience_min_years > p.max_years + 2, false) AS above_experience'))
  assert.ok(statement.includes('AND NOT above_experience'))
})

test('profile and refs carry preferred cities', () => {
  assert.ok(buildStatement('profile', {}, USER).statement.includes('preferred_cities'))
  const refs = buildStatement('refs').statement
  assert.ok(refs.includes("SELECT 'city', city, max(state), collect_set(lower(alias)) FROM ops.ref_india_locations"))
  assert.ok(refs.includes("city <> 'India'"))
})

test('preferred cities: optional, at most 3, names only, checked against the city list in SQL', () => {
  const base = { target_roles: ['Data Engineer'], skills: ['SQL'] }
  assert.equal(validateProfile(base).preferred_cities, null)
  assert.deepEqual(validateProfile({ ...base, preferred_cities: [' Pune ', 'pune', 'Navi Mumbai'] }).preferred_cities, ['Pune', 'Navi Mumbai'])
  assert.throws(() => validateProfile({ ...base, preferred_cities: ['Pune', 'Delhi', 'Noida', 'Goa'] }), /at most 3/)
  assert.throws(() => validateProfile({ ...base, preferred_cities: ["Pune'; DROP"] }), /not a city name/)
  assert.throws(() => validateProfile({ ...base, preferred_cities: 'Pune' }), /must be a list/)

  const saved = buildStatement('saveProfile', { ...base, preferred_cities: ['Bangalore'] }, USER)
  assert.ok(saved.statement.includes('FROM ops.ref_india_locations'))
  assert.ok(saved.statement.includes("'Preferred cities: pick Indian cities from the list'"))
  assert.ok(saved.statement.includes('preferred_cities = coalesce(s.preferred_cities, t.preferred_cities)'))
  assert.deepEqual(saved.parameters.find(p => p.name === 'preferred_cities'), { name: 'preferred_cities', value: '["Bangalore"]', type: 'STRING' })

  // an older client that does not send cities keeps the saved ones (NULL parameter)
  const older = buildStatement('saveProfile', base, USER)
  assert.deepEqual(older.parameters.find(p => p.name === 'preferred_cities'), { name: 'preferred_cities', type: 'STRING' })
})

test('missing fit tables (before 01_setup) are replaced by empty relations with the same columns', () => {
  assert.ok(missingPipelineTable('[TABLE_OR_VIEW_NOT_FOUND] The table or view `ops`.`role_similarity` cannot be found.'))
  assert.ok(!missingPipelineTable('[TABLE_OR_VIEW_NOT_FOUND] The table or view `gold`.`jobs` cannot be found.'))
  assert.ok(!missingPipelineTable(undefined))
  const statement = withoutPipelineTables(buildStatement('jobs', {}, USER).statement)
  assert.ok(!statement.includes('ops.role_similarity') && !statement.includes('ops.skill_stats'))
  assert.ok(statement.includes('CAST(NULL AS DOUBLE) AS sim WHERE false) s'))
  assert.ok(statement.includes('CAST(NULL AS DOUBLE) AS idf WHERE false) WHERE skill IS NOT NULL'))
})
