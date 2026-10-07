import asyncio
import html
import re
import sys
from datetime import date, datetime
from urllib.parse import parse_qs, urlparse

import aiohttp
from bs4 import BeautifulSoup

from scraper_common import (
	ScrapeFailed,
	fetch_companies,
	first_text,
	format_calendar_date,
	goto_settled,
	print_companies,
	relative_text_to_days,
	scrape_report,
	short_error,
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


BOARD_TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")


def board_token(value):
	"""Greenhouse board token of a bare token ("stripe"), a board URL (job-boards.greenhouse.io/stripe[/jobs/<id>],
	boards.greenhouse.io/stripe, the embed link with ?for=stripe) or an API URL (boards-api.greenhouse.io/v1/boards/stripe/jobs);
	None when the value is none of these. Settings > Companies (CompaniesPanel) derives the token with the same rules.
	"""
	value = (value or "").strip()
	if not value:
		return None
	if BOARD_TOKEN_RE.fullmatch(value.strip("/")):
		return value.strip("/")

	parsed = urlparse(value if "://" in value else f"https://{value.lstrip('/')}")
	host = (parsed.hostname or "").lower()
	if host != "greenhouse.io" and not host.endswith(".greenhouse.io"):
		return None
	parts = [part for part in parsed.path.split("/") if part]
	if parts and parts[0].lower() == "v1":
		# API URL: the token follows /v1/boards/ (the last segment is "jobs")
		token = parts[2] if len(parts) >= 3 and parts[1].lower() == "boards" else ""
	elif parts and parts[0].lower() == "embed":
		token = parse_qs(parsed.query).get("for", [""])[0]
	else:
		token = parts[0] if parts else ""
	return token if BOARD_TOKEN_RE.fullmatch(token) else None


def board_api_url(token):
	return f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true"


def company_board_token(company):
	"""Board token of a companies row (slug wins over api_url); raises ScrapeFailed when neither gives one."""
	values = [(company.get(column) or "").strip() for column in ("slug", "api_url")]
	if not any(values):
		raise ScrapeFailed("Missing Greenhouse board URL")
	for value in values:
		token = board_token(value)
		if token:
			return token
	raise ScrapeFailed("Unable to derive Greenhouse board")


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
	"""Return the board payload; raises ScrapeFailed (e.g. "HTTP 404") after a non-retryable error or exhausted retries."""
	error = "failed"
	for attempt in range(1, attempts + 1):
		try:
			async with session.get(api_url, timeout=aiohttp.ClientTimeout(total=30)) as response:
				if response.status == 200:
					return await response.json()
				print(f"    [WARN] Greenhouse API returned {response.status} for {api_url} (attempt {attempt}/{attempts})")
				error = f"HTTP {response.status}"
				if response.status < 500 and response.status != 429:
					raise ScrapeFailed(error)
		except ScrapeFailed:
			raise
		except Exception as exc:
			print(f"    [WARN] Greenhouse API request failed for {api_url} (attempt {attempt}/{attempts}): {exc}")
			error = short_error(exc) if str(exc).strip() else type(exc).__name__

		if attempt < attempts:
			await asyncio.sleep(2 ** attempt)

	raise ScrapeFailed(error)


async def read_greenhouse_description(page, job):
	"""Only used when the board API returned no content for a job."""
	await goto_settled(page, job["job_url"])
	await page.wait_for_timeout(1000)
	for selector in DESCRIPTION_SELECTORS:
		text = await first_text(page, selector)
		if len(text) > 80:
			return text
	return await first_text(page, "body")


async def collect_greenhouse_jobs(companies, report):
	"""Jobs of every company, with one report outcome per company."""
	collected_jobs = []
	collected_on = format_calendar_date(date.today())

	async with aiohttp.ClientSession() as session:
		for company in companies:
			company_name = company.get("name") or "Unknown"
			try:
				token = company_board_token(company)
			except ScrapeFailed as exc:
				print(f"    [WARN] {exc} for {company_name}")
				report.outcome(company_name, False, error=str(exc))
				continue

			# The API URL is always built from the token
			board_url = f"https://job-boards.greenhouse.io/{token}"
			try:
				payload = await fetch_board_jobs(session, board_api_url(token))
			except ScrapeFailed as exc:
				print(f"[COMPANY] {company_name}: failed")
				report.outcome(company_name, False, error=str(exc))
				continue

			jobs = parse_jobs_from_api(payload, board_url)
			print(f"[COMPANY] {company_name}: jobs found {len(jobs)}")
			report.outcome(company_name, True, jobs_found=len(jobs))
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

	return collected_jobs


async def main():
	# Writes output/greenhouse_report.json on every exit path (sys.exit and crashes included)
	with scrape_report("greenhouse") as report:
		companies = await fetch_companies("greenhouse", "name,ats_type,disabled,slug,api_url")
		print_companies(companies, "Greenhouse")
		report.totals["companies"] = len(companies)
		if not companies:
			print("[ERROR] No Greenhouse companies to scrape.")
			report.message = "No Greenhouse companies to scrape"
			sys.exit(1)

		jobs = await collect_greenhouse_jobs(companies, report)
		filtered_jobs_dataframe, output_file = await write_recent_jobs(jobs, "Greenhouse", "greenhouse", read_greenhouse_description)
		failed_companies = report.failed_names
		missing_descriptions = int((filtered_jobs_dataframe['description'] == '').sum())
		report.totals.update(jobs_scraped=len(jobs), jobs_written=len(filtered_jobs_dataframe),
		                     missing_descriptions=missing_descriptions)

		print(
			f"[SUMMARY] companies={len(companies)} failed={len(failed_companies)} "
			f"jobs_scraped={len(jobs)} jobs_written={len(filtered_jobs_dataframe)} "
			f"missing_descriptions={missing_descriptions}"
		)
		if failed_companies:
			print(f"[SUMMARY] failed companies: {', '.join(failed_companies)}")

		report.finish(output_file, None if output_file else "Failed to write the CSV")
		if not output_file:
			sys.exit(1)
		if len(failed_companies) == len(companies):
			print("[ERROR] All Greenhouse companies failed.")
			report.message = "All Greenhouse companies failed"
			sys.exit(1)


if __name__ == "__main__":
	asyncio.run(main())
