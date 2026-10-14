import { CHECKIN_MIN_DAYS } from '../../utils/gold'
import { expiryHint, followUpDateLabel, followUpTitle, isNewJob, localDay, parseDay } from '../../utils/job'
import { checkinAnswers, daysSinceUpdate } from '../../utils/tracker'
import { localDaysSince } from './dates'

// Short state badges under the drawer title: new since your last visit, expiry, follow-up, muted, hidden.
// since: useVisit's time of your last visit (the New badge). An older posting gets no badge: the subtitle says
// "Posted 5 days ago", since it may still be open.
export function JobBadges({ job, since }) {
  const expiry = expiryHint(job)
  const followUpDate = !job.follow_up ? followUpDateLabel(job.next_action_at) : null
  const badges = [
    isNewJob(job, since) && { key: 'new', tone: 'new', label: 'New', title: 'Found since your last visit' },
    expiry && { key: 'expiry', tone: 'warning', label: expiry.label, title: 'Jobs you haven\'t saved or applied to disappear 7 days after posting. Save it to keep it.' },
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

// Days the AgeNotice asks about, else null: Applied or Interviewing (an older row without a status reads as Applied when
// is_applied, as the drawer's statusOf does) with no update for CHECKIN_MIN_DAYS+ days, and no follow-up date still ahead
// ("No reply yet" sets one a week out). The weekly check-in asks about the same applications (app.read_checkin).
// -> { stage, days } where days count from applying (Applied) or from the last update (Interviewing)
function ageNotice(job, now = Date.now()) {
  const stage = job?.application_status || (job?.is_applied ? 'applied' : null)
  if (stage !== 'applied' && stage !== 'interviewing') return null
  const since = daysSinceUpdate(job, now)
  if (since === null || since < CHECKIN_MIN_DAYS) return null
  const next = parseDay(String(job.next_action_at || '').slice(0, 10))
  if (next && localDay(next) > localDay(new Date(now))) return null
  return { stage, days: stage === 'applied' ? localDaysSince(job.applied_at, now) ?? since : since }
}

// "You applied 12 days ago. Heard back?" / "Interviewing for 9 days. Any news?" on an application with no update for a
// week. The answers are the weekly check-in's (tracker.js checkinAnswers), so the two never disagree: onStatus(status)
// moves it on; onSnooze(nextActionAt) asks again later (the follow-up date, 'YYYY-MM-DD' a week out, hides the notice
// until that day).
export function AgeNotice({ job, onStatus, onSnooze, busy = false }) {
  const notice = ageNotice(job)
  if (!notice) return null
  const answers = checkinAnswers(job)
  if (!answers.length) return null
  // Every answer takes the notice away: keyboard focus moves to the drawer's current stage (else its Close button)
  // instead of dropping out of the dialog (checked for 2 s: a status change takes the notice away only once it is saved)
  const answer = run => (e) => {
    const button = e.currentTarget
    const dialog = button.closest('[role="dialog"]')
    const until = Date.now() + 2000
    run()
    const check = () => {
      const now = document.activeElement
      if (now === button && button.isConnected && Date.now() < until) return setTimeout(check, 100)
      if (now && now !== document.body && now.isConnected) return undefined
      const target = dialog?.querySelector('.stage-step[aria-current="step"]') || dialog?.querySelector('button[aria-label="Close details"]')
      target?.focus({ preventScroll: true })
      return undefined
    }
    requestAnimationFrame(check)
  }
  const question = notice.stage === 'applied' ? 'Heard back?' : 'Any news?'
  const text = notice.stage === 'applied'
    ? `You applied ${notice.days} ${notice.days === 1 ? 'day' : 'days'} ago. Heard back?`
    : `Interviewing for ${notice.days} days. Any news?`
  return (
    <div className="drawer-banner age-notice" role="group" aria-label={question}>
      <p>{text}</p>
      <div className="drawer-banner-actions">
        {answers.map(item => (
          <button
            key={item.key}
            type="button"
            className={`btn sm ${item.suggested ? 'is-suggested' : ''}`}
            disabled={busy}
            title={item.title}
            aria-label={item.ariaLabel}
            onClick={answer(() => (item.kind === 'snooze' ? onSnooze(item.nextActionAt) : onStatus(item.status)))}
          >
            {item.label}
            {/* not by colour only: the suggestion is said in words too (as in the stage menu) */}
            {item.suggested && <span className="answer-suggested"><span aria-hidden="true">· </span>suggested</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
