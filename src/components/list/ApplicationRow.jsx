import { memo, useId } from 'react'
import { formatDate } from '../../utils/job'
import { jobUrl, statusLabel } from '../../utils/gold'
import { actionFlag, appliedAgo, nextLabel } from '../../utils/tracker'
import { StagePill } from '../job/StageMenu'
import { CheckSquareIcon, ExternalLinkIcon, NoteIcon, SquareIcon } from '../common/icons'
import { JobItem } from '../common/JobItem'

// What a screen reader hears after the row's name: "Interviewing. Applied Oct 4. Interviewing with no update for 9 days.
// Has a note."
function applicationSummary(job, flag, next) {
  const parts = [statusLabel(job.application_status || 'applied')]
  const applied = formatDate(job.applied_at)
  if (applied) parts.push(`Applied ${applied}`)
  if (flag) parts.push(flag.title)
  else if (next) parts.push(`Your follow-up date: ${next.replace(/^Next /, '')}`)
  if (job.has_note) parts.push('Has a note')
  return `${parts.join('. ')}.`
}

// One application on the Applied tab (list and cards view alike): Company · Title | stage pill | "Applied 8d ago" | the
// follow-up date ("Next Oct 12") or what needs doing ("No update 15d") | note | open the posting. No fit, skills or
// hide: this tab is a tracker. MOBILE: two lines (company · title, then pill · date · flag · icons), at most 76 px.
// The JobItem shell gives it what every row has: tap / Enter opens the drawer, a right swipe moves it to the next stage,
// keyboard focus and data-job-key. The pill's menu changes the stage (actions.status: optimistic, toast with Undo).
// selecting: show the checkbox (select mode or a selection); actions: the page's stable row handlers (see JobItem).
export const ApplicationRow = memo(function ApplicationRow({
  job, active = false, selected = false, selecting = false, selectMode = false, actions, since, tab = 'applied',
  rightApplies = false, peek = false, leaving = false,
}) {
  const titleId = useId()
  const companyId = useId()
  const ago = appliedAgo(job)
  const flag = actionFlag(job)
  const next = flag ? null : nextLabel(job)
  const url = jobUrl(job)
  const stop = (handler) => (e) => {
    e.stopPropagation()
    handler(e)
  }

  return (
    <JobItem
      job={job} className="app-row" active={active} selected={selected} selectMode={selectMode}
      labelledBy={`${companyId} ${titleId}`} actions={actions} since={since} tab={tab} rightApplies={rightApplies}
      peek={peek} leaving={leaving} summary={applicationSummary(job, flag, next)}
    >
      <div className="app-row-main">
        <span className="app-row-company" id={companyId}>{job.company_name || 'Unknown company'}</span>
        <h3 className="app-row-title" id={titleId}>{job.title}</h3>
      </div>

      <div className="app-row-side">
        {/* Fixed slots, so the pills, dates and flags line up in columns on desktop (empty ones collapse on phones) */}
        <span className="app-row-stage"><StagePill job={job} onChange={status => actions.status(job, status)} onSnooze={date => actions.snooze?.(job, date)} size="sm" /></span>
        <span className="app-row-date" title={formatDate(job.applied_at) || undefined}>{ago}</span>
        <span className="app-row-flag">
          {flag
            ? <span className={`flag ${flag.tone || 'warning'}`} title={flag.title}>{flag.label}</span>
            : next && <span className="flag" title="Your follow-up date">{next}</span>}
        </span>
        <span className="app-row-note">{job.has_note && <span className="flag note" title="Has a note"><NoteIcon /></span>}</span>
      </div>

      <div className="job-actions app-row-actions">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          onClick={stop(e => actions.select(job, { range: e.shiftKey }))}
          className={`icon-btn select-box ${selected ? 'is-on' : ''} ${selecting ? 'is-visible' : ''}`}
          title={selected ? 'Unselect (Space)' : 'Select (Space, Shift+click for a range)'}
          aria-label={`Select ${job.title}`}
        >
          {selected ? <CheckSquareIcon /> : <SquareIcon />}
        </button>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="icon-btn open-btn"
            title="Open the posting (o)"
            aria-label="Open the posting (o)"
            onClick={(e) => {
              e.stopPropagation()
              actions.opened(job)
            }}
          >
            <ExternalLinkIcon />
          </a>
        ) : (
          <button type="button" className="icon-btn open-btn" disabled title="No link for this job" aria-label="No link for this job">
            <ExternalLinkIcon />
          </button>
        )}
      </div>
    </JobItem>
  )
})
