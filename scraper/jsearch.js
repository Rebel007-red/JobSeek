/**
 * JSearch (RapidAPI) handler — aggregates Google Jobs, Indeed, Glassdoor, etc.
 *
 * Free tier: 500 requests/month. Used for daily role-specific job searches.
 *
 * In companies.json / Supabase:
 *   ats_type: "jsearch"
 *   api_url:  search query, e.g. "data engineer python pyspark databricks"
 *   slug:     location,     e.g. "India"
 *
 * Requires env var: RAPIDAPI_KEY
 */

const RAPID_HOST = 'jsearch.p.rapidapi.com'
const PAGE_SIZE = 10  // max per call on free tier
const MAX_PAGES = 3   // up to 30 results per query per day

export async function fetchJSearchJobs(company) {
  const { api_url: query, slug: location } = company
  if (!query) throw new Error(`JSearch company "${company.name}" missing api_url (search query)`)

  const apiKey = process.env.RAPIDAPI_KEY
  if (!apiKey) throw new Error('Missing RAPIDAPI_KEY env var — add it to GitHub Actions secrets')

  const allJobs = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      query: location ? `${query} in ${location}` : query,
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
      if (res.status === 429) throw new Error(`JSearch rate limit exceeded for "${company.name}"`)
      throw new Error(`JSearch API error for "${company.name}": ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    const jobs = data.data || []
    if (jobs.length === 0) break

    jobs.forEach((job) => {
      allJobs.push({
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

  return allJobs
}
