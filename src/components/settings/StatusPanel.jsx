import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { dataFreshness } from '../../utils/job'
import { SCHEDULES, clockLabel, nextJobsAt, nextStart } from '../../utils/schedule'

const SOURCES = [
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'workday', label: 'Workday' },
  { key: 'greenhouse', label: 'Greenhouse' },
]

// Run results (Databricks result_state / life cycle state) and scrape statuses as badges: { label, tone }
const RUN_RESULTS = {
  SUCCESS: { label: 'Succeeded', tone: 'success' },
  SUCCESS_WITH_FAILURES: { label: 'Partly failed', tone: 'warning' },
  FAILED: { label: 'Failed', tone: 'danger' },
  TIMEDOUT: { label: 'Timed out', tone: 'danger' },
  CANCELED: { label: 'Cancelled', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'warning' },
  SKIPPED: { label: 'Skipped', tone: 'muted' },
  UPSTREAM_FAILED: { label: 'Not run', tone: 'muted' },
  UPSTREAM_CANCELED: { label: 'Not run', tone: 'muted' },
  EXCLUDED: { label: 'Excluded', tone: 'muted' },
}
const SCRAPE_STATUSES = {
  ok: { label: 'OK', tone: 'success' },
  partial: { label: 'Partial', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  crashed: { label: 'Crashed', tone: 'danger' },
}
// How a run was started (Databricks trigger); the workflows start it with run-now (ONE_TIME)
const TRIGGERS = { ONE_TIME: 'run now', PERIODIC: 'Databricks schedule', RETRY: 'retry' }
const DATABASE_WARN = 0.8 // the size bar turns to the warning tone above this share of the limit
const MB = 1024 * 1024

function runBadge(result, state) {
  if (result) return RUN_RESULTS[result] || { label: result.toLowerCase().replace(/_/g, ' '), tone: 'pending' }
  if (!state) return null
  if (['PENDING', 'QUEUED', 'BLOCKED', 'WAITING'].includes(state)) return { label: 'Waiting', tone: 'running' }
  if (['RUNNING', 'TERMINATING'].includes(state)) return { label: 'Running', tone: 'running' }
  return { label: state.toLowerCase().replace(/_/g, ' '), tone: 'pending' }
}

const dateTime = (value) => (value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')
const time = (value) => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

function duration(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s < 0) return ''
  if (s < 60) return `${Math.round(s)} s`
  const minutes = Math.round(s / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

// "Step_01_Ingest_Silver" -> "Ingest silver"
function taskName(key) {
  const words = String(key || '').replace(/^Step_\d+_/i, '').replace(/_/g, ' ').trim().toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Task'
}

const count = (value) => (value === null || value === undefined ? '–' : Number(value).toLocaleString())

function Badge({ badge, title }) {
  if (!badge) return null
  return <span className={`company-health ${badge.tone}`} title={title}>{badge.label}</span>
}

// Admin System tab: pipeline runs, scrape reports, the LinkedIn search cap, the database size and the schedule
// (api.systemStatus(): one row, see app.read_system_status in supabase/app_api.sql)
export function StatusPanel() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      setStatus(await api.systemStatus())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading && !status) return <div className="settings-panel"><div className="settings-empty-state">Loading system status…</div></div>
  if (error && !status) {
    return (
      <div className="settings-panel">
        <div className="settings-card">
          <p className="settings-form-error">Could not load the system status: {error}</p>
          <div className="settings-actions-row">
            <button type="button" onClick={load} className="secondary-button compact-button">Retry</button>
          </div>
        </div>
      </div>
    )
  }

  const { database = {}, counts = {}, publish, runs = [], scrapes = [], linkedin, generated_at: generatedAt } = status || {}
  const used = Number(database.bytes) || 0
  const limit = Number(database.limit_bytes) || 500 * MB
  const share = Math.min(used / limit, 1)
  const now = new Date()

  return (
    <div className="settings-panel settings-panel-animate system-panel">
      <div className="settings-summary-row">
        <p>
          {generatedAt ? `As of ${time(generatedAt)}. ` : ''}Run history comes from Databricks after each publish (at most
          an hour old); scrape results arrive when each scrape ends.
        </p>
        <button type="button" onClick={load} disabled={loading} className="secondary-button compact-button">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error && <p className="settings-form-error" role="alert">Could not refresh: {error}</p>}

      <section className="settings-card" aria-labelledby="system-database">
        <div className="settings-card-header">
          <h3 id="system-database">Database</h3>
          <small className="muted-text">Supabase free plan</small>
        </div>
        <div className="system-meter-label">
          <strong>{Math.round(used / MB)} MB of {Math.round(limit / MB)} MB</strong>
          <span className="muted-text">{Math.round(share * 100)}% used</span>
        </div>
        <div
          className={`system-meter ${share > DATABASE_WARN ? 'warning' : ''}`}
          role="meter"
          aria-labelledby="system-database"
          aria-valuemin={0}
          aria-valuemax={Math.round(limit / MB)}
          aria-valuenow={Math.round(used / MB)}
          aria-valuetext={`${Math.round(used / MB)} MB of ${Math.round(limit / MB)} MB`}
        >
          <span style={{ width: `${Math.max(share * 100, 1)}%` }} />
        </div>
        {share > DATABASE_WARN && (
          <p className="settings-inline-error">Over {Math.round(DATABASE_WARN * 100)}% used. On the free plan Supabase makes the database read-only at the limit.</p>
        )}
        <dl className="system-counts">
          <div><dt>Jobs</dt><dd>{count(counts.jobs)}</dd></div>
          <div title="Jobs in the latest update; the others are kept because someone saved or applied to them"><dt>In the latest update</dt><dd>{count(counts.active_jobs)}</dd></div>
          <div><dt>Saved or applied</dt><dd>{count(counts.tracked_jobs)}</dd></div>
          <div><dt>Profiles</dt><dd>{count(counts.profiles)}</dd></div>
          <div><dt>Allowed emails</dt><dd>{count(counts.allowed_emails)}</dd></div>
        </dl>
        {publish?.published_at && (
          <p className="muted-text">
            Last publish {dateTime(publish.published_at)} ({dataFreshness(publish.published_at)?.label.replace(/^Updated /, '')}):{' '}
            {count(publish.jobs)} jobs from run {publish.run_id}.
          </p>
        )}
      </section>

      <section className="settings-card" aria-labelledby="system-schedule">
        <div className="settings-card-header">
          <h3 id="system-schedule">Next scheduled runs</h3>
          <small className="muted-text">Your local time; GitHub can start them a few minutes late</small>
        </div>
        <ul className="system-schedule">
          {SCHEDULES.map(schedule => {
            const at = nextStart(schedule, now)
            return (
              <li key={schedule.label}>
                <span>{schedule.label}</span>
                <strong>{at ? time(at) : '–'}</strong>
              </li>
            )
          })}
        </ul>
        <p className="muted-text">
          Users see &ldquo;Next jobs around {clockLabel(nextJobsAt(now))}&rdquo; (the next LinkedIn run plus about the time
          it takes to publish).
        </p>
      </section>

      <section className="settings-card" aria-labelledby="system-scrapers">
        <div className="settings-card-header">
          <h3 id="system-scrapers">Scrapers</h3>
        </div>
        <div className="settings-list system-list">
          {SOURCES.map(source => {
            const history = scrapes.filter(row => row.source === source.key)
            const latest = history[0]
            return (
              <div key={source.key} className="settings-row system-row">
                <div className="settings-row-main">
                  <div className="settings-company-name">
                    {source.label} <Badge badge={latest ? SCRAPE_STATUSES[latest.status] || { label: latest.status, tone: 'pending' } : { label: 'No report yet', tone: 'pending' }} />
                  </div>
                  {latest && (
                    <div className="settings-company-meta">
                      <span title={dateTime(latest.finished_at)}>{dateTime(latest.finished_at)}</span>
                      <span>{count(latest.companies)} {source.key === 'linkedin' ? 'searches' : 'companies'}, {count(latest.failed)} failed</span>
                      <span>{count(latest.jobs_written)} jobs written{latest.jobs_scraped !== null && latest.jobs_scraped !== undefined ? ` of ${count(latest.jobs_scraped)} scraped` : ''}</span>
                    </div>
                  )}
                  {latest?.message && <p className="system-message">{latest.message}</p>}
                </div>
                {history.length > 1 && (
                  <ol className="system-history" aria-label={`Last ${history.length} ${source.label} scrapes, newest first`}>
                    {history.map(row => {
                      const badge = SCRAPE_STATUSES[row.status] || { label: row.status, tone: 'pending' }
                      return <li key={`${row.github_run_id}-${row.github_run_attempt}-${row.finished_at}`} className={`system-dot ${badge.tone}`} title={`${badge.label} · ${dateTime(row.finished_at)}`}><span className="sr-only">{badge.label}, {dateTime(row.finished_at)}</span></li>
                    })}
                  </ol>
                )}
              </div>
            )
          })}
        </div>

        {linkedin && (
          <div className="system-linkedin">
            <p>
              <strong>LinkedIn searches:</strong>{' '}
              {count(linkedin.searches_total)} searches, cap {count(linkedin.searches_cap)}:{' '}
              {linkedin.dropped?.length ? `${linkedin.dropped.length} dropped` : 'none dropped'}
            </p>
            {linkedin.dropped?.length > 0 && (
              <details>
                <summary>Show the dropped searches</summary>
                <ul className="system-dropped">
                  {linkedin.dropped.map((name, index) => <li key={`${index}-${name}`}>{name}</li>)}
                </ul>
                <p className="muted-text">Searches past the cap are skipped. Fewer roles or cities per profile, or fewer LinkedIn rows under Companies, bring the count down.</p>
              </details>
            )}
          </div>
        )}
      </section>

      <section className="settings-card" aria-labelledby="system-runs">
        <div className="settings-card-header">
          <h3 id="system-runs">Databricks runs</h3>
          <small className="muted-text">Last {runs.length}</small>
        </div>
        {runs.length === 0 ? (
          <div className="settings-empty-state inline-empty">No runs recorded yet. They appear after the next publish.</div>
        ) : (
          <ol className="settings-list system-list">
            {runs.map(run => {
              const badge = runBadge(run.result, run.state)
              const tasks = Array.isArray(run.tasks) ? run.tasks : []
              return (
                <li key={run.run_id} className="settings-row system-run">
                  <div className="settings-row-main">
                    <div className="settings-company-name">
                      {dateTime(run.started_at || run.published_at)} <Badge badge={badge} title={run.message || undefined} />
                    </div>
                    <div className="settings-company-meta">
                      {run.duration_s !== null && run.duration_s !== undefined && <span>{duration(run.duration_s)}</span>}
                      {run.published_at
                        ? <span>Published {count(run.published_jobs)} jobs, {count(run.deleted_jobs)} removed</span>
                        : run.result && <span>Not published</span>}
                      {run.trigger && <span>{TRIGGERS[run.trigger] || run.trigger.toLowerCase().replace(/_/g, ' ')}</span>}
                    </div>
                    {run.message && run.result !== 'SUCCESS' && <p className="system-message">{run.message}</p>}
                    {tasks.length > 0 && (
                      <ul className="system-tasks" aria-label="Tasks">
                        {tasks.map(task => {
                          const taskBadge = runBadge(task.result, task.state) || { label: 'Not finished', tone: 'pending' }
                          return (
                            <li key={task.task_key} className={`system-task ${taskBadge.tone}`}>
                              {taskName(task.task_key)}
                              <span>{taskBadge.label}{task.duration_s ? ` · ${duration(task.duration_s)}` : ''}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </div>
  )
}
