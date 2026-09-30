import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
    'Copy .env.example to .env and fill in your Supabase project values.'
  )
}

// Read before the client consumes the URL hash: an invite / recovery link lands with #...&type=invite|recovery,
// an expired or used link with #error_description=...
const linkParams = new URLSearchParams(window.location.hash.slice(1))
let pendingLinkType = linkParams.get('type') || ''
export const authLinkError = linkParams.get('error_description') || ''

// Invite / recovery link type of this page load; cleared once the new password is saved
export function authLinkType() {
  return pendingLinkType
}

export function clearAuthLinkType() {
  pendingLinkType = ''
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
