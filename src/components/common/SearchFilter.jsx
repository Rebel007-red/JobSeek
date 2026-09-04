import { useState } from 'react'

export function SearchFilter({ filters, companies, onChange }) {
  const [isOpen, setIsOpen] = useState(false)

  const handleChange = (key, value) => {
    onChange({ ...filters, [key]: value })
  }

  const hasActiveFilters = filters.keyword || filters.companyId || filters.location || filters.department

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded border transition-all duration-200 ${
          isOpen || hasActiveFilters
            ? 'bg-indigo-900/40 border-indigo-600 text-indigo-300 shadow-sm'
            : 'bg-slate-800/50 border-slate-700 text-slate-300 hover:bg-slate-700/50'
        }`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
        </svg>
        <span>Filters</span>
        {hasActiveFilters && (
          <span className="ml-1 px-1.5 py-0 text-xs font-bold bg-indigo-600 text-white rounded-full">
            {[filters.keyword, filters.companyId, filters.location, filters.department].filter(Boolean).length}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-2 w-80 bg-slate-800 border border-slate-700 rounded-lg shadow-2xl p-4 z-50">
          
          {/* Header */}
          <div className="flex items-center justify-between mb-3 pb-3 border-b border-slate-700">
            <h3 className="text-sm font-bold text-slate-100">Filter</h3>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1 text-slate-600 hover:text-slate-400 hover:bg-slate-700 rounded transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Keyword */}
          <div className="mb-2.5">
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Keyword
            </label>
            <input
              type="text"
              value={filters.keyword}
              onChange={e => handleChange('keyword', e.target.value)}
              placeholder="e.g., Python, Data"
              className="w-full px-3 py-1.5 border border-slate-600 bg-slate-900 text-slate-100 placeholder:text-slate-600 rounded text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
            />
          </div>

          {/* Company */}
          <div className="mb-2.5">
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Company
            </label>
            <select
              value={filters.companyId}
              onChange={e => handleChange('companyId', e.target.value)}
              className="w-full px-3 py-1.5 border border-slate-600 bg-slate-900 text-slate-100 placeholder:text-slate-600 rounded text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
            >
              <option value="">All</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Location */}
          <div className="mb-2.5">
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Location
            </label>
            <input
              type="text"
              value={filters.location}
              onChange={e => handleChange('location', e.target.value)}
              placeholder="e.g., Remote, India"
              className="w-full px-3 py-1.5 border border-slate-600 bg-slate-900 text-slate-100 placeholder:text-slate-600 rounded text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
            />
          </div>

          {/* Department */}
          <div className="mb-3">
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Department
            </label>
            <input
              type="text"
              value={filters.department}
              onChange={e => handleChange('department', e.target.value)}
              placeholder="e.g., Engineering"
              className="w-full px-3 py-1.5 border border-slate-600 bg-slate-900 text-slate-100 placeholder:text-slate-600 rounded text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
            />
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2 pt-3 border-t border-slate-700">
            {hasActiveFilters && (
              <button
                onClick={() => {
                  onChange({ keyword: '', companyId: '', location: '', department: '' })
                }}
                className="flex-1 px-3 py-1.5 text-xs font-semibold text-slate-300 bg-slate-700/50 hover:bg-slate-600/50 rounded transition-colors"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setIsOpen(false)}
              className="flex-1 px-3 py-1.5 text-xs font-semibold text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded transition-all shadow-sm hover:shadow-md"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
