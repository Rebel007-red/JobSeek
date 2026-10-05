import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

const ATS_TYPES = ['greenhouse', 'workday', 'phenom', 'icims', 'oracle', 'successfactors', 'jsearch', 'linkedin', 'naukri']

const ATS_HELP = {
  greenhouse: {
    slug: null,
    api_url: { label: 'Greenhouse API URL', placeholder: 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs', help: 'Use the public Greenhouse jobs API URL for this board.' },
  },
  workday: {
    slug: null,
    api_url: { label: 'Workday API URL', placeholder: 'https://company.wd1.myworkdayjobs.com/wday/cxs/company/Board/jobs', help: 'Find via DevTools → Network → XHR → POST to myworkdayjobs.com/jobs' },
  },
  phenom: {
    slug: null,
    api_url: { label: 'Career Site Base URL', placeholder: 'https://careers.company.com/global/en', help: 'The base path of the Phenom career site (before /search-results)' },
  },
  icims: {
    slug: { label: 'iCIMS Subdomain', placeholder: 'e.g. careers-acme', help: 'The subdomain from {slug}.icims.com' },
    api_url: null,
  },
  oracle: {
    slug: { label: 'Site Number', placeholder: 'e.g. CX_1001', help: 'Visible in the Oracle career site URL: /sites/{siteNumber}/jobs' },
    api_url: { label: 'Career Site Base URL', placeholder: 'https://company.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001', help: 'Full URL up to and including the site path' },
  },
  successfactors: {
    slug: { label: 'Career Site Domain', placeholder: 'e.g. careers.company.com', help: 'The domain of the SAP SuccessFactors career site' },
    api_url: null,
  },
}

const EMPTY_FORM = { name: '', ats_type: 'workday', slug: '', api_url: '' }

const HEALTH_DAYS = 7
const UNKNOWN_HEALTH = { label: 'No data', tone: 'pending' }

// Live = the scraper found a job for this company in the last HEALTH_DAYS days (Supabase jobs table).
async function companyHealth(company) {
  if (company.disabled) return { label: 'Paused', tone: 'muted' }
  const { data, error } = await supabase
    .from('jobs')
    .select('first_seen_at')
    .eq('company_id', company.id)
    .order('first_seen_at', { ascending: false, nullsFirst: false })
    .limit(1)
  if (error) throw error
  const latest = data?.[0]?.first_seen_at
  if (!latest) return UNKNOWN_HEALTH
  const days = (Date.now() - new Date(latest).getTime()) / (24 * 3600 * 1000)
  return days <= HEALTH_DAYS ? { label: 'Live', tone: 'success' } : { label: 'Stale', tone: 'warning' }
}

// Scraper sources (admin only; Supabase RLS enforces the same rule). Renders nothing while visible is false.
export function CompaniesPanel({ visible }) {
  const [companies, setCompanies] = useState([])
  const [companyStatusMap, setCompanyStatusMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    loadCompanies()
  }, [])

  const nameTaken = (name) => companies.some(c => c.name.toLowerCase() === name.toLowerCase())

  async function loadCompanies() {
    setLoading(true)
    const { data } = await supabase.from('companies').select('*').order('name')
    const list = data || []
    setCompanies(list)

    // One tiny query per company (latest scraped job) instead of downloading every job row
    const statuses = await Promise.all(list.map(company => companyHealth(company).catch(() => UNKNOWN_HEALTH)))
    setCompanyStatusMap(Object.fromEntries(list.map((company, index) => [company.id, statuses[index]])))
    setLoading(false)
  }

  async function toggleDisabled(company) {
    await supabase
      .from('companies')
      .update({ disabled: !company.disabled })
      .eq('id', company.id)
    setCompanies(prev => prev.map(c => c.id === company.id ? { ...c, disabled: !c.disabled } : c))
  }

  async function deleteCompany(company) {
    if (!confirm(`Delete "${company.name}"? This will also delete all its scraped jobs.`)) return
    await supabase.from('companies').delete().eq('id', company.id)
    setCompanies(prev => prev.filter(c => c.id !== company.id))
  }

  async function saveCompany(e) {
    e.preventDefault()
    setFormError('')

    const name = form.name.trim()
    if (!name) return setFormError('Company name is required')
    if (!form.ats_type) return setFormError('ATS type is required')
    if (nameTaken(name)) return setFormError(`Company "${name}" already exists`)

    const help = ATS_HELP[form.ats_type]
    if (help?.api_url && !form.api_url.trim()) return setFormError(`${help.api_url.label} is required for this ATS`)
    if (help?.slug && !form.slug.trim()) return setFormError(`${help.slug.label} is required for this ATS`)

    setSaving(true)
    const { error, data } = await supabase.from('companies').insert([{
      name,
      ats_type: form.ats_type,
      slug: form.slug.trim() || null,
      api_url: form.api_url.trim() || null,
      disabled: false,
    }]).select()
    setSaving(false)

    if (error) {
      console.error('Company insert error:', error)
      return setFormError(`Failed to add company: ${error.message}`)
    }
    if (!data || data.length === 0) return setFormError('Company was not created (unexpected response)')

    setForm(EMPTY_FORM)
    setShowForm(false)
    await loadCompanies()
  }

  if (!visible) return null

  const help = ATS_HELP[form.ats_type]

  return (
    <div className="settings-panel settings-panel-animate">
      <div className="settings-summary-row">
        <p>
          Companies are scraped every 4 hours via GitHub Actions. Changes take effect on the next run.
        </p>
        <button
          type="button"
          onClick={() => { setShowForm(true); setForm(EMPTY_FORM); setFormError('') }}
          className="primary-button"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Company
        </button>
      </div>

      {showForm && (
        <form onSubmit={saveCompany} className="settings-card settings-form-panel">
          <div className="settings-card-header">
            <h3>Add New Company</h3>
          </div>

          <div className="settings-form-grid">
            <div className="settings-field">
              <label>Company Name *</label>
              <input type="text" required value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Stripe, Acme Corp"
                className="settings-input" />
              {form.name.trim() && nameTaken(form.name.trim()) && (
                <p className="settings-inline-error">This company already exists</p>
              )}
            </div>

            <div className="settings-field">
              <label>ATS Type *</label>
              <select value={form.ats_type} onChange={e => setForm(f => ({ ...f, ats_type: e.target.value, slug: '', api_url: '' }))}
                className="settings-input settings-select">
                {ATS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            {help?.slug && (
              <div className="settings-field settings-field-full">
                <label>{help.slug.label} *</label>
                <input type="text" required value={form.slug}
                  onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                  placeholder={help.slug.placeholder}
                  className="settings-input" />
                <small>{help.slug.help}</small>
              </div>
            )}

            {help?.api_url && (
              <div className="settings-field settings-field-full">
                <label>{help.api_url.label} *</label>
                <input type="url" required value={form.api_url}
                  onChange={e => setForm(f => ({ ...f, api_url: e.target.value }))}
                  placeholder={help.api_url.placeholder}
                  className="settings-input" />
                <small>{help.api_url.help}</small>
              </div>
            )}
          </div>

          {formError && <p className="settings-form-error">{formError}</p>}

          <div className="settings-actions-row">
            <button type="button" onClick={() => { setShowForm(false); setFormError('') }} className="secondary-button">
              Cancel
            </button>
            <button type="submit" disabled={saving || !form.name.trim() || !form.ats_type} className="primary-button">
              {saving ? 'Adding…' : 'Add Company'}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="settings-empty-state">Loading…</div>
      ) : companies.length === 0 ? (
        <div className="settings-empty-state">No companies yet. Add one above.</div>
      ) : (
        <div className="settings-card settings-list-card">
          <div className="settings-list-head">
            <span>Company list</span>
            <strong>{companies.length}</strong>
          </div>

          <div className="settings-list">
            {companies.map(company => {
              const status = companyStatusMap[company.id] || UNKNOWN_HEALTH

              return (
                <div key={company.id} className={`settings-row ${company.disabled ? 'muted' : ''}`}>
                  <div className="settings-row-main">
                    <div className="settings-company-name">{company.name}</div>
                    <div className="settings-company-meta">
                      <span className="settings-chip">{company.ats_type}</span>
                      {company.slug || company.api_url ? <span>{company.slug || company.api_url}</span> : <span>details pending</span>}
                      <span className={`company-health ${status.tone}`}>{status.label}</span>
                    </div>
                  </div>

                  <div className="settings-row-actions">
                    <button onClick={() => toggleDisabled(company)} className={`status-pill ${company.disabled ? 'off' : 'on'}`}>
                      {company.disabled ? 'Disabled' : 'Enabled'}
                    </button>
                    <button onClick={() => deleteCompany(company)} className="trash-button" aria-label={`Delete ${company.name}`}>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
