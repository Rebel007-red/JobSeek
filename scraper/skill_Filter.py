import os
import aiohttp
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").rstrip("/")
BASE_URL = f"{SUPABASE_URL}/rest/v1" if SUPABASE_URL else ""
HEADERS = {
    'apikey': os.getenv("VITE_SUPABASE_ANON_KEY"),
    'Content-Type': 'application/json'
}


class SkillFilter:
    """Centralized skill matching for job filtering"""
    
    def __init__(self, skills):
        """Initialize filter with user's required skills
        
        Args:
            skills: List of skill strings to match against jobs
        """
        self.skills = skills if skills else []
        self.last_filter_stats = {}  # Track stats from last filter() call
    
    def _match_skill_in_text(self, skill, text):
        """Check if skill matches in text (case-insensitive)
        
        Args:
            skill: Skill string to search for
            text: Text to search in (should be lowercase)
        
        Returns:
            bool: True if skill found in text
        """
        return skill.lower() in text
    
    def _find_matched_skills(self, job):
        """Find all skills that match a job's title and description
        
        Args:
            job: Job dict with 'title' and 'description' fields
        
        Returns:
            list: Skills that matched this job
        """
        if not self.skills:
            return []
        
        job_description = job.get('description', '').lower()
        job_title = job.get('title', '').lower()
        matched_skills = []
        
        for skill in self.skills:
            if self._match_skill_in_text(skill, job_description) or self._match_skill_in_text(skill, job_title):
                if skill not in matched_skills:  # Avoid duplicates
                    matched_skills.append(skill)
        
        return matched_skills
    
    def filter(self, jobs):
        """Filter jobs by required skills and add matched skills to each job
        
        Args:
            jobs: List of job dicts with 'title' and 'description'
        
        Returns:
            list: Jobs with at least one matched skill, with 'matched_skills' field added
        """
        if not self.skills:
            return jobs
        
        filtered_jobs = []
        matched_count = 0
        skills_used = set()
        
        for job in jobs:
            matched_skills = self._find_matched_skills(job)
            
            if matched_skills:
                # Add matched skills to job object
                job['matched_skills'] = matched_skills
                filtered_jobs.append(job)
                matched_count += 1
                skills_used.update(matched_skills)
                
                # DEBUG: Print which skills matched
                print(f"        [SKILL MATCH] {matched_skills} matched in: {job.get('title', '')[:50]}")
        
        # Store stats for later retrieval
        self.last_filter_stats = {
            'total_input': len(jobs),
            'total_matched': matched_count,
            'matched_skills_used': list(skills_used),
            'skills_not_used': [s for s in self.skills if s not in skills_used]
        }
        
        return filtered_jobs
    
    def get_stats(self):
        """Get statistics from the last filter() call
        
        Returns:
            dict: Stats including total_matched, skills_used, etc.
        """
        return self.last_filter_stats