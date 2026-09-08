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
        # Initialize SkillFilter with user skills
        self.skill_filter = SkillFilter(company.get('user_skills', []))
        
        print(f"[INIT] LinkedIn scraper for: {company['name']} (Skills: {len(self.skill_filter.skills)} skills)")
    
    async def scrape(self):
        """Scrape jobs from LinkedIn using headless browser"""
        print(f"[SCRAPE] {self.company['name']} at {self.company['api_url']}")
        
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                
                # Navigate to LinkedIn search URL (URL handles location + 6-hour filter)
                search_url = self.company['api_url']
                
                await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_selector('div[class*="base-card"]', timeout=10000)
                
                # Get page content
                content = await page.content()
                
                # STEP 1: Parse jobs from LinkedIn
                all_jobs = self._parse_linkedin_jobs(content)
                print(f"    [TOTAL] {len(all_jobs)} jobs fetched from LinkedIn")
                
                # STEP 2: Fetch descriptions for all jobs
                for i, job in enumerate(all_jobs):
                    try:
                        job_url = job.get('job_url')
                        if job_url:
                            await page.goto(job_url, wait_until="domcontentloaded", timeout=20000)
                            await page.wait_for_timeout(1000)
                            
                            # Get description from detail page
                            description = await page.text_content()
                            all_jobs[i]['description'] = description[:500] if description else "No description"
                    except Exception as e:
                        all_jobs[i]['description'] = "Description unavailable"
                
                await browser.close()
                
                print(f"    [COMPLETE] {len(all_jobs)} jobs with descriptions ready")
                
                # STEP 3: Filter by skills
                filtered_jobs = all_jobs
                if self.skill_filter.skills and len(filtered_jobs) > 0:
                    filtered_jobs = self.skill_filter.filter(filtered_jobs)
                    stats = self.skill_filter.get_stats()
                    matched_skills = stats.get('matched_skills_used', [])
                    print(f"    [FILTER] Skills filter: {stats.get('total_matched', 0)} jobs matched (Skills: {matched_skills})")
                
                # STEP 4: Sort by freshness (most recent first)
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
                # 1. Extract job link & ID
                job_link = card.find('a', class_='base-card__full-link')
                if not job_link or not job_link.get('href'):
                    continue
                
                job_url = job_link['href']
                match = re.search(r'/view/([^?]+)', job_url)
                job_id = match.group(1) if match else f"linkedin_{idx}"
                
                # 2. Extract job title
                title_elem = card.find('h3', class_='base-search-card__title')
                title = title_elem.get_text(strip=True) if title_elem else "No title"
                
                # 3. Extract company
                company_elem = card.find('h4', class_='base-search-card__subtitle')
                company = company_elem.get_text(strip=True) if company_elem else "No company"
                
                # 4. Extract location
                location_elem = card.find('span', class_='job-search-card__location')
                location = location_elem.get_text(strip=True) if location_elem else "Not specified"
                
                # 5. Extract posted date/time (use datetime attribute from time tag)
                time_elem = card.find('time', class_='job-search-card__listdate--new')
                posted_datetime = time_elem.get('datetime') if time_elem else "2026-09-08"
                posted_time = time_elem.get_text(strip=True) if time_elem else "Unknown"
                
                job = {
                    "company_id": self.company['id'],
                    "job_id": job_id,
                    "title": title,
                    "company": company,
                    "location": location,
                    "job_url": job_url,
                    "posted_datetime": posted_datetime,
                    "posted_time": posted_time,
                    "description": "Pending...",
                    "posted_at": datetime.now().isoformat(),
                    "matched_skills": []
                }
                jobs.append(job)
                
            except Exception as e:
                continue
        
        return jobs
    
    def _sort_by_freshness(self, jobs):
        """Sort jobs by freshness (most recent first)"""
        def get_freshness_score(job):
            posted_time = job.get('posted_time', '').lower().strip()
            
            # Handle "X hours ago"
            hours_match = re.search(r'(\d+)\s+hours?\s+ago', posted_time)
            if hours_match:
                hours = int(hours_match.group(1))
                return -hours
            
            # Handle "X days ago"
            days_match = re.search(r'(\d+)\s+days?\s+ago', posted_time)
            if days_match:
                days = int(days_match.group(1))
                return -(days * 24)
            
            # Handle "minutes ago" or "just now"
            if 'minute' in posted_time or 'just now' in posted_time:
                return -0.1
            
            # Default: very old
            return -999999
        
        # Sort jobs by freshness score (descending)
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