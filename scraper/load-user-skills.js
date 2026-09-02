/**
 * Skill filtering utilities for job scrapers
 * 
 * Loads user skills from Supabase and provides combined skill keywords
 * for filtering high-quality jobs relevant to the user.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DEFAULT_SKILLS = ['databricks', 'pyspark', 'sql']  // User-preferred default
const CORE_SKILLS = ['pyspark', 'databricks', 'spark']   // Always included for quality

let supabaseClient = null

function getSupabase() {
  if (!supabaseClient && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  }
  return supabaseClient
}

/**
 * Load user's preferred skills from Supabase user_skills table
 * @param {string} userId - Authenticated user ID (optional for testing)
 * @returns {Promise<string[]>} Combined skills array for filtering
 */
export async function loadFilterSkills(userId = null) {
  const sb = getSupabase()
  if (!sb) {
    console.warn('⚠️  Supabase not configured. Using default skills:', DEFAULT_SKILLS)
    return DEFAULT_SKILLS
  }

  try {
    // If userId provided, fetch from database
    if (userId) {
      const { data, error } = await sb
        .from('user_skills')
        .select('skills')
        .eq('user_id', userId)
        .single()

      if (error) throw error
      const userSkills = data?.skills || DEFAULT_SKILLS
      
      // Combine: user skills + core skills (for better quality)
      const combined = Array.from(new Set([...userSkills, ...CORE_SKILLS]))
      console.log(`✓ Loaded skills from user ${userId}: ${combined.join(', ')}`)
      return combined
    } else {
      // No user ID provided — use defaults
      console.log(`✓ Using default skills (no user context): ${DEFAULT_SKILLS.join(', ')}`)
      return DEFAULT_SKILLS
    }
  } catch (err) {
    console.warn(`⚠️  Failed to load skills from Supabase: ${err.message}. Using defaults.`)
    return DEFAULT_SKILLS
  }
}

/**
 * Get default fallback skills if user has none
 * @returns {string[]} Default skills array
 */
export function getDefaultSkills() {
  return [...DEFAULT_SKILLS]
}

/**
 * Get core skills that are always included for quality
 * @returns {string[]} Core skills array
 */
export function getCoreSkills() {
  return [...CORE_SKILLS]
}
