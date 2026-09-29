import { useEffect, useLayoutEffect, useRef } from 'react'

const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isTyping(target) {
  return Boolean(target && (FIELD_TAGS.has(target.tagName) || target.isContentEditable))
}

// Single-key shortcuts, keyed by KeyboardEvent.key ('j', 'Enter', '?', 'Escape').
// Skipped while typing in a field (except Escape), with Ctrl/Alt/Meta held, or when a
// component already handled the event. A handler can return false to let the key through.
export function useHotkeys(bindings) {
  const bindingsRef = useRef(bindings)

  useLayoutEffect(() => {
    bindingsRef.current = bindings
  })

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (isTyping(e.target) && e.key !== 'Escape') return
      const handler = bindingsRef.current[e.key]
      if (handler && handler(e) !== false) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
