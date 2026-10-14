import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { isApplied } from '../../utils/gold'
import { jobLink } from '../../utils/urlState'
import { shortDay } from './dates'

const CHIPS_SHOWN = 8 // more than this: "+N more"

const placeOf = (row) => String(row?.city || '').trim() || String(row?.location || '').trim() || 'Location not stated'

// The chip texts: the place, and for a place that comes up more than once its posting day ("Chennai · Oct 9"), then a
// number when even that repeats ("Chennai · Oct 9 (2)"), so no two chips read the same. -> Map job_key -> text
function chipTexts(rows) {
  const count = (list, nameOf) => list.reduce((m, row) => m.set(nameOf(row), (m.get(nameOf(row)) || 0) + 1), new Map())
  const places = count(rows, placeOf)
  const withDay = (row) => {
    const place = placeOf(row)
    if (places.get(place) < 2) return place
    const day = shortDay(row.posted_date) || shortDay(row.first_seen_at)
    return day ? `${place} · ${day}` : place
  }
  const dayed = count(rows, withDay)
  const seen = new Map()
  return new Map(rows.map((row) => {
    const text = withDay(row)
    if (dayed.get(text) < 2) return [row.job_key, text]
    seen.set(text, (seen.get(text) || 0) + 1)
    return [row.job_key, `${text} (${seen.get(text)})`]
  }))
}

// The latest application among the rows, or null
function latestApplied(rows) {
  let latest = null
  for (const row of rows) {
    if (!isApplied(row)) continue
    if (!latest || String(row.applied_at || '') > String(latest.applied_at || '')) latest = row
  }
  return latest
}

// "Also posted in 6 places": the other visible postings of the job's near-duplicate group (api.jobGroup), as place chips
// that open that posting (onOpenJob(jobKey); without it, a link that opens the app on it). The one you applied to gets
// a ✓, and a warning line says where and when ("You applied to the one in Pune on Oct 4."). Until the group arrives, or
// when it cannot be read, the row's own dup_applied_at / dup_applied_key give that warning with a "View it" button.
export function AlsoPosted({ job, onOpenJob }) {
  const group = job.dup_group || null
  const [state, setState] = useState({ group: null, rows: null })
  const [allKey, setAllKey] = useState(null) // the job whose whole chip list is open

  useEffect(() => {
    if (!group) return undefined
    let cancelled = false
    api.jobGroup(group)
      .then(rows => { if (!cancelled) setState({ group, rows: Array.isArray(rows) ? rows : [] }) })
      .catch(() => { if (!cancelled) setState({ group, rows: [] }) }) // the fallback warning below still shows
    return () => { cancelled = true }
  }, [group])

  const loaded = group && state.group === group ? state.rows : null
  const others = (loaded || []).filter(row => row.job_key !== job.job_key)
  // the group read stops at 50 postings; total_count is the whole group (the job itself included when visible)
  const listedSelf = (loaded || []).some(row => row.job_key === job.job_key)
  const total = loaded?.length ? Math.max(others.length, Number(loaded[0].total_count || 0) - (listedSelf ? 1 : 0)) : others.length
  const applied = latestApplied(others)

  const open = (key) => (e) => {
    if (!onOpenJob) return
    e.preventDefault()
    onOpenJob(key)
  }

  // Before the group arrives, without one, or when the posting you applied to is not among the chips (the group read
  // stops at 50): the row says you applied to a near-identical posting
  const fallback = !applied && job.dup_applied_at ? (
    <div className="drawer-banner warning also-posted-applied" role="note">
      <p>You applied to a near-identical posting{shortDay(job.dup_applied_at) ? ` on ${shortDay(job.dup_applied_at)}` : ''}.</p>
      {job.dup_applied_key && (
        <a className="btn sm" href={jobLink(job.dup_applied_key)} onClick={open(job.dup_applied_key)}>View it</a>
      )}
    </div>
  ) : null

  if (!others.length) {
    // a collapsed list row knows it stands for others: hold their place while they load (the description does not jump)
    if (!loaded && group && Number(job.dup_count) > 0) {
      return (
        <section className="drawer-section also-posted" aria-busy="true">
          <div className="skeleton-lines also-posted-placeholder"><i /></div>
          {fallback}
        </section>
      )
    }
    return fallback ? <section className="drawer-section also-posted">{fallback}</section> : null
  }

  const all = allKey === job.job_key
  const shown = all ? others : others.slice(0, CHIPS_SHOWN)
  const appliedDay = applied ? shortDay(applied.applied_at) : null
  const texts = chipTexts(others)

  return (
    <section className="drawer-section also-posted" aria-labelledby={`also-posted-${job.job_key}`}>
      <h3 id={`also-posted-${job.job_key}`}>Also posted in {total} {total === 1 ? 'place' : 'places'}</h3>
      <ul className="also-posted-chips">
        {shown.map(row => {
          const mine = isApplied(row)
          const day = shortDay(row.applied_at)
          const posting = row.title ? ` (${row.title})` : ''
          return (
            <li key={row.job_key}>
              <a
                className={`also-posted-chip ${mine ? 'is-applied' : ''}`}
                href={jobLink(row.job_key)}
                onClick={open(row.job_key)}
                title={mine ? `You applied to this posting${day ? ` on ${day}` : ''}${posting}` : `Open this posting${posting}`}
              >
                <span className="also-posted-chip-text">{texts.get(row.job_key)}{mine && ' ✓'}</span>
              </a>
            </li>
          )
        })}
        {others.length > CHIPS_SHOWN && (
          <li>
            <button type="button" className="text-button also-posted-more" onClick={() => setAllKey(all ? null : job.job_key)} aria-expanded={all}>
              {all ? 'Show fewer' : `+${others.length - CHIPS_SHOWN} more`}
            </button>
          </li>
        )}
      </ul>
      {applied && (
        <p className="also-posted-warning" role="note">
          You applied to the one in {placeOf(applied)}{appliedDay ? ` on ${appliedDay}` : ''}.
        </p>
      )}
      {fallback}
    </section>
  )
}
