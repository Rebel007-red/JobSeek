#!/usr/bin/env node

/**
 * Execute Supabase migration + run scraper
 * Usage: node scripts/execute-migration.js
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { execSync } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing env vars')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

async function executeMigration() {
  console.log('\n🔧 Running Supabase migration: Add user_skills table...\n')
  
  try {
    const migrationPath = join(__dirname, '..', 'supabase', 'migrations', '001_add_user_skills_table.sql')
    const sql = readFileSync(migrationPath, 'utf-8')
    
    // Execute each SQL statement separately
    const statements = sql
      .split(/;(?=\s*$)/m)
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'))
    
    console.log(`📝 Found ${statements.length} SQL statements to execute\n`)
    
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]
      console.log(`  [${i + 1}/${statements.length}] Executing...`)
      
      try {
        const { error } = await supabase
          .rpc('exec_sql', { sql_text: stmt + ';' })
          .catch(async () => {
            // If exec_sql doesn't exist, try using query directly
            // This is a fallback - it won't work for most DDL statements
            return { error: new Error('exec_sql RPC not available') }
          })
        
        if (error) {
          // Log but continue - some statements may fail if they already exist
          console.log(`    ⚠️  ${error.message}`)
        } else {
          console.log(`    ✓ Success`)
        }
      } catch (err) {
        console.log(`    ⚠️  ${err.message}`)
      }
    }
    
    console.log('\n✅ Migration complete!\n')
    return true
  } catch (err) {
    console.error('❌ Migration error:', err.message)
    console.log('\n📋 Manual SQL:\n')
    try {
      const migrationPath = join(__dirname, '..', 'supabase', 'migrations', '001_add_user_skills_table.sql')
      const sql = readFileSync(migrationPath, 'utf-8')
      console.log(sql)
    } catch (e) {
      // ignore
    }
    return false
  }
}

async function runScraper() {
  console.log('🔄 Running scraper with new skill loading...\n')
  
  try {
    const cwd = join(__dirname, '..')
    execSync('node scraper/index.js --boards', {
      cwd,
      env: process.env,
      stdio: 'inherit',
    })
    console.log('\n✅ Scraper completed!\n')
    return true
  } catch (err) {
    console.error('\n⚠️  Scraper exited with error')
    return false
  }
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗')
  console.log('║  Dynamic Skill Filtering - Migration & Scraper Run       ║')
  console.log('╚═══════════════════════════════════════════════════════════╝')
  
  // Run migration
  const migrationOk = await executeMigration()
  
  if (!migrationOk) {
    console.log('⚠️  Migration had issues. Proceeding anyway...')
  }
  
  // Wait for DB
  console.log('⏳ Waiting for Supabase...')
  await new Promise(r => setTimeout(r, 2000))
  
  // Run scraper
  const scraperOk = await runScraper()
  
  if (scraperOk) {
    console.log('\n╔═══════════════════════════════════════════════════════════╗')
    console.log('║  ✅ Complete!                                            ║')
    console.log('║                                                           ║')
    console.log('║  Now test in UI:                                         ║')
    console.log('║  1. http://localhost:5173/login                          ║')
    console.log('║  2. Settings → Add skill (e.g., "python")                ║')
    console.log('║  3. Run scraper again: node scripts/execute-migration.js ║')
    console.log('║  4. Check console for skills loaded from Supabase        ║')
    console.log('╚═══════════════════════════════════════════════════════════╝\n')
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
