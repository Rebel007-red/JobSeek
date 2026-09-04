/**
 * Workday Jobs Scraper - Python BS4 Edition
 * 
 * Fetches jobs from all Workday companies (Rockwell, Fractal, MiQ, Dentsu)
 * using BeautifulSoup4 HTML parsing.
 */

import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function fetchWorkdayJobs(company) {
  try {
    console.log(`    → Workday: ${company.name}`)

    // Execute Python scraper script with company JSON via stdin
    const pythonScript = path.join(__dirname, 'workday_bs4.py')
    const companyJSON = JSON.stringify({
      id: company.id,
      name: company.name,
      api_url: company.api_url,
    })

    const output = execSync(`python "${pythonScript}"`, {
      input: companyJSON,
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
      skills: extractSkillsArray(job.description),
    }))

    console.log(`      ✓ Found ${formattedJobs.length} jobs`)
    return formattedJobs
  } catch (err) {
    console.error(`      ✗ Workday scraper error:`, err.message)
    return []
  }
}

/**
 * Extract skill keywords from job description
 */
function extractSkillsArray(description) {
  if (!description) return []

  const skills = []
  const keywords = [
    'pyspark',
    'databricks',
    'spark',
    'sql',
    'python',
    'aws',
    'gcp',
    'azure',
    'scala',
    'java',
  ]
  const text = (description || '').toLowerCase()

  for (const skill of keywords) {
    if (text.includes(skill)) {
      skills.push(skill)
    }
  }

  return [...new Set(skills)]
}
