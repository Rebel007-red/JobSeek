/**
 * LinkedIn guest jobs API handler
 *
 * Uses LinkedIn's public (unauthenticated) HTML job search endpoint.
 * No API key required. Returns HTML job cards which are parsed to JSON.
 *
 * NOTE: LinkedIn may rate-limit or block IPs that make many requests.
 * This is run at most once per day via scrape-boards.yml.
 *
 * In companies.json / Supabase:
 *   ats_type: "linkedin"
 *   api_url:  URL-encoded search keywords, e.g. "data engineer pyspark databricks"
 *   slug:     location, e.g. "India"
 */

import { parse } from 'node-html-parser'
import { extractSkillsFromText } from './skills-extractor.js'
import { loadFilterSkills } from './load-user-skills.js'

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search'
const PAGE_SIZE = 25
const MAX_PAGES = 2   // ~50 results per query
const MAX_JOBS = 20   // Tighter: max 20 high-quality jobs (was 50)
const MIN_SKILL_KEYWORDS = 2  // Must match at least 2 skill keywords

// Skills will be loaded dynamically at runtime
let SKILL_KEYWORDS = []

// ── ADD YOUR JOB TITLES HERE ─────────────────────────────────────────────────
// Each entry fetches up to 250 LinkedIn jobs. No API quota — add freely!
// location: 'India' filters to India-based roles. Covers all Indian cities + Remote
// Targeted: Python/Databricks/PySpark mid-level roles (2-5 years)
// ─────────────────────────────────────────────────────────────────────────────
const QUERIES = [
  { keywords: 'pyspark databricks data engineer 2-5 years', location: 'India' },
  { keywords: 'pyspark databricks engineer mid level', location: 'India' },
  { keywords: 'databricks pyspark python engineer', location: 'India' },
]

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.linkedin.com/',
}

function parseJobCard(card) {
  // The card is an <li>, but data-entity-urn is on the inner <div>
  const divEl = card.querySelector('div.base-search-card')
  const urn = divEl?.getAttribute('data-entity-urn') || ''
  const jobId = urn.split(':').pop() || ''

  // Try multiple selectors for title (fallback chain)
  let titleEl = card.querySelector('.base-search-card__title')
  if (!titleEl) titleEl = card.querySelector('h3')
  if (!titleEl) titleEl = card.querySelector('span.sr-only')  // Accessibility fallback

  // Try multiple selectors for company
  let companyEl = card.querySelector('.base-search-card__subtitle')
  if (!companyEl) companyEl = card.querySelector('h4')
  if (!companyEl) companyEl = card.querySelector('span[data-entity-urn*="company"]')

  // Try multiple selectors for location
  let locationEl = card.querySelector('.job-search-card__location')
  if (!locationEl) locationEl = card.querySelector('.base-search-card__metadata span')

  // Try multiple selectors for link
  let linkEl = card.querySelector('a.base-card__full-link')
  if (!linkEl) linkEl = card.querySelector('a[href*="/jobs/view/"]')
  if (!linkEl) linkEl = card.querySelector('a[href*="jobPosting"]')

  const timeEl = card.querySelector('time')

  const url = linkEl?.getAttribute('href')?.split('?')[0]

  // If no title or job_id, return null (invalid card)
  if (!jobId || !titleEl?.text?.trim?.()) return null

  return {
    job_id: jobId,
    title: titleEl.text.trim(),
    location: locationEl?.text.trim() || null,
    department: null,
    url: url || `https://www.linkedin.com/jobs/view/${jobId}/`,
    posted_at: timeEl?.getAttribute('datetime') || null,
    _company: companyEl?.text.trim() || null,
  }
}

export async function fetchLinkedInJobs(company) {
  // Load user's preferred skills for filtering
  SKILL_KEYWORDS = await loadFilterSkills()
  
  const allJobs = []
  const seenIds = new Set()
  const matchedJobIds = new Set()  // Track jobs that pass skill filter

  for (const query of QUERIES) {
    if (allJobs.length >= MAX_JOBS) break  // Stop at 50 total jobs

    console.log(`    → Fetching LinkedIn: "${query.keywords}"${query.location ? ` in "${query.location}"` : ' (global)'}`)
    let pageJobs = 0

    for (let page = 0; page < MAX_PAGES; page++) {
      if (allJobs.length >= MAX_JOBS) break  // Stop at 50 total jobs

      const params = new URLSearchParams({
        keywords: query.keywords,
        ...(query.location ? { location: query.location } : {}),
        f_TPR: 'r86400',   // last 24 hours (86400 seconds)
        count: String(PAGE_SIZE),
        start: String(page * PAGE_SIZE),
      })

      let res
      try {
        res = await fetch(`${BASE}?${params}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(15000),
        })
      } catch (e) {
        throw new Error(`LinkedIn fetch failed: ${e.message}`)
      }

      if (res.status === 429) throw new Error('LinkedIn rate limited')
      if (!res.ok) throw new Error(`LinkedIn error: ${res.status}`)

      const html = await res.text()
      if (!html.trim()) break

      const root = parse(html)
      const cards = root.querySelectorAll('li')

      if (cards.length === 0) break

      let newThisPage = 0
      for (const card of cards) {
        if (allJobs.length >= MAX_JOBS) break  // Stop at 20 total jobs
        const job = parseJobCard(card)
        if (job && !seenIds.has(job.job_id)) {
          seenIds.add(job.job_id)
          allJobs.push(job)
          newThisPage++
        }
      }

      pageJobs += newThisPage
      if (newThisPage === 0) break
      if (allJobs.length >= MAX_JOBS) break  // Stop at 50 total jobs

      // Polite delay between pages
      await new Promise(r => setTimeout(r, 1500))
    }

    // ── Fetch job descriptions and filter by skills ──
    // First fetch descriptions for all jobs from this query
    for (const job of allJobs.slice(-pageJobs)) {
      job.skills = await fetchLinkedInJobSkills(job.job_id)
      job.description = job.skills.join(' ')  // Store as description for skill matching
      
      // Check if job matches skill filter
      const desc = (job.description || '').toLowerCase()
      const title = (job.title || '').toLowerCase()
      const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length
      if (matchCount >= MIN_SKILL_KEYWORDS) {
        matchedJobIds.add(job.job_id)
      }
      
      await new Promise(r => setTimeout(r, 300))
    }

    const matchCount = Array.from(matchedJobIds).filter(id => 
      allJobs.slice(-pageJobs).some(j => j.job_id === id)
    ).length
    console.log(`      Found ${pageJobs} jobs, ${matchCount} match skills`)
  }

  // Return only jobs that matched the skill filter
  return allJobs.filter(j => matchedJobIds.has(j.job_id))
}

// Fetch a single LinkedIn job's description via the guest jobPosting API
async function fetchLinkedInJobSkills(jobId) {
  try {
    const res = await fetch(
      `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`,
      { headers: HEADERS, signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) return []
    const html = await res.text()
    const root = parse(html)
    // Try multiple selectors for the description block
    const descEl =
      root.querySelector('.show-more-less-html__markup') ||
      root.querySelector('.description__text') ||
      root.querySelector('section.description')
    return descEl ? extractSkillsFromText(descEl.text) : []
  } catch {
    return []
  }
}
