import { jobUrl } from '../../utils/gold'
import { CheckIcon, CircleIcon, CloseIcon, ExternalLinkIcon } from './icons'

// Applied / open posting / hide, shared by list rows and cards.
export function JobActions({ job, onApplied, onHide }) {
  const applied = Boolean(job.is_applied)
  const url = jobUrl(job)
  const stop = (handler) => (e) => {
    e.stopPropagation()
    handler()
  }

  return (
    <div className="job-actions">
      <button
        type="button"
        onClick={stop(() => onApplied(job, !applied))}
        className={`icon-btn ${applied ? 'is-on' : ''}`}
        title={applied ? 'Applied. Click to undo (a)' : 'Mark as applied (a)'}
        aria-label={applied ? 'Mark as not applied' : 'Mark as applied'}
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
          onClick={e => e.stopPropagation()}
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
        onClick={stop(() => onHide(job))}
        className="icon-btn danger"
        title="Hide (x)"
        aria-label="Hide this job"
      >
        <CloseIcon />
      </button>
    </div>
  )
}
