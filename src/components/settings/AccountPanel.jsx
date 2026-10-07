import { useId, useState } from 'react'
import { sessionUser } from '../../lib/session'
import { readAutoAdvance, saveAutoAdvance } from '../../utils/viewPref'
import { SignOutButton } from './SignOutButton'

// Your account and the preferences kept on this device
export function AccountPanel() {
  const [autoAdvance, setAutoAdvance] = useState(readAutoAdvance)
  const autoAdvanceId = useId()
  const user = sessionUser()

  return (
    <div className="settings-panel settings-panel-animate">
      <div className="settings-card">
        <div className="settings-card-header">
          <h3>Account</h3>
          {user?.isAdmin && <span className="settings-chip">admin</span>}
        </div>
        <p className="settings-copy">Signed in as <strong>{user?.email || 'unknown'}</strong>.</p>
        <div className="settings-actions-row account-actions">
          <SignOutButton />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-header">
          <h3>On this device</h3>
        </div>
        <div className="settings-check">
          <input
            id={autoAdvanceId}
            type="checkbox"
            checked={autoAdvance}
            onChange={e => {
              setAutoAdvance(e.target.checked)
              saveAutoAdvance(e.target.checked)
            }}
            aria-describedby={`${autoAdvanceId}-help`}
          />
          <div>
            <label htmlFor={autoAdvanceId}>Move to the next job after marking applied</label>
            <small id={`${autoAdvanceId}-help`}>
              After you mark a job applied (a key, the button, the job panel or the “Applied to …?” question), the next job
              is selected, and opened when the job panel is open.
            </small>
          </div>
        </div>
      </div>
    </div>
  )
}
