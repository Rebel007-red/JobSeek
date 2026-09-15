import asyncio
import aiohttp
from dotenv import load_dotenv
import os
import json
from workday.main import Scraper as WorkdayScraper
from linkedin.main import Scraper as LinkedInScraper

# Load environment variables from .env
load_dotenv()

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").rstrip("/")
BASE_URL = f"{SUPABASE_URL}/rest/v1" if SUPABASE_URL else ""


def build_headers(extra_headers=None):
    headers = {'Content-Type': 'application/json'}
    api_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("VITE_SUPABASE_ANON_KEY")
    if api_key:
        headers['apikey'] = api_key
    if extra_headers:
        headers.update(extra_headers)
    return headers


HEADERS = build_headers()


async def fetch_componies():
    table_name = "companies"
    if not BASE_URL:
        print("    [WARN] SUPABASE_URL not configured. Skipping company fetch.")
        return {table_name: []}

    # Try without limit first to see all data
    url = f"{BASE_URL}/{table_name}"
    print(f"[API] Fetching: {url}")

    if not HEADERS.get('apikey'):
        print("    [WARN] No Supabase API key configured. Skipping company fetch.")
        return {table_name: []}

    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=HEADERS) as response:
            print(f"    Status: {response.status}")
            data = await response.json()
            return {table_name: data}


async def fetch_user_skills():
    """Fetch all user skills from database"""
    url = f"{BASE_URL}/user_skills?select=skills"
    print(f"[API] Fetching: {url}")

    if not HEADERS.get('apikey'):
        print("    [WARN] No Supabase API key configured. Skipping user skills fetch.")
        return []

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=HEADERS) as response:
                print(f"    Status: {response.status}")
                data = await response.json()

                # Flatten all skills from all users into one list
                all_skills = []
                for user_skill in data:
                    skills = user_skill.get('skills', [])
                    if isinstance(skills, list):
                        all_skills.extend(skills)
                    elif isinstance(skills, str):
                        # Handle string format like "skill1, skill2, skill3"
                        all_skills.extend([s.strip() for s in skills.split(',')])

                print(f"    Found {len(set(all_skills))} unique skills: {list(set(all_skills))[:10]}...")
                return list(set(all_skills))  # Return unique skills
    except Exception as e:
        print(f"    [WARN] Error fetching user skills: {e}")
        return []


async def insert_jobs_to_db(jobs, ats_type):
    """Insert jobs into Supabase jobs table"""
    if not jobs:
        return

    if not HEADERS.get('apikey'):
        print("    [WARN] No Supabase API key configured. Skipping database insert.")
        return

    url = f"{BASE_URL}/jobs?on_conflict=company_id,job_id"
    print(f"    [UPSERT] Upserting {len(jobs)} jobs to database...")
    
    # Normalize fields to match Supabase schema
    # Schema: company_id, job_id, title, location, url, posted_at, skills
    def _canonical_key(company_id, job_id):
        return (
            str(company_id or "").strip().lower(),
            str(job_id or "").strip().lower()
        )

    normalized_jobs = []
    seen_keys = set()
    for job in jobs:
        normalized = {
            'company_id': job.get('company_id'),
            'job_id': job.get('job_id'),
            'title': job.get('title'),
            'location': job.get('location'),
            'url': job.get('job_url'),
            'posted_at': job.get('posted_at'),
            'skills': job.get('matched_skills') or job.get('skills', [])
        }

        # Deduplicate aggressively to avoid ON CONFLICT affecting the same row twice.
        dedupe_key = _canonical_key(normalized['company_id'], normalized['job_id'])
        if dedupe_key in seen_keys:
            continue

        seen_keys.add(dedupe_key)
        normalized_jobs.append(normalized)

    dropped_count = len(jobs) - len(normalized_jobs)
    if dropped_count > 0:
        print(f"    [UPSERT] Dropped {dropped_count} duplicate jobs in current batch")
    
    try:
        upsert_headers = {
            **HEADERS,
            'Prefer': 'resolution=merge-duplicates,return=minimal'
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=normalized_jobs, headers=upsert_headers) as response:
                if response.status in [200, 201]:
                    print(f"    [OK] Upserted {len(normalized_jobs)} jobs successfully")
                else:
                    error_text = await response.text()
                    # Fallback for Postgres 21000: same constrained row affected twice in one statement.
                    if response.status == 500 and '"code":"21000"' in error_text:
                        print("    [WARN] Bulk upsert conflict in one statement; retrying row-by-row")
                        success_count = 0
                        fail_count = 0
                        for row in normalized_jobs:
                            async with session.post(url, json=[row], headers=upsert_headers) as single_resp:
                                if single_resp.status in [200, 201]:
                                    success_count += 1
                                else:
                                    fail_count += 1

                        print(f"    [OK] Row-wise upsert complete: {success_count} succeeded, {fail_count} failed")
                    else:
                        print(f"    [ERROR] API error ({response.status}): {error_text[:200]}")
    except Exception as e:
        print(f"    [ERROR] Insert failed: {str(e)}")


