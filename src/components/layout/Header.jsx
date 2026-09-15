import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2.75l1.8 5.45L19.25 10l-5.45 1.8-1.8 5.45-1.8-5.45L4.75 10l5.45-1.8L12 2.75zm7 13.5l.72 2.18L22 18.97l-2.28.54L19 21.7l-.72-2.19L16 18.97l2.28-.54L19 16.25zm-14 0l.72 2.18L8 18.97l-2.28.54L5 21.7l-.72-2.19L2 18.97l2.28-.54L5 16.25z" fill="currentColor" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.18l-2.39.96a7.18 7.18 0 00-1.63-.94L14.5 2.8a.5.5 0 00-.5-.34h-3.99a.5.5 0 00-.5.34l-.34 2.46c-.58.24-1.12.57-1.63.94l-2.39-.96a.5.5 0 00-.61.18L2.71 8.84a.5.5 0 00.12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.52a.5.5 0 00-.12.64l1.92 3.32c.13.22.39.31.61.18l2.39-.96c.51.37 1.05.7 1.63.94l.34 2.46c.05.19.25.34.5.34h3.99c.25 0 .45-.15.5-.34l.34-2.46c.58-.24 1.12-.57 1.63-.94l2.39.96c.22.13.48.04.61-.18l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8a3.5 3.5 0 010 7.5z" fill="currentColor" />
    </svg>
  )
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10 17l5-5-5-5v3H3v4h7v3zm9-11h-7v2h7v10h-7v2h7a2 2 0 002-2V8a2 2 0 00-2-2z" fill="currentColor" />
    </svg>
  )
}

export function Header({ stats = {}, onSkillsToggle, skillsActive, userSkills }) {
  const navigate = useNavigate()
  const { signOut } = useAuth()

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand-wrap">
          <div className="brand-mark">J</div>
          <div>
            <p className="brand-kicker">Workspace</p>
            <h1>JobSeeker</h1>
          </div>
        </div>

        {stats.total > 0 && (
          <div className="topbar-stats">
            <div className="mini-stat">
              <span>Total</span>
              <strong>{stats.total}</strong>
            </div>
            {stats.new > 0 && (
              <div className="mini-stat success">
                <span>New</span>
                <strong>{stats.new}</strong>
              </div>
            )}
            {stats.matched > 0 && userSkills.length > 0 && (
              <div className="mini-stat accent">
                <span>Match</span>
                <strong>{stats.matched}</strong>
              </div>
            )}
          </div>
        )}

        <div className="topbar-actions">
          {userSkills.length > 0 && (
            <button
              type="button"
              onClick={onSkillsToggle}
              className={`icon-button ${skillsActive ? 'active' : ''}`}
              title="Toggle skill filter"
              aria-label="Toggle skill filter"
            >
              <SparkIcon />
            </button>
          )}

          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="icon-button"
            title="Settings"
            aria-label="Settings"
          >
            <SettingsIcon />
          </button>

          <button
            type="button"
            onClick={signOut}
            className="icon-button"
            title="Sign out"
            aria-label="Sign out"
          >
            <SignOutIcon />
          </button>
        </div>
      </div>
    </header>
  )
}
