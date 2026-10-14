import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { EMPLOYMENT_LABELS, WORK_MODE_LABELS } from '../../utils/gold'
import { DEFAULT_FILTERS, PANEL_KEYS } from '../../utils/filters'
import { SOURCE_LABELS } from '../../utils/sources'
import { CloseIcon, FilterIcon } from './icons'

// The filter definitions moved to utils/filters.js (the URL state uses them too); re-exported for older imports
export { DEFAULT_FILTERS, EMPTY_FILTERS, FRESH_HOURS, PANEL_KEYS, POSTED_OPTIONS } from '../../utils/filters'

// keep in sync: the MOBILE query of DESIGN_SYSTEM.md ("Layout"); the panel is a bottom sheet there
const MOBILE_QUERY = '(max-width: 720px), (pointer: coarse) and (max-height: 500px), (pointer: coarse) and (max-width: 960px)'
const isSheet = () => Boolean(globalThis.matchMedia?.(MOBILE_QUERY).matches)
const reducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
// A downward drag this long on the handle or the header closes the sheet
const DRAG_CLOSE_PX = 60

const FIT_STEPS = ['', '50', '60', '70', '80']
const WORK_MODES = ['', 'remote', 'hybrid', 'onsite']
const YEARS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15]

// labels: value -> display text (source, work mode, employment); other facets show the value itself
function FacetSelect({ label, value, options, allLabel, onChange, labels }) {
  const id = useId()
  const text = (option) => labels?.[option] ?? option
  return (
    <div className="field-group">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {value && !options.some(option => option.value === value) && <option value={value}>{text(value)}</option>}
        {options.map(option => (
          <option key={option.value} value={option.value}>{text(option.value)} ({option.count})</option>
        ))}
      </select>
    </div>
  )
}

// One choice out of a few short ones, as buttons. A value that is not offered (from a link) shows as its own pressed
// segment, so the panel never hides a filter that is in use.
function Segmented({ label, value, values, text, onChange }) {
  const id = useId()
  const items = values.includes(value) ? values : [...values, value]
  return (
    <div className="field-group">
      <span className="filter-label" id={id}>{label}</span>
      <div className="filter-seg" role="group" aria-labelledby={id}>
        {items.map(item => (
          <button key={item || 'any'} type="button" aria-pressed={item === value} onClick={() => { if (item !== value) onChange(item) }}>
            {text(item)}
          </button>
        ))}
      </div>
    </div>
  )
}

// An on / off filter. disabled: the reason is the title and a hint line (phones have no hover)
function Toggle({ label, checked, onChange, disabled = false, reason }) {
  const hintId = useId()
  return (
    <div className="field-group filter-toggle-field">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled && reason ? hintId : undefined}
        title={disabled ? reason : undefined}
        className="filter-toggle"
        onClick={() => { if (!disabled) onChange(!checked) }}
      >
        <span>{label}</span>
        <span className="filter-switch" aria-hidden="true" />
      </button>
      {disabled && reason && <span className="filter-hint" id={hintId}>{reason}</span>}
    </div>
  )
}

// Backdrop + panel, rendered into <body>: inside the blurred bottom bar or the sticky toolbar a fixed element is
// positioned and stacked against that bar, so the backdrop would only cover the bar and taps would reach the list.
// On phones (a bottom sheet) a downward drag that starts on the handle or the header closes it.
function FilterDialog({ onClose, children, footer }) {
  const panelRef = useRef(null)
  const closeRef = useRef(null)
  const dragRef = useRef(null)
  const titleId = useId()
  useDialogFocus(panelRef, closeRef)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden' // the page behind must not scroll with the sheet
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const moveTo = (dy) => {
    const panel = panelRef.current
    if (!panel || reducedMotion()) return
    panel.style.transform = dy > 0 ? `translateY(${dy}px)` : ''
  }
  const onPointerDown = (e) => {
    // The close button keeps its own tap; a mouse drag on desktop does nothing
    if (!isSheet() || e.button > 0 || e.target.closest('button')) return
    dragRef.current = { id: e.pointerId, y: e.clientY, dy: 0 }
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId) // the drag goes on when the finger leaves the header
    } catch {
      // the pointer is already gone; the moves still arrive while it stays on the header
    }
  }
  const onPointerMove = (e) => {
    const drag = dragRef.current
    if (!drag || drag.id !== e.pointerId) return
    drag.dy = Math.max(0, e.clientY - drag.y)
    moveTo(drag.dy)
  }
  const onPointerEnd = (e) => {
    const drag = dragRef.current
    if (!drag || drag.id !== e.pointerId) return
    dragRef.current = null
    if (e.type === 'pointerup' && drag.dy >= DRAG_CLOSE_PX) onClose()
    else moveTo(0)
  }
  const drag = { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd }

  return createPortal(
    <>
      <div className="filter-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="filter-panel live-filters" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef}>
        <div className="filter-drag" {...drag}>
          <span className="filter-grip" aria-hidden="true" />
          <div className="filter-panel-header">
            <h3 id={titleId}>Filters</h3>
            <button ref={closeRef} type="button" onClick={onClose} className="icon-btn" aria-label="Close filters">
              <CloseIcon />
            </button>
          </div>
        </div>
        {children}
        {footer}
      </div>
    </>,
    document.body,
  )
}

