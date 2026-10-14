// The Applied tab as a tracker: the words of an application row, the weekly check-in's answers and timing, the funnel
// line, and the counts and relaxations of the filter panel and the empty state. Pure: everything takes `now`.
// The server decides what needs action (app.user_jobs action_rank) and what the check-in asks about (app.read_checkin);
// these helpers only put it into words, with the same thresholds (gold.js, pinned in sql_constants.test.js).
import { CHECKIN_MIN_DAYS, FOLLOW_UP_DAYS, INTERVIEW_STALE_DAYS, NO_REPLY_DAYS, STATUS_LABELS } from './gold.js'
import { localDay, parseDay } from './job.js'

const DAY_MS = 86_400_000

let dayFormat = null // shared: one Intl formatter for every row

function shortDay(date) {
  dayFormat ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return dayFormat.format(date)
}

// A timestamp or a date-only value as a Date; null when missing or invalid
function toDate(value) {
  if (!value) return null
  const day = parseDay(value)
  if (day) return day
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())

// Whole local calendar days from `date` to `now` (0 = today, negative = a later day)
function localDaysSince(date, now) {
  return Math.round((startOfDay(new Date(now)) - startOfDay(date)) / DAY_MS)
}

// The stage the row is in (rows of an older API may only have is_applied)
const stageOf = (job) => job?.application_status || (job?.is_applied ? 'applied' : 'not_applied')

// action_rank of the row (1 = follow-up date came, 2 = stale interview, 3 = no reply for FOLLOW_UP_DAYS, 0 = nothing).
// Rows of an older API have only follow_up (an applied job with a date that came, or 14+ days without an update).
function actionRank(job) {
  if (job?.action_rank !== undefined && job?.action_rank !== null) return Number(job.action_rank) || 0
  if (job?.follow_up) return job.next_action_at ? 1 : 3
  return 0
}

// Whole local days since the application last changed (status_updated_at, else applied_at); null without a date
export function daysSinceUpdate(job, now = Date.now()) {
  const date = toDate(job?.status_updated_at) || toDate(job?.applied_at)
  return date ? Math.max(localDaysSince(date, now), 0) : null
}

// 'Applied today' | 'Applied yesterday' | 'Applied 8d ago' (local days since applied_at); null without a date
export function appliedAgo(job, now = Date.now()) {
  const date = toDate(job?.applied_at)
  if (!date) return null
  const days = localDaysSince(date, now)
  if (days <= 0) return 'Applied today'
  if (days === 1) return 'Applied yesterday'
  return `Applied ${days}d ago`
}

// 'no_response' when the application is plain 'applied' and applied_at is NO_REPLY_DAYS+ days ago, else null (the
// server's checkin.suggest uses the same rule: applied_at <= now() - c_no_reply_days())
export function suggestedStage(job, now = Date.now()) {
  if (stageOf(job) !== 'applied') return null
  const applied = toDate(job?.applied_at)
  return applied && now - applied.getTime() >= NO_REPLY_DAYS * DAY_MS ? 'no_response' : null
}

// The row's to-do flag from action_rank: null | { label, title, tone: 'warning' }
export function actionFlag(job, now = Date.now()) {
  const rank = actionRank(job)
  const since = daysSinceUpdate(job, now)
  if (rank === 1) return { label: 'Follow up', title: 'Your follow-up date has come', tone: 'warning' }
  if (rank === 2) {
    const days = Math.max(since ?? 0, INTERVIEW_STALE_DAYS)
    return { label: `No update ${days}d`, title: `Interviewing with no update for ${days} days`, tone: 'warning' }
  }
  if (rank === 3) {
    const days = Math.max(since ?? 0, FOLLOW_UP_DAYS)
    // "Mark it No reply?" exactly when the stage menu suggests No reply (suggestedStage), so the two never disagree
    const title = suggestedStage(job, now)
      ? `Applied ${days} days ago with no update. Mark it No reply?`
      : `Applied ${days} days ago with no update`
    return { label: `No update ${days}d`, title, tone: 'warning' }
  }
  return null
}

// 'Next Oct 12' when next_action_at is today or later and nothing needs action yet, else null
export function nextLabel(job, now = Date.now()) {
  const day = parseDay(job?.next_action_at)
  if (!day || actionRank(job) !== 0 || day < startOfDay(new Date(now))) return null
  return `Next ${shortDay(day)}`
}

