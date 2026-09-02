import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Insert Greenhouse Databricks board company
const { data, error } = await supabase.from('companies').insert([
  {
    name: 'Databricks Greenhouse',
    ats_type: 'greenhouse',
    slug: 'databricks',
    api_url: 'https://boards-api.greenhouse.io/v1/boards/databricks/jobs?content=true',
    disabled: false,
  },
]).select('id')

if (error) {
  console.error('Error inserting company:', error)
  process.exit(1)
}

console.log('Inserted company:', data[0])
