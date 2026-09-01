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
 * Hardcoded queries (same as JSearch/LinkedIn) for consistency.
 */

// Try multiple login endpoints (Naukri API structure changes often)
const LOGIN_URLS = [
  'https://www.naukri.com/central-login-services/v1/login',  // Most likely (exists but needs right format)
  'https://www.naukri.com/login-service/v1/login',           // Fallback 1
]
const SEARCH_URL = 'https://www.naukri.com/jobapi/v3/search'

// Hardcoded queries (same as JSearch) for consistency
const QUERIES = [
  { keyword: 'data engineer python pyspark databricks', location: 'india' },
  { keyword: 'java developer spring boot react', location: 'india' },
]

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

  let lastError = null

  // Try each login endpoint until one succeeds
  for (const loginUrl of LOGIN_URLS) {
    try {
      const res = await fetch(loginUrl, {
        method: 'POST',
        headers: BASE_HEADERS,
        body: JSON.stringify({ username: email, password }),
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        lastError = new Error(`${loginUrl}: ${res.status} ${res.statusText}`)
        continue  // Try next endpoint
      }

      const data = await res.json()

      // Token is in different fields depending on Naukri API version
      const token = data?.data?.jwtToken
        || data?.jwtToken
        || data?.token
        || data?.data?.token

      if (!token) {
        lastError = new Error(`No token in response from ${loginUrl}`)
        continue
      }

      _cachedToken = token
      return token
    } catch (e) {
      lastError = e
    }
  }

  throw new Error(`Naukri login failed on all endpoints: ${lastError?.message || 'unknown'}`)
}

const PAGE_SIZE = 20
const MAX_PAGES = 5  // up to 100 results per query

export async function fetchNaukriJobs(company) {
  const token = await getNaukriToken()
  const allJobs = []

  for (const query of QUERIES) {
    console.log(`    → Fetching Naukri: "${query.keyword}" in "${query.location}"`)
    let queryJobs = 0

    for (let page = 1; page <= MAX_PAGES; page++) {
      const params = new URLSearchParams({
        noOfResults: String(PAGE_SIZE),
        urlType: 'search_by_key_loc',
        searchType: 'adv',
        keyword: query.keyword,
        location: query.location,
        experience: '0',
        page: String(page),
        k: query.keyword,
        l: query.location,
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
        throw new Error('Naukri token expired — will retry on next run')
      }

      if (!res.ok) {
        throw new Error(`Naukri API error: ${res.status} ${res.statusText}`)
      }

      const data = await res.json()
      const jobs = data.jobDetails || data.jobs || []
      if (jobs.length === 0) break

      jobs.forEach((job) => {
        const jobId = String(job.jobId || job.jobid || `naukri-${page}-${queryJobs}`)
        const url = job.jdURL
          ? `https://www.naukri.com${job.jdURL}`
          : `https://www.naukri.com/job-listings-${jobId}`

        allJobs.push({
          job_id: jobId,
          title: job.jobTitle || 'Untitled',
          location: job.jobLocations?.[0] || job.location || null,
          department: null,
          url,
          posted_at: job.createdDate || null,
        })
        queryJobs++
      })

      if (jobs.length < PAGE_SIZE) break

      // Polite delay between pages
      await new Promise(r => setTimeout(r, 1000))
    }

    console.log(`      Found ${queryJobs} jobs`)
  }

  return allJobs
}
