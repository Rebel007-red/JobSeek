import asyncio
import os
import re
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urljoin

import aiohttp
from bs4 import BeautifulSoup
from dotenv import load_dotenv
import pandas as pd
from playwright.async_api import async_playwright

load_dotenv(Path(__file__).resolve().parent / ".env")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").rstrip("/")
BASE_URL = f"{SUPABASE_URL}/rest/v1" if SUPABASE_URL else ""

# Databricks Unity Catalog volume path for raw scraped data
DATABRICKS_VOLUME_PATH = os.getenv("DATABRICKS_VOLUME_PATH", "/Volumes/main/default/jobseeker_raw")


def build_headers(extra_headers=None):
    headers = {'Content-Type': 'application/json'}
    api_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("VITE_SUPABASE_ANON_KEY")
    if api_key:
        headers['apikey'] = api_key
    if extra_headers:
        headers.update(extra_headers)
    return headers


HEADERS = build_headers()


def sanitize_text(value):
    if value is None:
        return ""

    text = str(value).replace("\r", " ").replace("\n", " ")
    return re.sub(r"\s+", " ", text).strip()


def extract_workday_job_id(job_url):
    value = (job_url or "").strip()
    if not value:
        return ""

    match = re.search(r'_([^/_?]+)$', value)
    if match:
        return match.group(1)

    return value.rstrip('/').split('/')[-1]


def parse_workday_page_jobs(html, workday_url):
    soup = BeautifulSoup(html, "html.parser")
    jobs = []

    job_list = soup.find("ul", attrs={"role": "list"})
    if job_list:
        item_nodes = job_list.find_all("li", recursive=False)
    else:
        item_nodes = soup.select("li")

    if not item_nodes:
        return jobs

    for item in item_nodes:
        try:
            title_link = item.find("a", attrs={"data-automation-id": "jobTitle"})
            if not title_link:
                continue

            title = title_link.get_text(" ", strip=True)
            raw_url = title_link.get("href", "")
            job_url = raw_url if raw_url.startswith("http") else urljoin(workday_url, raw_url)

            location = "Not specified"
            loc_div = item.find("div", attrs={"data-automation-id": "locations"})
            if loc_div:
                loc_dd = loc_div.find("dd")
                if loc_dd:
                    location = loc_dd.get_text(" ", strip=True)

            posted_date = "Not specified"
            date_div = item.find("div", attrs={"data-automation-id": "postedOn"})
            if date_div:
                date_dd = date_div.find("dd")
                if date_dd:
                    posted_date = date_dd.get_text(" ", strip=True)

            jobs.append({
                "job_id": extract_workday_job_id(job_url),
                "title": title,
                "location": location,
                "job_url": job_url,
                "posted_date": posted_date,
                "description": "",
            })
        except Exception:
            continue

    return jobs


async def fetch_descriptions_for_jobs(jobs):
    if not jobs:
        return jobs

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()

            for job in jobs:
                detail_url = job.get("job_url")
                if not detail_url:
                    job["description"] = ""
                    continue

                try:
                    try:
                        await page.goto(detail_url, wait_until="networkidle", timeout=30000)
                    except Exception:
                        await page.goto(detail_url, wait_until="domcontentloaded", timeout=20000)

                    await page.wait_for_timeout(1500)
                    locator = page.locator('[data-automation-id="jobPostingDescription"]').first
                    if await locator.count() > 0:
                        description = await locator.text_content()
                        job["description"] = description.strip() if description else ""
                    else:
                        job["description"] = ""
                except Exception:
                    job["description"] = ""

            await browser.close()
    except Exception as exc:
        print(f"    [WARN] Failed to fetch filtered job descriptions: {exc}")
        for job in jobs:
            job.setdefault("description", "")

    return jobs


async def scrape_workday_jobs(workday_url):
    if not workday_url:
        return []

    jobs = []
    seen = set()

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            print(f"    [SCRAPE] {workday_url}")
            await page.goto(workday_url, wait_until="domcontentloaded", timeout=30000)

            for page_index in range(1, 21):
                try:
                    await page.wait_for_selector('ul[role="list"], a[data-automation-id="jobTitle"]', timeout=10000)
                except Exception:
                    pass

                html = await page.content()
                page_jobs = parse_workday_page_jobs(html, workday_url)
                for job in page_jobs:
                    key = (job.get("title") or "", job.get("job_url") or "")
                    if not key[0] or not key[1] or key in seen:
                        continue
                    seen.add(key)
                    jobs.append(job)

                print(f"    [PAGE {page_index}] found {len(page_jobs)} jobs, total collected {len(jobs)}")

                next_selectors = [
                    'button[aria-label*="Next"]',
                    'button[aria-label*="next"]',
                    'a[aria-label*="Next"]',
                    'a[aria-label*="next"]',
                    'button[data-automation-id="paginationNext"]',
                    'a[data-automation-id="paginationNext"]',
                ]
                next_button = None
                for selector in next_selectors:
                    locator = page.locator(selector).first
                    if await locator.count() > 0:
                        next_button = locator
                        break

                if not next_button:
                    break

                try:
                    if not await next_button.is_visible():
                        break
                    await next_button.click(force=True)
                    await page.wait_for_timeout(2000)
                except Exception:
                    break

            await browser.close()
    except Exception as exc:
        print(f"    [WARN] Failed to fetch Workday URL with Playwright: {exc}")
        return []

    return jobs


