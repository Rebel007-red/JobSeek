export function SearchFilter({ filters, companies, onChange }) {
  const { keyword, companyId, location, department } = filters

  function handle(field) {
    return (e) => onChange({ ...filters, [field]: e.target.value })
  }

  function clear() {
    onChange({ ...filters, keyword: '', companyId: '', location: '', department: '' })
  }

  const hasFilters = keyword || companyId || location || department

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-3 shadow-sm">
      {/* Keyword */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search job titles…"
          value={keyword}
          onChange={handle('keyword')}
          className="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>

      {/* Dropdowns row */}
      <div className="flex flex-wrap gap-2">
        <select
          value={companyId}
          onChange={handle('companyId')}
          className="flex-1 min-w-[140px] border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          <option value="">All Companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Location…"
          value={location}
          onChange={handle('location')}
          className="flex-1 min-w-[120px] border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />

        <input
          type="text"
          placeholder="Department…"
          value={department}
          onChange={handle('department')}
          className="flex-1 min-w-[120px] border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />

        {hasFilters && (
          <button
            onClick={clear}
            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
