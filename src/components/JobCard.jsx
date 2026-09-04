import { useRef, useState } from 'react'

const NEW_JOB_MS = 2 * 24 * 3600000 // 2 days

function isNew(postedAt, firstSeenAt) {
  const ref = postedAt || firstSeenAt
  return ref ? Date.now() - new Date(ref).getTime() < NEW_JOB_MS : false
}

function formatDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  return isNaN(d) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const SWIPE_THRESHOLD = 80  // px before triggering action

export function JobCard({ job, matchedSkills = [], onHide, onApplied }) {
  const { title, location, department, url, first_seen_at, posted_at, applied_at, companies } = job
  const companyName = companies?.name ?? 'Unknown'
  const matchCount = matchedSkills.length

  // Use skills extracted from description (stored in DB); fall back to empty
  const storedSkills = Array.isArray(job.skills) ? job.skills : []
  // Show matched skills first, then remaining stored skills up to 6 total
  const displaySkills = [
    ...matchedSkills,
    ...storedSkills.filter(s => !matchedSkills.includes(s)),
  ].slice(0, 6)

  // Compute match score percentage: matched / total job skills
  const matchScore = storedSkills.length > 0
    ? Math.round((matchCount / storedSkills.length) * 100)
    : 0

  // Swipe state
  const [offset, setOffset] = useState(0)
  const [exitColor, setExitColor] = useState(null)  // 'red' or 'green' for exit animation
  const touchStartX = useRef(null)
  const swiping = useRef(false)

  function handleTouchStart(e) {
    touchStartX.current = e.touches[0].clientX
    swiping.current = false
  }

  function handleTouchMove(e) {
    if (touchStartX.current === null) return
    const delta = e.touches[0].clientX - touchStartX.current
    if (Math.abs(delta) > 10) swiping.current = true
    // Clamp: right max 160px (hide), left max -160px (applied)
    setOffset(Math.max(-160, Math.min(160, delta)))
  }

  function handleTouchEnd() {
    if (offset > SWIPE_THRESHOLD && onHide) {
      // Swipe right → red background, slide and fade out
      setExitColor('red')
      setTimeout(() => {
        setOffset(400)
        setTimeout(() => onHide(job.id), 300)
      }, 50)
    } else if (offset < -SWIPE_THRESHOLD && onApplied) {
      // Swipe left → green background, slide and fade out, then call onApplied
      setExitColor('green')
      setTimeout(() => {
        setOffset(-400)
        setTimeout(() => {
          onApplied(job.id, !applied_at)
          setOffset(0)
          setExitColor(null)
        }, 300)
      }, 50)
    } else {
      setOffset(0)
    }
    touchStartX.current = null
  }

  // Reveal colors
  const hideReveal = offset > 0
  const applyReveal = offset < 0
  const revealIntensity = Math.min(Math.abs(offset) / SWIPE_THRESHOLD, 1)

  return (
    <div className="relative overflow-hidden rounded-lg h-full">
      {/* Exit background (shows when swiped off) */}
      {exitColor && (
        <div
          className={`absolute inset-0 rounded-lg transition-opacity duration-300 ${
            exitColor === 'red' ? 'bg-red-500/80' : 'bg-green-500/80'
          }`}
        />
      )}

      {/* Swipe reveal backgrounds */}
      <div
        className="absolute inset-0 flex items-center justify-start px-4 rounded-lg"
        style={{ background: `rgba(239, 68, 68, ${hideReveal ? revealIntensity * 0.85 : 0})` }}
      >
        <span className="text-white font-bold text-sm opacity-90">Hide</span>
      </div>
      <div
        className="absolute inset-0 flex items-center justify-end px-4 rounded-lg"
        style={{ background: `rgba(16, 185, 129, ${applyReveal ? revealIntensity * 0.85 : 0})` }}
      >
        <span className="text-white font-bold text-sm opacity-90">{applied_at ? 'Undo' : 'Applied!'}</span>
      </div>

      {/* Card */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          transform: `translateX(${offset}px)`,
          transition: swiping.current ? 'none' : 'transform 0.3s ease-out',
          opacity: exitColor ? (1 - Math.abs(offset) / 500) : 1,
        }}
        }}
        className={`relative rounded-lg p-3 flex flex-col gap-2.5 border h-full backdrop-blur-sm ${
          matchCount > 0
            ? 'bg-gray-800/95 border-indigo-500/50 shadow-lg shadow-indigo-900/20 hover:shadow-indigo-900/30'
            : 'bg-gray-800/90 border-gray-700/50 shadow-md shadow-black/30 hover:shadow-black/40 hover:border-gray-600/60'
        } transition-all`}
      >
        {/* Title row */}
        <div className="flex items-start gap-2.5">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-50 text-[13px] leading-snug line-clamp-2" title={title}>{title}</h3>
            <p className="text-[11px] text-indigo-400/90 mt-1 font-medium truncate">{companyName}</p>
          </div>
          {/* Right badges + hide button */}
          <div className="shrink-0 flex items-center gap-1 pt-0.5">
            {applied_at && (
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                ✓ Applied
              </span>
            )}
            {!applied_at && isNew(posted_at, first_seen_at) && (
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/15 text-sky-400 border border-sky-500/20">
                NEW
              </span>
            )}
            {matchCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/15 text-indigo-400 border border-indigo-500/20 whitespace-nowrap" title={`${matchCount}/${storedSkills.length} skills matched`}>
                {matchScore}% ✦
              </span>
            )}
            {onHide && (
              <button
                onClick={() => onHide(job.id)}
                title="Hide this job"
                className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-600/50 hover:bg-red-500/80 text-gray-400 hover:text-white transition-all touch-manipulation ml-0.5"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Location + date */}
        <div className="flex items-center justify-between text-[10px] text-gray-500">
          {location ? (
            <span className="flex items-center gap-1 min-w-0">
              <svg className="w-3 h-3 shrink-0 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="truncate max-w-[160px]">{location}</span>
            </span>
          ) : <span />}
          <span className="text-gray-600 shrink-0 font-medium">
            {formatDate(posted_at || first_seen_at)}
          </span>
        </div>

        {/* Skill tags — flex-1 pushes footer to bottom */}
        <div className="flex-1">
          {displaySkills.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {displaySkills.map(s => (
              <span key={s} className={`px-2 py-0.5 text-[10px] rounded-full border font-medium transition-colors ${
                matchedSkills.includes(s)
                  ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                  : 'bg-gray-700/40 text-gray-400 border-gray-700/40'
              }`}>
                {s}
              </span>
            ))}
          </div>
        )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-gray-700/40">
          {onApplied ? (
            <button
              onClick={() => onApplied(job.id, !applied_at)}
              className={`inline-flex items-center gap-1 text-[11px] font-medium transition-colors ${
                applied_at
                  ? 'text-emerald-400 hover:text-emerald-300'
                  : 'text-gray-500 hover:text-emerald-400'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill={applied_at ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {applied_at ? 'Applied' : 'Mark applied'}
            </button>
          ) : <span />}
          {url && url !== '#' ? (
            <a href={url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors">
              View
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          ) : (
            <span className="text-[11px] text-gray-700">No link</span>
          )}
        </div>
      </div>
    </div>
  )
}
