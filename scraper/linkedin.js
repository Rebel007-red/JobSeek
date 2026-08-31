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
const MAX_PAGES = 10  // up to 250 results

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.linkedin.com/',
}

function parseJobCard(card) {
  // Job ID from data-entity-urn="urn:li:jobPosting:1234"
  const urn = card.getAttribute('data-entity-urn') || ''
  const jobId = urn.split(':').pop() || ''

  const titleEl = card.querySelector('.base-search-card__title, h3')
  const companyEl = card.querySelector('.base-search-card__subtitle, h4')
  const locationEl = card.querySelector('.job-search-card__location, .base-search-card__metadata')
  const linkEl = card.querySelector('a.base-card__full-link, a[href*="/jobs/view/"]')
  const timeEl = card.querySelector('time')

  const url = linkEl?.getAttribute('href')?.split('?')[0]

  if (!jobId || !titleEl) return null

  return {
    job_id: jobId,
    title: titleEl.text.trim(),
    location: locationEl?.text.trim() || null,
    department: null,
    url: url || `https://www.linkedin.com/jobs/view/${jobId}/`,
    posted_at: timeEl?.getAttribute('datetime') || null,
    _company: companyEl?.text.trim() || null,  // LinkedIn includes the hiring company name
  }
}

export async function fetchLinkedInJobs(company) {
  const { api_url: keywords, slug: location } = company
  if (!keywords) throw new Error(`LinkedIn company "${company.name}" missing api_url (search keywords)`)

  const allJobs = []
  const seenIds = new Set()

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      keywords,
      location: location || 'India',
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
      throw new Error(`LinkedIn fetch failed for "${company.name}": ${e.message}`)
    }

    if (res.status === 429) throw new Error(`LinkedIn rate limited for "${company.name}"`)
    if (!res.ok) throw new Error(`LinkedIn error for "${company.name}": ${res.status}`)

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

    if (newThisPage === 0) break

    // Polite delay between pages
    await new Promise(r => setTimeout(r, 1500))
  }

  return allJobs
}
