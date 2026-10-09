// The jobs page's list bookkeeping: summary parameters, optimistic status edits and their counter changes.
import { APPLIED_STATUSES, HIDE_REASONS, STATUS_LABELS, STRONG_FIT, isApplied, isTracked } from '../../utils/gold'
import { groupKeys, isExpiring, isNewJob } from '../../utils/job'

// The hide reasons offered in the toast after a hide (app.c_hide_reasons; Other needs no button)
export const TOAST_REASONS = HIDE_REASONS.filter(reason => reason.value !== 'other')
// Where the "Edit my roles" / "Set My cities" levers after a reason go (Settings → Profile, scrolled to the field)
export const PROFILE_ANCHORS = { roles: '/settings?tab=profile#roles', cities: '/settings?tab=profile#cities' }
// Mute rule kind of a row's muted_by
export const MUTE_KINDS = { company: 'companies', title: 'titleWords', level: 'levels' }
// Filters only the Applied tab offers (its stage chips); left behind when you switch tabs
export const APPLIED_TAB_FILTERS = { stage: '', followUp: false, closed: '' }
// The summary ignores these (it counts every tab, stage and the muted jobs at once): left out, so the cached counts
// are shared and a stage chip does not re-read them
const SUMMARY_IGNORES = ['stage', 'followUp', 'closed', 'muteView']

// since: the ISO time of your last visit (useVisit), sent once it is known (new_since); undefined / null leave it out
export function summaryParams(filters, scope, since) {
  const params = { ...filters, scope }
  SUMMARY_IGNORES.forEach(key => delete params[key])
  if (typeof since === 'string' && since) params.since = since
  return params
}

// Keeps the counters right after a write until the summary is read again.
export function adjustSummary(summary, changes) {
  const next = { ...summary }
  Object.entries(changes).forEach(([key, delta]) => {
    if (next[key] !== undefined && next[key] !== null) next[key] = Math.max(Number(next[key]) + delta, 0)
  })
  return next
}

export function addChanges(total, changes) {
  Object.entries(changes).forEach(([key, delta]) => { total[key] = (total[key] || 0) + delta })
  return total
}

export const negate = (changes) => Object.fromEntries(Object.entries(changes).map(([key, delta]) => [key, -delta]))
export const statusOf = (job) => job.application_status || (job.is_applied ? 'applied' : 'not_applied')

const isStrong = (job) => Number(job?.fit_score) >= STRONG_FIT
const HOUR_MS = 3_600_000

// Whether a job is inside the Inbox's time window (postedWithin hours, '' = any date): the server's `fresh` in
// app.filtered_jobs. posted_date is only a date: a job posted today passes, one posted on the cutoff day passes only if
// it was first found inside the window; without posted_date, first_seen_at decides.
export function inTimeWindow(job, postedWithin, now = Date.now()) {
  const hours = Number(postedWithin)
  if (!postedWithin || !Number.isFinite(hours) || hours <= 0) return true
  const cutoff = now - hours * HOUR_MS
  const firstSeen = new Date(job?.first_seen_at || '').getTime()
  const posted = /^\d{4}-\d{2}-\d{2}/.exec(String(job?.posted_date || ''))?.[0]
  if (!posted) return Number.isFinite(firstSeen) && firstSeen >= cutoff
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10)
  const today = new Date(now).toISOString().slice(0, 10)
  return posted >= cutoffDay && (posted >= today || (Number.isFinite(firstSeen) && firstSeen >= cutoff))
}

// The counters an untracked, unhidden row stands in, each 1 or 0: the Inbox ones (inbox, inbox_strong, new_since) and
// muted only inside the time window (postedWithin); expiring and expiring_strong whatever the window (as the summary).
// A muted row counts only in muted.
function inboxCounters(job, since, postedWithin) {
  if (!job) return {}
  const counters = {}
  const inWindow = inTimeWindow(job, postedWithin)
  if (job.muted_by) {
    if (inWindow) counters.muted = 1
    return counters
  }
  if (inWindow) {
    counters.inbox = 1
    if (isStrong(job)) counters.inbox_strong = 1
    if (isNewJob(job, since)) counters.new_since = 1
  }
  if (job.in_for_you !== false && isExpiring(job)) {
    counters.expiring = 1
    if (isStrong(job)) counters.expiring_strong = 1
  }
  return counters
}

