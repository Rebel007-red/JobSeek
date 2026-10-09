// The job list's state in the URL: tab, sort, scope, filters, the open job (?job=) and the filter sheet (?sheet=filters).
// Values equal to what this device would open with anyway are left out, so a plain "/" stays plain; invalid values are
// dropped. parseListState(listStateToParams(state, remembered), remembered) gives the same state back. Old links keep
// working: tab=pending (To apply) and tab=all open the Inbox.
import { APPLIED_STATUSES, EMPLOYMENT_LABELS, WORK_MODE_LABELS } from './gold.js'
import {
  DEFAULT_FILTERS, DEFAULT_SCOPE, DEFAULT_TAB, FRESH_HOURS, POSTED_OPTIONS, SCOPES, defaultSortFor, normalizeTab, sortAllowed,
} from './filters.js'

const JOB_KEY_RE = /^[0-9a-f]{64}$/
// Text filters and their longest accepted value (the server cuts at the same lengths)
const TEXT_PARAMS = { q: 100, role: 100, category: 100, source: 100, company: 200, location: 100, city: 100 }
const CHOICES = {
  workMode: Object.keys(WORK_MODE_LABELS),
  employment: Object.keys(EMPLOYMENT_LABELS),
  stage: APPLIED_STATUSES,
  closed: ['only', 'hide'],
}
const RANGES = { maxYears: [0, 40], minFit: [1, 100] }
// Boolean filters, written as "<param>=1"
const FLAGS = { matchedOnly: 'skills', myCities: 'myCities', followUp: 'followUp' }
const POSTED_VALUES = new Set(POSTED_OPTIONS.map(option => option.value))
const SHEETS = ['filters']

export const isJobKey = (value) => typeof value === 'string' && JOB_KEY_RE.test(value)

// remembered: { tab, scope, postedWithin, sortFor(tab) } from viewPref (all optional); what a value left out of the URL
// means
function fallbacks(remembered = {}) {
  const tab = normalizeTab(remembered.tab) ?? DEFAULT_TAB
  const scope = SCOPES.includes(remembered.scope) ? remembered.scope : DEFAULT_SCOPE
  const span = String(remembered.postedWithin ?? FRESH_HOURS)
  const postedWithin = span === '' || POSTED_VALUES.has(span) ? span : FRESH_HOURS
  const sortFor = (forTab) => {
    const sort = remembered.sortFor?.(forTab)
    return sortAllowed(sort, forTab) ? sort : defaultSortFor(forTab)
  }
  return { tab, scope, postedWithin, sortFor }
}

function toParams(searchParams) {
  if (searchParams instanceof URLSearchParams) return searchParams
  return new URLSearchParams(searchParams || '')
}

function rangeValue(key, raw) {
  const [min, max] = RANGES[key]
  if (!/^\d{1,3}$/.test(raw ?? '')) return ''
  const value = Number(raw)
  return value >= min && value <= max ? String(value) : ''
}

// -> { tab, sort, scope, filters, jobKey, sheet }
export function parseListState(searchParams, remembered) {
  const params = toParams(searchParams)
  const base = fallbacks(remembered)
  const tab = normalizeTab(params.get('tab')) ?? base.tab
  const sort = sortAllowed(params.get('sort'), tab) ? params.get('sort') : base.sortFor(tab)
  const scope = SCOPES.includes(params.get('scope')) ? params.get('scope') : base.scope

  const filters = { ...DEFAULT_FILTERS }
  for (const [key, max] of Object.entries(TEXT_PARAMS)) {
    const value = params.get(key) ?? ''
    if (value.trim()) filters[key] = value.slice(0, max)
  }
  for (const [key, values] of Object.entries(CHOICES)) {
    if (values.includes(params.get(key))) filters[key] = params.get(key)
  }
  for (const key of Object.keys(RANGES)) filters[key] = rangeValue(key, params.get(key))
  const posted = params.get('posted')
  filters.postedWithin = posted === 'any' ? '' : POSTED_VALUES.has(posted) ? posted : base.postedWithin
  for (const [key, param] of Object.entries(FLAGS)) filters[key] = params.get(param) === '1'
  filters.muteView = params.get('muted') === 'only' ? 'only' : ''

  const jobKey = isJobKey(params.get('job')) ? params.get('job') : null
  const sheet = SHEETS.includes(params.get('sheet')) ? params.get('sheet') : null
  return { tab, sort, scope, filters, jobKey, sheet }
}

// -> URLSearchParams in a stable order; state may leave out filters, jobKey and sheet
export function listStateToParams(state, remembered) {
  const base = fallbacks(remembered)
  const params = new URLSearchParams()
  const filters = { ...DEFAULT_FILTERS, ...state?.filters }
  const tab = normalizeTab(state?.tab) ?? base.tab
  if (tab !== base.tab) params.set('tab', tab)
  if (sortAllowed(state?.sort, tab) && state.sort !== base.sortFor(tab)) params.set('sort', state.sort)
  if (SCOPES.includes(state?.scope) && state.scope !== base.scope) params.set('scope', state.scope)

  // Same order as the panel: text, choices, ranges
  const ordered = ['q', 'role', 'category', 'source', 'company', 'location', 'city', 'workMode', 'employment', 'maxYears',
    'minFit', 'stage', 'closed']
  for (const key of ordered) {
    const raw = filters[key] === null || filters[key] === undefined ? '' : String(filters[key])
    let value = ''
    if (key in TEXT_PARAMS) value = raw.trim() ? raw.slice(0, TEXT_PARAMS[key]) : ''
    else if (key in CHOICES) value = CHOICES[key].includes(raw) ? raw : ''
    else value = rangeValue(key, raw)
    if (value) params.set(key, value)
  }
  const posted = String(filters.postedWithin ?? '')
  if (posted !== base.postedWithin && (!posted || POSTED_VALUES.has(posted))) params.set('posted', posted || 'any')
  for (const [key, param] of Object.entries(FLAGS)) if (filters[key] === true) params.set(param, '1')
  if (filters.muteView === 'only') params.set('muted', 'only')

  if (isJobKey(state?.jobKey)) params.set('job', state.jobKey)
  if (SHEETS.includes(state?.sheet)) params.set('sheet', state.sheet)
  return params
}

// A link that opens this job in the app (the drawer's Share button)
export function jobLink(jobKey, origin = globalThis.location?.origin ?? '') {
  return `${origin}/?job=${encodeURIComponent(jobKey)}`
}
