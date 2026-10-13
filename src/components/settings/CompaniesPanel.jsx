import { useEffect, useId, useState } from 'react'
import { api } from '../../lib/api'
import { supabase } from '../../lib/supabase'
import { SearchIcon } from '../common/icons'
import { ATS_FIELDS, ATS_TYPES, describeSource, parseAtsSource, sourceKey, sourceValue } from '../../utils/atsSources'
import { MANUAL_SOURCES, sourceLabel } from '../../utils/sources'

// Every type with a scraper (databricks/workday.py, greenhouse.py, linkedin.py and databricks/ats_scrape.py for the
// others). Rows of other types (added before) show "not scraped" and can still be paused or deleted. The field, its help
// and the link -> columns parsers live in utils/atsSources.js (pinned to the scrapers' url_cases.json).
const SCRAPED_TYPES = ATS_TYPES
const BOARD_TYPES = ATS_TYPES.filter(type => !MANUAL_SOURCES.includes(type))
// LinkedIn rows are search keywords, not a company board
const atsLabel = (type) => (type === 'linkedin' ? 'LinkedIn search' : sourceLabel(type))

// The row's source line: the keywords of a LinkedIn search, the URL / token for Workday and Greenhouse, else what the
// scraper reads ("site “paytm”" next to the Lever chip; the stored value is the tooltip)
function sourceText(company) {
  const value = sourceValue(company)
  if (company.ats_type === 'linkedin') return `“${value}”`
  if (company.ats_type === 'workday' || company.ats_type === 'greenhouse' || !ATS_FIELDS[company.ats_type]) return value
  const text = describeSource(company.ats_type, ATS_FIELDS[company.ats_type].parse(value) || company)
  if (!text) return value
  // the type chip already names the ATS: "Lever site “paytm”" -> "site “paytm”"
  const label = `${atsLabel(company.ats_type)} `
  return text.startsWith(label) ? text.slice(label.length) : text
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
      if (MANUAL_SOURCES.includes(company.ats_type)) {
        return { label: 'By hand only', tone: 'muted', title: `Runs only when the LinkedIn workflow is started by hand; last searched ${whenText(scrape.last_scraped_at)}` }
      }
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
  if (!latest && MANUAL_SOURCES.includes(company.ats_type)) {
    return { label: 'By hand only', tone: 'muted', title: 'Runs only when the LinkedIn workflow is started by hand' }
  }
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
    const field = ATS_FIELDS[type]
    if (!field) return ''
    if (!source) return `${field.label} is required`
    const parsed = parseAtsSource(type, source)
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
      ...parseAtsSource(draft.ats_type, draft.source),
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
    if (!confirm(`Delete "${company.name}"? It will no longer be scraped; jobs already found stay until they disappear (7 days after posting, unless someone saved or applied to them).`)) return
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
    const patch = { name: draft.name, ...(ATS_FIELDS[company.ats_type] ? parseAtsSource(company.ats_type, draft.source) : {}) }
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

  const field = ATS_FIELDS[form.ats_type]
  const derived = field && form.source.trim() ? describeSource(form.ats_type, parseAtsSource(form.ats_type, form.source)) : ''
  const needle = search.trim().toLowerCase()
  const shown = needle
    ? companies.filter(c => [c.name, c.ats_type, atsLabel(c.ats_type), c.slug, c.api_url].some(v => String(v ?? '').toLowerCase().includes(needle)))
    : companies
  const failing = companies.filter(c => companyHealth(c, healthRows).label === 'Failing').length

  return (
    <div className="settings-panel settings-panel-animate">
      <div className="settings-summary-row">
        <p>
          Company boards are scraped every 6 hours (05:37, 11:37, 17:37 and 23:37 IST); new jobs appear about 2 hours
          later. LinkedIn searches run only when started by hand.
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
                <optgroup label="Company careers boards">
                  {BOARD_TYPES.map(t => <option key={t} value={t}>{atsLabel(t)}</option>)}
                </optgroup>
                <optgroup label="By hand only">
                  {MANUAL_SOURCES.map(t => <option key={t} value={t}>{atsLabel(t)}</option>)}
                </optgroup>
              </select>
            </div>

            {field && (
              <div className="settings-field settings-field-full">
                <label htmlFor={`${ids}-source`}>{field.label}</label>
                <input id={`${ids}-source`} type={field.type} required value={form.source}
                  onChange={e => { setForm(f => ({ ...f, source: e.target.value })); setFormError('') }}
                  placeholder={field.placeholder}
                  aria-describedby={`${ids}-source-help ${ids}-source-derived`}
                  autoComplete="off" spellCheck={false}
                  className="settings-input" />
                <small id={`${ids}-source-help`}>{field.help}</small>
                <small id={`${ids}-source-derived`} className="settings-derived" aria-live="polite">
                  {derived ? `Will read: ${derived}` : null}
                </small>
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
              const rowField = ATS_FIELDS[company.ats_type]

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
                        ? <span title={sourceValue(company)}>{sourceText(company)}</span>
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
