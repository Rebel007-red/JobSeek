import os
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse

import aiohttp
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).parent.parent))
from skill_Filter import SkillFilter


class Scraper:
    def __init__(self, company):
        self.company = company
        self.company_slug = company.get('slug') or company.get('greenhouse_slug') or ''
        self.board_url = company.get('api_url') or company.get('board_url') or ''
        self.location_filter = (company.get('location_filter') or 'India').strip()
        self.date_filter = company.get('date_filter', ['today', 'yesterday', '1 day', '2 days', '3 days'])
        self.skill_filter = SkillFilter(company.get('user_skills', []))

        if not self.board_url and self.company_slug:
            self.board_url = self._normalize_board_url(self.company_slug)

        print(f"[INIT] Greenhouse scraper for: {company['name']} (board_url: {self.board_url or 'n/a'}, skills: {len(self.skill_filter.skills)})")

    def _normalize_board_url(self, raw_value):
        value = (raw_value or '').strip().rstrip('/')
        if not value:
            return ''

        if value.startswith('http://') or value.startswith('https://'):
            return value

        if 'greenhouse.io' in value:
            return f"https://{value.lstrip('/')}"

        if value.startswith('/'):
            return f"https://job-boards.greenhouse.io{value}"

        return f"https://job-boards.greenhouse.io/{value.lstrip('/')}"

    async def scrape(self):
        if not self.board_url:
            print(f"    [ERROR] Missing greenhouse board URL for {self.company['name']}")
            return []

        try:
            board_api_url = self._board_api_url(self.board_url)
            async with aiohttp.ClientSession() as session:
                async with session.get(board_api_url, timeout=30) as response:
                    if response.status != 200:
                        print(f"    [WARN] Greenhouse API returned {response.status} for {board_api_url}")
                        return []

                    payload = await response.json()
                    jobs = self._parse_jobs_from_api(payload)

            print(f"    [TOTAL] {len(jobs)} jobs fetched from Greenhouse API")

            filtered_jobs = self._filter_by_location(jobs)
            print(f"    [FILTER] Location filter: {len(jobs)} -> {len(filtered_jobs)} jobs")

            filtered_jobs = self._filter_by_posted_date(filtered_jobs)
            print(f"    [FILTER] Date filter: {len(filtered_jobs)} jobs remaining")

            # Description pages are not needed for the public API payload; the job content is not included.
            for job in filtered_jobs:
                job['description'] = 'Description unavailable'

            if self.skill_filter.skills and filtered_jobs:
                filtered_jobs = self.skill_filter.filter(filtered_jobs)
                stats = self.skill_filter.get_stats()
                print(f"    [FILTER] Skills filter: {stats.get('total_matched', 0)} jobs matched")

            return filtered_jobs
        except Exception as e:
            print(f"    [ERROR] Greenhouse scrape failed: {str(e)}")
            return []

    def _board_api_url(self, board_url):
        parsed = urlparse(board_url)
        board_name = parsed.path.strip('/').split('/')[-1]
        if not board_name:
            board_name = (self.company_slug or self.company.get('slug') or '').strip().strip('/')
        if not board_name:
            raise ValueError(f"Unable to derive Greenhouse board slug from {board_url}")
        return f"https://boards-api.greenhouse.io/v1/boards/{board_name}/jobs"

    def _parse_jobs_from_api(self, payload):
        jobs = payload.get('jobs', []) if isinstance(payload, dict) else []
        parsed_jobs = []
        for item in jobs:
            if not isinstance(item, dict):
                continue

            title = (item.get('title') or '').strip()
            if not title:
                continue

            location = (item.get('location') or {})
            location_name = location.get('name') if isinstance(location, dict) else location
            raw_url = item.get('absolute_url') or item.get('url') or item.get('job_url') or self.board_url
            job_id = str(item.get('id') or self._extract_job_id(raw_url) or f"{self.company['id']}_{len(parsed_jobs)}")

            parsed_jobs.append({
                'company_id': self.company['id'],
                'job_id': job_id,
                'title': title,
                'location': location_name or 'Not specified',
                'job_url': raw_url,
                'posted_date': item.get('first_published') or 'Today',
                'description': 'Description unavailable',
                'posted_at': item.get('updated_at') or datetime.now().isoformat(),
                'skills': []
            })

        return parsed_jobs

    def _parse_jobs(self, html_content):
        soup = BeautifulSoup(html_content, 'html.parser')
        jobs = []

        for card in soup.select('a[href*="/jobs/"]'):
            href = card.get('href', '')
            if not href or '/jobs/' not in href:
                continue

            title = card.get_text(' ', strip=True)
            if not title:
                continue

            raw_url = href if href.startswith('http') else urljoin(self.board_url, href)
            job_id = self._extract_job_id(raw_url)
            location = self._extract_location(card)
            posted_date = self._extract_posted_date(card)

            jobs.append({
                'company_id': self.company['id'],
                'job_id': job_id or f"{self.company['id']}_{len(jobs)}",
                'title': title,
                'location': location,
                'job_url': raw_url,
                'posted_date': posted_date,
                'description': 'Pending...',
                'posted_at': datetime.now().isoformat(),
                'skills': []
            })

        return jobs

    async def _find_next_page_link(self, page):
        selectors = [
            'a[aria-label="Next page"]',
            'a[rel="next"]',
            'a.pagination-next',
            'button[aria-label="Next page"]',
            'a[href*="page="]',
        ]
        for selector in selectors:
            locator = page.locator(selector).first
            try:
                count = await locator.count()
                if count > 0:
                    return locator
            except Exception:
                pass
        return None

    def _extract_job_id(self, url):
        match = re.search(r'/jobs/(?:[^/]+-)?(\d+)', url)
        if match:
            return match.group(1)
        return re.sub(r'[^a-zA-Z0-9_-]', '_', url)[:80]

    def _extract_location(self, card):
        parent = card.find_parent()
        if not parent:
            return 'Not specified'

        location = parent.select_one('[data-metric="location"], .location, .job-location, .location-name')
        if location:
            return location.get_text(' ', strip=True)

        text = parent.get_text(' ', strip=True)
        if '·' in text:
            parts = [p.strip() for p in text.split('·') if p.strip()]
            if len(parts) >= 2:
                return parts[-1]
        return 'Not specified'

    def _extract_posted_date(self, card):
        parent = card.find_parent()
        if not parent:
            return 'Not specified'

        date_el = parent.select_one('.job-posted, .job-date, .timestamp, [data-metric="posted"]')
        if date_el:
            return date_el.get_text(' ', strip=True)

        return 'Today'

    async def _extract_job_description(self, page):
        selectors = [
            '.job-description',
            '.app-job-description',
            '.content',
            '[data-testid="job-description"]',
            '.description',
            '.job-posting',
            'article',
            'main'
        ]

        for selector in selectors:
            try:
                locator = page.locator(selector).first
                if await locator.count() > 0:
                    text = await locator.text_content()
                    if text and len(text.strip()) > 80:
                        return text.strip()
            except Exception:
                pass

        try:
            body = await page.locator('body').text_content()
            if body and len(body.strip()) > 80:
                return body.strip()
        except Exception:
            pass

        return ''

    def _filter_by_location(self, jobs):
        """Only keep roles tied to India or Indian cities; India remote is allowed."""
        india_markers = [
            'india', 'indian', 'bengaluru', 'bangalore', 'hyderabad', 'gurugram', 'gurgaon',
            'delhi', 'mumbai', 'pune', 'chennai', 'kochi', 'ahmedabad', 'noida', 'kolkata',
            'jaipur', 'lucknow', 'bhubaneswar', 'visakhapatnam', 'coimbatore', 'trivandrum',
            'india remote', 'remote - india', 'remote india'
        ]

        filtered = []
        for job in jobs:
            location = (job.get('location') or '').lower().strip()
            if not location or location == 'not specified':
                continue

            if 'remote' in location and 'india' in location:
                filtered.append(job)
                continue

            if any(marker in location for marker in india_markers):
                filtered.append(job)

        return filtered

    def _filter_by_posted_date(self, jobs):
        """Greenhouse boards often do not expose reliable posted-age text.
        Keep all jobs instead of dropping them on weak or missing date labels.
        """
        return list(jobs)
