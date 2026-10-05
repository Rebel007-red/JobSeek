// Fixed, parameterised SQL for the Databricks SQL Statement API.
// Only values travel as named parameters; clause text is chosen from this file, never from the request.
// Every per-user statement is scoped by :user_id, which comes from the verified Supabase session, never from the request body.
import { ENTRY_MAX_LENGTH, PROFILE_LIMITS, entryProblem } from '../../../src/utils/entries.js'
import { FIT_WEIGHTS, MATCH_MIN_FIT } from '../../../src/utils/gold.js'

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

// Visible = not hidden, and either still active or something you applied to (applied jobs stay after expiry).
const VISIBLE_SQL = 'NOT coalesce(is_hidden, false) AND (coalesce(is_active, true) OR coalesce(is_applied, false))'
// Applied jobs always count as yours, so the Applied tab keeps your history.
const MATCH_SQL = `(is_applied OR (role_match AND fit_score >= ${MATCH_MIN_FIT}))`

const JOB_DATE_SQL = 'coalesce(posted_date, to_date(first_seen_at))'

// gold.jobs as seen by one user: their applied/hidden flags (gold.user_job_state) and a fit score from their
// profile (ops.user_profile). A missing profile scores every job 0 on role and skills.
// Roles users typed themselves (ops.custom_roles, checked by 04_enrich): 'mapped' ones count as the existing role they
// duplicate; 'active' ones are matched like reference roles. Until then a job whose title contains the role text counts.
const USER_JOBS_CTE = `WITH role_map AS (
  SELECT map_from_entries(collect_list(struct(lower(role_title), duplicate_of))) AS m
  FROM ops.custom_roles
  WHERE status = 'mapped' AND duplicate_of IS NOT NULL
),
profile AS (
  SELECT transform(target_roles, r -> coalesce(try_element_at(rm.m, lower(r)), r)) AS roles, skills AS profile_skills, max_years
  FROM ops.user_profile
  CROSS JOIN role_map rm
  WHERE profile_id = :user_id
  LIMIT 1
),
role_categories AS (
  SELECT collect_set(r.category) AS categories
  FROM (
    SELECT role_title, category FROM ops.ref_roles
    UNION ALL SELECT role_title, category FROM ops.custom_roles WHERE status = 'active'
  ) r
  JOIN profile p ON array_contains(p.roles, r.role_title)
),
state AS (
  SELECT job_key, is_applied, applied_at, is_hidden, hidden_at
  FROM gold.user_job_state
  WHERE user_id = :user_id
),
scored AS (
  SELECT
    j.job_key, j.source, j.company_name, j.title, j.location, j.posted_date, j.job_url,
    j.seniority_level, j.employment_type, j.experience_min_years, j.experience_max_years, j.experience_level,
    j.skills, j.category, j.role_title, j.role_score, j.role_alternative,
    j.first_seen_at, j.last_seen_at, j.times_seen, j.is_active,
    coalesce(st.is_applied, false) AS is_applied, st.applied_at,
    coalesce(st.is_hidden, false) AS is_hidden, st.hidden_at,
    CASE
      WHEN array_position(p.roles, j.role_title) = 1 THEN 1.0
      WHEN array_position(p.roles, j.role_title) > 1 THEN 0.95
      WHEN exists(p.roles, r -> contains(lower(j.title), lower(r))) THEN 0.9
      WHEN array_contains(p.roles, j.role_alternative) THEN 0.5
      WHEN array_contains(c.categories, j.category) THEN 0.3
      ELSE 0.0
    END AS fit_role,
    coalesce(
      filter(p.profile_skills, ps -> exists(j.skills, js -> lower(js) = lower(ps)) OR array_contains(j.skill_groups, ps)),
      CAST(array() AS ARRAY<STRING>)
    ) AS fit_matched_skills,
    greatest(1, least(coalesce(size(p.profile_skills), 0), 5)) AS skill_denominator,
    CASE
      WHEN j.experience_min_years IS NULL THEN 0.7
      WHEN p.max_years IS NULL OR j.experience_min_years <= p.max_years THEN 1.0
      ELSE greatest(0.0, 1.0 - 0.25 * (j.experience_min_years - p.max_years))
    END AS fit_experience,
    coalesce(array_contains(p.roles, j.role_title), false)
      OR coalesce(array_contains(p.roles, j.role_alternative), false)
      OR coalesce(array_contains(c.categories, j.category), false)
      OR coalesce(exists(p.roles, r -> contains(lower(j.title), lower(r))), false) AS role_match
  FROM gold.jobs j
  LEFT JOIN state st ON st.job_key = j.job_key
  LEFT JOIN profile p ON true
  CROSS JOIN role_categories c
),
skills_scored AS (
  SELECT *, least(1.0, size(fit_matched_skills) / skill_denominator) AS fit_skills
  FROM scored
),
user_jobs AS (
  SELECT *,
    CAST(round(100 * (${FIT_WEIGHTS.role} * fit_role + ${FIT_WEIGHTS.skills} * fit_skills + ${FIT_WEIGHTS.experience} * fit_experience)) AS INT) AS fit_score
  FROM skills_scored
)`

