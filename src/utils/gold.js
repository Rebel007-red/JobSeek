// Helpers for rows from Databricks gold.jobs.

// Fit components computed per user by the API (weights fixed there too: role 40%, skills 45%, experience 15%).
export const FIT_PARTS = [
  { key: 'fit_role', label: 'Role', weight: 0.4 },
  { key: 'fit_skills', label: 'Skills', weight: 0.45 },
  { key: 'fit_experience', label: 'Experience', weight: 0.15 },
]

// "For you" shows jobs matching your roles with at least this fit (same number as the API)
export const MATCH_MIN_FIT = 60

export function fitTone(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return 'none'
  if (score >= 70) return 'strong'
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

export function jobUrl(job) {
  return job?.job_url && job.job_url !== '#' ? job.job_url : null
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

// Fills the last `days` UTC days so the trend strip always has one entry per day (oldest first).
export function buildTrend(rows = [], days = 14, today = new Date()) {
  const byDay = new Map(rows.map(row => [String(row.day).slice(0, 10), row]))
  const result = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset))
    const key = date.toISOString().slice(0, 10)
    const row = byDay.get(key)
    result.push({
      key,
      label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      added: Number(row?.added ?? 0),
      applied: Number(row?.applied ?? 0),
    })
  }
  return result
}

export function facetOptions(facetRows = [], kind) {
  return facetRows.filter(row => row.kind === kind && row.value).map(row => ({ value: row.value, count: Number(row.n) || 0 }))
}
