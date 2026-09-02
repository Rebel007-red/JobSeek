/**
 * Phenom People handler
 *
 * Phenom People career sites expose job data via their search-results page
 * with a ?format=json query parameter.
 *
 * The `api_url` in companies.json should be the base locale path, e.g.:
 *   https://careers.services.global.ntt/global/en
 *   https://jobs-ta.pwc.com/global/en
 *
 * The scraper calls: GET {api_url}/search-results?format=json&from=N
 * Job data lives in: response.ddoResults.eagerLoadRefineSearch.data.jobs
 */

const PAGE_SIZE = 10 // Phenom default page size
const MAX_JOBS = 50  // Limit to 50 high-quality jobs
const MAX_AGE_MS = 24 * 3600 * 1000  // 24 hours in ms
const MIN_SKILL_KEYWORDS = 2  // Must match at least 2 skill keywords
let SKILL_KEYWORDS = []

import { extractSkillsFromText } from './skills-extractor.js'
import { loadFilterSkills } from './load-user-skills.js'

export async function fetchPhenomJobs(company) {
  // Load user's preferred skills for filtering
  SKILL_KEYWORDS = await loadFilterSkills()
  
  const { api_url } = company
  if (!api_url) {
    throw new Error(`Phenom company "${company.name}" is missing api_url in companies.json`)
  }

  const baseUrl = api_url.replace(/\/$/, '') // strip trailing slash
  const allJobs = []
  let from = 0
  let total = null

  while (total === null || allJobs.length < total) {
    if (allJobs.length >= MAX_JOBS) break  // Stop at 50 jobs

    const url = `${baseUrl}/search-results?format=json&from=${from}&s=1`

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json, text/javascript, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: `${baseUrl}/search-results`,
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      throw new Error(`Phenom API error for ${company.name}: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    const searchData = data?.ddoResults?.eagerLoadRefineSearch

    if (!searchData) {
      throw new Error(`Phenom unexpected response structure for ${company.name}`)
    }

    if (total === null) {
      total = searchData.totalHits || 0
    }

    const jobs = searchData?.data?.jobs || []
    if (jobs.length === 0) break

    jobs.forEach((job) => {
      if (allJobs.length >= MAX_JOBS) return  // Stop at 50 jobs

      // 24hr freshness check
      const postedDate = new Date(job.postedDate || job.modifiedDate || 0)
      if (Date.now() - postedDate.getTime() > MAX_AGE_MS) return
      
      // Quality filter — pyspark/databricks focus
      const desc = (job.description || '').toLowerCase()
      const title = (job.title || '').toLowerCase()
      const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length
      if (matchCount < MIN_SKILL_KEYWORDS) return

      const jobId = String(job.jobId || job.reqId || job.jobSeqNo || `${from}-${allJobs.length}`)
      // Prefer the applyUrl; fall back to building the canonical job page URL
      const jobUrl = job.applyUrl && job.applyUrl.startsWith('http')
        ? job.applyUrl
        : `${baseUrl}/job/${job.jobId}/${encodeURIComponent((job.title || '').replace(/\s+/g, '-').toLowerCase())}`
      
      const skills = extractSkillsFromText(job.description || '')

      allJobs.push({
        job_id: jobId,
        title: job.title || 'Untitled',
        location: job.location || job.cityState || job.city || null,
        department: job.category || job.department || null,
        url: jobUrl,
        posted_at: job.postedDate || null,
        skills: skills || [],
      })
    })

    if (allJobs.length >= MAX_JOBS) break
    from += jobs.length
    if (allJobs.length >= total) break
  }

  return allJobs
}
