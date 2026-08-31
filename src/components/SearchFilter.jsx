export function SearchFilter({ filters, companies, onChange }) {
  const { keyword, companyId, location, department } = filters

  const handle = (field) => (e) => onChange({ ...filters, [field]: e.target.value })

  function clear() {
    onChange({ ...filters, keyword: '', companyId: '', location: '', department: '' })
  }

  const hasFilters = keyword || companyId || location || department
  const inputCls = 'flex-1 min-w-[100px] bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-600 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500'

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex flex-col gap-2">
      {/* Keyword */}
      <div className="relative">
        <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none"
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search job titles..."
          value={keyword}
          onChange={handle('keyword')}
          className="w-full pl-8 pr-3 py-1.5 bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-600 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap gap-2">
        <select value={companyId} onChange={handle('companyId')} className={inputCls}>
          <option value="">All Companies</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <input
          type="text"
          placeholder="Location..."
          value={location}
          onChange={handle('location')}
          className={inputCls}
        />

        <input
          type="text"
          placeholder="Department..."
          value={department}
          onChange={handle('department')}
          className={inputCls}
        />

        {hasFilters && (
          <button
            onClick={clear}
            className="px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 rounded-md hover:bg-gray-700 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
