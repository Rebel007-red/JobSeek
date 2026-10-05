import asyncio
import os
import re
import sys
from datetime import date, datetime
from urllib.parse import quote

from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

from scraper_common import (
	fetch_companies,
	fetch_user_roles,
	first_text,
	format_calendar_date,
	format_days_ago,
	print_companies,
	write_recent_jobs,
)

BLOCKED_URL_MARKERS = ("authwall", "/login", "checkpoint")

# Job detail page: "About the job" text plus the job criteria list, fallbacks when it is missing, and the company name
ABOUT_SELECTOR = ".show-more-less-html__markup"
METADATA_SELECTORS = [
	".description__job-criteria-list",
	".description__job-criteria-text",
	".description__job-criteria-subheader",
]
DESCRIPTION_SELECTORS = [
	".show-more-less-html__markup",
	".description__text",
	"[data-job-id] .show-more-less-html__markup",
	"section.show-more-less-html",
]
COMPANY_SELECTORS = [
	".artdeco-entity-lockup__subtitle.ember-view",
	".job-details-jobs-unified-top-card__company-name",
]

# Searches per run (Companies rows first, then user roles), pause between searches, and results per role search
MAX_LINKEDIN_SEARCHES = int(os.getenv("MAX_LINKEDIN_SEARCHES", "60"))
SEARCH_DELAY_SECONDS = int(os.getenv("LINKEDIN_SEARCH_DELAY_SECONDS", "5"))
ROLE_SEARCH_TARGET_JOBS = int(os.getenv("LINKEDIN_ROLE_TARGET_JOBS", "100"))


def build_searches(companies, roles):
	"""Companies rows (admin-managed keywords) plus one search per user role not already covered, capped."""
	covered = {(company.get("api_url") or "").strip().lower() for company in companies}
	role_searches = [
		{"name": f"Role | {role}", "api_url": role, "linkedin_target_jobs": ROLE_SEARCH_TARGET_JOBS}
		for role in roles
		if role.strip().lower() not in covered
	]
	searches = companies + role_searches
	if len(searches) > MAX_LINKEDIN_SEARCHES:
		dropped = [search.get("name") for search in searches[MAX_LINKEDIN_SEARCHES:]]
		print(f"[WARN] {len(searches)} searches exceed MAX_LINKEDIN_SEARCHES={MAX_LINKEDIN_SEARCHES}; skipping: {', '.join(dropped)}")
		searches = searches[:MAX_LINKEDIN_SEARCHES]
	return searches


def build_search_url(keywords_str):
	if not keywords_str:
		return None

	encoded_keywords = quote(keywords_str.strip())
	return f"https://www.linkedin.com/jobs/search/?keywords={encoded_keywords}&location=India&distance=25&f_TPR=r21600"


def posted_time_to_days(posted_time):
	value = (posted_time or "").strip().lower()
	if not value:
		return None
	if "just now" in value or "minute" in value or "hour" in value or "today" in value:
		return 0
	if "yesterday" in value:
		return 1

	match = re.search(r"(\d+)\s+days?\s+ago", value)
	if match:
		return int(match.group(1))

	return None


def format_posted_date(posted_datetime):
	value = (posted_datetime or "").strip()
	if not value:
		return ""

	try:
		return format_calendar_date(datetime.fromisoformat(value.replace("Z", "+00:00")).date())
	except ValueError:
		return value


