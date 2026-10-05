import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clearAuthLinkType, supabase } from '../lib/supabase'
import { AuthLayout, NewPasswordFields } from '../components/layout/AuthLayout'
import { passwordProblem } from '../utils/password'

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
    <AuthLayout title="Set your password" subtitle={email ? `For ${email}` : 'Choose a password for your account'}>
      <form onSubmit={handleSubmit} className="auth-card">
        <NewPasswordFields
          passwordId="new-password"
          confirmId="confirm-password"
          password={password}
          confirm={confirm}
          onPasswordChange={setPassword}
          onConfirmChange={setConfirm}
        />

        {error && <p className="form-error">{error}</p>}

        <button type="submit" disabled={saving} className="btn primary block">
          {saving ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </AuthLayout>
  )
}
