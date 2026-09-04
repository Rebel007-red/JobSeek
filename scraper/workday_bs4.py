#!/usr/bin/env python3
"""
Workday Jobs Scraper - Single Company Focus

Fetches jobs from a specific Workday company using API
"""

import requests
import json
import sys
import time
import os
import re
from urllib.parse import urlparse

# Fix encoding for Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ─── CONFIG ────────────────────────────────────────────────────────────
SKILL_KEYWORDS = ["pyspark", "databricks", "spark", "sql", "python", "data", "aws", "gcp", "azure"]
MIN_SKILL_KEYWORDS = 1
MAX_JOBS_PER_COMPANY = 100

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Content-Type": "application/json",
}

TIMEOUT = 15
DELAY_BETWEEN_REQUESTS = 0.5


# ─── API CALL ──────────────────────────────────────────────────────────
def extract_api_endpoint_from_url(career_url):
    """
    Extract API endpoint from Workday career page URL.
    
    Pattern: https://TENANT.wdX.myworkdayjobs.com/...BOARD...
    Returns: https://TENANT.wdX.myworkdayjobs.com/wday/cxs/TENANT/BOARD/jobs
    """
    try:
        # Parse URL
        match = re.search(
            r"https://([^.]+)\.(wd\d+)\.myworkdayjobs\.com/[^/]+/([^?]+)",
            career_url,
        )
        if not match:
            return None

        tenant = match.group(1)
        wd_version = match.group(2)
        board = match.group(3)

        # Handle trailing parameters in board
        board = board.split("?")[0]

        api_endpoint = (
            f"https://{tenant}.{wd_version}.myworkdayjobs.com/wday/cxs/{tenant}/{board}/jobs"
        )
        return api_endpoint
    except Exception as e:
        print(f"[ERROR] Failed to extract API endpoint: {e}", file=sys.stderr)
        return None


def fetch_workday_jobs_api(company_url):
    """Fetch jobs from Workday API endpoint (POST /jobs)."""
    api_endpoint = extract_api_endpoint_from_url(company_url)
    if not api_endpoint:
        print(f"[WARN] Could not extract API endpoint from {company_url}", file=sys.stderr)
        return []

    try:
        print(f"[API] Calling {api_endpoint[:60]}...", file=sys.stderr)

        response = requests.post(
            api_endpoint, headers=HEADERS, json={}, timeout=TIMEOUT
        )

        if response.status_code != 200:
            print(
                f"[WARN] API returned {response.status_code}",
                file=sys.stderr,
            )
            return []

        data = response.json()
        job_postings = data.get("jobPostings", [])
        total_available = data.get("total", 0)

        print(
            f"[API] Total available: {total_available}, returned: {len(job_postings)}",
            file=sys.stderr,
        )

        return job_postings

    except Exception as e:
        print(f"[ERROR] Failed to fetch jobs: {e}", file=sys.stderr)
        return []


# ─── PARSING ───────────────────────────────────────────────────────────
def extract_skills_array(text):
    """Extract skill keywords from text."""
    if not text:
        return []

    skills = []
    keywords = [
        "pyspark",
        "databricks",
        "spark",
        "sql",
        "python",
        "aws",
        "gcp",
        "azure",
        "scala",
        "java",
        "data",
    ]
    text_lower = (text or "").lower()

    for skill in keywords:
        if skill in text_lower:
            skills.append(skill)

    return list(set(skills))


def matches_skills(job_title):
    """Check if job title matches skill keywords."""
    text = (job_title or "").lower()

    matched = sum(1 for skill in SKILL_KEYWORDS if skill in text)
    return matched >= MIN_SKILL_KEYWORDS


def parse_workday_job(job_posting, base_url):
    """
    Convert Workday job posting to standard format.

    Workday job posting structure:
    {
        "title": "Job Title",
        "externalPath": "/job/Location/Job-Title_ID",
        "locationsText": "Location",
        "postedOn": "Posted Today",
        "bulletFields": ["JR123456"]
    }
    """
    try:
        title = job_posting.get("title", "").strip()
        location = job_posting.get("locationsText", "").strip()
        external_path = job_posting.get("externalPath", "").strip()
        job_id = (
            job_posting.get("bulletFields", [""])[0]
            if job_posting.get("bulletFields")
            else ""
        )

        # Build full URL
        if external_path:
            # Extract base domain from URL
            parsed = urlparse(base_url)
            job_url = f"{parsed.scheme}://{parsed.netloc}{external_path}"
        else:
            job_url = ""

        # Skill filtering
        if not matches_skills(title):
            return None

        return {
            "job_id": job_id or title.lower().replace(" ", "_"),
            "title": title,
            "location": location,
            "url": job_url,
            "description": title,  # Workday API doesn't provide full description
            "posted_at": None,
            "skills": extract_skills_array(title),
        }
    except Exception as e:
        print(f"[WARN] Failed to parse job: {e}", file=sys.stderr)
        return None


# ─── MAIN ──────────────────────────────────────────────────────────────
def main():
    """Main scraper function. Reads company JSON from stdin."""
    try:
        # Read company JSON from stdin
        company_json = sys.stdin.read().strip()
        if not company_json:
            print("[]", flush=True)
            return

        company = json.loads(company_json)
    except (json.JSONDecodeError, EOFError):
        print("[]", flush=True)
        return

    name = company.get("name", "Unknown")
    api_url = company.get("api_url", "")

    if not api_url:
        print("[]", flush=True)
        return

    print(f"[SCRAPE] Workday: {name}", file=sys.stderr)

    try:
        job_postings = fetch_workday_jobs_api(api_url)
        job_postings = job_postings[:MAX_JOBS_PER_COMPANY]

        jobs = []
        for posting in job_postings:
            job = parse_workday_job(posting, api_url)
            if job:
                jobs.append(job)

        print(
            f"[RESULT] {name}: {len(job_postings)} found, {len(jobs)} matched skills",
            file=sys.stderr,
        )

        # Output as JSON for Node.js wrapper
        print(json.dumps(jobs, ensure_ascii=False), flush=True)

        if jobs:
            print(f"[SUCCESS] {name}: {len(jobs)} jobs", file=sys.stderr)
        else:
            print(f"[NOTICE] {name}: No jobs found", file=sys.stderr)

    except Exception as e:
        print(f"[ERROR] Failed to scrape {name}: {e}", file=sys.stderr)
        print("[]", flush=True)


if __name__ == "__main__":
    main()
