import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function SearchFilter({ filters, companies, onChange }) {
  const { keyword, companyId, location } = filters
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const inputRef = useRef(null)
  const filterBtnRef = useRef(null)
  const popoverRef = useRef(null)

  const handle = (field) => (e) => onChange({ ...filters, [field]: e.target.value })

  function clear() {
    onChange({ ...filters, companyId: '', location: '', department: '' })
  }

  const activeFilterCount = [companyId, location, filters.department].filter(Boolean).length
  const hasKeyword = !!keyword

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])

  // Close on Escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { setSearchOpen(false); setFilterOpen(false) }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Close popover on outside tap
  useEffect(() => {
    if (!filterOpen) return
    const handler = (e) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target) &&
        filterBtnRef.current && !filterBtnRef.current.contains(e.target)
      ) {
        setFilterOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [filterOpen])

  // Get popover position below the filter button
  function getPopoverStyle() {
    if (!filterBtnRef.current) return {}
    const rect = filterBtnRef.current.getBoundingClientRect()
    return {
      position: 'fixed',
      top: rect.bottom + 6,
      right: window.innerWidth - rect.right,
      zIndex: 200,
      width: Math.min(280, window.innerWidth - 16),
    }
  }

  const inputCls = 'w-full bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-500 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500'

  return (
    <>
      {/* DESKTOP: inline filters (sm+) */}
      <div className="hidden sm:flex items-center gap-1.5">
        <div className={`flex items-center transition-all duration-200 ${searchOpen ? 'flex-1' : ''}`}>
          {searchOpen ? (
            <div className="relative flex-1">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input ref={inputRef} type="text" placeholder="Search jobs..." value={keyword}
                onChange={handle('keyword')} onBlur={() => { if (!keyword) setSearchOpen(false) }}
                className="w-full pl-8 pr-3 py-1.5 bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-500 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500" />
            </div>
          ) : (
            <button onClick={() => setSearchOpen(true)} title="Search"
              className={`p-1.5 rounded-md transition-colors ${keyword ? 'text-indigo-400 bg-indigo-500/10' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          )}
        </div>
        <select value={companyId} onChange={handle('companyId')}
          className={`py-1.5 px-2 text-[11px] rounded-md border transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500 ${companyId ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-300' : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'}`}>
          <option value="">Company</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="text" placeholder="Location" value={location} onChange={handle('location')}
          className={`py-1.5 px-2 text-[11px] rounded-md border w-24 transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500 ${location ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-300 placeholder:text-indigo-400' : 'bg-gray-900 border-gray-700 text-gray-400 placeholder:text-gray-600 hover:border-gray-600'}`}
        />
        {(hasKeyword || activeFilterCount > 0) && (
          <button onClick={() => onChange({ keyword: '', companyId: '', location: '', department: '' })}
            className="flex items-center gap-1 px-1.5 py-1 text-[10px] font-bold text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-md transition-colors">
            <span className="bg-red-500/20 text-red-300 rounded-full w-4 h-4 flex items-center justify-center text-[9px]">
              {activeFilterCount + (hasKeyword ? 1 : 0)}
            </span>
            x
          </button>
        )}
      </div>

      {/* MOBILE: compact icons (below sm) */}
      <div className="flex sm:hidden items-center gap-0.5">
        {searchOpen ? (
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input ref={inputRef} type="text" placeholder="Search..." value={keyword}
              onChange={handle('keyword')} onBlur={() => { if (!keyword) setSearchOpen(false) }}
              className="w-36 pl-8 pr-3 py-1.5 bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-500 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500" />
          </div>
        ) : (
          <button onClick={() => setSearchOpen(true)} title="Search"
            className={`p-1.5 rounded-md transition-colors ${keyword ? 'text-indigo-400 bg-indigo-500/10' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
        )}

        {/* Filter icon — toggles popover */}
        <button ref={filterBtnRef} onClick={() => setFilterOpen(v => !v)} title="Filters"
          className={`relative p-1.5 rounded-md transition-colors ${activeFilterCount > 0 ? 'text-indigo-400 bg-indigo-500/10' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}>
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

      {/* MOBILE FILTER POPOVER — portaled to body, positioned below filter button */}
      {filterOpen && createPortal(
        <div ref={popoverRef} style={getPopoverStyle()}
          className="bg-gray-900 border border-gray-700/80 rounded-xl shadow-2xl p-4 flex flex-col gap-3">

          {/* Company */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Company</label>
            <select value={companyId} onChange={handle('companyId')} className={inputCls}>
              <option value="">All Companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {/* Location */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Location</label>
            <input type="text" placeholder="e.g. Bangalore, Remote"
              value={location} onChange={handle('location')} className={inputCls} />
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button onClick={() => { clear(); setFilterOpen(false) }}
              className="flex-1 py-2 text-xs font-medium text-gray-400 border border-gray-700 rounded-lg hover:bg-gray-800 transition-colors">
              Reset
            </button>
            <button onClick={() => setFilterOpen(false)}
              className="flex-1 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors">
              Apply
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
