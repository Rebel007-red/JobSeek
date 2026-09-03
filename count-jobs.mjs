import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://deczscnmmxpgpayyxglk.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlY3pzY25tbXhwZ3BheXl4Z2xrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODEzMzQ3NywiZXhwIjoyMTAzNzA5NDc3fQ.zp1V1NJuT-6f_cKFty5BXNLSwVqiCqEYGeEPMAxUIW8';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { count, error } = await supabase
  .from('jobs')
  .select('*', { count: 'exact', head: true });

if (error) {
  console.error('Error:', error.message);
} else {
  console.log('✓ Total jobs in database:', count);
}

// Get sample jobs
const { data } = await supabase
  .from('jobs')
  .select('title,company_id')
  .limit(5);

if (data) {
  console.log('\nSample jobs:');
  data.forEach((j) => console.log('  -', j.title.slice(0, 60)));
}
