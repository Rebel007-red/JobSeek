// Fixed, parameterised SQL for the Databricks SQL Statement API.
// Only values travel as named parameters; clause text is chosen from this file, never from the request.

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

// Visible = not hidden, and either still active or something you applied to (applied jobs stay after expiry).
const VISIBLE_SQL = 'NOT coalesce(is_hidden, false) AND (coalesce(is_active, true) OR coalesce(is_applied, false))'

const JOB_DATE_SQL = 'coalesce(posted_date, to_date(first_seen_at))'

const LIST_COLUMNS = `job_key, source, company_name, title, location, posted_date, job_url,
  seniority_level, employment_type, experience_min_years, experience_max_years, experience_level,
  skills, category, role_title, role_score, role_alternative,
  fit_score, fit_role, fit_skills, fit_experience, fit_location, fit_matched_skills,
  first_seen_at, last_seen_at, times_seen, is_applied, applied_at`

const SORTS = {
  fit: `fit_score DESC NULLS LAST, ${JOB_DATE_SQL} DESC NULLS LAST, job_key`,
  recent: `${JOB_DATE_SQL} DESC NULLS LAST, fit_score DESC NULLS LAST, job_key`,
  found: 'first_seen_at DESC NULLS LAST, fit_score DESC NULLS LAST, job_key',
}

const JOB_KEY_RE = /^[0-9a-f]{64}$/
const STATEMENT_ID_RE = /^[0-9a-zA-Z-]{16,64}$/
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

