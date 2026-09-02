import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const ATS_TYPES = ['greenhouse', 'workday', 'phenom', 'icims', 'oracle', 'successfactors', 'jsearch', 'linkedin', 'naukri']

const ATS_HELP = {
  greenhouse: {
    slug: { label: 'Board Slug', placeholder: 'e.g. stripe', help: 'The part after boards.greenhouse.io/' },
    api_url: null,
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
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  // Hidden jobs state
  const [hiddenCount, setHiddenCount] = useState(0)
  const [restoring, setRestoring] = useState(false)

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
      // Try upsert first (in case record doesn't exist yet)
      await supabase
        .from('user_skills')
        .upsert({ user_id: user.id, skills: updatedSkills })
        .eq('user_id', user.id)
    }
  }

  async function restoreAllHidden() {
    setRestoring(true)
    await supabase.from('jobs').update({ hidden: false }).eq('hidden', true)
    setHiddenCount(0)
    setRestoring(false)
  }

  async function loadCompanies() {
    setLoading(true)
    const { data } = await supabase.from('companies').select('*').order('name')
    setCompanies(data || [])
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

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="text-gray-500 hover:text-gray-300">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="text-sm font-bold text-gray-100">Settings</h1>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-4">
        {/* Tabs */}
        <div className="flex gap-1 bg-gray-800 border border-gray-700 rounded-lg p-1 w-fit mb-6">
          {['companies', 'skills', 'hidden'].map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium capitalize transition-colors flex items-center gap-1.5 ${tab === t ? 'bg-gray-700 text-gray-100 shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}>
              {t}
              {t === 'hidden' && hiddenCount > 0 && (
                <span className="text-[10px] bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded-full font-bold">{hiddenCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── COMPANIES TAB ── */}
        {tab === 'companies' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400">
                Companies are scraped every 30 minutes via GitHub Actions.
                Changes take effect on the next run.
              </p>
              <button onClick={() => { setShowForm(true); setForm(EMPTY_FORM); setFormError('') }}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-md transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Company
              </button>
            </div>

            {/* Add company form */}
            {showForm && (
              <form onSubmit={saveCompany} className="bg-gray-800 border border-indigo-700/50 rounded-lg p-4 flex flex-col gap-4 shadow-sm">
                <h3 className="font-semibold text-gray-100">Add New Company</h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Company Name *</label>
                    <input type="text" required value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Stripe, Acme Corp"
                      className="w-full bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-600 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                    {companies.some(c => c.name.toLowerCase() === form.name.trim().toLowerCase()) && form.name.trim() && (
                      <p className="text-xs text-red-400 mt-1">⚠ This company already exists</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">ATS Type *</label>
                    <select value={form.ats_type} onChange={e => setForm(f => ({ ...f, ats_type: e.target.value, slug: '', api_url: '' }))}
                      className="w-full bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-600 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500">
                      {ATS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>

                  {help?.slug && (
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium text-gray-400 mb-1">{help.slug.label} *</label>
                      <input type="text" required value={form.slug}
                        onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                        placeholder={help.slug.placeholder}
                        className="w-full bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-600 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                      <p className="text-xs text-gray-600 mt-0.5">{help.slug.help}</p>
                    </div>
                  )}

                  {help?.api_url && (
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium text-gray-400 mb-1">{help.api_url.label} *</label>
                      <input type="url" required value={form.api_url}
                        onChange={e => setForm(f => ({ ...f, api_url: e.target.value }))}
                        placeholder={help.api_url.placeholder}
                        className="w-full bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-600 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                      <p className="text-xs text-gray-600 mt-0.5">{help.api_url.help}</p>
                    </div>
                  )}
                </div>

                {formError && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded-md px-3 py-2">{formError}</p>}

                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => { setShowForm(false); setFormError('') }}
                    className="px-3 py-1.5 text-xs text-gray-400 border border-gray-700 rounded-md hover:bg-gray-700">
                    Cancel
                  </button>
                  <button type="submit" disabled={saving || !form.name.trim() || !form.ats_type}
                    className="px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md transition-colors">
                    {saving ? 'Adding…' : 'Add Company'}
                  </button>
                </div>
              </form>
            )}

            {/* Company list */}
            {loading ? (
              <div className="text-xs text-gray-600 py-8 text-center">Loading…</div>
            ) : companies.length === 0 ? (
              <div className="text-xs text-gray-600 py-8 text-center">No companies yet. Add one above.</div>
            ) : (
              <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-900/50 border-b border-gray-700">
                    <tr>
                      <th className="text-left px-3 py-2.5 font-medium text-gray-500 text-xs">Company</th>
                      <th className="text-left px-3 py-2.5 font-medium text-gray-500 text-xs hidden sm:table-cell">ATS</th>
                      <th className="text-left px-3 py-2.5 font-medium text-gray-500 text-xs hidden md:table-cell">Slug / URL</th>
                      <th className="px-3 py-2.5 font-medium text-gray-500 text-xs text-right">Status</th>
                      <th className="px-3 py-2.5 font-medium text-gray-500 text-xs"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700/50">
                    {companies.map(company => (
                      <tr key={company.id} className={company.disabled ? 'opacity-50' : ''}>
                        <td className="px-3 py-2.5 font-medium text-gray-200 text-sm">{company.name}</td>
                        <td className="px-3 py-2.5 text-gray-500 hidden sm:table-cell">
                          <span className="px-2 py-0.5 bg-gray-100 rounded text-xs">{company.ats_type}</span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-600 hidden md:table-cell text-xs font-mono truncate max-w-[200px]">
                          {company.slug || company.api_url || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <button onClick={() => toggleDisabled(company)}
                            className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-colors ${company.disabled ? 'bg-gray-700/60 text-gray-500 hover:bg-green-900/40 hover:text-green-300' : 'bg-green-900/40 text-green-300 border border-green-700/50 hover:bg-gray-700/60 hover:text-gray-400'}`}>
                            {company.disabled ? 'Disabled' : 'Enabled'}
                          </button>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <button onClick={() => deleteCompany(company)}
                            className="text-gray-700 hover:text-red-400 transition-colors p-1">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── SKILLS TAB ── */}
        {tab === 'skills' && (
          <div className="flex flex-col gap-5">
            <p className="text-xs text-gray-400">
              Enter your skills to highlight matching jobs. Jobs are scored and sorted by how many of your skills appear in the job title and department.
            </p>

            {/* Tag input */}
            <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 flex flex-col gap-3">
              <div className="flex gap-2">
                <input type="text" value={skillInput}
                  onChange={e => setSkillInput(e.target.value)}
                  onKeyDown={handleSkillKeyDown}
                  placeholder="Type a skill and press Enter or comma…"
                  className="flex-1 bg-gray-900 border border-gray-700 text-gray-100 placeholder:text-gray-600 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <button onClick={addSkill}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-md transition-colors">
                  Add
                </button>
              </div>

              {skills.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {skills.map(skill => (
                    <span key={skill} className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-900/50 text-indigo-300 border border-indigo-700/40 text-sm rounded-full">
                      {skill}
                      <button onClick={() => removeSkill(skill)} className="text-indigo-400 hover:text-indigo-300 leading-none">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </span>
                  ))}
                  <button onClick={clearAllSkills}
                    className="text-xs text-gray-600 hover:text-red-400 px-2 py-1 transition-colors">
                    Clear all
                  </button>
                </div>
              ) : (
                <p className="text-xs text-gray-600">No skills added yet.</p>
              )}
            </div>

            <p className="text-xs text-gray-400">Skills are stored in your account and used to filter job results.</p>
          </div>
        )}

        {/* ── HIDDEN JOBS TAB ── */}
        {tab === 'hidden' && (
          <div className="flex flex-col gap-4">
            <div className="bg-gray-800 border border-gray-700 rounded-lg p-5 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-200">
                    {hiddenCount > 0
                      ? <>{hiddenCount} job{hiddenCount > 1 ? 's' : ''} hidden</>
                      : 'No hidden jobs'}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Jobs you dismiss with the × button are hidden across all sessions.
                    They reappear if a new scrape finds them again — unless you restore them here first.
                  </p>
                </div>
                {hiddenCount > 0 && (
                  <button
                    onClick={restoreAllHidden}
                    disabled={restoring}
                    className="shrink-0 px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-md transition-colors"
                  >
                    {restoring ? 'Restoring…' : `Restore all ${hiddenCount}`}
                  </button>
                )}
              </div>

              {hiddenCount === 0 && (
                <p className="text-xs text-gray-600 text-center py-4">
                  Hover over any job card and click × to hide it.
                </p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

