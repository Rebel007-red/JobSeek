import { useEffect, useId, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { ChipInput } from '../common/ChipInput'
import { EXPERIENCE_HIDE_GAP, FIT_PARTS, MATCH_MIN_FIT } from '../../utils/gold'
import { PROFILE_LIMITS, alsoSkillProblem, entryProblem } from '../../utils/entries'

// Same limits as the API
const { roles: MAX_ROLES, skills: MAX_SKILLS, cities: MAX_CITIES, alsoSkills: MAX_ALSO_SKILLS } = PROFILE_LIMITS
const NOT_SUPPORTED = 'is outside the supported roles (data, full stack / backend, DevOps and cloud)'
const CHECK_PENDING = 'custom · checked on the next pipeline run'

// Lookups from api.refs(): lower-case text -> the list's spelling, plus what users added themselves (with its status).
function buildLookups(refs) {
  const roles = new Map()
  const outOfScope = new Set()
  const skills = new Map()
  const refSkills = new Set()
  const customRoles = new Map()
  const cities = new Map()
  const byKind = (kind) => refs.filter(row => row.kind === kind)
  for (const row of byKind('role')) roles.set(row.value.toLowerCase(), row.value)
  for (const row of byKind('role_out')) outOfScope.add(row.value.toLowerCase())
  for (const row of byKind('skill')) skills.set(row.value.toLowerCase(), row.value)
  for (const row of byKind('skill')) {
    for (const alias of row.aliases || []) if (!skills.has(alias.toLowerCase())) skills.set(alias.toLowerCase(), row.value)
  }
  for (const key of skills.keys()) refSkills.add(key)
  for (const row of byKind('custom_skill')) if (!skills.has(row.value.toLowerCase())) skills.set(row.value.toLowerCase(), row.value)
  for (const row of byKind('custom_role')) {
    customRoles.set(row.value.toLowerCase(), { value: row.value, status: row.detail, duplicateOf: row.aliases?.[0] || null })
  }
  // Other spellings (e.g. Bangalore) resolve to the list's city name
  for (const row of byKind('city')) {
    cities.set(row.value.toLowerCase(), row.value)
    for (const alias of row.aliases || []) if (!cities.has(alias.toLowerCase())) cities.set(alias.toLowerCase(), row.value)
  }
  return { roles, outOfScope, skills, refSkills, customRoles, cities }
}

function toForm(profile) {
  return {
    target_roles: profile?.target_roles || [],
    skills: profile?.skills || [],
    also_skills: profile?.also_skills || [],
    min_years: profile?.min_years ?? '',
    max_years: profile?.max_years ?? '',
    preferred_cities: profile?.preferred_cities || [],
  }
}

// onboarding: first visit without a profile (shows a welcome note; the parent leaves the page after saving)
export function ProfileEditor({ profile, onSave, onboarding = false }) {
  const [form, setForm] = useState(() => toForm(profile))
  const [refs, setRefs] = useState(null) // null until the lists load: no "custom" notes yet (they'd be wrong, then jump)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [dirty, setDirty] = useState(false)
  const minYearsId = useId()
  const maxYearsId = useId()

  useEffect(() => {
    api.refs().then(setRefs).catch(err => console.error('Failed to load role/skill lists:', err))
  }, [])

  const lookups = useMemo(() => buildLookups(refs || []), [refs])
  const roleOptions = useMemo(
    () => [...lookups.roles.values(), ...[...lookups.customRoles.values()].filter(role => role.status === 'active').map(role => role.value)],
    [lookups],
  )
  const skillOptions = useMemo(() => [...new Set(lookups.skills.values())], [lookups])
  const cityOptions = useMemo(() => [...new Set(lookups.cities.values())], [lookups])
  const complete = form.target_roles.length > 0 && form.skills.length > 0

  // Known roles resolve to the list's spelling; a custom role the pipeline mapped resolves to the role it duplicates
  const resolveRole = (text) => {
    const key = text.toLowerCase()
    if (lookups.roles.has(key)) return { value: lookups.roles.get(key) }
    if (lookups.outOfScope.has(key)) return { blocked: `"${text}" ${NOT_SUPPORTED}.` }
    const custom = lookups.customRoles.get(key)
    if (!custom) return null
    if (custom.status === 'rejected') return { blocked: `"${text}" ${NOT_SUPPORTED}.` }
    if (custom.status === 'mapped' && custom.duplicateOf) return { value: custom.duplicateOf }
    return { value: custom.value }
  }
  const roleNote = (value) => {
    if (!refs) return ''
    const key = value.toLowerCase()
    if (lookups.roles.has(key)) return ''
    const custom = lookups.customRoles.get(key)
    if (!custom || custom.status === 'pending') return CHECK_PENDING
    return { active: 'custom', mapped: `matched as ${custom.duplicateOf}`, rejected: 'not supported' }[custom.status] || ''
  }
  const resolveSkill = (text) => {
    const value = lookups.skills.get(text.toLowerCase())
    return value ? { value } : null
  }
  // A skill is either core or also-know, never both (the server refuses an also-know skill that is a core skill)
  const sameSkill = (list, value) => list.some(item => item.toLowerCase() === value.toLowerCase())
  const resolveCoreSkill = (text) => {
    const known = resolveSkill(text)
    if (sameSkill(form.also_skills, known?.value || text)) return { blocked: `"${known?.value || text}" is already in Also know. Remove it there first.` }
    return known
  }
  const resolveAlsoSkill = (text) => {
    const known = resolveSkill(text)
    if (sameSkill(form.skills, known?.value || text)) return { blocked: 'Already a core skill' }
    return known
  }
  const skillNote = (value) => (!refs || lookups.refSkills.has(value.toLowerCase()) ? '' : 'custom')
  // Cities come only from the list (no custom entries)
  const resolveCity = (text) => {
    // No city rows = lists cached from before the city list existed
    if (!refs || !cityOptions.length) return { blocked: 'The city list is still loading, try again in a moment (or reload the page).' }
    const value = lookups.cities.get(text.toLowerCase())
    if (value) return { value }
    const lower = text.toLowerCase()
    const near = cityOptions.filter(city => city.toLowerCase().startsWith(lower.slice(0, 3))).slice(0, 3)
    return { blocked: `"${text}" is not in the city list.${near.length ? ` Did you mean ${near.join(', ')}?` : ''}` }
  }

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
        also_skills: form.also_skills,
        min_years: form.min_years === '' ? null : Number(form.min_years),
        max_years: form.max_years === '' ? null : Number(form.max_years),
        preferred_cities: form.preferred_cities,
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
        (or closely related ones) with fit {MATCH_MIN_FIT}+, leaving out jobs that ask for over {EXPERIENCE_HIDE_GAP} years
        more than your maximum (stated, or implied by a level such as Lead/Manager); <strong>Show all</strong> lists
        every job by fit. Core skills count fully and Also know skills half as much, so they lift a job's score without
        outweighing your core skills.
      </p>

      <div className="settings-form-grid">
        <ChipInput
          label={`Roles (1–${MAX_ROLES}, most important first)`}
          values={form.target_roles}
          onChange={value => update('target_roles', value)}
          suggestions={roleOptions}
          resolve={resolveRole}
          validate={entryProblem}
          noteFor={roleNote}
          placeholder="e.g. Data Engineer"
          help="Data, full stack / backend, DevOps and cloud roles. Not in the list? Type it and add it as your own: it is checked on the next pipeline run (a few hours) and until then jobs with it in the title count as matches. LinkedIn is also searched for these roles."
          maxItems={MAX_ROLES}
          numbered
        />

        <ChipInput
          label={`Core skills (1–${MAX_SKILLS}, full weight)`}
          values={form.skills}
          onChange={value => update('skills', value)}
          suggestions={skillOptions}
          resolve={resolveCoreSkill}
          validate={entryProblem}
          noteFor={skillNote}
          placeholder="e.g. PySpark, Azure, SQL"
          help="Skill groups (e.g. Cloud) match any skill in the group. Skills you add yourself are looked for in job descriptions from the next pipeline run."
          maxItems={MAX_SKILLS}
        />

        <ChipInput
          label={`Also know (up to ${MAX_ALSO_SKILLS}, half weight)`}
          values={form.also_skills}
          onChange={value => update('also_skills', value)}
          suggestions={skillOptions}
          resolve={resolveAlsoSkill}
          validate={text => alsoSkillProblem(text, form.skills)}
          noteFor={skillNote}
          placeholder="e.g. Kafka, Docker"
          help="Skills you can work with but would not lead on. A job asking for them scores higher, by half as much as a core skill, and they show as skills you have instead of missing ones."
          maxItems={MAX_ALSO_SKILLS}
        />

        <div className="settings-field">
          <label htmlFor={minYearsId}>Experience from (years)</label>
          <input id={minYearsId} type="number" min="0" max="40" value={form.min_years} onChange={e => update('min_years', e.target.value)} className="settings-input" />
        </div>
        <div className="settings-field">
          <label htmlFor={maxYearsId}>Experience to (years)</label>
          <input id={maxYearsId} type="number" min="0" max="40" value={form.max_years} onChange={e => update('max_years', e.target.value)} className="settings-input" />
        </div>

        <ChipInput
          label={`Preferred cities (optional, up to ${MAX_CITIES})`}
          values={form.preferred_cities}
          onChange={value => update('preferred_cities', value)}
          suggestions={cityOptions}
          resolve={resolveCity}
          placeholder="e.g. Bengaluru"
          help="Widens the LinkedIn search: your roles are also searched in each city, within a few hours of saving. Leave empty to search all of India. Your job list is not limited to these cities."
          maxItems={MAX_CITIES}
        />
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
