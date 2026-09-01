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

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search'
const PAGE_SIZE = 25
const MAX_PAGES = 10  // up to 250 results per query

// Hardcoded queries (same as JSearch) for consistency
const QUERIES = [
  { keywords: 'data engineer python pyspark databricks', location: 'India' },
  { keywords: 'java developer spring boot react', location: 'India' },
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
  const allJobs = []
  const seenIds = new Set()

  for (const query of QUERIES) {
    console.log(`    → Fetching LinkedIn: "${query.keywords}" in "${query.location}"`)
    let pageJobs = 0

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        keywords: query.keywords,
        location: query.location,
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
        const job = parseJobCard(card)
        if (job && !seenIds.has(job.job_id)) {
          seenIds.add(job.job_id)
          allJobs.push(job)
          newThisPage++
        }
      }

      pageJobs += newThisPage
      if (newThisPage === 0) break

      // Polite delay between pages
      await new Promise(r => setTimeout(r, 1500))
    }

    console.log(`      Found ${pageJobs} jobs`)
  }

  return allJobs
}
