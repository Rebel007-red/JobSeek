import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { authLinkError, supabase } from '../lib/supabase'
import { AuthLayout, NewPasswordFields } from '../components/layout/AuthLayout'
import { passwordProblem } from '../utils/password'

// Supabase sends a 6-10 digit code (length is a project setting)
const CODE_RE = /^\d{6,10}$/

// Where to go after signing in: the page that sent you here (location.state.from, e.g. a shared /?job=<key> link),
// when it is a path inside this app, else the jobs page
function returnPath(from) {
  const path = typeof from === 'string' ? from : ''
  return path.startsWith('/') && !path.startsWith('//') && !/^\/(login|set-password)\b/.test(path) ? path : '/'
}

// mode: 'signin' | 'reset' (ask for a code) | 'code' (enter code + new password)
export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const returnTo = returnPath(location.state?.from)
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(authLinkError ? `${authLinkError}. Use "Forgot password" to get a code instead.` : '')
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)

  const switchMode = (next) => {
    setMode(next)
    setError('')
    setInfo('')
  }

  async function handleSignIn(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setLoading(false)
    if (!authError) return navigate(returnTo, { replace: true })
    // Invited users whose password was never saved land here too; the reset flow sets it.
    setError(authError.code === 'invalid_credentials'
      ? 'Wrong email or password. New here, or never finished setting a password? Use "Forgot password?" below.'
      : authError.message)
  }

  async function handleSendCode(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error: sendError } = await supabase.auth.resetPasswordForEmail(email.trim())
    setLoading(false)
    if (sendError) return setError(sendError.message)
    setMode('code')
    setInfo(`If an account exists for ${email.trim()}, a code is on its way. It expires in 1 hour.`)
  }

  async function handleReset(e) {
    e.preventDefault()
    const token = code.trim()
    if (!CODE_RE.test(token)) return setError('Enter the numeric code from the email')
    const problem = passwordProblem(newPassword, confirm)
    if (problem) return setError(problem)
    setError('')
    setLoading(true)
    const { error: verifyError } = await supabase.auth.verifyOtp({ email: email.trim(), token, type: 'recovery' })
    if (verifyError) {
      setLoading(false)
      return setError(verifyError.message)
    }
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })
    setLoading(false)
    if (updateError) return setError(updateError.message)
    navigate(returnTo, { replace: true })
  }

  const emailField = (
    <div className="field">
      <label htmlFor="login-email">Email</label>
      <input
        id="login-email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="input"
        readOnly={mode === 'code'}
      />
    </div>
  )

  return (
    <AuthLayout title="JobSeeker" subtitle={mode === 'signin' ? 'Invite only · Sign in to your job inbox' : 'Reset your password'}>
      {mode === 'signin' && (
        <form onSubmit={handleSignIn} className="auth-card">
          {emailField}

          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="input"
            />
          </div>

          {error && <p className="form-error">{error}</p>}

          <button type="submit" disabled={loading} className="btn primary block">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <button type="button" className="text-button" onClick={() => switchMode('reset')}>Forgot password?</button>
        </form>
      )}

      {mode === 'reset' && (
        <form onSubmit={handleSendCode} className="auth-card">
          {emailField}
          {error && <p className="form-error">{error}</p>}
          <button type="submit" disabled={loading} className="btn primary block">
            {loading ? 'Sending…' : 'Email me a code'}
          </button>
          <button type="button" className="text-button" onClick={() => switchMode('signin')}>Back to sign in</button>
        </form>
      )}

      {mode === 'code' && (
        <form onSubmit={handleReset} className="auth-card">
          {emailField}
          {info && <p className="form-info">{info}</p>}

          <div className="field">
            <label htmlFor="reset-code">Code</label>
            <input
              id="reset-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={10}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="input"
            />
          </div>

          <NewPasswordFields
            passwordId="reset-password"
            confirmId="reset-confirm"
            password={newPassword}
            confirm={confirm}
            onPasswordChange={setNewPassword}
            onConfirmChange={setConfirm}
          />

          {error && <p className="form-error">{error}</p>}

          <button type="submit" disabled={loading} className="btn primary block">
            {loading ? 'Saving…' : 'Set new password'}
          </button>
          <button type="button" className="text-button" onClick={() => switchMode('reset')}>Send a new code</button>
        </form>
      )}
    </AuthLayout>
  )
}
