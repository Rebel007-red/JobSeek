import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PING_COUNT_MAX, SYNC_MS, api } from '../lib/api'
import { sessionUser } from '../lib/session'
import { addCount, afterPing, localSince, planPing, readVisit, saveVisit, visitKey } from '../utils/visit'

// A visit ends after this long without a ping (keep in sync: app.c_visit_gap_minutes(), pinned in sql_constants.test.js)
export const VISIT_GAP_MS = 30 * 60_000
// At most one ping this often, shared by the tabs of this device
export const PING_EVERY_MS = 10 * 60_000

const PROMPT_COUNTERS = { yes: 'promptYes', no: 'promptNo', saved: 'promptSaved' }
const PLAN = { gapMs: VISIT_GAP_MS, everyMs: PING_EVERY_MS, maxCount: PING_COUNT_MAX }
const storageKey = () => visitKey(sessionUser()?.id)

// "New since your last visit" and the throttled ping (app_write 'ping'; the bookkeeping is in utils/visit.js).
// since: undefined until known, then the ISO time of your previous visit, or null on a first visit ever. One `since`
// holds for the whole visit: the pings every 10 minutes do not move it; coming back to the page after 30+ minutes away
// starts a new visit. Pings happen on mount, when the page becomes visible and every 5 minutes while it is visible, at
// most every PING_EVERY_MS (across tabs), and only while `enabled` (profile loaded, access allowed). recordOpen() (a
// job's details opened) and recordPrompt('yes' | 'no' | 'saved') (the "Did you apply?" answers) are counted and sent
// with the next ping; a failed ping keeps them for the next one. Against an older API without 'ping' the call fails
// quietly and since stays at the local estimate.
export function useVisit({ enabled = true } = {}) {
  const [since, setSince] = useState(() => localSince(readVisit(storageKey()), Date.now(), VISIT_GAP_MS))
  const inflightRef = useRef(false)
  const enabledRef = useRef(enabled)

  useLayoutEffect(() => {
    enabledRef.current = enabled
  })

  const attempt = useCallback(async () => {
    if (!enabledRef.current || inflightRef.current || document.visibilityState === 'hidden') return
    const key = storageKey()
    const entry = readVisit(key)
    const now = Date.now()
    const plan = planPing(entry, now, PLAN)
    if (!plan) return
    if (plan.newVisit && entry.pingAt) setSince(localSince(entry, now, VISIT_GAP_MS))
    inflightRef.current = true
    try {
      const result = await api.ping(plan.sent)
      const next = afterPing(readVisit(key), plan, result?.previous_seen_at, Date.now())
      saveVisit(key, next)
      setSince(next.since)
    } catch {
      // older API ("Unknown action"), offline: try again at the next chance; the counters stay pending
    } finally {
      inflightRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    attempt()
    const onVisible = () => { if (document.visibilityState === 'visible') attempt() }
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(attempt, SYNC_MS)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [enabled, attempt])

  const add = useCallback((counter) => {
    const key = storageKey()
    saveVisit(key, addCount(readVisit(key), counter))
  }, [])

  const recordOpen = useCallback(() => add('opened'), [add])
  const recordPrompt = useCallback((answer) => {
    if (PROMPT_COUNTERS[answer]) add(PROMPT_COUNTERS[answer])
  }, [add])

  return { since, recordOpen, recordPrompt, ping: attempt }
}
