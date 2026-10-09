import { useEffect, useId, useRef, useState } from 'react'

const DISMISS_DRAG_PX = 60 // a swipe down this far answers "Not yet" (the bottom sheet on phones)

// "Did you apply to <title> at <company>?" after you come back from a posting (useReturnPrompt). Not modal: the list
// stays usable; a (Yes, applied), s (Save for later) and Esc (Not yet) answer it from the keyboard (handled by the page).
// On phones it is a bottom sheet above the bottom bar with three full-width buttons (CSS), and a swipe down answers
// "Not yet"; wider screens keep a banner under the top bar. autoFocus: Yes takes focus (not while the drawer is open,
// which keeps its own). Once answered, focus goes back to where it was (a field or a button), else to the highlighted
// row, which is then the next job after auto-advance.
export function ReturnPrompt({ prompt, onYes, onSave, onNo, autoFocus = true }) {
  const titleId = useId()
  const yesRef = useRef(null)
  const returnRef = useRef(null)
  const dragRef = useRef(null)
  const [drag, setDrag] = useState(0)

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

  const touch = {
    onTouchStart: (e) => {
      dragRef.current = e.touches.length === 1 ? e.touches[0].clientY : null
    },
    onTouchMove: (e) => {
      if (dragRef.current === null) return
      setDrag(Math.max(0, e.touches[0].clientY - dragRef.current))
    },
    onTouchEnd: () => {
      const distance = drag
      dragRef.current = null
      setDrag(0)
      if (distance >= DISMISS_DRAG_PX) onNo()
    },
    onTouchCancel: () => {
      dragRef.current = null
      setDrag(0)
    },
  }

  return (
    <div
      className={`return-prompt ${drag ? 'is-dragging' : ''}`}
      role="dialog"
      aria-labelledby={titleId}
      style={drag ? { '--drag': `${drag}px` } : undefined}
      {...touch}
    >
      <span className="return-prompt-grip" aria-hidden="true" />
      <p id={titleId}>
        Did you apply to <strong>{prompt.title || 'this job'}</strong>{prompt.company_name ? <> at <strong>{prompt.company_name}</strong></> : null}?
      </p>
      <div className="return-prompt-actions">
        <button ref={yesRef} type="button" className="btn primary sm" onClick={onYes}>Yes, applied <kbd>a</kbd></button>
        <button type="button" className="btn sm" onClick={onSave}>Save for later <kbd>s</kbd></button>
        <button type="button" className="btn sm" onClick={onNo}>Not yet <kbd>Esc</kbd></button>
      </div>
    </div>
  )
}
