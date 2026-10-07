// Rules for roles and skills people type themselves. Used by the profile editor; saveProfile in supabase/app_api.sql
// applies the same rules on the server (checked by src/utils/sql_constants.test.js).
import { companyKey } from './gold.js'

export const ENTRY_MAX_LENGTH = 60
// Most roles, core skills, preferred cities and also-know skills one profile can have
export const PROFILE_LIMITS = { roles: 2, skills: 5, cities: 3, alsoSkills: 10 }
// Longest note per job (setNote)
export const NOTE_MAX_LENGTH = 2000
// Most mute rules per kind (saveMuteRules), and the length of one entry
export const MUTE_LIMITS = { companies: 50, titleWords: 30 }
export const MUTE_LENGTHS = { companies: [2, 100], titleWords: [2, 40] }
// Muted title words: like ENTRY_RE without brackets (the words end up in a regex)
export const MUTE_WORD_RE = /^[A-Za-z0-9][A-Za-z0-9 .+#&/-]*$/

// Letters, digits and the punctuation real tech names use (C++, C#, .NET, Node.js, CI/CD, A/B Testing).
// No quotes: role titles end up inside LLM response schemas and SQL literals in the pipeline.
const ENTRY_RE = /^[A-Za-z0-9.][A-Za-z0-9 .+#&/()-]*$/

// Too general to match jobs on
const VAGUE = new Set([
  'communication', 'communication skills', 'teamwork', 'team player', 'leadership', 'problem solving', 'management',
  'analytics', 'hard working', 'english', 'ms office', 'microsoft office', 'computer', 'computers', 'it', 'software',
  'engineering', 'engineer', 'developer', 'job', 'jobs', 'fresher', 'any', 'none', 'na', 'n/a',
])

// '' when the entry is fine, otherwise a short reason
export function entryProblem(value) {
  const text = String(value ?? '').trim()
  if (text.length < 2) return 'Too short'
  if (text.length > ENTRY_MAX_LENGTH) return `At most ${ENTRY_MAX_LENGTH} characters`
  if (!ENTRY_RE.test(text) || !/[A-Za-z]/.test(text)) return 'Use letters, numbers, spaces and . + # & / ( ) - only'
  if (VAGUE.has(text.toLowerCase())) return `"${text}" is too general to match jobs on`
  return ''
}

// '' when the also-know skill is fine, otherwise the reason (entryProblem, then a repeat of a core skill)
export function alsoSkillProblem(value, coreSkills = []) {
  const problem = entryProblem(value)
  if (problem) return problem
  const key = String(value).trim().toLowerCase()
  return coreSkills.some(skill => String(skill).trim().toLowerCase() === key) ? 'Already a core skill' : ''
}

// '' when the mute rule is fine, otherwise a short reason (saveMuteRules checks the same; levels are picked, not typed)
export function muteRuleProblem(kind, value) {
  const text = String(value ?? '').trim()
  const [min, max] = MUTE_LENGTHS[kind] || [2, 40]
  if (text.length < min) return 'Too short'
  if (text.length > max) return `At most ${max} characters`
  if (kind === 'companies' && !companyKey(text)) return 'Not a company name'
  if (kind === 'titleWords' && !MUTE_WORD_RE.test(text)) return 'Use letters, numbers, spaces and . + # & / - only'
  return ''
}
