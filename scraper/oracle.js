/**
 * Oracle Recruiting Cloud handler
 *
 * Oracle hosts career sites on Oracle Fusion HCM.
 * REST API: GET {host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *
 * The `api_url` in companies.json is the career site base URL, e.g.:
 *   https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001
 *
 * The `slug` is the siteNumber visible in that URL (e.g. CX_1001).
 *
 * To find these: open the company career page ? DevTools ? Network ? XHR/Fetch
 * ? look for a request containing "recruitingCEJobRequisitions" ? copy the
 * host+path and the siteNumber= param.
 */

const PAGE_SIZE = 100
const MAX_JOBS = 50  // Limit to 50 high-quality jobs
const MAX_AGE_MS = 24 * 3600 * 1000  // 24 hours in ms
const MIN_SKILL_KEYWORDS = 2  // Must match at least 2 skill keywords
let SKILL_KEYWORDS = []

import { extractSkillsFromText } from './skills-extractor.js'
import { loadFilterSkills } from './load-user-skills.js'

export async function fetchOracleJobs(company) {
  // Load user's preferred skills for filtering
  SKILL_KEYWORDS = await loadFilterSkills()
  
  const { api_url, slug: siteNumber } = company
  if (!api_url) {
    throw new Error(`Oracle company "${company.name}" is missing api_url in companies.json`)
  }
  if (!siteNumber) {
    throw new Error(`Oracle company "${company.name}" is missing slug (siteNumber) in companies.json`)
  }

  // Derive the REST API base from the career site URL
  // e.g. https://jpmc.fa.oraclecloud.com/hcmUI/... -> https://jpmc.fa.oraclecloud.com
  const host = new URL(api_url).origin
  const restBase = `${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`

  const allJobs = []
  let offset = 0
  let total = null

  while (total === null || allJobs.length < total) {
    if (allJobs.length >= MAX_JOBS) break  // Stop at 50 jobs

    const params = new URLSearchParams({
      expand: 'requisitionList',
      finder: `findReqs;siteNumber=${siteNumber},facetsList=TITLES%3BCATEGORIES%3BLOCATIONS`,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })

    const res = await fetch(`${restBase}?${params}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      throw new Error(`Oracle API error for ${company.name}: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()

    // Oracle wraps everything in items[0] which contains metadata + requisitionList
    const meta = data.items?.[0]
    if (!meta) break

    if (total === null) {
      total = meta.TotalJobsCount || 0
    }

    const jobs = meta.requisitionList || []
    if (jobs.length === 0) break

    jobs.forEach((job) => {
      if (allJobs.length >= MAX_JOBS) return  // Stop at 50 jobs

      // 24hr freshness check
      const postedDate = new Date(job.PostedDate || 0)
      if (Date.now() - postedDate.getTime() > MAX_AGE_MS) return
      
      // Quality filter — pyspark/databricks focus
      const desc = (job.Description || job.description || '').toLowerCase()
      const title = (job.Title || job.title || '').toLowerCase()
      const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length
      if (matchCount < MIN_SKILL_KEYWORDS) return

      const jobId = String(job.Id || `${offset}-${allJobs.length}`)
      // Build canonical job page URL
      const jobUrl = `${api_url.replace(/\/+$/, '')}/job/${jobId}`
      const skills = extractSkillsFromText(job.Description || job.description || '')

      allJobs.push({
        job_id: jobId,
        title: job.Title || 'Untitled',
        location: job.PrimaryLocation || null,
        department: job.JobFamily || job.JobFunction || job.Department || null,
        url: jobUrl,
        posted_at: job.PostedDate || null,
        skills: skills || [],
      })
    })

    if (allJobs.length >= MAX_JOBS) break
    offset += jobs.length
    if (allJobs.length >= total) break
  }

  return allJobs
}
