import { useId, useLayoutEffect, useRef, useState } from 'react'
import { isApplied, statusLabel } from '../../utils/gold'
import { shortDay } from './dates'

// The way an application usually goes, then how it can end
const TRACK = ['saved', 'applied', 'interviewing', 'offer']
const OUTCOMES = ['no_response', 'rejected', 'withdrawn']
const STEPS = [...TRACK, ...OUTCOMES]

const statusOf = (job) => job?.application_status || (job?.is_applied ? 'applied' : 'not_applied')

// The track steps behind the current stage: everything before it on the track, and for an outcome (No reply, Rejected,
// Withdrawn) Saved, Applied and the interview when there was one (interviewed_at; an older API has no such column)
function passedSteps(job, current) {
  const index = TRACK.indexOf(current)
  if (index >= 0) return new Set(TRACK.slice(0, index))
  if (!OUTCOMES.includes(current)) return new Set()
  const passed = new Set(['saved', 'applied'])
  if (job.interviewed_at) passed.add('interviewing')
  return passed
}

// The drawer's one stage control for a saved or applied job: Saved — Applied — Interviewing — Offer, then the outcomes
// No reply · Rejected · Withdrawn. Passed steps show ✓, Applied shows its date. A roving tab stop: Left / Right / Home /
// End move, Enter / Space pick. onChange(status) only on a real change (the page's setJobStatus: optimistic, with Undo).
// Saved is off once applied (Undo applied in the actions goes back). ref reaches the current step (the t key).
export function StageStepper({ job, onChange, ref }) {
  const labelId = useId()
  const listRef = useRef(null)
  const stepRefs = useRef({})
  const current = statusOf(job)
  const applied = isApplied(job)
  const passed = passedSteps(job, current)
  const [focusKey, setFocusKey] = useState(null) // the step holding the tab stop after arrow keys (else the current one)
  const tabStop = STEPS.includes(focusKey) ? focusKey : STEPS.includes(current) ? current : STEPS[0]

  // On a narrow screen the steps scroll sideways: bring the current one into view (without scrolling the drawer)
  useLayoutEffect(() => {
    const list = listRef.current
    const step = stepRefs.current[current]
    if (!list || !step || list.scrollWidth <= list.clientWidth) return
    list.scrollLeft = Math.max(0, step.offsetLeft - (list.clientWidth - step.offsetWidth) / 2)
  }, [current])

  const move = (key) => {
    setFocusKey(key)
    stepRefs.current[key]?.focus()
  }

  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const index = STEPS.indexOf(tabStop)
    let next = null
    if (e.key === 'ArrowRight') next = STEPS[Math.min(index + 1, STEPS.length - 1)]
    else if (e.key === 'ArrowLeft') next = STEPS[Math.max(index - 1, 0)]
    else if (e.key === 'Home') next = STEPS[0]
    else if (e.key === 'End') next = STEPS[STEPS.length - 1]
    if (next === null) return
    e.preventDefault() // also keeps the page's shortcuts out of it
    move(next)
  }

  const step = (status) => {
    const isCurrent = status === current
    const locked = status === 'saved' && applied // going back to Saved is Undo applied
    const done = passed.has(status)
    let text = statusLabel(status)
    if (status === 'applied' && applied) {
      const day = shortDay(job.applied_at)
      text = day ? `Applied ✓ ${day}` : 'Applied ✓'
    } else if (done) {
      text = `${text} ✓`
    }
    return (
      <button
        key={status}
        ref={el => {
          stepRefs.current[status] = el
          if (status === current && ref) {
            if (typeof ref === 'function') ref(el)
            else ref.current = el
          }
        }}
        type="button"
        className={`stage-step stage-${status} ${isCurrent ? 'is-current' : ''} ${done ? 'is-done' : ''}`}
        aria-current={isCurrent ? 'step' : undefined}
        aria-label={`${statusLabel(status)}${isCurrent ? ', current stage' : ''}`}
        aria-disabled={locked && !isCurrent ? true : undefined}
        title={locked && !isCurrent ? 'Use Undo applied to go back to Saved' : isCurrent ? undefined : `Move to ${statusLabel(status)}`}
        tabIndex={status === tabStop ? 0 : -1}
        onFocus={() => setFocusKey(status)}
        onClick={() => {
          if (isCurrent || locked) return
          onChange?.(status)
        }}
      >
        {text}
      </button>
    )
  }

  return (
    <div className="stage-stepper">
      <span className="stage-stepper-label" id={labelId}>Stage</span>
      <div
        className="stage-steps"
        role="group"
        aria-labelledby={labelId}
        ref={listRef}
        onKeyDown={onKeyDown}
        /* leaving the steps gives the tab stop back to the current stage */
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocusKey(null) }}
      >
        <span className="stage-track">
          {TRACK.map((status, index) => (
            <span key={status} className="stage-track-item">
              {index > 0 && <span className={`stage-line ${passed.has(status) || status === current ? 'is-done' : ''}`} aria-hidden="true" />}
              {step(status)}
            </span>
          ))}
        </span>
        <span className="stage-outcomes">
          {OUTCOMES.map(step)}
        </span>
      </div>
    </div>
  )
}
