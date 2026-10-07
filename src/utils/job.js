import { FOLLOW_UP_DAYS, isTracked } from './gold.js'

const NEW_JOB_MS = 2 * 24 * 3600 * 1000 // 2 days

// One shared formatter: toLocaleDateString builds a new Intl.DateTimeFormat on every call, which is slow per row.
let dayFormat = null

export function formatDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d)) return null
  dayFormat ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return dayFormat.format(d)
}

export function formatRelativeAge(dateStr) {
  if (!dateStr) return null

  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return null

  const diffMs = Date.now() - date.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)

  if (diffHours < 1) return 'Now'
  if (diffHours < 24) return `${Math.max(1, Math.round(diffHours))}h ago`

  const diffDays = Math.round(diffHours / 24)
  if (diffDays === 1) return '1d ago'
  if (diffDays < 7) return `${diffDays}d ago`

  return 'Older'
}

// "New" = first scraped within the last 2 days.
export function isNewJob(firstSeenAt) {
  return firstSeenAt ? Date.now() - new Date(firstSeenAt).getTime() < NEW_JOB_MS : false
}

const STALE_DATA_MS = 12 * 3600 * 1000 // a publish older than this is shown in the warning tone

// "Updated 2 h ago" for the last pipeline publish; null when there is none (or the date is invalid).
export function dataFreshness(publishedAt, now = Date.now()) {
  if (!publishedAt) return null
  const date = new Date(publishedAt)
  if (Number.isNaN(date.getTime())) return null
  const ageMs = Math.max(now - date.getTime(), 0)
  const minutes = Math.floor(ageMs / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const ago = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : hours < 48 ? `${hours} h ago` : `${days} d ago`
  return { label: `Updated ${ago}`, stale: ageMs > STALE_DATA_MS, title: `Job data published ${date.toLocaleString()}` }
}

// The pipeline deletes an untracked job at the first run on or after UTC midnight of (job date + this + 1 days); job date =
// posted_date, else the UTC day it was first seen. keep in sync: job_delete_after_days in 04_gold_cleanup.
export const JOB_DELETE_AFTER_DAYS = 2
const EXPIRY_HINT_HOURS = 36

function utcDay(value) {
  const text = String(value || '')
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.slice(0, 10))
  if (match && text.length === 10) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const date = new Date(text)
  if (!text || Number.isNaN(date.getTime())) return null
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

// { hours, label } when an untracked job is deleted within 36 hours ("Expires in ~9h"), else null
export function expiryHint(job, now = Date.now()) {
  if (!job || isTracked(job)) return null
  const day = utcDay(job.posted_date) ?? utcDay(job.first_seen_at)
  if (day === null) return null
  const hoursLeft = (day + (JOB_DELETE_AFTER_DAYS + 1) * 24 * 3600 * 1000 - now) / 3600_000
  if (hoursLeft <= 0) return { hours: 0, label: 'Expires at the next run' }
  if (hoursLeft > EXPIRY_HINT_HOURS) return null
  const hours = Math.max(1, Math.ceil(hoursLeft))
  return { hours, label: `Expires in ~${hours}h` }
}

// A date-only value ('2026-10-12', next_action_at) as a local date, so it shows the same day in every time zone
export function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null
}

// Today as 'YYYY-MM-DD' in local time (date inputs, file names)
export function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// "Follow up Oct 12" for a job's next_action_at; null when none
export function followUpDateLabel(nextActionAt) {
  const day = parseDay(nextActionAt)
  if (!day) return null
  dayFormat ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return `Follow up ${dayFormat.format(day)}`
}

// Title of the "Follow up" chip (follow_up rows): the date you set has come, or no update for FOLLOW_UP_DAYS+ days
export function followUpTitle(job, now = Date.now()) {
  if (job?.next_action_at) return 'Follow-up date reached'
  const since = new Date(job?.status_updated_at || job?.applied_at || '')
  const days = Number.isNaN(since.getTime()) ? FOLLOW_UP_DAYS : Math.max(FOLLOW_UP_DAYS, Math.floor((now - since) / 86_400_000))
  return `Applied ${days} days ago with no update`
}

// Every job key a collapsed row stands for (itself first, then its near-duplicates, at most 20 of them)
export function groupKeys(job) {
  return [...new Set([job?.job_key, ...(Array.isArray(job?.dup_keys) ? job.dup_keys : [])].filter(Boolean))]
}

// "+2 more · Pune, Hyderabad" for a row standing for near-duplicate postings; null when it stands for itself only
export function dupLabel(job, maxCities = 3) {
  const count = Number(job?.dup_count) || 0
  if (count <= 0) return null
  const own = String(job.city || '').toLowerCase()
  const seen = new Set(own ? [own] : [])
  const cities = []
  for (const place of Array.isArray(job.dup_locations) ? job.dup_locations : []) {
    const key = String(place || '').trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    cities.push(String(place).trim())
    if (cities.length === maxCities) break
  }
  return cities.length ? `+${count} more · ${cities.join(', ')}` : `+${count} more`
}

// { label, title } for a row's place: "Pune +1" (the job lists more cities), titled with the raw location; null when the
// job names no city and no location
export function placeLabel(job) {
  const cities = Array.isArray(job?.cities) ? job.cities : []
  const city = job?.city || cities[0]
  if (!city) return job?.location ? { label: job.location, title: job.location } : null
  return { label: cities.length > 1 ? `${city} +${cities.length - 1}` : city, title: job.location || cities.join(', ') }
}
