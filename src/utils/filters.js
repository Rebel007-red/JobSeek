// Job list filters, tabs and sorts, shared by the jobs page, the filter panel and the URL (urlState.js).
// Every key is sent to app_read jobs / summary as is; empty values add no condition on the server.
export const EMPTY_FILTERS = {
  q: '',
  role: '',
  category: '',
  source: '',
  company: '',
  location: '',
  city: '',
  workMode: '',
  employment: '',
  maxYears: '',
  postedWithin: '',
  minFit: '',
  matchedOnly: false,
  myCities: false,
  closed: '',
  followUp: false,
  stage: '',
  muteView: '',
}

// What the dashboard starts with: only jobs from the last 24 hours (older ones are hidden until you widen it).
export const FRESH_HOURS = '24'
export const DEFAULT_FILTERS = { ...EMPTY_FILTERS, postedWithin: FRESH_HOURS }

// Filters edited in the panel (search box and quick chips live on the page; the time window lives in the scope menu).
export const PANEL_KEYS = ['role', 'category', 'source', 'company', 'location', 'city', 'workMode', 'employment', 'maxYears',
  'minFit']

// Hours. The pipeline removes untracked jobs posted more than 2 days ago, so longer windows only add tracked jobs.
export const POSTED_OPTIONS = [
  { value: '24', label: 'Last 24 hours' },
  { value: '48', label: 'Last 2 days' },
]

// Tabs, disjoint: 'inbox' (untracked: not saved, applied or hidden), 'saved', 'applied' (any stage). The old tabs
// 'pending' (To apply) and 'all' are read as 'inbox' (old links, remembered tabs).
export const LIST_TABS = ['inbox', 'saved', 'applied']
export const DEFAULT_TAB = 'inbox'
export const TAB_LABELS = { inbox: 'Inbox', saved: 'Saved', applied: 'Applied' }
const OLD_TABS = new Map([['pending', 'inbox'], ['all', 'inbox']])
// Saved and applied jobs are listed whatever their date on these tabs (the server ignores postedWithin for them)
export const TRACKED_TABS = ['saved', 'applied']

// A tab name from a URL or storage: one of LIST_TABS, or null
export function normalizeTab(tab) {
  if (LIST_TABS.includes(tab)) return tab
  return OLD_TABS.get(tab) ?? null
}

// 'expiring' ("Expiring first") is offered on the Inbox only (saved and applied jobs never expire)
export const SORT_VALUES = ['fit', 'recent', 'found', 'applied', 'expiring']
const INBOX_ONLY_SORTS = ['expiring']

// Whether a sort can be used on this tab
export function sortAllowed(sort, tab) {
  return SORT_VALUES.includes(sort) && (!INBOX_ONLY_SORTS.includes(sort) || tab === 'inbox')
}

// The sort a tab opens with until you pick another one
export function defaultSortFor(tab) {
  return tab === 'applied' ? 'applied' : 'fit'
}

export const SCOPES = ['match', 'all']
export const DEFAULT_SCOPE = 'match'
export const SCOPE_LABELS = { match: 'For you', all: 'Everything' }

// The scope menu ("Which jobs"): the scope and the time window are set together. These three are always offered; any
// other combination (from a URL) is shown as its own checked item.
export const SCOPE_PRESETS = [
  { scope: 'match', postedWithin: FRESH_HOURS },
  { scope: 'match', postedWithin: '' },
  { scope: 'all', postedWithin: '' },
]
const WINDOW_LABELS = new Map([['', 'any date'], ['24', 'last 24h'], ['48', 'last 2 days']])

// "For you · last 24h", "Everything · any date"
export function scopeLabel({ scope, postedWithin } = {}) {
  const key = String(postedWithin ?? '')
  const span = WINDOW_LABELS.get(key) ?? `last ${key}h`
  return `${SCOPE_LABELS[SCOPES.includes(scope) ? scope : DEFAULT_SCOPE]} · ${span}`
}

// The scope menu's items: [{ scope, postedWithin, label, checked }], the presets plus the current state when it is not one
export function scopeMenuItems(current = {}) {
  const now = { scope: SCOPES.includes(current.scope) ? current.scope : DEFAULT_SCOPE, postedWithin: String(current.postedWithin ?? '') }
  const same = (item) => item.scope === now.scope && item.postedWithin === now.postedWithin
  const items = SCOPE_PRESETS.some(same) ? SCOPE_PRESETS : [...SCOPE_PRESETS, now]
  return items.map(item => ({ ...item, label: scopeLabel(item), checked: same(item) }))
}
