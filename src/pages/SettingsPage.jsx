import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { api } from '../lib/api'
import { useProfile } from '../hooks/useProfile'
import { ProfileEditor } from '../components/settings/ProfileEditor'
import { ChevronLeftIcon, GridIcon, ListIcon } from '../components/common/icons'
import { readView, saveView } from '../utils/viewPref'
import { formatDate } from '../utils/job'

const SETTINGS_TABS = ['companies', 'profile', 'hidden']

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

export function SettingsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState(() => (SETTINGS_TABS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'companies'))
  const [view, setView] = useState(readView)
  const { profile, loading: profileLoading, error: profileError, reload: reloadProfile, save: saveProfile } = useProfile()
  const [companies, setCompanies] = useState([])
  const [companyStatusMap, setCompanyStatusMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  // Hidden jobs (Databricks gold.jobs)
  const [hiddenJobs, setHiddenJobs] = useState([])
  const [hiddenLoading, setHiddenLoading] = useState(true)
  const [hiddenError, setHiddenError] = useState('')
  const [restoring, setRestoring] = useState(false)
  const hiddenCount = hiddenJobs.length

  useEffect(() => {
    loadCompanies()
    loadHiddenJobs()
  }, [])

  async function loadHiddenJobs() {
    setHiddenLoading(true)
    setHiddenError('')
    try {
      setHiddenJobs(await api.hiddenJobs())
    } catch (err) {
      setHiddenError(err.message)
    } finally {
      setHiddenLoading(false)
    }
  }

  async function restoreJob(job) {
    setHiddenJobs(prev => prev.filter(item => item.job_key !== job.job_key))
    try {
      await api.setHidden(job.job_key, false)
    } catch (err) {
      setHiddenError(err.message)
      await loadHiddenJobs()
    }
  }

  async function restoreAllHidden() {
    setRestoring(true)
    try {
      await api.restoreHidden()
      setHiddenJobs([])
    } catch (err) {
      setHiddenError(err.message)
    } finally {
      setRestoring(false)
    }
  }

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
    
    // Validation
    const name = form.name.trim()
    if (!name) return setFormError('Company name is required')
    if (!form.ats_type) return setFormError('ATS type is required')

    // Check for duplicate company names
    if (companies.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      return setFormError(`Company "${name}" already exists`)
    }

    const help = ATS_HELP[form.ats_type]
    if (help?.api_url && !form.api_url.trim()) return setFormError(`${help.api_url.label} is required for this ATS`)
    if (help?.slug && !form.slug.trim()) return setFormError(`${help.slug.label} is required for this ATS`)

    setSaving(true)
    
    // Insert with proper error handling
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
    
    if (!data || data.length === 0) {
      return setFormError('Company was not created (unexpected response)')
    }

    // Success - clear form and reload
    setForm(EMPTY_FORM)
    setShowForm(false)
    setFormError('')
    await loadCompanies()
  }

  const help = ATS_HELP[form.ats_type]

  return (
    <div className="settings-page min-h-screen">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <button type="button" onClick={() => navigate('/')} className="icon-btn" aria-label="Back to jobs" title="Back to jobs">
              <ChevronLeftIcon />
            </button>
            <span className="brand-name">Settings</span>
          </div>
          {/* On phones the list/grid switch lives here instead of the jobs top bar */}
          <div className="topbar-actions hide-desktop">
            <span className="muted-text">Job layout</span>
            <div className="segmented" role="group" aria-label="Job layout">
              {[['list', ListIcon, 'List'], ['grid', GridIcon, 'Cards']].map(([value, Icon, label]) => (
                <button
                  key={value}
                  type="button"
                  className={view === value ? 'active' : ''}
                  onClick={() => { setView(value); saveView(value) }}
                  aria-pressed={view === value}
                  aria-label={label}
                  title={label}
                >
                  <Icon />
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="page-content settings-content">
        <div className="settings-shell">
          <div className="settings-header">
            <div>
              <p className="eyebrow">Preferences</p>
              <h2>Manage sources & fit</h2>
            </div>
            <div className="settings-tabs" role="tablist" aria-label="Settings sections">
              {SETTINGS_TABS.map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`settings-tab ${tab === t ? 'active' : ''}`}
                  aria-selected={tab === t}
                >
                  <span>{t}</span>
                  {t === 'hidden' && hiddenCount > 0 && <em>{hiddenCount}</em>}
                </button>
              ))}
            </div>
          </div>

          {tab === 'companies' && (
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
                      {companies.some(c => c.name.toLowerCase() === form.name.trim().toLowerCase()) && form.name.trim() && (
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
                      const status = companyStatusMap[company.id] || { label: 'No data', tone: 'pending' }

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
          )}

          {tab === 'profile' && (
            <div className="settings-panel settings-panel-animate">
              {profileLoading ? (
                <div className="settings-empty-state">Loading profile from Databricks…</div>
              ) : profileError ? (
                <div className="settings-card">
                  <p className="settings-form-error">Could not load your profile: {profileError}</p>
                  <div className="settings-actions-row">
                    <button type="button" onClick={reloadProfile} className="secondary-button compact-button">Retry</button>
                  </div>
                </div>
              ) : (
                <ProfileEditor key={profile?.profile_id || 'default'} profile={profile} onSave={saveProfile} />
              )}
            </div>
          )}

          {tab === 'hidden' && (
            <div className="settings-panel settings-panel-animate">
              <div className="settings-card hidden-card">
                <div className="settings-card-header">
                  <h3>
                    {hiddenLoading ? 'Loading hidden jobs…' : hiddenCount > 0 ? `${hiddenCount}${hiddenCount >= 200 ? '+' : ''} hidden ${hiddenCount === 1 ? 'job' : 'jobs'}` : 'No hidden jobs'}
                  </h3>
                  {hiddenCount > 0 && (
                    <button type="button" onClick={restoreAllHidden} disabled={restoring} className="primary-button compact-button">
                      {restoring ? 'Restoring…' : 'Restore all'}
                    </button>
                  )}
                </div>

                <p className="settings-copy">
                  Jobs you hide stay hidden across sessions and pipeline runs until you restore them here. The pipeline removes jobs posted more than 2 days ago that you haven't applied to, hidden ones included.
                </p>

                {hiddenError && <p className="settings-form-error">{hiddenError}</p>}

                {hiddenCount > 0 && (
                  <div className="settings-list">
                    {hiddenJobs.map(job => (
                      <div key={job.job_key} className="settings-row">
                        <div className="settings-row-main">
                          <div className="settings-company-name">{job.title}</div>
                          <div className="settings-company-meta">
                            <span>{job.company_name}</span>
                            {job.location && <span>{job.location}</span>}
                            {job.hidden_at && <span>hidden {formatDate(job.hidden_at)}</span>}
                          </div>
                        </div>
                        <div className="settings-row-actions">
                          <button type="button" onClick={() => restoreJob(job)} className="secondary-button compact-button">Restore</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {!hiddenLoading && hiddenCount === 0 && (
                  <div className="settings-empty-state inline-empty">Click × on any job (or press x) to hide it.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

