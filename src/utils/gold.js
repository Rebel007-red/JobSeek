// Helpers for job rows from the app API (Supabase app.jobs, published from Databricks gold.jobs).

// Fit = 100 * (role * 0.40 + skills * 0.45 + experience * 0.15); the weights add up to 1.
// The score itself is computed per user in Postgres (supabase/app_api.sql, app.user_jobs); the constants here must match
// it (checked by src/utils/sql_constants.test.js), so keep this file import-free.
export const FIT_WEIGHTS = { role: 0.4, skills: 0.45, experience: 0.15 }

// Fit components as shown in the UI
export const FIT_PARTS = [
  { key: 'fit_role', label: 'Role', short: 'Role', weight: FIT_WEIGHTS.role },
  { key: 'fit_skills', label: 'Skills', short: 'Skills', weight: FIT_WEIGHTS.skills },
  { key: 'fit_experience', label: 'Experience', short: 'Exp', weight: FIT_WEIGHTS.experience },
]

// "For you" = the job's role matches (or is close to) one of your roles and the fit is at least this (shared with the API)
export const MATCH_MIN_FIT = 60
// "Strong fit" from this score up (the API's strong_fit count, the fit badge, the Fit 70+ filter)
export const STRONG_FIT = 70

// Experience: a job asking more than this many years above your maximum is left out of "For you" (shared with the API)
export const EXPERIENCE_HIDE_GAP = 2
// Skills score of a posting with no skills found (counted as neutral, shared with the API)
export const NEUTRAL_SKILLS = 0.3
// Experience score when the posting states no years or level
export const UNKNOWN_EXPERIENCE = 0.7
// An also-know skill counts this much of a core skill (the skill tiers of app.user_jobs)
export const ALSO_SKILL_WEIGHT = 0.5
// An applied job with no status change for this many days shows "Follow up"
export const FOLLOW_UP_DAYS = 14
// Most jobs one write sends (api.js splits larger selections into chunks of this size; app.c_max_bulk_keys)
export const MAX_BULK_KEYS = 100

// Application statuses (app.c_application_statuses). Tracked = applied (any stage) or saved: kept past the 2-day
// expiry, never muted, always "For you".
export const APPLICATION_STATUSES = ['not_applied', 'saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn']
// Statuses that count as applied (is_applied)
export const APPLIED_STATUSES = ['applied', 'interviewing', 'offer', 'rejected', 'withdrawn']
export const STATUS_LABELS = {
  not_applied: 'Not applied',
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
}
export const STATUS_OPTIONS = APPLICATION_STATUSES.map(value => ({ value, label: STATUS_LABELS[value] }))

// Why a job was hidden (app.c_hide_reasons), for the toast actions and the Hidden list
export const HIDE_REASONS = [
  { value: 'too_senior', label: 'Too senior' },
  { value: 'wrong_role', label: 'Not my role' },
  { value: 'company', label: 'Not this company' },
  { value: 'location', label: 'Wrong city' },
  { value: 'duplicate', label: 'Seen it' },
  { value: 'other', label: 'Other' },
]

// Years each experience level stands for when a posting states no years (app.c_experience_levels, same order)
export const LEVEL_YEARS = {
  Intern: 0,
  Entry: 0,
  Junior: 1,
  Mid: 3,
  'Mid-Senior': 3,
  Senior: 5,
  'Lead/Manager': 7,
  'Principal/Staff': 8,
  'Director+': 10,
}
export const EXPERIENCE_LEVELS = Object.keys(LEVEL_YEARS)

// Normalised work mode and employment kind of a job (app.jobs.work_mode / employment_kind); 'unknown' = not stated
export const WORK_MODE_LABELS = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', unknown: 'Not stated' }
export const EMPLOYMENT_LABELS = {
  full_time: 'Full-time',
  contract: 'Contract',
  internship: 'Internship',
  part_time: 'Part-time',
  other: 'Other',
  unknown: 'Not stated',
}

export function isApplied(job) {
  return Boolean(job?.is_applied) || APPLIED_STATUSES.includes(job?.application_status)
}

// Applied (any stage) or saved
export function isTracked(job) {
  return isApplied(job) || Boolean(job?.application_status && job.application_status !== 'not_applied')
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.not_applied
}

// Core skills, then the also-know ones, without case-insensitive repeats (what the job skills are compared with)
export function profileSkillList(profile) {
  const seen = new Set()
  const result = []
  for (const skill of [...(profile?.skills || []), ...(profile?.also_skills || [])]) {
    const key = String(skill).trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(String(skill).trim())
  }
  return result
}

