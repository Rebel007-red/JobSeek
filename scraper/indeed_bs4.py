#!/usr/bin/env python3
"""
Indeed.com Job Scraper - Playwright with Cloudflare Bypass & Stealth

Searches Indeed.com for Data Engineering jobs in India
Uses Playwright headless browser with stealth measures to bypass Cloudflare
"""

import json
import sys
import time
import re
from urllib.parse import urljoin
from datetime import datetime

# Fix encoding for Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ─── CONFIG ────────────────────────────────────────────────────────────
BASE_SKILLS = {'pyspark', 'databricks', 'spark'}
RUNTIME_KEYWORDS = {'pyspark', 'databricks', 'spark', 'sql', 'python', 'data', 'aws', 'gcp', 'azure', 'scala', 'java'}
MIN_SKILL_KEYWORDS = 1
MAX_JOBS_PER_PAGE = 20
MAX_PAGES = 5  # Increased from 3 to get more jobs (up to 100/search)
TIMEOUT = 30000

# Indeed search configuration
SEARCHES = [
    {'q': 'data engineer', 'location': 'India'},
    {'q': 'databricks', 'location': 'India'},
    {'q': 'python data', 'location': 'India'},  # Added for more results
]

DELAY_BETWEEN_PAGES = 1.0

# Stealth JavaScript to avoid bot detection
STEALTH_JS = """
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  window.chrome = {runtime: {}};
"""

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


# ─── PARSING ───────────────────────────────────────────────────────────
def extract_skills_array(text):
    """Extract matched skills from text"""
    if not text:
        return []
    text_lower = text.lower()
    matched = set()
    for keyword in RUNTIME_KEYWORDS:
        if keyword in text_lower:
            matched.add(keyword)
    return sorted(list(matched))


def matches_skills(title, description):
    """Check if job matches minimum skill keywords"""
    text = f"{title} {description}".lower() if description else title.lower()
    matched_skills = []
    for keyword in RUNTIME_KEYWORDS:
        if keyword in text:
            matched_skills.append(keyword)
    return len(matched_skills) >= MIN_SKILL_KEYWORDS


def fetch_indeed_jobs():
    """Fetch jobs from Indeed using Playwright with stealth mode"""
    if not HAS_PLAYWRIGHT:
        print("[ERROR] Playwright required but not installed", file=sys.stderr)
        return []
    
    if not HAS_BS4:
        print("[ERROR] BeautifulSoup4 required but not installed", file=sys.stderr)
        return []
    
    all_jobs = []
    
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-gpu',
            ]
        )
        
        try:
            for search in SEARCHES:
                print(f"[SEARCH] '{search['q']}' in {search['location']}", file=sys.stderr)
                
                # Build search URL
                url = f"https://in.indeed.com/jobs?q={search['q'].replace(' ', '+')}&l={search['location']}&fromage=1"
                
                for page_num in range(MAX_PAGES):
                    if len(all_jobs) >= 75:  # Global limit per pipeline
                        break
                    
                    page_url = f"{url}&start={page_num * 15}"
                    print(f"  Page {page_num + 1}: Fetching...", file=sys.stderr)
                    
                    context = browser.new_context(
                        user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                        viewport={'width': 1920, 'height': 1080}
                    )
                    page = context.new_page()
                    page.add_init_script(STEALTH_JS)
                    
                    try:
                        # Navigate with domcontentloaded (faster than networkidle)
                        response = page.goto(page_url, wait_until='domcontentloaded', timeout=TIMEOUT)
                        if response.status != 200:
                            print(f"    ❌ HTTP {response.status}", file=sys.stderr)
                            continue
                        
                        # Wait additional time for React to render jobs
                        print(f"    ⏳ Waiting for jobs to render...", file=sys.stderr)
                        page.wait_for_timeout(4000)
                        
                        # Extract HTML
                        html = page.content()
                        soup = BeautifulSoup(html, 'html.parser')
                        
                        # Find job items - Indeed uses cardOutline div elements for jobs
                        job_items = soup.find_all('div', class_=re.compile('cardOutline', re.I), limit=MAX_JOBS_PER_PAGE)
                        
                        if not job_items:
                            print(f"    📭 No jobs found (cardOutline), stopping pagination", file=sys.stderr)
                            break
                        
                        print(f"    Found {len(job_items)} job items", file=sys.stderr)
                        matched_count = 0
                        
                        for item in job_items:
                            try:
                                # Extract job ID from data-jk attribute on the link
                                job_link = item.find('a', attrs={'data-jk': True})
                                if not job_link:
                                    continue
                                
                                job_id = job_link.get('data-jk', '')
                                if not job_id:
                                    continue
                                
                                # Extract title from the link text or span[@title]
                                title_span = job_link.find('span', attrs={'title': True})
                                title = title_span.get('title', '') if title_span else job_link.get_text(strip=True)
                                if not title or len(title) < 3:
                                    continue
                                
                                # Get job URL from link href
                                job_url = job_link.get('href', '')
                                if not job_url.startswith('http'):
                                    job_url = urljoin('https://in.indeed.com', job_url)
                                
                                # Extract company - look for span with data-testid="company-name"
                                company_elem = item.find('span', attrs={'data-testid': 'company-name'})
                                company = company_elem.get_text(strip=True) if company_elem else 'N/A'
                                
                                # Extract location - look for span inside [data-testid="text-location"]
                                location_container = item.find(attrs={'data-testid': 'text-location'})
                                location = location_container.get_text(strip=True) if location_container else ''
                                
                                # Extract description from belowJobSnippet div
                                snippet_elem = item.find('div', attrs={'data-testid': 'belowJobSnippet'})
                                description = ''
                                if snippet_elem:
                                    # Get all li items and join them
                                    list_items = snippet_elem.find_all('li')
                                    description = ' '.join([li.get_text(strip=True) for li in list_items])[:500]
                                
                                # Check skill match
                                if matches_skills(title, description):
                                    job = {
                                        'job_id': job_id,
                                        'title': title,
                                        'company': company,
                                        'location': location,
                                        'url': job_url,
                                        'description': description[:500],
                                        'posted_at': datetime.now().isoformat(),
                                        'skills': extract_skills_array(f"{title} {description}")
                                    }
                                    all_jobs.append(job)
                                    matched_count += 1
                                    print(f"      ✓ {title[:50]}", file=sys.stderr)
                                    
                            except Exception as e:
                                continue
                        
                        if matched_count == 0:
                            print(f"    ⚠️  No skill-matched jobs on this page", file=sys.stderr)
                        else:
                            print(f"    ✓ Matched {matched_count}/{len(job_items)} jobs", file=sys.stderr)
                        
                        # Rate limiting between pages
                        if page_num < MAX_PAGES - 1 and len(all_jobs) < 75:
                            time.sleep(DELAY_BETWEEN_PAGES)
                            
                    except Exception as e:
                        print(f"    ❌ Error loading page: {e}", file=sys.stderr)
                        continue
                    finally:
                        page.close()
                        context.close()
        finally:
            browser.close()
    
    return all_jobs


if __name__ == "__main__":
    try:
        jobs = fetch_indeed_jobs()
        
        # Output JSON to stdout
        print(json.dumps(jobs, default=str))
        
        # Stats to stderr
        print(f"\n[OK] Total jobs found: {len(jobs)}", file=sys.stderr)
        
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
