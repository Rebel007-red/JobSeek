/**
 * SAP SuccessFactors Career Site handler
 *
 * SAP SuccessFactors Career Site v2 exposes a public REST API at:
 *   GET https://{domain}/api/apply/v2/jobs?domain={domain}&start=0&num=100&locale=en_US
 *
 * The `slug` in companies.json should be the career site domain, e.g. "careers.ey.com"
 *
 * To verify a company uses SuccessFactors:
 *   Open their career page → view page source or DevTools → look for "successfactors.com"
 *   in script/CDN references (e.g. rmkcdn.successfactors.com)
 */

const PAGE_SIZE = 50      // Limited to 50 per page
const MAX_JOBS = 12       // Tighter: max 12 per company board (was 50)
const MAX_AGE_MS = 24 * 3600 * 1000  // 24 hours in ms
const MIN_SKILL_KEYWORDS = 2  // Must match at least 2 skill keywords
let SKILL_KEYWORDS = []

import { loadFilterSkills } from './load-user-skills.js'

export async function fetchSuccessFactorsJobs(company) {
  // Load user's preferred skills for filtering
  SKILL_KEYWORDS = await loadFilterSkills()
  const { slug } = company
  if (!slug) {
    throw new Error(
      `SuccessFactors company "${company.name}" is missing slug (career site domain) in companies.json`
    )
  }

  const domain = slug // e.g. "careers.ey.com"
  const allJobs = []
  let start = 0
  let total = null

  while (total === null || allJobs.length < MAX_JOBS) {
    const url =
      `https://${domain}/api/apply/v2/jobs` +
      `?domain=${encodeURIComponent(domain)}&start=${start}&num=${PAGE_SIZE}&locale=en_US`

    let res
    try {
      res = await fetch(url, {
        headers: {
          Accept: 'application/json, text/javascript, */*',
          'User-Agent': 'Mozilla/5.0 (compatible; JobAggregator/1.0)',
          Referer: `https://${domain}/`,
        },
        signal: AbortSignal.timeout(15000),  // 15 second timeout
      })
    } catch (e) {
      throw new Error(
        `SuccessFactors fetch failed for ${company.name} (${domain}): ${e.message}`
      )
    }

    if (!res.ok) {
      throw new Error(
        `SuccessFactors API error for ${company.name}: ${res.status} ${res.statusText}`
      )
    }

    const data = await res.json()
    const jobs = data.data || data.jobs || data.results || []

    if (total === null) {
      total = data.total || data.totalCount || data.count || jobs.length
    }

    if (jobs.length === 0) break

    const now = Date.now()
    for (const job of jobs) {
      if (allJobs.length >= MAX_JOBS) break  // Stop at 12 jobs

      // Filter: only keep jobs posted in last 24 hours
      const postedDate = new Date(job.postedDate || job.postingDate || job.createdDate || 0)
      if (now - postedDate.getTime() > MAX_AGE_MS) {
        continue  // Skip jobs older than 24 hours
      }

      // Quality filter for SuccessFactors — pyspark/databricks focus
      const desc = (job.description || job.jobDescription || '').toLowerCase()
      const title = (job.title || job.jobTitle || '').toLowerCase()
      const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length
      if (matchCount < MIN_SKILL_KEYWORDS) continue  // Skip if doesn't match pyspark/databricks focus

      const jobId = String(
        job.jobId || job.id || job.externalJobId || `${start}-${allJobs.length}`
      )
      const jobPath = job.applyUrl || job.jobUrl || job.detailUrl || ''
      const absoluteUrl = jobPath.startsWith('http')
        ? jobPath
        : `https://${domain}${jobPath || `/jobs/${jobId}`}`

      allJobs.push({
        job_id: jobId,
        title: job.title || job.jobTitle || 'Untitled',
        location: job.location || job.city || job.country || null,
        department: job.department || job.category || job.businessArea || null,
        url: absoluteUrl,
        posted_at: postedDate.toISOString() || null,
      })
    }

    if (allJobs.length >= MAX_JOBS) break
    start += jobs.length
    if (allJobs.length >= total) break
  }

  return allJobs
}
