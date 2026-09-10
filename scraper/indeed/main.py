from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
import sys
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import quote_plus, urljoin, urlparse

# Add parent directory to sys.path to import skill_Filter
sys.path.insert(0, str(Path(__file__).parent.parent))
from skill_Filter import SkillFilter


class Scraper:
    def __init__(self, company):
        self.company = company
        self.skill_filter = SkillFilter(company.get('user_skills', []))

        self.search_url = self._build_search_url(company.get('api_url', ''))
        self.target_jobs = int(company.get('indeed_target_jobs', 50) or 50)
        self.max_pages = int(company.get('indeed_max_pages', 3) or 3)
        self.fetch_descriptions = bool(company.get('indeed_fetch_descriptions', False))

        print(f"[INIT] Indeed scraper for: {company['name']} (Skills: {len(self.skill_filter.skills)} skills)")

    def _build_search_url(self, keywords_str):
        """Build Indeed search URL from the configured keywords."""
        if not keywords_str:
            return None

        if keywords_str.startswith('http'):
            parsed = urlparse(keywords_str)
            if 'indeed.com' in parsed.netloc:
                print(f"    [URL] {keywords_str}")
                return keywords_str

        query = keywords_str.strip()
        encoded = quote_plus(query)
        search_url = f"https://in.indeed.com/jobs?q={encoded}&l=India&fromage=1&sort=date"
        print(f"    [URL] {search_url}")
        return search_url

    async def scrape(self):
        """Scrape jobs from Indeed using headless browser."""
        print(f"[SCRAPE] {self.company['name']} with keywords: {self.company.get('api_url', 'N/A')}")

        if not self.search_url:
            print("    [ERROR] No keywords provided in api_url field")
            return []

        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                    viewport={"width": 1440, "height": 2200},
                    locale="en-IN",
                    extra_http_headers={"Accept-Language": "en-IN,en;q=0.9"}
                )
                await page.goto(self.search_url, wait_until="networkidle", timeout=60000)

                try:
                    await page.wait_for_selector('a.jcs-JobTitle, .jobTitle', timeout=10000)
                except Exception:
                    print("    [WARN] No Indeed job cards detected on the first page")

                all_jobs = await self._collect_jobs_across_pages(page)
                print(f"    [TOTAL] {len(all_jobs)} jobs fetched from Indeed")

                if all_jobs:
                    jobs_list = " | ".join([f"{i + 1}. {job['title'][:35]}" for i, job in enumerate(all_jobs[:10])])
                    print(f"    [JOBS] {jobs_list}")

                if self.fetch_descriptions:
                    for i, job in enumerate(all_jobs):
                        try:
                            description = await self._fetch_description(page, job.get('job_url'))
                            all_jobs[i]['description'] = description or "No description"
                        except Exception:
                            all_jobs[i]['description'] = "Description unavailable"
                else:
                    for job in all_jobs:
                        job['description'] = job.get('description', 'Description not fetched')

                await browser.close()

                filtered_jobs = all_jobs
                if self.skill_filter.skills and len(filtered_jobs) > 0:
                    filtered_jobs = self.skill_filter.filter(filtered_jobs)
                    stats = self.skill_filter.get_stats()
                    matched_skills = stats.get('matched_skills_used', [])
                    print(f"    [FILTER] Skills filter: {stats.get('total_matched', 0)} jobs matched (Skills: {matched_skills})")

                filtered_jobs = self._sort_by_freshness(filtered_jobs)

                if filtered_jobs:
                    matched_list = " | ".join([f"{i + 1}. {job['title'][:35]} ({job['location'][:15]})" for i, job in enumerate(filtered_jobs[:10])])
                    print(f"    [MATCHED] {matched_list}")

                print(f"    [COMPLETE] {len(filtered_jobs)} jobs ready")
                return filtered_jobs

        except Exception as e:
            print(f"    [ERROR] {str(e)}")
            return []

    async def _fetch_description(self, page, job_url):
        if not job_url:
            return "No description"
        try:
            await page.goto(job_url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(1500)
            selectors = [
                '#jobDescriptionText',
                '.jobsearch-JobDescriptionText',
                '[data-testid="jobsearch-JobDescription"]',
                '.jobsearch-jobDescriptionText'
            ]
            for selector in selectors:
                locator = page.locator(selector)
                if await locator.count() > 0:
                    description = await locator.first.text_content()
                    return description.strip() if description else "No description"
            full_text = await page.text_content('body')
            return full_text[:2000] if full_text else "No description"
        except Exception:
            return "Description unavailable"

    async def _collect_jobs_across_pages(self, page):
        """Collect unique jobs from several Indeed result pages."""
        seen = set()
        all_jobs = []

        for page_num in range(1, self.max_pages + 1):
            content = await page.content()
            jobs = self._parse_indeed_jobs(content)

            for job in jobs:
                key = (job.get('company_id'), job.get('job_id'))
                if key in seen:
                    continue
                seen.add(key)
                all_jobs.append(job)

            if len(all_jobs) >= self.target_jobs:
                print(f"    [PAGE] Target reached ({self.target_jobs})")
                break

            next_page = page.locator('a[aria-label="Next Page"], a[data-testid="pagination-page-next"]')
            if await next_page.count() == 0:
                break

            try:
                await next_page.first.click(timeout=5000)
                await page.wait_for_load_state("networkidle", timeout=30000)
                print(f"    [PAGE] Moved to Indeed page {page_num + 1}")
            except Exception:
                break

        print(f"    [PAGE] Scroll collection complete: {len(all_jobs)} unique jobs")
        return all_jobs

    def _dedupe_jobs(self, jobs):
        deduped = []
        seen = set()
        for job in jobs:
            key = (job.get('company_id'), job.get('job_id'))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(job)
        return deduped

    def _parse_indeed_jobs(self, html_content):
        """Parse Indeed job cards from the HTML response."""
        soup = BeautifulSoup(html_content, 'html.parser')
        jobs = []

        anchors = soup.select('a.jcs-JobTitle')
        if not anchors:
            return jobs

        for idx, anchor in enumerate(anchors):
            try:
                title = anchor.get_text(' ', strip=True)
                if not title:
                    continue

                href = anchor.get('href', '')
                if href.startswith('/'):
                    job_url = urljoin('https://in.indeed.com', href)
                elif href.startswith('http'):
                    job_url = href
                else:
                    job_url = f"https://in.indeed.com/{href.lstrip('/')}"

                match = re.search(r'[?&](?:jk|vjk)=([A-Za-z0-9]+)', href)
                job_id = match.group(1) if match else anchor.get('id', '').replace('job_', '') or f"indeed_{idx}_{abs(hash(title))}"

                card = anchor.find_parent(['li', 'div', 'article']) or anchor.parent
                if card and not card.select_one('.job_seen_beacon'):
                    card = card.find_parent(['li', 'div', 'article']) or card

                company = "No company"
                company_elem = None
                if card:
                    company_elem = card.select_one('[data-testid="company-name"], .companyName, .company-name, .company')
                if company_elem:
                    company = company_elem.get_text(' ', strip=True) or company

                location = "Not specified"
                location_elem = None
                if card:
                    location_elem = card.select_one('[data-testid="text-location"], .companyLocation, .location, .job-location')
                if location_elem:
                    location = location_elem.get_text(' ', strip=True) or location

                posted_time = "Unknown"
                time_elem = None
                if card:
                    time_elem = card.select_one('[data-testid="attribute_snippet_testid"], .date, .job-search-card__date, .result-link-bar')
                if time_elem:
                    posted_time = time_elem.get_text(' ', strip=True) or posted_time

                jobs.append({
                    'company_id': self.company['id'],
                    'job_id': job_id,
                    'title': title,
                    'company': company,
                    'location': location,
                    'job_url': job_url,
                    'posted_time': posted_time,
                    'posted_date': posted_time,
                    'posted_at': datetime.now().isoformat(),
                    'description': 'Pending...',
                    'matched_skills': []
                })
            except Exception:
                continue

        return self._dedupe_jobs(jobs)

    def _sort_by_freshness(self, jobs):
        """Sort jobs by how recently they were posted."""
        def get_freshness_score(job):
            posted_time = str(job.get('posted_time', '')).lower().strip()

            if not posted_time or posted_time == 'unknown':
                return -999999

            hours_match = re.search(r'(\d+)\s+hours?\s+ago', posted_time)
            if hours_match:
                return -int(hours_match.group(1))

            days_match = re.search(r'(\d+)\s+days?\s+ago', posted_time)
            if days_match:
                return -(int(days_match.group(1)) * 24)

            if 'today' in posted_time or 'just now' in posted_time or 'minute' in posted_time:
                return -1

            return -999999

        sorted_jobs = sorted(jobs, key=get_freshness_score)
        print("    [SORT] Jobs sorted by freshness (most recent first)")
        return sorted_jobs

