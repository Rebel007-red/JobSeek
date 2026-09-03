#!/usr/bin/env python3
"""
Workday Jobs Scraper (BeautifulSoup4 + Playwright Fallback)

Fetches jobs from all Workday companies:
  - First tries HTML parsing (BS4) - fast
  - Falls back to Playwright headless browser - reliable for JS rendering

Companies: Rockwell Automation, Fractal, MiQ Digital, Dentsu Aegis
"""

import requests
from bs4 import BeautifulSoup
import json
import sys
import time
import os
import asyncio

# Fix encoding for Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ─── CONFIG ────────────────────────────────────────────────────────────
SKILL_KEYWORDS = ["pyspark", "databricks", "spark", "sql", "python", "data"]
MIN_SKILL_KEYWORDS = 1
MAX_JOBS_PER_COMPANY = 100
MAX_TOTAL_JOBS = 200

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

TIMEOUT = 15
DELAY_BETWEEN_REQUESTS = 0.5

# Try Playwright import
try:
    from playwright.sync_api import sync_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False


# ─── SUPABASE ──────────────────────────────────────────────────────────
def get_workday_companies():
    """Fetch all enabled Workday companies from Supabase."""
    # Fallback companies with real URLs
    fallback_companies = [
        {"id": "1", "name": "Rockwell Automation", "api_url": "https://rockwellautomation.wd1.myworkdayjobs.com/en-US/External_Rockwell_Automation?locationCountry=c4f78be1a8f14da0ab49ce1162348a5e", "slug": "rockwell"},
        {"id": "2", "name": "Fractal", "api_url": "https://fractal.wd1.myworkdayjobs.com/en-US/Careers?isComingFromApp=true", "slug": "fractal"},
        {"id": "3", "name": "MiQ Digital", "api_url": "https://miqdigital.wd3.myworkdayjobs.com/en-US/MiQ_Careers", "slug": "miq"},
        {"id": "4", "name": "Dentsu Aegis", "api_url": "https://dentsuaegis.wd3.myworkdayjobs.com/en-US/DAN_GLOBAL", "slug": "dentsu"},
    ]
    
    try:
        from supabase import create_client
        
        url = os.getenv('VITE_SUPABASE_URL') or 'https://deczscnmmxpgpayyxglk.supabase.co'
        key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
        
        if not key:
            print("[WARN] SUPABASE_SERVICE_ROLE_KEY not set, using fallback", file=sys.stderr)
            return fallback_companies
        
        supabase = create_client(url, key)
        
        response = supabase.table('companies').select('id,name,api_url,slug').eq('ats_type', 'workday').eq('disabled', False).execute()
        
        companies = response.data or []
        if companies:
            print(f"[FETCH] Found {len(companies)} Workday companies in DB", file=sys.stderr)
            return companies
        else:
            print("[WARN] No Workday companies in DB, using fallback", file=sys.stderr)
            return fallback_companies
    except Exception as e:
        print(f"[WARN] Failed to query companies: {e}, using fallback", file=sys.stderr)
        return fallback_companies


# ─── PARSING ───────────────────────────────────────────────────────────
def extract_skills_array(text):
    """Extract skill keywords from text."""
    if not text:
        return []
    
    skills = []
    keywords = ["pyspark", "databricks", "spark", "sql", "python", "aws", "gcp", "azure", "scala", "java"]
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


