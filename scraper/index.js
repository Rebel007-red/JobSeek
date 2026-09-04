import { createClient } from '@supabase/supabase-js';
import { fetchWorkdayJobs } from './workday_html.js';
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
// Query disabled=false companies from database
async function loadCompanies() {
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('*')
      .eq('disabled', false)
      .order('name')
    
    if (error) throw new Error(`Failed to load companies: ${error.message}`)
    if (!data || data.length === 0) {
      console.warn(`⚠️  No enabled companies found in Supabase.`)
      return []
    }
    return data
  } catch (err) {
    console.error(`Failed to load companies from Supabase: ${err.message}`)
    return []
  }
}

// ── Helpers ───────────────────────────────────────────────────

// Call Python scraper and parse JSON output
function callPythonScraper(scriptPath) {
  try {
    const output = execSync(`python ${scriptPath}`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,  // 10MB buffer for large outputs
    });
    
    // Extract JSON from output (skip any logging lines)
    const jsonMatch = output.match(/\[\{[\s\S]*\}(?:\,[\s\S]*\})*\]|\[\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch (error) {
    console.error(`Error calling Python scraper ${scriptPath}:`, error.message);
    return [];
  }
}

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

  // NOTE: Freshness filtering (24-hour window) is now handled by individual scrapers
  // (e.g., workday_html.js has filterByFreshness() called BEFORE skill matching)
  // Each ATS type must implement its own date parsing and freshness filter
  
  const rows = uniqueJobs
    .map((job) => ({
      company_id: companyId,
      job_id: String(job.job_id),
      title: job.title || 'Untitled',
      location: job.location || null,
      department: job.department || null,
      url: job.url || '',
      posted_at: safeDate(job.posted_at),
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
  // Load user's preferred skills for filtering
  const filterSkills = await loadFilterSkills()
  console.log(`\n📋 Filter Skills: ${filterSkills.join(', ')}\n`)

  let totalInserted = 0;
  const errors = [];
  // NO GLOBAL JOB LIMIT - fetch all available jobs from all companies

  const companies = await loadCompanies();
  console.log(`Loaded ${companies.length} companies from Supabase.\n`);

  for (const company of companies) {

    console.log(`\nScraping: ${company.name} (${company.ats_type})`);
    try {
      let jobs = [];
      
      // Currently only supporting Workday
      if (company.ats_type === 'workday') {
        jobs = await fetchWorkdayJobs(company);
      } else {
        console.warn(`  Unsupported ATS type: ${company.ats_type} — skipping`);
        continue;
      }

      console.log(`  Found ${jobs.length} jobs`);
      const count = await upsertJobs(company.id, jobs);
      totalInserted += count;
      console.log(`  Upserted ${count} jobs (total: ${totalInserted})`);
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