def parse_linkedin_jobs(html_content):
	soup = BeautifulSoup(html_content, "html.parser")
	jobs = []
	job_cards = soup.find_all("div", class_="base-card")

	for card in job_cards:
		try:
			job_link = card.find("a", class_="base-card__full-link")
			if not job_link or not job_link.get("href"):
				continue

			# Drop tracking query params so the same job always has the same URL.
			job_url = job_link["href"].split("?", 1)[0]
			match = re.search(r"/view/(?:[^/?]*-)?(\d+)", job_url) or re.search(r"/view/([^/?]+)", job_url)
			if not match:
				continue
			job_id = match.group(1)

			title_elem = card.find("h3", class_="base-search-card__title")
			title = title_elem.get_text(strip=True) if title_elem else ""
			if not title:
				continue

			company_elem = card.find("h4", class_="base-search-card__subtitle")
			company = company_elem.get_text(strip=True) if company_elem else ""

			location_elem = card.find("span", class_="job-search-card__location")
			location = location_elem.get_text(strip=True) if location_elem else "Not specified"

			time_elem = card.find("time")
			posted_datetime = time_elem.get("datetime") if time_elem else ""
			posted_time = time_elem.get_text(strip=True) if time_elem else "Unknown"

			jobs.append({
				"company_name": f"LinkedIn | {company}" if company else "LinkedIn",
				"job_id": job_id,
				"title": title,
				"location": location,
				"job_url": job_url,
				"posted_datetime": posted_datetime,
				"posted_time": posted_time,
				"description": "",
			})
		except Exception:
			continue

	return jobs


def dedupe_jobs(jobs):
	deduped = []
	seen = set()
	for job in jobs:
		key = job.get("job_id") or job.get("job_url")
		if key in seen:
			continue
		seen.add(key)
		deduped.append(job)
	return deduped


async def load_more_results(page, target_jobs, max_rounds, pagination_delay_seconds):
	previous_count = 0
	no_growth_rounds = 0
	saw_load_more_button = False
	plateau_card_threshold = min(target_jobs, 80)

	for round_num in range(1, max_rounds + 1):
		if round_num > 1:
			await page.wait_for_timeout(pagination_delay_seconds * 1000)

		cards_locator = page.locator('div.base-card')
		current_count = await cards_locator.count()

		if current_count <= previous_count:
			no_growth_rounds += 1
		else:
			no_growth_rounds = 0

		previous_count = current_count

		if current_count >= target_jobs:
			break

		if no_growth_rounds >= 2 and (saw_load_more_button or current_count >= plateau_card_threshold):
			break

		await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
		await page.wait_for_timeout(1200)

		load_more = page.locator("button.infinite-scroller__show-more-button")
		if await load_more.count() > 0 and await load_more.first.is_visible():
			saw_load_more_button = True
			try:
				await load_more.first.click(timeout=5000)
				await page.wait_for_timeout(1500)
			except Exception:
				break

	return await page.locator('div.base-card').count()


async def read_linkedin_description(page, job):
	"""Description of a job detail page; also replaces the card's company name with the page's when present."""
	await page.goto(job["job_url"], wait_until="domcontentloaded", timeout=20000)
	await page.wait_for_timeout(1000)
	for selector in COMPANY_SELECTORS:
		company = await first_text(page, selector)
		if company:
			job["company_name"] = f"LinkedIn | {company}"
			break

	description = ""
	if await page.locator(ABOUT_SELECTOR).count() > 0:
		metadata_parts = []
		for selector in METADATA_SELECTORS:
			locators = page.locator(selector)
			for idx in range(await locators.count()):
				text = await locators.nth(idx).text_content()
				if text and text.strip():
					metadata_parts.append(text.strip())
		about = await first_text(page, ABOUT_SELECTOR)
		description = " ".join(part for part in (about, " ".join(metadata_parts)) if part)

	for selector in DESCRIPTION_SELECTORS:
		if description:
			break
		description = await first_text(page, selector)
	return description


