import { memo, useEffect, useRef } from 'react'
import { formatDate, formatRelativeAge, isNewJob } from '../../utils/job'
import { experienceLabel, jobDate, skillBuckets } from '../../utils/gold'
import { FitScore } from './Fit'
import { JobActions } from './JobActions'
import { Swipeable } from './Swipeable'

// One dense line per job for fast scanning; click or Enter opens the drawer. Swipe right = applied, left = hide.
export const JobRow = memo(function JobRow({ job, profileSkills = [], active = false, onOpen, onHide, onApplied }) {
  const ref = useRef(null)

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const applied = Boolean(job.is_applied)
  const date = jobDate(job)
  const isNew = isNewJob(job.first_seen_at)
  const { matchedLabels } = skillBuckets(job, profileSkills)
  const experience = experienceLabel(job)
  const meta = [job.company_name || 'Unknown company', job.location].filter(Boolean)

  return (
    <Swipeable onLeft={() => onHide(job)} onRight={applied ? undefined : () => onApplied(job, true)}>
      <article
        ref={ref}
        className={`job-row ${applied ? 'is-applied' : ''} ${active ? 'is-active' : ''}`}
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
        <FitScore score={job.fit_score} />

        <div className="job-row-main">
          <h3 className="job-row-title">
            {isNew && !applied && <i className="new-dot" title="Found in the last 48 hours" />}
            {job.title}
          </h3>
          <p className="job-row-meta">
            {meta.map((part, index) => <span key={`${index}-${part}`}>{part}</span>)}
          </p>
        </div>

        <div className="job-row-side">
          {job.role_title && <span className="tag role-tag" title={job.category || undefined}>{job.role_title}</span>}
          <span className={`exp-tag ${experience ? '' : 'unknown'}`} title="Experience required">{experience || 'Exp n/a'}</span>
          {profileSkills.length > 0 && (
            <span
              className={`skill-count ${matchedLabels.length ? 'has' : ''}`}
              title={matchedLabels.length ? `Your skills in this job: ${matchedLabels.join(', ')}` : 'None of your skills'}
            >
              {matchedLabels.length}/{profileSkills.length} skills
            </span>
          )}
          {applied ? (
            <span className="row-date applied">Applied {formatDate(job.applied_at) || ''}</span>
          ) : (
            <span className={`row-date ${isNew ? 'new' : ''}`} title={formatDate(date) || undefined}>{formatRelativeAge(date)}</span>
          )}
        </div>

        <JobActions job={job} onApplied={onApplied} onHide={onHide} />
      </article>
    </Swipeable>
  )
})
