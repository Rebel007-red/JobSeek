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
const PAGE_SIZE = 10  // fixed per page by API
const MAX_PAGES = 3   // up to 30 results per query
// ── ADD YOUR JOB TITLES HERE ─────────────────────────────────────────────────
// Each entry = 1 RapidAPI call × 3 pages = 30 jobs
// Free tier: 200 calls/month → max 6 entries (6 × 3 × ~30 days = 180 calls)
// ─────────────────────────────────────────────────────────────────────────────
const QUERIES = [
  'data engineer python pyspark databricks',
  'java developer spring boot react',
  // 'frontend developer react typescript',
  // 'devops engineer kubernetes aws',
]

async function fetchQueryJobs(query) {
  const apiKey = process.env.RAPIDAPI_KEY
  if (!apiKey) throw new Error('Missing RAPIDAPI_KEY env var — add it to GitHub Actions secrets')

  const queryJobs = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      query,
      page: String(page),
      num_pages: '1',
      country: 'us',
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
      queryJobs.push({
        job_id: job.job_id || `jsearch-${Date.now()}-${Math.random()}`.replace(/\D/g, ''),
        title: job.job_title || 'Untitled',
        location: [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', ') || null,
        department: job.job_category || null,
        url: job.job_apply_link || job.job_google_link || '#',
        posted_at: job.job_posted_at_datetime_utc || null,
      })
    })

    if (jobs.length < PAGE_SIZE) break

    // Respect rate limiting
    await new Promise(r => setTimeout(r, 500))
  }

  return queryJobs
}

export async function fetchJSearchJobs(company) {
  const allJobs = []

  for (const query of QUERIES) {
    console.log(`    → Fetching JSearch: "${query}"`)
    const jobs = await fetchQueryJobs(query)
    console.log(`      Found ${jobs.length} jobs`)
    allJobs.push(...jobs)
  }

  return allJobs
}
