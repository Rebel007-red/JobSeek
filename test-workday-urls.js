// Test real Workday URLs from companies.json
const workdayCompanies = [
  { name: 'Omnissa', api_url: 'https://omnissa.wd501.myworkdayjobs.com/wday/cxs/omnissa/Omnissa_External_Career_Site/jobs' },
  { name: 'Google', api_url: 'https://google.wd501.myworkdayjobs.com/wday/cxs/google/GOCJobs/jobs' },
]

console.log('🔍 Testing real Workday URLs...\n')

for (const { name, api_url } of workdayCompanies) {
  console.log(`Testing ${name}...`)
  try {
    const res = await fetch(api_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; JobAggregator/1.0)',
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: 20,
        offset: 0,
        searchText: '',
      }),
      signal: AbortSignal.timeout(10000),
    })
    
    console.log(`  Status: ${res.status}`)
    const txt = await res.text()
    console.log(`  Response length: ${txt.length} bytes`)
    console.log(`  First 200 chars: ${txt.slice(0, 200)}`)
  } catch (e) {
    console.log(`  Error: ${e.message}`)
  }
  console.log()
}
