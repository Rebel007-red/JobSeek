import { useCallback, useEffect, useRef, useState } from 'react'
import { useUndoStack } from './useUndoStack'

const TOAST_MS = 6000
const ACTION_TOAST_MS = 10_000 // a toast with actions (hide reasons, mute shortcuts) stays longer

// One toast at a time, hidden after TOAST_MS. undo (optional) is pushed onto the undo stack (the last 5 actions of the
// last 10 minutes): the toast's Undo button and the u key undo the newest, then the ones before, even after the toast
// has gone (undoCount says how many are left). tone: 'success' | 'danger' colours the toast like the swipe hint for the
// same action. actions: [{ label, onClick }] extra buttons (hide reasons, "Mute <company>"). options.offerUndo: a
// follow-up toast that adds no undo of its own ("Thanks, noted") still shows Undo for the stack's newest entry.
export function useToast() {
  const [toast, setToast] = useState(null)
  const timerRef = useRef(null)
  const idRef = useRef(0) // toast.id: tells two toasts with the same message apart (Toast's live region)
  const undoStack = useUndoStack()
  const { push, run } = undoStack

  const hideToast = useCallback(() => {
    clearTimeout(timerRef.current)
    setToast(null)
  }, [])

  const showToast = useCallback((message, undo, tone, actions, options) => {
    clearTimeout(timerRef.current)
    // An undo given while another undo runs (its "redo") is not recorded, and the toast then offers none
    const recorded = Boolean(undo) && push(undo, message)
    const list = Array.isArray(actions) && actions.length ? actions : null
    idRef.current += 1
    setToast({ id: idRef.current, message, undo: recorded ? undo : null, tone, actions: list, offerUndo: Boolean(options?.offerUndo) })
    timerRef.current = setTimeout(() => setToast(null), list ? ACTION_TOAST_MS : TOAST_MS)
  }, [push])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  // Undoes the newest action on the stack (not only the one this toast shows)
  const runUndo = useCallback(() => {
    clearTimeout(timerRef.current)
    setToast(null)
    return run()
  }, [run])

  return { toast, showToast, hideToast, runUndo, undoCount: undoStack.count }
}
