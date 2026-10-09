import { useEffect, useId, useState } from 'react'
import { api } from '../../lib/api'
import { sessionUser } from '../../lib/session'
import { dataFreshness, formatDate } from '../../utils/job'

// keep in sync: app.write_set_allowed_email() in supabase/app_api.sql (lower-cased, at most 320 characters)
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const EMAIL_MAX_LENGTH = 320

function emailProblem(email, list) {
  if (!email) return 'Enter an email address'
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) return 'Invalid email'
  if (list.some(row => row.email === email)) return `${email} is already on the list`
  return ''
}

const byEmail = (a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)

// "2 h ago" (the latest ping or write of that email's account), '–' without one
const lastActive = (value) => dataFreshness(value)?.label.replace(/^Updated /, '') || '–'
const countText = (value) => (value === null || value === undefined ? '–' : Number(value).toLocaleString())

// Admin only (the server checks): who may use the job data (app.allowed_emails). An empty list lets every signed-in
// user in; admins always can. Edits show at once and go back (with the reason) when the server refuses.
export function AccessPanel() {
  const [emails, setEmails] = useState([]) // [{ email, added_at, last_active_at, applied_7d }]
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [input, setInput] = useState('')
  const [formError, setFormError] = useState('')
  const [listError, setListError] = useState('')
  const [confirming, setConfirming] = useState(null) // email waiting for "Remove?"
  const ids = useId()
  const me = sessionUser()?.email?.toLowerCase() || ''

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setLoadError('')
    try {
      setEmails(await api.allowedEmails())
    } catch (err) {
      setLoadError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function add(e) {
    e.preventDefault()
    const email = input.trim().toLowerCase()
    const problem = emailProblem(email, emails)
    if (problem) return setFormError(problem)
    setFormError('')
    setListError('')
    setInput('')
    const row = { email, added_at: new Date().toISOString() }
    setEmails(prev => [...prev, row].sort(byEmail))
    try {
      await api.setAllowedEmail(email, true)
    } catch (err) {
      setEmails(prev => prev.filter(item => item !== row))
      setInput(email)
      setFormError(`Could not add ${email}: ${err.message}`)
    }
  }

  async function remove(row) {
    setConfirming(null)
    setListError('')
    setEmails(prev => prev.filter(item => item.email !== row.email))
    try {
      await api.setAllowedEmail(row.email, false)
    } catch (err) {
      setEmails(prev => [...prev.filter(item => item.email !== row.email), row].sort(byEmail))
      setListError(`Could not remove ${row.email}: ${err.message}`)
    }
  }

  return (
    <div className="settings-panel settings-panel-animate">
      <div className="settings-card">
        <div className="settings-card-header">
          <h3>Who can use JobSeeker</h3>
          {!loading && !loadError && <small className="muted-text">{emails.length} {emails.length === 1 ? 'email' : 'emails'}</small>}
        </div>
        <p className="settings-copy">
          Only these accounts see job data. An empty list lets every signed-in user in. Admins can always sign in.
          New people also need an account: invite them from the Supabase dashboard (Authentication → Users).
        </p>

        <form onSubmit={add} className="settings-field" noValidate>
          <label htmlFor={`${ids}-email`}>Give access to</label>
          <div className="settings-input-row">
            <input
              id={`${ids}-email`}
              type="email"
              autoComplete="off"
              value={input}
              onChange={e => { setInput(e.target.value); setFormError('') }}
              placeholder="name@example.com"
              maxLength={EMAIL_MAX_LENGTH}
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? `${ids}-email-error` : undefined}
              className="settings-input"
            />
            <button type="submit" className="primary-button compact-button" disabled={!input.trim() || loading}>Allow</button>
          </div>
          {formError && <p id={`${ids}-email-error`} className="settings-inline-error" role="alert">{formError}</p>}
        </form>

        {listError && <p className="settings-form-error" role="alert">{listError}</p>}

        {loading ? (
          <div className="settings-empty-state inline-empty">Loading…</div>
        ) : loadError ? (
          <>
            <p className="settings-form-error">Could not load the list: {loadError}</p>
            <div className="settings-actions-row">
              <button type="button" onClick={load} className="secondary-button compact-button">Retry</button>
            </div>
          </>
        ) : emails.length === 0 ? (
          <div className="settings-empty-state inline-empty">
            The list is empty, so every signed-in user can use the app. Add an email to limit access.
          </div>
        ) : (
          <ul className="settings-list access-list" aria-label="Allowed emails">
            {emails.map(row => (
              <li key={row.email} className="settings-row">
                <div className="settings-row-main">
                  <div className="settings-company-name">
                    {row.email}
                    {row.email === me && <span className="settings-chip access-you">you</span>}
                  </div>
                  {row.added_at && <div className="settings-company-meta"><span>added {formatDate(row.added_at)}</span></div>}
                </div>
                <dl className="access-stats">
                  <div title={row.last_active_at ? new Date(row.last_active_at).toLocaleString() : 'No visit recorded yet'}>
                    <dt>Last active</dt>
                    <dd>{lastActive(row.last_active_at)}</dd>
                  </div>
                  <div title="Jobs marked applied in the last 7 days">
                    <dt>Applied (7 d)</dt>
                    <dd>{countText(row.applied_7d)}</dd>
                  </div>
                </dl>
                <div className="settings-row-actions">
                  {confirming === row.email ? (
                    <div className="inline-confirm" role="group" aria-label={`Remove ${row.email}?`}>
                      <span>
                        {emails.length === 1
                          ? 'Remove? The list will be empty, so every signed-in user can use the app.'
                          : 'Remove?'}
                      </span>
                      <button type="button" className="secondary-button compact-button danger-button" onClick={() => remove(row)} autoFocus>Remove</button>
                      <button type="button" className="secondary-button compact-button" onClick={() => setConfirming(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button type="button" className="secondary-button compact-button" onClick={() => setConfirming(row.email)} aria-label={`Remove ${row.email}`}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
