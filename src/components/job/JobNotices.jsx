import { JOB_DELETE_AFTER_DAYS, expiryHint, followUpDateLabel, followUpTitle, formatDate } from '../../utils/job'
import { jobLink } from '../../utils/urlState'

// Short state badges under the drawer title: posting closed, expiry, follow-up, muted, hidden
export function JobBadges({ job }) {
  const expiry = expiryHint(job)
  const followUpDate = !job.follow_up ? followUpDateLabel(job.next_action_at) : null
  const badges = [
    job.is_active === false && { key: 'closed', tone: 'closed', label: 'Posting closed', title: 'The posting is no longer listed on the job board' },
    expiry && { key: 'expiry', tone: 'warning', label: expiry.label, title: `Jobs you have not saved or applied to are removed about ${JOB_DELETE_AFTER_DAYS} days after posting. Save it to keep it.` },
    job.follow_up && { key: 'follow', tone: 'warning', label: 'Follow up', title: followUpTitle(job) },
    followUpDate && { key: 'date', tone: 'neutral', label: followUpDate, title: 'Your follow-up date' },
    job.muted_by && { key: 'muted', tone: 'neutral', label: `Muted: ${job.muted_value || job.muted_by}`, title: 'Left out of your lists by a mute rule (Settings → Mute rules)' },
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

// An applied job whose posting closed: offer the usual endings
export function ClosedNotice({ job, status, onStatus }) {
  if (job.is_active !== false || status !== 'applied') return null
  return (
    <div className="drawer-banner" role="note">
      <p>This posting has closed. Update the status?</p>
      <div className="drawer-banner-actions">
        <button type="button" className="btn sm" onClick={() => onStatus('rejected')}>Rejected</button>
        <button type="button" className="btn sm" onClick={() => onStatus('withdrawn')}>Withdrawn</button>
      </div>
    </div>
  )
}
