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
    <article 
      className="group bg-white border border-gray-200 rounded-xl p-5 hover:shadow-lg hover:border-indigo-200 transition-all duration-200 flex flex-col h-full"
    >
      
      {/* Header: Title + Company */}
      <div className="mb-3">
        <h3 className="text-base font-bold text-gray-900 line-clamp-2 group-hover:text-indigo-600 transition-colors">
          {title}
        </h3>
        <p className="text-sm text-indigo-600 font-semibold mt-1.5">
          {companyName}
        </p>
      </div>

      {/* Meta: Location + Department */}
      <div className="space-y-1.5 mb-3 text-sm text-gray-600">
        {location && (
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span>{location}</span>
          </div>
        )}
        {department && (
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <span>{department}</span>
          </div>
        )}
      </div>

      {/* Skills Tags */}
      {storedSkills.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {storedSkills.slice(0, 5).map(skill => (
            <span
              key={skill}
              className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold transition-colors ${
                matchedSkills.includes(skill)
                  ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200'
                  : 'bg-gray-100 text-gray-700 ring-1 ring-gray-200'
              }`}
            >
              {skill}
            </span>
          ))}
          {storedSkills.length > 5 && (
            <span className="text-xs text-gray-600 px-2 py-1 font-medium">
              +{storedSkills.length - 5}
            </span>
          )}
        </div>
      )}

      {/* Badges Row */}
      <div className="flex flex-wrap gap-2 mb-4 pt-3 border-t border-gray-100">
        {applied_at && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg border border-emerald-200">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Applied
          </span>
        )}
        
        {isNew && !applied_at && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-amber-700 bg-amber-50 rounded-lg border border-amber-200">
            <span className="w-2 h-2 bg-amber-500 rounded-full"></span>
            New
          </span>
        )}
        
        {matchedSkills.length > 0 && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-purple-700 bg-purple-50 rounded-lg border border-purple-200">
            <span>✨</span>
            {matchScore}% Match
          </span>
        )}

        <span className="text-xs text-gray-500 px-2 py-1 ml-auto">
          {formatDate(posted_at || first_seen_at)}
        </span>
      </div>

      {/* Footer: Actions */}
      <div className="flex items-center justify-between pt-3 border-t border-gray-100 mt-auto">
        {onApplied && (
          <button
            onClick={() => onApplied(job.id, !applied_at)}
            className={`inline-flex items-center gap-1.5 text-sm font-semibold transition-all duration-200 ${
              applied_at
                ? 'text-emerald-600 hover:text-emerald-700'
                : 'text-gray-600 hover:text-indigo-600'
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
            {applied_at ? 'Applied' : 'Apply'}
          </button>
        )}

        <div className="flex items-center gap-2 ml-auto">
          {url && url !== '#' && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center w-9 h-9 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all duration-200 group/link"
              title="Open job posting"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              className="inline-flex items-center justify-center w-9 h-9 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all duration-200"
              title="Hide this job"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
    </article>
  )
}
