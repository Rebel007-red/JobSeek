#!/usr/bin/env node

/**
 * Execute Supabase migration directly via PostgreSQL
 * Then run scraper
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { execSync } from 'child_process'
import pkg from 'pg'
const { Client } = pkg

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing env vars')
  process.exit(1)
}

// Extract PostgreSQL connection string from Supabase URL
// Format: https://xxxxx.supabase.co
const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]
if (!projectRef) {
  console.error('❌ Could not parse Supabase URL')
  process.exit(1)
}

async function executeMigration() {
  console.log('\n🔧 Running Supabase migration: Add user_skills table...\n')
  
  try {
    // Connect to Supabase PostgreSQL
    const client = new Client({
      host: `${projectRef}.db.supabase.co`,
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      password: SUPABASE_SERVICE_ROLE_KEY,
      ssl: { rejectUnauthorized: false },
    })
    
    await client.connect()
    console.log('✅ Connected to Supabase PostgreSQL\n')
    
    // Read and execute migration
    const migrationPath = join(__dirname, '..', 'supabase', 'migrations', '001_add_user_skills_table.sql')
    const sql = readFileSync(migrationPath, 'utf-8')
    
    console.log('📝 Executing migration SQL...\n')
    await client.query(sql)
    
    await client.end()
    console.log('✅ Migration completed successfully!\n')
    return true
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('ℹ️  Table already exists - that\'s fine!\n')
      return true
    }
    console.error('❌ Migration error:', err.message, '\n')
    return false
  }
}

async function runScraper() {
  console.log('🔄 Running scraper with dynamic skill loading...\n')
  
  try {
    const cwd = join(__dirname, '..')
    execSync('node scraper/index.js --boards', {
      cwd,
      env: process.env,
      stdio: 'inherit',
    })
    return true
  } catch (err) {
    return false
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗')
  console.log('║  🚀 Dynamic Skill Filtering - Full Setup                        ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝')
  
  // Run migration
  const migrationOk = await executeMigration()
  
  if (!migrationOk) {
    console.log('⚠️  Migration failed - continuing anyway...\n')
  }
  
  // Wait for DB
  console.log('⏳ Waiting for Supabase...')
  await new Promise(r => setTimeout(r, 2000))
  
  // Run scraper
  const scraperOk = await runScraper()
  
  console.log('\n╔══════════════════════════════════════════════════════════════════╗')
  if (scraperOk) {
    console.log('║  ✅ SUCCESS - Setup Complete!                                   ║')
    console.log('║                                                                  ║')
    console.log('║  Next steps:                                                    ║')
    console.log('║  1. Go to http://localhost:5173                                 ║')
    console.log('║  2. Settings tab → Skills section                               ║')
    console.log('║  3. Add a skill (e.g., "python")                                ║')
    console.log('║  4. Verify it saves and persists on refresh                     ║')
    console.log('║  5. Run scraper again to load skills from Supabase              ║')
  } else {
    console.log('║  ⚠️  Scraper had errors                                          ║')
  }
  console.log('╚══════════════════════════════════════════════════════════════════╝\n')
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
