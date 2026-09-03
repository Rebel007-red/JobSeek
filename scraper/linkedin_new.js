/**
 * LinkedIn Scraper - Python BS4 version
 * 
 * Calls the Python script and returns structured job data
 * integrated with Supabase
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { loadFilterSkills } from './load-user-skills.js'

const execAsync = promisify(exec)

// Update the Python scraper to return JSON
const PYTHON_SCRIPT = `
import json
import requests
from bs4 import BeautifulSoup
import sys
import time

BASE_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"

QUERIES = [
    {"keywords": "Data Engineering", "location": "India"},
    {"keywords": "Databricks", "location": "India"},
]

SKILL_KEYWORDS = ["pyspark", "databricks", "spark", "sql", "python", "data"]
MIN_SKILL_KEYWORDS = 1
MAX_JOBS = 50
PAGE_SIZE = 25
MAX_PAGES = 3

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.linkedin.com/",
}

TIMEOUT = 15
DELAY_BETWEEN_PAGES = 1.5
DELAY_BETWEEN_DESCRIPTIONS = 0.5

def parse_job_card(card):
    try:
        div = card.find("div", class_="base-search-card")
        if not div:
            return None
        
        urn = div.get("data-entity-urn", "")
        job_id = urn.split(":")[-1] if urn else None
        if not job_id:
            return None

        title_el = card.find("h3", class_="base-search-card__title")
        title = title_el.get_text(strip=True) if title_el else None
        if not title:
            return None

        company_el = card.find("h4", class_="base-search-card__subtitle")
        company = company_el.get_text(strip=True) if company_el else None

        location_el = card.find("span", class_="job-search-card__location")
        location = location_el.get_text(strip=True) if location_el else None

        time_el = card.find("time")
        posted_at = time_el.get("datetime") if time_el else None

        link_el = card.find("a", class_="base-card__full-link")
        url = link_el.get("href") if link_el else None
        if url:
            url = url.split("?")[0]

        return {
            "job_id": job_id,
            "title": title,
            "company": company,
            "location": location,
            "url": url or f"https://www.linkedin.com/jobs/view/{job_id}/",
            "posted_at": posted_at,
            "description": None,
        }
    except:
        return None

def fetch_job_description(job_id):
    try:
        url = f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        
        if resp.status_code != 200:
            return None
        
        soup = BeautifulSoup(resp.text, "html.parser")
        desc_el = (
            soup.find("div", class_="show-more-less-html__markup")
            or soup.find("div", class_="description__text")
            or soup.find("section", class_="description")
        )
        
        return desc_el.get_text(" ", strip=True) if desc_el else None
    except:
        return None

def matches_skills(job):
    text = (job["title"] or "") + " " + (job["description"] or "")
    text_lower = text.lower()
    matched = sum(1 for skill in SKILL_KEYWORDS if skill in text_lower)
    return matched >= MIN_SKILL_KEYWORDS

def fetch_linkedin_jobs():
    all_jobs = []
    seen_ids = set()
    
    for query in QUERIES:
        if len(all_jobs) >= MAX_JOBS:
            break
        
        keywords = query["keywords"]
        location = query.get("location", "")
        query_jobs = 0
        
        for page in range(MAX_PAGES):
            if len(all_jobs) >= MAX_JOBS:
                break
            
            params = {
                "keywords": keywords,
                "location": location,
                "f_TPR": "r86400",
                "count": PAGE_SIZE,
                "start": page * PAGE_SIZE,
            }
            
            try:
                resp = requests.get(BASE_URL, params=params, headers=HEADERS, timeout=TIMEOUT)
                resp.raise_for_status()
            except:
                break
            
            soup = BeautifulSoup(resp.text, "html.parser")
            cards = soup.find_all("li")
            
            if not cards:
                break
            
            page_jobs = 0
            for card in cards:
                if len(all_jobs) >= MAX_JOBS:
                    break
                
                job = parse_job_card(card)
                if job and job["job_id"] not in seen_ids:
                    seen_ids.add(job["job_id"])
                    all_jobs.append(job)
                    query_jobs += 1
                    page_jobs += 1
            
            if page_jobs == 0:
                break
            
            time.sleep(DELAY_BETWEEN_PAGES)
    
    matched_jobs = []
    
    for i, job in enumerate(all_jobs, 1):
        job["description"] = fetch_job_description(job["job_id"])
        
        if matches_skills(job):
            matched_jobs.append(job)
        
        time.sleep(DELAY_BETWEEN_DESCRIPTIONS)
    
    return matched_jobs

if __name__ == "__main__":
    try:
        jobs = fetch_linkedin_jobs()
        print(json.dumps(jobs, default=str))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
`

export async function fetchLinkedInJobs(company) {
  try {
    // Write Python script to temp file and execute
    const scriptPath = './scraper/linkedin_bs4.py'
    
    // Execute Python script
    const { stdout, stderr } = await execAsync(`python "${scriptPath}"`, {
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large responses
      timeout: 300000, // 5 minute timeout
    })
    
    if (stderr && !stderr.includes('processed')) {
      console.error('Python stderr:', stderr)
    }
    
    // Parse JSON output
    let jobs = JSON.parse(stdout)
    
    // Ensure it's an array
    if (!Array.isArray(jobs)) {
      console.warn('Expected array from Python script, got:', typeof jobs)
      return []
    }
    
    console.log(`    ✓ LinkedIn: ${jobs.length} jobs fetched and skill-filtered`)
    
    // Return with company_id for Supabase insert
    return jobs.map(job => ({
      ...job,
      company_id: company.id,
      department: null, // LinkedIn doesn't provide department
      skills: extractSkillsFromDescription(job.description),
    }))
    
  } catch (err) {
    console.error('LinkedIn scraper error:', err.message)
    return []
  }
}

// Helper: Extract skills from description
function extractSkillsFromDescription(description) {
  if (!description) return []
  
  const skills = []
  const keywords = ['pyspark', 'databricks', 'spark', 'sql', 'python', 'aws', 'gcp', 'azure']
  const text = (description || '').toLowerCase()
  
  for (const skill of keywords) {
    if (text.includes(skill)) {
      skills.push(skill)
    }
  }
  
  return [...new Set(skills)] // Remove duplicates
}
