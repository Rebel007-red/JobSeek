import asyncio
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import aiohttp
import pandas as pd
from bs4 import BeautifulSoup
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


def format_date_from_days_ago(days_ago):
	if days_ago is None:
		return ""
	return format_calendar_date(date.today() - timedelta(days=days_ago))


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
		parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).date()
		return parsed.strftime("%d/%m/%Y")
	except ValueError:
		return value


def parse_linkedin_jobs(html_content):
	soup = BeautifulSoup(html_content, "html.parser")
	jobs = []
	job_cards = soup.find_all("div", class_="base-card")

	for idx, card in enumerate(job_cards):
		try:
			job_link = card.find("a", class_="base-card__full-link")
			if not job_link or not job_link.get("href"):
				continue

			job_url = job_link["href"]
			match = re.search(r"/view/([^?]+)", job_url)
			job_id = match.group(1) if match else f"linkedin_{idx}"

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
				"company": company,
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


async def fetch_descriptions_for_jobs(jobs):
	if not jobs:
		return jobs

	metadata_selectors = [
		".description__job-criteria-list",
		".description__job-criteria-text",
		".description__job-criteria-subheader",
	]

	selectors = [
		".show-more-less-html__markup",
		".description__text",
		"[data-job-id] .show-more-less-html__markup",
		"section.show-more-less-html",
	]
	company_selectors = [
		".artdeco-entity-lockup__subtitle.ember-view",
		".job-details-jobs-unified-top-card__company-name",
	]

	try:
		async with async_playwright() as p:
			browser = await p.chromium.launch(headless=True)
			total_jobs = len(jobs)
			semaphore = asyncio.Semaphore(3)
			progress_lock = asyncio.Lock()
			progress = {"count": 0}

			async def fetch_single_description(job):
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

						await page.goto(detail_url, wait_until="domcontentloaded", timeout=20000)
						await page.wait_for_timeout(1000)
						for company_selector in company_selectors:
							company_locator = page.locator(company_selector).first
							if await company_locator.count() == 0:
								continue
							company_text = await company_locator.text_content()
							company_cleaned = company_text.strip() if company_text else ""
							if company_cleaned:
								job["company_name"] = f"LinkedIn | {company_cleaned}"
								break

						description = ""
						about_locator = page.locator(".show-more-less-html__markup").first
						if await about_locator.count() > 0:
							about_text = await about_locator.text_content()
							metadata_parts = []
							for selector in metadata_selectors:
								locators = page.locator(selector)
								count = await locators.count()
								for idx in range(count):
									text = await locators.nth(idx).text_content()
									cleaned = text.strip() if text else ""
									if cleaned:
										metadata_parts.append(cleaned)

							about_cleaned = about_text.strip() if about_text else ""
							combined_parts = []
							if about_cleaned:
								combined_parts.append(about_cleaned)
							if metadata_parts:
								combined_parts.append(" ".join(metadata_parts))
							description = " ".join(part for part in combined_parts if part)

						for selector in selectors:
							if description:
								break
							locator = page.locator(selector).first
							if await locator.count() == 0:
								continue
							text = await locator.text_content()
							cleaned = text.strip() if text else ""
							if cleaned:
								description = cleaned
								break
						job["description"] = description
					except Exception:
						job["description"] = ""
					finally:
						await page.close()

			await asyncio.gather(*(fetch_single_description(job) for job in jobs))
			await browser.close()
	except Exception as exc:
		print(f"    [WARN] Failed to fetch filtered LinkedIn job descriptions: {exc}")
		for job in jobs:
			job.setdefault("description", "")

	return jobs


