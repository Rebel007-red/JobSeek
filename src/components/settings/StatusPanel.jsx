import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { dataFreshness } from '../../utils/job'
import { SCHEDULES, clockLabel, nextJobsAt, nextStart } from '../../utils/schedule'
import { MANUAL_SOURCES, SCRAPE_SOURCES, sourceLabel } from '../../utils/sources'

// Every scrape source: the scheduled company boards first, then the ones run by hand only (LinkedIn), shown as paused
const SOURCES = [
  ...SCRAPE_SOURCES.filter(key => !MANUAL_SOURCES.includes(key)),
  ...SCRAPE_SOURCES.filter(key => MANUAL_SOURCES.includes(key)),
].map(key => ({ key, label: sourceLabel(key), manual: MANUAL_SOURCES.includes(key) }))
const PAUSED = { label: 'Paused', tone: 'muted' }
const PAUSED_TITLE = 'No schedule: runs only when the LinkedIn workflow is started by hand'

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
// What the ATS Scrapers workflow decided about the pipeline (app.pipeline_triggers, databricks/jobs/record_trigger.py).
// keep in sync: app.c_trigger_decisions() / record_trigger.py DECISIONS. "recent" is the workflow's 3 h gap
// (trigger_job.py --min-interval-hours, manual runs only).
const DECISIONS = {
  started: { label: 'Started', tone: 'success' },
  started_daily: { label: 'Started: daily run', tone: 'success' },
  waiting: { label: 'Joined a waiting run', tone: 'running' },
  recent: { label: 'Skipped: ran under 3 h ago', tone: 'muted' },
  paused: { label: 'Paused by Databricks', tone: 'warning' },
  no_new: { label: 'Skipped: no new files', tone: 'muted' },
  failed: { label: 'Failed', tone: 'danger' },
}
const DECISION_TITLES = {
  started_daily: 'No new jobs, but the daily run was due (the latest run started 20+ hours ago, or it failed): expiry and the daily clean-up still run',
  paused: 'Databricks accepts no new runs for now (Free Edition over its allowance). The uploaded files are kept; the next allowed run ingests them',
  no_new: 'The scrapers found only jobs the pipeline already has, and a run was still going or the latest one started less than 20 hours ago',
}
// The wait's own results (trigger_job.py); Databricks result states use RUN_RESULTS. NONE / SKIPPED / PAUSED add
// nothing to the decision badge, so they show no badge.
const WAIT_RESULTS = {
  TIMEOUT: { label: 'Still running when the wait ended', tone: 'warning' },
  STARTED: { label: 'Started', tone: 'running' },
  ERROR: { label: 'Wait failed', tone: 'danger' },
}
const QUIET_RESULTS = ['NONE', 'SKIPPED', 'PAUSED']
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
const known = (value) => value !== null && value !== undefined
// '6:10 AM' today, else 'Oct 12, 2026, 6:10 AM'
const when = (value, now) => (new Date(value).toDateString() === now.toDateString() ? time(value) : dateTime(value))

// A decision's run result: the Databricks run's own result when the run history has it (a wait that timed out is
// settled there later), else the wait's result; null when it adds nothing to the decision
function decisionResult(trigger, runs) {
  const run = trigger.run_id ? runs.find(item => String(item.run_id) === String(trigger.run_id)) : null
  const fromRun = run && runBadge(run.result, run.state)
  if (fromRun) return fromRun
  const result = trigger.result
  if (!result || QUIET_RESULTS.includes(result)) return null
  return WAIT_RESULTS[result] || runBadge(result, null)
}

// "3 files uploaded, 1 with new jobs (12 jobs)"; the parts the workflow did not count are left out
function uploadText({ uploaded_files: uploaded, new_files: newFiles, new_jobs: newJobs }) {
  if (!known(uploaded)) return ''
  const files = `${count(uploaded)} ${Number(uploaded) === 1 ? 'file' : 'files'} uploaded`
  if (!known(newFiles)) return files
  const jobs = known(newJobs) ? ` (${count(newJobs)} ${Number(newJobs) === 1 ? 'job' : 'jobs'})` : ''
  return `${files}, ${count(newFiles)} with new jobs${jobs}`
}

