// Debug why LinkedIn jobs are being filtered out
import { parse } from 'node-html-parser'
import { URLSearchParams } from 'url'

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search'

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.linkedin.com/',
}

function parseJobCard(card) {
  const divEl = card.querySelector('div.base-search-card')
  const urn = divEl?.getAttribute('data-entity-urn') || ''
  const jobId = urn.split(':').pop() || ''

  let titleEl = card.querySelector('.base-search-card__title')
  if (!titleEl) titleEl = card.querySelector('h3')
  if (!titleEl) titleEl = card.querySelector('span.sr-only')

  let companyEl = card.querySelector('.base-search-card__subtitle')
  if (!companyEl) companyEl = card.querySelector('h4')

  let locationEl = card.querySelector('.job-search-card__location')
  if (!locationEl) locationEl = card.querySelector('.base-search-card__metadata span')

  let linkEl = card.querySelector('a.base-card__full-link')
  if (!linkEl) linkEl = card.querySelector('a[href*="/jobs/view/"]')

  const url = linkEl?.getAttribute('href')?.split('?')[0]

  if (!jobId || !titleEl?.text?.trim?.()) return null

  return {
    job_id: jobId,
    title: titleEl.text.trim(),
    location: locationEl?.text.trim() || null,
    url: url || `https://www.linkedin.com/jobs/view/${jobId}/`,
    _company: companyEl?.text.trim() || null,
    // ⚠️ NOTE: description is NOT extracted from card - that's the bug!
    description: null
  }
}

try {
  console.log('🔍 Testing LinkedIn job card parsing...\n')

  const params = new URLSearchParams({
    keywords: 'pyspark databricks data engineer',
    location: 'India',
    start: 0,
    count: 25
  })

  const r = await fetch(`${BASE}?${params.toString()}`, { headers, signal: AbortSignal.timeout(10000) })
  const html = await r.text()
  const root = parse(html)
  const cards = root.querySelectorAll('li')

  console.log(`Found ${cards.length} job cards\n`)

  const MIN_SKILL_KEYWORDS = 2
  const SKILL_KEYWORDS = ['pyspark', 'databricks', 'spark', 'sql', 'python']

  let filtered = 0
  for (let i = 0; i < Math.min(5, cards.length); i++) {
    const job = parseJobCard(cards[i])
    if (!job) {
      console.log(`Card ${i}: ❌ Failed to parse`)
      continue
    }

    const desc = (job.description || '').toLowerCase()  // Empty string!
    const title = (job.title || '').toLowerCase()

    const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length

    console.log(`Card ${i}:`)
    console.log(`  ✓ Job ID: ${job.job_id}`)
    console.log(`  ✓ Title: ${job.title}`)
    console.log(`  ✓ Company: ${job._company}`)
    console.log(`  ✓ Description: "${desc.slice(0, 50)}" (${desc.length} chars)`)
    console.log(`  🔍 Skill matches in title: ${matchCount}`)
    console.log(`  ${matchCount >= MIN_SKILL_KEYWORDS ? '✅' : '❌'} Passed filter (need ${MIN_SKILL_KEYWORDS})\n`)

    if (matchCount < MIN_SKILL_KEYWORDS) filtered++
  }

  console.log(`\n⚠️  Problem: ${filtered} jobs filtered out!`)
  console.log(`📌 Root cause: job.description is always null - it's not extracted from the card HTML`)
  console.log(`💡 Solution: Either:`)
  console.log(`   1. Extract description snippet from card HTML`)
  console.log(`   2. Fetch descriptions separately (as it does with fetchLinkedInJobSkills)`)
  console.log(`   3. Lower MIN_SKILL_KEYWORDS threshold`)
  console.log(`   4. Skip skill filtering at parse stage, do it after fetching descriptions`)

} catch (e) {
  console.error('❌ Error:', e.message)
}
