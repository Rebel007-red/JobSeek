import { formatDate, formatRelativeAge, isNewJob } from '../../utils/job'
import { experienceLabel, jobDate } from '../../utils/gold'
import { Swipeable } from './Swipeable'

// Shared shell of a list row / card: click or Enter opens the drawer, swipe right = applied, left = hide.
// className is the base class ('job-row' | 'job-card'); data-job-key lets the page scroll the selection into view.
export function JobItem({ job, className, active, onOpen, onHide, onApplied, children }) {
  const applied = Boolean(job.is_applied)

  return (
    <Swipeable onLeft={() => onHide(job)} onRight={applied ? undefined : () => onApplied(job, true)}>
      <article
        data-job-key={job.job_key}
        className={`${className} ${applied ? 'is-applied' : ''} ${active ? 'is-active' : ''}`}
        onClick={() => onOpen(job)}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && e.key === 'Enter') {
            e.preventDefault()
            onOpen(job)
          }
        }}
        tabIndex={0}
        aria-label={`${job.title} at ${job.company_name}. Open details`}
      >
        {children}
      </article>
    </Swipeable>
  )
}

export function NewJobDot({ job }) {
  if (job.is_applied || !isNewJob(job.first_seen_at)) return null
  return <i className="new-dot" title="Found in the last 48 hours" />
}

export function ExperienceTag({ job }) {
  const experience = experienceLabel(job)
  return <span className={`exp-tag ${experience ? '' : 'unknown'}`} title="Experience required">{experience || 'Exp n/a'}</span>
}

// When you applied, otherwise how long ago the job was posted (or first found)
export function JobDateTag({ job }) {
  if (job.is_applied) return <span className="row-date applied">Applied {formatDate(job.applied_at) || ''}</span>
  const date = jobDate(job)
  return (
    <span className={`row-date ${isNewJob(job.first_seen_at) ? 'new' : ''}`} title={formatDate(date) || undefined}>
      {formatRelativeAge(date)}
    </span>
  )
}
