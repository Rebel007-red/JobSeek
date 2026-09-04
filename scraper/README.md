# Scraper Directory

This directory will contain ATS job scraper implementations.

## Structure to Build

- `index.js` - Main orchestrator (routes to different ATS scrapers)
- `workday.js` - Workday ATS scraper
- `indeed.js` - Indeed job portal scraper
- `linkedin.js` - LinkedIn job scraper
- `skills-extractor.js` - Extract skills from job titles/descriptions
- `load-user-skills.js` - Load user skills from Supabase database

## Database Integration

Uses Supabase PostgreSQL:
- `companies` table - ATS company configs
- `jobs` table - Scraped job listings
- `user_skills` table - User skill preferences for filtering

## Getting Started

1. Create your scraper implementations
2. Export a function like: `export async function fetchWorkdayJobs(company) { ... }`
3. Update `index.js` to route and call your scrapers
4. Test with: `node --env-file=.env scraper/index.js`

## Dependencies

See `package.json` for installed packages. Key libraries:
- `@supabase/supabase-js` - Database client
- `playwright` - Browser automation (for Workday/dynamic sites)
- `node-html-parser` - HTML parsing
