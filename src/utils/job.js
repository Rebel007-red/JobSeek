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

function normalizeSkillToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function skillMatchesText(skill, text) {
  const normalizedSkill = normalizeSkillToken(skill)
  const normalizedText = normalizeSkillToken(text)

  if (!normalizedSkill || !normalizedText) return false

  const escapedSkill = normalizedSkill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const boundaryPattern = new RegExp(`(^|\\s)${escapedSkill}(?=\\s|$)`, 'i')

  return boundaryPattern.test(normalizedText)
}

export function getMatchedSkills(job, userSkills) {
  if (!Array.isArray(userSkills) || userSkills.length === 0) return []

  const normalizedUserSkills = userSkills
    .map(skill => normalizeSkillToken(skill))
    .filter(Boolean)

  if (!normalizedUserSkills.length) return []

  const storedSkills = Array.isArray(job.skills)
    ? job.skills.map(skill => normalizeSkillToken(skill)).filter(Boolean)
    : []

  const haystack = `${job.title || ''} ${job.department || ''}`

  const fromTags = normalizedUserSkills.filter(skill =>
    storedSkills.some(tag => tag === skill || skillMatchesText(skill, tag))
  )

  const fromText = normalizedUserSkills.filter(skill => !fromTags.includes(skill) && skillMatchesText(skill, haystack))
  const orderedMatches = normalizedUserSkills.filter(skill => fromTags.includes(skill) || fromText.includes(skill))

  return orderedMatches
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
