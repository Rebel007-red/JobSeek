/**
 * Local test — runs all enabled companies without writing to Supabase.
 * Usage: node test-all.js
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { fetchGreenhouseJobs } from './greenhouse.js'
import { fetchWorkdayJobs } from './workday.js'
import { fetchPhenomJobs } from './phenom.js'
import { fetchICIMSJobs } from './icims.js'
import { fetchOracleJobs } from './oracle.js'
import { fetchSuccessFactorsJobs } from './successfactors.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const companies = JSON.parse(readFileSync(join(__dirname, 'companies.json'), 'utf-8'))

for (const company of companies) {
  if (company.disabled) {
    console.log(`SKIP  ${company.name} (disabled: ${company._comment || company.ats_type})`)
    continue
  }

  process.stdout.write(`TEST  ${company.name} (${company.ats_type})... `)
  try {
    let jobs = []
    if (company.ats_type === 'greenhouse') jobs = await fetchGreenhouseJobs(company)
    else if (company.ats_type === 'workday') jobs = await fetchWorkdayJobs(company)
    else if (company.ats_type === 'phenom') jobs = await fetchPhenomJobs(company)
    else if (company.ats_type === 'icims') jobs = await fetchICIMSJobs(company)
    else if (company.ats_type === 'oracle') jobs = await fetchOracleJobs(company)
    else if (company.ats_type === 'successfactors') jobs = await fetchSuccessFactorsJobs(company)
    console.log(`✓  ${jobs.length} jobs — "${jobs[0]?.title}" @ ${jobs[0]?.location}`)
  } catch (e) {
    console.log(`✗  FAILED: ${e.message}`)
  }
}
