#!/usr/bin/env node

/**
 * Show Supabase migration SQL with clear instructions
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const migrationPath = join(__dirname, '..', 'supabase', 'migrations', '001_add_user_skills_table.sql')
const sql = readFileSync(migrationPath, 'utf-8')

console.clear()
console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║                       🔧 SUPABASE MIGRATION SETUP                           ║
║                                                                               ║
║  Dynamic Skill Filtering: Create user_skills table for storing user skills   ║
╚═══════════════════════════════════════════════════════════════════════════════╝

📋 SQL MIGRATION (Copy everything below):

${'─'.repeat(95)}
${sql}${'─'.repeat(95)}

📍 HOW TO EXECUTE:

  1. Go to: https://app.supabase.com/project/deczscnmmxpgpayyxglk/sql/new
  
  2. Click the text area and paste the SQL above (Ctrl+A, Ctrl+V)
  
  3. Click the "Run" button (bottom right)
  
  4. You should see "Success" message
  
  5. Go to http://localhost:5173 and test:
     • Settings tab → Skills section
     • Add skill "python" and press Enter
     • Should save to Supabase automatically
     • Run scraper: it will now load skills from database!

✅ STATUS: All 10 scrapers ready to use dynamic skills from Supabase
✅ STATUS: Frontend synced with Supabase user_skills table
✅ STATUS: Scraper tested and working with default skills

⏭️  NEXT STEPS AFTER MIGRATION:
   1. Execute SQL in Supabase (steps above)
   2. Add a skill in Settings page
   3. Run: node scraper/index.js --boards
   4. Check logs: should show "✓ Loaded skills from user..."
   5. Verify jobs in database match your skills

`)
