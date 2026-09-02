// Debug JSearch location and skill filtering
const apiKey = process.env.RAPIDAPI_KEY

console.log('🔍 Testing JSearch job data...\n')

try {
  const r = await fetch('https://jsearch.p.rapidapi.com/search-v2?query=pyspark+databricks+data+engineer+2-5+years+india&page=1&num_pages=1&date_posted=today&country=in', {
    headers: {
      'X-RapidAPI-Key': apiKey,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    },
    signal: AbortSignal.timeout(10000)
  })

  const json = await r.json()
  const jobs = json.data?.jobs || []
  
  console.log(`Found ${jobs.length} jobs from query: "pyspark databricks data engineer 2-5 years india"\n`)
  
  if (jobs.length > 0) {
    const SKILL_KEYWORDS = ['pyspark', 'databricks', 'spark', 'sql', 'python']
    const MIN_SKILL_KEYWORDS = 2

    for (let i = 0; i < Math.min(3, jobs.length); i++) {
      const job = jobs[i]
      
      const desc = (job.job_description || '').toLowerCase()
      const title = (job.job_title || '').toLowerCase()
      const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length
      
      const locStr = [job.job_city, job.job_state, job.job_country].join(' ').toLowerCase()
      const passesLocation = locStr.includes('india') || locStr.includes('remote') || job.job_country?.includes('IN')
      
      console.log(`Job ${i + 1}: ${job.job_title}`)
      console.log(`  Location fields: city=${job.job_city}, state=${job.job_state}, country=${job.job_country}`)
      console.log(`  Passes location filter? ${passesLocation ? '✅' : '❌'}`)
      console.log(`  Skill matches: ${matchCount} (need ${MIN_SKILL_KEYWORDS})`)
      console.log(`  Would pass? ${passesLocation && matchCount >= MIN_SKILL_KEYWORDS ? '✅' : '❌'}`)
      console.log()
    }
  }

} catch (e) {
  console.error('❌ Error:', e.message)
}
