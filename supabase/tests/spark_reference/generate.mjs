// Freezes the Databricks (Spark SQL) statements of the former Netlify Function for supabase/tests/parity.py.
//
//   node supabase/tests/spark_reference/generate.mjs              from netlify/functions/api/sql.mjs, else git HEAD
//   node supabase/tests/spark_reference/generate.mjs --rev 7cb4909  from that commit (after the function was deleted)
//
// Writes statements.json (one statement per (action, params) case, with its named parameters) and user_jobs.sql
// (USER_JOBS_CTE + the per-job score columns). Data-dependent filter values are placeholders ("__role__", ...) that
// parity.py replaces with real values from the facets, in the Spark parameters and the app params alike.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const revIndex = process.argv.indexOf('--rev')
const rev = revIndex > 0 ? process.argv[revIndex + 1] : null
const live = path.join(root, 'netlify/functions/api/sql.mjs')

let source
let origin
if (!rev && fs.existsSync(live)) {
  source = fs.readFileSync(live, 'utf8')
  origin = 'netlify/functions/api/sql.mjs (working tree)'
} else {
  const ref = rev || 'HEAD'
  source = execFileSync('git', ['show', `${ref}:netlify/functions/api/sql.mjs`], { cwd: root, encoding: 'utf8' })
  origin = `netlify/functions/api/sql.mjs at ${execFileSync('git', ['rev-parse', '--short', ref], { cwd: root, encoding: 'utf8' }).trim()}`
}
// The module imports its constants from src/utils (unchanged by the migration): point them at absolute file URLs
source = source.replace(/'\.\.\/\.\.\/\.\.\/src\/utils\/([\w.]+)'/g, (_, file) => `'${pathToFileURL(path.join(root, 'src/utils', file)).href}'`)
const temp = path.join(os.tmpdir(), `jobseeker-sql-reference-${process.pid}.mjs`)
fs.writeFileSync(temp, source)
const sql = await import(pathToFileURL(temp).href)
fs.unlinkSync(temp)

const USER = { id: '00000000-0000-4000-8000-000000000000', email: 'parity@jobseeker.test' }
const ALL = { scope: 'all', limit: 100 }
const cases = []
const add = (name, action, params) => cases.push({ name, action, params })

for (const scope of ['match', 'all']) {
  for (const sort of ['fit', 'recent', 'found']) add(`jobs ${scope} ${sort}`, 'jobs', { scope, sort, limit: 100 })
  for (const tab of ['applied', 'pending']) add(`jobs ${scope} tab ${tab}`, 'jobs', { scope, tab, limit: 100 })
  add(`summary ${scope}`, 'summary', { scope })
  add(`facets ${scope}`, 'facets', { scope })
  add(`trend ${scope}`, 'trend', { scope })
}
add('jobs page 2', 'jobs', { scope: 'all', limit: 20, offset: 20 })
add('jobs q', 'jobs', { ...ALL, q: '__q__' })
add('jobs role', 'jobs', { ...ALL, role: '__role__' })
add('jobs category', 'jobs', { ...ALL, category: '__category__' })
add('jobs source', 'jobs', { ...ALL, source: '__source__' })
add('jobs company', 'jobs', { ...ALL, company: '__company__' })
add('jobs location', 'jobs', { ...ALL, location: '__location__' })
add('jobs maxYears', 'jobs', { ...ALL, maxYears: 3 })
add('jobs postedWithin 24h', 'jobs', { ...ALL, postedWithin: 24 })
add('jobs postedWithin 7d', 'jobs', { ...ALL, postedWithin: 168 })
add('jobs minFit 50', 'jobs', { ...ALL, minFit: 50 })
add('jobs matchedOnly', 'jobs', { ...ALL, matchedOnly: true })
add('jobs combined', 'jobs', { scope: 'match', limit: 100, role: '__role__', minFit: 40, postedWithin: 168, sort: 'recent' })
add('summary role', 'summary', { scope: 'all', role: '__role__' })
add('summary postedWithin 24h', 'summary', { scope: 'all', postedWithin: 24 })
add('summary matchedOnly', 'summary', { scope: 'all', matchedOnly: true, maxYears: 5 })

const statements = cases.map(c => ({ ...c, ...sql.buildStatement(c.action, c.params, USER) }))
const jobs = sql.buildStatement('jobs', { scope: 'all' }, USER).statement
const cte = jobs.slice(0, jobs.indexOf('\nSELECT job_key, source,'))
if (!cte.startsWith('WITH role_map AS')) throw new Error('USER_JOBS_CTE not found in the jobs statement')
const userJobs = `${cte}
SELECT job_key, fit_score, fit_role, fit_skills, fit_experience, role_match, above_experience, fit_matched_skills, is_applied
FROM user_jobs
`

fs.writeFileSync(path.join(here, 'statements.json'), `${JSON.stringify({
  generated_from: origin,
  note: 'Frozen Spark SQL of the former Netlify Function (Databricks warehouse). :user_id is bound per profile by parity.py; __placeholders__ are replaced with real filter values.',
  placeholders: ['__q__', '__role__', '__category__', '__source__', '__company__', '__location__'],
  cases: statements,
}, null, 1)}\n`)
fs.writeFileSync(path.join(here, 'user_jobs.sql'), `-- Frozen from ${origin}: USER_JOBS_CTE + the score columns of every gold.jobs row for :user_id\n${userJobs}`)
console.log(`statements.json: ${statements.length} cases; user_jobs.sql written (${origin})`)
