import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

// '2026-10-05' (a UTC day) -> 'Oct 5', or 'Oct 5, 2026' with the year
function dayLabel(day, withYear = false) {
  if (!day) return '–'
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return '–'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
}

const isNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
const num = (value) => (isNumber(value) ? Number(value).toLocaleString() : '–')
// 0.7 -> '70%'
const share = (value) => (isNumber(value) ? `${Math.round(Number(value) * 100)}%` : '–')
const ratio = (part, whole) => `${num(part)}/${num(whole)}`

// Admin Metrics card (Settings → System): the north star (strong-fit applications per active user) and its supporting
// numbers over the last 8 ISO weeks (UTC, Monday first), from api.metrics() (one row, see app.read_metrics). Loaded
// when the tab opens; aggregates only.
export function MetricsCard() {
  const [metrics, setMetrics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      setMetrics(await api.metrics())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const header = (
    <div className="settings-card-header">
      <h3 id="system-metrics">Metrics</h3>
      <button type="button" onClick={load} disabled={loading} className="secondary-button compact-button">
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  )

  if (!metrics) {
    return (
      <section className="settings-card metrics-card" aria-labelledby="system-metrics">
        {header}
        {loading ? (
          <div className="settings-empty-state inline-empty">Loading metrics…</div>
        ) : error ? (
          <p className="settings-form-error">Could not load the metrics: {error}</p>
        ) : (
          <div className="settings-empty-state inline-empty">No metrics yet.</div>
        )}
      </section>
    )
  }

  const weeks = Array.isArray(metrics.weeks) ? metrics.weeks : []
  const thisWeek = weeks[0] || {}
  const { weekly_return: weekly = {}, retention = {}, outcome_capture: outcome = {}, guardrails = {} } = metrics
  const hours = isNumber(guardrails.median_hours_to_apply) ? Number(guardrails.median_hours_to_apply).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '–'

  return (
    <section className="settings-card metrics-card" aria-labelledby="system-metrics">
      {header}
      {error && <p className="settings-form-error" role="alert">Could not refresh: {error}</p>}

      <p className="metrics-lead">
        <strong>{isNumber(thisWeek.north_star) ? Number(thisWeek.north_star).toLocaleString() : '–'}</strong>{' '}
        strong-fit applications per active user this week
      </p>

      <div className="metrics-table-wrap">
        <table className="metrics-table">
          <caption className="sr-only">Last 8 weeks</caption>
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col">Active users</th>
              <th scope="col">Strong-fit applications</th>
              <th scope="col">Per active user</th>
              <th scope="col">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map(week => (
              <tr key={week.week}>
                <th scope="row">{dayLabel(week.week)}</th>
                <td>{num(week.active_users)}</td>
                <td>{num(week.strong_applications)}</td>
                <td>{isNumber(week.north_star) ? Number(week.north_star).toLocaleString() : '–'}</td>
                <td title={`Strong fits acted on: ${num(week.acted_strong)}; disappeared untouched: ${num(week.missed_strong)}`}>
                  {share(week.coverage)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="metrics-lines">
        <li>Weekly return: {num(weekly.habitual_7d)} of {num(weekly.active_7d)} users active 3+ of the last 7 days</li>
        <li>
          New users (60 d): {num(retention.new_users)} · back next day {ratio(retention.d1, retention.d1_eligible)} · back
          on day 7 {ratio(retention.d7, retention.d7_eligible)}
        </li>
        <li>Outcome capture: {num(outcome.moved)} of {num(outcome.eligible)} applications 14+ days old moved past Applied</li>
        <li>Duplicate applies (28 d): {share(guardrails.duplicate_rate)}</li>
        <li>Median time to apply (28 d): {hours === '–' ? hours : `${hours} h`}</li>
      </ul>

      <p className="muted-text">
        Counting since {dayLabel(metrics.collecting_since, true)}. Counters only: no job links or searches are stored.
      </p>
    </section>
  )
}
