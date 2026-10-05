import { memo } from 'react'
import { skillBuckets } from '../../utils/gold'
import { FitBreakdown, FitRing } from './Fit'
import { JobActions } from './JobActions'
import { ExperienceTag, JobDateTag, JobItem, NewJobDot } from './JobItem'

const MAX_TAGS = 5

// Memoized: only re-renders when this job (or the handlers) change, not on every page state update.
export const JobCard = memo(function JobCard({ job, profileSkills = [], active = false, onOpen, onHide, onApplied }) {
  const { have, missing } = skillBuckets(job, profileSkills)
  const tags = [...have.map(skill => ({ skill, have: true })), ...missing.map(skill => ({ skill, have: false }))]
  const hiddenTagCount = Math.max(tags.length - MAX_TAGS, 0)
  const meta = [job.location || 'India', job.source].filter(Boolean)

  return (
    <JobItem job={job} className="job-card" active={active} onOpen={onOpen} onHide={onHide} onApplied={onApplied}>
      <div className="job-card-header">
        <div className="job-card-heading">
          <p className="job-company">{job.company_name || 'Unknown company'}</p>
          <h3>
            <NewJobDot job={job} />
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
        <ExperienceTag job={job} />
        <JobDateTag job={job} />
        <JobActions job={job} onApplied={onApplied} onHide={onHide} />
      </div>
    </JobItem>
  )
})
