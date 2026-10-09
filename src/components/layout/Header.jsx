import { useNavigate } from 'react-router-dom'
import { CheckSquareIcon, GearIcon, GridIcon, KeyboardIcon, ListIcon } from '../common/icons'

// metrics: node shown in the bar (on mobile only its trend bars stay visible, see CSS).
// Search lives in the bottom bar on phones (JobsPage). The List / Cards switch lives in Settings on mobile.
// onSelectMode: turns bulk selection on and off (phones have no hover checkboxes or Space key). Sign out lives in
// Settings.
export function Header({ metrics = null, view, onViewChange, onHelp, onSelectMode, selectMode = false }) {
  const navigate = useNavigate()

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><img src="favicon.svg" alt="JobSeeker logo" /></span>
          <span className="brand-name">JobSeeker</span>
        </div>

        <div className="topbar-center">{metrics}</div>

        <div className="topbar-actions">
          {onSelectMode && (
            <button
              type="button"
              onClick={onSelectMode}
              className={`icon-btn ${selectMode ? 'is-on' : ''}`}
              title={selectMode ? 'Stop selecting' : 'Select jobs (Space)'}
              aria-label="Select jobs"
              aria-pressed={selectMode}
            >
              <CheckSquareIcon />
            </button>
          )}
          {onViewChange && (
            <div className="segmented hide-mobile" role="group" aria-label="Layout">
              <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => onViewChange('list')} aria-pressed={view === 'list'} title="List view (v)" aria-label="List view">
                <ListIcon />
              </button>
              <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => onViewChange('grid')} aria-pressed={view === 'grid'} title="Cards view (v)" aria-label="Cards view">
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
            <GearIcon />
          </button>
        </div>
      </div>
    </header>
  )
}
