// The fit and validation constants in supabase/app_api.sql (app.c_*() functions) must match the ones the UI uses.
// Values that only the SQL has (the former Netlify Function's tuning) are pinned here; change both together.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Namespace imports: a constant missing from gold.js / entries.js fails its own test, not the whole file
import * as entries from './entries.js'
import * as gold from './gold.js'

const { ENTRY_MAX_LENGTH, PROFILE_LIMITS, entryProblem } = entries
const { FIT_WEIGHTS, MATCH_MIN_FIT, STRONG_FIT } = gold

const SQL = fs.readFileSync(new URL('../../supabase/app_api.sql', import.meta.url), 'utf8')
const SCHEMA = fs.readFileSync(new URL('../../supabase/app_schema.sql', import.meta.url), 'utf8')
const ENTRIES = fs.readFileSync(new URL('./entries.js', import.meta.url), 'utf8')

// app.c_<name>() bodies: "... AS $$ SELECT <value> $$;"
function constants() {
  const found = {}
  const re = /CREATE OR REPLACE FUNCTION app\.c_(\w+)\(\)[^$]*\$\$\s*SELECT\s+([\s\S]*?)\s*\$\$;/g
  for (const [, name, body] of SQL.matchAll(re)) {
    assert.equal(found[name], undefined, `app.c_${name}() is defined twice`)
    found[name] = body
  }
  return found
}

const C = constants()

function number(name) {
  assert.ok(C[name] !== undefined, `app.c_${name}() missing`)
  return Number(C[name].replace(/::\w+$/, ''))
}

function text(name) {
  const match = /^'((?:[^']|'')*)'::text$/.exec(C[name])
  assert.ok(match, `app.c_${name}() is not a text literal`)
  return match[1].replaceAll("''", "'")
}

const quoted = list => [...list.matchAll(/'([^']*)'/g)].map(m => m[1])

function textArray(name) {
  assert.ok(C[name] !== undefined, `app.c_${name}() missing`)
  const match = /^ARRAY\[([\s\S]*)\]::text\[\]$/.exec(C[name])
  assert.ok(match, `app.c_${name}() is not an ARRAY literal`)
  return quoted(match[1])
}

// The values of a CHECK (<column> IN (...)) in app_schema.sql (whole column name: "reason" is not "hide_reason")
function schemaCheck(column) {
  const match = new RegExp(`(?<!\\w)${column} IN \\(([^)]*)\\)`).exec(SCHEMA)
  assert.ok(match, `CHECK on ${column} not found in app_schema.sql`)
  return quoted(match[1])
}

function exported(module, name) {
  assert.ok(module[name] !== undefined, `${name} is not exported`)
  return module[name]
}

test('fit weights and thresholds match gold.js', () => {
  assert.equal(number('fit_weight_role'), FIT_WEIGHTS.role)
  assert.equal(number('fit_weight_skills'), FIT_WEIGHTS.skills)
  assert.equal(number('fit_weight_experience'), FIT_WEIGHTS.experience)
  assert.equal(number('match_min_fit'), MATCH_MIN_FIT)
  assert.equal(number('strong_fit'), STRONG_FIT)
})

test('fit tuning is pinned (formerly in netlify/functions/api/sql.mjs)', () => {
  assert.equal(number('role_sim_floor'), 0.75)
  assert.equal(number('role_sim_match'), 0.86)
  assert.equal(number('role_sim_span'), Number((0.86 - 0.75).toFixed(2)))
  assert.equal(number('role_sim_score'), 0.85)
  assert.equal(number('neutral_skills'), 0.3)
  assert.equal(number('unseen_skill_idf'), 3)
  assert.equal(number('experience_hide_gap'), 2)
  assert.equal(number('max_page_size'), 100)
  assert.equal(number('default_page_size'), 48)
  assert.equal(number('max_bulk_keys'), 100)
  assert.equal(text('mute_word_re'), '^[A-Za-z0-9][A-Za-z0-9 .+#&/-]*$')
})

test('profile limits match entries.js', () => {
  assert.equal(number('max_roles'), PROFILE_LIMITS.roles)
  assert.equal(number('max_skills'), PROFILE_LIMITS.skills)
  assert.equal(number('max_cities'), PROFILE_LIMITS.cities)
  assert.equal(number('entry_max_length'), ENTRY_MAX_LENGTH)
})

test('entry rules match entries.js', () => {
  const entryRe = /const ENTRY_RE = \/(.+)\/\r?\n/.exec(ENTRIES)
  assert.ok(entryRe, 'ENTRY_RE not found in entries.js')
  assert.equal(text('entry_re'), entryRe[1])
  const vagueJs = /const VAGUE = new Set\(\[([\s\S]*?)\]\)/.exec(ENTRIES)
  assert.ok(vagueJs, 'VAGUE not found in entries.js')
  assert.deepEqual(textArray('vague_words'), quoted(vagueJs[1]))
  for (const word of quoted(vagueJs[1])) {
    if (word.length >= 2) assert.match(entryProblem(word), /too general|Use letters/, word)
  }
  // The city rule had no JS copy (sql.mjs CITY_RE); pinned
  assert.equal(text('city_re'), '^[A-Za-z][A-Za-z .-]*$')
})

