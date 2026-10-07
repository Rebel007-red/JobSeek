import asyncio
import re
import sys
from datetime import date
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

from scraper_common import (
    ScrapeFailed,
    fetch_companies,
    first_text,
    format_calendar_date,
    format_days_ago,
    goto_settled,
    print_companies,
    relative_text_to_days,
    scrape_report,
    short_error,
    write_recent_jobs,
)

NEXT_BUTTON_SELECTORS = [
    'button[aria-label*="Next"]',
    'button[aria-label*="next"]',
    'a[aria-label*="Next"]',
    'a[aria-label*="next"]',
    'button[data-automation-id="paginationNext"]',
    'a[data-automation-id="paginationNext"]',
]


def extract_workday_job_id(job_url):
    value = (job_url or "").strip()
    if not value:
        return ""

    match = re.search(r'_([^/_?]+)$', value)
    if match:
        return match.group(1)

    return value.rstrip('/').split('/')[-1]


def automation_field_text(item, automation_id):
    """Text of the <dd> inside the item's div[data-automation-id=...], or "Not specified"."""
    field = item.find("div", attrs={"data-automation-id": automation_id})
    value = field.find("dd") if field else None
    return value.get_text(" ", strip=True) if value else "Not specified"


def parse_workday_page_jobs(html, workday_url):
    soup = BeautifulSoup(html, "html.parser")
    jobs = []

    job_list = soup.find("ul", attrs={"role": "list"})
    if job_list:
        item_nodes = job_list.find_all("li", recursive=False)
    else:
        item_nodes = soup.select("li")

    for item in item_nodes:
        try:
            title_link = item.find("a", attrs={"data-automation-id": "jobTitle"})
            if not title_link:
                continue

            title = title_link.get_text(" ", strip=True)
            raw_url = title_link.get("href", "")
            job_url = raw_url if raw_url.startswith("http") else urljoin(workday_url, raw_url)

            jobs.append({
                "job_id": extract_workday_job_id(job_url),
                "title": title,
                "location": automation_field_text(item, "locations"),
                "job_url": job_url,
                "posted_date": automation_field_text(item, "postedOn"),
                "description": "",
            })
        except Exception:
            continue

    return jobs


async def read_workday_description(page, job):
    await goto_settled(page, job["job_url"])
    await page.wait_for_timeout(1500)
    return await first_text(page, '[data-automation-id="jobPostingDescription"]')


async def scrape_workday_jobs(workday_url):
    """Return a list of jobs; raises ScrapeFailed with the reason when the company could not be scraped."""
    if not workday_url:
        print("    [WARN] Missing Workday URL")
        raise ScrapeFailed("Missing Workday URL")

    jobs = []
    seen = set()
    stale_retry_used = False

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            await page.goto(workday_url, wait_until="domcontentloaded", timeout=30000)

            for page_index in range(1, 21):
                try:
                    await page.wait_for_selector('ul[role="list"], a[data-automation-id="jobTitle"]', timeout=10000)
                except Exception:
                    pass

                html = await page.content()
                page_jobs = parse_workday_page_jobs(html, workday_url)
                new_jobs_on_page = 0
                for job in page_jobs:
                    key = (job.get("title") or "", job.get("job_url") or "")
                    if not key[0] or not key[1] or key in seen:
                        continue
                    seen.add(key)
                    jobs.append(job)
                    new_jobs_on_page += 1

                # A disabled-but-visible Next button leaves us on the same page; stop instead of re-reading it.
                # Re-read once without clicking first, in case the previous click was just slow to render.
                if new_jobs_on_page == 0:
                    if stale_retry_used:
                        break
                    stale_retry_used = True
                    await page.wait_for_timeout(3000)
                    continue
                stale_retry_used = False

                next_button = None
                for selector in NEXT_BUTTON_SELECTORS:
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
        raise ScrapeFailed(short_error(exc)) from exc

    return jobs


def format_posted_date(posted_date):
    """Workday shows relative dates ("Posted 3 Days Ago"); turn them into calendar dates, else keep the text."""
    days_ago = relative_text_to_days(posted_date)
    if days_ago is None:
        return posted_date or ""
    return format_days_ago(days_ago)


async def collect_workday_jobs(companies, report):
    """Jobs of every company, with one report outcome per company."""
    collected_jobs = []
    collected_on = format_calendar_date(date.today())

    for company in companies:
        company_name = company.get("name") or "Unknown"
        api_url = company.get("api_url")
        try:
            jobs = await scrape_workday_jobs(api_url)
        except ScrapeFailed as exc:
            report.outcome(company_name, False, error=str(exc))
            print(f"[COMPANY] {company_name}: failed")
            continue
        print(f"[COMPANY] {company_name}: jobs found {len(jobs)}")
        report.outcome(company_name, True, jobs_found=len(jobs))

        for job in jobs:
            posted_date = job.get("posted_date", "")
            collected_jobs.append({
                "company_name": company_name,
                "ats_type": "workday",
                "company_url": api_url,
                "job_id": job.get("job_id", ""),
                "title": job.get("title", ""),
                "location": job.get("location", ""),
                "posted_date": format_posted_date(posted_date),
                "job_url": job.get("job_url", ""),
                "description": job.get("description", ""),
                "collected_on": collected_on,
                "posted_days": relative_text_to_days(posted_date),
            })

    return collected_jobs


async def main():
    # Writes output/workday_report.json on every exit path (sys.exit and crashes included)
    with scrape_report("workday") as report:
        companies = await fetch_companies("workday", "name,api_url,ats_type,disabled")
        print_companies(companies, "Workday")
        report.totals["companies"] = len(companies)
        if not companies:
            print("[ERROR] No Workday companies to scrape.")
            report.message = "No Workday companies to scrape"
            sys.exit(1)

        jobs = await collect_workday_jobs(companies, report)
        filtered_jobs_dataframe, output_file = await write_recent_jobs(jobs, "Workday", "workday", read_workday_description)
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
            print("[ERROR] All Workday companies failed.")
            report.message = "All Workday companies failed"
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