// WHERE clauses shared by the job list and the summary so counts always match what the list shows.
export function buildFilterWhere(filters = {}, { includeTab = true } = {}) {
  const where = [`(${VISIBLE_SQL})`]
  const parameters = []
  const add = (clause, name, value, type) => {
    where.push(clause)
    parameters.push(param(name, value, type))
  }

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

function jobsStatement(params) {
  const { where, parameters } = buildFilterWhere(params)
  const orderBy = SORTS[params.sort] || SORTS.fit
  const limit = int(params.limit, 1, MAX_PAGE_SIZE) ?? 48
  const offset = int(params.offset, 0, 100000) ?? 0
  return {
    statement: `SELECT ${LIST_COLUMNS}, count(*) OVER () AS total_count
FROM gold.jobs
WHERE ${where}
ORDER BY ${orderBy}
LIMIT ${limit} OFFSET ${offset}`,
    parameters,
  }
}

function summaryStatement(params) {
  const { where, parameters } = buildFilterWhere(params, { includeTab: false })
  const visible = `(${where.replaceAll('\n  AND ', ' AND ')})`
  return {
    statement: `SELECT
  count_if(${visible}) AS total,
  count_if(${visible} AND first_seen_at >= current_timestamp() - INTERVAL 48 HOURS) AS new_48h,
  count_if(${visible} AND coalesce(fit_score, 0) >= 70) AS strong_fit,
  count_if(${visible} AND coalesce(is_applied, false)) AS applied,
  count_if(${visible} AND NOT coalesce(is_applied, false)) AS pending
FROM gold.jobs`,
    parameters,
  }
}

const TREND_STATEMENT = `SELECT day, sum(added) AS added, sum(applied) AS applied
FROM (
  SELECT to_date(first_seen_at) AS day, 1 AS added, 0 AS applied FROM gold.jobs WHERE first_seen_at >= date_sub(current_date(), 13)
  UNION ALL
  SELECT to_date(applied_at) AS day, 0 AS added, 1 AS applied FROM gold.jobs WHERE applied_at >= date_sub(current_date(), 13)
)
GROUP BY day
ORDER BY day`

const FACETS_STATEMENT = `WITH visible AS (SELECT role_title, category, source, company_name FROM gold.jobs WHERE ${VISIBLE_SQL})
SELECT 'role' AS kind, role_title AS value, count(*) AS n FROM visible WHERE role_title IS NOT NULL GROUP BY role_title
UNION ALL SELECT 'category', category, count(*) FROM visible WHERE category IS NOT NULL GROUP BY category
UNION ALL SELECT 'source', source, count(*) FROM visible WHERE source IS NOT NULL GROUP BY source
UNION ALL SELECT 'company', company_name, count(*) FROM visible WHERE company_name IS NOT NULL GROUP BY company_name
ORDER BY kind, n DESC, value`

// Only what the detail drawer adds on top of the list row
const DETAIL_COLUMNS = 'job_key, description, job_function, industries, role_method, role_score'

const PROFILE_STATEMENT = `SELECT profile_id, target_roles, skills, min_years, max_years, preferred_cities,
  weight_role, weight_skills, weight_experience, weight_location, updated_at
FROM ops.user_profile
ORDER BY updated_at DESC NULLS LAST
LIMIT 1`

const REFS_STATEMENT = `SELECT 'role' AS kind, role_title AS value, category AS detail FROM ops.ref_roles
UNION SELECT 'skill', skill, skill_group FROM ops.ref_skills
UNION SELECT 'skill', skill_group, 'group' FROM ops.ref_skills WHERE skill_group IS NOT NULL
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

function weight(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new ValidationError(`${label} weight must be between 0 and 1`)
  return Math.round(number * 1000) / 1000
}

export function validateProfile(input = {}) {
  const profile = {
    target_roles: stringList(input.target_roles ?? [], { maxItems: 20, maxLength: 80, label: 'Target roles' }),
    skills: stringList(input.skills ?? [], { maxItems: 60, maxLength: 60, label: 'Skills' }),
    preferred_cities: stringList(input.preferred_cities ?? [], { maxItems: 20, maxLength: 60, label: 'Preferred cities' }),
    min_years: int(input.min_years, 0, 40),
    max_years: int(input.max_years, 0, 40),
    weight_role: weight(input.weight_role, 'Role'),
    weight_skills: weight(input.weight_skills, 'Skills'),
    weight_experience: weight(input.weight_experience, 'Experience'),
    weight_location: weight(input.weight_location, 'Location'),
  }
  if (profile.min_years !== null && profile.max_years !== null && profile.min_years > profile.max_years) {
    throw new ValidationError('Minimum years cannot be more than maximum years')
  }
  if (profile.weight_role + profile.weight_skills + profile.weight_experience + profile.weight_location <= 0) {
    throw new ValidationError('At least one weight must be above 0')
  }
  return profile
}

function saveProfileStatement(params) {
  const profile = validateProfile(params)
  const values = `from_json(:target_roles, 'ARRAY<STRING>'), from_json(:skills, 'ARRAY<STRING>'), :min_years, :max_years,
    from_json(:preferred_cities, 'ARRAY<STRING>'), :weight_role, :weight_skills, :weight_experience, :weight_location, current_timestamp()`
  return {
    statement: `MERGE INTO ops.user_profile t
USING (SELECT 'default' AS profile_id) s
ON t.profile_id = s.profile_id
WHEN MATCHED THEN UPDATE SET
  target_roles = from_json(:target_roles, 'ARRAY<STRING>'),
  skills = from_json(:skills, 'ARRAY<STRING>'),
  min_years = :min_years,
  max_years = :max_years,
  preferred_cities = from_json(:preferred_cities, 'ARRAY<STRING>'),
  weight_role = :weight_role,
  weight_skills = :weight_skills,
  weight_experience = :weight_experience,
  weight_location = :weight_location,
  updated_at = current_timestamp()
WHEN NOT MATCHED THEN INSERT (profile_id, target_roles, skills, min_years, max_years, preferred_cities,
  weight_role, weight_skills, weight_experience, weight_location, updated_at)
VALUES ('default', ${values})`,
    parameters: [
      param('target_roles', JSON.stringify(profile.target_roles)),
      param('skills', JSON.stringify(profile.skills)),
      param('preferred_cities', JSON.stringify(profile.preferred_cities)),
      param('min_years', profile.min_years, 'INT'),
      param('max_years', profile.max_years, 'INT'),
      param('weight_role', profile.weight_role, 'DOUBLE'),
      param('weight_skills', profile.weight_skills, 'DOUBLE'),
      param('weight_experience', profile.weight_experience, 'DOUBLE'),
      param('weight_location', profile.weight_location, 'DOUBLE'),
    ],
  }
}

const BUILDERS = {
  jobs: jobsStatement,
  summary: summaryStatement,
  trend: () => ({ statement: TREND_STATEMENT, parameters: [] }),
  facets: () => ({ statement: FACETS_STATEMENT, parameters: [] }),
  job: (params) => ({
    statement: `SELECT ${DETAIL_COLUMNS} FROM gold.jobs WHERE job_key = :job_key`,
    parameters: [param('job_key', jobKey(params.jobKey))],
  }),
  setApplied: (params) => ({
    statement: `UPDATE gold.jobs SET
  is_applied = :applied,
  applied_at = CASE WHEN :applied THEN coalesce(applied_at, current_timestamp()) END,
  application_status = CASE WHEN :applied THEN 'applied' ELSE 'not_applied' END,
  status_updated_at = current_timestamp()
WHERE job_key = :job_key`,
    parameters: [param('job_key', jobKey(params.jobKey)), param('applied', bool(params.applied), 'BOOLEAN')],
  }),
  setHidden: (params) => ({
    statement: `UPDATE gold.jobs SET
  is_hidden = :hidden,
  hidden_at = CASE WHEN :hidden THEN current_timestamp() END
WHERE job_key = :job_key`,
    parameters: [param('job_key', jobKey(params.jobKey)), param('hidden', bool(params.hidden), 'BOOLEAN')],
  }),
  hiddenJobs: () => ({
    statement: `SELECT job_key, title, company_name, location, hidden_at FROM gold.jobs
WHERE coalesce(is_hidden, false)
ORDER BY hidden_at DESC NULLS LAST
LIMIT 200`,
    parameters: [],
  }),
  restoreHidden: () => ({
    statement: 'UPDATE gold.jobs SET is_hidden = false, hidden_at = NULL WHERE coalesce(is_hidden, false)',
    parameters: [],
  }),
  profile: () => ({ statement: PROFILE_STATEMENT, parameters: [] }),
  refs: () => ({ statement: REFS_STATEMENT, parameters: [] }),
  saveProfile: saveProfileStatement,
}

export function buildStatement(action, params = {}) {
  const builder = Object.hasOwn(BUILDERS, action) ? BUILDERS[action] : null
  if (!builder) throw new ValidationError(`Unknown action: ${String(action).slice(0, 40)}`)
  return builder(params && typeof params === 'object' ? params : {})
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
