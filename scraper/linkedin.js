/**
 * LinkedIn Jobs Scraper - Python BS4 Edition
 * 
 * Executes Python script that uses BeautifulSoup4 for robust HTML parsing
 * - Searches: "Data Engineering" & "Databricks" in India
 * - Returns: 50 jobs max, filtered by skill match in title + description
 * - Skills matched: pyspark, databricks, spark, sql, python, data
 * 
 * Advantages over Node.js version:
 * - Better HTML parsing with BS4 (handles dynamic content better)
 * - Cleaner skill extraction
 * - Same execution time, more reliable
 * - Works in GitHub Actions without extra Node dependencies
 */

import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function fetchLinkedInJobs(company) {
  try {
    console.log(`    → LinkedIn (Python BS4)`)

    // Execute Python scraper script
    const pythonScript = path.join(__dirname, 'linkedin_bs4.py')
    const output = execSync(`python "${pythonScript}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      timeout: 300000, // 5 minutes
      stdio: ['pipe', 'pipe', 'pipe'], // Capture stdout, stderr, stdin
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
      company: job.company || null,
      location: job.location || null,
      department: null, // LinkedIn doesn't provide department
      url: job.url,
      posted_at: job.posted_at,
      description: job.description,
      skills: extractSkillsArray(job.description),
    }))

    console.log(`      ✓ Found ${formattedJobs.length} jobs (skill-filtered)`)
    return formattedJobs
  } catch (err) {
    console.error(`      ✗ LinkedIn scraper error:`, err.message)
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

  return [...new Set(skills)] // Remove duplicates
}
