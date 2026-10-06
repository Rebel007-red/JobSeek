// Fixed, parameterised SQL for the Databricks SQL Statement API.
// Only values travel as named parameters; clause text is chosen from this file, never from the request.
// Every per-user statement is scoped by :user_id, which comes from the verified Supabase session, never from the request body.
import { ENTRY_MAX_LENGTH, PROFILE_LIMITS, entryProblem } from '../../../src/utils/entries.js'
import { FIT_WEIGHTS, MATCH_MIN_FIT, STRONG_FIT } from '../../../src/utils/gold.js'

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

// Visible = not hidden, and either still active or something you applied to (applied jobs stay after expiry).
const VISIBLE_SQL = 'NOT coalesce(is_hidden, false) AND (coalesce(is_active, true) OR coalesce(is_applied, false))'
// Applied jobs always count as yours, so the Applied tab keeps your history. Jobs asking for more than
// EXPERIENCE_HIDE_GAP years above your maximum stay out of "For you" (they still show, scored lower, in "Show all").
const MATCH_SQL = `(is_applied OR (role_match AND fit_score >= ${MATCH_MIN_FIT} AND NOT above_experience))`

const JOB_DATE_SQL = 'coalesce(posted_date, to_date(first_seen_at))'

// Fit tuning (see USER_JOBS_CTE)
const EXPERIENCE_HIDE_GAP = 2
// Related roles: cosine similarity of the two role embeddings (ops.role_similarity, written by 03_enrich; other role
// pairs sit around 0.69, 10% above 0.78). The role part rises from 0 at ROLE_SIM_FLOOR to ROLE_SIM_SCORE at
// ROLE_SIM_MATCH (ROLE_SIM_SPAN = MATCH - FLOOR), and ROLE_SIM_MATCH and up is a match, so a related role that counts for
// "For you" always gets the full related score. Calibrated against judged jobs for six profiles: a match at 0.86 lets in
// close roles (MLOps Engineer for ML Engineer, Kubernetes Engineer for DevOps) but not Analytics Engineer (0.85) for Data
// Engineer.
const ROLE_SIM_FLOOR = 0.75
const ROLE_SIM_MATCH = 0.86
const ROLE_SIM_SPAN = Number((ROLE_SIM_MATCH - ROLE_SIM_FLOOR).toFixed(2))
const ROLE_SIM_SCORE = 0.85
// Skill part of a job with no skills found (often a LinkedIn row whose description could not be fetched). 0.3 keeps an
// exact-role job in "For you" (64 at the unknown-experience 0.7) but below STRONG_FIT even with full experience
// (0.4 + 0.45 * 0.3 + 0.15 = 0.685): a strong fit needs skill evidence.
const NEUTRAL_SKILLS = 0.3
// Exported for the tests (the numbers the SQL below is built from)
export const FIT_TUNING = Object.freeze({ ROLE_SIM_FLOOR, ROLE_SIM_MATCH, ROLE_SIM_SPAN, ROLE_SIM_SCORE, NEUTRAL_SKILLS })
// Rarity (ops.skill_stats.idf, rebuilt by 04_gold_cleanup) of a skill no active job lists: about ln(1 + 1 / 0.05)
const UNSEEN_SKILL_IDF = 3.0
// Typical years for a job that states only a level (experience_level from 03_enrich)
const LEVEL_YEARS_SQL = `CASE j.experience_level
      WHEN 'Intern' THEN 0 WHEN 'Entry' THEN 0 WHEN 'Junior' THEN 1 WHEN 'Mid' THEN 3 WHEN 'Mid-Senior' THEN 3
      WHEN 'Senior' THEN 5 WHEN 'Lead/Manager' THEN 7 WHEN 'Principal/Staff' THEN 8 WHEN 'Director+' THEN 10
    END`

