// Job sources (app.jobs.source = the company's ats_type = the scrape report source) and how the app names them.

// keep in sync: databricks/ats/registry.py LABELS (and ALL_SOURCES, the same names in the same order; pinned in
// sources.test.js, and against app.c_scrape_sources() in sql_constants.test.js)
export const SOURCE_LABELS = {
  workday: 'Workday',
  greenhouse: 'Greenhouse',
  linkedin: 'LinkedIn',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  oracle: 'Oracle Recruiting',
  successfactors: 'SAP SuccessFactors',
  darwinbox: 'Darwinbox',
  keka: 'Keka',
}

// Every scrape source, in the registry's order
export const SCRAPE_SOURCES = Object.keys(SOURCE_LABELS)

// Sources no schedule runs: LinkedIn is searched only when its workflow is started by hand (its jobs that someone saved
// or applied to stay; the others age out after 7 days)
export const MANUAL_SOURCES = ['linkedin']

// 'smartrecruiters' -> 'SmartRecruiters'; an unknown source is shown as it is
export function sourceLabel(source) {
  const key = String(source ?? '').trim().toLowerCase()
  return Object.hasOwn(SOURCE_LABELS, key) ? SOURCE_LABELS[key] : (source ?? '')
}
