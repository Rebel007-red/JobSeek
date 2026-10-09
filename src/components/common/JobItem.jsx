import { useId } from 'react'
import { dupPill, expiryHint, followUpDateLabel, followUpTitle, formatDate, formatRelativeAge, isNewJob, placeLabel } from '../../utils/job'
import { WORK_MODE_LABELS, experienceLabel, fitLabel, fitTone, isApplied, jobDate, statusLabel } from '../../utils/gold'
import { swipeActions } from '../list/listState'
import { CheckIcon, NoteIcon } from './icons'
import { Swipeable } from './Swipeable'

// Statuses shown as a tag outside the Applied tab (plain "Applied" already shows as the date)
const STAGE_TAGS = new Set(['interviewing', 'offer', 'rejected', 'withdrawn'])
const MUTED_BY = { company: 'Company', title: 'Title word', level: 'Level' }
const EXPIRY_TITLE = "Jobs you haven't saved or applied to disappear 2 days after posting. Save it to keep it."

// What a screen reader hears after the row's name (its title and company): "New. Fit 82, strong fit. Applied Oct 4.
// Disappears in ~9h."
function rowSummary(job, since) {
  const parts = []
  if (isNewJob(job, since)) parts.push('New since your last visit')
  const score = Number(job.fit_score)
  parts.push(fitTone(job.fit_score) === 'none' ? 'Fit not scored' : `Fit ${Math.round(score)}, ${fitLabel(job.fit_score).toLowerCase()}`)
  if (isApplied(job)) {
    const status = job.application_status && job.application_status !== 'applied' ? ` (${statusLabel(job.application_status).toLowerCase()})` : ''
    parts.push(`Applied ${formatDate(job.applied_at) || ''}${status}`.trim())
  } else if (job.application_status === 'saved') {
    parts.push('Saved')
  }
  const expiry = expiryHint(job)
  if (expiry) parts.push(expiry.label)
  if (job.follow_up) parts.push(followUpTitle(job))
  if (job.dup_applied_at) parts.push('You applied to a near-identical posting')
  if (Number(job.dup_count) > 0) parts.push(`${job.dup_count} similar ${Number(job.dup_count) === 1 ? 'posting' : 'postings'}`)
  if (job.muted_by) parts.push(`Muted by your rule: ${job.muted_value}`)
  if (job.has_note) parts.push('Has a note')
  return `${parts.join('. ')}.`
}

// Shared shell of a list row / card: click or Enter opens the drawer; swipes follow the tab (listState swipeActions:
// Inbox right = Save, or Mark applied with rightApplies, left = Hide; Saved right = Mark applied, left = Unsave; Applied
// right = the next stage). className is the base class ('job-row' | 'job-card'); data-job-key lets the page scroll the
// selection into view.
// actions: the page's stable handlers ({ open, applied, save, hide, swipe, status, select, toggleGroup, unmute, opened,
// focus, peekDone }); focus makes a row the keyboard shortcuts' current job when it (or one of its buttons) takes focus.
// selectMode: taps select instead of opening (phones); Shift+click always extends the selection.
// labelledBy: the ids of the title and company elements, which name the row for screen readers.
// since: your last visit (new dot); peek: the one-time swipe demo on this row; leaving: the exit animation.
export function JobItem({
  job, className, active, selected = false, selectMode = false, child = false, labelledBy, actions, since, tab = 'inbox',
  rightApplies = false, peek = false, leaving = false, children,
}) {
  const applied = isApplied(job)
  const summaryId = useId()
  const swipe = swipeActions(job, tab, rightApplies)

  return (
    <Swipeable
      right={swipe.right}
      left={swipe.left}
      onRight={() => actions.swipe(job, 'right')}
      onLeft={() => actions.swipe(job, 'left')}
      peek={peek}
      onPeekEnd={() => actions.peekDone?.()}
      leaving={leaving}
    >
      <article
        data-job-key={job.job_key}
        className={[
          className,
          applied ? 'is-applied' : '',
          active ? 'is-active' : '',
          selected ? 'is-selected' : '',
          child ? 'is-group-child' : '',
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
        <span id={summaryId} className="sr-only">{rowSummary(job, since)}</span>
      </article>
    </Swipeable>
  )
}

// Found since your last visit (an untracked job only)
export function NewJobDot({ job, since }) {
  if (!isNewJob(job, since)) return null
  return <i className="new-dot" title="Found since your last visit" aria-hidden="true" />
}

export function ExperienceTag({ job }) {
  const experience = experienceLabel(job)
  return <span className={`exp-tag ${experience ? '' : 'unknown'}`} title="Experience required">{experience || 'Exp not stated'}</span>
}

// The skill gap (fit.js skillsTag): "lacks Snowflake, Airflow +2", a check before "All skills", "No skills listed" in
// the muted italic of an unknown value
export function SkillsTag({ tag }) {
  if (!tag) return null
  return (
    <span className={`skill-count tone-${tag.tone}`} title={tag.title}>
      {tag.tone === 'complete' && <CheckIcon />}
      {tag.label}
    </span>
  )
}

// When you applied, otherwise how long ago the job was posted (or first found)
export function JobDateTag({ job, since }) {
  if (isApplied(job)) return <span className="row-date applied">Applied {formatDate(job.applied_at) || ''}</span>
  const date = jobDate(job)
  return (
    <span className={`row-date ${isNewJob(job, since) ? 'new' : ''}`} title={formatDate(date) || undefined}>
      {formatRelativeAge(date)}
    </span>
  )
}

// City (+N more cities, titled with the raw location), the near-duplicates pill and a Remote / Hybrid tag, for the meta
// line. With group + actions the pill expands the group (DupPill).
export function JobPlace({ job, fallback = null, group, actions }) {
  const place = placeLabel(job)
  const mode = job.work_mode === 'remote' || job.work_mode === 'hybrid' ? WORK_MODE_LABELS[job.work_mode] : null
  return (
    <>
      {place ? <span title={place.title}>{place.label}</span> : fallback && <span>{fallback}</span>}
      {actions && <DupPill job={job} group={group} actions={actions} />}
      {mode && <span className={`mode-tag ${job.work_mode}`}>{mode}</span>}
    </>
  )
}

// State badges: expiry, follow-up, applied to a duplicate, muted, a stage, a note
export function JobFlags({ job, showStage = true }) {
  const expiry = expiryHint(job)
  const followUpDate = !job.follow_up && job.next_action_at ? followUpDateLabel(job.next_action_at) : null
  const flags = []
  if (job.muted_by) {
    flags.push(<span key="muted" className="flag muted" title={`${MUTED_BY[job.muted_by] || 'Rule'}: ${job.muted_value}`}>Muted: {job.muted_value}</span>)
  }
  if (expiry) flags.push(<span key="expiry" className="flag warning" title={EXPIRY_TITLE}>{expiry.label}</span>)
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

// "+6" right after the place (titled with the other cities): opens the near-duplicate postings under the row
export function DupPill({ job, group, actions }) {
  const pill = dupPill(job)
  if (!pill) return null
  const expanded = group === 'expanded'
  return (
    <button
      type="button"
      className={`dup-pill ${expanded ? 'open' : ''}`}
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Hide' : 'Show'} ${job.dup_count} similar ${Number(job.dup_count) === 1 ? 'posting' : 'postings'}`}
      title={expanded ? `Hide the similar postings. ${pill.title}` : pill.title}
      onClick={(e) => {
        e.stopPropagation()
        actions.toggleGroup(job)
      }}
    >
      {group === 'loading' ? '…' : pill.label}
    </button>
  )
}
