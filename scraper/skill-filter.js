/**
 * Job Skill Filter
 * 
 * Reusable filtering function for all ATS types (Workday, Indeed, LinkedIn, Naukri, etc.)
 * Filters jobs based on user skills stored in database
 * Note: Freshness filtering (24-hour window) is handled by scraper/index.js
 * 
 * Usage:
 *   import { filterJobBySkills, filterJobsBySkills } from './skill-filter.js'
 *   const matchesSkills = filterJobBySkills(job, userSkills, minMatches)
 */

/**
 * Extract skill keywords from text (job title + description)
 * Uses word boundaries to avoid false matches
 */
function extractJobSkills(text, userSkills) {
  if (!text || userSkills.length === 0) return [];
  
  const lower = text.toLowerCase();
  const matchedSkills = [];
  
  for (const skill of userSkills) {
    const skillLower = skill.toLowerCase().trim();
    
    if (!skillLower) continue;
    
    // Multi-word skills (e.g., "machine learning", "data science")
    if (skillLower.includes(' ')) {
      if (lower.includes(skillLower)) {
        matchedSkills.push(skill);
      }
    } 
    // Single-word skills with word boundaries
    else {
      const escaped = skillLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = `(?<![a-z0-9])${escaped}(?![a-z0-9])`;
      if (new RegExp(pattern, 'i').test(lower)) {
        matchedSkills.push(skill);
      }
    }
  }
  
  return matchedSkills;
}

/**
 * Filter a single job by checking if it matches user skills
 * 
 * @param {Object} job - Job object with at least { title, description }
 * @param {Array} userSkills - Array of skill strings from database
 * @param {Number} minMatches - Minimum number of skill matches required (default: 1)
 * @returns {Object|null} Returns job with matched skills, or null if doesn't match
 * 
 * Example:
 *   const filtered = filterJobBySkills(job, ['python', 'aws', 'docker'], 1)
 *   if (filtered) { console.log(`Matched ${filtered.matchedSkills.length} skills`) }
 */
export function filterJobBySkills(job, userSkills, minMatches = 1) {
  if (!job || !job.title) return null;
  
  // Combine title + description for comprehensive matching
  const fullText = `${job.title} ${job.description || ''}`;
  
  // Extract which skills this job matches
  const matchedSkills = extractJobSkills(fullText, userSkills);
  
  // Check if meets minimum threshold
  if (matchedSkills.length >= minMatches) {
    return {
      ...job,
      matchedSkills,
      matchScore: Math.round((matchedSkills.length / userSkills.length) * 100)
    };
  }
  
  return null;
}

/**
 * Filter multiple jobs by skills
 * 
 * @param {Array} jobs - Array of job objects
 * @param {Array} userSkills - Array of skill strings from database
 * @param {Number} minMatches - Minimum number of skill matches required (default: 1)
 * @returns {Array} Filtered jobs that match skills, sorted by match score descending
 */
export function filterJobsBySkills(jobs, userSkills, minMatches = 1) {
  if (!Array.isArray(jobs) || !Array.isArray(userSkills)) {
    return [];
  }
  
  const filtered = jobs
    .map(job => filterJobBySkills(job, userSkills, minMatches))
    .filter(job => job !== null)
    .sort((a, b) => b.matchScore - a.matchScore);
  
  return filtered;
}

export default { filterJobBySkills, filterJobsBySkills };