function Badge({ badge, title }) {
  if (!badge) return null
  return <span className={`company-health ${badge.tone}`} title={title}>{badge.label}</span>
}

// Admin System tab: pipeline runs, scrape reports, the LinkedIn search cap, the ATS Scrapers workflow's pipeline
// decisions, the database size and the schedule (api.systemStatus(): one row, see app.read_system_status in
// supabase/app_api.sql). `triggers` is missing before the Track release SQL: the decisions card then stays away.
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

  const { database = {}, counts = {}, publish, runs = [], scrapes = [], linkedin, triggers, generated_at: generatedAt } = status || {}
  const decisions = Array.isArray(triggers) ? triggers : null
  // The newest decision explains a run list that stopped growing: the pipeline was skipped, or Databricks paused it
  const latestDecision = decisions?.[0]
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
          Users see &ldquo;Next jobs around {clockLabel(nextJobsAt(now))}&rdquo; (the next company-boards scrape plus about
          the time it takes to publish, an estimate). The pipeline starts only when the scrapers found new jobs, when the
          workflow is run by hand with <code>force</code>, or for its daily run (when the latest run started 20+ hours
          ago, or failed). LinkedIn has no schedule: it runs only when started by hand.
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
                    {source.label}{' '}
                    {source.manual && <Badge badge={PAUSED} title={PAUSED_TITLE} />}{source.manual && latest && ' '}
                    {(!source.manual || latest) && (
                      <Badge badge={latest ? SCRAPE_STATUSES[latest.status] || { label: latest.status, tone: 'pending' } : { label: 'No report yet', tone: 'pending' }} />
                    )}
                  </div>
                  {source.manual && <p className="system-message">{PAUSED_TITLE}.</p>}
                  {latest && (
                    <div className="settings-company-meta">
                      <span title={dateTime(latest.finished_at)}>{source.manual ? 'Last run ' : ''}{dateTime(latest.finished_at)}</span>
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

      {decisions && (
        <section className="settings-card" aria-labelledby="system-decisions">
          <div className="settings-card-header">
            <h3 id="system-decisions">Pipeline decisions</h3>
            {decisions.length > 0 && <small className="muted-text">Last {decisions.length} ATS Scrapers runs</small>}
          </div>
          {decisions.length === 0 ? (
            <div className="settings-empty-state inline-empty">No decisions recorded yet. They appear after the next ATS Scrapers run.</div>
          ) : (
            <ol className="settings-list system-list">
              {decisions.map((trigger, index) => {
                const badge = DECISIONS[trigger.decision] || { label: trigger.decision, tone: 'pending' }
                const result = decisionResult(trigger, runs)
                const uploads = uploadText(trigger)
                return (
                  <li key={`${trigger.github_run_id || 'run'}-${trigger.decided_at}-${index}`} className="settings-row system-decision">
                    <div className="settings-row-main">
                      <div className="settings-company-name">
                        {dateTime(trigger.decided_at)} <Badge badge={badge} title={DECISION_TITLES[trigger.decision]} />
                      </div>
                      {(uploads || trigger.forced || trigger.run_id) && (
                        <div className="settings-company-meta">
                          {uploads && <span>{uploads}</span>}
                          {trigger.forced && <span>Forced by hand</span>}
                          {trigger.run_id && (
                            <span>Run {trigger.run_id}{result && <> <Badge badge={result} title={trigger.result || undefined} /></>}</span>
                          )}
                        </div>
                      )}
                      {trigger.message && <p className="system-message">{trigger.message}</p>}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      )}

      <section className="settings-card" aria-labelledby="system-runs">
        <div className="settings-card-header">
          <h3 id="system-runs">Databricks runs</h3>
          <small className="muted-text">Last {runs.length}</small>
        </div>
        {latestDecision?.decision === 'no_new' && (
          <p className="system-lead">
            Pipeline skipped: no new files at {when(latestDecision.decided_at, now)}. The scrapers found only jobs the
            pipeline already has; it runs again with new jobs, or for its daily run.
          </p>
        )}
        {latestDecision?.decision === 'paused' && (
          <p className="system-lead warning">
            Databricks paused new runs at {when(latestDecision.decided_at, now)} (Free Edition over its allowance). The
            uploaded files are kept; the next allowed run ingests them.
          </p>
        )}
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
