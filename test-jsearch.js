// Test JSearch scraper
import { fetchJSearchJobs } from './scraper/jsearch.js'

console.log('🧪 Testing JSearch scraper...\n')

try {
  const jobs = await fetchJSearchJobs()
  console.log(`\n✅ Found ${jobs.length} jobs\n`)
  
  if (jobs.length > 0) {
    console.log('Sample jobs:')
    jobs.slice(0, 3).forEach((job, i) => {
      console.log(`\n${i+1}. ${job.title}`)
      console.log(`   Company: ${job.employer_name || 'N/A'}`)
      console.log(`   Location: ${job.location}`)
      console.log(`   Skills: ${(job.skills || []).slice(0, 3).join(', ')}`)
    })
  } else {
    console.log('❌ No jobs found')
  }
} catch (e) {
  console.error('❌ Error:', e.message)
}
