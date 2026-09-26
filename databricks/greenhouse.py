import asyncio
import html
import os
import re
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
from bs4 import BeautifulSoup
import pandas as pd
from dotenv import load_dotenv
from playwright.async_api import async_playwright

load_dotenv(Path(__file__).resolve().parent / ".env")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").rstrip("/")
BASE_URL = f"{SUPABASE_URL}/rest/v1" if SUPABASE_URL else ""


def build_headers(extra_headers=None):
	headers = {"Content-Type": "application/json"}
	api_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("VITE_SUPABASE_ANON_KEY")
	if api_key:
		headers["apikey"] = api_key
	if extra_headers:
		headers.update(extra_headers)
	return headers


HEADERS = build_headers()

OUTPUT_COLUMNS = [
	"company_name",
	"ats_type",
	"company_url",
	"job_id",
	"title",
	"location",
	"posted_date",
	"job_url",
	"description",
	"collected_on",
	"posted_days",
]


def sanitize_text(value):
	if value is None:
		return ""

	text = str(value).replace("\r", " ").replace("\n", " ")
	return re.sub(r"\s+", " ", text).strip()


def format_calendar_date(value):
	return value.strftime("%d/%m/%Y")


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


def posted_iso_to_days(posted_date):
	value = (posted_date or "").strip()
	if not value:
		return None

	try:
		parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).date()
		return (date.today() - parsed).days
	except ValueError:
		lowered = value.lower()
		if "today" in lowered:
			return 0
		if "yesterday" in lowered:
			return 1

		match = re.search(r"(\d+)\s+day", lowered)
		if match:
			return int(match.group(1))

	return None


def format_posted_date(posted_date):
	value = (posted_date or "").strip()
	if not value:
		return ""

	try:
		parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).date()
		return parsed.strftime("%d/%m/%Y")
	except ValueError:
		return value


def parse_jobs_from_api(payload, board_url):
	jobs = payload.get("jobs", []) if isinstance(payload, dict) else []
	parsed_jobs = []

	for item in jobs:
		if not isinstance(item, dict):
			continue

		title = (item.get("title") or "").strip()
		if not title:
			continue

		location = item.get("location") or {}
		location_name = location.get("name") if isinstance(location, dict) else location
		job_url = item.get("absolute_url") or item.get("url") or item.get("job_url") or board_url
		job_id = str(item.get("id") or extract_greenhouse_job_id(job_url, len(parsed_jobs)))
		posted_date = item.get("first_published") or item.get("updated_at") or ""

		parsed_jobs.append({
			"job_id": job_id,
			"title": title,
			"location": location_name or "Not specified",
			"job_url": job_url,
			"posted_date": posted_date,
			"description": greenhouse_content_to_text(item.get("content", "")),
		})

	return parsed_jobs


def keep_recent_jobs(dataframe):
	if dataframe.empty:
		return dataframe

	filtered = dataframe[dataframe["posted_days"].notna()].copy()
	return filtered[filtered["posted_days"] == 0]


async def fetch_descriptions_for_jobs(jobs):
	if not jobs:
		return jobs

	selectors = [
		".job-description",
		".app-job-description",
		".content",
		'[data-testid="job-description"]',
		".description",
		".job-posting",
		"article",
		"main",
	]

	try:
		async with async_playwright() as p:
			browser = await p.chromium.launch(headless=True)
			total_jobs = len(jobs)
			semaphore = asyncio.Semaphore(3)
			progress_lock = asyncio.Lock()
			progress = {"count": 0}

			async def fetch_single_description(job):
				if job.get("description"):
					return

				detail_url = job.get("job_url")
				if not detail_url:
					job["description"] = ""
					return

				async with semaphore:
					page = await browser.new_page()
					try:
						async with progress_lock:
							progress["count"] += 1
							print(f"    [DESC] {progress['count']}/{total_jobs}")

						try:
							await page.goto(detail_url, wait_until="networkidle", timeout=30000)
						except Exception:
							await page.goto(detail_url, wait_until="domcontentloaded", timeout=20000)

						await page.wait_for_timeout(1000)
						description = ""
						for selector in selectors:
							locator = page.locator(selector).first
							if await locator.count() > 0:
								text = await locator.text_content()
								if text and len(text.strip()) > 80:
									description = text.strip()
									break

						if not description:
							body = await page.locator("body").text_content()
							description = body.strip() if body else ""

						job["description"] = description
					except Exception:
						job["description"] = ""
					finally:
						await page.close()

			await asyncio.gather(*(fetch_single_description(job) for job in jobs))
			await browser.close()
	except Exception as exc:
		print(f"    [WARN] Failed to fetch filtered Greenhouse job descriptions: {exc}")
		for job in jobs:
			job.setdefault("description", "")

	return jobs


