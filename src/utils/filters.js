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
  // The Applied tab's "Needs action" chip (app.user_jobs action_rank > 0). The Finished fold's stageGroup is not a
  // filter: the page adds it to its requests.
  needsAction: false,
  muteView: '',
}

// What the Inbox starts with: '' = no time window, i.e. every live job. Untracked jobs live 7 days (the pipeline deletes
// them after JOB_DELETE_AFTER_DAYS, src/utils/job.js), so this is "the last 7 days"; the "new since your last visit"
// marker shows what arrived since. The name is kept from when the default was the last 24 hours.
export const FRESH_HOURS = ''
export const DEFAULT_FILTERS = { ...EMPTY_FILTERS, postedWithin: FRESH_HOURS }

// Filters edited in the panel (search box and quick chips live on the page; the time window lives in the scope menu).
export const PANEL_KEYS = ['role', 'category', 'source', 'company', 'location', 'city', 'workMode', 'employment', 'maxYears',
  'minFit']

// Hours; '' = no window. The pipeline removes untracked jobs posted more than 7 days ago, so '' is the last 7 days. Any
// other value (an old link's or this device's remembered '48') falls back to the default.
export const POSTED_OPTIONS = [
  { value: '24', label: 'Last 24 hours' },
  { value: '72', label: 'Last 3 days' },
  { value: '', label: 'Last 7 days' },
]
// The windows that are a number of hours (POSTED_OPTIONS without '')
export const POSTED_HOURS = POSTED_OPTIONS.map(option => option.value).filter(Boolean)

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

// 'expiring' ("Expiring first") is offered on the Inbox only (saved and applied jobs never expire); 'action' ("Needs
// action first": follow-up dates that came, then stale interviews, then applications with no reply) on Applied only
export const SORT_VALUES = ['fit', 'recent', 'found', 'applied', 'expiring', 'action']
const TAB_ONLY_SORTS = { expiring: 'inbox', action: 'applied' }

// Whether a sort can be used on this tab
export function sortAllowed(sort, tab) {
  return SORT_VALUES.includes(sort) && (!TAB_ONLY_SORTS[sort] || TAB_ONLY_SORTS[sort] === tab)
}

// The sort a tab opens with until you pick another one: the Applied tab is a tracker, so what needs you comes first
export function defaultSortFor(tab) {
  return tab === 'applied' ? 'action' : 'fit'
}

export const SCOPES = ['match', 'all']
export const DEFAULT_SCOPE = 'match'
export const SCOPE_LABELS = { match: 'For you', all: 'Everything' }

// The scope menu ("Which jobs"): the scope and the time window are set together. These four are always offered; any
// other combination (from a URL) is shown as its own checked item.
export const SCOPE_PRESETS = [
  { scope: 'match', postedWithin: '' },
  { scope: 'match', postedWithin: '72' },
  { scope: 'match', postedWithin: '24' },
  { scope: 'all', postedWithin: '' },
]
const WINDOW_LABELS = new Map([['', 'last 7 days'], ['72', 'last 3 days'], ['24', 'last 24h']])

// "For you · last 24h", "Everything · last 7 days"
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
