// Test Greenhouse scraper with Databricks
import { fetchGreenhouseJobs } from './scraper/greenhouse.js'

console.log('🧪 Testing Greenhouse scraper with Databricks...\n')

try {
  const company = { 
    name: 'Databricks', 
    slug: 'databricks',
    ats_type: 'greenhouse'
  }
  
  const jobs = await fetchGreenhouseJobs(company)
  console.log(`\n✅ Found ${jobs.length} jobs\n`)
  
  if (jobs.length > 0) {
    console.log('Sample jobs:')
    jobs.slice(0, 3).forEach((job, i) => {
      console.log(`\n${i+1}. ${job.title}`)
      console.log(`   Location: ${job.location}`)
      console.log(`   Posted: ${job.posted_at}`)
      console.log(`   URL: ${job.url}`)
    })
  }

} catch (e) {
  console.error('❌ Error:', e.message)
}
