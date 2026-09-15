from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
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
        
        # Build LinkedIn search URL from api_url keywords
        self.search_url = self._build_search_url(company.get('api_url', ''))
        self.search_terms = self._build_search_terms(company.get('api_url', ''))
        self.target_jobs = int(company.get('linkedin_target_jobs', 250) or 250)
        self.max_pages = int(company.get('linkedin_max_pages', 20) or 20)
        self.fetch_descriptions = bool(company.get('linkedin_fetch_descriptions', False))
        # Wait between pagination attempts to reduce throttling/authwall frequency.
        self.pagination_delay_seconds = int(company.get('linkedin_pagination_delay_seconds', 5) or 5)
        
        print(f"[INIT] LinkedIn scraper for: {company['name']} (Skills: {len(self.skill_filter.skills)} skills)")
    
    def _build_search_url(self, keywords_str):
        """Build LinkedIn search URL from keywords in api_url field"""
        # Extract keywords from api_url (e.g., "Data Engineer, PySpark")
        if not keywords_str:
            return None
        
        # URL encode the keywords
        from urllib.parse import quote
        encoded_keywords = quote(keywords_str.strip())
        
        # Keep the 6-hour recency filter and fetch more by loading additional results.
        search_url = f"https://www.linkedin.com/jobs/search/?keywords={encoded_keywords}&location=India&distance=25&f_TPR=r21600"
        
        print(f"    [URL] {search_url}")
        return search_url

    def _build_search_terms(self, keywords_str):
        if not keywords_str:
            return []

        terms = []
        for term in keywords_str.split(','):
            cleaned = term.strip().lower()
            if cleaned:
                terms.append(cleaned)
        return terms
    
    async def scrape(self):
        """Scrape jobs from LinkedIn using headless browser"""
        print(f"[SCRAPE] {self.company['name']} with keywords: {self.company.get('api_url', 'N/A')}")
        
        if not self.search_url:
            print(f"    [ERROR] No keywords provided in api_url field")
            return []
        
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                
                # Navigate to LinkedIn search URL (URL handles location + recency filter)
                search_url = self.search_url
                
                await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_selector('div[class*="base-card"]', timeout=10000)

                # STEP 1: Crawl paginated results to reach target volume.
                all_jobs = await self._collect_jobs_across_pages(page)
                print(f"    [TOTAL] {len(all_jobs)} jobs fetched from LinkedIn")
                
                # DEBUG: Show job list in pipe-separated format
                if all_jobs:
                    jobs_list = " | ".join([f"{i+1}. {job['title'][:30]}" for i, job in enumerate(all_jobs)])
                    print(f"    [JOBS] {jobs_list}")
                
                # STEP 2: Fetch descriptions only when explicitly enabled.
                if self.fetch_descriptions:
                    for i, job in enumerate(all_jobs):
                        try:
                            job_url = job.get('job_url')
                            if job_url:
                                await page.goto(job_url, wait_until="domcontentloaded", timeout=20000)
                                await page.wait_for_timeout(1000)
                                description = await self._fetch_description(page)
                                all_jobs[i]['description'] = description or "Description unavailable"
                        except Exception:
                            all_jobs[i]['description'] = "Description unavailable"
                else:
                    for job in all_jobs:
                        if not job.get('description'):
                            job['description'] = "Description not fetched"
                
                await browser.close()
                
                if self.fetch_descriptions:
                    print(f"    [COMPLETE] {len(all_jobs)} jobs with descriptions ready")
                else:
                    print(f"    [COMPLETE] {len(all_jobs)} jobs ready (description fetch skipped)")
                
                # STEP 3: Filter by skills
                filtered_jobs = all_jobs
                if self.skill_filter.skills and len(filtered_jobs) > 0:
                    filtered_jobs = self._filter_linkedin_relevance(filtered_jobs)
                    stats = self.skill_filter.get_stats()
                    matched_skills = stats.get('matched_skills_used', [])
                    print(f"    [FILTER] Skill keywords seen: {matched_skills}")
                
                # STEP 4: Sort by freshness (most recent first)
                filtered_jobs = self._sort_by_freshness(filtered_jobs)
                
                # DEBUG: Show filtered jobs list in pipe-separated format
                if filtered_jobs:
                    matched_list = " | ".join([f"{i+1}. {job['title'][:35]} ({job['location'][:15]})" for i, job in enumerate(filtered_jobs)])
                    print(f"    [MATCHED] {matched_list}")
                    
                    # FULL LIST: title | posted | location
                    print(f"\n    [FULL LIST]")
                    for i, job in enumerate(filtered_jobs):
                        print(f"    {i+1}. {job['title']} | {job['posted_time']} | {job['location']}")
                    print()
                
                return filtered_jobs
        
        except Exception as e:
            print(f"    [ERROR] {str(e)}")
            return []

    def _is_excluded_title(self, title):
        if not title:
            return False
        normalized = str(title).lower()
        return "senior" in normalized or "lead" in normalized

    def _filter_linkedin_relevance(self, jobs):
        if not jobs:
            return jobs

        filtered_jobs = []
        for job in jobs:
            title = job.get('title', '')
            if self._is_excluded_title(title):
                continue
            filtered_jobs.append(job)

        # SkillFilter mutates jobs with matched_skills and stores stats used by the caller.
        skill_matched_jobs = self.skill_filter.filter(filtered_jobs)
        skill_ids = {job.get('job_id') for job in skill_matched_jobs}

        if not self.search_terms:
            return skill_matched_jobs

        title_matched_jobs = []
        title_ids = set()
        for job in filtered_jobs:
            title = str(job.get('title', '')).lower()
            if any(term in title for term in self.search_terms):
                title_matched_jobs.append(job)
                title_ids.add(job.get('job_id'))

        # Keep jobs that match title OR skills.
        combined_jobs = []
        seen_ids = set()
        for job in filtered_jobs:
            job_id = job.get('job_id')
            if job_id in seen_ids:
                continue
            if job_id in skill_ids or job_id in title_ids:
                combined_jobs.append(job)
                seen_ids.add(job_id)

        overlap_count = len(skill_ids.intersection(title_ids))
        title_only_count = len(title_ids - skill_ids)
        skill_only_count = len(skill_ids - title_ids)
        dropped_count = max(0, len(filtered_jobs) - len(combined_jobs))

        print(
            "    [FILTER] LinkedIn relevance: "
            f"title-only={title_only_count}, skill-only={skill_only_count}, overlap={overlap_count}, dropped={dropped_count}"
        )

        return combined_jobs

    async def _fetch_description(self, page):
        selectors = [
            '.show-more-less-html__markup',
            '.description__text',
            '[data-job-id] .show-more-less-html__markup',
            'section.show-more-less-html'
        ]

        for selector in selectors:
            locator = page.locator(selector)
            if await locator.count() == 0:
                continue

            text = await locator.first.text_content()
            cleaned_text = text.strip() if text else ""
            if cleaned_text:
                return cleaned_text[:2000]

        return None

    async def _load_more_results(self, page, max_rounds=8):
        """Expand LinkedIn results on a single search page via scroll + 'See more jobs'."""
        previous_count = 0
        no_growth_rounds = 0
        saw_load_more_button = False
        plateau_card_threshold = min(self.target_jobs, 80)

        for round_num in range(1, max_rounds + 1):
            if round_num > 1:
                print(f"    [PAGE] Waiting {self.pagination_delay_seconds}s before next scroll attempt")
                await page.wait_for_timeout(self.pagination_delay_seconds * 1000)

            cards_locator = page.locator('div.base-card')
            current_count = await cards_locator.count()

            if current_count <= previous_count:
                no_growth_rounds += 1
            else:
                no_growth_rounds = 0

            print(f"    [PAGE] Round {round_num}: {current_count} cards")

            previous_count = current_count

            if current_count >= self.target_jobs:
                print(f"    [PAGE] Target reached ({self.target_jobs})")
                break

            if no_growth_rounds >= 2 and (saw_load_more_button or current_count >= plateau_card_threshold):
                print(f"    [PAGE] Card count plateaued at {current_count}; stopping pagination")
                break

            # Scroll to trigger lazy-loading.
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(1200)

            # Click load-more button when it appears.
            load_more = page.locator("button.infinite-scroller__show-more-button")
            if await load_more.count() > 0 and await load_more.first.is_visible():
                if not saw_load_more_button:
                    print("    [PAGE] Detected 'See more jobs' button")
                saw_load_more_button = True
                try:
                    await load_more.first.click(timeout=5000)
                    print("    [PAGE] Clicked 'See more jobs'")
                    await page.wait_for_timeout(1500)
                except Exception:
                    # LinkedIn may show an auth/sign-in overlay that intercepts clicks.
                    # Stop pagination and continue scraping currently loaded cards.
                    print("    [PAGE] Load-more blocked by overlay; continuing with loaded cards")
                    break

        final_count = await page.locator('div.base-card').count()
        if not saw_load_more_button:
            print("    [PAGE] 'See more jobs' button was not shown in this run")
        print(f"    [PAGE] Final loaded cards: {final_count}")

    async def _collect_jobs_across_pages(self, page):
        """Collect jobs from a single LinkedIn search result page using scroll/load-more rounds."""
        await self._load_more_results(page, max_rounds=self.max_pages)

        content = await page.content()
        all_jobs = self._parse_linkedin_jobs(content)
        all_jobs = self._dedupe_jobs(all_jobs)

        print(f"    [PAGE] Scroll collection complete: {len(all_jobs)} unique jobs")
        return all_jobs

    def _dedupe_jobs(self, jobs):
        """Deduplicate parsed jobs by (company_id, job_id)."""
        deduped = []
        seen = set()

        for job in jobs:
            key = (job.get('company_id'), job.get('job_id'))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(job)

        return deduped
    
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