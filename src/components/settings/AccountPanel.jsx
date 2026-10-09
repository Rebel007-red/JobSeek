import { useId, useState } from 'react'
import { sessionUser } from '../../lib/session'
import { readAutoAdvance, readSwipeRightApplies, saveAutoAdvance, saveSwipeRightApplies } from '../../utils/viewPref'
import { SignOutButton } from './SignOutButton'

// One "On this device" checkbox: the box, then its label and help
function DeviceSetting({ checked, onChange, label, help }) {
  const id = useId()
  return (
    <div className="settings-check">
      <input id={id} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} aria-describedby={`${id}-help`} />
      <div>
        <label htmlFor={id}>{label}</label>
        <small id={`${id}-help`}>{help}</small>
      </div>
    </div>
  )
}

// Your account and the preferences kept on this device
export function AccountPanel() {
  const [autoAdvance, setAutoAdvance] = useState(readAutoAdvance)
  const [swipeRightApplies, setSwipeRightApplies] = useState(readSwipeRightApplies)
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
        <DeviceSetting
          checked={autoAdvance}
          onChange={on => {
            setAutoAdvance(on)
            saveAutoAdvance(on)
          }}
          label="Move to the next job after marking applied"
          help="After you mark a job applied (the a key, the check, the job panel or the “Did you apply?” question), the next job is selected, and opened when the job panel is open."
        />
        <DeviceSetting
          checked={swipeRightApplies}
          onChange={on => {
            setSwipeRightApplies(on)
            saveSwipeRightApplies(on)
          }}
          label="Swipe right marks applied"
          help="Off: swiping a job right in the Inbox saves it. On: it marks it applied, as before."
        />
      </div>
    </div>
  )
}
