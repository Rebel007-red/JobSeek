import { Fragment, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { sessionUser } from '../lib/session'
import { useProfile } from '../hooks/useProfile'
import { useToast } from '../hooks/useToast'
import { AccessPanel } from '../components/settings/AccessPanel'
import { AccountPanel } from '../components/settings/AccountPanel'
import { CompaniesPanel } from '../components/settings/CompaniesPanel'
import { MetricsCard } from '../components/settings/MetricsCard'
import { MuteRulesPanel } from '../components/settings/MuteRulesPanel'
import { ProfileEditor } from '../components/settings/ProfileEditor'
import { SignOutButton } from '../components/settings/SignOutButton'
import { StatusPanel } from '../components/settings/StatusPanel'
import { Toast } from '../components/common/Toast'
import { ChevronLeftIcon, GridIcon, ListIcon, SearchIcon } from '../components/common/icons'
import { readView, saveView } from '../utils/viewPref'
import { JOB_DELETE_AFTER_DAYS, formatDate } from '../utils/job'
import { HIDE_REASONS } from '../utils/gold'

// Two groups of tabs: yours, then (admins only) Companies (scraper sources), System and Access; Supabase RLS and
// app_read / app_write enforce the same. Everyone starts at Profile.
const USER_TABS = ['profile', 'mute', 'hidden', 'account']
const ADMIN_TABS = ['companies', 'system', 'access']
const TAB_GROUPS = [
  { key: 'you', label: 'You', tabs: USER_TABS },
  { key: 'admin', label: 'Admin', tabs: ADMIN_TABS },
]
const TAB_LABELS = {
  companies: 'Companies',
  system: 'System',
  access: 'Access',
  profile: 'Profile',
  mute: 'Mute rules',
  hidden: 'Hidden',
  account: 'Account',
}
const tabId = (tab) => `settings-tab-${tab}`
const panelId = (tab) => `settings-panel-${tab}`

// The Hidden list shows at most this many (app.read_hidden_jobs LIMIT); "Restore all" restores every hidden job
const HIDDEN_LIST_LIMIT = 500
// The reasons in the hide toast's words (Not my role, Wrong city, …)
const REASON_LABELS = Object.fromEntries(HIDE_REASONS.map(reason => [reason.value, reason.label]))
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// '#also-skills' -> 'also-skills'; '' for a hash that is not valid URI text ('#%E0')
function hashAnchor(hash) {
  try {
    return decodeURIComponent(hash.replace(/^#/, ''))
  } catch {
    return ''
  }
}

export function SettingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const isAdmin = Boolean(sessionUser()?.isAdmin)
  const tabGroups = isAdmin ? TAB_GROUPS : TAB_GROUPS.slice(0, 1)
  const settingsTabs = tabGroups.flatMap(group => group.tabs)
  const onboarding = searchParams.get('welcome') === '1'
  const [tab, setTab] = useState(() => (settingsTabs.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'profile'))
  // A profile field to open (/settings?tab=profile#roles, from the hide toast and the job panel), read once and
  // dropped on the first tab change (ProfileEditor mounts again on returning to Profile and would jump to it again)
  const [profileAnchor, setProfileAnchor] = useState(() => hashAnchor(location.hash))
  const [undoError, setUndoError] = useState('')
  const [view, setView] = useState(readView)
  const { profile, loading: profileLoading, error: profileError, reload: reloadProfile, save: saveProfile, saveMuteRules } = useProfile()
  const { toast, showToast, runUndo, undoCount } = useToast()

  // Jobs you hid (kept until you restore them)
  const [hiddenJobs, setHiddenJobs] = useState([])
  const [hiddenLoading, setHiddenLoading] = useState(true)
  const [hiddenError, setHiddenError] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const restoreAllRef = useRef(null)
  const [hiddenSearch, setHiddenSearch] = useState('')
  const hiddenCount = hiddenJobs.length
  const hiddenCountLabel = `${hiddenCount}${hiddenCount >= HIDDEN_LIST_LIMIT ? '+' : ''}`

  useEffect(() => {
    loadHiddenJobs()
  }, [])

  // After the route change the button that opened Settings is gone: keyboard focus starts at the page heading, not <body>
  const headingRef = useRef(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      headingRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  // u undoes the newest restore or mute rule change, as the toast's Undo button (and the u key on the jobs page) do
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'u' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || undoCount === 0) return
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      setUndoError('')
      runUndo().catch(err => setUndoError(err.message))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [runUndo, undoCount])

  // The toast's Undo and the u key: restores and mute rule changes
  function undo() {
    setUndoError('')
    runUndo().catch(err => setUndoError(err.message))
  }

  // The tab is kept in the URL (replace: no history entry per tab), so a reload or a shared link opens it again
  function selectTab(next, focus = false) {
    setTab(next)
    setProfileAnchor('')
    setSearchParams(prev => {
      const params = new URLSearchParams(prev)
      params.set('tab', next)
      return params
    }, { replace: true })
    if (focus) requestAnimationFrame(() => document.getElementById(tabId(next))?.focus())
  }

  // Arrow keys, Home and End move between the tabs (WAI-ARIA tabs pattern, automatic activation)
  function onTabKeyDown(e) {
    const index = settingsTabs.indexOf(tab)
    const last = settingsTabs.length - 1
    const target = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[e.key]
    if (target === undefined) return
    e.preventDefault()
    selectTab(settingsTabs[target], true)
  }

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

  // Hides the jobs again, each with the reason it had
  async function hideAgain(jobs) {
    const byReason = new Map()
    for (const job of jobs) byReason.set(job.hide_reason || '', [...(byReason.get(job.hide_reason || '') || []), job.job_key])
    try {
      for (const [reason, keys] of byReason) await api.setHidden(keys, true, reason || undefined)
    } catch (err) {
      setHiddenError(`Could not hide the jobs again: ${err.message}`)
    }
    await loadHiddenJobs()
  }

  async function restoreJob(job) {
    setHiddenJobs(prev => prev.filter(item => item.job_key !== job.job_key))
    try {
      await api.setHidden(job.job_key, false)
      showToast(`Restored "${job.title}"`, () => hideAgain([job]))
    } catch (err) {
      setHiddenError(err.message)
      await loadHiddenJobs()
    }
  }

  // Closing the question puts focus back on "Restore all" (the question's buttons are about to go)
  function cancelRestore() {
    setConfirmRestore(false)
    requestAnimationFrame(() => restoreAllRef.current?.focus())
  }

  async function restoreAllHidden() {
    const previous = hiddenJobs
    setConfirmRestore(false)
    setRestoring(true)
    try {
      await api.restoreHidden()
      setHiddenJobs([])
      setHiddenSearch('')
      // The list holds at most HIDDEN_LIST_LIMIT jobs, so Undo hides those again (the newest hidden)
      showToast(`Restored ${previous.length >= HIDDEN_LIST_LIMIT ? `${previous.length}+ jobs` : plural(previous.length, 'job')}`, () => hideAgain(previous))
    } catch (err) {
      setHiddenError(err.message)
    } finally {
      setRestoring(false)
    }
  }

  const needle = hiddenSearch.trim().toLowerCase()
  const shownHidden = needle
    ? hiddenJobs.filter(job => `${job.title || ''} ${job.company_name || ''}`.toLowerCase().includes(needle))
    : hiddenJobs

  const renderPanel = (t) => {
    // Stays mounted on the other tabs so the list and an unfinished form survive switching
    if (t === 'companies') return <CompaniesPanel visible={tab === 'companies'} />
    if (tab !== t) return null
    if (t === 'system') {
      return (
        <div className="settings-panel">
          <MetricsCard />
          <StatusPanel />
        </div>
      )
    }
    if (t === 'access') return <AccessPanel />
    if (t === 'account') return <AccountPanel />
    if (t === 'mute' || t === 'profile') {
      if (profileLoading) return <div className="settings-empty-state">Loading profile…</div>
      if (profileError) {
        return (
          <div className="settings-card">
            <p className="settings-form-error">Could not load your profile: {profileError}</p>
            <div className="settings-actions-row">
              <button type="button" onClick={reloadProfile} className="secondary-button compact-button">Retry</button>
            </div>
          </div>
        )
      }
    }
    if (t === 'mute') {
      return (
        <div className="settings-panel settings-panel-animate">
          <MuteRulesPanel profile={profile} onSave={saveMuteRules} onOpenProfile={() => selectTab('profile')} showToast={showToast} />
        </div>
      )
    }
    if (t === 'profile') {
      return (
        <div className="settings-panel settings-panel-animate">
          <ProfileEditor
            key={profile?.profile_id || 'new'}
            profile={profile}
            onboarding={onboarding || !profile}
            anchor={profileAnchor}
            onSave={async (next) => {
              await saveProfile(next)
              if (onboarding || !profile) navigate('/', { replace: true })
            }}
          />
        </div>
      )
    }
    // hidden
    return (
      <div className="settings-panel settings-panel-animate">
        <div className="settings-card hidden-card">
          <div className="settings-card-header">
            <h3>
              {hiddenLoading ? 'Loading hidden jobs…' : hiddenCount > 0 ? `${hiddenCountLabel} hidden ${hiddenCount === 1 ? 'job' : 'jobs'}` : 'No hidden jobs'}
            </h3>
            {hiddenCount > 0 && !confirmRestore && (
              <button ref={restoreAllRef} type="button" onClick={() => setConfirmRestore(true)} disabled={restoring} className="primary-button compact-button">
                {restoring ? 'Restoring…' : 'Restore all'}
              </button>
            )}
            {confirmRestore && (
              <div className="inline-confirm" role="group" aria-label="Restore all hidden jobs?"
                onKeyDown={e => { if (e.key === 'Escape') cancelRestore() }}>
                <span>Restore {hiddenCountLabel} hidden {hiddenCount === 1 ? 'job' : 'jobs'}?</span>
                <button type="button" className="primary-button compact-button" onClick={restoreAllHidden}>Restore</button>
                <button type="button" className="secondary-button compact-button" onClick={cancelRestore} autoFocus>Cancel</button>
              </div>
            )}
          </div>

          <p className="settings-copy">
            Jobs you hide stay hidden until you restore them here. Jobs you haven&rsquo;t saved or applied to disappear{' '}
            {JOB_DELETE_AFTER_DAYS} days after posting, hidden ones included.
          </p>

          {hiddenError && <p className="settings-form-error" role="alert">{hiddenError}</p>}

          {hiddenCount > 0 && (
            <div className="settings-search">
              <SearchIcon />
              <label htmlFor="hidden-search" className="sr-only">Search hidden jobs</label>
              <input
                id="hidden-search"
                type="search"
                value={hiddenSearch}
                onChange={e => setHiddenSearch(e.target.value)}
                placeholder="Search by title or company"
                className="settings-input"
              />
            </div>
          )}

          {hiddenCount > 0 && (
            <div className="settings-list">
              {shownHidden.length === 0 && (
                <div className="settings-empty-state inline-empty">No hidden job matches &ldquo;{hiddenSearch.trim()}&rdquo;.</div>
              )}
              {shownHidden.map(job => (
                <div key={job.job_key} className="settings-row">
                  <div className="settings-row-main">
                    <div className="settings-company-name">{job.title}</div>
                    <div className="settings-company-meta">
                      <span>{job.company_name}</span>
                      {job.location && <span>{job.location}</span>}
                      {job.hide_reason && <span className="hide-reason">{REASON_LABELS[job.hide_reason] || job.hide_reason}</span>}
                      {job.hidden_at && <span className="meta-date">hidden {formatDate(job.hidden_at)}</span>}
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <button type="button" onClick={() => restoreJob(job)} className="secondary-button compact-button" aria-label={`Restore ${job.title}`}>Restore</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!hiddenLoading && hiddenCount === 0 && (
            <div className="settings-empty-state inline-empty">Hide a job (swipe left, press x or tap the eye) and it shows up here.</div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="settings-page min-h-screen">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <button type="button" onClick={() => navigate('/', { state: { from: 'settings' } })} className="icon-btn" aria-label="Back to jobs" title="Back to jobs">
              <ChevronLeftIcon />
            </button>
            <h1 className="brand-name" ref={headingRef} tabIndex={-1}>Settings</h1>
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
            <SignOutButton variant="icon" />
          </div>
        </div>
      </header>

      <main className="page-content settings-content">
        <div className="settings-shell">
          <div className="settings-header">
            {/* One tab list (the arrow keys move through both groups); the group names are only visual */}
            <div className={`settings-tabs ${isAdmin ? 'is-grouped' : ''}`} role="tablist" aria-label="Settings sections" onKeyDown={onTabKeyDown}>
              {tabGroups.map(group => (
                <Fragment key={group.key}>
                  {isAdmin && <span className={`settings-tab-group ${group.key}`} aria-hidden="true">{group.label}</span>}
                  {group.tabs.map(t => (
                    <button
                      key={t}
                      id={tabId(t)}
                      type="button"
                      role="tab"
                      aria-selected={tab === t}
                      aria-controls={panelId(t)}
                      tabIndex={tab === t ? 0 : -1}
                      onClick={() => selectTab(t)}
                      className={`settings-tab ${tab === t ? 'active' : ''}`}
                    >
                      <span>{TAB_LABELS[t]}</span>
                      {t === 'hidden' && hiddenCount > 0 && <em>{hiddenCountLabel}</em>}
                    </button>
                  ))}
                </Fragment>
              ))}
            </div>
          </div>

          {undoError && <p className="settings-form-error settings-undo-error" role="alert">Could not undo: {undoError}</p>}

          {settingsTabs.map(t => (
            <div key={t} id={panelId(t)} role="tabpanel" aria-labelledby={tabId(t)} hidden={tab !== t} tabIndex={0} className="settings-tabpanel">
              {renderPanel(t)}
            </div>
          ))}
        </div>
      </main>

      <Toast toast={toast} onUndo={undo} undoCount={undoCount} />
    </div>
  )
}
