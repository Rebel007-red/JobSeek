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

    def _extract_experience(self, text):
        """Extract a normalized experience value for jobs with 2+ years experience.

        We keep this intentionally narrow to match the current product preference:
        only jobs that clearly advertise 2 or more years are tagged.
        """
        if not text:
            return None

        normalized = text.lower().replace('–', '-').replace('—', '-')
        patterns = [
            r'(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\+?\s*years?\s*of\s*experience',
            r'(\d+(?:\.\d+)?)\s*\+\s*years?\s*of\s*experience',
            r'(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*years?\s*experience',
            r'(\d+(?:\.\d+)?)\s*years?\s*of\s*experience',
            r'(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\+?\s*yrs?\s*exp',
            r'(\d+(?:\.\d+)?)\s*\+\s*yrs?\s*exp',
        ]

        import re

        for pattern in patterns:
            match = re.search(pattern, normalized)
            if not match:
                continue

            if len(match.groups()) == 2:
                start = float(match.group(1))
                end = float(match.group(2))
                if start < 2:
                    return None
                if start <= end:
                    text_value = f"{int(start) if start.is_integer() else start}-{int(end) if end.is_integer() else end} years"
                    return {
                        'experience_text': text_value,
                        'experience_years': int(start) if start.is_integer() else start,
                    }

            value = float(match.group(1))
            if value < 2:
                return None

            text_value = f"{int(value) if value.is_integer() else value}+ years"
            return {
                'experience_text': text_value,
                'experience_years': int(value) if value.is_integer() else value,
            }

        return None

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
        job_description = (job.get('description', '') or '').lower()
        job_title = (job.get('title', '') or '').lower()
        combined_text = f"{job_title} {job_description}"
        matched_skills = []

        if 'data' in combined_text:
            matched_skills.append('data')

        if not self.skills:
            return matched_skills

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
                experience = self._extract_experience(
                    f"{job.get('title', '') or ''} {job.get('description', '') or ''}"
                )
                if experience:
                    job['experience_text'] = experience['experience_text']
                    job['experience_years'] = experience['experience_years']

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