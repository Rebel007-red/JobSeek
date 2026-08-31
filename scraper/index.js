import { createClient } from '@supabase/supabase-js';
import { fetchGreenhouseJobs } from './greenhouse.js';
import { fetchWorkdayJobs } from './workday.js';
import { fetchPhenomJobs } from './phenom.js';
import { fetchICIMSJobs } from './icims.js';
import { fetchOracleJobs } from './oracle.js';
import { fetchSuccessFactorsJobs } from './successfactors.js';

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
async function loadCompanies() {
  const { data, error } = await supabase
    .from('companies')
    .select('*')
    .eq('disabled', false)
    .order('name');
  if (error) throw new Error(`Failed to load companies: ${error.message}`);
  if (!data || data.length === 0) {
    console.warn('No enabled companies found in Supabase. Add companies via the Settings page in the app.');
    return [];
  }
  return data;
}

// ── Helpers ───────────────────────────────────────────────────

async function ensureCompanyRow(company) {
  // Upsert the company row and return its id
  const { data, error } = await supabase
    .from('companies')
    .upsert(
      {
        name: company.name,
        ats_type: company.ats_type,
        slug: company.slug || null,
        api_url: company.api_url || null,
      },
      { onConflict: 'name' }
    )
    .select('id')
    .single();

  if (error) throw new Error(`Failed to upsert company "${company.name}": ${error.message}`);
  return data.id;
}

async function upsertJobs(companyId, jobs) {
  if (jobs.length === 0) return 0;

  const now = new Date().toISOString();

  const rows = jobs.map((job) => ({
    company_id: companyId,
    job_id: job.job_id,
    title: job.title,
    location: job.location || null,
    department: job.department || null,
    url: job.url,
    posted_at: job.posted_at || null,
    last_seen_at: now,
    is_active: true,
  }));

  const { error } = await supabase.from('jobs').upsert(rows, {
    onConflict: 'company_id,job_id',
    ignoreDuplicates: false,
  });

  if (error) throw new Error(`Failed to upsert jobs: ${error.message}`);
  return rows.length;
}

// ── Main ──────────────────────────────────────────────────────

async function run() {
  let totalInserted = 0;
  const errors = [];

  const companies = await loadCompanies();
  console.log(`Loaded ${companies.length} enabled companies from Supabase.\n`);

  for (const company of companies) {
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
      } else {
        console.warn(`  Unknown ats_type "${company.ats_type}" — skipping`);
        continue;
      }

      console.log(`  Found ${jobs.length} jobs`);
      const count = await upsertJobs(company.id, jobs);
      totalInserted += count;
      console.log(`  Upserted ${count} jobs`);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      errors.push({ company: company.name, error: err.message });
    }
  }

  console.log(`\nDone. Total upserted: ${totalInserted}`);
  if (errors.length > 0) {
    console.error('\nErrors:');
    errors.forEach((e) => console.error(`  ${e.company}: ${e.error}`));
    process.exit(1);
  }
}

run();
