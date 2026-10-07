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

// Filters edited in the panel (search box and quick chips live on the page).
export const PANEL_KEYS = ['role', 'category', 'source', 'company', 'location', 'city', 'workMode', 'employment', 'maxYears',
  'postedWithin', 'minFit']

// Hours. The pipeline removes untracked jobs posted more than 2 days ago, so longer windows only add tracked jobs.
export const POSTED_OPTIONS = [
  { value: '24', label: 'Last 24 hours' },
  { value: '48', label: 'Last 2 days' },
]

// Tabs: 'pending' (To apply, saved included), 'saved', 'applied' (any stage), 'all'
export const LIST_TABS = ['pending', 'saved', 'applied', 'all']
export const DEFAULT_TAB = 'pending'
// Saved and applied jobs are listed whatever their date on these tabs (the server ignores postedWithin for them)
export const TRACKED_TABS = ['saved', 'applied']

export const SORT_VALUES = ['fit', 'recent', 'found', 'applied']

// The sort a tab opens with until you pick another one
export function defaultSortFor(tab) {
  return tab === 'applied' ? 'applied' : 'fit'
}

export const SCOPES = ['match', 'all']
export const DEFAULT_SCOPE = 'match'