async def fetch_companies():
	if not BASE_URL:
		print("    [WARN] SUPABASE_URL not configured. Skipping company fetch.")
		return []

	if not HEADERS.get("apikey"):
		print("    [WARN] No Supabase API key configured. Skipping company fetch.")
		return []

	url = (
		f"{BASE_URL}/companies?"
		"select=name,ats_type,disabled,slug"
		"&ats_type=eq.greenhouse"
		"&disabled=eq.false"
		# "&limit=2"
	)
	async with aiohttp.ClientSession() as session:
		async with session.get(url, headers=HEADERS) as response:
			if response.status not in (200, 201):
				text = await response.text()
				print(f"    [ERROR] {text[:500]}")
				return []
			return await response.json()


def print_companies(companies):
	if not companies:
		print("[INFO] No companies returned.")
		return

	print(f"[INFO] Greenhouse companies: {len(companies)}")


def jobs_to_dataframe(jobs):
	rows = []
	for job in jobs:
		raw_posted_date = job.get("posted_date", "")
		rows.append({
			"company_name": job.get("company_name", ""),
			"ats_type": job.get("ats_type", ""),
			"company_url": job.get("company_url", ""),
			"job_id": job.get("job_id", ""),
			"title": job.get("title", ""),
			"location": job.get("location", ""),
			"posted_date": format_posted_date(raw_posted_date),
			"posted_days": posted_iso_to_days(raw_posted_date),
			"job_url": job.get("job_url", ""),
			"description": sanitize_text(job.get("description", "")),
			"collected_on": job.get("collected_on", ""),
		})

	dataframe = pd.DataFrame(rows)
	if dataframe.empty:
		return pd.DataFrame(columns=OUTPUT_COLUMNS)

	return dataframe.reindex(columns=OUTPUT_COLUMNS)


def write_flat_jobs_csv(dataframe, output_dir):
	try:
		os.makedirs(output_dir, exist_ok=True)
		timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
		output_file = os.path.join(output_dir, f"greenhouse_{timestamp}.csv")
		dataframe.to_csv(output_file, index=False)
		print(f"[WRITE] Greenhouse CSV saved to {output_file}")
		return output_file
	except Exception as exc:
		print(f"[ERROR] Failed to write Greenhouse CSV: {exc}")
		return None


async def collect_greenhouse_jobs():
	companies = await fetch_companies()
	collected_jobs = []
	collected_on = format_calendar_date(date.today())

	async with aiohttp.ClientSession() as session:
		for company in companies:
			company_name = company.get("name") or "Unknown"
			board_url = company.get("slug") or company.get("greenhouse_slug") or company.get("api_url") or company.get("board_url") or ""
			board_url = normalize_board_url(board_url)
			if not board_url:
				print(f"    [WARN] Missing Greenhouse board URL for {company_name}")
				continue

			try:
				api_url = board_api_url(board_url)
				async with session.get(api_url, timeout=30) as response:
					if response.status != 200:
						print(f"    [WARN] Greenhouse API returned {response.status} for {api_url}")
						continue
					payload = await response.json()
			except Exception as exc:
				print(f"    [WARN] Failed to fetch Greenhouse jobs for {company_name}: {exc}")
				continue

			jobs = parse_jobs_from_api(payload, board_url)
			print(f"[COMPANY] {company_name}: jobs found {len(jobs)}")
			for job in jobs:
				collected_jobs.append({
					"company_name": company_name,
					"ats_type": "greenhouse",
					"company_url": board_url,
					"job_id": job.get("job_id", ""),
					"title": job.get("title", ""),
					"location": job.get("location", ""),
					"posted_date": job.get("posted_date", ""),
					"job_url": job.get("job_url", ""),
					"description": job.get("description", ""),
					"collected_on": collected_on,
				})

	return collected_jobs


async def main():
	companies = await fetch_companies()
	print_companies(companies)

	jobs = await collect_greenhouse_jobs()
	jobs_dataframe = jobs_to_dataframe(jobs)
	filtered_jobs_dataframe = keep_recent_jobs(jobs_dataframe)
	print(f"[FILTER] Greenhouse jobs after filtering: {len(filtered_jobs_dataframe)}")
	filtered_jobs = filtered_jobs_dataframe.to_dict(orient="records")
	filtered_jobs = await fetch_descriptions_for_jobs(filtered_jobs)
	filtered_jobs_dataframe = jobs_to_dataframe(filtered_jobs)
	write_flat_jobs_csv(filtered_jobs_dataframe, Path(__file__).resolve().parent / "output")


if __name__ == "__main__":
	asyncio.run(main())