// gold.jobs as seen by one user: their applied/hidden flags (gold.user_job_state) and a fit score from their
// profile (ops.user_profile). A missing profile scores every job 0 on role and skills.
// Roles users typed themselves (ops.custom_roles, checked by 03_enrich): 'mapped' ones count as the existing role they
// duplicate; 'active' ones are matched like reference roles. Until then a job whose title contains the role text counts.
// Role: your first role 1.0, your second 0.95, otherwise the job role's best similarity to one of yours. Until
// ops.role_similarity has rows for your roles (before the first pipeline run), the job's alternative role or category counts.
// Skills: matched idf / skill_idf_total (the profile skills' idf, scaled up to 3 skills when it has fewer), so rare
// skills count more and one or two skills cannot reach 100%; a job with no skills found scores NEUTRAL_SKILLS.
// Experience: 0.3 off per year you are short; a job below your minimum loses 0.15 per year, down to 0.5.
const USER_JOBS_CTE = `WITH role_map AS (
  SELECT map_from_entries(collect_list(struct(lower(role_title), duplicate_of))) AS m
  FROM ops.custom_roles
  WHERE status = 'mapped' AND duplicate_of IS NOT NULL
),
skill_idf AS (
  SELECT map_from_entries(collect_list(struct(skill, idf))) AS m
  FROM (SELECT lower(skill) AS skill, max(idf) AS idf FROM ops.skill_stats WHERE skill IS NOT NULL GROUP BY lower(skill))
),
profile_row AS (
  SELECT
    transform(target_roles, r -> coalesce(try_element_at(rm.m, lower(r)), r)) AS roles,
    transform(skills, s -> named_struct('skill', s, 'idf', coalesce(try_element_at(si.m, lower(s)), ${UNSEEN_SKILL_IDF}))) AS skill_weights,
    min_years, max_years
  FROM ops.user_profile
  CROSS JOIN role_map rm
  CROSS JOIN skill_idf si
  WHERE profile_id = :user_id
  LIMIT 1
),
profile AS (
  SELECT *,
    aggregate(skill_weights, 0D, (total, s) -> total + s.idf) * greatest(3, size(skill_weights)) / greatest(1, size(skill_weights))
      AS skill_idf_total
  FROM profile_row
),
related_roles AS (
  SELECT count(*) > 0 AS ready, map_from_entries(collect_list(struct(role_b, struct(score, sim)))) AS m
  FROM (
    SELECT s.role_b,
      max(CASE WHEN array_position(p.roles, s.role_a) = 1 THEN 1.0 ELSE 0.95 END
        * ${ROLE_SIM_SCORE} * least(1.0, greatest(0.0, (s.sim - ${ROLE_SIM_FLOOR}) / ${ROLE_SIM_SPAN}))) AS score,
      max(s.sim) AS sim
    FROM ops.role_similarity s
    JOIN profile p ON array_contains(p.roles, s.role_a)
    WHERE s.role_b IS NOT NULL
    GROUP BY s.role_b
  )
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
    coalesce(array_position(p.roles, j.role_title), 0) AS role_rank,
    coalesce(exists(p.roles, r -> contains(lower(j.title), lower(r))), false) AS title_has_role,
    rr.ready AS related_ready,
    try_element_at(rr.m, j.role_title) AS related,
    coalesce(array_contains(p.roles, j.role_alternative), false) AS alternative_is_role,
    coalesce(array_contains(c.categories, j.category), false) AS category_is_role,
    filter(p.skill_weights, ps -> exists(j.skills, js -> lower(js) = lower(ps.skill)) OR exists(j.skill_groups, g -> lower(g) = lower(ps.skill)))
      AS matched_weights,
    coalesce(size(p.skill_weights), 0) > 0 AS has_profile_skills,
    p.skill_idf_total,
    size(coalesce(j.skills, CAST(array() AS ARRAY<STRING>))) + size(coalesce(j.skill_groups, CAST(array() AS ARRAY<STRING>))) = 0 AS no_job_skills,
    coalesce(j.experience_min_years, ${LEVEL_YEARS_SQL}) AS exp_min,
    coalesce(j.experience_max_years, j.experience_min_years + 3, ${LEVEL_YEARS_SQL} + 3) AS exp_top,
    p.min_years AS profile_min_years, p.max_years AS profile_max_years,
    coalesce(j.experience_min_years > p.max_years + ${EXPERIENCE_HIDE_GAP}, false) AS above_experience
  FROM gold.jobs j
  LEFT JOIN state st ON st.job_key = j.job_key
  LEFT JOIN profile p ON true
  CROSS JOIN role_categories c
  CROSS JOIN related_roles rr
),
parts AS (
  SELECT *,
    CASE
      WHEN role_rank = 1 THEN 1.0
      WHEN role_rank > 1 THEN 0.95
      WHEN title_has_role THEN 0.9
      WHEN related_ready THEN coalesce(related.score, 0.0)
      WHEN alternative_is_role THEN 0.5
      WHEN category_is_role THEN 0.3
      ELSE 0.0
    END AS fit_role,
    role_rank > 0 OR title_has_role OR CASE
      WHEN related_ready THEN coalesce(related.sim >= ${ROLE_SIM_MATCH}, false)
      ELSE alternative_is_role OR category_is_role
    END AS role_match,
    coalesce(transform(matched_weights, ps -> ps.skill), CAST(array() AS ARRAY<STRING>)) AS fit_matched_skills,
    CASE
      WHEN NOT has_profile_skills THEN 0.0
      WHEN no_job_skills THEN ${NEUTRAL_SKILLS}
      ELSE least(1.0, aggregate(matched_weights, 0D, (total, ps) -> total + ps.idf) / skill_idf_total)
    END AS fit_skills,
    CASE
      WHEN exp_min IS NULL THEN 0.7
      WHEN exp_min > profile_max_years THEN greatest(0.0, 1.0 - 0.3 * (exp_min - profile_max_years))
      WHEN exp_top < profile_min_years THEN greatest(0.5, 1.0 - 0.15 * (profile_min_years - exp_top))
      ELSE 1.0
    END AS fit_experience
  FROM scored
),
user_jobs AS (
  SELECT *,
    CAST(round(100 * (${FIT_WEIGHTS.role} * fit_role + ${FIT_WEIGHTS.skills} * fit_skills + ${FIT_WEIGHTS.experience} * fit_experience)) AS INT) AS fit_score
  FROM parts
)`

