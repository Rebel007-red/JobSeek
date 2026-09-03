#!/usr/bin/env python3
"""
Workday Jobs Scraper (BeautifulSoup4)

Fetches all Workday companies from Supabase, iterates through each,
and scrapes their jobs endpoint for matching roles.

Pattern: {api_url} points to full endpoint
Example: https://omnissa.wd501.myworkdayjobs.com/wday/cxs/omnissa/Omnissa_External_Career_Site/jobs
"""

import requests
from bs4 import BeautifulSoup
import json
import sys
import time
import os

# Fix encoding for Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ─── CONFIG ────────────────────────────────────────────────────────────
SKILL_KEYWORDS = ["pyspark", "databricks", "spark", "sql", "python", "data"]
MIN_SKILL_KEYWORDS = 1
MAX_JOBS_PER_COMPANY = 50
MAX_TOTAL_JOBS = 200

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
    "Accept-Language": "en-US,en;q=0.9",
}

TIMEOUT = 15
DELAY_BETWEEN_REQUESTS = 1.0


# ─── SUPABASE ──────────────────────────────────────────────────────────
def get_workday_companies():
    """Fetch all enabled Workday companies from Supabase."""
    try:
        from supabase import create_client
        
        url = os.getenv('VITE_SUPABASE_URL') or 'https://deczscnmmxpgpayyxglk.supabase.co'
        key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
        
        if not key:
            print("[WARN] SUPABASE_SERVICE_ROLE_KEY not set, skipping DB query", file=sys.stderr)
            return []
        
        supabase = create_client(url, key)
        
        response = supabase.table('companies').select('id,name,api_url,slug').eq('ats_type', 'workday').eq('disabled', False).execute()
        
        companies = response.data or []
        print(f"[FETCH] Found {len(companies)} Workday companies in DB", file=sys.stderr)
        return companies
    except Exception as e:
        print(f"[ERROR] Failed to query companies: {e}", file=sys.stderr)
        # Fallback to hardcoded if DB fails
        return [
            {"id": "00000001-0000-0000-0000-000000000004", "name": "Omnissa", "api_url": "https://omnissa.wd501.myworkdayjobs.com/wday/cxs/omnissa/Omnissa_External_Career_Site/jobs", "slug": "omnissa"}
        ]


# ─── PARSING ───────────────────────────────────────────────────────────
def parse_jobs_from_html(html, company_name):
    """Extract jobs from Workday HTML using BeautifulSoup."""
    jobs = []
    try:
        soup = BeautifulSoup(html, "html.parser")
        
        # Workday typically uses data attributes for job listings
        # Look for common Workday job card patterns
        job_cards = soup.find_all("a", {"data-automation": "jobTitle"})
        
        if not job_cards:
            # Try alternative selectors
            job_cards = soup.find_all("div", class_="jobCardTitle")
        
        if not job_cards:
            # Last resort: look for any links containing job-like text
            job_cards = soup.find_all("a", class_=lambda x: x and ("job" in x.lower() or "title" in x.lower()))
        
        for card in job_cards:
            try:
                # Extract title
                title = card.get_text(strip=True)
                if not title or len(title) < 3:
                    continue
                
                # Extract URL
                url = card.get("href", "")
                if not url:
                    continue
                
                # Make URL absolute
                if url.startswith("/"):
                    base = "/".join(url.split("/")[:3]) if card.find_parent("a") else ""
                    url = base + url if base else url
                
                # Generate job_id from URL
                job_id = url.split("/")[-1] or title.lower().replace(" ", "-")
                
                jobs.append({
                    "job_id": job_id,
                    "title": title,
                    "company": company_name,
                    "location": None,  # Workday doesn't always show in list
                    "url": url,
                    "posted_at": None,
                    "description": title,  # Will enhance after fetching
                })
            except Exception as e:
                continue
        
        return jobs
    except Exception as e:
        print(f"[WARN] Error parsing HTML: {e}", file=sys.stderr)
        return []


