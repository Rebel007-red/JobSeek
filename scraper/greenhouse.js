/**
 * Greenhouse handler
 * Greenhouse public boards API: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 * No auth required for public job boards.
 */

import { extractSkillsFromText } from './skills-extractor.js'
import { loadFilterSkills } from './load-user-skills.js'

const MAX_JOBS = 50
const MAX_AGE_MS = 7 * 24 * 3600 * 1000  // 7 days in ms (was 24 hours - too restrictive)
const MIN_SKILL_KEYWORDS = 2  // Must match at least 2 skill keywords
let SKILL_KEYWORDS = []

export async function fetchGreenhouseJobs(company) {
  // Load user's preferred skills for filtering
  SKILL_KEYWORDS = await loadFilterSkills()
  const { slug } = company;
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Greenhouse API error for ${company.name}: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  
  // Parse all jobs first, then filter by skills (do NOT filter by freshness during parse)
  const now = Date.now()
  const filtered = (data.jobs || [])
    .filter(job => {
      // Quality filter — pyspark/databricks focus
      const desc = (job.content || '').toLowerCase()
      const title = (job.title || '').toLowerCase()
      const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length
      return matchCount >= MIN_SKILL_KEYWORDS
    })
    .slice(0, MAX_JOBS)
  
  return filtered.map((job) => ({
    job_id: String(job.id),
    title: job.title || 'Untitled',
    location: job.location?.name || null,
    department: job.departments?.[0]?.name || null,
    url: job.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${job.id}`,
    posted_at: job.first_published_at || job.updated_at || null,
    skills: extractSkillsFromText(job.content || ''),
  }));
}