const LIST_COLUMNS = `job_key, source, company_name, title, location, posted_date, job_url,
  seniority_level, employment_type, experience_min_years, experience_max_years, experience_level,
  skills, category, role_title, role_score, role_alternative, role_match,
  fit_score, fit_role, fit_skills, fit_experience, fit_matched_skills,
  first_seen_at, last_seen_at, times_seen, is_applied, applied_at`

const SORTS = {
  fit: `fit_score DESC NULLS LAST, role_score DESC NULLS LAST, ${JOB_DATE_SQL} DESC NULLS LAST, job_key`,
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
  count_if(${visible} AND coalesce(fit_score, 0) >= ${STRONG_FIT}) AS strong_fit,
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

const PROFILE_STATEMENT = `SELECT profile_id, target_roles, skills, min_years, max_years, preferred_cities, updated_at
FROM ops.user_profile
WHERE profile_id = :user_id
LIMIT 1`

// Pickers: roles in the supported scope (ops.ref_roles.in_scope; the other roles only help classify jobs), skills with
// their aliases (so typed spellings resolve to the list's name), what users added themselves with its status, and the
// cities a user can prefer (ops.ref_india_locations, with their other spellings such as Bangalore).
const REFS_STATEMENT = `SELECT 'role' AS kind, role_title AS value, category AS detail, CAST(NULL AS ARRAY<STRING>) AS aliases
FROM ops.ref_roles WHERE in_scope
UNION ALL SELECT 'role_out', role_title, category, CAST(NULL AS ARRAY<STRING>) FROM ops.ref_roles WHERE NOT in_scope
UNION ALL SELECT 'skill', skill, skill_group, aliases FROM ops.ref_skills
UNION ALL SELECT DISTINCT 'skill', skill_group, 'group', CAST(NULL AS ARRAY<STRING>) FROM ops.ref_skills WHERE skill_group IS NOT NULL
UNION ALL SELECT 'custom_role', role_title, status, CASE WHEN duplicate_of IS NOT NULL THEN array(duplicate_of) END FROM ops.custom_roles
UNION ALL SELECT 'custom_skill', skill, 'custom', CAST(NULL AS ARRAY<STRING>) FROM ops.custom_skills
UNION ALL SELECT 'city', city, max(state), collect_set(lower(alias)) FROM ops.ref_india_locations
  WHERE city IS NOT NULL AND city <> 'India' GROUP BY city
ORDER BY kind, value`

// Preferred-city spellings (city names and their aliases, lower case) -> the city name saved in the profile
const CITY_NAMES_SQL = `SELECT map_from_entries(collect_list(struct(name, city))) AS m
  FROM (
    SELECT name, max(city) AS city
    FROM (
      SELECT lower(trim(alias)) AS name, city FROM ops.ref_india_locations WHERE city IS NOT NULL AND city <> 'India'
      UNION ALL SELECT lower(city), city FROM ops.ref_india_locations WHERE city IS NOT NULL AND city <> 'India'
    )
    WHERE name IS NOT NULL
    GROUP BY name
  )`
const CITY_RE = /^[A-Za-z][A-Za-z .-]*$/

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

// 1-2 roles, 1-5 skills and 0-3 preferred cities. Roles and skills not in the lists are allowed (the pipeline checks new
// roles); SQL still rejects roles known to be outside the supported scope and cities not in ops.ref_india_locations.
// preferred_cities left out (an older client) is null: the saved cities stay as they are.
export function validateProfile(input = {}) {
  const profile = {
    target_roles: stringList(input.target_roles ?? [], { maxItems: PROFILE_LIMITS.roles, maxLength: ENTRY_MAX_LENGTH, label: 'Roles' }),
    skills: stringList(input.skills ?? [], { maxItems: PROFILE_LIMITS.skills, maxLength: ENTRY_MAX_LENGTH, label: 'Skills' }),
    min_years: int(input.min_years, 0, 40),
    max_years: int(input.max_years, 0, 40),
    preferred_cities: input.preferred_cities === undefined || input.preferred_cities === null
      ? null
      : stringList(input.preferred_cities, { maxItems: PROFILE_LIMITS.cities, maxLength: ENTRY_MAX_LENGTH, label: 'Preferred cities' }),
  }
  for (const city of profile.preferred_cities || []) {
    if (!CITY_RE.test(city)) throw new ValidationError(`Preferred cities: "${city.slice(0, 30)}" is not a city name`)
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
// outside the scope (an out-of-scope reference role or a custom role the pipeline rejected) or a preferred city is not
// in the list (the API returns a 400). Cities are saved in the list's spelling (Bangalore -> Bengaluru).
function saveProfileStatement(params, user) {
  const profile = validateProfile(params)
  const roles = "from_json(:target_roles, 'ARRAY<STRING>')"
  const skills = "from_json(:skills, 'ARRAY<STRING>')"
  const cities = "from_json(:preferred_cities, 'ARRAY<STRING>')"
  return {
    statement: `MERGE INTO ops.user_profile t
USING (
  SELECT :user_id AS profile_id, array_distinct(transform(${cities}, c -> try_element_at(cn.m, lower(trim(c))))) AS preferred_cities
  FROM (${CITY_NAMES_SQL}) cn
  WHERE assert_true(
      size(array_intersect(transform(${roles}, r -> lower(r)), (
        SELECT collect_set(lower(role_title)) FROM (
          SELECT role_title FROM ops.ref_roles WHERE NOT in_scope
          UNION ALL SELECT role_title FROM ops.custom_roles WHERE status = 'rejected'
        )
      ))) = 0,
      'We only support data, full stack, backend, DevOps and cloud roles') IS NULL
    AND assert_true(
      coalesce(forall(${cities}, c -> try_element_at(cn.m, lower(trim(c))) IS NOT NULL), true),
      'Preferred cities: pick Indian cities from the list') IS NULL
) s
ON t.profile_id = s.profile_id
WHEN MATCHED THEN UPDATE SET
  email = :email,
  target_roles = ${roles},
  skills = ${skills},
  min_years = :min_years,
  max_years = :max_years,
  preferred_cities = coalesce(s.preferred_cities, t.preferred_cities),
  updated_at = current_timestamp()
WHEN NOT MATCHED THEN INSERT (profile_id, email, target_roles, skills, min_years, max_years, preferred_cities, updated_at)
VALUES (s.profile_id, :email, ${roles}, ${skills}, :min_years, :max_years,
  coalesce(s.preferred_cities, CAST(array() AS ARRAY<STRING>)), current_timestamp())`,
    parameters: [
      userParam(user),
      param('email', text(user.email, 320) || null),
      param('target_roles', JSON.stringify(profile.target_roles)),
      param('skills', JSON.stringify(profile.skills)),
      param('min_years', profile.min_years, 'INT'),
      param('max_years', profile.max_years, 'INT'),
      param('preferred_cities', profile.preferred_cities && JSON.stringify(profile.preferred_cities)),
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
// ops.role_similarity / ops.skill_stats are created by 01_setup. Until that has run, a statement failing on either one is
// retried with empty stand-ins (category fallback, every skill idf UNSEEN_SKILL_IDF), so the app keeps working.
const PIPELINE_TABLE_STANDINS = {
  'ops.role_similarity': '(SELECT CAST(NULL AS STRING) AS role_a, CAST(NULL AS STRING) AS role_b, CAST(NULL AS DOUBLE) AS sim WHERE false)',
  'ops.skill_stats': '(SELECT CAST(NULL AS STRING) AS skill, CAST(NULL AS BIGINT) AS jobs, CAST(NULL AS DOUBLE) AS idf WHERE false)',
}

export function missingPipelineTable(message) {
  return /TABLE_OR_VIEW_NOT_FOUND/.test(message || '') && /role_similarity|skill_stats/.test(message || '')
}

export function withoutPipelineTables(statement) {
  return Object.entries(PIPELINE_TABLE_STANDINS).reduce((text, [table, standin]) => text.split(table).join(standin), statement)
}

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
