import { memo } from 'react'
import { skillBuckets } from '../../utils/gold'
import { FitScore } from './Fit'
import { JobActions } from './JobActions'
import { ExperienceTag, JobDateTag, JobItem, NewJobDot } from './JobItem'

// One dense line per job for fast scanning; click or Enter opens the drawer. Swipe right = applied, left = hide.
export const JobRow = memo(function JobRow({ job, profileSkills = [], active = false, onOpen, onHide, onApplied }) {
  const { matchedLabels } = skillBuckets(job, profileSkills)
  const meta = [job.company_name || 'Unknown company', job.location].filter(Boolean)

  return (
    <JobItem job={job} className="job-row" active={active} onOpen={onOpen} onHide={onHide} onApplied={onApplied}>
      <FitScore score={job.fit_score} />

      <div className="job-row-main">
        <h3 className="job-row-title">
          <NewJobDot job={job} />
          {job.title}
        </h3>
        <p className="job-row-meta">
          {meta.map((part, index) => <span key={`${index}-${part}`}>{part}</span>)}
        </p>
      </div>

      <div className="job-row-side">
        {job.role_title && <span className="tag role-tag" title={job.category || undefined}>{job.role_title}</span>}
        <ExperienceTag job={job} />
        {profileSkills.length > 0 && (
          <span
            className={`skill-count ${matchedLabels.length ? 'has' : ''}`}
            title={matchedLabels.length ? `Your skills in this job: ${matchedLabels.join(', ')}` : 'None of your skills'}
          >
            {matchedLabels.length}/{profileSkills.length} skills
          </span>
        )}
        <JobDateTag job={job} />
      </div>

      <JobActions job={job} onApplied={onApplied} onHide={onHide} />
    </JobItem>
  )
})