// 'YYYY-MM-DD' (local) of today + days
function dayAfter(days, now) {
  const today = new Date(now)
  return localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days))
}

const ASK_AGAIN = `Ask again in ${CHECKIN_MIN_DAYS} days`

// The follow-up date of every "ask again later" (the check-in's snoozes, the stage menu's "Followed up"): local
// 'YYYY-MM-DD' CHECKIN_MIN_DAYS from today
export const askAgainDay = (now = Date.now()) => dayAfter(CHECKIN_MIN_DAYS, now)

// Stages whose follow-up date can be moved on ("Followed up · ask again in 7 days"): the open ones and No reply, the
// stages a due follow-up date makes Needs action (app.user_jobs action_rank 1)
export const SNOOZE_STAGES = ['applied', 'interviewing', 'offer', 'no_response']
export const FOLLOWED_UP_LABEL = `Followed up · ask again in ${CHECKIN_MIN_DAYS} days`

// The check-in answers for one application, in button order, hotkeys '1'..'5' (the weekly sheet and the drawer's age
// notice use the same list, so the two never disagree):
//   applied, under 21 days: Heard back (Interviewing) · Rejected · No reply yet (ask again) · Withdrawn
//   applied, 21+ days:      Heard back · Rejected · No reply (suggested) · Withdrawn · Still waiting (ask again)
//   interviewing:           Offer · Rejected · Still interviewing (ask again) · Withdrawn
// -> [{ key, label, kind: 'status' | 'snooze', status?, nextActionAt?, suggested, hotkey, title?, ariaLabel? }]
// A snooze sets the follow-up date (nextActionAt, local 'YYYY-MM-DD') CHECKIN_MIN_DAYS from today. [] for other stages.
export function checkinAnswers(job, now = Date.now()) {
  const stage = stageOf(job)
  const snoozeTo = askAgainDay(now)
  const status = (key, label, value, extra = {}) => ({ key, label, kind: 'status', status: value, suggested: false, ...extra })
  const snooze = (key, label) => ({ key, label, kind: 'snooze', nextActionAt: snoozeTo, suggested: false, title: ASK_AGAIN })
  let answers = []
  if (stage === 'applied') {
    const heardBack = status('heard_back', 'Heard back', 'interviewing', { ariaLabel: 'Heard back: move to Interviewing' })
    const rejected = status('rejected', 'Rejected', 'rejected')
    const withdrawn = status('withdrawn', 'Withdrawn', 'withdrawn')
    answers = suggestedStage(job, now)
      ? [heardBack, rejected,
          status('no_reply', STATUS_LABELS.no_response, 'no_response', { suggested: true, title: 'No answer in 3 weeks: mark it No reply' }),
          withdrawn, snooze('still_waiting', 'Still waiting')]
      : [heardBack, rejected, snooze('no_reply_yet', 'No reply yet'), withdrawn]
  } else if (stage === 'interviewing') {
    answers = [status('offer', 'Offer', 'offer'), status('rejected', 'Rejected', 'rejected'),
      snooze('still_interviewing', 'Still interviewing'), status('withdrawn', 'Withdrawn', 'withdrawn')]
  }
  return answers.map((answer, index) => ({ ...answer, hotkey: String(index + 1) }))
}

// The local Monday 00:00 of now's week (Date)
export function weekStart(now = Date.now()) {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7))
}

// Whether the weekly sheet opens by itself: something to ask about, and not shown yet this local week (Monday 00:00
// onwards). Covers "the first visit on Monday" and "back after 7+ days away" (always a new week), at most once a week.
export function isCheckinDue({ lastCheckinAt, total } = {}, now = Date.now()) {
  if (!(Number(total) > 0)) return false
  const last = lastCheckinAt ? new Date(lastCheckinAt) : null
  if (!last || Number.isNaN(last.getTime())) return true
  return last < weekStart(now)
}

