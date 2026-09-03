#!/usr/bin/env python3
"""
LinkedIn Guest Jobs API Parser (BeautifulSoup4)

Clean, simple approach using BS4 for robust HTML parsing.
- Searches for Data Engineering & Databricks roles in India
- Matches skills in title + description
- Returns up to 50 jobs per search
"""

import requests
from bs4 import BeautifulSoup
from datetime import datetime
import time
import sys
import json

# Fix encoding for Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ─── CONFIG ────────────────────────────────────────────────────────────
BASE_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"

QUERIES = [
    {"keywords": "Data Engineering", "location": "India"},
    {"keywords": "Databricks", "location": "India"},
]

SKILL_KEYWORDS = ["pyspark", "databricks", "spark", "sql", "python", "data"]
MIN_SKILL_KEYWORDS = 1  # At least 1 skill must match

MAX_JOBS = 50
PAGE_SIZE = 25
MAX_PAGES = 3  # ~75 results available

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.linkedin.com/",
}

TIMEOUT = 15
DELAY_BETWEEN_PAGES = 1.5  # seconds
DELAY_BETWEEN_DESCRIPTIONS = 0.5  # seconds


# ─── PARSING ───────────────────────────────────────────────────────────
def parse_job_card(card):
    """Parse a single LinkedIn job card to JSON."""
    try:
        # Extract job ID from data-entity-urn
        div = card.find("div", class_="base-search-card")
        if not div:
            return None
        
        urn = div.get("data-entity-urn", "")
        job_id = urn.split(":")[-1] if urn else None
        if not job_id:
            return None

        # Extract title
        title_el = card.find("h3", class_="base-search-card__title")
        title = title_el.get_text(strip=True) if title_el else None
        if not title:
            return None

        # Extract company
        company_el = card.find("h4", class_="base-search-card__subtitle")
        company = company_el.get_text(strip=True) if company_el else None

        # Extract location
        location_el = card.find("span", class_="job-search-card__location")
        location = location_el.get_text(strip=True) if location_el else None

        # Extract posted date
        time_el = card.find("time")
        posted_at = time_el.get("datetime") if time_el else None

        # Extract URL
        link_el = card.find("a", class_="base-card__full-link")
        url = link_el.get("href") if link_el else None
        if url:
            url = url.split("?")[0]  # Remove query params

        return {
            "job_id": job_id,
            "title": title,
            "company": company,
            "location": location,
            "url": url or f"https://www.linkedin.com/jobs/view/{job_id}/",
            "posted_at": posted_at,
            "description": None,  # Will fetch later
        }
    except Exception as e:
        print(f"    [WARN] Error parsing card: {e}", file=sys.stderr)
        return None


def fetch_job_description(job_id):
    """Fetch full job description via jobPosting API."""
    try:
        url = f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        
        if resp.status_code != 200:
            return None
        
        soup = BeautifulSoup(resp.text, "html.parser")
        
        # Try multiple selectors for description
        desc_el = (
            soup.find("div", class_="show-more-less-html__markup")
            or soup.find("div", class_="description__text")
            or soup.find("section", class_="description")
        )
        
        return desc_el.get_text(" ", strip=True) if desc_el else None
    except Exception as e:
        print(f"    ⚠ Error fetching description for {job_id}: {e}", file=sys.stderr)
        return None


def matches_skills(job):
    """Check if job title + description match skill keywords."""
    text = (job["title"] or "") + " " + (job["description"] or "")
    text_lower = text.lower()
    
    matched = sum(1 for skill in SKILL_KEYWORDS if skill in text_lower)
    return matched >= MIN_SKILL_KEYWORDS


# ─── MAIN SCRAPER ──────────────────────────────────────────────────────
def fetch_linkedin_jobs():
    """Fetch jobs from LinkedIn with BS4 parsing."""
    all_jobs = []
    seen_ids = set()
    
    for query in QUERIES:
        if len(all_jobs) >= MAX_JOBS:
            break
        
        keywords = query["keywords"]
        location = query.get("location", "")
        
        print(f"  [SEARCH] Keywords: '{keywords}' in {location}", file=sys.stderr)
        query_jobs = 0
        
        for page in range(MAX_PAGES):
            if len(all_jobs) >= MAX_JOBS:
                break
            
            params = {
                "keywords": keywords,
                "location": location,
                "f_TPR": "r86400",  # Last 24 hours
                "count": PAGE_SIZE,
                "start": page * PAGE_SIZE,
            }
            
            try:
                resp = requests.get(BASE_URL, params=params, headers=HEADERS, timeout=TIMEOUT)
                resp.raise_for_status()
            except requests.exceptions.RequestException as e:
                print(f"    [ERROR] Fetch error: {e}", file=sys.stderr)
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
        
        print(f"    [OK] Found {query_jobs} jobs from this search", file=sys.stderr)
    
    # ─── Fetch descriptions and filter by skills ────
    print(f"[FETCH] Fetching descriptions ({len(all_jobs)} jobs)...", file=sys.stderr)
    matched_jobs = []
    
    for i, job in enumerate(all_jobs, 1):
        job["description"] = fetch_job_description(job["job_id"])
        
        if matches_skills(job):
            matched_jobs.append(job)
        
        if i % 5 == 0:
            print(f"    [OK] {i}/{len(all_jobs)} processed", file=sys.stderr)
        
        time.sleep(DELAY_BETWEEN_DESCRIPTIONS)
    
    print(f"[FILTER] Skill filter: {len(matched_jobs)}/{len(all_jobs)} jobs matched", file=sys.stderr)
    return matched_jobs


if __name__ == "__main__":
    
    try:
        jobs = fetch_linkedin_jobs()
        
        # Output JSON to stdout (for Node.js integration)
        print(json.dumps(jobs, default=str))
        
        # Stats to stderr (for logging) - avoid special chars on Windows
        print(f"\n[OK] Total jobs: {len(jobs)}", file=sys.stderr)
        for job in jobs[:3]:
            print(f"  - {job['title'][:40]:40s} ({job['location'] or 'N/A'})", file=sys.stderr)
        
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
