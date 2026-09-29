import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { ChipInput } from '../common/ChipInput'
import { FIT_PARTS } from '../../utils/gold'

const DEFAULT_PROFILE = {
  target_roles: [],
  skills: [],
  preferred_cities: [],
  min_years: null,
  max_years: null,
  weight_role: 0.4,
  weight_skills: 0.35,
  weight_experience: 0.15,
  weight_location: 0.1,
}

const WEIGHT_HELP = {
  weight_role: 'Job maps to one of your target roles',
  weight_skills: 'Share of your skills found in the job',
  weight_experience: 'Required years within your range',
  weight_location: 'Job is in a preferred city',
}

const RESCORE_MESSAGES = {
  started: 'Pipeline started. Fit scores update when it finishes (usually a few minutes).',
  queued: 'Pipeline is running; a re-score run was queued right after it.',
  already_queued: 'A pipeline run is already waiting to start; it will use your new profile.',
}

function toForm(profile) {
  const source = { ...DEFAULT_PROFILE, ...profile }
  return {
    ...source,
    target_roles: source.target_roles || [],
    skills: source.skills || [],
    preferred_cities: source.preferred_cities || [],
    min_years: source.min_years ?? '',
    max_years: source.max_years ?? '',
  }
}

export function ProfileEditor({ profile, onSave }) {
  const [form, setForm] = useState(() => toForm(profile))
  const [refs, setRefs] = useState([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [rescoring, setRescoring] = useState(false)

  useEffect(() => {
    api.refs().then(setRefs).catch(err => console.error('Failed to load role/skill lists:', err))
  }, [])

  const roleOptions = useMemo(() => refs.filter(row => row.kind === 'role').map(row => row.value), [refs])
  const skillOptions = useMemo(() => [...new Set(refs.filter(row => row.kind === 'skill').map(row => row.value))], [refs])
  const unknownRoles = roleOptions.length ? form.target_roles.filter(role => !roleOptions.includes(role)) : []

  const update = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }))
    setDirty(true)
    setMessage(null)
  }

  const totalWeight = FIT_PARTS.reduce((sum, part) => sum + (Number(form[part.weight]) || 0), 0)

  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      await onSave({
        ...form,
        min_years: form.min_years === '' ? null : Number(form.min_years),
        max_years: form.max_years === '' ? null : Number(form.max_years),
      })
      setDirty(false)
      setMessage({ tone: 'success', text: 'Profile saved. Fit scores refresh on the next pipeline run, or re-score now.' })
    } catch (err) {
      setMessage({ tone: 'error', text: err.message })
    } finally {
      setSaving(false)
    }
  }

  const rescore = async () => {
    setRescoring(true)
    try {
      const result = await api.rescore()
      setMessage({ tone: 'success', text: RESCORE_MESSAGES[result.status] || 'Pipeline triggered.' })
    } catch (err) {
      setMessage({ tone: 'error', text: `Could not start the pipeline: ${err.message}` })
    } finally {
      setRescoring(false)
    }
  }

  return (
    <form onSubmit={save} className="settings-card profile-form">
      <div className="settings-card-header">
        <h3>Fit profile</h3>
        {profile?.updated_at && <small className="muted-text">Last saved {new Date(profile.updated_at).toLocaleString()}</small>}
      </div>
      <p className="settings-copy">
        Every job in the gold layer gets a 0–100 fit score from this profile. It lives in Databricks (<code>ops.user_profile</code>).
      </p>

      <div className="settings-form-grid">
        <ChipInput
          label="Target roles (most important first)"
          values={form.target_roles}
          onChange={value => update('target_roles', value)}
          suggestions={roleOptions}
          placeholder="e.g. Data Engineer"
          help={unknownRoles.length ? `Not a standard role, will only match by category: ${unknownRoles.join(', ')}` : 'Pick from the standard role list so jobs map exactly.'}
          maxItems={20}
          numbered
        />

        <ChipInput
          label="Your skills"
          values={form.skills}
          onChange={value => update('skills', value)}
          suggestions={skillOptions}
          placeholder="e.g. PySpark, Azure, SQL"
          help="Skill groups (e.g. Cloud) match any skill in the group."
          maxItems={60}
        />

        <div className="settings-field">
          <label>Experience from (years)</label>
          <input type="number" min="0" max="40" value={form.min_years} onChange={e => update('min_years', e.target.value)} className="settings-input" />
        </div>
        <div className="settings-field">
          <label>Experience to (years)</label>
          <input type="number" min="0" max="40" value={form.max_years} onChange={e => update('max_years', e.target.value)} className="settings-input" />
        </div>

        <ChipInput
          label="Preferred cities"
          values={form.preferred_cities}
          onChange={value => update('preferred_cities', value)}
          placeholder="e.g. Hyderabad"
          help="Leave empty to treat every city in India as a full match."
          maxItems={20}
        />

        <div className="settings-field settings-field-full">
          <label>Score weights</label>
          <div className="weight-grid">
            {FIT_PARTS.map(part => {
              const value = Number(form[part.weight]) || 0
              const share = totalWeight > 0 ? Math.round((value / totalWeight) * 100) : 0
              return (
                <div key={part.weight} className="weight-item">
                  <div className="fit-part-label">
                    <span>{part.label}</span>
                    <em>{share}% of score</em>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={value}
                    onChange={e => update(part.weight, Number(e.target.value))}
                    className="range-input"
                    aria-label={`${part.label} weight`}
                  />
                  <small>{WEIGHT_HELP[part.weight]}</small>
                </div>
              )
            })}
          </div>
          {totalWeight <= 0 && <p className="settings-inline-error">At least one weight must be above 0.</p>}
        </div>
      </div>

      {message && <p className={message.tone === 'error' ? 'settings-form-error' : 'settings-form-success'}>{message.text}</p>}

      <div className="settings-actions-row">
        <button type="button" onClick={rescore} disabled={rescoring || dirty} className="secondary-button" title={dirty ? 'Save your changes first' : 'Run the Databricks pipeline now'}>
          {rescoring ? 'Starting…' : 'Re-score now'}
        </button>
        <button type="submit" disabled={saving || !dirty || totalWeight <= 0} className="primary-button">
          {saving ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </form>
  )
}
