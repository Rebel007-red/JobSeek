import { useEffect, useRef, useState } from 'react'

export function SearchFilter({ filters, companies, onChange }) {
  const { keyword, companyId, location, department } = filters
  const [open, setOpen] = useState(false)
  const inputRef = useRef(null)

  const handle = (field) => (e) => onChange({ ...filters, [field]: e.target.value })

  function clear() {
    onChange({ keyword: '', companyId: '', location: '', department: '' })
  }

  const hasFilters = keyword || companyId || location || department
  const activeCount = [keyword, companyId, location, department].filter(Boolean).length

  // Auto-focus when search expands
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const inputCls = 'w-full bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-500 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500'

  return (
    <>
      {/* Header search row — always visible */}
      <div className="flex items-center gap-1.5">
        {/* Search icon / expanded input */}
        <div className={`flex items-center transition-all duration-200 ${open ? 'flex-1' : ''}`}>
          {open ? (
            <div className="relative flex-1">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                placeholder="Search jobs..."
                value={keyword}
                onChange={handle('keyword')}
                onBlur={() => { if (!keyword) setOpen(false) }}
                className="w-full pl-8 pr-3 py-1.5 bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-500 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          ) : (
            <button
              onClick={() => setOpen(true)}
              title="Search jobs"
              className={`flex items-center justify-center p-1.5 rounded-md transition-colors ${
                keyword ? 'text-indigo-400 bg-indigo-500/10' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          )}
        </div>

        {/* Company filter */}
        <select
          value={companyId}
          onChange={handle('companyId')}
          title="Filter by company"
          className={`py-1.5 px-2 text-[11px] rounded-md border transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
            companyId
              ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-300'
              : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'
          }`}
        >
          <option value="">Company</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        {/* Location filter */}
        <input
          type="text"
          placeholder="Location"
          value={location}
          onChange={handle('location')}
          className={`hidden sm:block py-1.5 px-2 text-[11px] rounded-md border w-24 transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
            location
              ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-300 placeholder:text-indigo-400'
              : 'bg-gray-900 border-gray-700 text-gray-400 placeholder:text-gray-600 hover:border-gray-600'
          }`}
        />

        {/* Active filter count badge + clear */}
        {hasFilters && (
          <button
            onClick={clear}
            title="Clear all filters"
            className="flex items-center gap-1 px-1.5 py-1 text-[10px] font-bold text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-md transition-colors whitespace-nowrap"
          >
            <span className="bg-red-500/20 text-red-300 rounded-full w-4 h-4 flex items-center justify-center text-[9px]">
              {activeCount}
            </span>
            ✕
          </button>
        )}
      </div>
    </>
  )
}
