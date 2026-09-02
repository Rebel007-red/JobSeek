/**
 * Google Jobs search handler
 *
 * Uses Google's public job search results via direct search.
 * Scrapes HTML results from google.com/search with job listing filters.
 *
 * In companies.json / Supabase:
 *   ats_type: "google-jobs"
 *   api_url:  URL-encoded search keywords
 *   slug:     "google-jobs"
 */

import { parse } from 'node-html-parser'
import { extractSkillsFromText } from './skills-extractor.js'
import { loadFilterSkills } from './load-user-skills.js'

const MAX_PAGES = 2   // ~20 results per page
const MAX_JOBS = 30   // Max 30 high-quality jobs from Google
const MIN_SKILL_KEYWORDS = 2  // Must match at least 2 skill keywords
let SKILL_KEYWORDS = []

// ── Search queries ────────────────────────────────────────────────────────
const QUERIES = [
  'pyspark databricks data engineer 2-5 years india',
  'pyspark databricks engineer mid level',
  'databricks pyspark python engineer india',
]

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  Referer: 'https://www.google.com/',
  DNT: '1',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
}

function extractJobsFromHTML(html) {
  try {
    const root = parse(html)
    const jobs = []
    
    // Google job listings appear in various formats
    // Try multiple selectors for job cards
    const jobCards = root.querySelectorAll('[data-cid]') || []
    
    for (const card of jobCards) {
      try {
        // Extract title
        const titleEl = card.querySelector('h2') || card.querySelector('[role="heading"]')
        const title = titleEl?.text?.trim()
        if (!title) continue
        
        // Extract company
        const companyEl = card.querySelector('.vNEEBe') || card.querySelector('[role="link"]')
        const company = companyEl?.text?.trim() || 'Unknown'
        
        // Extract location
        const locEl = card.querySelector('.s75CSd') || card.querySelector('.Kkduyf')
        const location = locEl?.text?.trim() || null
        
        // Extract job URL
        const linkEl = card.querySelector('a[href*="google.com/url"]')
        let url = linkEl?.getAttribute('href')
        
        // Extract description snippet
        const descEl = card.querySelector('.HBvzbc')
        const description = descEl?.text?.trim() || ''
        
        // Generate job_id from title + company
        const job_id = `google_${Buffer.from(`${title}_${company}`).toString('hex').slice(0, 16)}`
        
        // Validate skill keywords
        const fullText = `${title} ${company} ${description}`.toLowerCase()
        const matchCount = SKILL_KEYWORDS.filter(kw => fullText.includes(kw)).length
        
        if (matchCount < MIN_SKILL_KEYWORDS) continue
        
        // Extract skills
        const skills = extractSkillsFromText(`${title} ${description}`)
        
        jobs.push({
          job_id,
          title,
          location,
          department: null,
          url: url || `https://google.com/search?q=${encodeURIComponent(title + ' ' + company)}`,
          posted_at: null, // Google doesn't reliably provide posted date
          description: description || title,
          skills: skills || [],
        })
      } catch (e) {
        console.error('  Error parsing card:', e.message)
        continue
      }
    }
    
    return jobs
  } catch (e) {
    console.error('  Error parsing HTML:', e.message)
    return []
  }
}

export async function fetchGoogleJobsJobs() {
  // Load user's preferred skills for filtering
  SKILL_KEYWORDS = await loadFilterSkills()
  
  const allJobs = []
  const seenIds = new Set()
  
  for (const query of QUERIES) {
    if (allJobs.length >= MAX_JOBS) break
    
    console.log(`  → Fetching Google Jobs: "${query}"...`)
    
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        if (allJobs.length >= MAX_JOBS) break
        
        const start = page * 20
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}+site:google.com/jobs&start=${start}`
        
        const response = await fetch(searchUrl, {
          headers: HEADERS,
          signal: AbortSignal.timeout(12000),
        })
        
        if (!response.ok) {
          console.error(`    Page ${page}: HTTP ${response.status}`)
          continue
        }
        
        const html = await response.text()
        const jobs = extractJobsFromHTML(html)
        
        let added = 0
        for (const job of jobs) {
          if (allJobs.length >= MAX_JOBS) break
          if (!seenIds.has(job.job_id)) {
            seenIds.add(job.job_id)
            allJobs.push(job)
            added++
          }
        }
        
        console.log(`    Page ${page}: ${added} new jobs`)
        
        // Polite delay between pages
        await new Promise(r => setTimeout(r, 1000))
      }
      
      console.log(`  Found ${allJobs.length} total jobs`)
    } catch (e) {
      console.error(`  ERROR: ${e.message}`)
      // Continue to next query
    }
  }
  
  return allJobs
}
