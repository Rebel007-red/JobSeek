/**
 * iCIMS handler
 *
 * iCIMS hosts career sites at: https://{slug}.icims.com
 * The public JSON job feed endpoint is:
 *   GET https://{slug}.icims.com/jobs/search?pr=0&format=json
 *
 * To find a company's iCIMS slug:
 *   Open their career page, look at the URL — it will contain "{company}.icims.com"
 *   The slug is the subdomain portion (e.g. "careers-acme" from "careers-acme.icims.com")
 *
 * The `slug` field in companies.json should be just the subdomain, e.g. "careers-acme"
 */

const PAGE_SIZE = 100
const MAX_JOBS = 50  // Limit to 50 high-quality jobs
const MAX_AGE_MS = 24 * 3600 * 1000  // 24 hours in ms
const MIN_SKILL_KEYWORDS = 2  // Must match at least 2 skill keywords
let SKILL_KEYWORDS = []

import { extractSkillsFromText } from './skills-extractor.js'
import { loadFilterSkills } from './load-user-skills.js'

export async function fetchICIMSJobs(company) {
  // Load user's preferred skills for filtering
  SKILL_KEYWORDS = await loadFilterSkills()
  
  const { slug } = company
  if (!slug) {
    throw new Error(`iCIMS company "${company.name}" is missing slug in companies.json`)
  }

  const baseUrl = `https://${slug}.icims.com`
  const allJobs = []
  let page = 0
  let total = null

  while (total === null || allJobs.length < total) {
    if (allJobs.length >= MAX_JOBS) break  // Stop at 50 jobs

    const url = `${baseUrl}/jobs/search?pr=${page * PAGE_SIZE}&format=json&in_iframe=1`

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; JobAggregator/1.0)',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      throw new Error(`iCIMS API error for ${company.name}: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    const jobs = data.searchResults || data.jobs || []

    if (total === null) {
      total = data.totalCount || data.count || data.total || jobs.length
    }

    if (jobs.length === 0) break

    jobs.forEach((job) => {
      if (allJobs.length >= MAX_JOBS) return  // Stop at 50 jobs

      // 24hr freshness check
      const postedDate = new Date(job.postDate || job.datePosted || 0)
      if (Date.now() - postedDate.getTime() > MAX_AGE_MS) return
      
      // Quality filter — pyspark/databricks focus
      const desc = (job.jobdescription || job.description || '').toLowerCase()
      const title = (job.jobtitle || job.title || job.jobTitle || '').toLowerCase()
      const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length
      if (matchCount < MIN_SKILL_KEYWORDS) return

      const jobId = String(job.id || job.jobId || job.requisitionId || `${page}-${allJobs.length}`)
      const jobUrl = job.detailUrl || job.applyUrl || job.url || `${baseUrl}/jobs/${jobId}`
      const skills = extractSkillsFromText(job.jobdescription || job.description || '')

      allJobs.push({
        job_id: jobId,
        title: job.jobtitle || job.title || job.jobTitle || 'Untitled',
        location: job.joblocation || job.location || job.city || null,
        department: job.jobcategory || job.category || job.department || null,
        url: jobUrl.startsWith('http') ? jobUrl : `${baseUrl}${jobUrl}`,
        skills: skills || [],
      })
    })

    if (allJobs.length >= MAX_JOBS) break
    page++
    if (allJobs.length >= total) break
  }

  return allJobs
}
