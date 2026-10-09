import { forwardRef, useId, useRef, useState } from 'react'
import { expiringStripCopy, expiryHint } from '../../utils/job'
import { FitScore } from '../common/Fit'
import { BookmarkIcon, CheckCircleIcon, ChevronDownIcon, ChevronUpIcon, EyeOffIcon } from '../common/icons'

// "Expiring tonight · 4 jobs": untouched For-you jobs on their last day, pinned above the Inbox whatever the time
// window (api.expiringJobs, at most 10, soonest gone first). count / strong: summary.expiring / expiring_strong; rows:
// the strip's jobs (the page drops the ones you saved, applied to or hid). Each row opens the drawer and has Save /
// Mark applied / Hide (the page's row handlers, so undo, counts and toasts are the same); Save all saves the rows shown.
// Only the first 3 rows (1 on a screen under 500px high, e.g. a phone in landscape) show until "Show N more", so the
// strip never fills the first screen; collapsed: only the header shows (remembered per user for the UTC day, see
// viewPref).
const firstRows = () => (typeof window !== 'undefined' && window.matchMedia?.('(max-height: 500px)').matches ? 1 : 3)
export const ExpiringStrip = forwardRef(function ExpiringStrip({
  count, strong, rows, collapsed = false, busy = false, onToggle, onOpen, onSave, onApplied, onHide, onSaveAll,
}, ref) {
  const bodyId = useId()
  const titleId = useId()
  const toggleRef = useRef(null)
  const [expanded, setExpanded] = useState(false)
  const first = firstRows()
  const visible = expanded ? rows : rows.slice(0, first)
  const more = rows.length - visible.length
  const copy = expiringStripCopy({ count, strong, shown: visible.length })
  const [before, after] = copy.subtitle.split(copy.time)

  // A row's action takes it off the strip: keyboard focus goes on to the next row (or the fold button), not the page top
  const act = (handler, job) => (e) => {
    const item = e.currentTarget.closest('li')
    const next = item?.nextElementSibling || item?.previousElementSibling
    handler(job)
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      ;((next?.isConnected && next.querySelector('.expiring-open, .expiring-more button')) || toggleRef.current)?.focus({ preventScroll: true })
    })
  }

  return (
    <section ref={ref} className={`expiring-strip ${collapsed ? 'is-collapsed' : ''}`} aria-labelledby={titleId}>
      <div className="expiring-head">
        <div className="expiring-heading">
          <h2 id={titleId}>{copy.title}</h2>
          <p>
            {before}
            <time title={copy.timeTitle}>{copy.time}</time>
            {after}
          </p>
        </div>
        {!collapsed && visible.length > 0 && (
          <button type="button" className="btn sm" onClick={() => onSaveAll(visible)} disabled={busy}>{copy.saveAll}</button>
        )}
        <button
          ref={toggleRef}
          type="button"
          className="icon-btn"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          aria-label={collapsed ? 'Show expiring jobs' : 'Hide expiring jobs'}
          title={collapsed ? 'Show expiring jobs' : 'Hide expiring jobs'}
        >
          {collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </button>
      </div>
      {!collapsed && (
        <ul className="expiring-rows" id={bodyId}>
          {visible.map(job => {
            const hint = expiryHint(job)
            return (
              <li key={job.job_key} className="expiring-row">
                <FitScore score={job.fit_score} />
                <button type="button" className="expiring-open" onClick={() => onOpen(job)} title="Open the details">
                  <strong>{job.title}</strong>
                  <span>{job.company_name || 'Unknown company'}{hint ? ` · ${hint.label}` : ''}</span>
                </button>
                <span className="expiring-actions">
                  <button type="button" className="icon-btn save-btn" onClick={act(onSave, job)} title="Save (s)" aria-label={`Save: ${job.title}`}>
                    <BookmarkIcon />
                  </button>
                  <button type="button" className="icon-btn applied-btn" onClick={act(onApplied, job)} title="Mark applied (a)" aria-label={`Mark applied: ${job.title}`}>
                    <CheckCircleIcon />
                  </button>
                  <button type="button" className="icon-btn danger" onClick={act(onHide, job)} title="Hide (x)" aria-label={`Hide: ${job.title}`}>
                    <EyeOffIcon />
                  </button>
                </span>
              </li>
            )
          })}
          {(more > 0 || (expanded && rows.length > first)) && (
            <li className="expiring-more">
              <button type="button" className="text-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
                {expanded ? 'Show fewer' : `Show ${more} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
})