async def scrape_linkedin_jobs(company):
	keywords = company.get("api_url", "")
	search_url = build_search_url(keywords)
	if not search_url:
		print(f"    [ERROR] No keywords provided in api_url field for {company.get('name')}")
		return []

	target_jobs = int(company.get("linkedin_target_jobs", 250) or 250)
	max_pages = int(company.get("linkedin_max_pages", 20) or 20)
	pagination_delay_seconds = int(company.get("linkedin_pagination_delay_seconds", 5) or 5)

	try:
		async with async_playwright() as p:
			browser = await p.chromium.launch(headless=True)
			page = await browser.new_page()
			await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
			await page.wait_for_selector('div[class*="base-card"]', timeout=10000)

			loaded_count = await load_more_results(page, target_jobs, max_pages, pagination_delay_seconds)
			html = await page.content()
			await browser.close()
	except Exception as exc:
		print(f"    [WARN] Failed to fetch LinkedIn jobs: {exc}")
		return []

	jobs = dedupe_jobs(parse_linkedin_jobs(html))
	print(f"[SCRAPE] LinkedIn loaded {loaded_count} cards and parsed {len(jobs)} jobs")
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
		"select=name,api_url,ats_type,disabled"
		"&ats_type=eq.linkedin"
		"&disabled=eq.false"
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

	print(f"[INFO] LinkedIn companies: {len(companies)}")


def jobs_to_dataframe(jobs):
	rows = []
	for job in jobs:
		rows.append({
			"company_name": job.get("company_name", ""),
			"ats_type": job.get("ats_type", ""),
			"company_url": job.get("company_url", ""),
			"job_id": job.get("job_id", ""),
			"title": job.get("title", ""),
			"location": job.get("location", ""),
			"posted_date": job.get("posted_date", ""),
			"job_url": job.get("job_url", ""),
			"description": sanitize_text(job.get("description", "")),
			"collected_on": job.get("collected_on", ""),
			"posted_days": job.get("posted_days"),
		})

	dataframe = pd.DataFrame(rows)
	if dataframe.empty:
		return pd.DataFrame(columns=OUTPUT_COLUMNS)

	return dataframe.reindex(columns=OUTPUT_COLUMNS)


def keep_recent_jobs(dataframe):
	if dataframe.empty:
		return dataframe

	filtered = dataframe[dataframe["posted_days"].notna()].copy()
	return filtered[filtered["posted_days"] <= 1]


def write_flat_jobs_csv(dataframe, output_dir):
	try:
		os.makedirs(output_dir, exist_ok=True)
		timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
		output_file = os.path.join(output_dir, f"linkedin_{timestamp}.csv")
		dataframe.to_csv(output_file, index=False)
		print(f"[WRITE] LinkedIn CSV saved to {output_file}")
		return output_file
	except Exception as exc:
		print(f"[ERROR] Failed to write LinkedIn CSV: {exc}")
		return None


async def collect_linkedin_jobs():
	companies = await fetch_companies()
	collected_jobs = []
	collected_on = format_calendar_date(date.today())

	for company in companies:
		company_name = company.get("name") or "Unknown"
		jobs = await scrape_linkedin_jobs(company)
		print(f"[COMPANY] {company_name}: jobs found {len(jobs)}")

		for job in jobs:
			posted_days = posted_time_to_days(job.get("posted_time", ""))
			posted_datetime = (job.get("posted_datetime") or "").strip()
			posted_date = format_posted_date(posted_datetime) if posted_datetime else format_date_from_days_ago(posted_days)

			collected_jobs.append({
				"company_name": job.get("company_name") or f"LinkedIn | {job.get('company', '')}".strip() or company_name,
				"ats_type": "linkedin",
				"company_url": build_search_url(company.get("api_url", "")) or "",
				"job_id": job.get("job_id", ""),
				"title": job.get("title", ""),
				"location": job.get("location", ""),
				"posted_date": posted_date,
				"job_url": job.get("job_url", ""),
				"description": job.get("description", ""),
				"collected_on": collected_on,
				"posted_days": posted_days,
			})

	return collected_jobs


async def main():
	companies = await fetch_companies()
	print_companies(companies)

	jobs = await collect_linkedin_jobs()
	jobs_dataframe = jobs_to_dataframe(jobs)
	filtered_jobs_dataframe = keep_recent_jobs(jobs_dataframe)
	print(f"[FILTER] LinkedIn jobs after filtering: {len(filtered_jobs_dataframe)}")
	filtered_jobs = filtered_jobs_dataframe.to_dict(orient="records")
	filtered_jobs = await fetch_descriptions_for_jobs(filtered_jobs)
	filtered_jobs_dataframe = jobs_to_dataframe(filtered_jobs)
	write_flat_jobs_csv(filtered_jobs_dataframe, Path(__file__).resolve().parent / "output")


if __name__ == "__main__":
	asyncio.run(main())