// Company name as mute rules and duplicate groups compare it: "Barclays" = "Barclay", "PwC India" = "PWC".
// keep in sync: app.company_key() in supabase/app_api.sql ('' = not a company name)
const COMPANY_STOP_WORDS = new Set(['pvt', 'private', 'ltd', 'limited', 'inc', 'incorporated', 'llp', 'llc', 'plc', 'corp',
  'corporation', 'co', 'company', 'the', 'india', 'in', 'gmbh', 'ag', 'sa', 'bv', 'pte'])
const COMPANY_ALIASES = {
  'hewlett packard enterprise': 'hpe',
  pricewaterhousecoopers: 'pwc',
  pricewaterhousecooper: 'pwc',
  'ernst and young': 'ey',
  'tata consultancy service': 'tcs',
  'international business machine': 'ibm',
}

export function companyKey(name) {
  const tokens = String(name ?? '').toLowerCase().replaceAll('&', ' and ').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter(token => token && !COMPANY_STOP_WORDS.has(token))
  const last = tokens.length - 1
  if (last >= 0 && tokens[last].length >= 5 && /[^s]s$/.test(tokens[last])) tokens[last] = tokens[last].slice(0, -1)
  const key = tokens.join(' ')
  return COMPANY_ALIASES[key] ?? key
}

export function fitTone(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return 'none'
  if (score >= STRONG_FIT) return 'strong'
  if (score >= 50) return 'good'
  return 'low'
}

export function fitLabel(score) {
  return { strong: 'Strong fit', good: 'Good fit', low: 'Low fit', none: 'Not scored' }[fitTone(score)]
}

export function experienceLabel(job) {
  const min = job?.experience_min_years
  const max = job?.experience_max_years
  if (min === 0 && (max === null || max === undefined || max <= 1)) return 'Fresher'
  if (min !== null && min !== undefined && max !== null && max !== undefined && max > min) return `${min}–${max} yrs`
  if (min !== null && min !== undefined) return `${min}+ yrs`
  return job?.experience_level || null
}

export function jobDate(job) {
  return job?.posted_date || job?.first_seen_at || null
}

// Only http(s) links are used as hrefs / window.open targets (scraped data, so never javascript: or data:)
export function jobUrl(job) {
  const url = typeof job?.job_url === 'string' ? job.job_url.trim() : ''
  return /^https?:\/\//i.test(url) ? url : null
}

// Descriptions arrive as a single line (the pipeline collapses whitespace, and scrapers sometimes glue blocks
// together: "...a better world.Join us", "Scope:Core duties"). Restore some structure for reading: bullets on
// their own line and a line break where a sentence or heading runs straight into the next capitalised word.
export function formatDescription(value) {
  return String(value || '')
    .replace(/\s*[•·▪●◦]\s*/g, '\n• ')
    .replace(/([a-z0-9)\]][.!?:])(?=[A-Z][a-z])/g, '$1\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

// Splits the job's skills into ones you have and ones you don't.
// fit_matched_skills holds profile labels (a skill or a skill group such as "Cloud").
export function skillBuckets(job, profileSkills = []) {
  const jobSkills = Array.isArray(job?.skills) ? job.skills : []
  const matchedLabels = Array.isArray(job?.fit_matched_skills) ? job.fit_matched_skills : []
  const known = new Set([...matchedLabels, ...profileSkills].map(skill => String(skill).toLowerCase()))
  const have = jobSkills.filter(skill => known.has(skill.toLowerCase()))
  const missing = jobSkills.filter(skill => !known.has(skill.toLowerCase()))
  return { matchedLabels, have, missing }
}

let utcDayFormat = null // shared: creating an Intl formatter per day label is slow

// Fills the last `days` UTC days so the trend strip always has one entry per day (oldest first).
export function buildTrend(rows = [], days = 14, today = new Date()) {
  utcDayFormat ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const byDay = new Map(rows.map(row => [String(row.day).slice(0, 10), row]))
  const result = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset))
    const key = date.toISOString().slice(0, 10)
    const row = byDay.get(key)
    result.push({
      key,
      label: utcDayFormat.format(date),
      added: Number(row?.added ?? 0),
      applied: Number(row?.applied ?? 0),
    })
  }
  return result
}

export function facetOptions(facetRows = [], kind) {
  return facetRows.filter(row => row.kind === kind && row.value).map(row => ({ value: row.value, count: Number(row.n) || 0 }))
}
