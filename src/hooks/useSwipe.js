import { useRef, useState } from 'react'
import { thud, tick } from '../utils/haptics'
import { markSwipeUsed } from '../utils/viewPref'

const INTENT_PX = 14 // movement before deciding between scroll and swipe
const MIN_TRIGGER_PX = 110
const TRIGGER_SHARE = 0.4 // or 40% of the element width, whichever is larger
const MAX_DRAG_PX = 180
const MAX_TRIGGER_PX = MAX_DRAG_PX - 30 // wide rows (tablets, landscape) must still be reachable within the drag clamp
// A touch starting this close to either screen edge is the system's back / forward gesture, never a swipe
export const EDGE_GUARD_PX = 24

// Deliberate horizontal swipe on touch devices. Vertical scrolling wins as soon as the finger moves
// more vertically than horizontally, so scrolling through the list never triggers an action. A short vibration marks
// the moment the swipe arms (tick) and when it commits (thud), see utils/haptics.js. Touches that start within
// EDGE_GUARD_PX of the screen edges are ignored.
export function useSwipe({ onLeft, onRight }) {
  const start = useRef(null)
  const [offset, setOffset] = useState(0)
  const threshold = useRef(MIN_TRIGGER_PX)
  const armedRef = useRef(false)

  const reset = () => {
    start.current = null
    armedRef.current = false
    setOffset(0)
  }

  const handlers = {
    onTouchStart: (e) => {
      start.current = null
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      if (touch.clientX < EDGE_GUARD_PX || touch.clientX > window.innerWidth - EDGE_GUARD_PX) return
      armedRef.current = false
      start.current = { x: touch.clientX, y: touch.clientY, lock: null }
      threshold.current = Math.min(Math.max(MIN_TRIGGER_PX, e.currentTarget.offsetWidth * TRIGGER_SHARE), MAX_TRIGGER_PX)
    },
    onTouchMove: (e) => {
      const state = start.current
      if (!state || state.lock === 'y') return
      const touch = e.touches[0]
      const dx = touch.clientX - state.x
      const dy = touch.clientY - state.y
      if (!state.lock) {
        if (Math.abs(dx) < INTENT_PX && Math.abs(dy) < INTENT_PX) return
        state.lock = Math.abs(dx) > Math.abs(dy) * 2 ? 'x' : 'y'
        if (state.lock === 'y') return
      }
      const allowed = (dx > 0 && onRight) || (dx < 0 && onLeft)
      const next = allowed ? Math.max(Math.min(dx, MAX_DRAG_PX), -MAX_DRAG_PX) : 0
      const armed = Math.abs(next) >= threshold.current
      if (armed && !armedRef.current) tick()
      armedRef.current = armed
      setOffset(next)
    },
    onTouchEnd: () => {
      const locked = start.current?.lock === 'x'
      const distance = offset
      reset()
      if (!locked) return
      const action = distance >= threshold.current ? onRight : distance <= -threshold.current ? onLeft : null
      if (!action) return
      thud()
      markSwipeUsed() // no swipe tip toast once you swiped (viewPref countOpenWithoutSwipe)
      action()
    },
    onTouchCancel: reset,
  }

  const armed = Math.abs(offset) >= threshold.current
  return { offset, armed, handlers }
}
