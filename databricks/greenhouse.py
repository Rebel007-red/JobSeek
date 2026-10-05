import asyncio
import html
import re
import sys
from datetime import date, datetime
from urllib.parse import urlparse

import aiohttp
from bs4 import BeautifulSoup

from scraper_common import (
	fetch_companies,
	first_text,
	format_calendar_date,
	goto_settled,
	print_companies,
	relative_text_to_days,
	write_recent_jobs,
)

DESCRIPTION_SELECTORS = [
	".job-description",
	".app-job-description",
	".content",
	'[data-testid="job-description"]',
	".description",
	".job-posting",
	"article",
	"main",
]


def normalize_board_url(raw_value):
	value = (raw_value or "").strip().rstrip("/")
	if not value:
		return ""

	if value.startswith("http://") or value.startswith("https://"):
		return value

	if "greenhouse.io" in value:
		return f"https://{value.lstrip('/')}"

	if value.startswith("/"):
		return f"https://job-boards.greenhouse.io{value}"

	return f"https://job-boards.greenhouse.io/{value.lstrip('/')}"


def board_api_url(board_url):
	parsed = urlparse(board_url)
	board_name = parsed.path.strip("/").split("/")[-1]
	if not board_name:
		raise ValueError(f"Unable to derive Greenhouse board slug from {board_url}")
	return f"https://boards-api.greenhouse.io/v1/boards/{board_name}/jobs?content=true"


def extract_greenhouse_job_id(job_url, fallback_value=""):
	value = (job_url or "").strip()
	if not value:
		return str(fallback_value or "")

	match = re.search(r"/jobs/(?:[^/]+-)?(\d+)", value)
	if match:
		return match.group(1)

	return str(fallback_value or re.sub(r"[^a-zA-Z0-9_-]", "_", value)[:80])


def greenhouse_content_to_text(content):
	value = content or ""
	if not value:
		return ""

	decoded = html.unescape(value)
	return BeautifulSoup(decoded, "html.parser").get_text(" ", strip=True)


def parse_iso_date(posted_date):
	"""Local calendar date of an ISO timestamp, or None when the value isn't one."""
	try:
		# Convert to local time (IST via TZ) before taking the date so it matches date.today().
		return datetime.fromisoformat((posted_date or "").strip().replace("Z", "+00:00")).astimezone().date()
	except ValueError:
		return None


def posted_iso_to_days(posted_date):
	parsed = parse_iso_date(posted_date)
	if parsed:
		return (date.today() - parsed).days
	return relative_text_to_days(posted_date)


def format_posted_date(posted_date):
	parsed = parse_iso_date(posted_date)
	if parsed:
		return format_calendar_date(parsed)
	return (posted_date or "").strip()


def parse_jobs_from_api(payload, board_url):
	jobs = payload.get("jobs", []) if isinstance(payload, dict) else []
	parsed_jobs = []
	missing_published = 0

	for item in jobs:
		if not isinstance(item, dict):
			continue

		title = (item.get("title") or "").strip()
		if not title:
			continue

		# Only first_published reflects when a job was posted; updated_at changes on every edit.
		posted_date = item.get("first_published") or ""
		if not posted_date:
			missing_published += 1
			continue

		location = item.get("location") or {}
		location_name = location.get("name") if isinstance(location, dict) else location
		job_url = item.get("absolute_url") or item.get("url") or item.get("job_url") or board_url
		job_id = str(item.get("id") or extract_greenhouse_job_id(job_url, len(parsed_jobs)))

		parsed_jobs.append({
			"job_id": job_id,
			"title": title,
			"location": location_name or "Not specified",
			"job_url": job_url,
			"posted_date": posted_date,
			"description": greenhouse_content_to_text(item.get("content", "")),
		})

	if missing_published:
		print(f"    [WARN] Skipped {missing_published} Greenhouse jobs without first_published")

	return parsed_jobs


async def fetch_board_jobs(session, api_url, attempts=3):
	"""Return the board payload, or None after non-retryable errors or exhausted retries."""
	for attempt in range(1, attempts + 1):
		try:
			async with session.get(api_url, timeout=aiohttp.ClientTimeout(total=30)) as response:
				if response.status == 200:
					return await response.json()
				print(f"    [WARN] Greenhouse API returned {response.status} for {api_url} (attempt {attempt}/{attempts})")
				if response.status < 500 and response.status != 429:
					return None
		except Exception as exc:
			print(f"    [WARN] Greenhouse API request failed for {api_url} (attempt {attempt}/{attempts}): {exc}")

		if attempt < attempts:
			await asyncio.sleep(2 ** attempt)

	return None


async def read_greenhouse_description(page, job):
	"""Only used when the board API returned no content for a job."""
	await goto_settled(page, job["job_url"])
	await page.wait_for_timeout(1000)
	for selector in DESCRIPTION_SELECTORS:
		text = await first_text(page, selector)
		if len(text) > 80:
			return text
	return await first_text(page, "body")


async def collect_greenhouse_jobs(companies):
	collected_jobs = []
	failed_companies = []
	collected_on = format_calendar_date(date.today())

	async with aiohttp.ClientSession() as session:
		for company in companies:
			company_name = company.get("name") or "Unknown"
			board_url = company.get("slug") or company.get("greenhouse_slug") or company.get("api_url") or company.get("board_url") or ""
			board_url = normalize_board_url(board_url)
			if not board_url:
				print(f"    [WARN] Missing Greenhouse board URL for {company_name}")
				failed_companies.append(company_name)
				continue

			try:
				api_url = board_api_url(board_url)
			except ValueError as exc:
				print(f"    [WARN] {exc}")
				failed_companies.append(company_name)
				continue

			payload = await fetch_board_jobs(session, api_url)
			if payload is None:
				print(f"[COMPANY] {company_name}: failed")
				failed_companies.append(company_name)
				continue

			jobs = parse_jobs_from_api(payload, board_url)
			print(f"[COMPANY] {company_name}: jobs found {len(jobs)}")
			for job in jobs:
				posted_date = job.get("posted_date", "")
				collected_jobs.append({
					"company_name": company_name,
					"ats_type": "greenhouse",
					"company_url": board_url,
					"job_id": job.get("job_id", ""),
					"title": job.get("title", ""),
					"location": job.get("location", ""),
					"posted_date": format_posted_date(posted_date),
					"job_url": job.get("job_url", ""),
					"description": job.get("description", ""),
					"collected_on": collected_on,
					"posted_days": posted_iso_to_days(posted_date),
				})

	return collected_jobs, failed_companies


async def main():
	companies = await fetch_companies("greenhouse", "name,ats_type,disabled,slug")
	print_companies(companies, "Greenhouse")
	if not companies:
		print("[ERROR] No Greenhouse companies to scrape.")
		sys.exit(1)

	jobs, failed_companies = await collect_greenhouse_jobs(companies)
	filtered_jobs_dataframe, output_file = await write_recent_jobs(jobs, "Greenhouse", "greenhouse", read_greenhouse_description)

	print(
		f"[SUMMARY] companies={len(companies)} failed={len(failed_companies)} "
		f"jobs_scraped={len(jobs)} jobs_written={len(filtered_jobs_dataframe)} "
		f"missing_descriptions={int((filtered_jobs_dataframe['description'] == '').sum())}"
	)
	if failed_companies:
		print(f"[SUMMARY] failed companies: {', '.join(failed_companies)}")

	if not output_file:
		sys.exit(1)
	if len(failed_companies) == len(companies):
		print("[ERROR] All Greenhouse companies failed.")
		sys.exit(1)


if __name__ == "__main__":
	asyncio.run(main())