// Counter changes when a job moves to status (since: for new_since; postedWithin: the Inbox's time window). The 700 ms
// re-read of the summary fixes the rest.
export function statusChanges(job, status, since, postedWithin) {
  const wasApplied = isApplied(job)
  const nowApplied = APPLIED_STATUSES.includes(status)
  const changes = {}
  if (wasApplied !== nowApplied) {
    changes.applied = nowApplied ? 1 : -1
    changes.pending = nowApplied ? -1 : 1
  }
  if ((statusOf(job) === 'saved') !== (status === 'saved')) changes.saved = status === 'saved' ? 1 : -1
  const wasTracked = isTracked(job)
  const nowTracked = status !== 'not_applied'
  if (wasTracked !== nowTracked) {
    const sign = nowTracked ? -1 : 1
    Object.entries(inboxCounters(job, since, postedWithin)).forEach(([key, value]) => { changes[key] = sign * value })
  }
  return changes
}

// Counter changes when rows are hidden (hidden jobs count nowhere): untracked ones leave the Inbox (and the pending count
// of the old To apply), saved and applied ones leave their tab
export function hideChanges(jobs, since, postedWithin) {
  return jobs.reduce((total, job) => {
    if (isApplied(job)) return addChanges(total, { applied: -1 })
    if (isTracked(job)) return addChanges(total, statusOf(job) === 'saved' ? { saved: -1 } : {})
    const changes = { ...inboxCounters(job, since, postedWithin) }
    if (!job.muted_by) changes.pending = 1
    Object.keys(changes).forEach(key => { changes[key] = -changes[key] })
    return addChanges(total, changes)
  }, {})
}

// Whether a row still belongs on a tab after a write: Inbox = untracked, Saved = saved, Applied = any applied stage
export function belongsToTab(job, tab) {
  if (tab === 'saved') return statusOf(job) === 'saved' && !isApplied(job)
  if (tab === 'applied') return isApplied(job)
  return !isTracked(job)
}

// The stage a right swipe moves an application on to (none after an offer or a final answer)
const NEXT_STAGE = { applied: 'interviewing', interviewing: 'offer' }

// What a swipe does on a row of this tab: { right, left }, each null (no swipe that way) or { action, label, tone,
// status? }. action: 'save' | 'applied' | 'unsave' | 'stage' | 'hide'; tone: 'primary' | 'success' | 'danger' (the hint's
// colour, as the toast after it). rightApplies: Settings → Account "Swipe right marks applied" (Inbox only).
export function swipeActions(job, tab, rightApplies = false) {
  if (tab === 'applied' || (tab !== 'saved' && isApplied(job))) {
    const next = NEXT_STAGE[statusOf(job)]
    return {
      right: next ? { action: 'stage', status: next, label: `Move to ${STATUS_LABELS[next]}`, tone: 'success' } : null,
      left: null,
    }
  }
  if (tab === 'saved' || statusOf(job) === 'saved') {
    return {
      right: { action: 'applied', label: 'Mark applied', tone: 'success' },
      left: { action: 'unsave', label: 'Unsave', tone: 'danger' },
    }
  }
  return {
    right: rightApplies ? { action: 'applied', label: 'Mark applied', tone: 'success' } : { action: 'save', label: 'Save', tone: 'primary' },
    left: { action: 'hide', label: 'Hide', tone: 'danger' },
  }
}

// The row fields a status write changes (as the server sets them), and their values before it
export function statusPatch(job, status, now) {
  const applied = APPLIED_STATUSES.includes(status)
  return {
    application_status: status,
    is_applied: applied,
    applied_at: applied ? job.applied_at || now : null,
    status_updated_at: now,
    follow_up: false,
  }
}

export const statusFields = (job) => ({
  application_status: statusOf(job),
  is_applied: Boolean(job.is_applied),
  applied_at: job.applied_at ?? null,
  status_updated_at: job.status_updated_at ?? null,
  follow_up: Boolean(job.follow_up),
})

export const todayKey = () => new Date().toISOString().slice(0, 10) // trend days are UTC dates

// Adds delta to today's applied count in the trend rows (keeps "applied today" right without a query).
export function bumpAppliedToday(rows, delta) {
  const today = todayKey()
  if (!rows.some(row => String(row.day).slice(0, 10) === today)) {
    return delta > 0 ? [...rows, { day: today, added: 0, applied: delta }] : rows
  }
  return rows.map(row => (String(row.day).slice(0, 10) === today ? { ...row, applied: Math.max(Number(row.applied) + delta, 0) } : row))
}

export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

// The job keys a row's hide covers: a collapsed row stands for its near-duplicates too
export function hideKeys(job, expanded) {
  return expanded ? [job.job_key] : groupKeys(job)
}