const LIST_COLUMNS = `job_key, source, company_name, title, location, posted_date, job_url,
  seniority_level, employment_type, experience_min_years, experience_max_years, experience_level,
  skills, category, role_title, role_score, role_alternative, role_match,
  fit_score, fit_role, fit_skills, fit_experience, fit_matched_skills,
  first_seen_at, last_seen_at, times_seen, is_applied, applied_at`

const SORTS = {
  fit: `fit_score DESC NULLS LAST, ${JOB_DATE_SQL} DESC NULLS LAST, job_key`,
  recent: `${JOB_DATE_SQL} DESC NULLS LAST, fit_score DESC NULLS LAST, job_key`,
  found: 'first_seen_at DESC NULLS LAST, fit_score DESC NULLS LAST, job_key',
}

const JOB_KEY_RE = /^[0-9a-f]{64}$/
const STATEMENT_ID_RE = /^[0-9a-zA-Z-]{16,64}$/
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PAGE_SIZE = 100

export function isStatementId(value) {
  return typeof value === 'string' && STATEMENT_ID_RE.test(value)
}

function text(value, max = 100) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function int(value, min, max) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(Math.max(Math.trunc(number), min), max)
}

function jobKey(value) {
  if (typeof value !== 'string' || !JOB_KEY_RE.test(value)) throw new ValidationError('Invalid job key')
  return value
}

function bool(value) {
  if (typeof value !== 'boolean') throw new ValidationError('Expected true or false')
  return value
}

function param(name, value, type = 'STRING') {
  return value === null || value === undefined ? { name, type } : { name, value: String(value), type }
}

// The signed-in user (id from the verified Supabase session)
function userParam(user) {
  if (!user || typeof user.id !== 'string' || !USER_ID_RE.test(user.id)) throw new ValidationError('Unknown user')
  return param('user_id', user.id.toLowerCase())
}

// WHERE clauses shared by the job list and the summary so counts always match what the list shows.
// scope: 'match' (default, "For you") or 'all' (every job, sorted by fit).
export function buildFilterWhere(filters = {}, { includeTab = true } = {}) {
  const where = [`(${VISIBLE_SQL})`]
  const parameters = []
  const add = (clause, name, value, type) => {
    where.push(clause)
    parameters.push(param(name, value, type))
  }

  if (filters.scope !== 'all') where.push(MATCH_SQL)
  const q = text(filters.q).toLowerCase()
  if (q) add("contains(lower(concat_ws(' ', title, company_name, role_title, array_join(skills, ' '))), :q)", 'q', q)

  const role = text(filters.role)
  if (role) add('role_title = :role', 'role', role)

  const category = text(filters.category)
  if (category) add('category = :category', 'category', category)

  const source = text(filters.source)
  if (source) add('source = :source', 'source', source)

  const company = text(filters.company, 200)
  if (company) add('company_name = :company', 'company', company)

  const location = text(filters.location).toLowerCase()
  if (location) add('contains(lower(location), :location)', 'location', location)

  const maxYears = int(filters.maxYears, 0, 40)
  if (maxYears !== null) add('coalesce(experience_min_years, 0) <= :max_years', 'max_years', maxYears, 'INT')

  // Freshness in hours. posted_date is only a DATE: a job posted today passes, one posted on the cutoff day passes only
  // if we first found it inside the window; jobs without posted_date use first_seen_at.
  // Applied jobs always pass so the Applied tab keeps your history.
  const postedWithin = int(filters.postedWithin, 1, 8760)
  if (postedWithin !== null) {
    const cutoff = 'current_timestamp() - make_interval(0, 0, 0, 0, :posted_within_hours, 0, 0)'
    add(`(coalesce(is_applied, false) OR CASE
    WHEN posted_date IS NOT NULL THEN posted_date >= to_date(${cutoff}) AND (posted_date >= current_date() OR first_seen_at >= ${cutoff})
    ELSE first_seen_at >= ${cutoff}
  END)`, 'posted_within_hours', postedWithin, 'INT')
  }

  const minFit = int(filters.minFit, 1, 100)
  if (minFit !== null) add('coalesce(fit_score, 0) >= :min_fit', 'min_fit', minFit, 'INT')

  if (filters.matchedOnly === true) where.push('coalesce(size(fit_matched_skills), 0) > 0')

  if (includeTab) {
    if (filters.tab === 'applied') where.push('coalesce(is_applied, false)')
    else if (filters.tab === 'pending') where.push('NOT coalesce(is_applied, false)')
  }

  return { where: where.join('\n  AND '), parameters }
}

