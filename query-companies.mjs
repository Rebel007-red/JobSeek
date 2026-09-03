import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://deczscnmmxpgpayyxglk.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlY3pzY25tbXhwZ3BheXl4Z2xrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODEzMzQ3NywiZXhwIjoyMTAzNzA5NDc3fQ.zp1V1NJuT-6f_cKFty5BXNLSwVqiCqEYGeEPMAxUIW8';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await supabase
  .from('companies')
  .select('id,name,ats_type')
  .order('name');

if (error) {
  console.error('Error:', error);
} else {
  console.log('Companies in database:');
  data.forEach((c) => {
    const id = c.id;
    const name = (c.name || '').padEnd(30);
    console.log(`  ${id} | ${name} | ${c.ats_type}`);
  });
}
