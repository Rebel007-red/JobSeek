/**
 * Workday Playwright Scraper
 * 
 * Uses Playwright to render JavaScript and extract job listings from Workday career portals
 * Handles dynamic page loads and extracts: title, location, description, URL, skills
 */

import { chromium } from 'playwright';
import { extractSkillsFromText } from './skills-extractor.js';
import { loadFilterSkills } from './load-user-skills.js';
import { filterJobsBySkills as filterByUserSkills } from './skill-filter.js';
import { parse } from 'node-html-parser';

const MAX_JOBS = 100;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MIN_SKILL_KEYWORDS = 1;
let SKILL_KEYWORDS = [];

/**
 * Parse Workday's relative date format to Date object
 * Handles: "today", "yesterday", "3 days ago", "Posted 2 days ago", etc.
 * Returns null if date cannot be parsed (defaults to current time in caller)
 */
function parseWorkdayDate(dateStr) {
  if (!dateStr) return null;
  
  const str = dateStr.toLowerCase().trim();
  
  // Handle "today"
  if (str.includes('today')) {
    return new Date();
  }
  
  // Handle "yesterday"
  if (str.includes('yesterday')) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  }
  
  // Handle "X days ago"
  const daysMatch = str.match(/(\d+)\s*days?\s*ago/i);
  if (daysMatch) {
    const daysAgo = parseInt(daysMatch[1], 10);
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d;
  }
  
  // Handle "X hours ago" (if present)
  const hoursMatch = str.match(/(\d+)\s*hours?\s*ago/i);
  if (hoursMatch) {
    const hoursAgo = parseInt(hoursMatch[1], 10);
    const d = new Date();
    d.setHours(d.getHours() - hoursAgo);
    return d;
  }
  
  return null;  // Cannot parse - caller will use fallback
}

/**
 * Filter jobs by freshness (24-hour window)
 * Must be called BEFORE skill filtering
 */
function filterByFreshness(jobs) {
  const MAX_AGE_HOURS = 24;
  const now = new Date();
  
  return jobs.filter(job => {
    if (!job.posted_at) {
      // No date = assume fresh
      return true;
    }
    
    try {
      const jobDate = new Date(job.posted_at);
      const ageHours = (now - jobDate) / (1000 * 60 * 60);
      return ageHours <= MAX_AGE_HOURS;
    } catch (e) {
      // Parse error = assume fresh
      return true;
    }
  });
}

/**
 * Parse jobs from rendered Workday HTML
 * Target: Find all links to job details pages (href contains /details/)
 */
