import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { NOTE_MAX_LENGTH } from '../../utils/entries'
import { isTracked } from '../../utils/gold'
import { formatDate, localDay } from '../../utils/job'
import { StatusPicker } from './StatusPicker'

const NOTE_WARN_AT = NOTE_MAX_LENGTH - 200 // the counter turns to the warning tone from here
const DATE_RANGE_DAYS = 366 // setNote accepts follow-up dates within this many days of today

const shiftDay = (days) => localDay(new Date(Date.now() + days * 86_400_000))
const sameValues = (a, b) => a.note === b.note && a.date === b.date
const cleanValues = (values) => ({ note: values.note.trim(), date: values.date || '' })

// The drawer's "Your application" section: status picker, a private note and a follow-up date for one job. Mount it
// with key={job.job_key}. The note saves on blur, with "Save note", and when the drawer moves on or closes with
// unsaved text. Saves run one after another, so the last edit always wins.
// onStatus(status) changes the status; onNoteSaved({ has_note, next_action_at, application_status }) reports a saved note
// (a note or date on an untracked job saves the job); notify(message) reports errors once the panel is gone.
export function ApplicationPanel({ job, status, onStatus, onNoteSaved, notify, statusRef }) {
  const jobKey = job.job_key
  const ids = { status: useId(), note: useId(), date: useId(), help: useId() }
  const knownEmpty = job.has_note === false && !job.next_action_at
  const initial = { note: '', date: job.next_action_at ? String(job.next_action_at).slice(0, 10) : '' }
  const [values, setValues] = useState(initial)
  const [saved, setSaved] = useState(initial) // what the server has (savedRef for the save queue)
  const [loading, setLoading] = useState(!knownEmpty)
  const [loadError, setLoadError] = useState('') // the saved note is unknown, so editing is off (a save would replace it)
  const [phase, setPhase] = useState({ state: 'idle', error: '' }) // idle | saving | saved | error
  const valuesRef = useRef(initial)
  const savedRef = useRef(initial) // what the server has
  const queueRef = useRef(Promise.resolve())
  const mountedRef = useRef(true)
  const callbacksRef = useRef({ onNoteSaved, notify })

  useLayoutEffect(() => {
    callbacksRef.current = { onNoteSaved, notify }
  })

  const edit = (patch) => {
    valuesRef.current = { ...valuesRef.current, ...patch }
    setValues(valuesRef.current)
    if (phase.state !== 'saving') setPhase({ state: 'idle', error: '' })
  }

  const save = () => {
    const run = async () => {
      const next = cleanValues(valuesRef.current)
      if (sameValues(next, savedRef.current)) {
        if (mountedRef.current) setPhase(prev => (prev.state === 'saving' ? { state: 'idle', error: '' } : prev))
        return
      }
      if (mountedRef.current) setPhase({ state: 'saving', error: '' })
      try {
        const row = await api.setNote(jobKey, next.note || null, next.date || null)
        // 0 rows: the last update deleted the job (it was over 2 days old and untracked), so nothing was saved
        if (Number(row?.num_affected_rows) === 0) throw new Error('This job disappeared with the last update, so the note was not saved')
        savedRef.current = next
        if (mountedRef.current) setSaved(next)
        callbacksRef.current.onNoteSaved?.({
          has_note: Boolean(next.note),
          next_action_at: next.date || null,
          ...(row?.application_status ? { application_status: row.application_status } : {}),
        })
        if (mountedRef.current) setPhase({ state: 'saved', error: '' })
      } catch (err) {
        if (mountedRef.current) setPhase({ state: 'error', error: err.message })
        else callbacksRef.current.notify?.(`Could not save the note: ${err.message}`)
      }
    }
    queueRef.current = queueRef.current.then(run, run)
    return queueRef.current
  }

  // The saved note and date (skipped when the row says there are none)
  useEffect(() => {
    if (knownEmpty) return undefined
    let cancelled = false
    api.jobNote(jobKey)
      .then(row => {
        if (cancelled) return
        const loaded = { note: row?.note || '', date: row?.next_action_at ? String(row.next_action_at).slice(0, 10) : '' }
        savedRef.current = loaded
        valuesRef.current = loaded
        setSaved(loaded)
        setValues(loaded)
      })
      .catch(err => { if (!cancelled) setLoadError(`Could not load the note: ${err.message}`) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, []) // once per job (the panel is keyed by job_key)

  // The follow-up date changed outside the panel (the AgeNotice's "No reply yet", or its Undo): take it as the saved date,
  // unless you are editing the date here, so a later note save does not send the old date back
  const outsideDate = job.next_action_at ? String(job.next_action_at).slice(0, 10) : ''
  useEffect(() => {
    if (outsideDate === savedRef.current.date) return
    const editing = valuesRef.current.date !== savedRef.current.date
    savedRef.current = { ...savedRef.current, date: outsideDate }
    setSaved(savedRef.current)
    if (!editing) {
      valuesRef.current = { ...valuesRef.current, date: outsideDate }
      setValues(valuesRef.current)
    }
  }, [outsideDate])

  // Unsaved text is saved when the drawer moves to another job or closes (set again on mount: StrictMode remounts)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (!sameValues(cleanValues(valuesRef.current), savedRef.current)) save()
    }
  }, [])

  const locked = loading || Boolean(loadError)
  const dirty = !sameValues(cleanValues(values), saved)
  const length = values.note.length
  const promotes = !isTracked(job) && status === 'not_applied'

  return (
    <section className="drawer-section application-panel" aria-labelledby={`${ids.status}-heading`}>
      <h3 id={`${ids.status}-heading`}>Your application</h3>
      <div className="application-status-row">
        <label htmlFor={ids.status}>Status</label>
        <StatusPicker id={ids.status} ref={statusRef} status={status} onChange={onStatus} />
        {status !== 'not_applied' && job.status_updated_at && (
          <span className="application-since">since {formatDate(job.status_updated_at)}</span>
        )}
      </div>

      <div className="note-field">
        <div className="note-label-row">
          <label htmlFor={ids.note}>Note</label>
          {/* announced only near the limit (a live count on every keystroke is noise for screen readers) */}
          <span className={`note-counter ${length >= NOTE_WARN_AT ? 'warn' : ''}`} aria-live={length >= NOTE_WARN_AT ? 'polite' : 'off'}>
            {length}/{NOTE_MAX_LENGTH}
          </span>
        </div>
        <textarea
          id={ids.note}
          className="input note-input"
          rows={3}
          maxLength={NOTE_MAX_LENGTH}
          value={values.note}
          readOnly={locked}
          aria-busy={loading || undefined}
          aria-describedby={promotes ? ids.help : undefined}
          placeholder={loading ? 'Loading note…' : 'Recruiter, referral, interview dates… (only you see this)'}
          onChange={(e) => edit({ note: e.target.value })}
          onBlur={() => { if (!locked) save() }}
        />
      </div>

      <div className="note-date-row">
        <label htmlFor={ids.date}>Follow up on</label>
        <input
          id={ids.date}
          type="date"
          className="input note-date"
          value={values.date}
          min={shiftDay(-DATE_RANGE_DAYS)}
          max={shiftDay(DATE_RANGE_DAYS)}
          disabled={locked}
          onChange={(e) => edit({ date: e.target.value })}
          onBlur={() => { if (!locked) save() }}
        />
        {values.date && !locked && (
          <button type="button" className="text-button" onClick={() => { edit({ date: '' }); save() }}>Clear date</button>
        )}
        <button type="button" className="btn sm note-save" onClick={save} disabled={locked || phase.state === 'saving' || !dirty}>
          {phase.state === 'saving' ? 'Saving…' : 'Save note'}
        </button>
        <span className="note-status" role="status">{phase.state === 'saved' && !dirty ? 'Saved' : ''}</span>
      </div>

      {promotes && (
        <p id={ids.help} className="drawer-note">A note or a follow-up date saves this job, so it doesn't disappear.</p>
      )}
      {(loadError || phase.state === 'error') && <p className="form-error">{loadError || phase.error}</p>}
    </section>
  )
}
