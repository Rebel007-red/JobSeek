import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clearAuthLinkType, supabase } from '../lib/supabase'
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../utils/password'

// Opened from an invite link (already signed in by the link): choose the password used on the login page.
export function SetPasswordPage() {
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        navigate('/login', { replace: true })
        return
      }
      setEmail(session.user.email || '')
      setReady(true)
    })
  }, [navigate])

  async function handleSubmit(e) {
    e.preventDefault()
    const problem = passwordProblem(password, confirm)
    if (problem) return setError(problem)
    setError('')
    setSaving(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setSaving(false)
    if (updateError) {
      // "Failed to fetch" = the browser could not reach Supabase (network, VPN, ad blocker)
      const offline = updateError.name === 'AuthRetryableFetchError' || /fetch/i.test(updateError.message)
      return setError(offline
        ? 'Could not reach the login server. Check your connection (try mobile data, or turn off VPN / ad blockers) and press Save again.'
        : updateError.message)
    }
    clearAuthLinkType()
    navigate('/', { replace: true })
  }

  if (!ready) return null

  return (
    <div className="auth-page">
      <div className="auth-box">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true"><img src="favicon.svg" alt="JobSeeker logo" /></span>
          <h1>Set your password</h1>
          <p>{email ? `For ${email}` : 'Choose a password for your account'}</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-card">
          <div className="field">
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
            />
          </div>

          <div className="field">
            <label htmlFor="confirm-password">Confirm password</label>
            <input
              id="confirm-password"
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="input"
            />
          </div>

          {error && <p className="form-error">{error}</p>}

          <button type="submit" disabled={saving} className="btn primary block">
            {saving ? 'Saving…' : 'Save password'}
          </button>
        </form>
      </div>
    </div>
  )
}
