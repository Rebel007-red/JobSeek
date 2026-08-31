export function SearchFilter({ filters, companies, onChange }) {
  const { keyword, companyId, location, department, skills } = filters

  function handle(field) {
    return (e) => onChange({ ...filters, [field]: e.target.value })
  }

  function clear() {
    onChange({ keyword: '', companyId: '', location: '', department: '', skills: '' })
  }

  const hasFilters = keyword || companyId || location || department || skills

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
      </div>

      {/* Skills row */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-400"
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
        <input
          type="text"
          placeholder="My skills (comma-separated, e.g. Python, React, AWS)…"
          value={skills}
          onChange={handle('skills')}
          className="w-full pl-9 pr-4 py-2 border border-indigo-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-indigo-50"
        />
      </div>

      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-400">
          {skills
            ? `Matching against: ${skills.split(',').map(s => s.trim()).filter(Boolean).join(', ')}`
            : 'Enter your skills above to highlight matching jobs'}
        </p>
        {hasFilters && (
          <button
            onClick={clear}
            className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  )
}
