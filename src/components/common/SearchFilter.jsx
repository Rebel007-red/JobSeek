import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { CloseIcon, FilterIcon } from './icons'

export const EMPTY_FILTERS = {
  q: '',
  role: '',
  category: '',
  source: '',
  company: '',
  location: '',
  maxYears: '',
  postedWithin: '',
  minFit: '',
  matchedOnly: false,
}

// What the dashboard starts with: only jobs from the last 24 hours (older ones are hidden until you widen it).
export const FRESH_HOURS = '24'
export const DEFAULT_FILTERS = { ...EMPTY_FILTERS, postedWithin: FRESH_HOURS }

// Filters edited in the panel (search box and quick chips live on the page).
export const PANEL_KEYS = ['role', 'category', 'source', 'company', 'location', 'maxYears', 'postedWithin', 'minFit']

// Hours. The pipeline removes never-applied jobs posted more than 2 days ago, so longer windows only add applied jobs.
export const POSTED_OPTIONS = [
  { value: '24', label: 'Last 24 hours' },
  { value: '48', label: 'Last 2 days' },
]

function FacetSelect({ label, value, options, allLabel, onChange }) {
  return (
    <div className="field-group">
      <label>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {value && !options.some(option => option.value === value) && <option value={value}>{value}</option>}
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.value} ({option.count})</option>
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
      <div className="filter-panel" role="dialog" aria-modal="true" aria-label="Filter jobs" ref={panelRef}>
        <div className="filter-panel-header">
          <h3>Filter jobs</h3>
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

// variant 'nav' renders the trigger as a bottom-bar tab (mobile). Pass sorts/sort/onSortChange to include sorting in the panel.
export function SearchFilter({ filters, facets, onChange, variant = 'toolbar', sorts, sort, onSortChange }) {
  const [isOpen, setIsOpen] = useState(false)
  const [draft, setDraft] = useState(filters)
  const [draftSort, setDraftSort] = useState(sort)
  const close = useCallback(() => setIsOpen(false), [])

  // The default 24h window is not counted as an active filter
  const activeCount = PANEL_KEYS.filter(key => filters[key] && filters[key] !== DEFAULT_FILTERS[key]).length
  const set = (key, value) => setDraft(prev => ({ ...prev, [key]: value }))

  const toggle = () => {
    if (!isOpen) {
      setDraft(filters)
      setDraftSort(sort)
    }
    setIsOpen(open => !open)
  }

  // Unchanged values don't call onChange, which would reload and re-render the whole list for nothing
  const commit = (values) => {
    if (PANEL_KEYS.some(key => values[key] !== filters[key])) onChange({ ...filters, ...values })
  }

  const apply = () => {
    commit(Object.fromEntries(PANEL_KEYS.map(key => [key, draft[key]])))
    if (sorts && draftSort !== sort) onSortChange(draftSort)
    setIsOpen(false)
  }

  const clear = () => {
    commit(Object.fromEntries(PANEL_KEYS.map(key => [key, DEFAULT_FILTERS[key]])))
    setIsOpen(false)
  }

  return (
    <div className={`filter-shell ${variant === 'nav' ? 'in-nav' : 'in-toolbar'}`}>
      <button
        type="button"
        onClick={toggle}
        className={variant === 'nav' ? `nav-item ${isOpen || activeCount ? 'active' : ''}` : `filter-trigger ${isOpen || activeCount ? 'active' : ''}`}
        aria-expanded={isOpen}
      >
        {variant === 'nav' ? (
          <strong><FilterIcon />{activeCount > 0 && <span className="filter-count">{activeCount}</span>}</strong>
        ) : (
          <FilterIcon />
        )}
        <span>Filters</span>
        {variant !== 'nav' && activeCount > 0 && <span className="filter-count">{activeCount}</span>}
      </button>

      {isOpen && (
        <FilterDialog onClose={close}>
          <div className="filter-grid">
            {sorts && (
              <div className="field-group">
                <label>Sort by</label>
                <select value={draftSort} onChange={e => setDraftSort(e.target.value)}>
                  {sorts.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            )}
            <FacetSelect label="Role" value={draft.role} options={facets.role} allLabel="All roles" onChange={v => set('role', v)} />
            <FacetSelect label="Category" value={draft.category} options={facets.category} allLabel="All categories" onChange={v => set('category', v)} />
            <FacetSelect label="Company" value={draft.company} options={facets.company} allLabel="All companies" onChange={v => set('company', v)} />
            <FacetSelect label="Source" value={draft.source} options={facets.source} allLabel="All sources" onChange={v => set('source', v)} />

            <div className="field-group">
              <label>Location contains</label>
              <input type="text" value={draft.location} onChange={e => set('location', e.target.value)} placeholder="Bengaluru, Hyderabad…" />
            </div>

            <div className="field-group">
              <label>Posted</label>
              <select value={draft.postedWithin} onChange={e => set('postedWithin', e.target.value)}>
                <option value="">Any time</option>
                {POSTED_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>

            <div className="field-group">
              <label>Requires at most</label>
              <select value={draft.maxYears} onChange={e => set('maxYears', e.target.value)}>
                <option value="">Any experience</option>
                {[0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15].map(years => (
                  <option key={years} value={String(years)}>{years === 0 ? 'Fresher' : `${years} years`}</option>
                ))}
              </select>
            </div>

            <div className="field-group">
              <label>Minimum fit: {draft.minFit ? `${draft.minFit}+` : 'any'}</label>
              <input
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
