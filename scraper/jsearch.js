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
 * Requires env var: RAPIDAPI_KEY
 */

const RAPID_HOST = 'jsearch.p.rapidapi.com'
const PAGE_SIZE = 10  // max per call on free tier
const MAX_PAGES = 3   // up to 30 results per query
const QUERIES = [
  'data engineer python pyspark databricks',
  'java developer spring boot react',
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
      date_posted: 'month',
    })

    const res = await fetch(`https://${RAPID_HOST}/search?${params}`, {
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
    const jobs = data.data || []
    if (jobs.length === 0) break

    jobs.forEach((job) => {
      queryJobs.push({
        job_id: job.job_id || `${job.employer_name}-${job.job_title}-${page}`.replace(/\s+/g, '-'),
        title: job.job_title || 'Untitled',
        location: [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', ') || null,
        department: job.job_category || null,
        url: job.job_apply_link || job.job_google_link || '#',
        posted_at: job.job_posted_at_datetime_utc || null,
      })
    })

    if (jobs.length < PAGE_SIZE) break
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
