import { memo, useId } from 'react'
import { isOwnRole, skillsTag } from '../../utils/fit'
import { StatusPicker } from '../job/StatusPicker'
import { FitScore } from './Fit'
import { JobActions } from './JobActions'
import { ExperienceTag, JobDateTag, JobFlags, JobItem, JobPlace, NewJobDot, SkillsTag } from './JobItem'

// One dense line per job for fast scanning; click or Enter opens the drawer. Swipes follow the tab (see JobItem).
// showStatus: the Applied tab's status picker. group: 'collapsed' | 'loading' | 'expanded' for a row standing for
// near-duplicate postings (the "+6" pill after the place); child: one of those postings, shown indented under it.
// The role tag shows only when it is not one of your roles; the skills text names what the job asks that you lack.
export const JobRow = memo(function JobRow({
  job, profile = null, active = false, selected = false, selecting = false, selectMode = false, showStatus = false,
  group = 'collapsed', child = false, actions, since, tab, rightApplies = false, peek = false, leaving = false,
}) {
  const skills = skillsTag(job, profile)
  const titleId = useId()
  const companyId = useId()

  return (
    <JobItem
      job={job} className="job-row" active={active} selected={selected} selectMode={selectMode} child={child}
      labelledBy={`${titleId} ${companyId}`} actions={actions} since={since} tab={tab} rightApplies={rightApplies}
      peek={peek} leaving={leaving}
    >
      <FitScore score={job.fit_score} />

      <div className="job-row-main">
        <h3 className="job-row-title" id={titleId}>
          <NewJobDot job={job} since={since} />
          {job.title}
        </h3>
        <p className="job-row-meta">
          <span id={companyId}>{job.company_name || 'Unknown company'}</span>
          <JobPlace job={job} group={group} actions={child ? null : actions} />
        </p>
      </div>

      <div className="job-row-side">
        <JobFlags job={job} showStage={!showStatus} />
        {showStatus && (
          <StatusPicker status={job.application_status || (job.is_applied ? 'applied' : 'not_applied')} onChange={status => actions.status(job, status)} size="sm" />
        )}
        {job.role_title && !isOwnRole(job, profile) && <span className="tag role-tag" title={job.category || undefined}>{job.role_title}</span>}
        <ExperienceTag job={job} />
        <SkillsTag tag={skills} />
        <JobDateTag job={job} since={since} />
      </div>

      <JobActions job={job} actions={actions} selected={selected} selecting={selecting} />
    </JobItem>
  )
})