function jobsStatement(params, user) {
  const { where, parameters } = buildFilterWhere(params)
  const orderBy = SORTS[params.sort] || SORTS.fit
  const limit = int(params.limit, 1, MAX_PAGE_SIZE) ?? 48
  const offset = int(params.offset, 0, 100000) ?? 0
  return {
    statement: `${USER_JOBS_CTE}
SELECT ${LIST_COLUMNS}, count(*) OVER () AS total_count
FROM user_jobs
WHERE ${where}
ORDER BY ${orderBy}
LIMIT ${limit} OFFSET ${offset}`,
    parameters: [userParam(user), ...parameters],
  }
}

function summaryStatement(params, user) {
  const { where, parameters } = buildFilterWhere(params, { includeTab: false })
  const visible = `(${where.replaceAll('\n  AND ', ' AND ')})`
  return {
    statement: `${USER_JOBS_CTE}
SELECT
  count_if(${visible}) AS total,
  count_if(${visible} AND first_seen_at >= current_timestamp() - INTERVAL 48 HOURS) AS new_48h,
  count_if(${visible} AND coalesce(fit_score, 0) >= 70) AS strong_fit,
  count_if(${visible} AND coalesce(is_applied, false)) AS applied,
  count_if(${visible} AND NOT coalesce(is_applied, false)) AS pending
FROM user_jobs`,
    parameters: [userParam(user), ...parameters],
  }
}

function scopeSql(params) {
  return params.scope === 'all' ? 'TRUE' : MATCH_SQL
}

// Jobs added per day (in your scope) and jobs you applied to per day, last 14 days
function trendStatement(params, user) {
  return {
    statement: `${USER_JOBS_CTE}
SELECT day, sum(added) AS added, sum(applied) AS applied
FROM (
  SELECT to_date(first_seen_at) AS day, 1 AS added, 0 AS applied FROM user_jobs
  WHERE first_seen_at >= date_sub(current_date(), 13) AND ${scopeSql(params)}
  UNION ALL
  SELECT to_date(applied_at) AS day, 0 AS added, 1 AS applied FROM user_jobs WHERE applied_at >= date_sub(current_date(), 13)
)
GROUP BY day
ORDER BY day`,
    parameters: [userParam(user)],
  }
}

function facetsStatement(params, user) {
  return {
    statement: `${USER_JOBS_CTE},
visible AS (SELECT role_title, category, source, company_name FROM user_jobs WHERE ${VISIBLE_SQL} AND ${scopeSql(params)})
SELECT 'role' AS kind, role_title AS value, count(*) AS n FROM visible WHERE role_title IS NOT NULL GROUP BY role_title
UNION ALL SELECT 'category', category, count(*) FROM visible WHERE category IS NOT NULL GROUP BY category
UNION ALL SELECT 'source', source, count(*) FROM visible WHERE source IS NOT NULL GROUP BY source
UNION ALL SELECT 'company', company_name, count(*) FROM visible WHERE company_name IS NOT NULL GROUP BY company_name
ORDER BY kind, n DESC, value`,
    parameters: [userParam(user)],
  }
}

// Only what the detail drawer adds on top of the list row
const DETAIL_COLUMNS = 'job_key, description, job_function, industries, role_method, role_score'

const PROFILE_STATEMENT = `SELECT profile_id, target_roles, skills, min_years, max_years, updated_at
FROM ops.user_profile
WHERE profile_id = :user_id
LIMIT 1`

