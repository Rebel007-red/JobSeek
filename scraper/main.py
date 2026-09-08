import asyncio
import aiohttp
from dotenv import load_dotenv
import os
import json
from workday.main import Scraper

# Load environment variables from .env
load_dotenv()

BASE_URL = "https://deczscnmmxpgpayyxglk.supabase.co/rest/v1"
HEADERS = {
    'apikey': os.getenv("VITE_SUPABASE_ANON_KEY"),
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
        ats_type = company.get("ats_type")
        
        if ats_type == "workday":
            try:
                print(f"[SCRAPER] Workday: {company['name']}")
                # Add user skills to company object for scraper to use
                company['user_skills'] = user_skills
                scraper = Scraper(company)
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
                    print(f"    Description: {sample['description'][:80]}...\n")
                else:
                    print(f"    No jobs found after filtering\n")
                    
            except Exception as e:
                print(f"[ERROR] {company['name']}: {str(e)}\n")
        else:
            print(f"[SKIP] {company['name']}: ATS type '{ats_type}' not supported yet\n")
    
    # Summary
    total_jobs = sum(r['jobs_found'] for r in all_results)
    print(f"\n[SUMMARY] Scraped {len(all_results)} companies, {total_jobs} total jobs with descriptions ready")
    
    return all_results

# Run the scraper
if __name__ == "__main__":
    asyncio.run(scrape_all())