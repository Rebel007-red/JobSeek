/**
 * Indeed Jobs Scraper - Python BS4 Edition
 * 
 * Searches Indeed.com for Data Engineer + Databricks jobs in India
 */

import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function fetchIndeedJobs(company) {
  try {
    console.log(`    → Indeed (Python BS4)`)

    // Execute Python scraper script
    const pythonScript = path.join(__dirname, 'indeed_bs4.py')
    const output = execSync(`python "${pythonScript}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Parse JSON output
    const jobs = JSON.parse(output)

    if (!Array.isArray(jobs)) {
      console.log(`      ✗ Invalid response from Python scraper`)
      return []
    }

    // Format for Supabase insert
    const formattedJobs = jobs.map(job => ({
      job_id: job.job_id,
      title: job.title,
      location: job.location || null,
      department: null,
      url: job.url,
      posted_at: job.posted_at,
      description: job.description,
      skills: job.skills || [],
    }))

    console.log(`      ✓ Found ${formattedJobs.length} jobs`)
    return formattedJobs
  } catch (err) {
    console.error(`      ✗ Indeed scraper error:`, err.message)
    return []
  }
}
