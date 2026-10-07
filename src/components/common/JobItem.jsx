import { useId } from 'react'
import { dupLabel, expiryHint, followUpDateLabel, followUpTitle, formatDate, formatRelativeAge, isNewJob, placeLabel } from '../../utils/job'
import { WORK_MODE_LABELS, experienceLabel, fitLabel, fitTone, isApplied, jobDate, statusLabel } from '../../utils/gold'
import { NoteIcon } from './icons'
import { Swipeable } from './Swipeable'

// Statuses shown as a tag outside the Applied tab (plain "Applied" already shows as the date)
const STAGE_TAGS = new Set(['interviewing', 'offer', 'rejected', 'withdrawn'])
const MUTED_BY = { company: 'Company', title: 'Title word', level: 'Level' }

// What a screen reader hears after the row's name (its title and company): "New. Fit 82, strong fit. Applied Oct 4.
// Posting closed. Expires in ~9h."
function rowSummary(job) {
  const parts = []
  if (!isApplied(job) && isNewJob(job.first_seen_at)) parts.push('New')
  const score = Number(job.fit_score)
  parts.push(fitTone(job.fit_score) === 'none' ? 'Fit not scored' : `Fit ${Math.round(score)}, ${fitLabel(job.fit_score).toLowerCase()}`)
  if (isApplied(job)) {
    const status = job.application_status && job.application_status !== 'applied' ? ` (${statusLabel(job.application_status).toLowerCase()})` : ''
    parts.push(`Applied ${formatDate(job.applied_at) || ''}${status}`.trim())
  } else if (job.application_status === 'saved') {
    parts.push('Saved')
  }
  if (job.is_active === false) parts.push('Posting closed')
  const expiry = expiryHint(job)
  if (expiry) parts.push(expiry.label)
  if (job.follow_up) parts.push(followUpTitle(job))
  if (job.dup_applied_at) parts.push('You applied to a near-identical posting')
  if (Number(job.dup_count) > 0) parts.push(`${job.dup_count} similar ${Number(job.dup_count) === 1 ? 'posting' : 'postings'}`)
  if (job.muted_by) parts.push(`Muted by your rule: ${job.muted_value}`)
  if (job.has_note) parts.push('Has a note')
  return `${parts.join('. ')}.`
}

// Shared shell of a list row / card: click or Enter opens the drawer, swipe right = applied, left = hide.
// className is the base class ('job-row' | 'job-card'); data-job-key lets the page scroll the selection into view.
// actions: the page's stable handlers ({ open, applied, save, hide, status, select, toggleGroup, unmute, opened, focus });
// focus makes a row the keyboard shortcuts' current job when it (or one of its buttons) takes focus.
// selectMode: taps select instead of opening (phones); Shift+click always extends the selection.
// labelledBy: the ids of the title and company elements, which name the row for screen readers.
export function JobItem({ job, className, active, selected = false, selectMode = false, child = false, labelledBy, actions, children }) {
  const applied = isApplied(job)
  const summaryId = useId()

  return (
    <Swipeable onLeft={() => actions.hide(job)} onRight={applied ? undefined : () => actions.applied(job, true)}>
      <article
        data-job-key={job.job_key}
        className={[
          className,
          applied ? 'is-applied' : '',
          active ? 'is-active' : '',
          selected ? 'is-selected' : '',
          child ? 'is-group-child' : '',
          job.is_active === false ? 'is-closed' : '',
          job.muted_by ? 'is-muted' : '',
        ].filter(Boolean).join(' ')}
        onMouseDown={(e) => { if (e.shiftKey) e.preventDefault() }} // Shift+click selects rows, not text
        onClick={(e) => {
          if (e.shiftKey) actions.select(job, { range: true })
          else if (selectMode) actions.select(job)
          else actions.open(job)
        }}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && e.key === 'Enter') {
            e.preventDefault()
            actions.open(job)
          }
        }}
        onFocus={() => actions.focus?.(job)}
        tabIndex={0}
        aria-labelledby={labelledBy}
        aria-describedby={summaryId}
      >
        {children}
        <span id={summaryId} className="sr-only">{rowSummary(job)}</span>
      </article>
    </Swipeable>
  )
}

