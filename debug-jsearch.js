// Debug JSearch API
const headers = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

try {
  console.log('🔍 Testing JSearch API...\n')

  const r = await fetch('https://jsearch.p.rapidapi.com/search?query=pyspark databricks data engineer&page=1&num_pages=1', {
    headers: {
      ...headers,
      'X-RapidAPI-Key': process.env.JSEARCH_API_KEY,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
    },
    signal: AbortSignal.timeout(10000)
  })

  console.log('Status:', r.status)
  console.log('Content-Type:', r.headers.get('content-type'))

  const txt = await r.text()
  console.log('Length:', txt.length)
  console.log('First 1000 chars:')
  console.log(txt.slice(0, 1000))

  if (txt.startsWith('{')) {
    const json = JSON.parse(txt)
    console.log('\n✅ Valid JSON!')
    console.log('Keys:', Object.keys(json))
    if (json.data) {
      console.log('Data length:', json.data.length)
      if (json.data[0]) {
        console.log('First job keys:', Object.keys(json.data[0]).slice(0, 10))
      }
    }
  }

} catch (e) {
  console.error('❌ Error:', e.message)
}