async def scrape_all():
    # Fetch companies from Supabase
    results = await fetch_componies()
    
    # Fetch user skills from Supabase
    print("\n")
    user_skills = await fetch_user_skills()
    print("")
    
    companies = results.get('companies', [])
    print(f"\n[API] Fetched {len(companies)} companies from database\n")
    
    all_results = []
    
    # Scrape each company based on ATS type
    for company in companies:
        # Skip disabled companies
        if company.get('disabled', False):
            print(f"[SKIP] {company['name']}: Company disabled\n")
            continue
        
        ats_type = company.get("ats_type")
        
        # Add user skills to company object for scraper to use
        company['user_skills'] = user_skills
        
        if ats_type == "workday":
            try:
                print(f"[SCRAPER] Workday: {company['name']}")
                scraper = WorkdayScraper(company)
                jobs = await scraper.scrape()
                
                # Store results
                all_results.append({
                    "company": company['name'],
                    "ats_type": ats_type,
                    "jobs_found": len(jobs),
                    "jobs": jobs
                })
                
                print(f"[RESULT] {company['name']}: {len(jobs)} jobs ready")
                
                # Show sample job if available
                if jobs:
                    sample = jobs[0]
                    print(f"    Sample: {sample['title']}")
                    print(f"    Location: {sample['location']}")
                    print(f"    Posted: {sample['posted_date']}")
                    print(f"    Description: {sample['description'][:80]}...")
                    
                    # INSERT WORKDAY JOBS TO DB
                    await insert_jobs_to_db(jobs, ats_type)
                else:
                    print(f"    No jobs found after filtering")
                
                print()
                    
            except Exception as e:
                print(f"[ERROR] {company['name']}: {str(e)}\n")
        
        elif ats_type == "linkedin":
            try:
                print(f"[SCRAPER] LinkedIn: {company['name']}")
                scraper = LinkedInScraper(company)
                jobs = await scraper.scrape()
                
                # Store results
                all_results.append({
                    "company": company['name'],
                    "ats_type": ats_type,
                    "jobs_found": len(jobs),
                    "jobs": jobs
                })
                
                print(f"[RESULT] {company['name']}: {len(jobs)} jobs ready")
                
                # Show sample job if available
                if jobs:
                    sample = jobs[0]
                    print(f"    Sample: {sample['title']}")
                    print(f"    Location: {sample['location']}")
                    print(f"    Posted: {sample['posted_time']}")
                    print(f"    Description: {sample['description'][:80]}...")
                    # INSERT LINKEDIN JOBS TO DB
                    await insert_jobs_to_db(jobs, ats_type)
                else:
                    print(f"    No jobs found after filtering")
                
                print()
                    
            except Exception as e:
                print(f"[ERROR] {company['name']}: {str(e)}\n")

        elif ats_type == "indeed":
            try:
                print(f"[SCRAPER] Indeed: {company['name']}")
                from indeed.main import Scraper as IndeedScraper
                scraper = IndeedScraper(company)
                jobs = await scraper.scrape()

                all_results.append({
                    "company": company['name'],
                    "ats_type": ats_type,
                    "jobs_found": len(jobs),
                    "jobs": jobs
                })

                print(f"[RESULT] {company['name']}: {len(jobs)} jobs ready")

                if jobs:
                    sample = jobs[0]
                    print(f"    Sample: {sample['title']}")
                    print(f"    Location: {sample['location']}")
                    print(f"    Posted: {sample['posted_time']}")
                    print(f"    Description: {sample['description'][:80]}...")
                    await insert_jobs_to_db(jobs, ats_type)
                else:
                    print(f"    No jobs found after filtering")

                print()

            except Exception as e:
                print(f"[ERROR] {company['name']}: {str(e)}\n")
        
        else:
            print(f"[SKIP] {company['name']}: ATS type '{ats_type}' not supported\n")
    
    # Summary
    total_jobs = sum(r['jobs_found'] for r in all_results)
    print(f"\n[SUMMARY] Scraped {len(all_results)} companies, {total_jobs} total jobs")
    
    return all_results

# Run the scraper
if __name__ == "__main__":
    asyncio.run(scrape_all())