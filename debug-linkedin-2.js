// Debug LinkedIn seeMoreJobPostings endpoint
import { URLSearchParams } from 'url'

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search'

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.linkedin.com/',
}

try {
  console.log('🔍 Testing LinkedIn seeMoreJobPostings endpoint...\n')
  
  const params = new URLSearchParams({
    keywords: 'pyspark databricks data engineer',
    location: 'India',
    start: 0,
    count: 25
  })
  
  const url = `${BASE}?${params.toString()}`
  console.log('URL:', url.slice(0, 100) + '...')
  
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
  
  console.log('\n📊 Response:')
  console.log('  Status:', r.status)
  console.log('  Content-Type:', r.headers.get('content-type'))
  
  const txt = await r.text()
  console.log('  Length:', txt.length, 'bytes')
  console.log('  Is HTML?', txt.includes('<'))
  console.log('  Has job cards?', txt.includes('base-search-card'))
  console.log('  Has data-entity-urn?', txt.includes('data-entity-urn'))
  
  console.log('\n📋 First 2000 chars:')
  console.log(txt.slice(0, 2000))
  
  console.log('\n🎯 Job card count:', (txt.match(/<li/g) || []).length)
  
} catch(e) {
  console.error('❌ Error:', e.message)
}
