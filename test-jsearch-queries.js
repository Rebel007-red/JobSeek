// Test new JSearch queries
const apiKey = process.env.RAPIDAPI_KEY

console.log('🔍 Testing new JSearch queries...\n')

const newQueries = [
  'pyspark databricks data engineer',
  'pyspark databricks engineer remote',
  'databricks python engineer',
]

try {
  for (const query of newQueries) {
    const r = await fetch(`https://jsearch.p.rapidapi.com/search-v2?query=${encodeURIComponent(query)}&page=1&num_pages=1&date_posted=today&country=in`, {
      headers: {'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'},
      signal: AbortSignal.timeout(10000)
    })
    
    const json = await r.json()
    const count = json.data?.jobs?.length || 0
    console.log(`"${query}" → ${count} jobs`)
  }

} catch (e) {
  console.error('Error:', e.message)
}
