import { createClient } from '@supabase/supabase-js';
import { fetchGreenhouseJobs } from './greenhouse.js';
import { fetchWorkdayJobs } from './workday.js';
import { fetchPhenomJobs } from './phenom.js';
import { fetchICIMSJobs } from './icims.js';
import { fetchOracleJobs } from './oracle.js';
import { fetchSuccessFactorsJobs } from './successfactors.js';
import { fetchJSearchJobs } from './jsearch.js';
import { fetchLinkedInJobs } from './linkedin.js';
import { fetchNaukriJobs } from './naukri.js';
import { fetchMedpaceJobs } from './medpace.js';
import { fetchGoogleJobsJobs } from './google-jobs.js';
import { loadFilterSkills } from './load-user-skills.js';

// ── Environment ──────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── Load companies from Supabase ──────────────────────────────
// mode: 'companies' (default, used by 30-min cron) or 'boards' (daily job board search)
async function loadCompanies(mode = 'all') {
  const BOARD_TYPES = ['jsearch', 'linkedin', 'naukri']
  
  // Hardcoded board companies (no database lookup needed)
  // Using stable IDs so job references don't break
  const BOARD_COMPANIES = [
    { id: '00000001-0000-0000-0000-000000000001', name: 'JSearch', ats_type: 'jsearch', api_url: 'data engineer python pyspark databricks', slug: 'jsearch', disabled: false },
    { id: '00000001-0000-0000-0000-000000000002', name: 'LinkedIn Jobs', ats_type: 'linkedin', api_url: 'data engineer python pyspark databricks', slug: 'linkedin', disabled: false },
    { id: '230f9132-8381-4646-9d6d-9b2d1ed44f7e', name: 'Databricks Greenhouse', ats_type: 'greenhouse', api_url: '', slug: 'databricks', disabled: false },
    { id: '00000001-0000-0000-0000-000000000006', name: 'Google Jobs', ats_type: 'google-jobs', api_url: '', slug: 'google-jobs', disabled: false },
    { id: '00000001-0000-0000-0000-000000000003', name: 'Naukri.com', ats_type: 'naukri', api_url: 'data engineer python pyspark databricks', slug: 'naukri', disabled: true },  // Disabled: requires reCAPTCHA
    { id: '00000001-0000-0000-0000-000000000004', name: 'Accenture', ats_type: 'workday', api_url: 'https://accenture.wd103.myworkdayjobs.com/wday/cxs/accenture/AccentureCareers/jobs', slug: 'accenture', disabled: false },
    { id: '00000001-0000-0000-0000-000000000005', name: 'Medpace', ats_type: 'medpace', api_url: '', slug: 'medpace', disabled: false },
  ]

  // For board mode, return hardcoded list (bypass database constraint issue)
  if (mode === 'boards') {
    return BOARD_COMPANIES
  }

  let query = supabase.from('companies').select('*').eq('disabled', false).order('name')

  if (mode === 'companies') {
    // Exclude job boards — they run on a separate daily schedule
    query = query.not('ats_type', 'in', `(${BOARD_TYPES.map(t => `"${t}"`).join(',')})`)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to load companies: ${error.message}`)
  if (!data || data.length === 0) {
    console.warn(`No enabled companies found for mode="${mode}".`)
    return []
  }
  return data
}

// ── Helpers ───────────────────────────────────────────────────

// Validate and sanitize a date value — returns ISO string or null
function safeDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function upsertJobs(companyId, jobs) {
  if (jobs.length === 0) return 0;

  const now = new Date().toISOString();

  // Deduplicate by job_id within this batch
  const seen = new Set();
  const uniqueJobs = jobs.filter(job => {
    if (!job.job_id || seen.has(job.job_id)) return false;
    seen.add(job.job_id);
    return true;
  });

  const rows = uniqueJobs
    .filter(job => {
      // Filter: only keep jobs posted in last 24 hours
      const postedDate = job.posted_at ? new Date(job.posted_at).getTime() : null
      if (postedDate && Date.now() - postedDate > 24 * 3600 * 1000) {
        return false  // Skip jobs older than 24 hours
      }
      return true
    })
    .map((job) => ({
      company_id: companyId,
      job_id: String(job.job_id),
      title: job.title || 'Untitled',
      location: job.location || null,
      department: job.department || null,
      url: job.url || '',
      posted_at: safeDate(job.posted_at),   // sanitize — rejects "Posted X Days Ago"
      last_seen_at: now,
      is_active: true,
      skills: Array.isArray(job.skills) ? job.skills : [],
    }));

  // Chunk into batches of 500 to avoid payload / dedup issues
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from('jobs').upsert(chunk, {
      onConflict: 'company_id,job_id',
      ignoreDuplicates: false,
    });
    if (error) throw new Error(`Failed to upsert jobs: ${error.message}`);
    total += chunk.length;
  }
  return total;
}

// ── Main ──────────────────────────────────────────────────────

async function run() {
  // mode passed via CLI: node index.js --boards  (daily)  or default (every 30 min)
  const mode = process.argv.includes('--boards') ? 'boards'
    : process.argv.includes('--all') ? 'all'
    : 'companies'

  // Load user's preferred skills for filtering
  const filterSkills = await loadFilterSkills()
  console.log(`\n📋 Filter Skills: ${filterSkills.join(', ')}\n`)

  let totalInserted = 0;
  const errors = [];
  const MAX_TOTAL_JOBS = 75  // Global limit: max 75 high-quality jobs across all sources

  const companies = await loadCompanies(mode);
  console.log(`Loaded ${companies.length} companies [mode=${mode}].\n`);

  for (const company of companies) {
    // Stop if we've reached global limit
    if (totalInserted >= MAX_TOTAL_JOBS) {
      console.log(`\n⚠️  Reached global limit of ${MAX_TOTAL_JOBS} jobs. Stopping scrapers.`);
      break;
    }

    console.log(`\nScraping: ${company.name} (${company.ats_type})`);
    try {
      let jobs = [];
      if (company.ats_type === 'greenhouse') {
        jobs = await fetchGreenhouseJobs(company);
      } else if (company.ats_type === 'workday') {
        jobs = await fetchWorkdayJobs(company);
      } else if (company.ats_type === 'phenom') {
        jobs = await fetchPhenomJobs(company);
      } else if (company.ats_type === 'icims') {
        jobs = await fetchICIMSJobs(company);
      } else if (company.ats_type === 'oracle') {
        jobs = await fetchOracleJobs(company);
      } else if (company.ats_type === 'successfactors') {
        jobs = await fetchSuccessFactorsJobs(company);
      } else if (company.ats_type === 'jsearch') {
        jobs = await fetchJSearchJobs(company);
      } else if (company.ats_type === 'linkedin') {
        jobs = await fetchLinkedInJobs(company);
      } else if (company.ats_type === 'naukri') {
        jobs = await fetchNaukriJobs(company);
      } else if (company.ats_type === 'medpace') {
        jobs = await fetchMedpaceJobs(company);
      } else if (company.ats_type === 'google-jobs') {
        jobs = await fetchGoogleJobsJobs(company);
      } else {
        console.warn(`  Unknown ats_type "${company.ats_type}" — skipping`);
        continue;
      }

      console.log(`  Found ${jobs.length} jobs`);
      const count = await upsertJobs(company.id, jobs);
      totalInserted += count;
      console.log(`  Upserted ${count} jobs (total: ${totalInserted}/${MAX_TOTAL_JOBS})`);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      errors.push({ company: company.name, error: err.message });
    }
  }

  console.log(`\nDone. Total upserted: ${totalInserted}`);
  if (errors.length > 0) {
    console.error('\nErrors:');
    errors.forEach((e) => console.error(`  ${e.company}: ${e.error}`));
    // Only fail if nothing was upserted at all — partial success is still success
    if (totalInserted === 0) {
      process.exit(1);
    }
  }
}

// ── Cleanup ───────────────────────────────────────────────────
// Delete jobs not seen in the last 30 days to stay within Supabase free tier
async function cleanupOldJobs() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await supabase
    .from('jobs')
    .delete({ count: 'exact' })
    .lt('last_seen_at', cutoff);
  if (error) {
    console.warn(`Cleanup failed: ${error.message}`);
  } else if (count > 0) {
    console.log(`\nCleaned up ${count} jobs not seen in 30+ days.`);
  }
}

async function main() {
  await run();
  await cleanupOldJobs();
}

main();
