import { useRef, useState } from 'react'

// Common tech/domain skills to extract from job title + department text
const SKILL_KEYWORDS = [
  'python','java','javascript','typescript','react','angular','vue','node','golang',
  'rust','c++','c#','.net','php','ruby','swift','kotlin','sql','nosql','mongodb',
  'postgres','mysql','redis','elasticsearch','kafka','spark','hadoop','aws','azure',
  'gcp','cloud','docker','kubernetes','terraform','ansible','devops','mlops','linux',
  'machine learning','deep learning','ai','llm','nlp','data science','data engineering',
  'backend','frontend','fullstack','full stack','api','rest','graphql','microservices',
  'serverless','sap','salesforce','oracle','power bi','tableau','qa','testing',
  'security','networking','ios','android','mobile','embedded','product','ux','ui',
  'agile','scrum','project management','blockchain',
]

function extractSkills(title, department) {
  const text = `${title} ${department || ''}`.toLowerCase()
  return SKILL_KEYWORDS.filter(k => text.includes(k)).slice(0, 5)
}

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

  const extractedSkills = extractSkills(title, department)
  const displaySkills = [
    ...matchedSkills,
    ...extractedSkills.filter(s => !matchedSkills.includes(s)),
  ].slice(0, 5)

  // Swipe state
  const [offset, setOffset] = useState(0)
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
      // Animate out right, then hide
      setOffset(400)
      setTimeout(() => onHide(job.id), 200)
    } else if (offset < -SWIPE_THRESHOLD && onApplied) {
      // Animate out left, then mark applied
      setOffset(-400)
      setTimeout(() => onApplied(job.id, !applied_at), 200)
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
    <div className="relative overflow-hidden rounded-lg">
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
          transition: swiping.current ? 'none' : 'transform 0.25s ease',
        }}
        className={`relative rounded-lg p-2.5 flex flex-col gap-2 border ${
          matchCount > 0
            ? 'bg-gray-800 border-indigo-500/40 ring-1 ring-indigo-500/10'
            : 'bg-gray-800 border-gray-700/60 hover:border-gray-600/80'
        }`}
      >
        {/* Title row */}
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-100 text-[13px] leading-snug line-clamp-2" title={title}>{title}</h3>
            <p className="text-[11px] text-indigo-400/80 mt-0.5 font-medium truncate">{companyName}</p>
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
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/15 text-indigo-400 border border-indigo-500/20 whitespace-nowrap">
                {matchCount}✦
              </span>
            )}
            {onHide && (
              <button
                onClick={() => onHide(job.id)}
                title="Hide this job"
                className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-700/50 hover:bg-red-500/70 text-gray-600 hover:text-white transition-all touch-manipulation ml-0.5"
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Location + date */}
        <div className="flex items-center justify-between text-[10px]">
          {location ? (
            <span className="flex items-center gap-0.5 text-gray-500 min-w-0">
              <svg className="w-2.5 h-2.5 shrink-0 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="truncate max-w-[160px]">{location}</span>
            </span>
          ) : <span />}
          <span className="text-gray-600 shrink-0">
            {formatDate(posted_at || first_seen_at)}
          </span>
        </div>

        {/* Skill tags */}
        {displaySkills.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {displaySkills.map(s => (
              <span key={s} className={`px-1.5 py-0.5 text-[10px] rounded-full border ${
                matchedSkills.includes(s)
                  ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20'
                  : 'bg-gray-700/30 text-gray-500 border-gray-700/50'
              }`}>
                {s}
              </span>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-1.5 border-t border-gray-700/30">
          {onApplied ? (
            <button
              onClick={() => onApplied(job.id, !applied_at)}
              className={`inline-flex items-center gap-1 text-[11px] transition-colors ${
                applied_at
                  ? 'text-emerald-400 hover:text-gray-400'
                  : 'text-gray-600 hover:text-emerald-400'
              }`}
            >
              <svg className="w-3 h-3" fill={applied_at ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {applied_at ? 'Applied' : 'Mark applied'}
            </button>
          ) : <span />}
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors">
            Apply
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  )
}
