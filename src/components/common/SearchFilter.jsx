import { useState } from 'react'

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function SearchFilter({ filters, companies, onChange }) {
  const [isOpen, setIsOpen] = useState(false)

  const handleChange = (key, value) => {
    onChange({ ...filters, [key]: value })
  }

  const hasActiveFilters = filters.keyword || filters.companyId || filters.location || filters.department

  return (
    <div className="filter-shell">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`filter-trigger ${isOpen || hasActiveFilters ? 'active' : ''}`}
      >
        <span className="filter-icon"><SearchIcon /></span>
        <span>Filters</span>
        {hasActiveFilters && (
          <span className="filter-count">
            {[filters.keyword, filters.companyId, filters.location, filters.department].filter(Boolean).length}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="filter-panel">
          <div className="filter-panel-header">
            <h3>Filter roles</h3>
            <button type="button" onClick={() => setIsOpen(false)} className="close-button" aria-label="Close filters">
              <CloseIcon />
            </button>
          </div>

          <div className="field-group">
            <label>Keyword</label>
            <input
              type="text"
              value={filters.keyword}
              onChange={e => handleChange('keyword', e.target.value)}
              placeholder="Python, Data, Analytics"
            />
          </div>

          <div className="field-group">
            <label>Company</label>
            <select value={filters.companyId} onChange={e => handleChange('companyId', e.target.value)}>
              <option value="">All companies</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label>Location</label>
            <input
              type="text"
              value={filters.location}
              onChange={e => handleChange('location', e.target.value)}
              placeholder="Remote, India, Bengaluru"
            />
          </div>

          <div className="field-group">
            <label>Department</label>
            <input
              type="text"
              value={filters.department}
              onChange={e => handleChange('department', e.target.value)}
              placeholder="Engineering, Product"
            />
          </div>

          <div className="filter-panel-actions">
            {hasActiveFilters && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  onChange({ keyword: '', companyId: '', location: '', department: '' })
                }}
              >
                Clear
              </button>
            )}
            <button type="button" className="primary-button" onClick={() => setIsOpen(false)}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
