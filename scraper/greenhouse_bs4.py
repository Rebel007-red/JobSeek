#!/usr/bin/env python3
"""
Greenhouse Jobs Scraper (JSON API)

Fetches all Greenhouse companies from Supabase, queries their public JSON API
for matching jobs, and returns structured data.

API Pattern: https://api.greenhouse.io/v1/boards/{slug}/jobs?format=json
No auth required - public API
"""

import requests
import json
import sys
import time
import os

# Fix encoding for Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ─── CONFIG ────────────────────────────────────────────────────────────
SKILL_KEYWORDS = ["pyspark", "databricks", "spark", "sql", "python", "data"]
MIN_SKILL_KEYWORDS = 1
MAX_JOBS_PER_COMPANY = 100
MAX_TOTAL_JOBS = 200

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}

TIMEOUT = 15
DELAY_BETWEEN_REQUESTS = 0.5


# ─── SUPABASE ──────────────────────────────────────────────────────────
def get_greenhouse_companies():
    """Fetch all enabled Greenhouse companies from Supabase."""
    # Fallback companies (used when DB unavailable)
    fallback_companies = [
        {"id": "230f9132-8381-4646-9d6d-9b2d1ed44f7e", "name": "Databricks", "slug": "databricks"}
    ]
    
    try:
        from supabase import create_client
        
        url = os.getenv('VITE_SUPABASE_URL') or 'https://deczscnmmxpgpayyxglk.supabase.co'
        key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
        
        if not key:
            print("[WARN] SUPABASE_SERVICE_ROLE_KEY not set, using fallback", file=sys.stderr)
            return fallback_companies
        
        supabase = create_client(url, key)
        response = supabase.table('companies').select('id,name,slug').eq('ats_type', 'greenhouse').eq('disabled', False).execute()
        
        companies = response.data or []
        if companies:
            print(f"[FETCH] Found {len(companies)} Greenhouse companies in DB", file=sys.stderr)
            return companies
        else:
            print("[WARN] No Greenhouse companies in DB, using fallback", file=sys.stderr)
            return fallback_companies
    except Exception as e:
        print(f"[WARN] Failed to query companies: {e}, using fallback", file=sys.stderr)
        return fallback_companies


# ─── PARSING ───────────────────────────────────────────────────────────
def matches_skills(job):
    """Check if job matches skill keywords."""
    text = (job.get("title") or "") + " " + (job.get("description") or "")
    text_lower = text.lower()
    
    matched = sum(1 for skill in SKILL_KEYWORDS if skill in text_lower)
    return matched >= MIN_SKILL_KEYWORDS


def extract_skills_array(text):
    """Extract skill keywords from text."""
    if not text:
        return []
    
    skills = []
    keywords = ["pyspark", "databricks", "spark", "sql", "python", "aws", "gcp", "azure", "scala", "java"]
    text_lower = (text or "").lower()
    
    for skill in keywords:
        if skill in text_lower:
            skills.append(skill)
    
    return list(set(skills))


def parse_greenhouse_job(job_data, company_name):
    """Parse Greenhouse API job response."""
    try:
        return {
            "job_id": str(job_data.get("id", "")),
            "title": job_data.get("title", ""),
            "company": company_name,
            "location": job_data.get("location", {}).get("name") if job_data.get("location") else None,
            "url": job_data.get("absolute_url", ""),
            "posted_at": job_data.get("posted_at"),
            "description": job_data.get("content", ""),
        }
    except Exception as e:
        print(f"[WARN] Error parsing job: {e}", file=sys.stderr)
        return None


# ─── MAIN SCRAPER ──────────────────────────────────────────────────────
def fetch_greenhouse_jobs():
    """Main scraper: fetch all Greenhouse companies and scrape jobs."""
    all_jobs = []
    seen_ids = set()
    
    companies = get_greenhouse_companies()
    
    if not companies:
        print("[ERROR] No Greenhouse companies found", file=sys.stderr)
        return []
    
    for company in companies:
        if len(all_jobs) >= MAX_TOTAL_JOBS:
            break
        
        company_name = company.get("name", "Unknown")
        slug = company.get("slug")
        
        if not slug:
            print(f"[SKIP] {company_name}: No slug", file=sys.stderr)
            continue
        
        api_url = f"https://api.greenhouse.io/v1/boards/{slug}/jobs?format=json"
        print(f"[FETCH] {company_name}: {api_url}", file=sys.stderr)
        
        try:
            # Fetch jobs from Greenhouse API
            resp = requests.get(api_url, headers=HEADERS, timeout=TIMEOUT)
            resp.raise_for_status()
            
            data = resp.json()
            jobs_data = data.get("jobs", [])
            
            if not jobs_data:
                print(f"[WARN] {company_name}: No jobs found", file=sys.stderr)
                continue
            
            print(f"[PARSE] {company_name}: Found {len(jobs_data)} jobs", file=sys.stderr)
            
            # Parse and filter jobs
            matched_count = 0
            for job_data in jobs_data:
                if len(all_jobs) >= MAX_TOTAL_JOBS:
                    break
                
                job = parse_greenhouse_job(job_data, company_name)
                if not job or job["job_id"] in seen_ids:
                    continue
                
                # Check skill match
                if matches_skills(job):
                    job["skills"] = extract_skills_array(job["description"])
                    all_jobs.append(job)
                    seen_ids.add(job["job_id"])
                    matched_count += 1
            
            print(f"[MATCH] {company_name}: {matched_count}/{len(jobs_data)} matched skills", file=sys.stderr)
            
        except Exception as e:
            print(f"[ERROR] {company_name}: {e}", file=sys.stderr)
            continue
        
        time.sleep(DELAY_BETWEEN_REQUESTS)
    
    return all_jobs


if __name__ == "__main__":
    try:
        jobs = fetch_greenhouse_jobs()
        
        # Output JSON to stdout
        print(json.dumps(jobs, default=str))
        
        # Stats to stderr
        print(f"\n[OK] Total jobs: {len(jobs)}", file=sys.stderr)
        for job in jobs[:3]:
            print(f"  - {job['title'][:40]:40s} at {job['company']}", file=sys.stderr)
        
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
