#!/usr/bin/env node

/**
 * Execute Supabase migration: Add user_skills table
 * Then run scraper to test dynamic skill loading
 * 
 * Usage: node scripts/run-migration.js
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

async function runMigration() {
  console.log('🔧 Running Supabase migration: Add user_skills table...\n')
  
  try {
    // Read migration SQL
    const migrationPath = join(__dirname, '..', 'supabase', 'migrations', '001_add_user_skills_table.sql')
    const sql = readFileSync(migrationPath, 'utf-8')
    
    // Execute migration via Supabase admin API
    const { error } = await supabase.rpc('exec_sql', { sql_text: sql }).catch(err => {
      // If exec_sql RPC doesn't exist, we need to use a different approach
      // For now, log what we're trying to do
      return { error: err }
    })
    
    if (error) {
      // Fallback: Log instructions for manual execution
      console.log('⚠️  Could not execute via RPC. Here\'s the SQL to run manually:\n')
      console.log('─'.repeat(80))
      console.log(sql)
      console.log('─'.repeat(80))
      console.log('\n📍 Go to: https://app.supabase.com/')
      console.log('📍 Select your project → SQL Editor')
      console.log('📍 Paste the SQL above and click Run\n')
      return false
    }
    
    console.log('✅ Migration executed successfully!\n')
    return true
  } catch (err) {
    console.log('⚠️  Could not auto-execute migration. Here\'s the SQL:\n')
    try {
      const migrationPath = join(__dirname, '..', 'supabase', 'migrations', '001_add_user_skills_table.sql')
      const sql = readFileSync(migrationPath, 'utf-8')
      console.log('─'.repeat(80))
      console.log(sql)
      console.log('─'.repeat(80))
    } catch (readErr) {
      console.error('Error reading migration file:', readErr.message)
    }
    console.log('\n📍 Please execute the SQL above in Supabase SQL Editor manually')
    console.log('📍 Then run: node scripts/run-scraper.js\n')
    return false
  }
}

async function waitForUserConfirm() {
  return new Promise((resolve) => {
    console.log('⏳ Press Enter after running the migration in Supabase...')
    process.stdin.once('data', () => {
      resolve()
    })
  })
}

async function runScraper() {
  console.log('\n🔄 Running scraper with new skill loading...\n')
  
  try {
    const { spawn } = await import('child_process')
    
    return new Promise((resolve, reject) => {
      const proc = spawn('node', ['scraper/index.js', '--boards'], {
        cwd: join(__dirname, '..'),
        env: { ...process.env, NODE_OPTIONS: '--experimental-detect-module-unhandled-rejections' },
        stdio: 'inherit',
      })
      
      proc.on('close', (code) => {
        if (code === 0) {
          console.log('\n✅ Scraper completed successfully!')
          resolve(true)
        } else {
          console.log(`\n⚠️  Scraper exited with code ${code}`)
          resolve(false)
        }
      })
      
      proc.on('error', (err) => {
        console.error('Error running scraper:', err.message)
        reject(err)
      })
    })
  } catch (err) {
    console.error('Error spawning scraper:', err.message)
    return false
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗')
  console.log('║  Dynamic Skill Filtering - Migration & Test Setup              ║')
  console.log('╚════════════════════════════════════════════════════════════════╝\n')
  
  // Try to run migration
  const migrationOk = await runMigration()
  
  if (!migrationOk) {
    console.log('\n⚠️  Manual intervention needed. Instructions above.\n')
    process.exit(1)
  }
  
  // Wait a moment for DB to settle
  console.log('⏳ Waiting for database to settle...')
  await new Promise(resolve => setTimeout(resolve, 2000))
  
  // Run scraper
  const scraperOk = await runScraper()
  
  if (scraperOk) {
    console.log('\n╔════════════════════════════════════════════════════════════════╗')
    console.log('║  ✅ Setup Complete!                                            ║')
    console.log('║                                                                ║')
    console.log('║  Next steps:                                                   ║')
    console.log('║  1. Go to http://localhost:5173                               ║')
    console.log('║  2. Settings tab → Add a skill (e.g., "python")               ║')
    console.log('║  3. Verify it saves to Supabase                               ║')
    console.log('║  4. Run scraper again to see skills from Supabase loaded      ║')
    console.log('╚════════════════════════════════════════════════════════════════╝\n')
  } else {
    console.log('\n⚠️  Scraper had issues. Check logs above.\n')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
