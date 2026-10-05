import { useCallback, useEffect, useRef, useState } from 'react'

const TOAST_MS = 6000

// One toast at a time, hidden after TOAST_MS. undo (optional) runs from the toast's Undo button or the u key;
// tone: 'success' | 'danger' colours the toast like the swipe hint for the same action.
export function useToast() {
  const [toast, setToast] = useState(null)
  const timerRef = useRef(null)

  const showToast = useCallback((message, undo, tone) => {
    clearTimeout(timerRef.current)
    setToast({ message, undo, tone })
    timerRef.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  const runUndo = () => {
    const undo = toast?.undo
    setToast(null)
    undo?.()
  }

  return { toast, showToast, runUndo }
}
