import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function deleteOldJobs() {
  // Get all Workday company IDs
  const { data: companies } = await supabase
    .from('companies')
    .select('id, name')
    .in('slug', ['omnissa', 'dentsuaegis', 'miq', 'fractal', 'rockwellautomation']);

  console.log(`Deleting jobs from ${companies.length} Workday companies...\n`);

  let totalDeleted = 0;
  for (const company of companies) {
    const { count, error } = await supabase
      .from('jobs')
      .delete({ count: 'exact' })
      .eq('company_id', company.id);

    if (error) {
      console.error(`  ❌ ${company.name}: ${error.message}`);
    } else {
      console.log(`  ✓ ${company.name}: Deleted ${count} jobs`);
      totalDeleted += count;
    }
  }

  console.log(`\nTotal deleted: ${totalDeleted} jobs`);
}

deleteOldJobs();
