import { useEffect, useId, useState } from 'react'
import { api } from '../../lib/api'
import { supabase } from '../../lib/supabase'
import { SearchIcon } from '../common/icons'

// Only these types have a scraper (databricks/workday.py, greenhouse.py, linkedin.py). Rows of other types (added
// before) show "not scraped" and can still be paused or deleted.
const SCRAPED_TYPES = ['workday', 'greenhouse', 'linkedin']
const ATS_LABELS = { workday: 'Workday', greenhouse: 'Greenhouse', linkedin: 'LinkedIn search' }
const atsLabel = (type) => ATS_LABELS[type] || type

// The one field each scraped type needs; parse(value) -> the columns to save ({ api_url }, plus slug for Greenhouse),
// or { error }
const SOURCE_FIELDS = {
  workday: {
    label: 'Workday jobs URL',
    placeholder: 'https://company.wd1.myworkdayjobs.com/en-US/Careers',
    help: 'The careers page on myworkdayjobs.com (or myworkdaysite.com) that lists the jobs (the scraper opens it like a browser).',
    type: 'url',
    // slug is left as it is (workday.py reads only api_url)
    parse: (value) => (workdayUrlOk(value)
      ? { api_url: value }
      : { error: 'Paste the https:// link of the Workday jobs page, e.g. https://company.wd1.myworkdayjobs.com/en-US/Careers' }),
  },
  greenhouse: {
    label: 'Greenhouse board',
    placeholder: 'https://job-boards.greenhouse.io/stripe',
    help: 'The board link, its API URL or just the board token (stripe).',
    type: 'text',
    parse: (value) => {
      const token = greenhouseBoardToken(value)
      return token
        ? { slug: token, api_url: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs` }
        : { error: 'Paste the Greenhouse board link, e.g. https://job-boards.greenhouse.io/stripe' }
    },
  },
  linkedin: {
    label: 'Search keywords',
    placeholder: 'e.g. Databricks',
    help: 'Searched India-wide every 4 hours, newest first',
    type: 'text',
    parse: (value) => (value.length >= 2 && value.length <= 100
      ? { api_url: value }
      : { error: 'Search keywords: 2 to 100 characters' }),
  },
}

// Board token of a Greenhouse board URL (job-boards.greenhouse.io/stripe[/jobs/<id>], boards.greenhouse.io/stripe,
// the embed link with ?for=stripe), an API URL (boards-api.greenhouse.io/v1/boards/stripe/jobs) or a bare token;
// null when the value is none of these. keep in sync: board_token() in databricks/greenhouse.py
const BOARD_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

function greenhouseBoardToken(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const bare = value.replace(/^\/+|\/+$/g, '')
  if (BOARD_TOKEN_RE.test(bare)) return bare
  let url
  try {
    url = new URL(value.includes('://') ? value : `https://${value.replace(/^\/+/, '')}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'greenhouse.io' && !host.endsWith('.greenhouse.io')) return null
  const parts = url.pathname.split('/').filter(Boolean)
  const first = (parts[0] || '').toLowerCase()
  let token
  if (first === 'v1') token = parts.length >= 3 && parts[1].toLowerCase() === 'boards' ? parts[2] : ''
  else if (first === 'embed') token = url.searchParams.get('for') || ''
  else token = parts[0] || ''
  return BOARD_TOKEN_RE.test(token) ? token : null
}

// Workday hosts its career sites on myworkdayjobs.com and, for some tenants, myworkdaysite.com (two rows use it)
const WORKDAY_HOSTS = ['myworkdayjobs.com', 'myworkdaysite.com']

function workdayUrlOk(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && WORKDAY_HOSTS.some(base => host === base || host.endsWith(`.${base}`))
  } catch {
    return false
  }
}

// What makes two rows of one type the same source: the board token for Greenhouse, else the URL / keywords
const normalise = (value) => String(value ?? '').trim().toLowerCase().replace(/\/+$/, '')
function sourceKey(company) {
  if (company.ats_type === 'greenhouse') return normalise(greenhouseBoardToken(company.slug) || greenhouseBoardToken(company.api_url))
  return normalise(company.api_url) || normalise(company.slug)
}

// The value shown in (and edited back from) the source field of a row
function sourceValue(company) {
  if (company.ats_type === 'greenhouse') return company.slug || company.api_url || ''
  return company.api_url || company.slug || ''
}

const EMPTY_FORM = { name: '', ats_type: 'workday', source: '' }
const DAY_MS = 24 * 3600 * 1000
const HEALTH_DAYS = 7 // without a scrape result: Live when a job was found this recently
const SCRAPE_STALE_DAYS = 2 // a source not scraped for longer shows "Not scraped"
const UNKNOWN_HEALTH = { label: 'No data', tone: 'pending', title: 'No scrape result or job yet' }
const NO_CHANGE = 'nothing was changed (the row may be gone, or this account is not an admin)'

const daysSince = (value) => (Date.now() - new Date(value).getTime()) / DAY_MS
const whenText = (value) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// api.companyHealth() rows: { company: lower(name), source, latest_first_seen, last_scraped_at, last_ok_at,
// jobs_found, last_error, failures }. The scrape result of the same ATS wins; else the newest job of any source.
function companyHealth(company, rows) {
  if (company.disabled) return { label: 'Paused', tone: 'muted', title: 'Not scraped while paused' }
  const name = String(company.name || '').trim().toLowerCase()
  const same = rows.filter(row => row.company === name)
  const scrape = same.find(row => row.source === company.ats_type && row.last_scraped_at)
  if (scrape) {
    if (Number(scrape.failures) > 0) {
      const runs = Number(scrape.failures) === 1 ? 'the last scrape' : `the last ${scrape.failures} scrapes`
      return { label: 'Failing', tone: 'danger', title: `${scrape.last_error || 'Scrape failed'} (${runs})` }
    }
    if (daysSince(scrape.last_scraped_at) > SCRAPE_STALE_DAYS) {
      return { label: 'Not scraped', tone: 'warning', title: `Last scraped ${whenText(scrape.last_scraped_at)}` }
    }
    if (Number(scrape.jobs_found) === 0) return { label: 'No openings', tone: 'muted', title: `No jobs found ${whenText(scrape.last_scraped_at)}` }
    return { label: 'Live', tone: 'success', title: `${scrape.jobs_found ?? 'Some'} jobs found ${whenText(scrape.last_scraped_at)}` }
  }
  const pick = same.find(row => row.source === company.ats_type && row.latest_first_seen) || same.reduce(
    (best, row) => (row.latest_first_seen && (!best || String(row.latest_first_seen) > String(best.latest_first_seen)) ? row : best),
    null,
  )
  const latest = pick?.latest_first_seen
  if (!latest) return UNKNOWN_HEALTH
  return daysSince(latest) <= HEALTH_DAYS
    ? { label: 'Live', tone: 'success', title: `Newest job found ${whenText(latest)}` }
    : { label: 'Stale', tone: 'warning', title: `No new job since ${whenText(latest)}` }
}

// Scraper sources (admin only; Supabase RLS enforces the same rule). Renders nothing while visible is false.
export function CompaniesPanel({ visible }) {
  const [companies, setCompanies] = useState([])
  const [healthRows, setHealthRows] = useState([]) // api.companyHealth() rows
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [listError, setListError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null) // { id, name, source, error, saving }
  const ids = useId()

  useEffect(() => {
    loadCompanies()
  }, [])

  async function loadCompanies() {
    setLoading(true)
    setLoadError('')
    const { data, error } = await supabase.from('companies').select('*').order('name')
    if (error) setLoadError(error.message)
    setCompanies(data || [])

    // One query for every company's latest scrape result and newest job
    const rows = await api.companyHealth().catch((err) => {
      console.error('Failed to load company health:', err)
      return []
    })
    setHealthRows(rows)
    setLoading(false)
  }

  // '' when name and source are fine for a new row (or for row `self` being edited), else the message
  function problemFor({ name, ats_type: type, source }, self = null) {
    if (!name) return 'Company name is required'
    const others = companies.filter(c => c.id !== self?.id)
    if (others.some(c => c.name.trim().toLowerCase() === name.toLowerCase())) return `A company named "${name}" already exists`
    const field = SOURCE_FIELDS[type]
    if (!field) return ''
    if (!source) return `${field.label} is required`
    const parsed = field.parse(source)
    if (parsed.error) return parsed.error
    const key = sourceKey({ ats_type: type, ...parsed })
    const twin = others.find(c => c.ats_type === type && key && sourceKey(c) === key)
    return twin ? `Already added as "${twin.name}"` : ''
  }

  const insertError = (error) => (error.code === '23505' ? `A company named "${form.name.trim()}" already exists` : `Failed to add company: ${error.message}`)

  async function saveCompany(e) {
    e.preventDefault()
    const draft = { name: form.name.trim(), ats_type: form.ats_type, source: form.source.trim() }
    const problem = problemFor(draft)
    if (problem) return setFormError(problem)
    setFormError('')
    setSaving(true)
    const { error, data } = await supabase.from('companies').insert([{
      name: draft.name,
      ats_type: draft.ats_type,
      ...SOURCE_FIELDS[draft.ats_type].parse(draft.source),
      disabled: false,
    }]).select()
    setSaving(false)

    if (error) {
      console.error('Company insert error:', error)
      return setFormError(insertError(error))
    }
    if (!data || data.length === 0) return setFormError('Company was not created (unexpected response)')

    setForm(EMPTY_FORM)
    setShowForm(false)
    setCompanies(prev => [...prev, ...data].sort((a, b) => a.name.localeCompare(b.name)))
  }

  // Optimistic: the screen changes first and goes back (with the reason) when Supabase refuses or changes no row
  const replaceRow = (row) => setCompanies(prev => prev.map(c => (c.id === row.id ? row : c)))

  async function toggleDisabled(company) {
    const next = { ...company, disabled: !company.disabled }
    setListError('')
    replaceRow(next)
    const { data, error } = await supabase.from('companies').update({ disabled: next.disabled }).eq('id', company.id).select('id')
    if (error || !data?.length) {
      replaceRow(company)
      setListError(`Could not ${next.disabled ? 'pause' : 'resume'} "${company.name}": ${error?.message || NO_CHANGE}`)
    }
  }

  async function deleteCompany(company) {
    if (!confirm(`Delete "${company.name}"? It will no longer be scraped; jobs already found stay until they expire.`)) return
    setListError('')
    setCompanies(prev => prev.filter(c => c.id !== company.id))
    const { data, error } = await supabase.from('companies').delete().eq('id', company.id).select('id')
    if (error || !data?.length) {
      setCompanies(prev => [...prev.filter(c => c.id !== company.id), company].sort((a, b) => a.name.localeCompare(b.name)))
      setListError(`Could not delete "${company.name}": ${error?.message || NO_CHANGE}`)
    }
  }

  const startEdit = (company) => setEditing({ id: company.id, name: company.name, source: sourceValue(company), error: '', saving: false })

  async function saveEdit(e, company) {
    e.preventDefault()
    const draft = { name: editing.name.trim(), ats_type: company.ats_type, source: editing.source.trim() }
    const problem = problemFor(draft, company)
    if (problem) return setEditing(prev => ({ ...prev, error: problem }))
    const field = SOURCE_FIELDS[company.ats_type]
    const patch = { name: draft.name, ...(field ? field.parse(draft.source) : {}) }
    setEditing(null)
    setListError('')
    replaceRow({ ...company, ...patch })
    const { data, error } = await supabase.from('companies').update(patch).eq('id', company.id).select()
    if (error || !data?.length) {
      replaceRow(company)
      const reason = error?.code === '23505' ? `a company named "${draft.name}" already exists` : (error?.message || NO_CHANGE)
      setListError(`Could not save "${company.name}": ${reason}`)
      return
    }
    replaceRow(data[0])
  }

  if (!visible) return null

  const field = SOURCE_FIELDS[form.ats_type]
  const needle = search.trim().toLowerCase()
  const shown = needle
    ? companies.filter(c => [c.name, c.ats_type, atsLabel(c.ats_type), c.slug, c.api_url].some(v => String(v ?? '').toLowerCase().includes(needle)))
    : companies
  const failing = companies.filter(c => companyHealth(c, healthRows).label === 'Failing').length

  return (
    <div className="settings-panel settings-panel-animate">
      <div className="settings-summary-row">
        <p>
          LinkedIn searches run every 4 hours. Workday and Greenhouse are scraped twice a day (07:37 and 19:37 IST);
          their jobs appear after the next LinkedIn run.
        </p>
        <button
          type="button"
          onClick={() => { setShowForm(true); setForm(EMPTY_FORM); setFormError('') }}
          className="primary-button"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add company
        </button>
      </div>

      {showForm && (
        <form onSubmit={saveCompany} className="settings-card settings-form-panel" noValidate>
          <div className="settings-card-header">
            <h3>Add a company</h3>
          </div>

          <div className="settings-form-grid">
            <div className="settings-field">
              <label htmlFor={`${ids}-name`}>Company name</label>
              <input id={`${ids}-name`} type="text" required value={form.name}
                onChange={e => { setForm(f => ({ ...f, name: e.target.value })); setFormError('') }}
                placeholder="e.g. Stripe, Acme Corp"
                className="settings-input" />
            </div>

            <div className="settings-field">
              <label htmlFor={`${ids}-type`}>Source type</label>
              <select id={`${ids}-type`} value={form.ats_type}
                onChange={e => { setForm(f => ({ ...f, ats_type: e.target.value, source: '' })); setFormError('') }}
                className="settings-input settings-select">
                {SCRAPED_TYPES.map(t => <option key={t} value={t}>{atsLabel(t)}</option>)}
              </select>
            </div>

            {field && (
              <div className="settings-field settings-field-full">
                <label htmlFor={`${ids}-source`}>{field.label}</label>
                <input id={`${ids}-source`} type={field.type} required value={form.source}
                  onChange={e => { setForm(f => ({ ...f, source: e.target.value })); setFormError('') }}
                  placeholder={field.placeholder}
                  aria-describedby={`${ids}-source-help`}
                  className="settings-input" />
                <small id={`${ids}-source-help`}>{field.help}</small>
              </div>
            )}
          </div>

          {formError && <p className="settings-form-error" role="alert">{formError}</p>}

          <div className="settings-actions-row">
            <button type="button" onClick={() => { setShowForm(false); setFormError('') }} className="secondary-button">
              Cancel
            </button>
            <button type="submit" disabled={saving || !form.name.trim()} className="primary-button">
              {saving ? 'Adding…' : 'Add company'}
            </button>
          </div>
        </form>
      )}

      {listError && <p className="settings-form-error" role="alert">{listError}</p>}

      {loading ? (
        <div className="settings-empty-state">Loading…</div>
      ) : loadError ? (
        <div className="settings-card">
          <p className="settings-form-error">Could not load the companies: {loadError}</p>
          <div className="settings-actions-row">
            <button type="button" onClick={loadCompanies} className="secondary-button compact-button">Retry</button>
          </div>
        </div>
      ) : companies.length === 0 ? (
        <div className="settings-empty-state">No companies yet. Add one above.</div>
      ) : (
        <div className="settings-card settings-list-card">
          <div className="settings-list-head">
            <span>Company list{failing > 0 && <span className="settings-head-warn"> · {failing} failing</span>}</span>
            <strong>{needle ? `${shown.length} of ${companies.length}` : companies.length}</strong>
          </div>

          <div className="settings-search">
            <SearchIcon />
            <label htmlFor={`${ids}-search`} className="sr-only">Search companies</label>
            <input
              id={`${ids}-search`}
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, type or URL"
              className="settings-input"
            />
          </div>

          <div className="settings-list">
            {shown.length === 0 && <div className="settings-empty-state inline-empty">No company matches &ldquo;{search.trim()}&rdquo;.</div>}
            {shown.map(company => {
              const status = companyHealth(company, healthRows)
              const scraped = SCRAPED_TYPES.includes(company.ats_type)
              const rowField = SOURCE_FIELDS[company.ats_type]

              if (editing?.id === company.id) {
                return (
                  <form key={company.id} className="settings-row company-edit-row" onSubmit={e => saveEdit(e, company)} noValidate>
                    <div className="company-edit-fields">
                      <div className="settings-field">
                        <label htmlFor={`${ids}-edit-name`}>Company name</label>
                        <input id={`${ids}-edit-name`} type="text" value={editing.name} autoFocus
                          onChange={e => setEditing(prev => ({ ...prev, name: e.target.value, error: '' }))}
                          className="settings-input" />
                      </div>
                      {rowField && (
                        <div className="settings-field">
                          <label htmlFor={`${ids}-edit-source`}>{rowField.label}</label>
                          <input id={`${ids}-edit-source`} type={rowField.type} value={editing.source}
                            onChange={e => setEditing(prev => ({ ...prev, source: e.target.value, error: '' }))}
                            placeholder={rowField.placeholder}
                            className="settings-input" />
                        </div>
                      )}
                      {editing.error && <p className="settings-inline-error" role="alert">{editing.error}</p>}
                    </div>
                    <div className="settings-row-actions">
                      <button type="button" className="secondary-button compact-button" onClick={() => setEditing(null)}>Cancel</button>
                      <button type="submit" className="primary-button compact-button">Save</button>
                    </div>
                  </form>
                )
              }

              return (
                <div key={company.id} className={`settings-row ${company.disabled ? 'muted' : ''}`}>
                  <div className="settings-row-main">
                    <div className="settings-company-name">{company.name}</div>
                    <div className="settings-company-meta">
                      <span className="settings-chip">{atsLabel(company.ats_type)}</span>
                      {!scraped && <span className="settings-chip not-scraped" title="This type has no scraper">not scraped</span>}
                      {sourceValue(company)
                        ? <span title={sourceValue(company)}>{company.ats_type === 'linkedin' ? `“${sourceValue(company)}”` : sourceValue(company)}</span>
                        : <span>details pending</span>}
                      <span className={`company-health ${status.tone}`} title={status.title}>{status.label}</span>
                    </div>
                  </div>

                  <div className="settings-row-actions">
                    <button
                      type="button"
                      onClick={() => toggleDisabled(company)}
                      className={`status-pill ${company.disabled ? 'off' : 'on'}`}
                      aria-pressed={!company.disabled}
                      title={company.disabled ? `Resume scraping ${company.name}` : `Pause scraping ${company.name}`}
                    >
                      {company.disabled ? 'Paused' : 'Enabled'}
                    </button>
                    <button type="button" onClick={() => startEdit(company)} className="text-button" aria-label={`Edit ${company.name}`}>Edit</button>
                    <button type="button" onClick={() => deleteCompany(company)} className="trash-button" aria-label={`Delete ${company.name}`} title="Delete">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
