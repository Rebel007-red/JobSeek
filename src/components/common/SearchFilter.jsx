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
        className={`inline-flex items-center gap-2.5 px-4 py-2.5 text-sm font-semibold rounded-lg border transition-all duration-200 ${
          isOpen || hasActiveFilters
            ? 'bg-indigo-50 border-indigo-300 text-indigo-700 shadow-sm'
            : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
        }`}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
        </svg>
        <span>Filters</span>
        {hasActiveFilters && (
          <span className="ml-1 px-2 py-0.5 text-xs font-bold bg-indigo-600 text-white rounded-full">
            {[filters.keyword, filters.companyId, filters.location, filters.department].filter(Boolean).length}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-2 w-96 bg-white border border-gray-300 rounded-xl shadow-2xl p-6 z-50">
          
          {/* Header */}
          <div className="flex items-center justify-between mb-5 pb-4 border-b border-gray-200">
            <h3 className="text-lg font-bold text-gray-900">Filter Jobs</h3>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Keyword */}
          <div className="mb-5">
            <label className="block text-sm font-semibold text-gray-900 mb-2">
              Keyword
            </label>
            <input
              type="text"
              value={filters.keyword}
              onChange={e => handleChange('keyword', e.target.value)}
              placeholder="e.g., Python, Data, Engineering"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
            />
          </div>

          {/* Company */}
          <div className="mb-5">
            <label className="block text-sm font-semibold text-gray-900 mb-2">
              Company
            </label>
            <select
              value={filters.companyId}
              onChange={e => handleChange('companyId', e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors bg-white"
            >
              <option value="">All companies</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Location */}
          <div className="mb-5">
            <label className="block text-sm font-semibold text-gray-900 mb-2">
              Location
            </label>
            <input
              type="text"
              value={filters.location}
              onChange={e => handleChange('location', e.target.value)}
              placeholder="e.g., India, Remote, Bangalore"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
            />
          </div>

          {/* Department */}
          <div className="mb-6">
            <label className="block text-sm font-semibold text-gray-900 mb-2">
              Department
            </label>
            <input
              type="text"
              value={filters.department}
              onChange={e => handleChange('department', e.target.value)}
              placeholder="e.g., Engineering, Product"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
            />
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 pt-4 border-t border-gray-200">
            {hasActiveFilters && (
              <button
                onClick={() => {
                  onChange({ keyword: '', companyId: '', location: '', department: '' })
                }}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setIsOpen(false)}
              className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition-all shadow-sm hover:shadow-md"
            >
              Apply Filters
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
