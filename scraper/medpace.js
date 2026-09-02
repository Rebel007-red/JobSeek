/**
 * Medpace careers scraper — IBM Talent Suite (Jibe) ATS
 *
 * Public API endpoint: GET https://careers.medpace.com/api/jobs
 * Query params: q (search text), start (offset), num (page size), lang (en-us)
 *
 * Pagination: response includes `totalCount` and `count` (results on this page)
 */

import { extractSkillsFromText } from './skills-extractor.js'
import { loadFilterSkills } from './load-user-skills.js'

const BASE = 'https://careers.medpace.com/api/jobs'
const SITE = 'https://careers.medpace.com'
const PAGE_SIZE = 50
const MAX_JOBS = 50  // Limit to 50 high-quality jobs
const MAX_AGE_MS = 7 * 24 * 3600 * 1000  // 7 days (extended from 24 hours)
const MIN_SKILL_KEYWORDS = 1  // Must match at least 1 skill keyword (relaxed from 2)
let SKILL_KEYWORDS = []

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: SITE + '/',
}

export async function fetchMedpaceJobs(_company) {
  // Load user's preferred skills for filtering
  SKILL_KEYWORDS = await loadFilterSkills()
  
  const allJobs = []
  const seenIds = new Set()
  let start = 0
  let total = null

  while (total === null || allJobs.length < total) {
    if (allJobs.length >= MAX_JOBS) break  // Stop at 50 jobs

    const params = new URLSearchParams({ q: '', start: String(start), num: String(PAGE_SIZE), lang: 'en-us' })
    let res
    try {
      res = await fetch(`${BASE}?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    } catch (e) {
      throw new Error(`Medpace fetch failed: ${e.message}`)
    }
    if (res.status === 429) throw new Error('Medpace rate limited')
    if (!res.ok) throw new Error(`Medpace API error: ${res.status}`)

    const data = await res.json()
    if (total === null) total = data.totalCount || data.count || 0

    const jobs = data.jobs || []
    if (jobs.length === 0) break

    for (const entry of jobs) {
      if (allJobs.length >= MAX_JOBS) break  // Stop at 50 jobs

      const job = entry.data || entry
      const id = String(job.slug || job.req_id || job.id || '')
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)

      // 7-day freshness check
      const postedDate = new Date(job.posted_date || job.create_date || 0)
      if (Date.now() - postedDate.getTime() > MAX_AGE_MS) continue
      
      // Quality filter — pyspark/databricks focus
      const description = job.description ? job.description.replace(/<[^>]+>/g, ' ').toLowerCase() : ''
      const title = (job.title || '').toLowerCase()
      const matchCount = SKILL_KEYWORDS.filter(kw => description.includes(kw) || title.includes(kw)).length
      if (matchCount < MIN_SKILL_KEYWORDS) continue

      const location = [job.city, job.country].filter(Boolean).join(', ') || job.location_name || job.full_location || null
      const url = `${SITE}/jobs/${id}/`   // description page
      const rawDate = job.posted_date || job.create_date || null
      const posted_at = rawDate ? new Date(rawDate).toISOString() : null

      allJobs.push({
        job_id: id,
        title: job.title || 'Untitled',
        location,
        department: job.department || job.category || null,
        url,
        posted_at,
        skills: extractSkillsFromText(`${job.title} ${job.department || ''} ${description}`),
      })
    }

    if (allJobs.length >= MAX_JOBS) break
    start += jobs.length
    if (jobs.length < PAGE_SIZE) break

    // Polite delay
    await new Promise(r => setTimeout(r, 800))
  }

  return allJobs
}
