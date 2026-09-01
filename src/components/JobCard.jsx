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

const NEW_JOB_HOURS = 48

function isNew(firstSeenAt) {
  return Date.now() - new Date(firstSeenAt).getTime() < NEW_JOB_HOURS * 3600000
}

function formatDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  return isNaN(d) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function JobCard({ job, matchedSkills = [], onHide }) {
  const { title, location, department, url, first_seen_at, posted_at, companies } = job
  const companyName = companies?.name ?? 'Unknown'
  const matchCount = matchedSkills.length

  const extractedSkills = extractSkills(title, department)
  const displaySkills = [
    ...matchedSkills,
    ...extractedSkills.filter(s => !matchedSkills.includes(s)),
  ].slice(0, 6)

  return (
    <div className={`relative rounded-lg p-3 flex flex-col gap-2 border transition-all active:scale-[0.99] ${
      matchCount > 0
        ? 'bg-gray-800 border-indigo-500/50 ring-1 ring-indigo-500/20'
        : 'bg-gray-800 border-gray-700/80 hover:border-gray-600'
    }`}>

      {/* Hide button — always visible (dim), bright on hover */}
      {onHide && (
        <button
          onClick={() => onHide(job.id)}
          title="Hide this job"
          className="absolute top-1 right-1 p-1.5 rounded opacity-20 hover:opacity-100 focus:opacity-100 text-gray-400 hover:text-red-400 hover:bg-gray-700/80 transition-all touch-manipulation"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Title + badges */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-gray-100 text-sm leading-snug line-clamp-2" title={title}>{title}</h3>
          <p className="text-[11px] text-indigo-400 mt-0.5 font-medium truncate">{companyName}</p>
        </div>
        <div className="shrink-0 flex flex-col gap-1 items-end">
          {matchCount > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 whitespace-nowrap">
              {matchCount} match
            </span>
          )}
          {isNew(first_seen_at) && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              NEW
            </span>
          )}
        </div>
      </div>

      {/* Skill tags */}
      {displaySkills.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {displaySkills.map(s => (
            <span key={s} className={`px-1.5 py-0.5 text-[10px] rounded border ${
              matchedSkills.includes(s)
                ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                : 'bg-gray-700/40 text-gray-500 border-gray-600/40'
            }`}>
              {s}
            </span>
          ))}
        </div>
      )}

      {/* Location + department */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
        {location && (
          <span className="flex items-center gap-1 min-w-0">
            <svg className="w-3 h-3 shrink-0 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="truncate max-w-[140px]">{location}</span>
          </span>
        )}
        {department && (
          <span className="flex items-center gap-1 min-w-0">
            <svg className="w-3 h-3 shrink-0 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5" />
            </svg>
            <span className="truncate max-w-[140px]">{department}</span>
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-1 border-t border-gray-700/40 mt-auto">
        <span className="text-[10px] text-gray-600">
          {posted_at ? <>Posted <span className="text-gray-500">{formatDate(posted_at)}</span></> : new Date(first_seen_at).toLocaleDateString()}
        </span>
        <a href={url} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors">
          Apply
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>
    </div>
  )
}