def scrape_with_playwright(url):
    """Use Playwright headless browser to scrape job listings from Workday."""
    if not HAS_PLAYWRIGHT:
        print(f"[WARN] Playwright not available, skipping: {url}", file=sys.stderr)
        return []
    
    try:
        from playwright.sync_api import sync_playwright
        
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            
            # Set timeout and navigate
            page.goto(url, wait_until="networkidle", timeout=30000)
            
            # Wait for job listings to load (adjust selector as needed)
            try:
                page.wait_for_selector('div[data-test-id*="job"]', timeout=10000)
            except:
                # If selector doesn't exist, continue anyway
                pass
            
            # Get page content
            content = page.content()
            browser.close()
            
            # Parse with BS4
            soup = BeautifulSoup(content, "html.parser")
            
            # Look for job listings in various formats
            jobs = []
            
            # Try multiple selectors for job cards
            job_cards = soup.find_all(
                ['a', 'div'],
                class_=lambda x: x and any(keyword in x.lower() for keyword in ['job', 'position', 'listing'])
            )
            
            if not job_cards:
                # Try data attributes
                job_cards = soup.find_all(lambda tag: tag.name and tag.get('data-test-id') and 'job' in tag.get('data-test-id', '').lower())
            
            for card in job_cards[:MAX_JOBS_PER_COMPANY]:
                try:
                    # Extract title
                    title_el = card.find(['h2', 'h3', 'a']) if card.name != 'a' else card
                    title = title_el.get_text(strip=True) if title_el else card.get_text(strip=True)
                    
                    if not title or len(title) < 3:
                        continue
                    
                    # Extract URL
                    if card.name == 'a':
                        link_url = card.get('href')
                    else:
                        link_el = card.find('a')
                        link_url = link_el.get('href') if link_el else None
                    
                    if not link_url:
                        continue
                    
                    # Make absolute URL
                    if link_url.startswith('/'):
                        base_url = '/'.join(url.split('/')[:3])
                        link_url = base_url + link_url
                    
                    job = {
                        "job_id": link_url.split('/')[-1] or title.lower().replace(' ', '-'),
                        "title": title,
                        "location": None,
                        "url": link_url,
                        "posted_at": None,
                        "description": title,  # Workday doesn't always provide description in list view
                    }
                    
                    if matches_skills(job):
                        job["skills"] = extract_skills_array(title)
                        jobs.append(job)
                except Exception as e:
                    continue
            
            return jobs
    except Exception as e:
        print(f"[ERROR] Playwright scraping failed: {e}", file=sys.stderr)
        return []


def scrape_with_html_parser(url):
    """Try to scrape Workday page with BeautifulSoup (fast but may not work if JS-rendered)."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        
        soup = BeautifulSoup(resp.text, "html.parser")
        
        jobs = []
        
        # Look for job cards/listings
        job_cards = soup.find_all(['a', 'div'], class_=lambda x: x and any(
            keyword in x.lower() for keyword in ['job', 'position', 'opening', 'title']
        ))
        
        for card in job_cards[:MAX_JOBS_PER_COMPANY]:
            try:
                # Extract title
                if card.name == 'a':
                    title = card.get_text(strip=True)
                    url_attr = card.get('href', '')
                else:
                    title_el = card.find('a') or card.find(['h2', 'h3'])
                    title = title_el.get_text(strip=True) if title_el else card.get_text(strip=True)
                    url_attr = title_el.get('href', '') if title_el and title_el.name == 'a' else ''
                
                if not title or len(title) < 3:
                    continue
                
                job = {
                    "job_id": url_attr.split('/')[-1] or title.lower().replace(' ', '-'),
                    "title": title,
                    "location": None,
                    "url": url_attr or url,
                    "posted_at": None,
                    "description": title,
                }
                
                if matches_skills(job):
                    job["skills"] = extract_skills_array(title)
                    jobs.append(job)
            except Exception as e:
                continue
        
        return jobs
    except Exception as e:
        print(f"[WARN] HTML parsing failed: {e}", file=sys.stderr)
        return []


# ─── MAIN SCRAPER ──────────────────────────────────────────────────────
def fetch_workday_jobs():
    """Main scraper: iterate through companies and fetch jobs."""
    all_jobs = []
    seen_ids = set()
    
    companies = get_workday_companies()
    print(f"[SCRAPE] Processing {len(companies)} Workday companies", file=sys.stderr)
    
    for company in companies:
        if len(all_jobs) >= MAX_TOTAL_JOBS:
            break
        
        company_name = company.get('name', 'Unknown')
        company_url = company.get('api_url', '')
        
        if not company_url:
            print(f"[SKIP] {company_name}: No URL provided", file=sys.stderr)
            continue
        
        print(f"[FETCH] {company_name}: {company_url[:60]}...", file=sys.stderr)
        
        # Try HTML parsing first (fast)
        jobs = scrape_with_html_parser(company_url)
        
        # If no jobs found, try Playwright (slow but reliable)
        if not jobs and HAS_PLAYWRIGHT:
            print(f"[RETRY] {company_name}: Using Playwright...", file=sys.stderr)
            jobs = scrape_with_playwright(company_url)
        
        if jobs:
            print(f"[OK] {company_name}: Found {len(jobs)} jobs", file=sys.stderr)
            for job in jobs:
                if job["job_id"] not in seen_ids:
                    all_jobs.append(job)
                    seen_ids.add(job["job_id"])
        else:
            print(f"[WARN] {company_name}: No jobs found", file=sys.stderr)
        
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
            print(f"  - {job['title'][:40]:40s}", file=sys.stderr)
        
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
