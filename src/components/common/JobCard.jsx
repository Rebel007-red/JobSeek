import { formatDate, getMatchScore, isNewJob } from '../../utils/job'

export function JobCard({ job, matchedSkills = [], onHide, onApplied }) {
  const {
    title,
    location,
    department,
    url,
    first_seen_at,
    posted_at,
    applied_at,
    companies,
  } = job

  const companyName = companies?.name ?? 'Unknown'
  const storedSkills = Array.isArray(job.skills) ? job.skills : []
  const matchScore = getMatchScore(job, matchedSkills.length)
  const isNew = isNewJob(posted_at, first_seen_at)

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
      
      {/* Header: Title + Company + Actions */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-gray-900 line-clamp-2">
            {title}
          </h3>
          <p className="text-sm text-indigo-600 font-medium mt-1">
            {companyName}
          </p>
        </div>
        
        {/* Badges */}
        <div className="flex items-center gap-2 shrink-0">
          {applied_at && (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-emerald-700 bg-emerald-100 rounded-full">
              ✓ Applied
            </span>
          )}
          {isNew && !applied_at && (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-blue-700 bg-blue-100 rounded-full">
              NEW
            </span>
          )}
          {matchedSkills.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-indigo-700 bg-indigo-100 rounded-full">
              ✦ {matchScore}%
            </span>
          )}
        </div>
      </div>

      {/* Meta: Location + Date */}
      <div className="flex items-center justify-between text-sm text-gray-600 mb-3">
        {location && (
          <span className="flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {location}
          </span>
        )}
        <span>{formatDate(posted_at || first_seen_at)}</span>
      </div>

      {/* Skills Tags */}
      {storedSkills.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {storedSkills.slice(0, 4).map(skill => (
            <span
              key={skill}
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                matchedSkills.includes(skill)
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'bg-gray-100 text-gray-700'
              }`}
            >
              {skill}
            </span>
          ))}
          {storedSkills.length > 4 && (
            <span className="text-xs text-gray-600 px-2.5 py-1">
              +{storedSkills.length - 4} more
            </span>
          )}
        </div>
      )}

      {/* Footer: Actions */}
      <div className="flex items-center justify-between pt-3 border-t border-gray-200">
        <div className="flex items-center gap-3">
          {onApplied && (
            <button
              onClick={() => onApplied(job.id, !applied_at)}
              className={`inline-flex items-center gap-1.5 text-sm font-medium transition-colors ${
                applied_at
                  ? 'text-emerald-600 hover:text-emerald-700'
                  : 'text-gray-600 hover:text-emerald-600'
              }`}
            >
              <svg
                className="w-4 h-4"
                fill={applied_at ? 'currentColor' : 'none'}
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              {applied_at ? 'Applied' : 'Mark applied'}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {url && url !== '#' && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-600 hover:text-indigo-700 transition-colors"
            >
              View job
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </a>
          )}
          {onHide && (
            <button
              onClick={() => onHide(job.id)}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-red-600 transition-colors"
              title="Hide this job"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
