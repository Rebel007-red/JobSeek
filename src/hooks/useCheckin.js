import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { sessionUser } from '../lib/session'
import { isCheckinDue } from '../utils/tracker'

// The user the sheet already opened by itself for in this page load: a remount (Settings and back) never reopens it,
// even when recording the time failed
let autoOpenedFor = null

// The weekly "How did last week go?" sheet (app_read 'checkin', app_write 'markCheckin').
// enabled: profile loaded and access allowed. While enabled, the check-in is read once per mount; when it is due (something
// to ask about and not shown yet this local week, utils/tracker.js isCheckinDue) the sheet opens by itself, at most once
// per page load. The page may hold an open sheet back (a drawer or another sheet is in front); it calls shown() once the
// sheet is really on screen, and only then is the time recorded (app_write markCheckin), so a sheet closed without
// answers does not come back this week, and one that never showed (a deep-linked job left open) still comes next visit.
// show() re-reads and opens it by hand (the Applied tab's "Weekly check-in"), due or not; hide() closes it and re-reads,
// so answered applications drop out of total. Against an older API ("Unknown action") it stays closed and quiet.
// -> { open, jobs, total, loading, show(), hide(), refresh(), shown() }
export function useCheckin({ enabled = true } = {}) {
  const [open, setOpen] = useState(false)
  const [jobs, setJobs] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const requestRef = useRef(0)
  const readOnceRef = useRef(false)
  // The sheet opened by itself and its time is not recorded yet (shown() records it)
  const markPendingRef = useRef(false)

  // Resolves to the check-in row, or null when the read failed. Only the newest read sets the state, but every caller
  // gets its row (a refresh() during the first read must not stop the sheet opening by itself)
  const read = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    try {
      const row = (await api.checkin()) || { last_checkin_at: null, total: 0, jobs: [] }
      if (request === requestRef.current) {
        setJobs(Array.isArray(row.jobs) ? row.jobs : [])
        setTotal(Number(row.total) || 0)
      }
      return row
    } catch {
      // older API, offline: no sheet
      return null
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled || readOnceRef.current) return
    readOnceRef.current = true
    read().then(row => {
      const user = sessionUser()?.id || 'anon'
      if (!row || autoOpenedFor === user) return
      if (!isCheckinDue({ lastCheckinAt: row.last_checkin_at, total: row.total })) return
      autoOpenedFor = user
      markPendingRef.current = true
      setOpen(true)
    })
  }, [enabled, read])

  const shown = useCallback(() => {
    if (!markPendingRef.current) return
    markPendingRef.current = false
    api.markCheckin().catch(() => {})
  }, [])

  const refresh = useCallback(() => read(), [read])

  const show = useCallback(async () => {
    const row = await read()
    if (row) setOpen(true)
  }, [read])

  const hide = useCallback(() => {
    setOpen(false)
    read()
  }, [read])

  return { open, jobs, total, loading, show, hide, refresh, shown }
}
