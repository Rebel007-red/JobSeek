// Test different JSearch query variations
const apiKey = process.env.RAPIDAPI_KEY

console.log('🔍 Testing JSearch query variations...\n')

const queries = [
  { q: 'pyspark databricks data engineer', dateFilter: true },
  { q: 'pyspark databricks data engineer', dateFilter: false },
  { q: 'pyspark databricks engineer', dateFilter: true },
  { q: 'pyspark databricks engineer', dateFilter: false },
  { q: 'pyspark databricks engineer mid level remote', dateFilter: false },  // Original working
]

try {
  for (const {q, dateFilter} of queries) {
    const params = new URLSearchParams({
      query: q,
      page: '1',
      num_pages: '1',
      country: 'in',
    })
    if (dateFilter) params.set('date_posted', 'today')

    const r = await fetch(`https://jsearch.p.rapidapi.com/search-v2?${params}`, {
      headers: {'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'},
      signal: AbortSignal.timeout(10000)
    })
    
    const json = await r.json()
    const count = json.data?.jobs?.length || 0
    const filter = dateFilter ? '(date=today)' : '(no date filter)'
    console.log(`"${q}" ${filter} → ${count} jobs`)
  }

} catch (e) {
  console.error('Error:', e.message)
}
