// Debug Greenhouse filtering
import { extractSkillsFromText } from './scraper/skills-extractor.js'

const slug = 'databricks'
const SKILL_KEYWORDS = ['databricks', 'pyspark', 'sql', 'python']
const MIN_SKILL_KEYWORDS = 2
const MAX_AGE_MS = 24 * 3600 * 1000

console.log('🔍 Debugging Greenhouse filtering...\n')

try {
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, {
    signal: AbortSignal.timeout(10000)
  })
  
  const json = await r.json()
  const jobs = json.jobs || []
  
  console.log(`Total jobs from API: ${jobs.length}\n`)
  
  // Check freshness filter
  const now = Date.now()
  const fresh = jobs.filter(job => {
    const postedDate = new Date(job.first_published_at || 0)
    return now - postedDate.getTime() <= MAX_AGE_MS
  })
  
  console.log(`Jobs within 24 hours: ${fresh.length}`)
  
  // Check skill filter
  let skillMatches = 0
  let samples = []
  
  for (const job of fresh) {
    const desc = (job.content || '').toLowerCase()
    const title = (job.title || '').toLowerCase()
    const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length
    
    if (matchCount >= MIN_SKILL_KEYWORDS) {
      skillMatches++
      if (samples.length < 3) {
        samples.push({ title: job.title, matches: matchCount, location: job.location?.name })
      }
    }
  }
  
  console.log(`Jobs with ${MIN_SKILL_KEYWORDS}+ skill matches: ${skillMatches}`)
  
  if (samples.length > 0) {
    console.log('\nSample matching jobs:')
    samples.forEach(job => {
      console.log(`  - "${job.title}" (${job.matches} matches) at ${job.location}`)
    })
  }
  
  // Show sample of non-matching jobs to see why
  console.log('\nSample non-matching jobs:')
  for (let i = 0; i < Math.min(3, fresh.length); i++) {
    const job = fresh[i]
    const desc = (job.content || '').toLowerCase()
    const matches = SKILL_KEYWORDS.filter(kw => desc.includes(kw)).length
    console.log(`  - "${job.title}" (${matches} matches)`)
    console.log(`    Content preview: ${job.content?.slice(0, 100)}...`)
  }

} catch (e) {
  console.error('Error:', e.message)
}
