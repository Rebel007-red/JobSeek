import { useCallback, useEffect, useRef, useState } from 'react'
import { UNDO_TTL_MS, popUndo, pruneUndo, pushUndo } from '../utils/undoStack'

// Multi-step undo (#8): push(undo, label) after each undoable action; run() undoes the newest one, then the one before,
// up to UNDO_MAX steps of the last 10 minutes. count is how many steps are left (for "Undo (3)").
// An undo that itself pushes an undo (the toast after undoing offers to redo) is not recorded while it runs, so the
// next run() goes on to the action before instead of redoing this one.
export function useUndoStack() {
  const entriesRef = useRef([])
  const [count, setCount] = useState(0)
  const timerRef = useRef(null)
  const runningRef = useRef(0) // undos in progress

  // Recount now and again when the oldest entry expires
  const sync = useCallback(() => {
    clearTimeout(timerRef.current)
    const now = Date.now()
    entriesRef.current = pruneUndo(entriesRef.current, now)
    setCount(entriesRef.current.length)
    const oldest = entriesRef.current[0]
    if (oldest) timerRef.current = setTimeout(sync, Math.max(oldest.at + UNDO_TTL_MS - now, 0) + 50)
  }, [])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  // True when the undo was recorded
  const push = useCallback((undo, label) => {
    if (typeof undo !== 'function' || runningRef.current > 0) return false
    entriesRef.current = pushUndo(entriesRef.current, undo, label)
    sync()
    return true
  }, [sync])

  // Runs (and forgets) the newest undo; resolves to its label, or null when there was nothing to undo
  const run = useCallback(async () => {
    const [entry, rest] = popUndo(entriesRef.current)
    entriesRef.current = rest
    sync()
    if (!entry) return null
    runningRef.current += 1
    try {
      await entry.undo()
    } finally {
      runningRef.current -= 1
    }
    return entry.label ?? ''
  }, [sync])

  const clear = useCallback(() => {
    entriesRef.current = []
    sync()
  }, [sync])

  return { push, run, clear, count }
}
