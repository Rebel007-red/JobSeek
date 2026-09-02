// Test Greenhouse API
// Greenhouse uses public boards with URL slugs like: hibob, guidepoint, etc.

const testSlugs = [
  'hibob',        // Popular tech company
  'guidepoint',   // Another popular
  'gitlab',       // GitLab
  'notion',       // Notion
  'stripe',       // Stripe
  'databricks',   // Databricks itself!
]

console.log('🔍 Testing Greenhouse boards...\n')

for (const slug of testSlugs) {
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, {
      signal: AbortSignal.timeout(8000)
    })
    
    if (!r.ok) {
      console.log(`${slug}: ❌ ${r.status}`)
      continue
    }
    
    const json = await r.json()
    const jobs = json.jobs || []
    console.log(`${slug}: ✅ Found ${jobs.length} jobs`)
    
    if (jobs.length > 0) {
      // Show sample job to understand structure
      const job = jobs[0]
      console.log(`  Sample: "${job.title}"`)
      console.log(`  Location: ${job.location?.name || 'N/A'}`)
      console.log(`  Content length: ${(job.content || '').length} chars`)
    }
  } catch (e) {
    console.log(`${slug}: Error - ${e.message}`)
  }
}
