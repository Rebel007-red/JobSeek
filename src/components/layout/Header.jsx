import { useNavigate } from 'react-router-dom'
import { CheckSquareIcon, GearIcon, GridIcon, KeyboardIcon, ListIcon, SearchIcon } from '../common/icons'

// metrics: node shown in the bar (on mobile only its trend bars stay visible, see CSS).
// onSearch: mobile-only toggle for the collapsed search box. The list/grid switch lives in Settings on mobile.
// onSelectMode: turns bulk selection on and off (phones have no hover checkboxes or Space key). Sign out lives in
// Settings.
export function Header({ metrics = null, onSearch, searchOpen = false, view, onViewChange, onHelp, onSelectMode, selectMode = false }) {
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
              <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => onViewChange('grid')} aria-pressed={view === 'grid'} title="Grid view (v)" aria-label="Grid view">
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
