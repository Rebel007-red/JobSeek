// The jobs page's list bookkeeping: summary parameters, optimistic status edits and their counter changes.
import { APPLIED_STATUSES, HIDE_REASONS, isApplied } from '../../utils/gold'
import { groupKeys } from '../../utils/job'

// The hide reasons offered in the toast after a hide (Other needs no button)
export const TOAST_REASONS = HIDE_REASONS.filter(reason => reason.value !== 'other')
// Mute rule kind of a row's muted_by
export const MUTE_KINDS = { company: 'companies', title: 'titleWords', level: 'levels' }
// Filters only the Applied tab offers (its stage chips); left behind when you switch tabs
export const APPLIED_TAB_FILTERS = { stage: '', followUp: false, closed: '' }
// The summary ignores these (it counts every tab, stage and the muted jobs at once): left out, so the cached counts
// are shared and a stage chip does not re-read them
const SUMMARY_IGNORES = ['stage', 'followUp', 'closed', 'muteView']

export function summaryParams(filters, scope) {
  const params = { ...filters, scope }
  SUMMARY_IGNORES.forEach(key => delete params[key])
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

// Counter changes when a job moves to status
export function statusChanges(job, status) {
  const wasApplied = isApplied(job)
  const nowApplied = APPLIED_STATUSES.includes(status)
  const changes = {}
  if (wasApplied !== nowApplied) {
    changes.applied = nowApplied ? 1 : -1
    changes.pending = nowApplied ? -1 : 1
  }
  if ((statusOf(job) === 'saved') !== (status === 'saved')) changes.saved = status === 'saved' ? 1 : -1
  return changes
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
