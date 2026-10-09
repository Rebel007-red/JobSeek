import { memo, useId, useMemo } from 'react'
import { isOwnRole, skillsTag } from '../../utils/fit'
import { profileSkillList, skillBuckets } from '../../utils/gold'
import { StatusPicker } from '../job/StatusPicker'
import { FitBreakdown, FitRing } from './Fit'
import { JobActions } from './JobActions'
import { ExperienceTag, JobDateTag, JobFlags, JobItem, JobPlace, NewJobDot, SkillsTag } from './JobItem'

const MAX_TAGS = 5

// Memoized: only re-renders when this job (or the handlers) change, not on every page state update.
// Props as JobRow's; the skill tags compare against core and also-know skills.
export const JobCard = memo(function JobCard({
  job, profile = null, active = false, selected = false, selecting = false, selectMode = false, showStatus = false,
  group = 'collapsed', child = false, actions, since, tab, rightApplies = false, peek = false, leaving = false,
}) {
  const profileSkills = useMemo(() => profileSkillList(profile), [profile])
  const { have, missing } = skillBuckets(job, profileSkills)
  const tags = [...have.map(skill => ({ skill, have: true })), ...missing.map(skill => ({ skill, have: false }))]
  const hiddenTagCount = Math.max(tags.length - MAX_TAGS, 0)
  const skills = skillsTag(job, profile)
  const titleId = useId()
  const companyId = useId()
  const roleLine = job.role_title && !isOwnRole(job, profile) ? job.role_title : null

  return (
    <JobItem
      job={job} className="job-card" active={active} selected={selected} selectMode={selectMode} child={child}
      labelledBy={`${titleId} ${companyId}`} actions={actions} since={since} tab={tab} rightApplies={rightApplies}
      peek={peek} leaving={leaving}
    >
      <div className="job-card-header">
        <div className="job-card-heading">
          <p className="job-company" id={companyId} title={job.company_name || undefined}>{job.company_name || 'Unknown company'}</p>
          <h3 id={titleId}>
            <NewJobDot job={job} since={since} />
            {job.title}
          </h3>
          {roleLine && <p className="job-role-line">{roleLine}{job.category ? ` · ${job.category}` : ''}</p>}
        </div>
        <FitRing score={job.fit_score} />
      </div>

      <p className="job-card-meta">
        <JobPlace job={job} fallback="India" group={group} actions={child ? null : actions} />
        {job.source && <span>{job.source}</span>}
      </p>

      <JobFlags job={job} showStage={!showStatus} />

      {tags.length > 0 && (
        <div className="skill-tags">
          {tags.slice(0, MAX_TAGS).map(({ skill, have: hasSkill }) => (
            <span key={skill} className={hasSkill ? 'skill-tag active' : 'skill-tag'}>{skill}</span>
          ))}
          {hiddenTagCount > 0 && <span className="skill-tag more">+{hiddenTagCount}</span>}
        </div>
      )}
      <SkillsTag tag={skills} />

      <FitBreakdown job={job} compact />

      <div className="job-card-footer">
        {showStatus && (
          <StatusPicker status={job.application_status || (job.is_applied ? 'applied' : 'not_applied')} onChange={status => actions.status(job, status)} size="sm" />
        )}
        <ExperienceTag job={job} />
        <JobDateTag job={job} since={since} />
        <JobActions job={job} actions={actions} selected={selected} selecting={selecting} />
      </div>
    </JobItem>
  )
})
