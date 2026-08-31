import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const ATS_TYPES = ['greenhouse', 'workday', 'phenom', 'icims', 'oracle', 'successfactors']

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

  // Skills state (localStorage)
  const [skillInput, setSkillInput] = useState('')
  const [skills, setSkills] = useState(() => {
    const saved = localStorage.getItem('jobseeker_skills') || ''
    return saved ? saved.split(',').map(s => s.trim()).filter(Boolean) : []
  })

  useEffect(() => {
    loadCompanies()
  }, [])

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
    if (!form.name.trim()) return setFormError('Name is required')
    if (!form.ats_type) return setFormError('ATS type is required')

    const help = ATS_HELP[form.ats_type]
    if (help?.api_url && !form.api_url.trim()) return setFormError('API URL / Career site URL is required for this ATS')
    if (help?.slug && !form.slug.trim()) return setFormError(`${help.slug.label} is required for this ATS`)

    setSaving(true)
    const { error } = await supabase.from('companies').insert({
      name: form.name.trim(),
      ats_type: form.ats_type,
      slug: form.slug.trim() || null,
      api_url: form.api_url.trim() || null,
      disabled: false,
    })
    setSaving(false)

    if (error) return setFormError(error.message)
    setForm(EMPTY_FORM)
    setShowForm(false)
    loadCompanies()
  }

  // Skills handlers
  function addSkill() {
    const val = skillInput.trim().toLowerCase()
    if (!val || skills.includes(val)) { setSkillInput(''); return }
    const updated = [...skills, val]
    setSkills(updated)
    setSkillInput('')
    localStorage.setItem('jobseeker_skills', updated.join(','))
  }

  function removeSkill(skill) {
    const updated = skills.filter(s => s !== skill)
    setSkills(updated)
    localStorage.setItem('jobseeker_skills', updated.join(','))
  }

  function handleSkillKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSkill() }
  }

  const help = ATS_HELP[form.ats_type]

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="text-lg font-bold text-gray-900">Settings</h1>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit mb-6">
          {['companies', 'skills'].map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* ── COMPANIES TAB ── */}
        {tab === 'companies' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">
                Companies are scraped every 30 minutes via GitHub Actions.
                Changes take effect on the next run.
              </p>
              <button onClick={() => { setShowForm(true); setForm(EMPTY_FORM); setFormError('') }}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Company
              </button>
            </div>

            {/* Add company form */}
            {showForm && (
              <form onSubmit={saveCompany} className="bg-white border border-indigo-200 rounded-xl p-5 flex flex-col gap-4 shadow-sm">
                <h3 className="font-semibold text-gray-900">Add New Company</h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Company Name *</label>
                    <input type="text" required value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Stripe"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">ATS Type *</label>
                    <select value={form.ats_type} onChange={e => setForm(f => ({ ...f, ats_type: e.target.value, slug: '', api_url: '' }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
                      {ATS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>

                  {help?.slug && (
                    <div className="sm:col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">{help.slug.label} *</label>
                      <input type="text" value={form.slug}
                        onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                        placeholder={help.slug.placeholder}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                      <p className="text-xs text-gray-400 mt-1">{help.slug.help}</p>
                    </div>
                  )}

                  {help?.api_url && (
                    <div className="sm:col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">{help.api_url.label} *</label>
                      <input type="url" value={form.api_url}
                        onChange={e => setForm(f => ({ ...f, api_url: e.target.value }))}
                        placeholder={help.api_url.placeholder}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                      <p className="text-xs text-gray-400 mt-1">{help.api_url.help}</p>
                    </div>
                  )}
                </div>

                {formError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{formError}</p>}

                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => setShowForm(false)}
                    className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
                    Cancel
                  </button>
                  <button type="submit" disabled={saving}
                    className="px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white rounded-lg transition-colors">
                    {saving ? 'Saving…' : 'Add Company'}
                  </button>
                </div>
              </form>
            )}

            {/* Company list */}
            {loading ? (
              <div className="text-sm text-gray-400 py-8 text-center">Loading…</div>
            ) : companies.length === 0 ? (
              <div className="text-sm text-gray-400 py-8 text-center">No companies yet. Add one above.</div>
            ) : (
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-gray-600">Company</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">ATS</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Slug / URL</th>
                      <th className="px-4 py-3 font-medium text-gray-600 text-right">Status</th>
                      <th className="px-4 py-3 font-medium text-gray-600"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {companies.map(company => (
                      <tr key={company.id} className={company.disabled ? 'opacity-50' : ''}>
                        <td className="px-4 py-3 font-medium text-gray-900">{company.name}</td>
                        <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">
                          <span className="px-2 py-0.5 bg-gray-100 rounded text-xs">{company.ats_type}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-400 hidden md:table-cell text-xs font-mono truncate max-w-[200px]">
                          {company.slug || company.api_url || '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => toggleDisabled(company)}
                            className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-colors ${company.disabled ? 'bg-gray-100 text-gray-500 hover:bg-green-100 hover:text-green-700' : 'bg-green-100 text-green-700 hover:bg-gray-100 hover:text-gray-500'}`}>
                            {company.disabled ? 'Disabled' : 'Enabled'}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => deleteCompany(company)}
                            className="text-gray-300 hover:text-red-500 transition-colors p-1">
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
            <p className="text-sm text-gray-500">
              Enter your skills to highlight matching jobs. Jobs are scored and sorted by how many of your skills appear in the job title and department.
            </p>

            {/* Tag input */}
            <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm flex flex-col gap-4">
              <div className="flex gap-2">
                <input type="text" value={skillInput}
                  onChange={e => setSkillInput(e.target.value)}
                  onKeyDown={handleSkillKeyDown}
                  placeholder="Type a skill and press Enter or comma…"
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                <button onClick={addSkill}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors">
                  Add
                </button>
              </div>

              {skills.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {skills.map(skill => (
                    <span key={skill} className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-100 text-indigo-700 text-sm rounded-full">
                      {skill}
                      <button onClick={() => removeSkill(skill)} className="text-indigo-400 hover:text-indigo-700 leading-none">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </span>
                  ))}
                  <button onClick={() => { setSkills([]); localStorage.removeItem('jobseeker_skills') }}
                    className="text-xs text-gray-400 hover:text-red-500 px-2 py-1 transition-colors">
                    Clear all
                  </button>
                </div>
              ) : (
                <p className="text-sm text-gray-400">No skills added yet.</p>
              )}
            </div>

            <p className="text-xs text-gray-400">Skills are stored locally in your browser and never sent to the server.</p>
          </div>
        )}
      </main>
    </div>
  )
}
