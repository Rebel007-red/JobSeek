// Test JSearch query 2
const apiKey = process.env.RAPIDAPI_KEY

console.log('🔍 Testing JSearch Query 2...\n')

try {
  const r = await fetch('https://jsearch.p.rapidapi.com/search-v2?query=pyspark+databricks+engineer+mid+level+remote&page=1&num_pages=1', {
    headers: {'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'},
    signal: AbortSignal.timeout(10000)
  })
  
  const json = await r.json()
  const jobs = json.data?.jobs || []
  console.log('Query 2 results:', jobs.length, 'jobs\n')

  if (jobs.length > 0) {
    const SKILLS = ['pyspark', 'databricks', 'spark', 'sql', 'python']
    const MIN_SKILLS = 2

    console.log('First 3 jobs analysis:')
    for (let i = 0; i < Math.min(3, jobs.length); i++) {
      const job = jobs[i]
      const desc = (job.job_description || '').toLowerCase()
      const title = (job.job_title || '').toLowerCase()
      const matches = SKILLS.filter(kw => desc.includes(kw) || title.includes(kw)).length
      const loc = [job.job_city, job.job_state, job.job_country].filter(Boolean).join(', ')
      const passesLocation = loc.toLowerCase().includes('remote') || loc.toLowerCase().includes('in')

      console.log(`\n${i+1}. ${job.job_title}`)
      console.log(`   Location: ${loc}`)
      console.log(`   Passes location filter? ${passesLocation ? '✅' : '❌'}`)
      console.log(`   Skill matches: ${matches}/${SKILLS.length} (need ${MIN_SKILLS})`)
      console.log(`   Would be included? ${passesLocation && matches >= MIN_SKILLS ? '✅' : '❌'}`)
    }
  }

} catch (e) {
  console.error('Error:', e.message)
}
