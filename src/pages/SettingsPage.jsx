import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

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

export function SettingsPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('companies')
  const [companies, setCompanies] = useState([])
  const [companyStatusMap, setCompanyStatusMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  // Hidden jobs state
  const [hiddenCount, setHiddenCount] = useState(0)
  const [restoring, setRestoring] = useState(false)
  const [cleaningStale, setCleaningStale] = useState(false)

  // Skills state (localStorage)
  const [skillInput, setSkillInput] = useState('')
  const [skills, setSkills] = useState(() => {
    const saved = localStorage.getItem('jobseeker_skills') || ''
    return saved ? saved.split(',').map(s => s.trim()).filter(Boolean) : []
  })

  useEffect(() => {
    loadCompanies()
    loadHiddenCount()
    loadUserSkills()
  }, [])

  async function loadHiddenCount() {
    const { count } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('hidden', true)
    setHiddenCount(count || 0)
  }

  async function loadUserSkills() {
    // Try to load from Supabase first
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data } = await supabase
        .from('user_skills')
        .select('skills')
        .eq('user_id', user.id)
        .single()
      
      if (data?.skills && data.skills.length > 0) {
        setSkills(data.skills)
        localStorage.setItem('jobseeker_skills', data.skills.join(','))
        return
      }
    }
    
    // Fallback to localStorage if no Supabase data
    const saved = localStorage.getItem('jobseeker_skills') || ''
    if (saved) {
      setSkills(saved.split(',').map(s => s.trim()).filter(Boolean))
    }
  }

  async function saveSkillsToSupabase(updatedSkills) {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      // Upsert: Insert or update the user_skills row
      const { error } = await supabase
        .from('user_skills')
        .upsert({ user_id: user.id, skills: updatedSkills }, { onConflict: 'user_id' })
      
      if (error) {
        console.error('Failed to save skills:', error)
      } else {
        console.log('✓ Skills saved to Supabase:', updatedSkills)
      }
    }
  }

  async function restoreAllHidden() {
    setRestoring(true)
    await supabase.from('jobs').update({ hidden: false }).eq('hidden', true)
    setHiddenCount(0)
    setRestoring(false)
  }

  async function cleanupStaleJobs() {
    setCleaningStale(true)
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('jobs')
      .select('id, posted_at, first_seen_at')
      .or(`posted_at.lt.${cutoff},first_seen_at.lt.${cutoff}`)

    if (error) {
      console.error('Failed to find stale jobs:', error)
      setCleaningStale(false)
      return
    }

    const staleIds = (data || []).map(job => job.id)
    if (staleIds.length > 0) {
      const { error: updateError } = await supabase
        .from('jobs')
        .update({ hidden: true })
        .in('id', staleIds)

      if (updateError) {
        console.error('Failed to hide stale jobs:', updateError)
      }
    }

    await loadHiddenCount()
    await loadCompanies()
    setCleaningStale(false)
  }

  async function loadCompanies() {
    setLoading(true)
    const { data } = await supabase.from('companies').select('*').order('name')
    const list = data || []
    setCompanies(list)

    if (list.length > 0) {
      const companyIds = list.map(company => company.id)
      const { data: jobsData } = await supabase
        .from('jobs')
        .select('company_id, posted_at, first_seen_at')
        .in('company_id', companyIds)
        .order('posted_at', { ascending: false, nullsFirst: false })

      const statusMap = {}
      const rows = jobsData || []

      list.forEach(company => {
        const latestJob = rows
          .filter(row => row.company_id === company.id)
          .map(row => row.posted_at || row.first_seen_at)
          .filter(Boolean)
          .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]

        if (!latestJob) {
          statusMap[company.id] = { label: 'No data', tone: 'pending' }
          return
        }

        const latestDate = new Date(latestJob).getTime()
        const now = Date.now()
        const daysSince = (now - latestDate) / (1000 * 60 * 60 * 24)

        if (company.disabled) {
          statusMap[company.id] = { label: 'Paused', tone: 'muted' }
        } else if (daysSince <= 7) {
          statusMap[company.id] = { label: 'Live', tone: 'success' }
        } else {
          statusMap[company.id] = { label: 'Stale', tone: 'warning' }
        }
      })

      setCompanyStatusMap(statusMap)
    } else {
      setCompanyStatusMap({})
    }

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

  // Skills handlers
  function addSkill() {
    const val = skillInput.trim().toLowerCase()
    if (!val || skills.includes(val)) { setSkillInput(''); return }
    const updated = [...skills, val]
    setSkills(updated)
    setSkillInput('')
    localStorage.setItem('jobseeker_skills', updated.join(','))
    saveSkillsToSupabase(updated)
  }

  function removeSkill(skill) {
    const updated = skills.filter(s => s !== skill)
    setSkills(updated)
    localStorage.setItem('jobseeker_skills', updated.join(','))
    saveSkillsToSupabase(updated)
  }

  function clearAllSkills() {
    setSkills([])
    localStorage.setItem('jobseeker_skills', '')
    saveSkillsToSupabase([])
  }

  function handleSkillKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSkill() }
  }

  const help = ATS_HELP[form.ats_type]
  const enabledCompanies = companies.filter(company => !company.disabled).length
  const disabledCompanies = companies.length - enabledCompanies

  return (
    <div className="settings-page min-h-screen">
      <header className="topbar settings-topbar">
        <div className="topbar-inner">
          <div className="brand-wrap">
            <button onClick={() => navigate('/')} className="icon-button" aria-label="Back home" title="Back to jobs">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div>
              <div className="brand-kicker">Workspace</div>
              <h1>Settings</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="page-content settings-content">
        <div className="settings-shell panel">
          <div className="settings-header">
            <div>
              <p className="eyebrow">Preferences</p>
              <h2>Manage sources & fit</h2>
            </div>
            <div className="settings-tabs" role="tablist" aria-label="Settings sections">
              {['companies', 'skills', 'hidden'].map(t => (
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

          {tab === 'skills' && (
            <div className="settings-panel settings-panel-animate">
              <div className="settings-card">
                <div className="settings-card-header">
                  <h3>Skills that match your target roles</h3>
                </div>
                <p className="settings-copy">
                  Enter your skills to highlight matching jobs. Jobs are scored and sorted by how many of your skills appear in the title and department.
                </p>

                <div className="settings-input-row">
                  <input type="text" value={skillInput}
                    onChange={e => setSkillInput(e.target.value)}
                    onKeyDown={handleSkillKeyDown}
                    placeholder="Type a skill and press Enter or comma…"
                    className="settings-input" />
                  <button onClick={addSkill} className="primary-button compact-button">Add</button>
                </div>

                {skills.length > 0 ? (
                  <div className="settings-skill-list">
                    {skills.map(skill => (
                      <span key={skill} className="skill-chip">
                        {skill}
                        <button type="button" onClick={() => removeSkill(skill)} aria-label={`Remove ${skill}`}>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                    ))}
                    <button type="button" onClick={clearAllSkills} className="text-button">Clear all</button>
                  </div>
                ) : (
                  <p className="settings-empty-state inline-empty">No skills added yet.</p>
                )}
              </div>
            </div>
          )}

          {tab === 'hidden' && (
            <div className="settings-panel settings-panel-animate">
              <div className="settings-card hidden-card">
                <div className="settings-card-header">
                  <h3>{hiddenCount > 0 ? `${hiddenCount} hidden ${hiddenCount === 1 ? 'job' : 'jobs'}` : 'No hidden jobs'}</h3>
                  {hiddenCount > 0 && (
                    <button type="button" onClick={restoreAllHidden} disabled={restoring} className="primary-button compact-button">
                      {restoring ? 'Restoring…' : 'Restore all'}
                    </button>
                  )}
                </div>

                <p className="settings-copy">
                  Jobs you dismiss with the × button are hidden across all sessions. They reappear if a new scrape finds them again unless you restore them here.
                </p>

                <div className="settings-actions-row compact-actions">
                  <button type="button" onClick={cleanupStaleJobs} disabled={cleaningStale} className="secondary-button compact-button">
                    {cleaningStale ? 'Cleaning…' : 'Hide stale jobs'}
                  </button>
                </div>

                {hiddenCount === 0 && (
                  <div className="settings-empty-state inline-empty">Hover over any job card and click × to hide it.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

