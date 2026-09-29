import { memo, useEffect, useRef } from 'react'
import { formatDate, formatRelativeAge, isNewJob } from '../../utils/job'
import { experienceLabel, jobDate, skillBuckets } from '../../utils/gold'
import { FitBreakdown, FitRing } from './Fit'
import { JobActions } from './JobActions'
import { Swipeable } from './Swipeable'

const MAX_TAGS = 5

// Memoized: only re-renders when this job (or the handlers) change, not on every page state update.
export const JobCard = memo(function JobCard({ job, profileSkills = [], active = false, onOpen, onHide, onApplied }) {
  const ref = useRef(null)

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const applied = Boolean(job.is_applied)
  const date = jobDate(job)
  const isNew = isNewJob(job.first_seen_at)
  const experience = experienceLabel(job)
  const { have, missing } = skillBuckets(job, profileSkills)
  const tags = [...have.map(skill => ({ skill, have: true })), ...missing.map(skill => ({ skill, have: false }))]
  const hiddenTagCount = Math.max(tags.length - MAX_TAGS, 0)
  const meta = [job.location || 'India', job.source].filter(Boolean)

  return (
    <Swipeable onLeft={() => onHide(job)} onRight={applied ? undefined : () => onApplied(job, true)}>
      <article
        ref={ref}
        className={`job-card ${applied ? 'is-applied' : ''} ${active ? 'is-active' : ''}`}
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
        <div className="job-card-header">
          <div className="job-card-heading">
            <p className="job-company">{job.company_name || 'Unknown company'}</p>
            <h3>
              {isNew && !applied && <i className="new-dot" title="Found in the last 48 hours" />}
              {job.title}
            </h3>
            {job.role_title && <p className="job-role-line">{job.role_title}{job.category ? ` · ${job.category}` : ''}</p>}
          </div>
          <FitRing score={job.fit_score} />
        </div>

        <p className="job-card-meta">
          {meta.map((part, index) => <span key={`${index}-${part}`}>{part}</span>)}
        </p>

        {tags.length > 0 && (
          <div className="skill-tags">
            {tags.slice(0, MAX_TAGS).map(({ skill, have: hasSkill }) => (
              <span key={skill} className={hasSkill ? 'skill-tag active' : 'skill-tag'}>{skill}</span>
            ))}
            {hiddenTagCount > 0 && <span className="skill-tag more">+{hiddenTagCount}</span>}
          </div>
        )}

        <FitBreakdown job={job} compact />

        <div className="job-card-footer">
          <span className={`exp-tag ${experience ? '' : 'unknown'}`} title="Experience required">{experience || 'Exp n/a'}</span>
          {applied ? (
            <span className="row-date applied">Applied {formatDate(job.applied_at) || ''}</span>
          ) : (
            <span className={`row-date ${isNew ? 'new' : ''}`} title={formatDate(date) || undefined}>{formatRelativeAge(date)}</span>
          )}
          <JobActions job={job} onApplied={onApplied} onHide={onHide} />
        </div>
      </article>
    </Swipeable>
  )
})
