import { expiryHint, followUpDateLabel, followUpTitle, formatDate, isNewJob, localDay, parseDay } from '../../utils/job'
import { jobLink } from '../../utils/urlState'

const DAY_MS = 86_400_000
// The AgeNotice asks about an application from this many days after it, and "No reply yet" asks again this much later
const AGE_NOTICE_DAYS = 7

// Short state badges under the drawer title: new since your last visit, expiry, follow-up, muted, hidden.
// since: useVisit's time of your last visit (the New badge). An older posting gets no badge: the subtitle says
// "Posted 5 days ago", since it may still be open.
export function JobBadges({ job, since }) {
  const expiry = expiryHint(job)
  const followUpDate = !job.follow_up ? followUpDateLabel(job.next_action_at) : null
  const badges = [
    isNewJob(job, since) && { key: 'new', tone: 'new', label: 'New', title: 'Found since your last visit' },
    expiry && { key: 'expiry', tone: 'warning', label: expiry.label, title: 'Jobs you haven\'t saved or applied to disappear 2 days after posting. Save it to keep it.' },
    job.follow_up && { key: 'follow', tone: 'warning', label: 'Follow up', title: followUpTitle(job) },
    followUpDate && { key: 'date', tone: 'neutral', label: followUpDate, title: 'Your follow-up date' },
    job.muted_by && { key: 'muted', tone: 'neutral', label: `Muted: ${job.muted_value || job.muted_by}`, title: 'Left out by your mute rules (Settings → Mute rules)' },
    job.is_hidden && { key: 'hidden', tone: 'neutral', label: 'Hidden', title: 'You hid this job (Settings → Hidden)' },
  ].filter(Boolean)
  if (!badges.length) return null
  return (
    <p className="drawer-badges">
      {badges.map(badge => <span key={badge.key} className={`drawer-badge ${badge.tone}`} title={badge.title}>{badge.label}</span>)}
    </p>
  )
}

// "You applied to a near-identical posting on Oct 4 · View it" (dup_applied_at / dup_applied_key from the list row).
// onOpenJob(jobKey) opens that job; without it the button is a link that opens the app on it.
export function DuplicateNotice({ job, onOpenJob }) {
  if (!job.dup_applied_at) return null
  const date = formatDate(job.dup_applied_at)
  const key = job.dup_applied_key
  return (
    <div className="drawer-banner warning" role="note">
      <p>You applied to a near-identical posting{date ? ` on ${date}` : ''}.</p>
      {key && (onOpenJob
        ? <button type="button" className="btn sm" onClick={() => onOpenJob(key)}>View it</button>
        : <a className="btn sm" href={jobLink(key)}>View it</a>)}
    </div>
  )
}

// Whole local calendar days since an ISO time (0 = today); null without a valid time
function daysSince(value, now) {
  const date = new Date(value || '')
  if (!value || Number.isNaN(date.getTime())) return null
  const today = new Date(now)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.round((start - day) / DAY_MS)
}

// 'YYYY-MM-DD' (local) of the day "No reply yet" asks again
const ageSnoozeDay = (now = Date.now()) => {
  const today = new Date(now)
  return localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() + AGE_NOTICE_DAYS))
}

// Days since the application when the AgeNotice should ask about it, else null: status exactly 'applied' (not yet
// moved on), applied 7+ days ago, and no follow-up date still ahead (No reply yet sets one 7 days out)
function ageNoticeDays(job, now = Date.now()) {
  // an older row without a status reads as applied when is_applied (as the drawer's statusOf does)
  const status = job?.application_status || (job?.is_applied ? 'applied' : null)
  if (status !== 'applied') return null
  const days = daysSince(job.applied_at, now)
  if (days === null || days < AGE_NOTICE_DAYS) return null
  const next = parseDay(String(job.next_action_at || '').slice(0, 10))
  if (next && localDay(next) > localDay(new Date(now))) return null
  return days
}

// "You applied 12 days ago. Heard back?" on an application a week or more old. onStatus(status) moves it on;
// onSnooze(nextActionAt) is "No reply yet": it sets the follow-up date ('YYYY-MM-DD', a week from today), which hides the
// notice until that day.
export function AgeNotice({ job, onStatus, onSnooze, busy = false }) {
  const days = ageNoticeDays(job)
  if (days === null) return null
  // Every answer takes the notice away: keyboard focus moves to the drawer's stage picker (else its Close button)
  // instead of dropping out of the dialog
  // (checked for 2 s: a status change takes the notice away only once it is saved)
  const answer = run => (e) => {
    const button = e.currentTarget
    const dialog = button.closest('[role="dialog"]')
    const until = Date.now() + 2000
    run()
    const check = () => {
      const now = document.activeElement
      if (now === button && button.isConnected && Date.now() < until) return setTimeout(check, 100)
      if (now && now !== document.body && now.isConnected) return undefined
      dialog?.querySelector('.status-picker, button[aria-label="Close details"]')?.focus({ preventScroll: true })
      return undefined
    }
    requestAnimationFrame(check)
  }
  return (
    <div className="drawer-banner age-notice" role="group" aria-label="Heard back?">
      <p>You applied {days} days ago. Heard back?</p>
      <div className="drawer-banner-actions">
        <button type="button" className="btn sm" disabled={busy} onClick={answer(() => onStatus('interviewing'))}>Interviewing</button>
        <button type="button" className="btn sm" disabled={busy} onClick={answer(() => onStatus('rejected'))}>Rejected</button>
        <button type="button" className="btn sm" disabled={busy} onClick={answer(() => onSnooze(ageSnoozeDay()))} title={`Ask again in ${AGE_NOTICE_DAYS} days`}>No reply yet</button>
        <button type="button" className="btn sm" disabled={busy} onClick={answer(() => onStatus('withdrawn'))}>Withdrawn</button>
      </div>
    </div>
  )
}
