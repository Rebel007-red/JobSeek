import { useEffect, useRef } from 'react'
import { BookmarkIcon, CheckIcon, EyeOffIcon } from './icons'

// The icon of the action the toast reports, as on the row buttons (the x only ever closes)
const SavedIcon = () => <BookmarkIcon filled />
const TOAST_ICONS = { success: CheckIcon, danger: EyeOffIcon, primary: SavedIcon }

// When the toast's button that had keyboard focus goes away (Undo, a hide reason, the toast closing), focus moves to the
// open drawer, else the highlighted row, else the first row, instead of dropping to <body>.
function focusAfterToast() {
  const now = document.activeElement
  if (now && now !== document.body && now.isConnected) return
  const target = document.querySelector('.drawer-root[role="dialog"] button[aria-label="Close details"]')
    || document.querySelector('article.is-active[data-job-key]')
    || document.querySelector('article[data-job-key]')
  target?.focus({ preventScroll: true })
}

const TAP_SLOP_PX = 10

// A toast button's handlers. After a quick swipe on a row, Chrome treats the next tap as "stop the fling" and drops its
// click (tap suppression), so Undo right after a swipe could do nothing. A touch press therefore acts on touchend (and
// cancels the click that may follow); mouse and keyboard keep using click.
const pressStarts = new WeakMap() // button -> the touch that started on it (kept across re-renders)

function pressHandlers(fn) {
  return {
    onTouchStart: (e) => {
      const touch = e.changedTouches[0]
      if (e.touches.length === 1 && touch) pressStarts.set(e.currentTarget, { id: touch.identifier, x: touch.clientX, y: touch.clientY })
      else pressStarts.delete(e.currentTarget)
    },
    onTouchEnd: (e) => {
      const from = pressStarts.get(e.currentTarget)
      pressStarts.delete(e.currentTarget)
      const touch = from && [...e.changedTouches].find(item => item.identifier === from.id)
      if (!touch || Math.abs(touch.clientX - from.x) > TAP_SLOP_PX || Math.abs(touch.clientY - from.y) > TAP_SLOP_PX) return
      if (!e.cancelable) return // the browser is scrolling: its click (if any) decides
      e.preventDefault()
      fn()
    },
    onTouchCancel: (e) => { pressStarts.delete(e.currentTarget) },
    onClick: fn,
  }
}

// toast: { id, message, undo, tone ('success' | 'danger' | 'primary'), actions, offerUndo } from useToast(), or null. undoCount: steps left on the undo
// stack ("Undo (3)"); a toast with actions (hide reasons, "Mute <company>") keeps offering Undo while the action before
// it can be undone. Always rendered: the polite live region exists before a message arrives (screen readers miss
// regions inserted with their text), and a no-break space on every other toast lets the same message be read again.
export function Toast({ toast, onUndo, undoCount = 0 }) {
  const focusedRef = useRef(false) // keyboard focus is inside the toast
  useEffect(() => {
    if (!focusedRef.current) return undefined
    const frame = requestAnimationFrame(() => {
      const now = document.activeElement
      if (now && now !== document.body && now.isConnected) return // still on a toast button (or moved on purpose)
      focusedRef.current = false
      focusAfterToast()
    })
    return () => cancelAnimationFrame(frame)
  })
  const live = (
    <div className="sr-only" role="status" aria-live="polite">
      {toast ? `${toast.message}${toast.id % 2 ? ' ' : ''}` : ''}
    </div>
  )
  if (!toast) return live
  const Icon = TOAST_ICONS[toast.tone]
  const canUndo = Boolean(toast.undo) || ((Boolean(toast.actions) || toast.offerUndo) && undoCount > 0)
  return (
    <>
      {live}
      <div
        className={`toast ${toast.tone || ''} ${toast.actions ? 'has-actions' : ''}`}
        onFocus={() => { focusedRef.current = true }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget)) return
          focusedRef.current = false
          // Focus going nowhere (the button was removed): put it back on the list
          if (!e.relatedTarget) requestAnimationFrame(focusAfterToast)
        }}
      >
        {Icon && <Icon />}
        <span className="toast-message">{toast.message}</span>
        {toast.actions && (
          <span className="toast-actions">
            {toast.actions.map(action => (
              <button key={action.label} type="button" className="toast-action" {...pressHandlers(action.onClick)}>{action.label}</button>
            ))}
          </span>
        )}
        {canUndo && (
          <button type="button" {...pressHandlers(onUndo)}>{undoCount > 1 ? `Undo (${undoCount})` : 'Undo'} <kbd>u</kbd></button>
        )}
      </div>
    </>
  )
}
