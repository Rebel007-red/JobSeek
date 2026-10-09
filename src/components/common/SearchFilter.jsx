import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { EMPLOYMENT_LABELS, WORK_MODE_LABELS } from '../../utils/gold'
import { DEFAULT_FILTERS, PANEL_KEYS } from '../../utils/filters'
import { CloseIcon, FilterIcon } from './icons'

// The filter definitions moved to utils/filters.js (the URL state uses them too); re-exported for older imports
export { DEFAULT_FILTERS, EMPTY_FILTERS, FRESH_HOURS, PANEL_KEYS, POSTED_OPTIONS } from '../../utils/filters'

// labels: value -> display text (work mode, employment); other facets show the value itself
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

// Backdrop + panel, rendered into <body>: inside the blurred bottom bar or the sticky toolbar a fixed element is
// positioned and stacked against that bar, so the backdrop would only cover the bar and taps would reach the list.
function FilterDialog({ onClose, children }) {
  const panelRef = useRef(null)
  const closeRef = useRef(null)
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

  return createPortal(
    <>
      <div className="filter-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="filter-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef}>
        <div className="filter-panel-header">
          <h3 id={titleId}>Filter jobs</h3>
          <button ref={closeRef} type="button" onClick={onClose} className="icon-btn" aria-label="Close filters">
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </>,
    document.body,
  )
}

const EMPTY_FACETS = { role: [], category: [], source: [], company: [], city: [], work_mode: [], employment: [] }

// variant 'nav' renders the trigger as a bottom-bar tab (mobile). Pass sorts/sort/onSortChange to include sorting in
// the panel (shown on phones only; the toolbar has its own sort select).
// open / onOpenChange make the panel controlled (the page keeps it in the URL, so Back closes it); without them it
// opens by itself. panel={false} renders only the trigger, for a second trigger of the same controlled panel.
// extra: a node shown at the top of the panel (phone landscape moves the stage chips and the freshness line there; CSS
// shows .filter-extra only in that layout). The time window is not here: it lives in the scope menu.
export function SearchFilter({
  filters, facets = EMPTY_FACETS, onChange, variant = 'toolbar', sorts, sort, onSortChange, open, onOpenChange, panel = true, extra = null,
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const controlled = open !== undefined
  const isOpen = controlled ? open : ownOpen
  const setOpen = useCallback((next) => {
    if (controlled) onOpenChange?.(next)
    else setOwnOpen(next)
  }, [controlled, onOpenChange])
  const [draft, setDraft] = useState(filters)
  const [draftSort, setDraftSort] = useState(sort)
  const close = useCallback(() => setOpen(false), [setOpen])
  const ids = { sort: useId(), location: useId(), years: useId(), fit: useId() }

  // Every opening starts from the filters in use (also when the URL opened the panel)
  const [wasOpen, setWasOpen] = useState(isOpen)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) {
      setDraft(filters)
      setDraftSort(sort)
    }
  }

  const activeCount = PANEL_KEYS.filter(key => filters[key] && filters[key] !== DEFAULT_FILTERS[key]).length
  const set = (key, value) => setDraft(prev => ({ ...prev, [key]: value }))
  const options = (kind) => facets[kind] || []

  // Unchanged values don't call onChange, which would reload and re-render the whole list for nothing
  const commit = (values) => {
    if (PANEL_KEYS.some(key => values[key] !== filters[key])) onChange({ ...filters, ...values })
  }

  const apply = () => {
    commit(Object.fromEntries(PANEL_KEYS.map(key => [key, draft[key]])))
    if (sorts && draftSort !== sort) onSortChange(draftSort)
    close()
  }

  const clear = () => {
    commit(Object.fromEntries(PANEL_KEYS.map(key => [key, DEFAULT_FILTERS[key]])))
    close()
  }

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
        <FilterDialog onClose={close}>
          {extra && <div className="filter-extra">{extra}</div>}
          <div className="filter-grid">
            {sorts && (
              <div className="field-group hide-desktop">
                <label htmlFor={ids.sort}>Sort by</label>
                <select id={ids.sort} value={draftSort} onChange={e => setDraftSort(e.target.value)}>
                  {sorts.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            )}
            <FacetSelect label="Role" value={draft.role} options={options('role')} allLabel="All roles" onChange={v => set('role', v)} />
            <FacetSelect label="Category" value={draft.category} options={options('category')} allLabel="All categories" onChange={v => set('category', v)} />
            <FacetSelect label="Company" value={draft.company} options={options('company')} allLabel="All companies" onChange={v => set('company', v)} />
            <FacetSelect label="Source" value={draft.source} options={options('source')} allLabel="All sources" onChange={v => set('source', v)} />
            <FacetSelect label="City" value={draft.city} options={options('city')} allLabel="All cities" onChange={v => set('city', v)} />
            <FacetSelect
              label="Work mode"
              value={draft.workMode}
              options={options('work_mode')}
              allLabel="Any work mode"
              labels={WORK_MODE_LABELS}
              onChange={v => set('workMode', v)}
            />
            <FacetSelect
              label="Employment"
              value={draft.employment}
              options={options('employment')}
              allLabel="Any employment"
              labels={EMPLOYMENT_LABELS}
              onChange={v => set('employment', v)}
            />

            {/* "Location contains" gave way to City; a location from a link still shows here and can be cleared */}
            {draft.location && (
              <div className="field-group">
                <label htmlFor={ids.location}>Location contains</label>
                <input id={ids.location} type="text" value={draft.location} onChange={e => set('location', e.target.value)} />
              </div>
            )}

            <div className="field-group">
              <label htmlFor={ids.years}>Requires at most</label>
              <select id={ids.years} value={draft.maxYears} onChange={e => set('maxYears', e.target.value)}>
                <option value="">Any experience</option>
                {[0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15].map(years => (
                  <option key={years} value={String(years)}>{years === 0 ? 'Fresher' : `${years} years`}</option>
                ))}
              </select>
            </div>

            <div className="field-group">
              <label htmlFor={ids.fit}>Minimum fit: {draft.minFit ? `${draft.minFit}+` : 'any'}</label>
              <input
                id={ids.fit}
                type="range"
                min="0"
                max="90"
                step="10"
                value={draft.minFit || 0}
                onChange={e => set('minFit', e.target.value === '0' ? '' : e.target.value)}
                className="range-input"
              />
            </div>
          </div>

          <div className="filter-panel-actions">
            {activeCount > 0 && (
              <button type="button" className="secondary-button" onClick={clear}>Clear</button>
            )}
            <button type="button" className="primary-button" onClick={apply}>Apply</button>
          </div>
        </FilterDialog>
      )}
    </div>
  )
}
