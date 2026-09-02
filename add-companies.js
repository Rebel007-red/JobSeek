import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Insert missing companies
const { data, error } = await sb.from('companies').insert([
  {
    id: '00000001-0000-0000-0000-000000000004',
    name: 'Accenture',
    ats_type: 'workday',
    api_url: 'https://accenture.wd103.myworkdayjobs.com/wday/cxs/accenture/AccentureCareers/jobs',
    slug: 'accenture',
    disabled: false
  },
  {
    id: '00000001-0000-0000-0000-000000000005',
    name: 'Medpace',
    ats_type: 'medpace',
    api_url: '',
    slug: 'medpace',
    disabled: false
  }
], { ignoreDuplicates: true })

console.log(error ? '❌ ' + error.message : '✅ Companies added: ' + (data?.length || 0))
