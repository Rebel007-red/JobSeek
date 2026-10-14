import { useId, useRef, useState } from 'react'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { statusLabel } from '../../utils/gold'
import { checkinAnswers, daysSinceUpdate } from '../../utils/tracker'
import { CloseIcon } from '../common/icons'
import { isMobile, localDaysSince, shortDay } from './dates'

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

const PHONE_ANSWERS = 3 // phones show this many answers on one line, the rest behind "More" (the hotkeys reach them all)

// The second line of an item: "Acme · Applied 12 days ago" / "Acme · Interviewing, no update for 9 days"
function itemLine(job) {
  const company = job.company_name || 'Unknown company'
  const sinceUpdate = Number.isFinite(Number(job.days_since_update)) && job.days_since_update !== null
    ? Number(job.days_since_update)
    : daysSinceUpdate(job)
  if (job.application_status === 'interviewing') {
    return `${company} · Interviewing, no update for ${plural(sinceUpdate ?? 0, 'day', 'days')}`
  }
  const applied = localDaysSince(job.applied_at) ?? sinceUpdate ?? 0
  return `${company} · Applied ${plural(applied, 'day', 'days')} ago`
}

// What an answered item shows instead of its buttons
function resultText(answer) {
  if (answer.kind === 'snooze') return `We'll ask again on ${shortDay(answer.nextActionAt) || answer.nextActionAt}`
  return `${statusLabel(answer.status)} ✓`
}

