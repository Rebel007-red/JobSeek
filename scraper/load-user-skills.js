/**
 * Skill filtering utilities for job scrapers
 * 
 * Loads user skills from Supabase and provides combined skill keywords
 * for filtering high-quality jobs relevant to the user.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
// Default skills - broad keywords that match most relevant jobs
const DEFAULT_SKILLS = [
  // Data & Analytics
  'data', 'analytics', 'sql', 'python', 'pandas', 'spark', 'pyspark', 'databricks',
  // Engineering
  'engineer', 'developer', 'java', 'javascript', 'typescript', 'go', 'rust', 'nodejs',
  // Cloud & DevOps
  'aws', 'azure', 'gcp', 'cloud', 'kubernetes', 'docker', 'devops',
  // AI/ML
  'machine learning', 'ai', 'deep learning', 'tensorflow', 'pytorch',
  // General
  'software', 'senior', 'lead', 'architect', 'manager', 'analyst',
]
const CORE_SKILLS = ['data', 'engineer', 'developer', 'python', 'sql']   // Always included

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
 * Fetches skills that users have added in the Settings > Skills UI
 * @param {string} userId - Authenticated user ID (optional for specific user)
 * @returns {Promise<string[]>} User skills array for filtering
 */
export async function loadFilterSkills(userId = null) {
  const sb = getSupabase()
  if (!sb) {
    console.warn('⚠️  Supabase not configured. Using default skills:', DEFAULT_SKILLS)
    return DEFAULT_SKILLS
  }

  try {
    // Try to fetch user skills from database
    let query = sb.from('user_skills').select('user_id, skills')
    
    // If specific user provided, fetch only their skills
    if (userId) {
      query = query.eq('user_id', userId)
    }
    
    const { data, error } = await query
    
    if (error) {
      console.warn(`⚠️  Failed to query user_skills: ${error.message}`)
      console.log(`✓ Using default skills: ${DEFAULT_SKILLS.join(', ')}`)
      return DEFAULT_SKILLS
    }
    
    // If user skills found in database, use them
    if (data && data.length > 0) {
      // If specific user was requested, use their skills
      if (userId) {
        const userSkills = data[0]?.skills || []
        if (userSkills.length > 0) {
          const combined = Array.from(new Set([...userSkills, ...CORE_SKILLS]))
          console.log(`✓ Loaded ${userSkills.length} skills from user ${userId}: ${combined.join(', ')}`)
          return combined
        }
      } else {
        // No specific user - combine all user skills from database
        const allSkills = new Set()
        for (const row of data) {
          if (row.skills && Array.isArray(row.skills)) {
            row.skills.forEach(s => allSkills.add(s))
          }
        }
        allSkills.forEach(s => CORE_SKILLS.forEach(cs => allSkills.add(cs)))
        
        if (allSkills.size > 0) {
          const skillsArray = Array.from(allSkills)
          console.log(`✓ Loaded ${skillsArray.length} skills from ${data.length} user(s) in DB: ${skillsArray.join(', ')}`)
          return skillsArray
        }
      }
    }
    
    // No user skills in database, use defaults
    console.log(`✓ No user skills in database. Using default skills: ${DEFAULT_SKILLS.join(', ')}`)
    return DEFAULT_SKILLS
    
  } catch (err) {
    console.warn(`⚠️  Error loading skills: ${err.message}. Using defaults.`)
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