async def scrape_linkedin_jobs(company):
	"""Return a list of jobs, or None when the search failed or LinkedIn blocked the request."""
	keywords = company.get("api_url", "")
	search_url = build_search_url(keywords)
	if not search_url:
		print(f"    [ERROR] No keywords provided in api_url field for {company.get('name')}")
		return None

	target_jobs = int(company.get("linkedin_target_jobs", 250) or 250)
	max_pages = int(company.get("linkedin_max_pages", 20) or 20)
	pagination_delay_seconds = int(company.get("linkedin_pagination_delay_seconds", 5) or 5)

	try:
		async with async_playwright() as p:
			browser = await p.chromium.launch(headless=True)
			try:
				page = await browser.new_page()
				response = await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
				if response is not None and response.status >= 400:
					print(f"    [WARN] LinkedIn returned HTTP {response.status}")
					return None
				if any(marker in page.url for marker in BLOCKED_URL_MARKERS):
					print(f"    [WARN] LinkedIn redirected to a login/authwall page: {page.url}")
					return None

				try:
					await page.wait_for_selector('div[class*="base-card"]', timeout=10000)
				except Exception:
					print("    [WARN] No LinkedIn job cards found")
					return []

				loaded_count = await load_more_results(page, target_jobs, max_pages, pagination_delay_seconds)
				html = await page.content()
			finally:
				await browser.close()
	except Exception as exc:
		print(f"    [WARN] Failed to fetch LinkedIn jobs: {exc}")
		return None

	jobs = dedupe_jobs(parse_linkedin_jobs(html))
	print(f"[SCRAPE] LinkedIn loaded {loaded_count} cards and parsed {len(jobs)} jobs")
	return jobs


async def collect_linkedin_jobs(companies):
	collected_jobs = []
	failed_companies = []
	seen_job_ids = set()
	duplicate_count = 0
	collected_on = format_calendar_date(date.today())

	for index, company in enumerate(companies):
		if index and SEARCH_DELAY_SECONDS > 0:
			await asyncio.sleep(SEARCH_DELAY_SECONDS)  # spread searches out to avoid LinkedIn's authwall
		company_name = company.get("name") or "Unknown"
		jobs = await scrape_linkedin_jobs(company)
		if jobs is None:
			failed_companies.append(company_name)
			print(f"[COMPANY] {company_name}: failed")
			continue
		print(f"[COMPANY] {company_name}: jobs found {len(jobs)}")

		company_url = build_search_url(company.get("api_url", "")) or ""
		for job in jobs:
			job_id = job.get("job_id", "")
			if job_id in seen_job_ids:
				duplicate_count += 1
				continue
			seen_job_ids.add(job_id)

			posted_days = posted_time_to_days(job.get("posted_time", ""))
			posted_datetime = (job.get("posted_datetime") or "").strip()
			posted_date = format_posted_date(posted_datetime) if posted_datetime else format_days_ago(posted_days)

			collected_jobs.append({
				"company_name": job["company_name"],
				"ats_type": "linkedin",
				"company_url": company_url,
				"job_id": job.get("job_id", ""),
				"title": job.get("title", ""),
				"location": job.get("location", ""),
				"posted_date": posted_date,
				"job_url": job.get("job_url", ""),
				"description": job.get("description", ""),
				"collected_on": collected_on,
				"posted_days": posted_days,
			})

	if duplicate_count:
		print(f"[DEDUPE] Skipped {duplicate_count} LinkedIn jobs already seen in another search")

	return collected_jobs, failed_companies


async def main():
	companies = await fetch_companies("linkedin", "name,api_url,ats_type,disabled")
	print_companies(companies, "LinkedIn")
	searches = build_searches(companies, await fetch_user_roles())
	print(f"[INFO] LinkedIn searches this run: {len(searches)} -> {', '.join(search.get('name') or '?' for search in searches)}")
	if not searches:
		print("[ERROR] No LinkedIn searches to run.")
		sys.exit(1)

	jobs, failed_companies = await collect_linkedin_jobs(searches)
	filtered_jobs_dataframe, output_file = await write_recent_jobs(jobs, "LinkedIn", "linkedin", read_linkedin_description)

	print(
		f"[SUMMARY] searches={len(searches)} failed={len(failed_companies)} "
		f"jobs_scraped={len(jobs)} jobs_written={len(filtered_jobs_dataframe)} "
		f"missing_descriptions={int((filtered_jobs_dataframe['description'] == '').sum())}"
	)
	if failed_companies:
		print(f"[SUMMARY] failed searches: {', '.join(failed_companies)}")

	if not output_file:
		sys.exit(1)
	if len(failed_companies) == len(searches):
		print("[ERROR] All LinkedIn searches failed.")
		sys.exit(1)


if __name__ == "__main__":
	asyncio.run(main())
