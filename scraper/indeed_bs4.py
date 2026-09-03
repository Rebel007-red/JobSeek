#!/usr/bin/env python3
"""
Indeed Jobs Scraper (Playwright + RSS Fallback)

Searches Indeed.com for Data Engineering jobs in India
Uses Playwright headless browser (more reliable than requests+BS4)

Falls back to RSS feed if Playwright unavailable
"""

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

TIMEOUT = 30000
DELAY_BETWEEN_REQUESTS = 1.0

# Try Playwright import
try:
    from playwright.sync_api import sync_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False
    print("[WARN] Playwright not installed", file=sys.stderr)

try:
    from bs4 import BeautifulSoup
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False

try:
    import feedparser
    HAS_FEEDPARSER = True
except ImportError:
    HAS_FEEDPARSER = False


# ─── PARSING ───────────────────────────────────────────────────────────
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


def matches_skills(job):
    """Check if job matches skill keywords."""
    text = (job.get("title") or "") + " " + (job.get("description") or "")
    text_lower = text.lower()
    
    matched = sum(1 for skill in SKILL_KEYWORDS if skill in text_lower)
    return matched >= MIN_SKILL_KEYWORDS


def scrape_indeed_with_playwright(query, location):
    """Use Playwright to scrape Indeed search results."""
    if not HAS_PLAYWRIGHT:
        return []
    
    try:
        from playwright.sync_api import sync_playwright
        
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            
            # Navigate to Indeed search
            url = f"https://www.indeed.com/jobs?q={query}&l={location}&sort=date"
            page.goto(url, wait_until="networkidle", timeout=TIMEOUT)
            
            # Wait for job listings
            try:
                page.wait_for_selector('div.job_seen_beacon', timeout=10000)
            except:
                pass
            
            # Get page content
            content = page.content()
            browser.close()
            
            if not HAS_BS4:
                return []
            
            # Parse with BS4
            soup = BeautifulSoup(content, "html.parser")
            jobs = []
            
            job_cards = soup.find_all("div", class_="job_seen_beacon")
            if not job_cards:
                job_cards = soup.find_all("div", {"data-jk": True})
            
            for card in job_cards[:MAX_JOBS]:
                try:
                    # Extract job ID
                    job_id = card.get("data-jk") or card.get("id", "").replace("job_", "")
                    if not job_id:
                        continue
                    
                    # Extract title
                    title_el = card.find("h2", class_="jobTitle") or card.find("a", class_="jcs-MatchedSearch")
                    title = title_el.get_text(strip=True) if title_el else None
                    if not title:
                        continue
                    
                    # Extract company
                    company_el = card.find("span", class_="companyName") or card.find("div", class_="company")
                    company = company_el.get_text(strip=True) if company_el else None
                    
                    # Extract location
                    location_el = card.find("div", class_="companyLocation") or card.find("div", {"data-testid": "text-location"})
                    location = location_el.get_text(strip=True) if location_el else None
                    
                    # Extract URL
                    link_el = card.find("a", class_="jcs-MatchedSearch") or card.find("a", {"data-jk": True})
                    url = link_el.get("href", "") if link_el else ""
                    if url and not url.startswith("http"):
                        url = "https://www.indeed.com" + url
                    
                    # Extract snippet
                    snippet_el = card.find("div", class_="snippet")
                    description = snippet_el.get_text(strip=True) if snippet_el else ""
                    
                    job = {
                        "job_id": job_id,
                        "title": title,
                        "company": company,
                        "location": location,
                        "url": url,
                        "posted_at": None,
                        "description": description,
                    }
                    
                    if matches_skills(job):
                        job["skills"] = extract_skills_array(job["description"])
                        jobs.append(job)
                except Exception as e:
                    continue
            
            return jobs
    except Exception as e:
        print(f"[ERROR] Playwright scraping failed: {e}", file=sys.stderr)
        return []


def fetch_indeed_jobs_rss():
    """Fallback: Use Indeed RSS feed (no JS rendering needed)."""
    if not HAS_FEEDPARSER:
        return []
    
    try:
        all_jobs = []
        
        # Build RSS feed URL for job search
        for query_dict in SEARCH_QUERIES:
            q = query_dict.get("q", "")
            l = query_dict.get("l", "")
            
            # Indeed RSS format: /rss?q={query}&l={location}&sort=date
            rss_url = f"https://www.indeed.com/rss?q={q}&l={l}&sort=date"
            
            print(f"[RSS] Fetching: {rss_url[:60]}...", file=sys.stderr)
            
            feed = feedparser.parse(rss_url)
            
            for entry in feed.entries[:50]:
                try:
                    job = {
                        "job_id": entry.get("id", entry.get("link", "")).split("/")[-1],
                        "title": entry.get("title", ""),
                        "company": entry.get("author", entry.get("source", {}).get("title", "")),
                        "location": None,  # RSS doesn't have location
                        "url": entry.get("link", ""),
                        "posted_at": entry.get("published", None),
                        "description": entry.get("summary", ""),
                    }
                    
                    if matches_skills(job):
                        job["skills"] = extract_skills_array(job["description"])
                        all_jobs.append(job)
                except Exception as e:
                    continue
            
            time.sleep(DELAY_BETWEEN_REQUESTS)
        
        return all_jobs
    except Exception as e:
        print(f"[ERROR] RSS parsing failed: {e}", file=sys.stderr)
        return []


def fetch_indeed_jobs():
    """Main scraper: search Indeed using Playwright with RSS fallback."""
    all_jobs = []
    seen_ids = set()
    
    print(f"[SEARCH] Indeed: Searching for Data Engineer + Databricks jobs", file=sys.stderr)
    
    if HAS_PLAYWRIGHT:
        # Try Playwright first (more reliable, more JS handling)
        for query_dict in SEARCH_QUERIES:
            if len(all_jobs) >= MAX_JOBS:
                break
            
            q = query_dict.get("q", "")
            l = query_dict.get("l", "")
            
            print(f"[SEARCH] Indeed: '{q}' in {l}", file=sys.stderr)
            
            jobs = scrape_indeed_with_playwright(q, l)
            
            for job in jobs:
                if job["job_id"] not in seen_ids and len(all_jobs) < MAX_JOBS:
                    all_jobs.append(job)
                    seen_ids.add(job["job_id"])
            
            if jobs:
                print(f"[OK] Found {len(jobs)} jobs for '{q}'", file=sys.stderr)
            else:
                print(f"[WARN] No jobs found for '{q}'", file=sys.stderr)
    
    # Fallback to RSS if Playwright didn't work or found nothing
    if len(all_jobs) < 10 and HAS_FEEDPARSER:
        print(f"[FALLBACK] Using Indeed RSS feed", file=sys.stderr)
        rss_jobs = fetch_indeed_jobs_rss()
        for job in rss_jobs:
            if job["job_id"] not in seen_ids and len(all_jobs) < MAX_JOBS:
                all_jobs.append(job)
                seen_ids.add(job["job_id"])
    
    return all_jobs


if __name__ == "__main__":
    try:
        jobs = fetch_indeed_jobs()
        
        # Output JSON to stdout
        print(json.dumps(jobs, default=str))
        
        # Stats to stderr
        print(f"\n[OK] Total jobs: {len(jobs)}", file=sys.stderr)
        for job in jobs[:3]:
            print(f"  - {job['title'][:40]:40s} at {job.get('company', '')}", file=sys.stderr)
        
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
