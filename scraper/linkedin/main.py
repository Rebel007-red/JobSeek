from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
import aiohttp
import asyncio
import os
import sys
import re
from datetime import datetime
from pathlib import Path

# Add parent directory to sys.path to import skill_Filter
sys.path.insert(0, str(Path(__file__).parent.parent))
from skill_Filter import SkillFilter

class Scraper:
    def __init__(self, company):
        self.company = company
        self.base_url = "https://deczscnmmxpgpayyxglk.supabase.co/rest/v1"
        self.headers = {
            'apikey': os.getenv("VITE_SUPABASE_ANON_KEY"),
            'Content-Type': 'application/json'
        }
        # Scraper-specific filters
        self.location_filter = company.get('location_filter', '')
        self.date_filter = company.get('date_filter', ['today', 'yesterday', '0 days', '1 day', 'hour'])
        # Initialize SkillFilter with user skills
        self.skill_filter = SkillFilter(company.get('user_skills', []))
        
        print(f"[INIT] LinkedIn scraper for: {company['name']} (Location filter: '{self.location_filter}' or None, Skills: {len(self.skill_filter.skills)} skills)")
    
    async def scrape(self):
        """Scrape jobs from LinkedIn using headless browser"""
        print(f"[SCRAPE] {self.company['name']} at {self.company['api_url']}")
        
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                
                # Navigate to LinkedIn search URL (6-hour filter)
                search_url = self.company['api_url']
                
                await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_selector('div[class*="base-card"]', timeout=10000)
                
                # Get page content
                content = await page.content()
                
                # STEP 1: Parse jobs from LinkedIn
                all_jobs = self._parse_linkedin_jobs(content)
                print(f"    [TOTAL] {len(all_jobs)} jobs fetched from LinkedIn")
                
                # STEP 2: Filter by location
                filtered_jobs = self._filter_by_location(all_jobs)
                print(f"    [FILTER] Location filter: {len(all_jobs)} -> {len(filtered_jobs)} jobs")
                
                # STEP 3: Filter by posted date
                filtered_jobs = self._filter_by_posted_date(filtered_jobs)
                print(f"    [FILTER] Date filter: -> {len(filtered_jobs)} jobs remaining")
                
                # STEP 4: Fetch descriptions for filtered jobs
                for i, job in enumerate(filtered_jobs):
                    try:
                        job_url = job.get('job_url')
                        if job_url:
                            await page.goto(job_url, wait_until="domcontentloaded", timeout=20000)
                            await page.wait_for_timeout(1000)
                            
                            # Get description from detail page
                            description = await page.text_content()
                            filtered_jobs[i]['description'] = description[:500] if description else "No description"
                    except Exception as e:
                        filtered_jobs[i]['description'] = "Description unavailable"
                
                await browser.close()
                
                print(f"    [COMPLETE] {len(filtered_jobs)} jobs with descriptions ready")
                
                # STEP 5: Filter by skills
                if self.skill_filter.skills and len(filtered_jobs) > 0:
                    filtered_jobs = self.skill_filter.filter(filtered_jobs)
                    stats = self.skill_filter.get_stats()
                    matched_skills = stats.get('matched_skills_used', [])
                    print(f"    [FILTER] Skills filter: {stats.get('total_matched', 0)} jobs matched (Skills: {matched_skills})")
                
                # STEP 6: Sort by freshness (most recent first)
                filtered_jobs = self._sort_by_freshness(filtered_jobs)
                
                return filtered_jobs
        
        except Exception as e:
            print(f"    [ERROR] {str(e)}")
            return []
    
    def _parse_linkedin_jobs(self, html_content):
        """Parse job listings from LinkedIn HTML"""
        soup = BeautifulSoup(html_content, 'html.parser')
        jobs = []
        
        # Find all job cards (base-card divs)
        job_cards = soup.find_all('div', class_='base-card')
        
        for idx, card in enumerate(job_cards):
            try:
                # Extract job link
                job_link = card.find('a', class_='base-card__full-link')
                if not job_link or not job_link.get('href'):
                    continue
                
                job_url = job_link['href']
                
                # Extract job ID from URL
                match = re.search(r'/view/([^?]+)', job_url)
                job_id = match.group(1) if match else f"linkedin_{idx}"
                
                # Extract job title
                title_elem = card.find('h3', class_='base-search-card__title')
                title = title_elem.get_text(strip=True) if title_elem else "No title"
                
                # Extract company
                subtitle_elem = card.find('h4', class_='base-search-card__subtitle')
                company = subtitle_elem.get_text(strip=True) if subtitle_elem else "No company"
                
                # Extract location
                location = "Not specified"
                location_span = card.find('span', class_='job-search-card__location')
                if location_span:
                    location = location_span.get_text(strip=True)
                
                # Extract posted date/time from <time> element
                posted_date = "Not specified"
                time_elem = card.find('time', class_='job-search-card__listdate--new')
                if time_elem:
                    # Get the text content of the time element and its parent
                    time_text = time_elem.get_text(strip=True)
                    # Also check parent div for the full text like "3 hours ago"
                    parent = time_elem.parent
                    if parent:
                        parent_text = parent.get_text(strip=True)
                        posted_date = parent_text if parent_text else f"{time_text} ago"
                    else:
                        posted_date = f"{time_text} ago"
                
                job = {
                    "company_id": self.company['id'],
                    "job_id": job_id,
                    "title": title,
                    "company": company,
                    "location": location,
                    "job_url": job_url,
                    "posted_date": posted_date,
                    "description": "Pending...",
                    "posted_at": datetime.now().isoformat(),
                    "matched_skills": []
                }
                jobs.append(job)
                
            except Exception as e:
                continue
        
        return jobs
    
    def _filter_by_location(self, jobs):
        """Filter jobs - blacklist known non-Indian countries"""
        # Known non-Indian countries and locations to reject
        non_indian_keywords = [
            # US states and cities
            'california', 'texas', 'new york', 'florida', 'washington', 'seattle', 'san francisco',
            'mountain view', 'palo alto', 'united states', 'us ', ' usa', 'us,',
            'chicago', 'austin', 'boston', 'denver', 'atlanta', 'houston', 'las vegas',
            'los angeles', 'new jersey', 'pennsylvania', 'virginia', 'illinois',
            
            # UK and Ireland
            'london', 'uk', 'united kingdom', 'england', 'ireland', 'dublin', 'manchester',
            
            # Canada
            'canada', 'toronto', 'vancouver', 'montreal', 'calgary', 'ottawa',
            
            # EU countries
            'germany', 'france', 'netherlands', 'belgium', 'switzerland', 'austria',
            'sweden', 'denmark', 'norway', 'finland', 'poland', 'czech', 'spain',
            'italy', 'portugal', 'greece', 'eu ', 'europe',
            'berlin', 'paris', 'amsterdam', 'zurich', 'brussels',
            
            # Other countries
            'australia', 'new zealand', 'singapore', 'malaysia', 'thailand', 'vietnam',
            'japan', 'china', 'hong kong', 'south korea', 'uae', 'dubai', 'middle east',
            'mexico', 'brazil', 'argentina', 'latin america'
        ]
        
        filtered = []
        for job in jobs:
            location = job.get('location', '').lower().strip()
            
            # Reject if location contains any known non-Indian keyword
            if any(keyword in location for keyword in non_indian_keywords):
                continue
            
            # Accept everything else
            filtered.append(job)
        
        return filtered
    
    def _filter_by_posted_date(self, jobs):
        """Filter jobs by posted date using scraper-specific filters"""
        filtered = []
        for job in jobs:
            posted_date = job.get('posted_date', '').lower()
            # Check if posted date matches any filter keywords
            if any(keyword in posted_date for keyword in self.date_filter):
                filtered.append(job)
        
        return filtered
    
    def _sort_by_freshness(self, jobs):
        """Sort jobs by freshness (most recent first)"""
        def get_freshness_score(job):
            posted_date = job.get('posted_date', '').lower().strip()
            
            # Handle "X hours ago"
            hours_match = re.search(r'(\d+)\s+hours?\s+ago', posted_date)
            if hours_match:
                hours = int(hours_match.group(1))
                return -hours
            
            # Handle "X days ago"
            days_match = re.search(r'(\d+)\s+days?\s+ago', posted_date)
            if days_match:
                days = int(days_match.group(1))
                return -(days * 24)
            
            # Handle specific keywords
            if 'today' in posted_date or 'just now' in posted_date:
                return -0.5
            
            if 'yesterday' in posted_date:
                return -24
            
            # Default
            return -999999
        
        # Sort jobs by freshness score
        sorted_jobs = sorted(jobs, key=get_freshness_score)
        
        print(f"    [SORT] Jobs sorted by freshness (most recent first)")
        
        return sorted_jobs
    
    async def _insert_jobs(self, jobs):
        """Insert jobs into Supabase via REST API"""
        url = f"{self.base_url}/jobs"
        print(f"    [INSERT] Attempting to insert {len(jobs)} jobs to {url}")
        
        jobs_to_insert = []
        for job in jobs:
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