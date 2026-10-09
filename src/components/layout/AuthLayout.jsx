import { MIN_PASSWORD_LENGTH } from '../../utils/password'

// Logo, title and card area shared by the login and set-password pages.
export function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="auth-page">
      <div className="auth-box">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true"><img src="favicon.svg" alt="JobSeeker logo" /></span>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

// "New password" + "Confirm password" inputs; check them with passwordProblem() on submit.
export function NewPasswordFields({ passwordId, confirmId, password, confirm, onPasswordChange, onConfirmChange }) {
  return (
    <>
      <div className="field">
        <label htmlFor={passwordId}>New password</label>
        <input
          id={passwordId}
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          className="input"
        />
      </div>

      <div className="field">
        <label htmlFor={confirmId}>Confirm password</label>
        <input
          id={confirmId}
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => onConfirmChange(e.target.value)}
          className="input"
        />
      </div>
    </>
  )
}
