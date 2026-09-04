import { useState } from 'react'
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

  const [touchStart, setTouchStart] = useState(0)
  const [touchEnd, setTouchEnd] = useState(0)
  const [swipeDirection, setSwipeDirection] = useState(null)

  const companyName = companies?.name ?? 'Unknown'
  const storedSkills = Array.isArray(job.skills) ? job.skills : []
  const matchScore = getMatchScore(job, matchedSkills.length)
  const isNew = isNewJob(posted_at, first_seen_at)

  // Swipe detection (minDistance: 50px)
  const handleTouchStart = (e) => {
    setTouchStart(e.targetTouches[0].clientX)
  }

  const handleTouchEnd = (e) => {
    setTouchEnd(e.changedTouches[0].clientX)
    detectSwipe(e.targetTouches[0]?.clientX || e.changedTouches[0].clientX)
  }

  const detectSwipe = (endX) => {
    const distance = touchStart - endX
    const isLeftSwipe = distance > 50
    const isRightSwipe = distance < -50

    if (isLeftSwipe && onHide) {
      setSwipeDirection('left')
      setTimeout(() => onHide(job.id), 150)
    } else if (isRightSwipe && onApplied) {
      setSwipeDirection('right')
      setTimeout(() => onApplied(job.id, !applied_at), 150)
    }
  }

  return (
    <article 
      className={`group bg-slate-800/50 border border-slate-700 rounded-lg p-3 hover:shadow-lg hover:border-indigo-600/50 transition-all duration-200 flex flex-col h-full swipeable ${
        swipeDirection ? 'opacity-50' : ''
      }`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      
      {/* Header: Title + Company */}
      <div className="mb-2">
        <h3 className="text-sm font-bold text-slate-100 line-clamp-2 group-hover:text-indigo-400 transition-colors">
          {title}
        </h3>
        <p className="text-xs text-indigo-400 font-semibold mt-1">
          {companyName}
        </p>
      </div>

      {/* Meta: Location + Department */}
      <div className="space-y-0.5 mb-2 text-xs text-slate-400">
        {location && (
          <div className="flex items-center gap-1.5">
            <svg className="w-3 h-3 flex-shrink-0 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="line-clamp-1">{location}</span>
          </div>
        )}
        {department && (
          <div className="flex items-center gap-1.5">
            <svg className="w-3 h-3 flex-shrink-0 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <span className="line-clamp-1">{department}</span>
          </div>
        )}
      </div>

      {/* Skills Tags - More Compact */}
      {storedSkills.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2.5">
          {storedSkills.slice(0, 4).map(skill => (
            <span
              key={skill}
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium transition-colors ${
                matchedSkills.includes(skill)
                  ? 'bg-indigo-900/60 text-indigo-300'
                  : 'bg-slate-700/50 text-slate-400'
              }`}
            >
              {skill}
            </span>
          ))}
          {storedSkills.length > 4 && (
            <span className="text-xs text-slate-500 px-1.5 py-0.5">
              +{storedSkills.length - 4}
            </span>
          )}
        </div>
      )}

      {/* Badges Row - Compact */}
      <div className="flex flex-wrap gap-1.5 mb-2.5 pt-2 border-t border-slate-700/50">
        {applied_at && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-emerald-400 bg-emerald-900/40 rounded border border-emerald-700/50">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Applied
          </span>
        )}
        
        {isNew && !applied_at && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-amber-400 bg-amber-900/40 rounded border border-amber-700/50">
            <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse"></span>
            New
          </span>
        )}
        
        {matchedSkills.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-purple-400 bg-purple-900/40 rounded border border-purple-700/50">
            ✨ {matchScore}%
          </span>
        )}

        <span className="text-xs text-slate-600 px-1.5 py-0.5 ml-auto">
          {formatDate(posted_at || first_seen_at)}
        </span>
      </div>

      {/* Footer: Actions - Icon Only */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-700/50 mt-auto">
        {onApplied && (
          <button
            onClick={() => onApplied(job.id, !applied_at)}
            className={`inline-flex items-center justify-center w-8 h-8 rounded transition-all duration-200 ${
              applied_at
                ? 'text-emerald-400 hover:bg-emerald-900/40'
                : 'text-slate-400 hover:text-indigo-400 hover:bg-slate-700/50'
            }`}
            title={applied_at ? 'Mark as unapplied' : 'Mark as applied'}
          >
            <svg
              className="w-4.5 h-4.5"
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
          </button>
        )}

        <div className="flex items-center gap-1 ml-auto">
          {url && url !== '#' && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center w-8 h-8 text-indigo-400 hover:bg-indigo-900/40 rounded transition-all duration-200"
              title="Open job posting"
            >
              <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              className="inline-flex items-center justify-center w-8 h-8 text-slate-400 hover:text-red-400 hover:bg-red-900/40 rounded transition-all duration-200"
              title="Hide this job (or swipe left)"
            >
              <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

      {/* Swipe Hint - For Touch Devices */}
      {(onHide || onApplied) && (
        <div className="text-xs text-slate-600 text-center mt-1 hidden sm:hidden lg:block">
          💬 Swipe left to hide, right to apply
        </div>
      )}
    </article>
  )
}
