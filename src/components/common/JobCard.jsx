import { memo, useId, useMemo } from 'react'
import { profileSkillList, skillBuckets } from '../../utils/gold'
import { StatusPicker } from '../job/StatusPicker'
import { FitBreakdown, FitRing } from './Fit'
import { JobActions } from './JobActions'
import { DupToggle, ExperienceTag, JobDateTag, JobFlags, JobItem, JobPlace, NewJobDot } from './JobItem'

const MAX_TAGS = 5

// Memoized: only re-renders when this job (or the handlers) change, not on every page state update.
// Props as JobRow's; the skill tags compare against core and also-know skills.
export const JobCard = memo(function JobCard({
  job, profile = null, active = false, selected = false, selecting = false, selectMode = false, showStatus = false,
  group = 'collapsed', child = false, actions,
}) {
  const profileSkills = useMemo(() => profileSkillList(profile), [profile])
  const { have, missing } = skillBuckets(job, profileSkills)
  const tags = [...have.map(skill => ({ skill, have: true })), ...missing.map(skill => ({ skill, have: false }))]
  const hiddenTagCount = Math.max(tags.length - MAX_TAGS, 0)
  const titleId = useId()
  const companyId = useId()

  return (
    <JobItem
      job={job} className="job-card" active={active} selected={selected} selectMode={selectMode} child={child}
      labelledBy={`${titleId} ${companyId}`} actions={actions}
    >
      <div className="job-card-header">
        <div className="job-card-heading">
          <p className="job-company" id={companyId} title={job.company_name || undefined}>{job.company_name || 'Unknown company'}</p>
          <h3 id={titleId}>
            <NewJobDot job={job} />
            {job.title}
          </h3>
          {job.role_title && <p className="job-role-line">{job.role_title}{job.category ? ` · ${job.category}` : ''}</p>}
        </div>
        <FitRing score={job.fit_score} />
      </div>

      <p className="job-card-meta">
        <JobPlace job={job} fallback="India" />
        {job.source && <span>{job.source}</span>}
      </p>

      <JobFlags job={job} showStage={!showStatus} />
      {!child && <DupToggle job={job} group={group} actions={actions} />}

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
        {showStatus && (
          <StatusPicker status={job.application_status || (job.is_applied ? 'applied' : 'not_applied')} onChange={status => actions.status(job, status)} size="sm" />
        )}
        <ExperienceTag job={job} />
        <JobDateTag job={job} />
        <JobActions job={job} actions={actions} selected={selected} selecting={selecting} />
      </div>
    </JobItem>
  )
})
