import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { 
  auth: { persistSession: false } 
})

async function clearJobs() {
  console.log('Clearing all jobs from database...')
  const { data, error } = await sb.from('jobs').delete().gt('id', '00000000-0000-0000-0000-000000000000')
  if (error) {
    console.error('Error:', error.message)
    process.exit(1)
  } else {
    console.log('✅ All jobs deleted. Database is now empty and ready for fresh data.')
  }
}

clearJobs()
