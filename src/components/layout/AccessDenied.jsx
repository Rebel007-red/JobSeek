import { clearApiCache, signOut } from '../../lib/api'
import { AuthLayout } from './AuthLayout'

// The whole page for a signed-in account that is not on the allow list (app.require_allowed, 42501 "not allowed to use
// the job data"), shown by ProtectedRoute instead of the page. Try again drops the cached results and reloads, so an
// email added in the meantime gets in.
export function AccessDenied({ email }) {
  const tryAgain = () => {
    clearApiCache()
    window.location.reload()
  }

  return (
    <AuthLayout title="No access yet" subtitle={null}>
      <div className="auth-card access-denied" role="alert">
        <p>
          Signed in as <strong>{email || 'unknown'}</strong>, but this email doesn&rsquo;t have access yet. Ask the person
          who invited you.
        </p>
        <div className="access-denied-actions">
          <button type="button" className="btn" onClick={signOut}>Sign out</button>
          <button type="button" className="btn primary" onClick={tryAgain} autoFocus>Try again</button>
        </div>
      </div>
    </AuthLayout>
  )
}
