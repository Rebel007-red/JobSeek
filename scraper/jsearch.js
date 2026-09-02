/**
 * JSearch (RapidAPI) handler — aggregates Google Jobs, Indeed, Glassdoor, etc.
 *
 * Free tier: 200 requests/month (not 500). Uses 2 hardcoded role queries:
 *   1. "data engineer python pyspark databricks"
 *   2. "java developer spring boot react"
 *
 * 3 pages × 2 queries = 6 calls/day × 30 days = 180/month ✅ within quota
 *
 * Ignores company.api_url and company.slug (hardcoded queries instead).
 * Uses `/search-v2` endpoint (working endpoint as of Sept 2026).
 * Requires env var: RAPIDAPI_KEY
 */

const RAPID_HOST = 'jsearch.p.rapidapi.com'
import { extractSkillsFromText } from './skills-extractor.js'
import { loadFilterSkills } from './load-user-skills.js'
const PAGE_SIZE = 10  // fixed per page by API
const MAX_PAGES = 3   // ~30 jobs per query max
const MAX_JOBS = 25   // Tighter: max 25 high-quality jobs per query (was 50)
const MIN_SKILL_KEYWORDS = 2  // Must match at least 2 keywords (Python + Spark/Databricks/ML)
let SKILL_KEYWORDS = []

// ── ADD YOUR JOB TITLES HERE ─────────────────────────────────────────────────
// Each entry = 1 RapidAPI call × 2 pages = 20 jobs
// Free tier: 200 calls/month → max 3 entries (3 × 2 × ~30 days = 180 calls)
// India-focused: Python/Databricks/PySpark mid-level roles
// ─────────────────────────────────────────────────────────────────────────────
const QUERIES = [
  `pyspark databricks data engineer 2-5 years india`,
  `pyspark databricks engineer mid level remote`,
  `databricks pyspark python engineer india`,
]

async function fetchQueryJobs(query) {
  const apiKey = process.env.RAPIDAPI_KEY
  if (!apiKey) throw new Error('Missing RAPIDAPI_KEY env var — add it to GitHub Actions secrets')

  const queryJobs = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (queryJobs.length >= MAX_JOBS) break  // Stop at 50 jobs

    const params = new URLSearchParams({
      query,
      page: String(page),
      num_pages: '1',
      date_posted: 'today',   // last 24 hours
      country: 'in',          // India only
      language: 'en',
    })

    const res = await fetch(`https://${RAPID_HOST}/search-v2?${params}`, {
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': RAPID_HOST,
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      if (res.status === 429) throw new Error(`JSearch rate limit (query="${query}")`)
      throw new Error(`JSearch API error for "${query}": ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    const jobs = data.data?.jobs || []
    if (jobs.length === 0) break

    jobs.forEach((job) => {
      if (queryJobs.length >= MAX_JOBS) return
      
      // Quality filters: must match skill keywords
      const desc = (job.job_description || '').toLowerCase()
      const title = (job.job_title || '').toLowerCase()
      const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length
      if (matchCount < MIN_SKILL_KEYWORDS) return  // Skip if too generic
      
      // Location check: India or Remote only
      const locStr = [job.job_city, job.job_state, job.job_country].join(' ').toLowerCase()
      if (!locStr.includes('india') && !locStr.includes('remote') && !job.job_country?.includes('IN')) return
      
      queryJobs.push({
        job_id: job.job_id || `jsearch-${Date.now()}-${Math.random()}`.replace(/\D/g, ''),
        title: job.job_title || 'Untitled',
        location: [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', ') || null,
        department: job.job_category || null,
        url: job.job_google_link || null,   // Google Jobs description link only (no apply forms)
        posted_at: job.job_posted_at_datetime_utc || null,
        skills: extractSkillsFromText(job.job_description || ''),
      })
    })

    if (queryJobs.length >= MAX_JOBS) break
    if (jobs.length < PAGE_SIZE) break

    // Respect rate limiting
    await new Promise(r => setTimeout(r, 500))
  }

  return queryJobs
}

export async function fetchJSearchJobs(company) {
  // Load user's preferred skills for filtering
  SKILL_KEYWORDS = await loadFilterSkills()
  
  const allJobs = []

  for (const query of QUERIES) {
    console.log(`    → Fetching JSearch: "${query}"`)
    const jobs = await fetchQueryJobs(query)
    console.log(`      Found ${jobs.length} jobs`)
    allJobs.push(...jobs)
  }

  return allJobs
}