test('statuses, hide reasons and levels match gold.js', () => {
  assert.deepEqual(textArray('application_statuses'), [...exported(gold, 'APPLICATION_STATUSES')])
  assert.deepEqual(textArray('applied_statuses'), [...exported(gold, 'APPLIED_STATUSES')])
  assert.deepEqual(exported(gold, 'STATUS_OPTIONS').map(option => option.value), textArray('application_statuses'))
  assert.deepEqual(textArray('hide_reasons'), exported(gold, 'HIDE_REASONS').map(reason => reason.value))
  assert.deepEqual(schemaCheck('application_status'), textArray('application_statuses'))
  assert.deepEqual(schemaCheck('hide_reason'), textArray('hide_reasons'))
  assert.deepEqual(schemaCheck('reason'), textArray('hide_reasons')) // app.job_feedback
  const levelYears = exported(gold, 'LEVEL_YEARS')
  assert.deepEqual(textArray('experience_levels'), Object.keys(levelYears))
  // The years: the CASE in app.user_jobs
  const body = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION app.user_jobs'), SQL.indexOf('CREATE OR REPLACE FUNCTION app.filtered_jobs'))
  const sqlYears = Object.fromEntries([...body.matchAll(/WHEN '([^']+)' THEN (\d+)/g)].map(([, level, years]) => [level, Number(years)]))
  assert.deepEqual(sqlYears, levelYears)
})

test('work modes and employment kinds match gold.js', () => {
  const modes = Object.keys(exported(gold, 'WORK_MODE_LABELS')).filter(mode => mode !== 'unknown')
  assert.deepEqual(textArray('work_modes'), modes)
  assert.deepEqual(schemaCheck('work_mode'), modes)
  const kinds = Object.keys(exported(gold, 'EMPLOYMENT_LABELS')).filter(kind => kind !== 'unknown')
  assert.deepEqual(textArray('employment_kinds'), kinds)
  assert.deepEqual(schemaCheck('employment_kind'), kinds)
})

test('also-know skills, follow-up, notes and mute limits match gold.js / entries.js', () => {
  assert.equal(number('also_skill_weight'), exported(gold, 'ALSO_SKILL_WEIGHT'))
  assert.equal(number('follow_up_days'), exported(gold, 'FOLLOW_UP_DAYS'))
  assert.equal(number('max_also_skills'), exported(PROFILE_LIMITS, 'alsoSkills'))
  assert.equal(number('note_max_length'), exported(entries, 'NOTE_MAX_LENGTH'))
  assert.match(SCHEMA, new RegExp(`char_length\\(note\\) <= ${entries.NOTE_MAX_LENGTH}\\)`), 'CHECK on app.user_job_state.note')
  const limits = exported(entries, 'MUTE_LIMITS')
  assert.equal(number('max_muted_companies'), limits.companies)
  assert.equal(number('max_muted_title_words'), limits.titleWords)
  // saveMuteRules: the longest entry per list (string_list) and the title-word rule, as the client checks them
  const lengths = exported(entries, 'MUTE_LENGTHS')
  assert.match(SQL, new RegExp(`app\\.c_max_muted_companies\\(\\), ${lengths.companies[1]}, 'Muted companies'`))
  assert.match(SQL, new RegExp(`app\\.c_max_muted_title_words\\(\\), ${lengths.titleWords[1]}, 'Muted title words'`))
  assert.equal(text('mute_word_re'), exported(entries, 'MUTE_WORD_RE').source)
  assert.equal(number('max_bulk_keys'), exported(gold, 'MAX_BULK_KEYS'))
})

test('the scoring uses the constants, not copies of them', () => {
  const body = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION app.user_jobs'), SQL.indexOf('CREATE OR REPLACE FUNCTION app.filtered_jobs'))
  for (const name of ['fit_weight_role', 'fit_weight_skills', 'fit_weight_experience', 'role_sim_floor', 'role_sim_match',
    'role_sim_span', 'role_sim_score', 'neutral_skills', 'unseen_skill_idf', 'experience_hide_gap', 'also_skill_weight',
    'follow_up_days', 'match_min_fit']) {
    assert.ok(body.includes(`app.c_${name}()`), `app.user_jobs does not use app.c_${name}()`)
  }
  for (const literal of ['0.45', '0.86', '0.75', '0.11']) {
    assert.ok(!new RegExp(`(?<![\\d.])${literal.replace('.', '\\.')}(?!\\d)`).test(body), `app.user_jobs repeats ${literal}`)
  }
})