def fetch_job_details(job_url):
    """Fetch full job description from job posting page."""
    try:
        resp = requests.get(job_url, headers=HEADERS, timeout=TIMEOUT)
        if resp.status_code != 200:
            return None
        
        soup = BeautifulSoup(resp.text, "html.parser")
        
        # Try to extract description
        desc_selectors = [
            soup.find("div", {"data-automation": "jobDescription"}),
            soup.find("div", class_="jobDescription"),
            soup.find("section", {"data-automation": "jobDetails"}),
        ]
        
        for selector in desc_selectors:
            if selector:
                return selector.get_text(" ", strip=True)
        
        return None
    except Exception as e:
        return None


def matches_skills(job):
    """Check if job matches skill keywords."""
    text = (job["title"] or "") + " " + (job["description"] or "")
    text_lower = text.lower()
    
    matched = sum(1 for skill in SKILL_KEYWORDS if skill in text_lower)
    return matched >= MIN_SKILL_KEYWORDS


def extract_skills_array(description):
    """Extract skill keywords from description."""
    if not description:
        return []
    
    skills = []
    keywords = ["pyspark", "databricks", "spark", "sql", "python", "aws", "gcp", "azure", "scala", "java"]
    text = (description or "").lower()
    
    for skill in keywords:
        if skill in text:
            skills.append(skill)
    
    return list(set(skills))


# ─── MAIN SCRAPER ──────────────────────────────────────────────────────
def fetch_workday_jobs():
    """Main scraper: fetch all Workday companies and scrape jobs."""
    all_jobs = []
    seen_ids = set()
    
    companies = get_workday_companies()
    
    if not companies:
        print("[ERROR] No Workday companies found", file=sys.stderr)
        return []
    
    for company in companies:
        if len(all_jobs) >= MAX_TOTAL_JOBS:
            break
        
        company_name = company.get("name", "Unknown")
        api_url = company.get("api_url")
        
        if not api_url:
            print(f"[SKIP] {company_name}: No api_url", file=sys.stderr)
            continue
        
        print(f"[FETCH] {company_name}: {api_url[:60]}...", file=sys.stderr)
        
        try:
            # Fetch jobs list page
            resp = requests.get(api_url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
            resp.raise_for_status()
            
            # Parse jobs from HTML
            company_jobs = parse_jobs_from_html(resp.text, company_name)
            
            if not company_jobs:
                print(f"[WARN] {company_name}: No jobs found in HTML", file=sys.stderr)
                continue
            
            print(f"[PARSE] {company_name}: Found {len(company_jobs)} jobs", file=sys.stderr)
            
            # Fetch descriptions and filter by skills
            matched_count = 0
            for job in company_jobs:
                if len(all_jobs) >= MAX_TOTAL_JOBS or job["job_id"] in seen_ids:
                    continue
                
                # Try to fetch full description
                job["description"] = fetch_job_details(job["url"]) or job["title"]
                
                # Check skill match
                if matches_skills(job):
                    job["skills"] = extract_skills_array(job["description"])
                    all_jobs.append(job)
                    seen_ids.add(job["job_id"])
                    matched_count += 1
                
                time.sleep(DELAY_BETWEEN_REQUESTS / 10)
            
            print(f"[MATCH] {company_name}: {matched_count}/{len(company_jobs)} matched skills", file=sys.stderr)
            
        except Exception as e:
            print(f"[ERROR] {company_name}: {e}", file=sys.stderr)
            continue
        
        time.sleep(DELAY_BETWEEN_REQUESTS)
    
    return all_jobs


if __name__ == "__main__":
    try:
        jobs = fetch_workday_jobs()
        
        # Output JSON to stdout
        print(json.dumps(jobs, default=str))
        
        # Stats to stderr
        print(f"\n[OK] Total jobs: {len(jobs)}", file=sys.stderr)
        for job in jobs[:3]:
            print(f"  - {job['title'][:40]:40s} at {job['company']}", file=sys.stderr)
        
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
