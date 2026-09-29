import { useEffect, useRef, useState } from 'react'

const INTENT_PX = 12
const TRIGGER_PX = 64 // indicator distance needed to refresh
const MAX_PULL_PX = 96
const RESISTANCE = 0.5 // indicator moves at half the finger speed

// Pull down at the top of the page to refresh (touch only). Vertical intent is required (|dy| > 2|dx|),
// so horizontal row swipes never trigger it. Ignored inside dialogs/sheets and while `enabled` is false.
export function usePullToRefresh(onRefresh, enabled = true) {
  const [pull, setPull] = useState(0)
  const state = useRef({ start: null, lock: null, pull: 0 })
  const latest = useRef({ onRefresh, enabled })

  useEffect(() => {
    latest.current = { onRefresh, enabled }
  })

  useEffect(() => {
    const reset = () => {
      state.current = { start: null, lock: null, pull: 0 }
      setPull(0)
    }

    const onStart = (e) => {
      if (!latest.current.enabled || e.touches.length !== 1 || window.scrollY > 0) return
      if (e.target.closest?.('.drawer-root, .filter-panel, .modal-root, .bottom-nav')) return
      const touch = e.touches[0]
      state.current = { start: { x: touch.clientX, y: touch.clientY }, lock: null, pull: 0 }
    }

    const onMove = (e) => {
      const current = state.current
      if (!current.start || current.lock === 'other') return
      const touch = e.touches[0]
      const dx = touch.clientX - current.start.x
      const dy = touch.clientY - current.start.y
      if (!current.lock) {
        if (Math.abs(dx) < INTENT_PX && Math.abs(dy) < INTENT_PX) return
        current.lock = dy > 0 && dy > Math.abs(dx) * 2 && window.scrollY <= 0 ? 'pull' : 'other'
        if (current.lock === 'other') return
      }
      current.pull = Math.min(Math.max(dy * RESISTANCE, 0), MAX_PULL_PX)
      setPull(current.pull)
    }

    const onEnd = () => {
      const triggered = state.current.lock === 'pull' && state.current.pull >= TRIGGER_PX
      reset()
      if (triggered) latest.current.onRefresh()
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', reset)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', reset)
    }
  }, [])

  return { pull, armed: pull >= TRIGGER_PX }
}
