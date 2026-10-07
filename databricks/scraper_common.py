"""Helpers shared by the Databricks scrapers (workday.py, greenhouse.py, linkedin.py).

The scrapers read their company list from Supabase and write one CSV per run to databricks/output,
which upload_to_volume.py then copies to the Databricks landing volume. Each run also writes
output/<source>_report.json (scrape_report below), which jobs/record_scrape_report.py sends to Supabase.
"""
import asyncio
import json
import os
import re
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import aiohttp
import pandas as pd
from dotenv import load_dotenv
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
load_dotenv(HERE.parent / ".env")

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").rstrip("/")
BASE_URL = f"{SUPABASE_URL}/rest/v1" if SUPABASE_URL else ""

# Keep jobs posted within this many days (0 = today only). Downstream MERGE dedupes overlaps.
MAX_POSTED_DAYS = int(os.getenv("MAX_POSTED_DAYS", "1"))

OUTPUT_DIR = HERE / "output"

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
    # LinkedIn job criteria; Workday/Greenhouse leave them empty. New columns are only ever appended (older files
    # simply lack them).
    "seniority_level",
    "employment_type",
    "job_function",
    "industries",
]
CRITERIA_COLUMNS = OUTPUT_COLUMNS[-4:]


def build_headers():
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("VITE_SUPABASE_ANON_KEY")
    if api_key:
        headers["apikey"] = api_key
        if api_key.startswith("eyJ"):  # legacy JWT keys also go in Authorization (sb_secret_/sb_publishable_ keys must not)
            headers["Authorization"] = f"Bearer {api_key}"
    return headers


HEADERS = build_headers()


def sanitize_text(value):
    if value is None:
        return ""

    text = str(value).replace("\r", " ").replace("\n", " ")
    return re.sub(r"\s+", " ", text).strip()


def format_calendar_date(value):
    return value.strftime("%d/%m/%Y")


def format_days_ago(days_ago):
    if days_ago is None:
        return ""
    return format_calendar_date(date.today() - timedelta(days=days_ago))


def relative_text_to_days(text):
    """Days ago from text like "Posted Today", "Posted Yesterday" or "Posted 3 Days Ago"; None when unrecognized."""
    value = (text or "").strip().lower()
    if "today" in value:
        return 0
    if "yesterday" in value:
        return 1

    match = re.search(r"(\d+)\s+day", value)
    if match:
        return int(match.group(1))

    return None


async def fetch_companies(ats_type, columns):
    """Enabled companies of one ATS type from the Supabase `companies` table."""
    if not BASE_URL:
        print("    [WARN] SUPABASE_URL not configured. Skipping company fetch.")
        return []

    if not HEADERS.get("apikey"):
        print("    [WARN] No Supabase API key configured. Skipping company fetch.")
        return []

    url = f"{BASE_URL}/companies?select={columns}&ats_type=eq.{ats_type}&disabled=eq.false"
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=HEADERS) as response:
            if response.status not in (200, 201):
                text = await response.text()
                print(f"    [ERROR] {text[:500]}")
                return []
            return await response.json()


def print_companies(companies, label):
    if not companies:
        print("[INFO] No companies returned.")
        return

    print(f"[INFO] {label} companies: {len(companies)}")


# Written by 04_gold_cleanup (before its gold MERGE) to the ops volume:
#   linkedin_roles.json    {"generated_at": ..., "profiles": [{"user_id": ..., "roles": [...], "cities": [...]}]}
#   linkedin_seen_ids.json {"generated_at": ..., "job_ids": [...]}: LinkedIn ids silver already has a description for
CONFIG_DIR = "/Volumes/jobseeker/ops/pipeline/config"
LINKEDIN_ROLES_FILE = os.getenv("LINKEDIN_ROLES_FILE", f"{CONFIG_DIR}/linkedin_roles.json")
LINKEDIN_SEEN_IDS_FILE = os.getenv("LINKEDIN_SEEN_IDS_FILE", f"{CONFIG_DIR}/linkedin_seen_ids.json")


