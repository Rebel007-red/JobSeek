const NEW_JOB_HOURS = 48

function isNew(firstSeenAt) {
  return Date.now() - new Date(firstSeenAt).getTime() < NEW_JOB_HOURS * 3600000
}

function formatDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  return isNaN(d) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function JobCard({ job, matchedSkills = [] }) {
  const { title, location, department, url, first_seen_at, posted_at, companies } = job
  const companyName = companies?.name ?? 'Unknown'
  const matchCount = matchedSkills.length

  return (
    <div className={`rounded-lg p-3 flex flex-col gap-2 border transition-shadow hover:shadow-lg ${matchCount > 0 ? 'bg-gray-800 border-indigo-600/60 ring-1 ring-indigo-600/30' : 'bg-gray-800 border-gray-700'}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-gray-100 text-sm leading-snug line-clamp-2" title={title}>{title}</h3>
          <p className="text-xs text-indigo-400 mt-0.5 font-medium">{companyName}</p>
        </div>
        <div className="shrink-0 flex flex-col gap-1 items-end">
          {matchCount > 0 && (
            <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-indigo-900/60 text-indigo-300 border border-indigo-700/50">
              {matchCount}?
            </span>
          )}
          {isNew(first_seen_at) && (
            <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-green-900/60 text-green-300 border border-green-700/50">
              NEW
            </span>
          )}
        </div>
      </div>

      {/* Matched skill tags */}
      {matchCount > 0 && (
        <div className="flex flex-wrap gap-1">
          {matchedSkills.map(s => (
            <span key={s} className="px-1.5 py-0.5 bg-indigo-900/40 text-indigo-300 text-xs rounded border border-indigo-700/40">{s}</span>
          ))}
        </div>
      )}

      {/* Meta */}
      <div className="flex flex-wrap gap-2 text-xs text-gray-400">
        {location && (
          <span className="flex items-center gap-1">
            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="truncate max-w-[140px]">{location}</span>
          </span>
        )}
        {department && (
          <span className="flex items-center gap-1">
            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5" />
            </svg>
            <span className="truncate max-w-[140px]">{department}</span>
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-0.5 border-t border-gray-700/50">
        <div className="flex flex-col gap-0">
          {posted_at && <span className="text-xs text-gray-400">Posted {formatDate(posted_at)}</span>}
          <span className="text-xs text-gray-600">Found {new Date(first_seen_at).toLocaleDateString()}</span>
        </div>
        <a href={url} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors">
          Apply
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>
    </div>
  )
}
