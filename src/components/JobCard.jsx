// How many hours after first_seen_at a job is considered "new"
const NEW_JOB_HOURS = 48

function isNew(firstSeenAt) {
  const diff = Date.now() - new Date(firstSeenAt).getTime()
  return diff < NEW_JOB_HOURS * 60 * 60 * 1000
}

function formatDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d)) return null
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function JobCard({ job, matchedSkills = [] }) {
  const { title, location, department, url, first_seen_at, posted_at, companies } = job
  const companyName = companies?.name ?? 'Unknown Company'
  const matchCount = matchedSkills.length

  return (
    <div className={`bg-white border rounded-xl p-5 flex flex-col gap-3 shadow-sm hover:shadow-md transition-shadow ${matchCount > 0 ? 'border-indigo-300 ring-1 ring-indigo-200' : 'border-gray-200'}`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 text-base leading-snug truncate" title={title}>
            {title}
          </h3>
          <p className="text-sm text-indigo-600 font-medium mt-0.5">{companyName}</p>
        </div>
        <div className="shrink-0 flex flex-col gap-1 items-end">
          {matchCount > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700">
              {matchCount} skill{matchCount > 1 ? 's' : ''} match
            </span>
          )}
          {isNew(first_seen_at) && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
              NEW
            </span>
          )}
        </div>
      </div>

      {/* Matched skills */}
      {matchCount > 0 && (
        <div className="flex flex-wrap gap-1">
          {matchedSkills.map((s) => (
            <span key={s} className="px-2 py-0.5 bg-indigo-50 text-indigo-600 text-xs rounded-full border border-indigo-100">
              {s}
            </span>
          ))}
        </div>
      )}

      {/* Meta */}
      <div className="flex flex-wrap gap-2 text-sm text-gray-500">
        {location && (
          <span className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {location}
          </span>
        )}
        {department && (
          <span className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            {department}
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex flex-col gap-0.5">
          {posted_at && (
            <span className="text-xs text-gray-500 font-medium">
              Posted {formatDate(posted_at)}
            </span>
          )}
          <span className="text-xs text-gray-400">
            Found {new Date(first_seen_at).toLocaleDateString()}
          </span>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
        >
          Apply
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>
    </div>
  )
}