async def _download_config_file(session, path, skipped_note):
    """Parsed JSON of a pipeline config file on the Databricks volume, or None (skipped_note says what is skipped)."""
    host = (os.getenv("DATABRICKS_HOST") or "").strip().strip('"').rstrip("/")
    token = (os.getenv("DATABRICKS_TOKEN") or "").strip().strip('"')
    if not host or not token:
        print(f"    [WARN] DATABRICKS_HOST / DATABRICKS_TOKEN not set. {skipped_note}")
        return None
    url = f"{host}/api/2.0/fs/files{path}"
    try:
        async with session.get(url, headers={"Authorization": f"Bearer {token}"}) as response:
            if response.status == 404:
                print(f"    [INFO] {path} not found yet (written by the pipeline). {skipped_note}")
                return None
            if response.status != 200:
                print(f"    [WARN] Could not read {path}: HTTP {response.status} {(await response.text())[:300]}")
                return None
            return json.loads(await response.text())
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
        print(f"    [WARN] Could not read {path}: {exc}. {skipped_note}")
        return None


async def _existing_user_ids(session):
    """Ids of current Supabase users (needs the service role key); None when they can't be listed."""
    if not SUPABASE_URL or not os.getenv("SUPABASE_SERVICE_ROLE_KEY"):
        print("    [WARN] No Supabase service role key. Using roles of every profile.")
        return None
    ids, page = set(), 1
    while True:
        url = f"{SUPABASE_URL}/auth/v1/admin/users?page={page}&per_page=100"
        async with session.get(url, headers=HEADERS) as response:
            if response.status != 200:
                print(f"    [WARN] Could not list Supabase users: HTTP {response.status}. Using roles of every profile.")
                return None
            users = (await response.json()).get("users", [])
        ids.update(str(user["id"]).lower() for user in users if user.get("id"))
        if len(users) < 100:
            return ids
        page += 1


def user_searches(profiles, user_ids=None):
    """Distinct (role, city) pairs of the profiles' roles x preferred cities; city None = India-wide.

    A user without cities searches India-wide. Pairs are deduped case-insensitively across users (first spelling wins)
    and ordered by the city's position in its user's list, so when MAX_LINKEDIN_SEARCHES cuts the list every role keeps
    its first search before any role gets a second one. Profiles of users not in user_ids (when given) are skipped.
    """
    ranked, seen, skipped_users = [], set(), 0
    for profile in profiles:
        if user_ids is not None and str(profile.get("user_id", "")).lower() not in user_ids:
            skipped_users += 1
            continue
        # 'India' is a city value of ops.ref_india_locations too; it means the India-wide search
        cities = [str(city or "").strip() for city in profile.get("cities") or []]
        cities = [city for city in cities if city.lower() not in ("", "india")] or [None]
        for role in profile.get("roles") or []:
            role = str(role).strip()
            for rank, city in enumerate(cities if role else []):
                key = (role.lower(), (city or "").lower())
                if key not in seen:
                    seen.add(key)
                    ranked.append((rank, role, city))
    ranked.sort(key=lambda item: item[0])  # stable, so profile and role order is kept within a rank
    return [(role, city) for _, role, city in ranked], skipped_users


async def fetch_user_searches():
    """(role, city) LinkedIn keyword searches for the roles and preferred cities of current app users."""
    async with aiohttp.ClientSession() as session:
        data = await _download_config_file(session, LINKEDIN_ROLES_FILE, "No user role searches.")
        if not data:
            return []
        user_ids = await _existing_user_ids(session)

    profiles = data.get("profiles") or []
    searches, skipped_users = user_searches(profiles, user_ids)
    print(f"[INFO] User searches: {len(searches)} distinct role x city pairs "
          f"({len({role.lower() for role, _ in searches})} roles) from {len(profiles)} profiles "
          f"(skipped {skipped_users} of removed users), file generated {data.get('generated_at')}")
    return searches


async def fetch_linkedin_seen_ids():
    """LinkedIn job ids the pipeline already has a description for (empty set when the file is unavailable)."""
    async with aiohttp.ClientSession() as session:
        data = await _download_config_file(session, LINKEDIN_SEEN_IDS_FILE, "Fetching every description.")
    if not data:
        return set()
    job_ids = {str(job_id).strip() for job_id in data.get("job_ids") or []} - {""}
    print(f"[INFO] Seen LinkedIn job ids: {len(job_ids)}, file generated {data.get('generated_at')}")
    return job_ids


