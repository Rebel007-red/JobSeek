import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, signOut } from '../lib/api'
import { sessionUser } from '../lib/session'
import { useProfile } from '../hooks/useProfile'
import { CompaniesPanel } from '../components/settings/CompaniesPanel'
import { ProfileEditor } from '../components/settings/ProfileEditor'
import { ChevronLeftIcon, GridIcon, ListIcon, SignOutIcon } from '../components/common/icons'
import { readView, saveView } from '../utils/viewPref'
import { formatDate } from '../utils/job'

// Companies (scraper sources) are admin-only; Supabase RLS enforces the same rule.
const ADMIN_TABS = ['companies', 'profile', 'hidden']
const USER_TABS = ['profile', 'hidden']

export function SettingsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isAdmin = Boolean(sessionUser()?.isAdmin)
  const settingsTabs = isAdmin ? ADMIN_TABS : USER_TABS
  const onboarding = searchParams.get('welcome') === '1'
  const [tab, setTab] = useState(() => (settingsTabs.includes(searchParams.get('tab')) ? searchParams.get('tab') : settingsTabs[0]))
  const [view, setView] = useState(readView)
  const { profile, loading: profileLoading, error: profileError, reload: reloadProfile, save: saveProfile } = useProfile()

  // Hidden jobs (Databricks gold.jobs)
  const [hiddenJobs, setHiddenJobs] = useState([])
  const [hiddenLoading, setHiddenLoading] = useState(true)
  const [hiddenError, setHiddenError] = useState('')
  const [restoring, setRestoring] = useState(false)
  const hiddenCount = hiddenJobs.length

  useEffect(() => {
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
          <div className="topbar-actions">
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
            {/* Also reachable during onboarding, where "Back to jobs" leads here again */}
            <button type="button" onClick={signOut} className="icon-btn" title="Sign out" aria-label="Sign out">
              <SignOutIcon />
            </button>
          </div>
        </div>
      </header>

      <main className="page-content settings-content">
        <div className="settings-shell">
          <div className="settings-header">
            <div>
              <p className="eyebrow">Preferences</p>
              <h2>{isAdmin ? 'Manage sources & profile' : 'Your profile'}</h2>
            </div>
            <div className="settings-tabs" role="tablist" aria-label="Settings sections">
              {settingsTabs.map(t => (
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

          {/* Stays mounted on the other tabs so the list and an unfinished form survive switching */}
          {isAdmin && <CompaniesPanel visible={tab === 'companies'} />}

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
                <ProfileEditor
                  key={profile?.profile_id || 'new'}
                  profile={profile}
                  onboarding={onboarding || !profile}
                  onSave={async (next) => {
                    await saveProfile(next)
                    if (onboarding || !profile) navigate('/', { replace: true })
                  }}
                />
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

