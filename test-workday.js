// Test Workday scraper
import { fetchWorkdayJobs } from './scraper/workday.js'

console.log('🧪 Testing Workday scraper...\n')

// Mock company with a Workday API URL (we'll use a real one for testing)
const testCompanies = [
  { name: 'Cognizant', api_url: 'https://cognizant.wd1.myworkdayjobs.com/wday/cxs/cognizant/en-us/jobs' },
  { name: 'Accenture', api_url: 'https://accenture.wd1.myworkdayjobs.com/wday/cxs/accenture/en-us/jobs' },
  { name: 'TCS', api_url: 'https://tcs.wd1.myworkdayjobs.com/wday/cxs/tcs/en-us/jobs' },
]

try {
  for (const company of testCompanies) {
    console.log(`Testing ${company.name}...`)
    try {
      const jobs = await fetchWorkdayJobs(company)
      console.log(`  ✅ Found ${jobs.length} jobs`)
    } catch (e) {
      console.log(`  ❌ Error: ${e.message.slice(0, 60)}...`)
    }
  }
} catch (e) {
  console.error('❌ Error:', e.message)
}