// Share of applications that got any answer, as a whole percent; null without applications
export function replyRate({ applied, replied } = {}) {
  const a = Number(applied) || 0
  return a > 0 ? Math.round((100 * (Number(replied) || 0)) / a) : null
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// '138 applied → 4 replies (3%) → 2 interviews → 1 offer · median reply 6 d' for summary.funnel; null without it or
// with no applications (interviews and offers only when there are some)
export function funnelText(funnel) {
  const applied = Number(funnel?.applied) || 0
  if (applied <= 0) return null
  const replied = Number(funnel.replied) || 0
  const interviewed = Number(funnel.interviewed) || 0
  const offers = Number(funnel.offers) || 0
  let text = `${applied} applied → ${plural(replied, 'reply', 'replies')} (${replyRate({ applied, replied })}%)`
  if (interviewed > 0) text += ` → ${plural(interviewed, 'interview', 'interviews')}`
  if (offers > 0) text += ` → ${plural(offers, 'offer', 'offers')}`
  const median = funnel.median_reply_days
  if (median !== null && median !== undefined && Number.isFinite(Number(median))) {
    text += ` · median reply ${Number(median) < 1 ? '<1' : Math.round(Number(median))} d`
  }
  return text
}

// The count "Show N jobs" and the empty state use for a tab (summary = app_read summary for the page's filters):
// inbox -> inbox (the muted view: muted); saved -> saved; applied -> the chip's count (needs_action, stages[stage],
// follow_up or closed of an old link) or applied. null when the key is missing (an older API, not loaded yet) or when
// two Applied-tab filters are combined (no count covers both).
export function liveCount(summary, tab, filters = {}) {
  const value = (raw) => (raw === undefined || raw === null || raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw))
  if (!summary) return null
  if (tab === 'inbox') return value(filters.muteView === 'only' ? summary.muted : summary.inbox)
  if (tab === 'saved') return value(summary.saved)
  if (tab !== 'applied') return null
  const chips = [filters.needsAction === true, Boolean(filters.stage), filters.followUp === true, Boolean(filters.closed)]
  if (chips.filter(Boolean).length > 1) return null
  if (filters.needsAction === true) return value(summary.needs_action)
  if (filters.stage) return value(summary.stages?.[filters.stage])
  if (filters.followUp === true) return value(summary.follow_up)
  if (filters.closed === 'only') return value(summary.closed)
  if (filters.closed === 'hide') {
    const [all, closed] = [value(summary.applied), value(summary.closed)]
    return all === null || closed === null ? null : Math.max(all - closed, 0)
  }
  return value(summary.applied)
}

// The one-filter relaxations an empty list can offer, in this order, only those currently set
const RELAXABLE = [
  { key: 'minFit', label: 'Any fit' },
  { key: 'matchedOnly', label: 'Any skills' },
  { key: 'maxYears', label: 'Any experience' },
  { key: 'myCities', label: 'Any city' },
  { key: 'city', label: 'Any city' },
  { key: 'workMode', label: 'Any work mode' },
  { key: 'role', label: 'Any role' },
  { key: 'category', label: 'Any category' },
  { key: 'company', label: 'Any company' },
  { key: 'source', label: 'Any source' },
  { key: 'employment', label: 'Any employment' },
  { key: 'location', label: 'Any location' },
]
const isSet = (value) => value === true || (typeof value === 'string' ? value.trim() !== '' : value !== false && value !== null && value !== undefined)

// -> [{ key, label, patch: { filters?: {...}, scope?: 'all' } }]: the search, the time window and the scope (Inbox only),
// then the panel filters. My cities and City are one relaxation ("Any city" clears both), so no two buttons share a
// label. patch.filters is merged into the filters; patch.scope (and a filters.postedWithin) go through the scope menu.
export function relaxations(filters = {}, scope = 'match', tab = 'inbox') {
  const result = []
  if (isSet(filters.q)) result.push({ key: 'q', label: 'Clear search', patch: { filters: { q: '' } } })
  if (tab === 'inbox' && isSet(filters.postedWithin)) {
    result.push({ key: 'postedWithin', label: 'Any date', patch: { filters: { postedWithin: '' } } })
  }
  if (tab === 'inbox' && scope === 'match') result.push({ key: 'scope', label: 'Everything', patch: { scope: 'all' } })
  for (const { key, label } of RELAXABLE) {
    if (!isSet(filters[key])) continue
    if (key === 'city' && isSet(filters.myCities)) continue // covered by the My cities one
    const patch = key === 'myCities' || key === 'city'
      ? { myCities: false, city: '' }
      : { [key]: key === 'matchedOnly' ? false : '' }
    result.push({ key, label, patch: { filters: patch } })
  }
  return result
}