const EMPTY_FACETS = { role: [], category: [], source: [], company: [], city: [], work_mode: [], employment: [] }

// "Show 12 jobs", "Show 1 job", "Show jobs" while the count is unknown
export function showJobsLabel(count) {
  if (count === null || count === undefined || !Number.isFinite(Number(count))) return 'Show jobs'
  return Number(count) === 1 ? 'Show 1 job' : `Show ${Number(count)} jobs`
}

// The filter panel. Live: every change calls onChange(nextFilters) at once and the page applies it, so the list and
// `count` (the tab's summary count, liveCount) update behind the panel; "Show N jobs" only closes it.
// variant 'nav' renders the trigger as a bottom-bar tab (mobile).
// open / onOpenChange make the panel controlled (the page keeps it in the URL, so Back closes it); without them it
// opens by itself. panel={false} renders only the trigger, for a second trigger of the same controlled panel.
// extra: a node shown at the top of the panel (phone landscape moves the stage chips and the freshness line there; CSS
// shows .filter-extra only in that layout). The time window is not here: it lives in the scope menu, and the sort
// lives in the toolbar (desktop) or the chip row's sort chip (phones).
// profile: why Has my skills / My cities are off, and which experience is yours. onReset: the page's Reset (it keeps
// the scope menu's choice).
export function SearchFilter({
  filters, facets = EMPTY_FACETS, onChange, variant = 'toolbar', open, onOpenChange, panel = true, extra = null,
  count = null, profile = null, onReset,
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const controlled = open !== undefined
  const isOpen = controlled ? open : ownOpen
  const setOpen = useCallback((next) => {
    if (controlled) onOpenChange?.(next)
    else setOwnOpen(next)
  }, [controlled, onOpenChange])
  const close = useCallback(() => setOpen(false), [setOpen])
  const ids = { location: useId(), years: useId() }

  const activeCount = PANEL_KEYS.filter(key => filters[key] && filters[key] !== DEFAULT_FILTERS[key]).length
    + (filters.matchedOnly ? 1 : 0) + (filters.myCities ? 1 : 0)
  // Reset shows while anything it would clear is set (the time window is the scope menu's, so it is left out)
  const resettable = Object.keys(DEFAULT_FILTERS)
    .some(key => key !== 'postedWithin' && (filters[key] || '') !== (DEFAULT_FILTERS[key] || ''))
  const options = (kind) => facets[kind] || []
  const set = (key, value) => {
    if (filters[key] !== value) onChange({ ...filters, [key]: value })
  }

  const skills = profile?.skills || []
  const cities = profile?.preferred_cities || []
  const myYears = profile?.max_years === null || profile?.max_years === undefined ? null : Number(profile.max_years)
  const workModes = options('work_mode').some(option => option.value === 'unknown') || filters.workMode === 'unknown'
    ? [...WORK_MODES, 'unknown'] : WORK_MODES
  const yearsText = (years) => `${years === 0 ? 'Fresher' : `${years} years`}${years === myYears ? ' (your profile)' : ''}`

  return (
    <div className={`filter-shell ${variant === 'nav' ? 'in-nav' : 'in-toolbar'}`}>
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        className={variant === 'nav' ? `nav-item ${isOpen || activeCount ? 'active' : ''}` : `filter-trigger ${isOpen || activeCount ? 'active' : ''}`}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        title="Filters (f)"
      >
        {variant === 'nav' ? (
          <strong><FilterIcon />{activeCount > 0 && <span className="filter-count">{activeCount}</span>}</strong>
        ) : (
          <FilterIcon />
        )}
        <span>Filters</span>
        {variant !== 'nav' && activeCount > 0 && <span className="filter-count">{activeCount}</span>}
      </button>

      {panel && isOpen && (
        <FilterDialog
          onClose={close}
          footer={(
            <div className="filter-panel-actions">
              {resettable && onReset && (
                <button type="button" className="text-button filter-reset" onClick={onReset}>Reset</button>
              )}
              <button type="button" className="primary-button" onClick={close}>{showJobsLabel(count)}</button>
            </div>
          )}
        >
          {/* extra scrolls with the groups: in phone landscape it would otherwise leave the groups no room */}
          <div className="filter-body">
            {extra && <div className="filter-extra">{extra}</div>}
            <section className="filter-group" aria-labelledby={`${ids.years}-fit`}>
              <h4 id={`${ids.years}-fit`}>Fit</h4>
              <Segmented
                label="Minimum fit"
                value={filters.minFit || ''}
                values={FIT_STEPS}
                text={value => (value ? `${value}+` : 'Any')}
                onChange={value => set('minFit', value)}
              />
              <Toggle
                label="Has my skills"
                checked={Boolean(filters.matchedOnly)}
                onChange={on => set('matchedOnly', on)}
                disabled={!filters.matchedOnly && skills.length === 0}
                reason="Add skills to your profile first"
              />
              <div className="field-group">
                <label htmlFor={ids.years}>Requires at most</label>
                <select id={ids.years} value={filters.maxYears} onChange={e => set('maxYears', e.target.value)}>
                  <option value="">Any experience</option>
                  {filters.maxYears && !YEARS.includes(Number(filters.maxYears)) && (
                    <option value={filters.maxYears}>{`${filters.maxYears} years`}</option>
                  )}
                  {YEARS.map(years => <option key={years} value={String(years)}>{yearsText(years)}</option>)}
                </select>
              </div>
            </section>

            <section className="filter-group" aria-labelledby={`${ids.years}-where`}>
              <h4 id={`${ids.years}-where`}>Where</h4>
              <FacetSelect label="City" value={filters.city} options={options('city')} allLabel="All cities" onChange={v => set('city', v)} />
              <Toggle
                label="My cities"
                checked={Boolean(filters.myCities)}
                onChange={on => set('myCities', on)}
                disabled={!filters.myCities && cities.length === 0}
                reason="Add preferred cities in Settings → Profile"
              />
              <Segmented
                label="Work mode"
                value={filters.workMode || ''}
                values={workModes}
                text={value => (value ? WORK_MODE_LABELS[value] ?? value : 'Any')}
                onChange={value => set('workMode', value)}
              />
              {/* "Location contains" gave way to City; a location from a link still shows here and can be cleared */}
              {filters.location && (
                <div className="field-group">
                  <label htmlFor={ids.location}>Location contains</label>
                  <input id={ids.location} type="text" value={filters.location} onChange={e => set('location', e.target.value)} />
                </div>
              )}
            </section>

            <section className="filter-group" aria-labelledby={`${ids.years}-what`}>
              <h4 id={`${ids.years}-what`}>What</h4>
              <div className="filter-grid">
                <FacetSelect label="Role" value={filters.role} options={options('role')} allLabel="All roles" onChange={v => set('role', v)} />
                <FacetSelect label="Category" value={filters.category} options={options('category')} allLabel="All categories" onChange={v => set('category', v)} />
                <FacetSelect label="Company" value={filters.company} options={options('company')} allLabel="All companies" onChange={v => set('company', v)} />
                <FacetSelect
                  label="Employment"
                  value={filters.employment}
                  options={options('employment')}
                  allLabel="Any employment"
                  labels={EMPLOYMENT_LABELS}
                  onChange={v => set('employment', v)}
                />
                <FacetSelect label="Source" value={filters.source} options={options('source')} allLabel="All sources" labels={SOURCE_LABELS} onChange={v => set('source', v)} />
              </div>
            </section>
          </div>
        </FilterDialog>
      )}
    </div>
  )
}