// Pickers: roles in the supported scope (ops.ref_roles.in_scope; the other roles only help classify jobs), skills with
// their aliases (so typed spellings resolve to the list's name), and what users added themselves with its status.
const REFS_STATEMENT = `SELECT 'role' AS kind, role_title AS value, category AS detail, CAST(NULL AS ARRAY<STRING>) AS aliases
FROM ops.ref_roles WHERE in_scope
UNION ALL SELECT 'role_out', role_title, category, CAST(NULL AS ARRAY<STRING>) FROM ops.ref_roles WHERE NOT in_scope
UNION ALL SELECT 'skill', skill, skill_group, aliases FROM ops.ref_skills
UNION ALL SELECT DISTINCT 'skill', skill_group, 'group', CAST(NULL AS ARRAY<STRING>) FROM ops.ref_skills WHERE skill_group IS NOT NULL
UNION ALL SELECT 'custom_role', role_title, status, CASE WHEN duplicate_of IS NOT NULL THEN array(duplicate_of) END FROM ops.custom_roles
UNION ALL SELECT 'custom_skill', skill, 'custom', CAST(NULL AS ARRAY<STRING>) FROM ops.custom_skills
ORDER BY kind, value`

function stringList(value, { maxItems, maxLength, label }) {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be a list`)
  const seen = new Set()
  const items = []
  for (const raw of value) {
    const item = text(raw, maxLength + 1)
    if (!item) continue
    if (item.length > maxLength) throw new ValidationError(`${label}: "${item.slice(0, 20)}…" is longer than ${maxLength} characters`)
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  if (items.length > maxItems) throw new ValidationError(`${label}: at most ${maxItems} items`)
  return items
}

// 1-2 roles and 1-5 skills. Entries not in the lists are allowed (the pipeline checks new roles); SQL still rejects
// roles known to be outside the supported scope.
export function validateProfile(input = {}) {
  const profile = {
    target_roles: stringList(input.target_roles ?? [], { maxItems: PROFILE_LIMITS.roles, maxLength: ENTRY_MAX_LENGTH, label: 'Roles' }),
    skills: stringList(input.skills ?? [], { maxItems: PROFILE_LIMITS.skills, maxLength: ENTRY_MAX_LENGTH, label: 'Skills' }),
    min_years: int(input.min_years, 0, 40),
    max_years: int(input.max_years, 0, 40),
  }
  if (!profile.target_roles.length) throw new ValidationError('Pick at least one role')
  if (!profile.skills.length) throw new ValidationError('Pick at least one skill')
  for (const [label, items] of [['Roles', profile.target_roles], ['Skills', profile.skills]]) {
    for (const item of items) {
      const problem = entryProblem(item)
      if (problem) throw new ValidationError(`${label}: "${item.slice(0, 30)}" - ${problem}`)
    }
  }
  if (profile.min_years !== null && profile.max_years !== null && profile.min_years > profile.max_years) {
    throw new ValidationError('Minimum years cannot be more than maximum years')
  }
  return profile
}

// Upserts the caller's own profile row. assert_true stops the MERGE with a readable message when a role is known to be
// outside the scope: an out-of-scope reference role or a custom role the pipeline rejected (the API returns a 400).
function saveProfileStatement(params, user) {
  const profile = validateProfile(params)
  const roles = "from_json(:target_roles, 'ARRAY<STRING>')"
  const skills = "from_json(:skills, 'ARRAY<STRING>')"
  return {
    statement: `MERGE INTO ops.user_profile t
USING (
  SELECT :user_id AS profile_id
  WHERE assert_true(
      size(array_intersect(transform(${roles}, r -> lower(r)), (
        SELECT collect_set(lower(role_title)) FROM (
          SELECT role_title FROM ops.ref_roles WHERE NOT in_scope
          UNION ALL SELECT role_title FROM ops.custom_roles WHERE status = 'rejected'
        )
      ))) = 0,
      'We only support data, full stack, backend, DevOps and cloud roles') IS NULL
) s
ON t.profile_id = s.profile_id
WHEN MATCHED THEN UPDATE SET
  email = :email,
  target_roles = ${roles},
  skills = ${skills},
  min_years = :min_years,
  max_years = :max_years,
  updated_at = current_timestamp()
WHEN NOT MATCHED THEN INSERT (profile_id, email, target_roles, skills, min_years, max_years, updated_at)
VALUES (s.profile_id, :email, ${roles}, ${skills}, :min_years, :max_years, current_timestamp())`,
    parameters: [
      userParam(user),
      param('email', text(user.email, 320) || null),
      param('target_roles', JSON.stringify(profile.target_roles)),
      param('skills', JSON.stringify(profile.skills)),
      param('min_years', profile.min_years, 'INT'),
      param('max_years', profile.max_years, 'INT'),
    ],
  }
}

// Per-user flags live in gold.user_job_state; the source only yields a row for a job that exists in gold.
function stateMerge(user, jobKeyValue, set, insertValues, extraParameters) {
  return {
    statement: `MERGE INTO gold.user_job_state t
USING (SELECT :user_id AS user_id, job_key FROM gold.jobs WHERE job_key = :job_key) s
ON t.user_id = s.user_id AND t.job_key = s.job_key
WHEN MATCHED THEN UPDATE SET
  ${set}
WHEN NOT MATCHED THEN INSERT (user_id, job_key, is_applied, applied_at, is_hidden, hidden_at, application_status, status_updated_at)
VALUES (s.user_id, s.job_key, ${insertValues})`,
    parameters: [userParam(user), param('job_key', jobKey(jobKeyValue)), ...extraParameters],
  }
}

const BUILDERS = {
  jobs: jobsStatement,
  summary: summaryStatement,
  trend: trendStatement,
  facets: facetsStatement,
  job: (params) => ({
    statement: `SELECT ${DETAIL_COLUMNS} FROM gold.jobs WHERE job_key = :job_key`,
    parameters: [param('job_key', jobKey(params.jobKey))],
  }),
  setApplied: (params, user) => stateMerge(
    user,
    params.jobKey,
    `is_applied = :applied,
  applied_at = CASE WHEN :applied THEN coalesce(t.applied_at, current_timestamp()) END,
  application_status = CASE WHEN :applied THEN 'applied' ELSE 'not_applied' END,
  status_updated_at = current_timestamp()`,
    `:applied, CASE WHEN :applied THEN current_timestamp() END, false, NULL,
  CASE WHEN :applied THEN 'applied' ELSE 'not_applied' END, current_timestamp()`,
    [param('applied', bool(params.applied), 'BOOLEAN')],
  ),
  setHidden: (params, user) => stateMerge(
    user,
    params.jobKey,
    `is_hidden = :hidden,
  hidden_at = CASE WHEN :hidden THEN current_timestamp() END`,
    `false, NULL, :hidden, CASE WHEN :hidden THEN current_timestamp() END, 'not_applied', current_timestamp()`,
    [param('hidden', bool(params.hidden), 'BOOLEAN')],
  ),
  hiddenJobs: (params, user) => ({
    statement: `SELECT j.job_key, j.title, j.company_name, j.location, st.hidden_at
FROM gold.user_job_state st
JOIN gold.jobs j ON j.job_key = st.job_key
WHERE st.user_id = :user_id AND coalesce(st.is_hidden, false)
ORDER BY st.hidden_at DESC NULLS LAST
LIMIT 200`,
    parameters: [userParam(user)],
  }),
  restoreHidden: (params, user) => ({
    statement: `UPDATE gold.user_job_state SET is_hidden = false, hidden_at = NULL
WHERE user_id = :user_id AND coalesce(is_hidden, false)`,
    parameters: [userParam(user)],
  }),
  profile: (params, user) => ({ statement: PROFILE_STATEMENT, parameters: [userParam(user)] }),
  refs: () => ({ statement: REFS_STATEMENT, parameters: [] }),
  saveProfile: saveProfileStatement,
}

// Reads that are the same for every user (cached once, not per user)
export const SHARED_ACTIONS = new Set(['job', 'refs'])

// user = { id, email } of the verified caller
export function buildStatement(action, params = {}, user = null) {
  const builder = Object.hasOwn(BUILDERS, action) ? BUILDERS[action] : null
  if (!builder) throw new ValidationError(`Unknown action: ${String(action).slice(0, 40)}`)
  return builder(params && typeof params === 'object' ? params : {}, user)
}

const NUMBER_TYPES = new Set(['INT', 'LONG', 'SHORT', 'BYTE', 'DOUBLE', 'FLOAT', 'DECIMAL'])
const JSON_TYPES = new Set(['ARRAY', 'MAP', 'STRUCT'])

// JSON_ARRAY results arrive as strings; convert them using the manifest column types.
export function convertValue(value, typeName) {
  if (value === null || value === undefined) return null
  if (NUMBER_TYPES.has(typeName)) return Number(value)
  if (typeName === 'BOOLEAN') return value === true || value === 'true'
  if (JSON_TYPES.has(typeName)) {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value
}

export function toObjects(columns, dataArray) {
  return (dataArray || []).map(row => {
    const record = {}
    columns.forEach((column, index) => {
      record[column.name] = convertValue(row[index], column.type_name)
    })
    return record
  })
}
