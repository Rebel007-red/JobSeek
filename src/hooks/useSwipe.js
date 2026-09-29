import { useRef, useState } from 'react'

const INTENT_PX = 14 // movement before deciding between scroll and swipe
const MIN_TRIGGER_PX = 110
const TRIGGER_SHARE = 0.4 // or 40% of the element width, whichever is larger
const MAX_DRAG_PX = 180

// Deliberate horizontal swipe on touch devices. Vertical scrolling wins as soon as the finger moves
// more vertically than horizontally, so scrolling through the list never triggers an action.
export function useSwipe({ onLeft, onRight }) {
  const start = useRef(null)
  const [offset, setOffset] = useState(0)
  const threshold = useRef(MIN_TRIGGER_PX)

  const reset = () => {
    start.current = null
    setOffset(0)
  }

  const handlers = {
    onTouchStart: (e) => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      start.current = { x: touch.clientX, y: touch.clientY, lock: null }
      threshold.current = Math.max(MIN_TRIGGER_PX, e.currentTarget.offsetWidth * TRIGGER_SHARE)
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
      setOffset(allowed ? Math.max(Math.min(dx, MAX_DRAG_PX), -MAX_DRAG_PX) : 0)
    },
    onTouchEnd: () => {
      const locked = start.current?.lock === 'x'
      const distance = offset
      reset()
      if (!locked) return
      if (distance >= threshold.current) onRight?.()
      else if (distance <= -threshold.current) onLeft?.()
    },
    onTouchCancel: reset,
  }

  const armed = Math.abs(offset) >= threshold.current
  return { offset, armed, handlers }
}
