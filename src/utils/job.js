const NEW_JOB_MS = 2 * 24 * 3600 * 1000 // 2 days

export function formatDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  return isNaN(d) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatRelativeAge(dateStr) {
  if (!dateStr) return null

  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return null

  const diffMs = Date.now() - date.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)

  if (diffHours < 1) return 'Now'
  if (diffHours < 24) return `${Math.max(1, Math.round(diffHours))}h ago`

  const diffDays = Math.round(diffHours / 24)
  if (diffDays === 1) return '1d ago'
  if (diffDays < 7) return `${diffDays}d ago`

  return 'Older'
}

export function isNewJob(postedAt, firstSeenAt) {
  const ref = postedAt || firstSeenAt
  return ref ? Date.now() - new Date(ref).getTime() < NEW_JOB_MS : false
}

export function getMatchedSkills(job, userSkills) {
  if (!userSkills.length) return []
  const storedSkills = Array.isArray(job.skills) ? job.skills : []
  
  const fromTags = userSkills.filter(s =>
    storedSkills.some(tag => tag.toLowerCase().includes(s) || s.includes(tag.toLowerCase()))
  )
  
  const haystack = `${job.title} ${job.department || ''}`.toLowerCase()
  const fromText = userSkills.filter(s => !fromTags.includes(s) && haystack.includes(s))
  
  return [...new Set([...fromTags, ...fromText])]
}

export function getMatchScore(job, matchedSkillsCount) {
  const storedSkills = Array.isArray(job.skills) ? job.skills : []
  return storedSkills.length > 0
    ? Math.round((matchedSkillsCount / storedSkills.length) * 100)
    : 0
}

export function getDisplaySkills(job, matchedSkills, limit = 6) {
  const storedSkills = Array.isArray(job.skills) ? job.skills : []
  return [
    ...matchedSkills,
    ...storedSkills.filter(s => !matchedSkills.includes(s)),
  ].slice(0, limit)
}