export function NewJobDot({ job }) {
  if (isApplied(job) || !isNewJob(job.first_seen_at)) return null
  return <i className="new-dot" title="Found in the last 48 hours" aria-hidden="true" />
}

export function ExperienceTag({ job }) {
  const experience = experienceLabel(job)
  return <span className={`exp-tag ${experience ? '' : 'unknown'}`} title="Experience required">{experience || 'Exp n/a'}</span>
}

// When you applied, otherwise how long ago the job was posted (or first found)
export function JobDateTag({ job }) {
  if (isApplied(job)) return <span className="row-date applied">Applied {formatDate(job.applied_at) || ''}</span>
  const date = jobDate(job)
  return (
    <span className={`row-date ${isNewJob(job.first_seen_at) ? 'new' : ''}`} title={formatDate(date) || undefined}>
      {formatRelativeAge(date)}
    </span>
  )
}

// City (+N more cities, titled with the raw location) and a Remote / Hybrid tag, for the meta line
export function JobPlace({ job, fallback = null }) {
  const place = placeLabel(job)
  const mode = job.work_mode === 'remote' || job.work_mode === 'hybrid' ? WORK_MODE_LABELS[job.work_mode] : null
  return (
    <>
      {place ? <span title={place.title}>{place.label}</span> : fallback && <span>{fallback}</span>}
      {mode && <span className={`mode-tag ${job.work_mode}`}>{mode}</span>}
    </>
  )
}

// State badges: posting closed, expiry, follow-up, applied to a duplicate, muted, a stage, a note
export function JobFlags({ job, showStage = true }) {
  const expiry = expiryHint(job)
  const followUpDate = !job.follow_up && job.next_action_at ? followUpDateLabel(job.next_action_at) : null
  const flags = []
  if (job.muted_by) {
    flags.push(<span key="muted" className="flag muted" title={`${MUTED_BY[job.muted_by] || 'Rule'}: ${job.muted_value}`}>Muted: {job.muted_value}</span>)
  }
  if (job.is_active === false) flags.push(<span key="closed" className="flag closed" title="The posting is no longer listed by the company">Posting closed</span>)
  if (expiry) flags.push(<span key="expiry" className="flag warning" title="Untracked jobs are removed 2 days after posting. Save it to keep it">{expiry.label}</span>)
  if (job.follow_up) flags.push(<span key="follow" className="flag warning" title={followUpTitle(job)}>Follow up</span>)
  else if (followUpDate) flags.push(<span key="follow" className="flag" title="Your follow-up date">{followUpDate}</span>)
  if (job.dup_applied_at) {
    flags.push(
      <span key="dup" className="flag warning" title={`You applied to a near-identical posting on ${formatDate(job.dup_applied_at) || 'an earlier date'}`}>
        Applied to a duplicate
      </span>,
    )
  }
  if (showStage && STAGE_TAGS.has(job.application_status)) {
    flags.push(<span key="stage" className={`flag stage ${job.application_status}`}>{statusLabel(job.application_status)}</span>)
  }
  if (job.has_note) flags.push(<span key="note" className="flag note" title="Has a note"><NoteIcon /></span>)
  return flags.length ? <span className="job-flags">{flags}</span> : null
}

// "+2 more · Pune, Hyderabad": opens the near-duplicate postings under the row (Enter or a click)
export function DupToggle({ job, group, actions, className = '' }) {
  const label = dupLabel(job)
  if (!label) return null
  const expanded = group === 'expanded'
  return (
    <button
      type="button"
      className={`dup-toggle ${expanded ? 'open' : ''} ${className}`}
      aria-expanded={expanded}
      title={expanded ? 'Hide the similar postings' : 'Show similar postings of this job'}
      onClick={(e) => {
        e.stopPropagation()
        actions.toggleGroup(job)
      }}
    >
      {group === 'loading' ? 'Loading…' : label}
    </button>
  )
}
