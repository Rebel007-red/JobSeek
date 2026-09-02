// Test fixed LinkedIn scraper
import { fetchLinkedInJobs } from './scraper/linkedin.js'

console.log('🧪 Testing fixed LinkedIn scraper...\n')

try {
  const jobs = await fetchLinkedInJobs()
  console.log(`\n✅ Success! Found ${jobs.length} jobs\n`)
  
  if (jobs.length > 0) {
    console.log('Sample job:')
    const job = jobs[0]
    console.log(`  Title: ${job.title}`)
    console.log(`  Company: ${job._company}`)
    console.log(`  Skills: ${(job.skills || []).slice(0, 3).join(', ')}`)
    console.log(`  URL: ${job.url}`)
  }
} catch (e) {
  console.error('❌ Error:', e.message)
}
