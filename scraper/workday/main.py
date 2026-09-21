from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
import aiohttp
import os
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

# Add parent directory to sys.path to import skill_Filter
sys.path.insert(0, str(Path(__file__).parent.parent))
from skill_Filter import SkillFilter

class Scraper:
    def __init__(self, company):
        self.company = company
        supabase_url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
        self.base_url = f"{supabase_url}/rest/v1" if supabase_url else ""
        self.headers = {
            'apikey': os.getenv("VITE_SUPABASE_ANON_KEY"),
            'Content-Type': 'application/json'
        }
        # Workday-specific filters: default to India-only unless the company config explicitly overrides it.
        self.location_filter = (company.get('location_filter') or 'India').strip()
        self.date_filter = company.get('date_filter', ['today', 'yesterday', '0 days', '1 day'])
        # Initialize SkillFilter with user skills from orchestrator
        self.skill_filter = SkillFilter(company.get('user_skills', []))
        print(f"[INIT] Workday scraper for: {company['name']} (Location filter: '{self.location_filter}' or None, Skills: {len(self.skill_filter.skills)} skills)")
    
    async def scrape(self):
        """Scrape jobs from Workday portal using headless browser"""
        print(f"[SCRAPE] {self.company['name']} at {self.company['api_url']}")
        
        try:
            # Launch headless browser
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                
                # Navigate to careers page with timeout
                await page.goto(self.company['api_url'], wait_until="domcontentloaded", timeout=30000)
                
                # Wait for job listings to load
                await page.wait_for_selector('ul[role="list"]', timeout=10000)
                
                # STEP 1: Fetch pages until we hit old jobs (optimization: stop early)
                all_jobs = []
                page_num = 1
                consecutive_old_count = 0
                
                while True:
                    # Get page content
                    content = await page.content()
                    
                    # Parse jobs from current page
                    jobs = self._parse_jobs(content)
                    
                    # On first page, collect ALL jobs (they're mixed new/old)
                    # On subsequent pages, stop when we hit consecutive old jobs
                    if page_num == 1:
                        # First page: collect everything (don't check age)
                        all_jobs.extend(jobs)
                    else:
                        # Subsequent pages: stop after 5+ consecutive old jobs
                        jobs_to_include = []
                        consecutive_old_count = 0
                        for job in jobs:
                            posted_date = job.get('posted_date', '').lower()
                            if self._is_old_job(posted_date):
                                consecutive_old_count += 1
                                if consecutive_old_count >= 5:
                                    # Stop pagination - consistently hitting old jobs
                                    print(f"    [STOP] {consecutive_old_count} consecutive old jobs on page {page_num}, stopping pagination")
                                    break
                            else:
                                consecutive_old_count = 0  # Reset counter if we hit a recent job
                                jobs_to_include.append(job)
                        
                        if consecutive_old_count >= 5:
                            break  # Exit outer loop
                        
                        all_jobs.extend(jobs_to_include)
                    
                    # Stop pagination if we hit consecutive old jobs
                    if consecutive_old_count >= 5:
                        break
                    
                    # Check if there's a next page button
                    next_button = await page.query_selector('button[aria-label*="next"]')
                    
                    if not next_button:
                        # Try alternative selector for pagination
                        pagination_nav = await page.query_selector('nav[aria-label="pagination"]')
                        if pagination_nav:
                            # Get current page info
                            page_info = await page.query_selector('p[data-automation-id="jobOutOfText"]')
                            if page_info:
                                page_text = await page_info.text_content()
                                print(f"    [FETCH] Pagination info: {page_text}")
                        break
                    
                    # Try to click next button
                    try:
                        await next_button.click()
                        await page.wait_for_timeout(2000)  # Wait for page to load
                        page_num += 1
                    except:
                        break
                
                print(f"    [TOTAL] {len(all_jobs)} jobs fetched from {page_num} page(s)")
                
                # STEP 2: Filter by location
                filtered_jobs = self._filter_by_location(all_jobs)
                print(f"    [FILTER] Location filter: {len(all_jobs)} -> {len(filtered_jobs)} jobs")
                
                # STEP 3: Filter by posted date
                filtered_jobs = self._filter_by_posted_date(filtered_jobs)
                print(f"    [FILTER] Date filter: -> {len(filtered_jobs)} jobs remaining")
                
                # STEP 4: Fetch descriptions ONLY for filtered jobs
                for i, job in enumerate(filtered_jobs):
                    try:
                        detail_url = job.get('job_url')
                        if detail_url:
                            
                            # Navigate to detail page with increased timeout
                            try:
                                await page.goto(detail_url, wait_until="networkidle", timeout=30000)
                            except:
                                # Fallback to domcontentloaded if networkidle times out
                                await page.goto(detail_url, wait_until="domcontentloaded", timeout=20000)
                            
                            await page.wait_for_timeout(1500)
                            
                            # Check for description element
                            desc_count = await page.locator('[data-automation-id="jobPostingDescription"]').count()
                            
                            if desc_count > 0:
                                description = await page.locator('[data-automation-id="jobPostingDescription"]').text_content()
                                filtered_jobs[i]['description'] = description.strip() if description else "No description"
                            else:
                                filtered_jobs[i]['description'] = "Description not available"
                    except Exception as e:
                        filtered_jobs[i]['description'] = "Description unavailable"
                
                await browser.close()
                
                print(f"    [COMPLETE] {len(filtered_jobs)} jobs with descriptions ready")
                
                # STEP 5: Filter by skills (if user skills provided)
                if self.skill_filter.skills and len(filtered_jobs) > 0:
                    filtered_jobs = self.skill_filter.filter(filtered_jobs)
                    stats = self.skill_filter.get_stats()
                    matched_skills = stats.get('matched_skills_used', [])
                    print(f"    [FILTER] Skills filter: {stats.get('total_matched', 0)} jobs matched (Skills: {matched_skills})")
                
                return filtered_jobs
        
        except Exception as e:
            print(f"    [ERROR] {str(e)}")
            return []
    
    def _parse_jobs(self, html_content):
        """Parse job listings from HTML"""
        soup = BeautifulSoup(html_content, 'html.parser')
        jobs = []
        
        # Find job list container
        job_list = soup.find('ul', attrs={"role": "list"})
        if not job_list:
            print("    [WARN] Could not find job list container")
            return jobs
        
        # Find all job items (li tags)
        job_items = job_list.find_all('li', recursive=False)
        
        for idx, job_item in enumerate(job_items):
            try:
                # Extract job title and URL
                title_link = job_item.find('a', attrs={"data-automation-id": "jobTitle"})
                if not title_link:
                    continue
                
                title = title_link.get_text(strip=True)
                raw_job_url = title_link.get('href', '')
                job_url = self._normalize_workday_url(raw_job_url)
                
                # Extract location
                location = "Not specified"
                location_div = job_item.find('div', attrs={"data-automation-id": "locations"})
                if location_div:
                    location_dd = location_div.find('dd')
                    if location_dd:
                        location = location_dd.get_text(strip=True)
                
                # Extract posted date
                posted_date = "Not specified"
                posted_div = job_item.find('div', attrs={"data-automation-id": "postedOn"})
                if posted_div:
                    posted_dd = posted_div.find('dd')
                    if posted_dd:
                        posted_date = posted_dd.get_text(strip=True)
                
                # Extract job ID from subtitle if available
                job_id = f"{self.company['id']}_{idx}"
                subtitle_li = job_item.find('li', class_=lambda x: x and "subtitle" in x)
                if subtitle_li:
                    job_id_text = subtitle_li.get_text(strip=True)
                    if job_id_text:
                        job_id = f"{self.company['id']}_{job_id_text}"
                
                job = {
                    "company_id": self.company['id'],
                    "job_id": job_id,
                    "title": title,
                    "location": location,
                    "job_url": job_url,
                    "posted_date": posted_date,
                    "description": "Pending...",
                    "posted_at": datetime.now().isoformat(),
                    "skills": []
                }
                jobs.append(job)
                
            except Exception as e:
                continue
        
        return jobs

    def _normalize_workday_url(self, raw_url):
        """Return an absolute Workday job URL for UI and DB storage."""
        if not raw_url:
            return ""

        base = self.company.get('api_url', '')
        raw = raw_url.strip()

        if raw.startswith('http://') or raw.startswith('https://'):
            return raw

        if raw.startswith('/'):
            return urljoin(base, raw)

        return f"{base.rstrip('/')}/{raw.lstrip('/')}"
    
    def _is_old_job(self, posted_date):
        """Check if a job is old (2+ days ago) - used to stop pagination early"""
        posted_lower = posted_date.lower()
        
        # If it contains "30+ days", it's definitely old
        if "30+" in posted_lower or "30 +" in posted_lower:
            return True
        
        # Check for "X days ago" patterns (2 or more days)
        # Match patterns like: "2 days", "3 days", "4 days", etc.
        import re
        days_match = re.search(r'(\d+)\s+days?', posted_lower)
        if days_match:
            days_num = int(days_match.group(1))
            if days_num >= 2:
                return True
        
        # "Today", "Yesterday", "1 day" are NOT old
        return False
    
    def _filter_by_location(self, jobs):
        """Only keep roles that are clearly India-focused, including India remote roles."""
        india_markers = [
            'india', 'indian', 'bengaluru', 'bangalore', 'hyderabad', 'gurugram', 'gurgaon',
            'delhi', 'mumbai', 'pune', 'chennai', 'kochi', 'ahmedabad', 'noida', 'kolkata',
            'jaipur', 'lucknow', 'bhubaneswar', 'visakhapatnam', 'coimbatore', 'trivandrum',
            'india remote', 'remote - india', 'remote india'
        ]

        filtered = []
        for job in jobs:
            location = (job.get('location', '') or '').lower().strip()
            if not location or location == 'not specified':
                continue

            if 'remote' in location and 'india' in location:
                filtered.append(job)
                continue

            if any(marker in location for marker in india_markers):
                filtered.append(job)

        return filtered
    
    def _filter_by_posted_date(self, jobs):
        """Filter jobs by posted date using scraper-specific filters."""
        filtered = []
        for job in jobs:
            posted_date = (job.get('posted_date') or '').lower()
            if not posted_date:
                continue

            if any(keyword in posted_date for keyword in self.date_filter):
                filtered.append(job)
        
        return filtered
    
    
    async def _insert_jobs(self, jobs):
        """Insert jobs into Supabase via REST API"""
        url = f"{self.base_url}/jobs"
        print(f"    [INSERT] Attempting to insert {len(jobs)} jobs to {url}")
        
        # Prepare minimal jobs for insertion - use only id, title, company_id
        jobs_to_insert = []
        for i, job in enumerate(jobs):
            cleaned_job = {
                'company_id': job.get('company_id'),
                'title': job.get('title'),
                'location': job.get('location'),
                'posted_date': job.get('posted_date')
            }
            jobs_to_insert.append(cleaned_job)
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=jobs_to_insert, headers=self.headers) as response:
                    error_text = await response.text()
                    print(f"    [INSERT] Status {response.status}: {error_text[:300]}")
                    if response.status in [200, 201]:
                        print(f"    [OK] Inserted {len(jobs_to_insert)} jobs into database")
                    else:
                        print(f"    [WARN] API error ({response.status})")
        except Exception as e:
            print(f"    [ERROR] Insert error: {e}")