/**
 * Shared skill-extraction utility used by all scraper handlers.
 *
 * Usage:
 *   import { extractSkillsFromText } from './skills-extractor.js'
 *   const skills = extractSkillsFromText(jobDescription)   // → ['python', 'aws', ...]
 */

// Comprehensive tech-skill keyword list (order matters: longer tokens first to prevent
// partial-match false positives when using whole-word regex, e.g. "next.js" before "js")
const TECH_SKILLS = [
  // ── Languages ──────────────────────────────────────────────────────────
  'python', 'java', 'typescript', 'javascript', 'golang', 'scala', 'kotlin',
  'rust', 'swift', 'c++', 'c#', '.net', 'php', 'ruby', 'r',
  // ── Frontend ───────────────────────────────────────────────────────────
  'next.js', 'nextjs', 'react', 'angular', 'vue', 'svelte', 'tailwind', 'css', 'html',
  // ── Backend / Frameworks ───────────────────────────────────────────────
  'spring boot', 'spring', 'fastapi', 'django', 'flask', 'express', 'nestjs',
  'node.js', 'nodejs', 'node', 'rails', 'laravel',
  // ── Databases ──────────────────────────────────────────────────────────
  'postgresql', 'postgres', 'mysql', 'mongodb', 'dynamodb', 'cassandra',
  'elasticsearch', 'redis', 'bigquery', 'snowflake', 'databricks', 'redshift',
  'nosql', 'sql',
  // ── Data / ML ──────────────────────────────────────────────────────────
  'pyspark', 'spark', 'hadoop', 'kafka', 'airflow', 'dbt', 'pandas', 'numpy',
  'scikit-learn', 'tensorflow', 'pytorch', 'huggingface',
  'machine learning', 'deep learning', 'nlp', 'llm', 'generative ai',
  'data engineering', 'data science', 'power bi', 'tableau', 'looker',
  'data analytics', 'analytics', 'data', 'ai',
  // ── Cloud / Infra ──────────────────────────────────────────────────────
  'aws', 'azure', 'gcp', 'google cloud',
  'kubernetes', 'k8s', 'docker', 'terraform', 'ansible', 'helm',
  'github actions', 'ci/cd', 'jenkins', 'gitlab',
  'serverless', 'microservices', 'linux', 'bash',
  // ── Practices / Domains ────────────────────────────────────────────────
  'devops', 'mlops', 'devsecops', 'sre',
  'rest', 'graphql', 'grpc', 'api',
  'agile', 'scrum', 'git',
  'security', 'blockchain', 'ios', 'android', 'mobile',
  // ── Enterprise / Business Tools ────────────────────────────────────────
  'salesforce', 'workday', 'oracle', 'sap', 'adobe', 'workfront',
  'servicenow', 'tableau', 'excel', 'power bi',
  // ── Generic Roles / Skills ─────────────────────────────────────────────
  'architect', 'engineer', 'developer', 'lead', 'manager', 'consultant',
]

/**
 * Extract recognised tech skills from free-form text.
 * Returns up to 20 unique lowercase skill strings.
 */
export function extractSkillsFromText(text) {
  if (!text) return []
  const lower = text.toLowerCase()
  const found = []
  for (const skill of TECH_SKILLS) {
    // Allow a word-boundary match OR plain includes for multi-word skills
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = skill.includes(' ')
      ? escaped           // multi-word: plain substring is fine
      : `(?<![a-z0-9])${escaped}(?![a-z0-9])`  // single-word: boundary check
    if (new RegExp(pattern, 'i').test(lower)) {
      found.push(skill)
    }
    if (found.length >= 20) break
  }
  return found
}
