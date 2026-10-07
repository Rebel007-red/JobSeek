import { isApplied, jobUrl } from '../../utils/gold'
import { BookmarkIcon, CheckIcon, CheckSquareIcon, CircleIcon, CloseIcon, ExternalLinkIcon, MuteIcon, SquareIcon } from './icons'

// Select / save / applied / open posting / hide, shared by list rows and cards. In the muted view (muted_by set) an
// Unmute button replaces save. actions: the page's stable handlers (see JobItem).
export function JobActions({ job, actions, selected = false, selecting = false }) {
  const applied = isApplied(job)
  const saved = job.application_status === 'saved'
  const url = jobUrl(job)
  const stop = (handler) => (e) => {
    e.stopPropagation()
    handler(e)
  }

  return (
    <div className="job-actions">
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
      {job.muted_by ? (
        <button
          type="button"
          onClick={stop(() => actions.unmute(job))}
          className="icon-btn"
          title={`Unmute: stop hiding jobs by "${job.muted_value}"`}
          aria-label={`Unmute ${job.muted_value}`}
        >
          <MuteIcon />
        </button>
      ) : (
        <button
          type="button"
          onClick={stop(() => actions.save(job))}
          className={`icon-btn save-btn ${saved ? 'is-saved' : ''} ${applied ? 'is-dim' : ''}`}
          title={applied ? 'Already applied' : saved ? 'Saved. Click to remove (s)' : 'Save for later (s)'}
          aria-label="Save for later"
          aria-pressed={saved}
        >
          <BookmarkIcon filled={saved} />
        </button>
      )}
      <button
        type="button"
        onClick={stop(() => actions.applied(job, !applied))}
        className={`icon-btn ${applied ? 'is-on' : ''}`}
        title={applied ? 'Applied. Click to undo (a)' : 'Mark as applied (a)'}
        aria-label="Applied"
        aria-pressed={applied}
      >
        {applied ? <CheckIcon /> : <CircleIcon />}
      </button>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="icon-btn"
          title="Open posting (o)"
          aria-label="Open job posting"
          onClick={(e) => {
            e.stopPropagation()
            actions.opened(job)
          }}
        >
          <ExternalLinkIcon />
        </a>
      ) : (
        <button type="button" className="icon-btn" disabled title="No link for this job" aria-label="No link for this job">
          <ExternalLinkIcon />
        </button>
      )}
      <button
        type="button"
        onClick={stop(() => actions.hide(job))}
        className="icon-btn danger"
        title={Number(job.dup_count) > 0 ? `Hide this job and its ${job.dup_count} similar postings (x)` : 'Hide (x)'}
        aria-label="Hide this job"
      >
        <CloseIcon />
      </button>
    </div>
  )
}
