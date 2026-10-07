import { memo, useId } from 'react'
import { skillsTag } from '../../utils/fit'
import { StatusPicker } from '../job/StatusPicker'
import { FitScore } from './Fit'
import { JobActions } from './JobActions'
import { DupToggle, ExperienceTag, JobDateTag, JobFlags, JobItem, JobPlace, NewJobDot } from './JobItem'

// One dense line per job for fast scanning; click or Enter opens the drawer. Swipe right = applied, left = hide.
// showStatus: the Applied tab's status picker. group: 'collapsed' | 'loading' | 'expanded' for a row standing for
// near-duplicate postings; child: one of those postings, shown indented under it.
export const JobRow = memo(function JobRow({
  job, profile = null, active = false, selected = false, selecting = false, selectMode = false, showStatus = false,
  group = 'collapsed', child = false, actions,
}) {
  const skills = skillsTag(job, profile)
  const titleId = useId()
  const companyId = useId()

  return (
    <JobItem
      job={job} className="job-row" active={active} selected={selected} selectMode={selectMode} child={child}
      labelledBy={`${titleId} ${companyId}`} actions={actions}
    >
      <FitScore score={job.fit_score} />

      <div className="job-row-main">
        <h3 className="job-row-title" id={titleId}>
          <NewJobDot job={job} />
          {job.title}
        </h3>
        <p className="job-row-meta">
          <span id={companyId}>{job.company_name || 'Unknown company'}</span>
          <JobPlace job={job} />
          {!child && <DupToggle job={job} group={group} actions={actions} className="hide-mobile" />}
        </p>
      </div>

      <div className="job-row-side">
        <JobFlags job={job} showStage={!showStatus} />
        {/* On phones the meta line is cut short, so the duplicates toggle moves to the tag line */}
        {!child && <DupToggle job={job} group={group} actions={actions} className="hide-desktop" />}
        {showStatus && (
          <StatusPicker status={job.application_status || (job.is_applied ? 'applied' : 'not_applied')} onChange={status => actions.status(job, status)} size="sm" />
        )}
        {job.role_title && <span className="tag role-tag" title={job.category || undefined}>{job.role_title}</span>}
        <ExperienceTag job={job} />
        {skills && (
          <span className={`skill-count ${job.job_skills_known !== false && job.fit_matched_skills?.length ? 'has' : ''}`} title={skills.title}>
            {skills.label}
          </span>
        )}
        <JobDateTag job={job} />
      </div>

      <JobActions job={job} actions={actions} selected={selected} selecting={selecting} />
    </JobItem>
  )
})
