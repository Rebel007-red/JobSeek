import { useId, useRef } from 'react'
import { Link } from 'react-router-dom'
import { isApplied } from '../../utils/gold'
import { FitScore } from '../common/Fit'
import { BookmarkIcon, CheckCircleIcon, CloseIcon, EyeOffIcon } from '../common/icons'
import { PROFILE_ANCHORS } from './listState'

// What a row of the card shows once you acted on it (in place, so the five stay where they were)
function actedLabel(job, hidden) {
  if (hidden) return 'Hidden'
  if (isApplied(job)) return 'Applied ✓'
  if (job.application_status === 'saved') return 'Saved ✓'
  return null
}

// "Your first 5" at the top of the Inbox after the welcome save (viewPref readFirstFivePending, per device): the five
// best For-you fits (api.firstFive), each with Save / Mark applied / Hide (the page's handlers, so toasts, Undo and the
// counts are the same as anywhere). A row you acted on stays and says what happened ("Saved ✓", "Applied ✓", "Hidden");
// once all of them are (or none came), the done line and Close show. ✕ and Close end it for good on this device
// (onClose). noCities: the profile has no preferred cities, so a line offers to add them (the My cities chip).
// rows: null while loading; hidden: the keys hidden from the card. The page shows the card instead of the Expiring strip.
export function FirstFiveCard({ rows, hidden, noCities = false, busy = false, onOpen, onSave, onApplied, onHide, onClose }) {
  const titleId = useId()
  const closeRef = useRef(null)
  const loading = rows === null
  const list = rows || []
  const done = !loading && list.every(job => actedLabel(job, hidden.has(job.job_key)))

  // A row's action: keyboard focus goes on to the next row still waiting (or the close button), not to the page top
  const act = (handler, job) => (e) => {
    const item = e.currentTarget.closest('li')
    handler(job)
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return
      let next = item?.nextElementSibling
      while (next && !next.querySelector('.first-five-actions button')) next = next.nextElementSibling
      ;(next?.querySelector('.first-five-actions button') || closeRef.current)?.focus({ preventScroll: true })
    })
  }

  return (
    <section className="first-five" aria-labelledby={titleId}>
      <div className="first-five-head">
        <div className="first-five-heading">
          <h2 id={titleId}>Your first 5</h2>
          <p>The best fits for your profile right now. Save the ones you like and hide the rest.</p>
        </div>
        <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close Your first 5" title="Close">
          <CloseIcon />
        </button>
      </div>

      {loading && <p className="first-five-note" aria-busy="true"><span className="spinner" /></p>}
      {!loading && list.length === 0 && (
        <p className="first-five-note">No jobs for your roles yet. New jobs arrive with the next update (every ~6 hours).</p>
      )}
      {list.length > 0 && (
        <ol className="first-five-rows">
          {list.map(job => {
            const acted = actedLabel(job, hidden.has(job.job_key))
            return (
              <li key={job.job_key} className={`first-five-row ${acted ? 'is-done' : ''}`}>
                <FitScore score={job.fit_score} />
                <button type="button" className="first-five-open" onClick={() => onOpen(job)} title="Open the details">
                  <strong>{job.title}</strong>
                  <span>{job.company_name || 'Unknown company'}</span>
                </button>
                {acted ? (
                  <span className={`first-five-state ${hidden.has(job.job_key) ? '' : 'is-kept'}`}>{acted}</span>
                ) : (
                  <span className="first-five-actions">
                    <button type="button" className="icon-btn save-btn" onClick={act(onSave, job)} disabled={busy} title="Save (s)" aria-label={`Save: ${job.title}`}>
                      <BookmarkIcon />
                    </button>
                    <button type="button" className="icon-btn applied-btn" onClick={act(onApplied, job)} disabled={busy} title="Mark applied (a)" aria-label={`Mark applied: ${job.title}`}>
                      <CheckCircleIcon />
                    </button>
                    <button type="button" className="icon-btn danger" onClick={act(onHide, job)} disabled={busy} title="Hide (x)" aria-label={`Hide: ${job.title}`}>
                      <EyeOffIcon />
                    </button>
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}

      <div className="first-five-foot">
        {done && list.length > 0 ? (
          <p role="status">Done. Saved jobs wait in Saved, and new ones arrive every ~6 hours.</p>
        ) : (
          <p>Jobs disappear 7 days after posting. Save to keep them. New ones arrive every ~6 hours.</p>
        )}
        {noCities && (
          <p>
            Add up to 3 cities to use the My cities chip (jobs there or remote).{' '}
            <Link to={PROFILE_ANCHORS.cities}>Add cities</Link>
          </p>
        )}
        {done && <button type="button" className="btn sm primary" onClick={onClose}>Close</button>}
      </div>
    </section>
  )
}
