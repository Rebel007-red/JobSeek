import asyncio
import aiohttp
from dotenv import load_dotenv
import os
import json
from workday.main import Scraper as WorkdayScraper
from linkedin.main import Scraper as LinkedInScraper

# Load environment variables from .env
load_dotenv()

BASE_URL = "https://deczscnmmxpgpayyxglk.supabase.co/rest/v1"
HEADERS = {
    'apikey': os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
    'Content-Type': 'application/json'
}

async def fetch_componies():
    table_name = "companies"
    # Try without limit first to see all data
    url = f"{BASE_URL}/{table_name}"
    print(f"[API] Fetching: {url}")
    
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=HEADERS) as response:
            print(f"    Status: {response.status}")
            data = await response.json()
            return {table_name: data}


async def fetch_user_skills():
    """Fetch all user skills from database"""
    url = f"{BASE_URL}/user_skills?select=skills"
    print(f"[API] Fetching: {url}")
    
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
    
    url = f"{BASE_URL}/jobs"
    print(f"    [INSERT] Inserting {len(jobs)} jobs to database...")
    
    # Normalize fields to match Supabase schema
    # Schema: company_id, job_id, title, location, url, posted_at, skills
    normalized_jobs = []
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
        normalized_jobs.append(normalized)
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=normalized_jobs, headers=HEADERS) as response:
                if response.status in [200, 201]:
                    print(f"    [OK] Inserted {len(normalized_jobs)} jobs successfully")
                else:
                    error_text = await response.text()
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
                    # NOTE: LinkedIn jobs not inserted to DB yet
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