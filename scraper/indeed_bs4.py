#!/usr/bin/env python3
"""
Indeed Jobs Scraper (BeautifulSoup4)

Searches Indeed.com for Data Engineering jobs in India
Uses public search without API key.

Pattern: https://www.indeed.com/jobs?q={keyword}&l={location}&sort=date
"""

import requests
from bs4 import BeautifulSoup
import json
import sys
import time

# Fix encoding for Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ─── CONFIG ────────────────────────────────────────────────────────────
SKILL_KEYWORDS = ["pyspark", "databricks", "spark", "sql", "python", "data"]
MIN_SKILL_KEYWORDS = 1
MAX_JOBS = 100

SEARCH_QUERIES = [
    {"q": "Data Engineer Databricks", "l": "India"},
    {"q": "Data Engineer PySpark", "l": "India"},
    {"q": "Databricks Engineer", "l": "India"},
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.indeed.com",
}

TIMEOUT = 15
DELAY_BETWEEN_REQUESTS = 1.0


# ─── PARSING ───────────────────────────────────────────────────────────
def parse_indeed_job(job_card):
    """Parse a single Indeed job card from HTML."""
    try:
        # Extract job ID
        job_id = job_card.get("data-jk") or job_card.get("id", "").replace("job_", "")
        if not job_id:
            return None
        
        # Extract title
        title_el = job_card.find("h2", class_="jobTitle")
        if not title_el:
            title_el = job_card.find("a", class_="jcs-MatchedSearch")
        title = title_el.get_text(strip=True) if title_el else None
        if not title:
            return None
        
        # Extract company
        company_el = job_card.find("span", class_="companyName")
        if not company_el:
            company_el = job_card.find("div", class_="company")
        company = company_el.get_text(strip=True) if company_el else None
        
        # Extract location
        location_el = job_card.find("div", class_="companyLocation")
        if not location_el:
            location_el = job_card.find("div", attrs={"data-testid": "text-location"})
        location = location_el.get_text(strip=True) if location_el else None
        
        # Extract job URL
        link_el = job_card.find("a", class_="jcs-MatchedSearch")
        if not link_el:
            link_el = job_card.find("a", {"data-jk": True})
        url = link_el.get("href", "") if link_el else ""
        if url and not url.startswith("http"):
            url = "https://www.indeed.com" + url
        
        # Extract snippet (description)
        snippet_el = job_card.find("div", class_="snippet")
        description = snippet_el.get_text(strip=True) if snippet_el else ""
        
        return {
            "job_id": job_id,
            "title": title,
            "company": company,
            "location": location,
            "url": url,
            "posted_at": None,  # Indeed doesn't easily provide posted date in list view
            "description": description,
        }
    except Exception as e:
        return None


def matches_skills(job):
    """Check if job matches skill keywords."""
    text = (job.get("title") or "") + " " + (job.get("description") or "")
    text_lower = text.lower()
    
    matched = sum(1 for skill in SKILL_KEYWORDS if skill in text_lower)
    return matched >= MIN_SKILL_KEYWORDS


def extract_skills_array(text):
    """Extract skill keywords from text."""
    if not text:
        return []
    
    skills = []
    keywords = ["pyspark", "databricks", "spark", "sql", "python", "aws", "gcp", "azure"]
    text_lower = (text or "").lower()
    
    for skill in keywords:
        if skill in text_lower:
            skills.append(skill)
    
    return list(set(skills))


# ─── MAIN SCRAPER ──────────────────────────────────────────────────────
def fetch_indeed_jobs():
    """Main scraper: search Indeed and scrape jobs."""
    all_jobs = []
    seen_ids = set()
    
    for query in SEARCH_QUERIES:
        if len(all_jobs) >= MAX_JOBS:
            break
        
        q = query.get("q", "")
        l = query.get("l", "")
        
        print(f"[SEARCH] Indeed: '{q}' in {l}", file=sys.stderr)
        
        # Build search URL
        params = {
            "q": q,
            "l": l,
            "sort": "date",
            "start": 0,
            "limit": 50,
        }
        
        try:
            url = "https://www.indeed.com/jobs"
            resp = requests.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)
            resp.raise_for_status()
            
            soup = BeautifulSoup(resp.text, "html.parser")
            
            # Find job cards
            job_cards = soup.find_all("div", class_="job_seen_beacon")
            if not job_cards:
                # Try alternative selectors
                job_cards = soup.find_all("div", {"data-jk": True})
            
            if not job_cards:
                print(f"[WARN] No jobs found for query: {q}", file=sys.stderr)
                continue
            
            print(f"[PARSE] Found {len(job_cards)} job cards", file=sys.stderr)
            
            query_jobs = 0
            for card in job_cards:
                if len(all_jobs) >= MAX_JOBS:
                    break
                
                job = parse_indeed_job(card)
                if job and job["job_id"] not in seen_ids:
                    # Check skill match
                    if matches_skills(job):
                        job["skills"] = extract_skills_array(job["description"])
                        all_jobs.append(job)
                        seen_ids.add(job["job_id"])
                        query_jobs += 1
            
            print(f"[MATCH] {query_jobs} jobs matched skills", file=sys.stderr)
            
        except Exception as e:
            print(f"[ERROR] Query '{q}': {e}", file=sys.stderr)
            continue
        
        time.sleep(DELAY_BETWEEN_REQUESTS)
    
    return all_jobs


if __name__ == "__main__":
    try:
        jobs = fetch_indeed_jobs()
        
        # Output JSON to stdout
        print(json.dumps(jobs, default=str))
        
        # Stats to stderr
        print(f"\n[OK] Total jobs: {len(jobs)}", file=sys.stderr)
        for job in jobs[:3]:
            print(f"  - {job['title'][:40]:40s} at {job['company']}", file=sys.stderr)
        
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
