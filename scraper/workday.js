/**
 * Workday handler
 *
 * Workday does not have one universal public API — each tenant has its own URL.
 * The standard undocumented JSON endpoint most Workday career sites expose is:
 *   POST {api_url}
 *   Body: { "appliedFacets": {}, "limit": 20, "offset": 0, "searchText": "" }
 *
 * The api_url for each company must be provided in companies.json.
 * Format: https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{path}/jobs
 *
 * To find the URL: open the company's careers page, open DevTools → Network,
 * filter by "jobs", and look for a POST request to a myworkdayjobs.com URL.
 */

import { extractSkillsFromText } from './skills-extractor.js'
import { loadFilterSkills } from './load-user-skills.js'

const PAGE_SIZE = 20;
const MAX_JOBS = 50;  // Limit to 50 high-quality jobs
const MAX_AGE_MS = 24 * 3600 * 1000  // 24 hours in ms
const MIN_SKILL_KEYWORDS = 2  // Must match at least 2 skill keywords
let SKILL_KEYWORDS = []

export async function fetchWorkdayJobs(company) {
  // Load user's preferred skills for filtering
  SKILL_KEYWORDS = await loadFilterSkills()
  
  const { api_url } = company;
  if (!api_url) {
    throw new Error(`Workday company "${company.name}" is missing api_url in companies.json`);
  }

  const allJobs = [];
  let offset = 0;
  let total = null;

  while (total === null || offset < total) {
    if (allJobs.length >= MAX_JOBS) break;  // Stop at 50 jobs

    const res = await fetch(api_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; JobAggregator/1.0)',
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: PAGE_SIZE,
        offset,
        searchText: '',
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Workday API error for ${company.name}: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const postings = data.jobPostings || [];

    if (total === null) {
      total = data.total || postings.length;
    }

    postings.forEach((job) => {
      if (allJobs.length >= MAX_JOBS) return;  // Stop at 50 jobs

      // Filter by 24hr freshness
      const postedDate = new Date(job.postedOn || 0)
      if (Date.now() - postedDate.getTime() > MAX_AGE_MS) return  // Skip jobs older than 24 hours

      // Quality filter — pyspark/databricks focus
      const desc = (job.description || '').toLowerCase()
      const title = (job.title || '').toLowerCase()
      const matchCount = SKILL_KEYWORDS.filter(kw => desc.includes(kw) || title.includes(kw)).length
      if (matchCount < MIN_SKILL_KEYWORDS) return  // Skip if doesn't match pyspark/databricks focus

      const tenantBase = api_url.split('/wday/')[0]
      // Extract board name from: /wday/cxs/{tenant}/{board}/jobs
      const boardName = api_url.split('/wday/cxs/')[1]?.split('/')?.[1] || ''
      const careerBase = boardName ? `${tenantBase}/en-US/${boardName}` : tenantBase
      const jobPath = job.externalPath || ''
      // Only store properly formatted dates — Workday sometimes returns "Posted X Days Ago"
      const rawDate = job.postedOn || null
      const posted_at = rawDate && /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate : null
      
      // Extract skills from job details
      const skills = extractSkillsFromText(job.description || '')
      
      allJobs.push({
        job_id: job.bulletFields?.[0] || job.title + '-' + offset,
        title: job.title || 'Untitled',
        location: job.locationsText || null,
        department: job.jobFamilyGroup || null,
        url: jobPath ? `${careerBase}${jobPath}` : careerBase,
        posted_at,
        skills: skills || [],
      });
    });

    if (allJobs.length >= MAX_JOBS) break;
    offset += postings.length;

    // Safety: stop if we got an empty page
    if (postings.length === 0) break;
  }

  return allJobs;
}
