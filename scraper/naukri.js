/**
 * Naukri.com authenticated job search handler
 *
 * Uses Naukri's internal API with JWT authentication to bypass reCAPTCHA.
 * Credentials are read from environment variables — NEVER hard-coded.
 *
 * Required GitHub Actions secrets:
 *   NAUKRI_EMAIL    — your Naukri account email
 *   NAUKRI_PASSWORD — your Naukri account password
 *
 * In Supabase companies table:
 *   ats_type: "naukri"
 *   api_url:  search keywords, e.g. "data engineer python pyspark"
 *   slug:     location, e.g. "india" (optional, defaults to india)
 */

const LOGIN_URL = 'https://www.naukri.com/central-login-services/v2/login'
const SEARCH_URL = 'https://www.naukri.com/jobapi/v3/search'

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  appid: '109',
  systemid: '109',
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Referer: 'https://www.naukri.com/',
}

let _cachedToken = null

async function getNaukriToken() {
  if (_cachedToken) return _cachedToken

  const email = process.env.NAUKRI_EMAIL
  const password = process.env.NAUKRI_PASSWORD

  if (!email || !password) {
    throw new Error('Missing NAUKRI_EMAIL or NAUKRI_PASSWORD env vars — add them to GitHub Actions secrets')
  }

  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: JSON.stringify({ username: email, password }),
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    throw new Error(`Naukri login failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json()

  // Token is in different fields depending on Naukri API version
  const token = data?.data?.jwtToken
    || data?.jwtToken
    || data?.token
    || data?.data?.token

  if (!token) {
    throw new Error(`Naukri login succeeded but no token found in response. Keys: ${Object.keys(data?.data || data || {}).join(', ')}`)
  }

  _cachedToken = token
  return token
}

const PAGE_SIZE = 20
const MAX_PAGES = 5  // up to 100 results per query

export async function fetchNaukriJobs(company) {
  const { api_url: keyword, slug: location } = company
  if (!keyword) throw new Error(`Naukri company "${company.name}" missing api_url (search keyword)`)

  const token = await getNaukriToken()
  const loc = location || 'india'

  const allJobs = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      noOfResults: String(PAGE_SIZE),
      urlType: 'search_by_key_loc',
      searchType: 'adv',
      keyword,
      location: loc,
      experience: '0',
      page: String(page),
      k: keyword,
      l: loc,
    })

    const res = await fetch(`${SEARCH_URL}?${params}`, {
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15000),
    })

    if (res.status === 401 || res.status === 403) {
      // Token expired — clear cache and retry once
      _cachedToken = null
      throw new Error(`Naukri token expired for "${company.name}" — will retry on next run`)
    }

    if (!res.ok) {
      throw new Error(`Naukri API error for "${company.name}": ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    const jobs = data.jobDetails || data.jobs || []
    if (jobs.length === 0) break

    jobs.forEach((job) => {
      const jobId = String(job.jobId || job.jobid || `naukri-${page}-${allJobs.length}`)
      const url = job.jdURL
        ? `https://www.naukri.com${job.jdURL}`
        : `https://www.naukri.com/job-listings-${jobId}`

      allJobs.push({
        job_id: jobId,
        title: job.title || job.jobTitle || 'Untitled',
        location: Array.isArray(job.placeholders)
          ? job.placeholders.find(p => p.type === 'location')?.label || loc
          : job.location || loc,
        department: job.functionalArea || job.category || null,
        url,
        posted_at: job.createdDate ? new Date(job.createdDate).toISOString() : null,
      })
    })

    if (jobs.length < PAGE_SIZE) break

    // Polite delay
    await new Promise(r => setTimeout(r, 1000))
  }

  return allJobs
}
