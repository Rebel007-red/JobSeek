import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://deczscnmmxpgpayyxglk.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlY3pzY25tbXhwZ3BheXl4Z2xrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODEzMzQ3NywiZXhwIjoyMTAzNzA5NDc3fQ.zp1V1NJuT-6f_cKFty5BXNLSwVqiCqEYGeEPMAxUIW8';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Companies to add
const companies = [
  {
    id: '00000001-0000-0000-0000-000000000002',
    name: 'LinkedIn Jobs',
    ats_type: 'linkedin',
    slug: 'linkedin',
    disabled: false,
  },
  {
    id: '230f9132-8381-4646-9d6d-9b2d1ed44f7e',
    name: 'Databricks Greenhouse',
    ats_type: 'greenhouse',
    slug: 'databricks',
    disabled: false,
  },
  {
    id: '00000001-0000-0000-0000-000000000007',
    name: 'Indeed',
    ats_type: 'indeed',
    slug: 'indeed',
    disabled: false,
  },
];

console.log('Adding companies to database...');

for (const company of companies) {
  const { data, error } = await supabase
    .from('companies')
    .upsert([company], { onConflict: 'id' })
    .select();

  if (error) {
    console.error(`Error adding ${company.name}:`, error);
  } else {
    console.log(`✓ Added ${company.name}`);
  }
}

console.log('\nDone!');
