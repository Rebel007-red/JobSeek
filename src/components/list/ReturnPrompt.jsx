import { useEffect, useId, useRef } from 'react'

// "Applied to <title> at <company>?" after you come back from a posting (useReturnPrompt). Not modal: the list stays
// usable; a (Yes) and Esc (Not yet) answer it from the keyboard (handled by the page). autoFocus: Yes takes focus (not
// while the drawer is open, which keeps its own). Once answered, focus goes back to where it was (a field or a button),
// else to the highlighted row, which is then the next job after auto-advance.
export function ReturnPrompt({ prompt, onYes, onNo, autoFocus = true }) {
  const titleId = useId()
  const yesRef = useRef(null)
  const returnRef = useRef(null)

  useEffect(() => {
    if (!autoFocus) return
    const before = document.activeElement
    if (before && before !== document.body && !yesRef.current?.closest('.return-prompt')?.contains(before)) returnRef.current = before
    yesRef.current?.focus({ preventScroll: true })
  }, [prompt.job_key, autoFocus])

  // On close (unmount), after the page has moved the highlight
  useEffect(() => () => {
    const before = returnRef.current
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return // focus went somewhere on purpose
      const row = document.querySelector('article.is-active[data-job-key]')
      const target = before?.isConnected && !before.dataset?.jobKey ? before : row || (before?.isConnected ? before : null)
      target?.focus({ preventScroll: true })
    })
  }, [])

  return (
    <div className="return-prompt" role="dialog" aria-labelledby={titleId}>
      <p id={titleId}>
        Applied to <strong>{prompt.title || 'this job'}</strong>{prompt.company_name ? <> at <strong>{prompt.company_name}</strong></> : null}?
      </p>
      <div className="return-prompt-actions">
        <button ref={yesRef} type="button" className="btn primary sm" onClick={onYes}>Yes, applied <kbd>a</kbd></button>
        <button type="button" className="btn sm" onClick={onNo}>Not yet <kbd>Esc</kbd></button>
      </div>
    </div>
  )
}
