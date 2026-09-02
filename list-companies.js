import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Fetch all companies
const { data, error } = await supabase.from('companies').select('id, name, ats_type, disabled')
if (error) {
  console.error('Error fetching companies:', error)
  process.exit(1)
}

console.log('Companies in database:')
data.forEach(c => {
  console.log(`  ${c.id} | ${c.name} | ${c.ats_type} | ${c.disabled ? 'DISABLED' : 'ENABLED'}`)
})
