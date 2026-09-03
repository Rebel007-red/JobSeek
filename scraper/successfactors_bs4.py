#!/usr/bin/env python3
"""
SuccessFactors Jobs Scraper (JSON API)

Fetches all SuccessFactors companies from Supabase, queries their API
for matching jobs, and returns structured data.

API Pattern: https://careers.{domain}/api/apply/v2/jobs
Example: https://careers.hcltech.com/api/apply/v2/jobs?domain=careers.hcltech.com&start=0&num=50&locale=en_US
"""

import requests
import json
import sys
import time
import os
from urllib.parse import urlparse

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
    "Accept": "application/json, text/javascript, */*",
}

TIMEOUT = 15
DELAY_BETWEEN_REQUESTS = 0.5


# ─── SUPABASE ──────────────────────────────────────────────────────────
def get_successfactors_companies():
    """Fetch all enabled SuccessFactors companies from Supabase."""
    # Fallback companies
    fallback_companies = [
        {"id": "00000001-0000-0000-0000-000000000007", "name": "HCL Tech", "api_url": "https://careers.hcltech.com/api/apply/v2/jobs"}
    ]
    
    try:
        from supabase import create_client
        
        url = os.getenv('VITE_SUPABASE_URL') or 'https://deczscnmmxpgpayyxglk.supabase.co'
        key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
        
        if not key:
            print("[WARN] SUPABASE_SERVICE_ROLE_KEY not set, using fallback", file=sys.stderr)
            return fallback_companies
        
        supabase = create_client(url, key)
        response = supabase.table('companies').select('id,name,api_url').eq('ats_type', 'successfactors').eq('disabled', False).execute()
        
        companies = response.data or []
        if companies:
            print(f"[FETCH] Found {len(companies)} SuccessFactors companies in DB", file=sys.stderr)
            return companies
        else:
            print("[WARN] No SuccessFactors companies in DB, using fallback", file=sys.stderr)
            return fallback_companies
    except Exception as e:
        print(f"[WARN] Failed to query companies: {e}, using fallback", file=sys.stderr)
        return fallback_companies


# ─── PARSING ───────────────────────────────────────────────────────────
def extract_domain_from_url(api_url):
    """Extract domain from SuccessFactors API URL for query parameter."""
    if not api_url:
        return None
    try:
        parsed = urlparse(api_url)
        # Remove /api/... part
        domain = parsed.netloc + parsed.path.split('/api')[0]
        return domain
    except:
        return None


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


def parse_successfactors_job(job_data, company_name):
    """Parse SuccessFactors API job response."""
    try:
        # SuccessFactors response structure varies, try multiple patterns
        job_id = job_data.get("id") or job_data.get("jobId") or job_data.get("job_id")
        title = job_data.get("title") or job_data.get("jobTitle")
        description = job_data.get("description") or job_data.get("jobDescription") or ""
        
        return {
            "job_id": str(job_id) if job_id else None,
            "title": title or "",
            "company": company_name,
            "location": job_data.get("location") or job_data.get("city") or None,
            "url": job_data.get("url") or job_data.get("jobUrl") or "",
            "posted_at": job_data.get("posted_date") or job_data.get("postedDate"),
            "description": description,
        }
    except Exception as e:
        print(f"[WARN] Error parsing job: {e}", file=sys.stderr)
        return None


# ─── MAIN SCRAPER ──────────────────────────────────────────────────────
def fetch_successfactors_jobs():
    """Main scraper: fetch all SuccessFactors companies and scrape jobs."""
    all_jobs = []
    seen_ids = set()
    
    companies = get_successfactors_companies()
    
    if not companies:
        print("[ERROR] No SuccessFactors companies found", file=sys.stderr)
        return []
    
    for company in companies:
        if len(all_jobs) >= MAX_TOTAL_JOBS:
            break
        
        company_name = company.get("name", "Unknown")
        api_url = company.get("api_url")
        
        if not api_url:
            print(f"[SKIP] {company_name}: No api_url", file=sys.stderr)
            continue
        
        # Build query URL
        domain = extract_domain_from_url(api_url)
        if not domain:
            print(f"[SKIP] {company_name}: Could not extract domain from URL", file=sys.stderr)
            continue
        
        query_url = f"{api_url}?domain={domain}&start=0&num={MAX_JOBS_PER_COMPANY}&locale=en_US"
        print(f"[FETCH] {company_name}: {query_url[:70]}...", file=sys.stderr)
        
        try:
            # Fetch jobs from SuccessFactors API
            resp = requests.get(query_url, headers=HEADERS, timeout=TIMEOUT)
            resp.raise_for_status()
            
            data = resp.json()
            
            # Handle different response structures
            jobs_data = data.get("jobs", []) or data.get("jobPostings", []) or (data if isinstance(data, list) else [])
            
            if not jobs_data:
                print(f"[WARN] {company_name}: No jobs found", file=sys.stderr)
                continue
            
            print(f"[PARSE] {company_name}: Found {len(jobs_data)} jobs", file=sys.stderr)
            
            # Parse and filter jobs
            matched_count = 0
            for job_data in jobs_data:
                if len(all_jobs) >= MAX_TOTAL_JOBS:
                    break
                
                job = parse_successfactors_job(job_data, company_name)
                if not job or not job.get("job_id") or job["job_id"] in seen_ids:
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
        jobs = fetch_successfactors_jobs()
        
        # Output JSON to stdout
        print(json.dumps(jobs, default=str))
        
        # Stats to stderr
        print(f"\n[OK] Total jobs: {len(jobs)}", file=sys.stderr)
        for job in jobs[:3]:
            print(f"  - {job['title'][:40]:40s} at {job['company']}", file=sys.stderr)
        
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
