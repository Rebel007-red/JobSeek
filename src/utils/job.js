import { FOLLOW_UP_DAYS, isTracked } from './gold.js'
import { clockLabel } from './schedule.js'

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

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

// "New" = an untracked job found since your last visit (since: ISO time from useVisit; undefined / null = not known yet
// or a first visit, so nothing is new). A job found exactly at `since` is not new (the server's first_seen_at > since).
export function isNewJob(job, since) {
  if (!job || !since || isTracked(job)) return false
  const found = new Date(job.first_seen_at || '').getTime()
  const last = new Date(since).getTime()
  return Number.isFinite(found) && Number.isFinite(last) && found > last
}

let timeFormat = null
let weekdayTimeFormat = null

// When your last visit was, for "12 new since 9:51 AM": the time today, "Mon 9:51 AM" within the last week, else "Oct 2"
export function sinceLabel(since, now = Date.now()) {
  const date = new Date(since || '')
  if (!since || Number.isNaN(date.getTime())) return null
  const today = new Date(now)
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  timeFormat ??= new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return timeFormat.format(date)
  if (now - date.getTime() < 6 * DAY_MS) {
    weekdayTimeFormat ??= new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    return weekdayTimeFormat.format(date)
  }
  return formatDate(since)
}

// A publish older than this means the updates are delayed: the "Updated …" label turns amber and the page shows a banner
export const STALE_DATA_MS = 6 * HOUR_MS

// "Updated 2 h ago" for the last pipeline publish, with { stale, hours } (whole hours since it); null when there is none
// (or the date is invalid).
export function dataFreshness(publishedAt, now = Date.now()) {
  if (!publishedAt) return null
  const date = new Date(publishedAt)
  if (Number.isNaN(date.getTime())) return null
  const ageMs = Math.max(now - date.getTime(), 0)
  const minutes = Math.floor(ageMs / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const ago = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : hours < 48 ? `${hours} h ago` : `${days} d ago`
  return { label: `Updated ${ago}`, stale: ageMs > STALE_DATA_MS, hours, title: `Last update: ${date.toLocaleString()}` }
}

// The stale banner's text for a dataFreshness() result; null while the data is fresh
export function staleBannerText(freshness) {
  if (!freshness?.stale) return null
  return `Job updates are delayed: the last one was ${freshness.hours} h ago. New jobs will appear when they resume.`
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

// { hours, label } when an untracked job is deleted within 36 hours ("Disappears in ~9h"), else null
export function expiryHint(job, now = Date.now()) {
  if (!job || isTracked(job)) return null
  const day = utcDay(job.posted_date) ?? utcDay(job.first_seen_at)
  if (day === null) return null
  const hoursLeft = (day + (JOB_DELETE_AFTER_DAYS + 1) * DAY_MS - now) / HOUR_MS
  if (hoursLeft <= 0) return { hours: 0, label: 'Disappears at the next update' }
  if (hoursLeft > EXPIRY_HINT_HOURS) return null
  const hours = Math.max(1, Math.ceil(hoursLeft))
  return { hours, label: `Disappears in ~${hours}h` }
}

// "Expiring tonight": an untracked job on its last UTC day (24 h or less left, or overdue). The same rule as the server's
// expiring list and count (job_date <= current_date - app.c_job_delete_after_days()).
export function isExpiring(job, now = Date.now()) {
  return (expiryHint(job, now)?.hours ?? Infinity) <= 24
}

// When tonight's expiring jobs go: the next UTC midnight (5:30 AM in India). They are deleted by the first update after it.
export function nextExpiryAt(now = Date.now()) {
  const date = new Date(now)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1))
}

// The Expiring strip's words for summary { expiring, expiring_strong } and the rows it shows:
// { title: 'Expiring tonight · 4 jobs', subtitle: '2 strong fits · disappear after 5:30 AM. Save to keep them.',
//   time: '5:30 AM', timeTitle, saveAll: 'Save all' | 'Save all 3 shown' | 'Save 1 shown' }
export function expiringStripCopy({ count, strong, shown } = {}, now = Date.now()) {
  const n = Number(count) || 0
  const s = Number(strong) || 0
  const time = clockLabel(nextExpiryAt(now))
  const after = `disappear after ${time}. Save to keep them.`
  const k = Number(shown) || 0
  return {
    title: `Expiring tonight · ${n} ${n === 1 ? 'job' : 'jobs'}`,
    subtitle: s ? `${s} strong ${s === 1 ? 'fit' : 'fits'} · ${after}` : `D${after.slice(1)}`,
    time,
    timeTitle: 'At the first update after midnight UTC',
    saveAll: k && n > k ? (k === 1 ? 'Save 1 shown' : `Save all ${k} shown`) : 'Save all',
  }
}

// Whole local calendar days from `date` to `now` (0 = today, negative = a later day)
function daysAgo(date, now) {
  const today = new Date(now)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.round((start - day) / DAY_MS)
}

function agoText(verb, days) {
  if (days <= 0) return `${verb} today`
  if (days === 1) return `${verb} yesterday`
  return `${verb} ${days} days ago`
}

// "Posted 5 days ago" / "Posted yesterday" / "Posted today" from posted_date, else "Found …" from first_seen_at; null
// without dates. Neutral wording for an older posting: it may still be open.
export function postedAgo(job, now = Date.now()) {
  const posted = parseDay(job?.posted_date)
  if (posted) return agoText('Posted', daysAgo(posted, now))
  const found = new Date(job?.first_seen_at || '')
  if (!job?.first_seen_at || Number.isNaN(found.getTime())) return null
  return agoText('Found', daysAgo(found, now))
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

// The other places of a row's near-duplicate postings, without the row's own city and repeats (job order)
function dupCities(job) {
  const own = String(job?.city || '').toLowerCase()
  const seen = new Set(own ? [own] : [])
  const cities = []
  for (const place of Array.isArray(job?.dup_locations) ? job.dup_locations : []) {
    const key = String(place || '').trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    cities.push(String(place).trim())
  }
  return cities
}

// "+2 more · Pune, Hyderabad" for a row standing for near-duplicate postings; null when it stands for itself only
export function dupLabel(job, maxCities = 3) {
  const count = Number(job?.dup_count) || 0
  if (count <= 0) return null
  const cities = dupCities(job).slice(0, maxCities)
  return cities.length ? `+${count} more · ${cities.join(', ')}` : `+${count} more`
}

// The compact duplicate button of a row: { label: '+6', title: 'Also posted in Pune, Navi Mumbai, Chennai and 3 more' };
// null when the row stands for itself only. "N more" counts the postings not named (several can share a city).
export function dupPill(job, maxCities = 3) {
  const count = Number(job?.dup_count) || 0
  if (count <= 0) return null
  const shown = dupCities(job).slice(0, maxCities)
  const more = count - shown.length
  let title
  if (!shown.length) title = `Also posted ${count} more ${count === 1 ? 'time' : 'times'}`
  else if (more > 0) title = `Also posted in ${shown.join(', ')} and ${more} more`
  else if (shown.length === 1) title = `Also posted in ${shown[0]}`
  else title = `Also posted in ${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
  return { label: `+${count}`, title }
}

// { label, title } for a row's place: "Pune +1" (the job lists more cities), titled with the raw location; null when the
// job names no city and no location
export function placeLabel(job) {
  const cities = Array.isArray(job?.cities) ? job.cities : []
  const city = job?.city || cities[0]
  if (!city) return job?.location ? { label: job.location, title: job.location } : null
  return { label: cities.length > 1 ? `${city} +${cities.length - 1}` : city, title: job.location || cities.join(', ') }
}
