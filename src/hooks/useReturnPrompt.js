import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { isTracked } from '../utils/gold'
import { clearOpened, markPrompted, readOpened, wasPrompted } from '../utils/viewPref'

// Asked between these times after you opened a posting (sooner is the click itself, later you have moved on)
const MIN_AWAY_MS = 5000
const MAX_AWAY_MS = 30 * 60_000

// "Applied to <title> at <company>?" when you come back to the app after opening a posting (#8). Call recordOpened(job)
// (viewPref) when a posting is opened. When the page is visible or focused again 5 s to 30 min later and that job is
// still untracked, prompt is { job_key, title, company_name, at }; each job is asked about at most once per tab.
// trackedState(jobKey) returns true / false when the page knows the job (its list rows), else undefined: the job is
// then looked up with api.jobRow (a job that is gone is not asked about). answer() clears the prompt and the record;
// the caller marks the job applied on "Yes".
export function useReturnPrompt({ trackedState, enabled = true } = {}) {
  const [prompt, setPrompt] = useState(null)
  const trackedRef = useRef(trackedState)
  const checkingRef = useRef(false)

  useLayoutEffect(() => {
    trackedRef.current = trackedState
  })

  const check = useCallback(async () => {
    if (!enabled || checkingRef.current || document.visibilityState === 'hidden') return
    const opened = readOpened()
    if (!opened) return
    const away = Date.now() - opened.at
    if (away < MIN_AWAY_MS) return
    if (away > MAX_AWAY_MS || wasPrompted(opened.job_key)) {
      clearOpened()
      return
    }
    checkingRef.current = true
    try {
      let tracked = trackedRef.current?.(opened.job_key)
      if (tracked === undefined) {
        const row = await api.jobRow(opened.job_key).catch(() => null)
        tracked = row ? isTracked(row) : true
      }
      // Another check may have answered it meanwhile
      if (readOpened()?.job_key !== opened.job_key) return
      if (tracked) {
        clearOpened()
        return
      }
      markPrompted(opened.job_key)
      setPrompt(opened)
    } finally {
      checkingRef.current = false
    }
  }, [enabled])

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', check)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', check)
    }
  }, [check])

  // Either answer ("Yes, applied" or "Not yet") ends it
  const answer = useCallback(() => {
    clearOpened()
    setPrompt(null)
  }, [])

  return { prompt, answer }
}
