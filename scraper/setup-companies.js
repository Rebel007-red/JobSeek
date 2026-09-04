import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log('=== STEP 1: Delete all old companies ===\n');

  // Get all disabled=false companies
  const { data: oldCompanies, error: fetchError } = await sb
    .from('companies')
    .select('id, name')
    .eq('disabled', false);

  if (fetchError) {
    console.error('Error fetching companies:', fetchError.message);
    return;
  }

  console.log('Found companies to delete:', oldCompanies.map(c => c.name));

  if (oldCompanies.length > 0) {
    const { error: deleteError } = await sb
      .from('companies')
      .delete()
      .eq('disabled', false);

    if (deleteError) {
      console.error('Error deleting:', deleteError.message);
      return;
    }
    console.log(`✓ Deleted ${oldCompanies.length} companies\n`);
  }

  console.log('=== STEP 2: Add 5 new Workday companies ===\n');

  const newCompanies = [
    {
      name: 'Omnissa',
      slug: 'omnissa',
      ats_type: 'workday',
      api_url: 'https://omnissa.wd501.myworkdayjobs.com/en-US/Omnissa_External_Career_Site',
      disabled: false,
    },
    {
      name: 'DentsuAegis',
      slug: 'dentsuaegis',
      ats_type: 'workday',
      api_url: 'https://dentsuaegis.wd3.myworkdayjobs.com/en-US/DAN_GLOBAL',
      disabled: false,
    },
    {
      name: 'MiQ Digital',
      slug: 'miqdigital',
      ats_type: 'workday',
      api_url: 'https://miqdigital.wd3.myworkdayjobs.com/en-US/MiQ_Careers',
      disabled: false,
    },
    {
      name: 'Fractal',
      slug: 'fractal',
      ats_type: 'workday',
      api_url: 'https://fractal.wd1.myworkdayjobs.com/en-US/Careers',
      disabled: false,
    },
    {
      name: 'Rockwell Automation',
      slug: 'rockwellautomation',
      ats_type: 'workday',
      api_url: 'https://rockwellautomation.wd1.myworkdayjobs.com/en-US/External_Rockwell_Automation',
      disabled: false,
    },
  ];

  const { data: inserted, error: insertError } = await sb
    .from('companies')
    .insert(newCompanies)
    .select();

  if (insertError) {
    console.error('Error inserting:', insertError.message);
    return;
  }

  console.log('✓ Added companies:');
  inserted.forEach(c => console.log(`  - ${c.name} (${c.ats_type})`));
  console.log('\n✅ Database setup complete!\n');
}

main().catch(console.error);