def jobs_to_dataframe(jobs):
    """One row per job in OUTPUT_COLUMNS order; posted_date and posted_days must already be normalized."""
    rows = [
        {
            **{column: job.get(column, "") for column in OUTPUT_COLUMNS},
            "description": sanitize_text(job.get("description", "")),
            **{column: sanitize_text(job.get(column, "")) for column in CRITERIA_COLUMNS},
            "posted_days": job.get("posted_days"),
        }
        for job in jobs
    ]
    dataframe = pd.DataFrame(rows, columns=OUTPUT_COLUMNS)
    dataframe["posted_days"] = dataframe["posted_days"].astype("Int64")
    return dataframe


def keep_recent_jobs(dataframe):
    if dataframe.empty:
        return dataframe

    filtered = dataframe[dataframe["posted_days"].notna()].copy()
    return filtered[filtered["posted_days"] <= MAX_POSTED_DAYS]


async def first_text(page, selector):
    """Stripped text of the first element matching selector, or "" when there is none."""
    locator = page.locator(selector).first
    if await locator.count() == 0:
        return ""
    text = await locator.text_content()
    return text.strip() if text else ""


async def goto_settled(page, url):
    """Open url and wait for the network to go idle, falling back to DOM-ready for pages that never settle."""
    try:
        await page.goto(url, wait_until="networkidle", timeout=30000)
    except Exception:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)


async def fetch_descriptions(jobs, label, read_description, skip_ids=frozenset()):
    """Fill in missing descriptions by opening each job_url in headless Chromium, 3 pages at a time.

    read_description(page, job) loads the job page and returns its description; any failure leaves "".
    Jobs whose job_id is in skip_ids keep an empty description: the pipeline already has it, and its silver MERGE never
    overwrites a stored description with an empty one, so the row only refreshes last_seen_at.
    """
    missing = [job for job in jobs if not job.get("description")]
    pending = [job for job in missing if str(job.get("job_id") or "") not in skip_ids]
    if len(pending) < len(missing):
        print(f"[DESC] {label}: {len(missing) - len(pending)} already seen jobs skipped, {len(pending)} to fetch")
    if not pending:
        return jobs

    total_jobs = len(pending)
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            semaphore = asyncio.Semaphore(3)
            fetched = 0

            async def fetch_single_description(job):
                nonlocal fetched
                if not job.get("job_url"):
                    job["description"] = ""
                    return

                async with semaphore:
                    page = await browser.new_page()
                    try:
                        fetched += 1
                        print(f"    [DESC] {fetched}/{total_jobs}")
                        job["description"] = await read_description(page, job)
                    except Exception:
                        job["description"] = ""
                    finally:
                        await page.close()

            await asyncio.gather(*(fetch_single_description(job) for job in pending))
            await browser.close()
    except Exception as exc:
        print(f"    [WARN] Failed to fetch filtered {label} job descriptions: {exc}")
        for job in jobs:
            job.setdefault("description", "")

    return jobs


def write_flat_jobs_csv(dataframe, prefix, output_dir=OUTPUT_DIR):
    """Write one row per job (e.g. output/workday_20260929_101500.csv) for downstream ingestion."""
    try:
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = os.path.join(output_dir, f"{prefix}_{timestamp}.csv")
        dataframe.to_csv(output_file, index=False)
        print(f"[WRITE] {prefix} CSV saved to {output_file}")
        return output_file
    except Exception as exc:
        print(f"[ERROR] Failed to write {prefix} CSV: {exc}")
        return None


async def write_recent_jobs(jobs, label, prefix, read_description, skip_ids=frozenset()):
    """Keep jobs posted within MAX_POSTED_DAYS, fetch their missing descriptions (except skip_ids) and write the CSV.

    Returns the written dataframe and the output file (None when writing failed).
    """
    recent = keep_recent_jobs(jobs_to_dataframe(jobs))
    print(f"[FILTER] {label} jobs after filtering (posted_days <= {MAX_POSTED_DAYS}): {len(recent)}")
    recent_jobs = await fetch_descriptions(recent.to_dict(orient="records"), label, read_description, skip_ids)
    dataframe = jobs_to_dataframe(recent_jobs)
    return dataframe, write_flat_jobs_csv(dataframe, prefix)


