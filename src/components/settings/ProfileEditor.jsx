import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { ChipInput } from '../common/ChipInput'
import { FIT_PARTS, MATCH_MIN_FIT } from '../../utils/gold'

// Same limits as the API
const MAX_ROLES = 2
const MAX_SKILLS = 5

function toForm(profile) {
  return {
    target_roles: profile?.target_roles || [],
    skills: profile?.skills || [],
    min_years: profile?.min_years ?? '',
    max_years: profile?.max_years ?? '',
  }
}

// onboarding: first visit without a profile (shows a welcome note; the parent leaves the page after saving)
export function ProfileEditor({ profile, onSave, onboarding = false }) {
  const [form, setForm] = useState(() => toForm(profile))
  const [refs, setRefs] = useState([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    api.refs().then(setRefs).catch(err => console.error('Failed to load role/skill lists:', err))
  }, [])

  const roleOptions = useMemo(() => refs.filter(row => row.kind === 'role').map(row => row.value), [refs])
  const skillOptions = useMemo(() => [...new Set(refs.filter(row => row.kind === 'skill').map(row => row.value))], [refs])
  const complete = form.target_roles.length > 0 && form.skills.length > 0

  const update = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }))
    setDirty(true)
    setMessage(null)
  }

  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      await onSave({
        target_roles: form.target_roles,
        skills: form.skills,
        min_years: form.min_years === '' ? null : Number(form.min_years),
        max_years: form.max_years === '' ? null : Number(form.max_years),
      })
      setDirty(false)
      setMessage({ tone: 'success', text: 'Profile saved. Your job list now uses it.' })
    } catch (err) {
      setMessage({ tone: 'error', text: err.message })
    } finally {
      setSaving(false)
    }
  }

  const weights = FIT_PARTS.map(part => `${part.label.toLowerCase()} ${Math.round(part.weight * 100)}%`).join(', ')

  return (
    <form onSubmit={save} className="settings-card profile-form">
      <div className="settings-card-header">
        <h3>{onboarding ? 'Welcome! Set up your profile' : 'Your profile'}</h3>
        {profile?.updated_at && <small className="muted-text">Last saved {new Date(profile.updated_at).toLocaleString()}</small>}
      </div>
      <p className="settings-copy">
        {onboarding && 'Pick what you are looking for to see your jobs. '}
        Jobs are matched to your roles and scored 0–100 ({weights}). <strong>For you</strong> shows jobs in your roles
        (or the same category) with fit {MATCH_MIN_FIT}+; <strong>Show all</strong> lists every job by fit.
      </p>

      <div className="settings-form-grid">
        <ChipInput
          label={`Roles (1–${MAX_ROLES}, most important first)`}
          values={form.target_roles}
          onChange={value => update('target_roles', value)}
          suggestions={roleOptions}
          placeholder="e.g. Data Engineer"
          help="Pick from the standard role list. LinkedIn is also searched for these roles."
          maxItems={MAX_ROLES}
          numbered
          strict
        />

        <ChipInput
          label={`Main skills (1–${MAX_SKILLS})`}
          values={form.skills}
          onChange={value => update('skills', value)}
          suggestions={skillOptions}
          placeholder="e.g. PySpark, Azure, SQL"
          help="Skill groups (e.g. Cloud) match any skill in the group."
          maxItems={MAX_SKILLS}
          strict
        />

        <div className="settings-field">
          <label>Experience from (years)</label>
          <input type="number" min="0" max="40" value={form.min_years} onChange={e => update('min_years', e.target.value)} className="settings-input" />
        </div>
        <div className="settings-field">
          <label>Experience to (years)</label>
          <input type="number" min="0" max="40" value={form.max_years} onChange={e => update('max_years', e.target.value)} className="settings-input" />
        </div>
      </div>

      {message && <p className={message.tone === 'error' ? 'settings-form-error' : 'settings-form-success'}>{message.text}</p>}

      <div className="settings-actions-row">
        <button
          type="submit"
          disabled={saving || !dirty || !complete}
          className="primary-button"
          title={complete ? undefined : 'Pick at least one role and one skill'}
        >
          {saving ? 'Saving…' : onboarding ? 'Save and show my jobs' : 'Save profile'}
        </button>
      </div>
    </form>
  )
}
