"""Helpers shared by the Databricks scrapers (workday.py, greenhouse.py, linkedin.py).

The scrapers read their company list from Supabase and write one CSV per run to databricks/output,
which upload_to_volume.py then copies to the Databricks landing volume.
"""
import os
import re
from datetime import datetime
from pathlib import Path

import aiohttp
from dotenv import load_dotenv

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
]


def build_headers(extra_headers=None):
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("VITE_SUPABASE_ANON_KEY")
    if api_key:
        headers["apikey"] = api_key
    if extra_headers:
        headers.update(extra_headers)
    return headers


HEADERS = build_headers()


def sanitize_text(value):
    if value is None:
        return ""

    text = str(value).replace("\r", " ").replace("\n", " ")
    return re.sub(r"\s+", " ", text).strip()


def format_calendar_date(value):
    return value.strftime("%d/%m/%Y")


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


def keep_recent_jobs(dataframe):
    if dataframe.empty:
        return dataframe

    filtered = dataframe[dataframe["posted_days"].notna()].copy()
    return filtered[filtered["posted_days"] <= MAX_POSTED_DAYS]


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