# --- Scrape report (format jobseeker.scrape_report.v1, recorded by jobs/record_scrape_report.py) ---

REPORT_FORMAT = "jobseeker.scrape_report.v1"
TOTAL_KEYS = ("companies", "failed", "jobs_scraped", "jobs_written", "missing_descriptions", "already_seen")


class ScrapeFailed(Exception):
    """One company or search could not be scraped; str() is the short reason the report records (e.g. "HTTP 404")."""


def short_error(exc, limit=200):
    """First line of an exception message (Playwright errors carry a long call log), cut to limit characters."""
    text = str(exc).strip().splitlines()
    return (text[0] if text else type(exc).__name__)[:limit]


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def report_path(source, output_dir=OUTPUT_DIR):
    return Path(output_dir) / f"{source}_report.json"


def github_run():
    """The GitHub Actions run fields of a report (None outside Actions)."""
    attempt = os.getenv("GITHUB_RUN_ATTEMPT") or ""
    return {
        "github_run_id": os.getenv("GITHUB_RUN_ID") or None,
        "github_run_attempt": int(attempt) if attempt.isdigit() else None,
        "workflow": os.getenv("GITHUB_WORKFLOW") or None,
    }


def report_status(companies, output_file):
    """ok = nothing failed, partial = some failed, failed = every company failed (or none ran) or no CSV was written."""
    failed = sum(1 for company in companies if not company["ok"])
    if not output_file or not companies or failed == len(companies):
        return "failed"
    return "partial" if failed else "ok"


def build_report(source, *, status, totals, companies, linkedin=None, message=None, started_at, finished_at=None):
    """The report document; totals missing a key get None, and failed defaults to the failed companies."""
    totals = {key: totals.get(key) for key in TOTAL_KEYS}
    if totals["failed"] is None:
        totals["failed"] = sum(1 for company in companies if not company["ok"])
    return {
        "format": REPORT_FORMAT,
        "source": source,
        "run": {**github_run(), "started_at": started_at, "finished_at": finished_at or utc_now_iso(),
                "status": status, "message": message},
        "totals": totals,
        "linkedin": linkedin,
        "companies": companies,
    }


def write_report(source, *, status, totals, companies, linkedin=None, message=None, started_at, output_dir=OUTPUT_DIR):
    """Write output/<source>_report.json; returns its path (None when writing failed, which never fails the scrape)."""
    report = build_report(source, status=status, totals=totals, companies=companies, linkedin=linkedin,
                          message=message, started_at=started_at)
    path = report_path(source, output_dir)
    try:
        os.makedirs(path.parent, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"[REPORT] {path}")
        return path
    except Exception as exc:
        print(f"[WARN] Failed to write the scrape report: {exc}")
        return None


class ScrapeReport:
    """What one scraper run reports: an outcome per company or search, the totals, and how the run ended."""

    def __init__(self, source):
        self.source = source
        self.started_at = utc_now_iso()
        self.companies = []
        self.totals = {}
        self.linkedin = None
        self.status = None
        self.message = None

    def outcome(self, name, ok, jobs_found=None, error=None):
        self.companies.append({
            "name": name,
            "ok": bool(ok),
            "jobs_found": jobs_found if ok else None,
            "error": None if ok else (error or "failed"),
        })

    @property
    def failed_names(self):
        return [company["name"] for company in self.companies if not company["ok"]]

    def finish(self, output_file, message=None):
        """Sets the status from the outcomes and whether the CSV was written."""
        self.status = report_status(self.companies, output_file)
        self.message = message
        return self.status


@contextmanager
def scrape_report(source):
    """with scrape_report("workday") as report: ... writes the report on every exit path.

    An exception (other than the scrapers' own sys.exit) marks the run crashed with its message; a body that ends without
    report.finish() (e.g. sys.exit before the CSV) reports failed with report.message.
    """
    report = ScrapeReport(source)
    try:
        yield report
    except SystemExit:
        raise
    except BaseException as exc:
        report.status = "crashed"
        report.message = f"{type(exc).__name__}: {short_error(exc, 900)}"
        raise
    finally:
        write_report(source, status=report.status or "failed", totals=report.totals, companies=report.companies,
                     linkedin=report.linkedin, message=report.message, started_at=report.started_at)