// The weekly "How did last week go?" sheet: one row per application with no update for a week (app.read_checkin, at
// most 20 of `total`), each with one-tap answers (tracker.js checkinAnswers, the same as the drawer's AgeNotice).
// onAnswer(job, answer) => Promise does it (the page: a stage change or a follow-up date, with its toast and Undo);
// onOpenJob(job) opens the job (the page closes the sheet first); onClose() closes it. Each answered row keeps its result
// here until the sheet closes. A modal: centered on desktop, a bottom sheet on phones. Keys: j / k or the arrows move
// between rows, 1-5 answer the focused row, u undoes the newest answer, Esc closes.
// onUndo() => Promise<boolean> undoes the newest action (the page's undo stack, the same as the toast's Undo, which sits
// outside this modal); canUndo: the stack still has one. The newest answered row offers "Undo" in place.
export function CheckinSheet({ jobs = [], total = 0, onAnswer, onUndo, canUndo = false, onOpenJob, onClose }) {
  const titleId = useId()
  const panelRef = useRef(null)
  const startRef = useRef(null) // the first row (or Close when there is none) takes the focus on open
  const itemRefs = useRef([])
  // The rows asked about: an answered one stays (with its result) when a re-read leaves it out; new ones join at the end
  const [rows, setRows] = useState(() => jobs)
  const missing = jobs.filter(job => !rows.some(row => row.job_key === job.job_key))
  if (missing.length) setRows([...rows, ...missing])
  const [results, setResults] = useState({}) // job_key -> { state: 'saving' | 'done' | 'error', answer, error }
  const [active, setActive] = useState(0)
  const [answered, setAnswered] = useState([]) // job keys in the order they were answered (Undo takes back the last)
  const [undoing, setUndoing] = useState(false)
  const [phone] = useState(isMobile)
  const [moreKey, setMoreKey] = useState(null) // the row whose every answer shows (phones)

  // Opened by itself (nothing had the focus), it hands the focus to the list's first job when it closes; opened by hand,
  // back to its button
  const [opener] = useState(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    return active && active !== document.body ? active : null
  })
  useDialogFocus(panelRef, startRef, () => (opener ? null : document.querySelector('article[data-job-key]')))

  const count = Math.max(Number(total) || 0, rows.length)
  const isDone = (job) => results[job.job_key]?.state === 'done'
  const allDone = rows.length > 0 && rows.every(isDone)

  const focusRow = (index) => {
    const next = Math.max(0, Math.min(index, rows.length - 1))
    setActive(next)
    itemRefs.current[next]?.focus()
  }

  const answer = async (job, item) => {
    const key = job.job_key
    if (results[key]?.state === 'saving' || results[key]?.state === 'done') return
    setResults(prev => ({ ...prev, [key]: { state: 'saving', answer: item } }))
    // the pressed button turns disabled while it saves: keep the focus (and the keys) on its row, not on the page
    const row = itemRefs.current[rows.findIndex(r => r.job_key === key)]
    if (row?.contains(document.activeElement)) row.focus({ preventScroll: true })
    try {
      await onAnswer?.(job, item)
    } catch (err) {
      setResults(prev => ({ ...prev, [key]: { state: 'error', answer: item, error: err?.message || 'Please try again' } }))
      return
    }
    setResults(prev => ({ ...prev, [key]: { state: 'done', answer: item } }))
    setAnswered(prev => [...prev.filter(k => k !== key), key])
    // one tap each: on to the next row still to answer (focus stays in the sheet when this row's buttons go)
    const index = rows.findIndex(row => row.job_key === key)
    const next = rows.findIndex((row, i) => i > index && !isDone(row) && row.job_key !== key)
    const first = rows.findIndex(row => !isDone(row) && row.job_key !== key)
    if (next >= 0) focusRow(next)
    else if (first >= 0) focusRow(first)
    else panelRef.current?.querySelector('.checkin-done')?.focus()
  }

  // Takes back the newest answer: its row gets its buttons back, and the focus goes to them
  const lastKey = answered[answered.length - 1] || null
  const undoLast = async () => {
    if (!lastKey || !canUndo || undoing || !onUndo) return
    setUndoing(true)
    let undone = false
    try {
      undone = await onUndo()
    } finally {
      setUndoing(false)
    }
    if (!undone) return
    setAnswered(prev => prev.filter(k => k !== lastKey))
    setResults((prev) => {
      const next = { ...prev }
      delete next[lastKey]
      return next
    })
    const index = rows.findIndex(row => row.job_key === lastKey)
    if (index >= 0) requestAnimationFrame(() => focusRow(index))
  }

  const onKeyDown = (e) => {
    if (e.key === 'Tab') return // the focus trap (useDialogFocus) handles it
    // nothing reaches the page's shortcuts behind the sheet (they would act on the list's highlighted job)
    e.stopPropagation()
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose?.()
      return
    }
    if (!rows.length) return
    if (e.key === 'u') {
      e.preventDefault()
      undoLast()
      return
    }
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault()
      focusRow(active + 1)
      return
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusRow(active - 1)
      return
    }
    const digit = Number(e.key)
    if (/^[1-5]$/.test(e.key)) {
      const job = rows[active]
      const item = job && checkinAnswers(job)[digit - 1]
      if (item && !isDone(job)) {
        e.preventDefault()
        answer(job, item)
      }
    }
  }

  return (
    <div className="modal-root checkin-root" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-backdrop" onClick={onClose} aria-hidden="true" />
      {/* tabIndex -1: a click on the panel's text keeps the focus (and the keys) in the sheet */}
      <div className="modal-panel checkin-panel" ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown}>
        <span className="checkin-grip" aria-hidden="true" />
        <div className="modal-header checkin-header">
          <h2 id={titleId}>How did last week go?</h2>
          <button
            ref={el => { if (!rows.length) startRef.current = el }}
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close the weekly check-in"
          >
            <CloseIcon />
          </button>
        </div>
        {rows.length > 0 ? (
          <p className="checkin-sub">
            {count} {count === 1 ? 'application has' : 'applications have'} had no update for a week or more. One tap each.
            {count > rows.length && ` Showing the oldest ${rows.length}.`}
          </p>
        ) : (
          <p className="checkin-sub">Nothing to check: every application had an update this week</p>
        )}

        {rows.length > 0 && (
          <ul className="checkin-list">
            {rows.map((job, index) => {
              const result = results[job.job_key]
              const done = result?.state === 'done'
              const answers = checkinAnswers(job)
              const folded = phone && moreKey !== job.job_key && answers.length > PHONE_ANSWERS
              const shownAnswers = folded ? answers.slice(0, PHONE_ANSWERS) : answers
              return (
                <li
                  key={job.job_key}
                  ref={el => {
                    itemRefs.current[index] = el
                    if (index === 0) startRef.current = el
                  }}
                  className={`checkin-item ${index === active ? 'is-active' : ''} ${done ? 'is-done' : ''}`}
                  tabIndex={-1}
                  aria-label={`${job.title || 'Job'} at ${job.company_name || 'unknown company'}`}
                  onFocus={() => setActive(index)}
                >
                  <div className="checkin-item-text">
                    <button type="button" className="checkin-title" onClick={() => onOpenJob?.(job)} title="Open this job">
                      {job.title || 'Untitled job'}
                    </button>
                    <p className="checkin-meta">{itemLine(job)}</p>
                  </div>
                  {done ? (
                    <div className="checkin-result-row">
                      <p className="checkin-result" role="status">{resultText(result.answer)}</p>
                      {job.job_key === lastKey && canUndo && onUndo && (
                        <button type="button" className="text-button checkin-undo" onClick={undoLast} disabled={undoing} title="Undo (u)">
                          Undo
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className={`checkin-answers ${folded ? 'is-folded' : ''}`} role="group" aria-label="Your answer">
                      {shownAnswers.map(item => (
                        <button
                          key={item.key}
                          type="button"
                          className={`btn sm ${item.suggested ? 'is-suggested' : ''}`}
                          title={item.title}
                          aria-label={item.ariaLabel}
                          disabled={result?.state === 'saving'}
                          onClick={() => answer(job, item)}
                        >
                          {item.label}
                          {/* not by colour only: the suggestion is said in words too */}
                          {item.suggested && <span className="answer-suggested"><span aria-hidden="true">· </span>suggested</span>}
                        </button>
                      ))}
                      {folded && (
                        <button
                          type="button"
                          className="btn sm checkin-more"
                          aria-label={`More answers: ${answers.slice(PHONE_ANSWERS).map(item => item.label).join(', ')}`}
                          disabled={result?.state === 'saving'}
                          onClick={() => {
                            setMoreKey(job.job_key)
                            // the first answer that was hidden takes the focus (the More button goes away)
                            requestAnimationFrame(() => itemRefs.current[index]?.querySelectorAll('.checkin-answers .btn')[PHONE_ANSWERS]?.focus())
                          }}
                        >
                          More
                        </button>
                      )}
                    </div>
                  )}
                  {result?.state === 'error' && <p className="form-error">Could not save: {result.error}</p>}
                </li>
              )
            })}
          </ul>
        )}

        <div className="checkin-footer">
          {allDone && <p className="checkin-all-done" role="status">All done. See you next week.</p>}
          <p className="checkin-keys hide-mobile" aria-hidden="true"><kbd>1</kbd>-<kbd>5</kbd> answer · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>u</kbd> undo · <kbd>Esc</kbd> close</p>
          <button type="button" className="btn primary checkin-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
