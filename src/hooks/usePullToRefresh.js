import { useCallback, useEffect, useRef, useState } from 'react'

const INTENT_PX = 12
const TRIGGER_PX = 64 // indicator distance needed to refresh
const MAX_PULL_PX = 96
const RESISTANCE = 0.5 // indicator moves at half the finger speed

// Pull down at the top of the page to refresh (touch only). Vertical intent is required (|dy| > 2|dx|),
// so horizontal row swipes never trigger it. Ignored inside dialogs/sheets and while `enabled` is false.
// The pull distance is written straight to the indicator (indicatorRef) once per frame instead of through
// React state, so a drag doesn't re-render the page; `phase` ('idle' | 'pull' | 'armed') changes only at the edges.
export function usePullToRefresh(onRefresh, enabled = true) {
  const [phase, setPhase] = useState('idle')
  const state = useRef({ start: null, lock: null, pull: 0 })
  const latest = useRef({ onRefresh, enabled })
  const indicator = useRef(null)
  const frame = useRef(0)

  useEffect(() => {
    latest.current = { onRefresh, enabled }
  })

  const paint = useCallback(() => {
    frame.current = 0
    const el = indicator.current
    if (!el) return
    const { pull } = state.current
    el.style.setProperty('--pull', `${pull}px`)
    el.style.opacity = String(Math.min(pull / TRIGGER_PX, 1))
  }, [])

  // Callback ref: the indicator mounts on the first pull frame and gets the current distance right away
  const indicatorRef = useCallback((el) => {
    indicator.current = el
    if (el && state.current.lock === 'pull') paint()
  }, [paint])

  useEffect(() => {
    const reset = () => {
      state.current = { start: null, lock: null, pull: 0 }
      cancelAnimationFrame(frame.current)
      frame.current = 0
      indicator.current?.style.removeProperty('--pull')
      indicator.current?.style.removeProperty('opacity')
      setPhase('idle')
    }

    const onStart = (e) => {
      if (!latest.current.enabled || e.touches.length !== 1 || window.scrollY > 0) return
      if (e.target.closest?.('.drawer-root, .filter-panel, .filter-backdrop, .modal-root, .bottom-nav')) return
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
      setPhase(current.pull >= TRIGGER_PX ? 'armed' : 'pull') // no-op render unless it changed
      if (!frame.current) frame.current = requestAnimationFrame(paint)
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
      cancelAnimationFrame(frame.current)
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', reset)
    }
  }, [paint])

  return { pulling: phase !== 'idle', armed: phase === 'armed', indicatorRef }
}