async def fetch_companies():
    if not BASE_URL:
        print("    [WARN] SUPABASE_URL not configured. Skipping company fetch.")
        return []

    if not HEADERS.get('apikey'):
        print("    [WARN] No Supabase API key configured. Skipping company fetch.")
        return []

    url = (
        f"{BASE_URL}/companies?"
        "select=name,api_url,ats_type,disabled"
        "&ats_type=eq.workday"
        "&disabled=eq.false"
        # "&limit=1"
    )
    print(f"[API] Fetching: {url}")

    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=HEADERS) as response:
            print(f"    Status: {response.status}")
            if response.status not in (200, 201):
                text = await response.text()
                print(f"    [ERROR] {text[:500]}")
                return []
            data = await response.json()
            return data


def print_companies(companies):
    if not companies:
        print("[INFO] No companies returned.")
        return

    print(f"\n[INFO] Found {len(companies)} companies\n")
    for company in companies:
        print(
            f"- {company.get('name')} | "
            f"ats={company.get('ats_type')} | "
            f"slug={company.get('slug')} | "
            f"api_url={company.get('api_url')} | "
            f"disabled={company.get('disabled')}"
        )
    print()


def write_to_databricks_volume(payload, volume_path=DATABRICKS_VOLUME_PATH):
    """Write raw payload to a Databricks schema volume path."""
    try:
        os.makedirs(volume_path, exist_ok=True)
        output_file = os.path.join(volume_path, "workday_jobs_raw.json")
        with open(output_file, "w", encoding="utf-8") as f:
            import json
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"[WRITE] Raw payload saved to {output_file}")
        return output_file
    except Exception as exc:
        print(f"[ERROR] Failed to write to volume path: {exc}")
        return None


def posted_date_to_days(posted_date):
    value = (posted_date or "").strip().lower()
    if not value or value == "not specified":
        return None
    if "today" in value:
        return 0
    if "yesterday" in value:
        return 1

    match = re.search(r"(\d+)\s+day", value)
    if match:
        return int(match.group(1))

    return None


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
        })

    dataframe = pd.DataFrame(rows)
    if dataframe.empty:
        return pd.DataFrame(
            columns=[
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
        )

    dataframe["posted_days"] = dataframe["posted_date"].apply(posted_date_to_days)
    return dataframe


def keep_recent_jobs(dataframe):
    if dataframe.empty:
        return dataframe

    filtered = dataframe[dataframe["posted_days"].notna()].copy()
    return filtered[filtered["posted_days"] <= 1]


def write_flat_jobs_csv(dataframe, output_dir):
    """Write one row per job for simpler downstream ingestion."""
    try:
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = os.path.join(output_dir, f"workday_{timestamp}.csv")

        dataframe.to_csv(output_file, index=False)
        print(f"[WRITE] Flat jobs CSV saved to {output_file}")
        return output_file
    except Exception as exc:
        print(f"[ERROR] Failed to write flat jobs CSV: {exc}")
        return None


async def collect_workday_jobs():
    companies = await fetch_companies()
    collected_jobs = []
    collected_on = date.today().isoformat()

    for company in companies:
        company_name = company.get("name") or "Unknown"
        api_url = company.get("api_url")
        jobs = await scrape_workday_jobs(api_url)

        for job in jobs:
            collected_jobs.append({
                "company_name": company_name,
                "ats_type": "workday",
                "company_url": api_url,
                "job_id": job.get("job_id", ""),
                "title": job.get("title", ""),
                "location": job.get("location", ""),
                "posted_date": job.get("posted_date", ""),
                "job_url": job.get("job_url", ""),
                "description": job.get("description", ""),
                "collected_on": collected_on,
            })

        print(f"[COLLECTED] {company_name}: {len(jobs)} jobs")

    return collected_jobs


async def main():
    companies = await fetch_companies()
    print_companies(companies)

    jobs = await collect_workday_jobs()
    jobs_dataframe = jobs_to_dataframe(jobs)
    filtered_jobs_dataframe = keep_recent_jobs(jobs_dataframe)
    filtered_jobs = filtered_jobs_dataframe.to_dict(orient="records")
    filtered_jobs = await fetch_descriptions_for_jobs(filtered_jobs)
    filtered_jobs_dataframe = jobs_to_dataframe(filtered_jobs)
    print(
        "[FILTER] Posted date mapped to posted_days and filtered to <= 1: "
        f"{len(jobs_dataframe)} -> {len(filtered_jobs_dataframe)} rows"
    )
    write_flat_jobs_csv(filtered_jobs_dataframe, Path(__file__).resolve().parent / "output")


if __name__ == "__main__":
    asyncio.run(main())
