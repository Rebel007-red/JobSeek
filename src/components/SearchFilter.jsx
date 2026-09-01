import { useEffect, useRef, useState } from 'react'

export function SearchFilter({ filters, companies, onChange }) {
  const { keyword, companyId, location, department } = filters
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const inputRef = useRef(null)

  const handle = (field) => (e) => onChange({ ...filters, [field]: e.target.value })

  function clear() {
    onChange({ keyword: '', companyId: '', location: '', department: '' })
    setFilterOpen(false)
  }

  const hasFilters = keyword || companyId || location || department
  const activeFilterCount = [companyId, location, department].filter(Boolean).length

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { setSearchOpen(false); setFilterOpen(false) }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Prevent body scroll when overlay open
  useEffect(() => {
    document.body.style.overflow = filterOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [filterOpen])

  const inputCls = 'w-full bg-gray-800 border border-gray-700 text-gray-100 placeholder:text-gray-500 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50'

  return (
    <>
      {/* -- DESKTOP: inline filters (sm and above) ------------------------- */}
      <div className="hidden sm:flex items-center gap-1.5">
        {/* Search icon / expanded input */}
        <div className={`flex items-center transition-all duration-200 ${searchOpen ? 'flex-1' : ''}`}>
          {searchOpen ? (
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
                onBlur={() => { if (!keyword) setSearchOpen(false) }}
                className="w-full pl-8 pr-3 py-1.5 bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-500 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          ) : (
            <button onClick={() => setSearchOpen(true)} title="Search jobs"
              className={`p-1.5 rounded-md transition-colors ${keyword ? 'text-indigo-400 bg-indigo-500/10' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          )}
        </div>

        {/* Company */}
        <select value={companyId} onChange={handle('companyId')} title="Filter by company"
          className={`py-1.5 px-2 text-[11px] rounded-md border transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
            companyId ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-300' : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'
          }`}>
          <option value="">Company</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        {/* Location */}
        <input type="text" placeholder="Location" value={location} onChange={handle('location')}
          className={`py-1.5 px-2 text-[11px] rounded-md border w-24 transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
            location ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-300 placeholder:text-indigo-400'
              : 'bg-gray-900 border-gray-700 text-gray-400 placeholder:text-gray-600 hover:border-gray-600'
          }`}
        />

        {/* Clear */}
        {hasFilters && (
          <button onClick={clear} title="Clear filters"
            className="flex items-center gap-1 px-1.5 py-1 text-[10px] font-bold text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-md transition-colors">
            <span className="bg-red-500/20 text-red-300 rounded-full w-4 h-4 flex items-center justify-center text-[9px]">
              {activeFilterCount + (keyword ? 1 : 0)}
            </span>
            ?
          </button>
        )}
      </div>

      {/* -- MOBILE: icon buttons only (below sm) --------------------------- */}
      <div className="flex sm:hidden items-center gap-0.5">
        {/* Search icon � expands to full-width input */}
        {searchOpen ? (
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none"
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              placeholder="Search..."
              value={keyword}
              onChange={handle('keyword')}
              onBlur={() => { if (!keyword) setSearchOpen(false) }}
              className="w-36 pl-8 pr-3 py-1.5 bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-500 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        ) : (
          <button onClick={() => setSearchOpen(true)} title="Search"
            className={`p-1.5 rounded-md transition-colors ${keyword ? 'text-indigo-400 bg-indigo-500/10' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
        )}

        {/* Filter icon */}
        <button onClick={() => setFilterOpen(true)} title="Filters"
          className={`relative p-1.5 rounded-md transition-colors ${
            activeFilterCount > 0 ? 'text-indigo-400 bg-indigo-500/10' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
          }`}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
          </svg>
          {activeFilterCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-indigo-500 text-white text-[8px] font-bold rounded-full flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {/* -- FULL-SCREEN FILTER OVERLAY (mobile) ---------------------------- */}
      {filterOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 sm:hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 h-14 border-b border-gray-800 shrink-0">
            <span className="text-sm font-semibold text-gray-100">Filters</span>
            <button onClick={() => setFilterOpen(false)}
              className="p-2 text-gray-400 hover:text-gray-200 rounded-md">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Filter fields */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">Company</label>
              <select value={companyId} onChange={handle('companyId')} className={inputCls}>
                <option value="">All Companies</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">Location</label>
              <input type="text" placeholder="e.g. Bangalore, Remote" value={location}
                onChange={handle('location')} className={inputCls} />
            </div>
          </div>

          {/* Footer */}
          <div className="shrink-0 px-4 py-4 border-t border-gray-800 flex gap-3">
            <button onClick={clear}
              className="flex-1 py-3 text-sm font-medium text-gray-400 border border-gray-700 rounded-xl hover:bg-gray-800 transition-colors">
              Reset
            </button>
            <button onClick={() => setFilterOpen(false)}
              className="flex-1 py-3 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-colors">
              Apply
            </button>
          </div>
        </div>
      )}
    </>
  )
}
