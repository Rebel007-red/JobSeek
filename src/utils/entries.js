// Rules for roles and skills people type themselves. Shared by the profile editor and the API (netlify/functions/api).
export const ENTRY_MAX_LENGTH = 60

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
