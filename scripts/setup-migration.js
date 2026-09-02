#!/usr/bin/env node

/**
 * Display migration SQL and guide user to execute it in Supabase
 * Then run scraper
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { execSync } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function displayMigration() {
  console.clear()
  console.log('\n╔══════════════════════════════════════════════════════════════════╗')
  console.log('║  🔧 Supabase Migration: Add user_skills Table                   ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝\n')
  
  const migrationPath = join(__dirname, '..', 'supabase', 'migrations', '001_add_user_skills_table.sql')
  const sql = readFileSync(migrationPath, 'utf-8')
  
  console.log('📋 SQL to execute:\n')
  console.log('─'.repeat(75))
  console.log(sql)
  console.log('─'.repeat(75))
  
  console.log('\n📍 STEPS:\n')
  console.log('1️⃣  Open: https://app.supabase.com/project/deczscnmmxpgpayyxglk/sql/new')
  console.log('2️⃣  Copy the SQL above (Ctrl+A to select all)')
  console.log('3️⃣  Paste into Supabase SQL Editor')
  console.log('4️⃣  Click "Run" button')
  console.log('5️⃣  Wait for success message')
  console.log('6️⃣  Press Enter here to continue with scraper...\n')
  
  // Wait for user
  return new Promise((resolve) => {
    process.stdin.once('data', () => {
      resolve()
    })
  })
}

async function runScraper() {
  console.clear()
  console.log('\n╔══════════════════════════════════════════════════════════════════╗')
  console.log('║  🔄 Running Scraper with Dynamic Skill Loading...              ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝\n')
  
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
  // Display migration SQL
  await displayMigration()
  
  // Run scraper
  const ok = await runScraper()
  
  console.log('\n╔══════════════════════════════════════════════════════════════════╗')
  if (ok) {
    console.log('║  ✅ SUCCESS!                                                     ║')
    console.log('║                                                                  ║')
    console.log('║  Next: Go to http://localhost:5173                              ║')
    console.log('║  • Settings → Add a skill (e.g., "python")                      ║')
    console.log('║  • Refresh Jobs page to see skill match scores                  ║')
  } else {
    console.log('║  ⚠️  Scraper had errors. Check output above.                    ║')
  }
  console.log('╚══════════════════════════════════════════════════════════════════╝\n')
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
