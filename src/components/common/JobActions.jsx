import { isApplied, jobUrl } from '../../utils/gold'
import { BookmarkIcon, CheckCircleIcon, CheckSquareIcon, ExternalLinkIcon, EyeOffIcon, MuteIcon, SquareIcon } from './icons'

// [select] · save · applied · open the posting · (gap) · hide, shared by list rows and cards. Applied jobs have no
// bookmark (they are kept anyway); a saved one keeps the filled bookmark, which unsaves it. In the muted view (muted_by
// set) an Unmute button takes the bookmark's place. A toggle's aria-label names the action it will take.
// actions: the page's stable handlers (see JobItem).
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
          title={`Unmute ${job.muted_value}: show its jobs again`}
          aria-label={`Unmute ${job.muted_value}`}
        >
          <MuteIcon />
        </button>
      ) : !applied && (
        <button
          type="button"
          onClick={stop(() => actions.save(job))}
          className={`icon-btn save-btn ${saved ? 'is-saved' : ''}`}
          title={saved ? 'Unsave (s)' : 'Save (s)'}
          aria-label={saved ? 'Unsave' : 'Save'}
        >
          <BookmarkIcon filled={saved} />
        </button>
      )}
      <button
        type="button"
        onClick={stop(() => actions.applied(job, !applied))}
        className={`icon-btn applied-btn ${applied ? 'is-on' : ''}`}
        title={applied ? 'Undo applied (a)' : 'Mark applied (a)'}
        aria-label={applied ? 'Undo applied' : 'Mark applied'}
      >
        <CheckCircleIcon filled={applied} />
      </button>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="icon-btn open-btn"
          title="Open the posting (o)"
          aria-label="Open the posting"
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
      <button
        type="button"
        onClick={stop(() => actions.hide(job))}
        className="icon-btn danger hide-btn"
        title={Number(job.dup_count) > 0 ? `Hide this job and its ${job.dup_count} similar ${Number(job.dup_count) === 1 ? 'posting' : 'postings'} (x)` : 'Hide (x)'}
        aria-label="Hide"
      >
        <EyeOffIcon />
      </button>
    </div>
  )
}