function parseJobsFromHTML(html, company) {
  try {
    const root = parse(html);
    const jobs = [];

    // Primary strategy: Find all links pointing to job detail pages
    // Workday URLs: /en-US/Company/job/Location/JobID
    const jobLinks = root.querySelectorAll('a[href*="/job/"]') || [];
    
    console.log(`    📄 Found ${jobLinks.length} job detail links (/job/ path)`);

    for (const link of jobLinks) {
      try {
        const href = link.getAttribute('href') || '';
        const text = link.text?.trim() || '';

        // Validate job title length
        if (text.length < 3 || text.length > 250) {
          continue;
        }

        // Extract title from link text
        const title = text;

        // Try to extract posting date from parent elements (job card context)
        let postedDate = null;
        try {
          // Look for posting date in nearby text (parent or sibling elements)
          const parent = link.parentNode;
          if (parent) {
            const parentText = parent.text || '';
            // Try to find relative date patterns: "today", "yesterday", "X days ago", "Posted X"
            const dateMatch = parentText.match(/(?:posted|posted on)?\s*(today|yesterday|(\d+)\s*days?\s*ago)/i);
            if (dateMatch) {
              postedDate = dateMatch[0];
            }
          }
        } catch (dateErr) {
          // Skip if date extraction fails
        }

        // Extract location from URL path
        // Pattern: /job/Location-With-Dashes/JobID
        const locMatch = href.match(/\/job\/([^/]+)\//);
        let location = 'Not specified';
        if (locMatch && locMatch[1]) {
          // Decode dashes to spaces, e.g., "Cork-Ireland-Office" → "Cork Ireland Office"
          location = locMatch[1]
            .replace(/-/g, ' ')
            .replace(/Office$/, '').trim();
        }

        // Build full URL using company's actual base URL (not hardcoded)
        let url = href;
        if (!url.startsWith('http')) {
          // Extract base domain from company.api_url
          const baseUrlMatch = company.api_url.match(/^https?:\/\/[^/]+/);
          const baseDomain = baseUrlMatch ? baseUrlMatch[0] : 'https://omnissa.wd501.myworkdayjobs.com';
          url = href.startsWith('/') 
            ? `${baseDomain}${href}`
            : `${baseDomain}/${href}`;
        }

        // Extract skills from title + location
        const fullText = `${title} ${location}`;
        const skills = extractSkillsFromText(fullText);

        // Generate unique job_id from URL (last segment)
        const urlParts = url.split('/');
        const urlJobId = urlParts[urlParts.length - 1] || url.replace(/[^a-z0-9]/gi, '');
        const jobId = `workday_${urlJobId}`.substring(0, 100);

        jobs.push({
          job_id: jobId, // REQUIRED for upsert
          title: title.substring(0, 200),
          location: location.substring(0, 100),
          description: `${title} - ${location}`,
          url,
          skills,
          posted_at: postedDate 
            ? parseWorkdayDate(postedDate)?.toISOString() 
            : new Date().toISOString(),  // Fallback to current time if no date found
        });

      } catch (e) {
        // Silently skip problematic entries
      }
    }

    return jobs;
  } catch (e) {
    console.error(`    ❌ Parse error: ${e.message}`);
    return [];
  }
}

/**
 * Filter jobs by user skills
 * Uses new reusable filter that checks if job title/description matches user skills
 */
function filterJobsByUserSkills(jobs, userSkills) {
  if (userSkills.length === 0) {
    console.log(`  ℹ️  No user skills defined, returning all ${jobs.length} jobs`);
    return jobs;
  }
  
  const filtered = filterByUserSkills(jobs, userSkills, MIN_SKILL_KEYWORDS);
  console.log(`  ✅ Filtered ${jobs.length} jobs → ${filtered.length} matching user skills`);
  
  return filtered;
}

/**
 * Main scraper using Playwright
 */
export async function fetchWorkdayJobs(company) {
  if (!company.api_url) {
    throw new Error(`Workday company "${company.name}" missing api_url`);
  }

  SKILL_KEYWORDS = await loadFilterSkills();
  console.log(`  🔍 Skill filter: ${SKILL_KEYWORDS.length > 0 ? SKILL_KEYWORDS.join(', ') : 'DISABLED (all jobs)'}`);

  let browser;
  let allJobs = [];

  try {
    // Launch browser
    console.log(`  🚀 Launching Playwright browser...`);
    browser = await chromium.launch({ 
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    });
    
    const page = await browser.newPage();
    page.setDefaultTimeout(60000); // 60 second timeout
    page.setDefaultNavigationTimeout(45000);

    console.log(`  🌐 Navigating to: ${company.api_url}`);

    // Navigate to career page
    await page.goto(company.api_url, { 
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    console.log(`  ⏳ Initial page load complete, waiting for job content...`);
    
    // Wait for job listings - this is the critical part
    // Try multiple strategies in sequence
    let hasJobs = false;
    
    // Strategy 1: Wait for job detail links specifically
    try {
      await page.waitForSelector('a[href*="/job/"]', { timeout: 15000 });
      hasJobs = true;
      console.log(`  ✅ Job links found (strategy 1: /job/ selector)`);
    } catch (e) {
      console.log(`  ⚠️  Strategy 1 timeout, trying strategy 2...`);
    }

    // Strategy 2: Wait for any anchor tags (fallback)
    if (!hasJobs) {
      try {
        await page.waitForSelector('a', { timeout: 10000 });
        hasJobs = true;
        console.log(`  ✅ Links found (strategy 2: generic anchor)`);
      } catch (e) {
        console.log(`  ⚠️  Strategy 2 timeout, checking page content...`);
      }
    }

    // Wait for React/JS rendering to stabilize
    console.log(`  📜 Scrolling to load more jobs...`);
    
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
      });
      await page.waitForTimeout(1200);
      
      // Check if we found any jobs
      const linkCount = await page.evaluate(() => {
        return document.querySelectorAll('a[href*="/job/"]').length;
      });
      
      console.log(`    Scroll ${i + 1}: ${linkCount} jobs found`);
      
      if (linkCount > 0) {
        hasJobs = true;
      }
    }

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    // Get the rendered HTML
    console.log(`  📄 Extracting rendered HTML...`);
    const html = await page.content();

    // Parse jobs from HTML
    allJobs = parseJobsFromHTML(html, company);

    console.log(`  ✓ Extracted: ${allJobs.length} jobs before filter`);

    // FILTER 1: Freshness (24-hour window) - must be FIRST
    const freshJobs = filterByFreshness(allJobs);
    console.log(`  ✅ Freshness filter: ${allJobs.length} → ${freshJobs.length} jobs (24hr window)`);

    // FILTER 2: Skill matching - applied after freshness
    const filtered = filterJobsByUserSkills(freshJobs, SKILL_KEYWORDS);
    console.log(`  ✓ After skill filter: ${filtered.length} jobs`);

    // Return filtered jobs
    return filtered.slice(0, MAX_JOBS);

  } catch (e) {
    console.error(`  ❌ Scraper error: ${e.message}`);
    if (e.stack) {
      console.debug(`     Stack: ${e.stack.split('\n')[1]}`);
    }
    return [];
  } finally {
    if (browser) {
      console.log(`  🔒 Closing browser...`);
      await browser.close();
    }
  }
}

