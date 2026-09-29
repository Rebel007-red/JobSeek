import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { clearApiCache } from '../../lib/api'
import { GridIcon, KeyboardIcon, ListIcon, SearchIcon, SettingsIcon, SignOutIcon } from '../common/icons'

// metrics: node shown in the bar (on mobile only its trend bars stay visible, see CSS).
// onSearch: mobile-only toggle for the collapsed search box. The list/grid switch lives in Settings on mobile.
export function Header({ metrics = null, onSearch, searchOpen = false, view, onViewChange, onHelp }) {
  const navigate = useNavigate()
  // ProtectedRoute sends you to /login once the session is gone
  const signOut = () => {
    clearApiCache()
    supabase.auth.signOut()
  }

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><img src="favicon.svg" alt="JobSeeker logo" /></span>
          <span className="brand-name">JobSeeker</span>
        </div>

        <div className="topbar-center">{metrics}</div>

        <div className="topbar-actions">
          {onSearch && (
            <button
              type="button"
              onClick={onSearch}
              className={`icon-btn hide-desktop ${searchOpen ? 'is-on' : ''}`}
              title="Search"
              aria-label="Search"
              aria-pressed={searchOpen}
            >
              <SearchIcon />
            </button>
          )}
          {onViewChange && (
            <div className="segmented hide-mobile" role="group" aria-label="Layout">
              <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => onViewChange('list')} aria-pressed={view === 'list'} title="List view (v)">
                <ListIcon />
              </button>
              <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => onViewChange('grid')} aria-pressed={view === 'grid'} title="Grid view (v)">
                <GridIcon />
              </button>
            </div>
          )}
          {onHelp && (
            <button type="button" onClick={onHelp} className="icon-btn hide-mobile" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
              <KeyboardIcon />
            </button>
          )}
          <button type="button" onClick={() => navigate('/settings')} className="icon-btn" title="Settings" aria-label="Settings">
            <SettingsIcon />
          </button>
          <button type="button" onClick={signOut} className="icon-btn" title="Sign out" aria-label="Sign out">
            <SignOutIcon />
          </button>
        </div>
      </div>
    </header>
  )
}
