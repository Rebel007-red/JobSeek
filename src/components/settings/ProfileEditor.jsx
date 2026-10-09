import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { ChipInput } from '../common/ChipInput'
import { EXPERIENCE_HIDE_GAP, FIT_PARTS, MATCH_MIN_FIT } from '../../utils/gold'
import { PROFILE_LIMITS, alsoSkillProblem, entryProblem } from '../../utils/entries'

// Same limits as the API
const { roles: MAX_ROLES, skills: MAX_SKILLS, cities: MAX_CITIES, alsoSkills: MAX_ALSO_SKILLS } = PROFILE_LIMITS
const NOT_SUPPORTED = 'is outside the supported roles (data, full stack / backend, DevOps and cloud)'
const CHECK_PENDING = 'custom · checked with the next update (every ~4 hours)'
// The fields a link can open (/settings?tab=profile#roles): the hide toast's "Edit my roles" / "Set My cities", the
// drawer's "Edit roles" / "Add a skill" / "Edit experience"
const PROFILE_ANCHORS = ['roles', 'skills', 'also-skills', 'experience', 'cities']
// "role up to 40 points, skills up to 45, experience up to 15" (the parts add up to the fit score)
const POINTS = FIT_PARTS.map((part, index) => `${part.label.toLowerCase()} up to ${Math.round(part.weight * 100)}${index === 0 ? ' points' : ''}`).join(', ')

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

// Scrolls to a field of the form and focuses its first control (its input, or a chip's remove button when it is full)
function focusField(form, anchor) {
  const field = anchor && form?.querySelector(`#${anchor}`)
  if (!field) return false
  field.scrollIntoView({ block: 'center' })
  field.querySelector('input, button, select, textarea')?.focus({ preventScroll: true })
  return true
}

// onboarding: first visit without a profile, or welcome=1 (a short intro, one-line help, the scoring rules folded away;
// the parent leaves the page after saving). anchor: one of PROFILE_ANCHORS to scroll to and focus once.
export function ProfileEditor({ profile, onSave, onboarding = false, anchor = '' }) {
  const [form, setForm] = useState(() => toForm(profile))
  const [refs, setRefs] = useState(null) // null until the lists load: no "custom" notes yet (they'd be wrong, then jump)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [dirty, setDirty] = useState(false)
  const minYearsId = useId()
  const maxYearsId = useId()
  const formRef = useRef(null)
  const anchorDone = useRef(false)

  // The field a link points at (#roles, #skills, …), once the form is on screen
  useEffect(() => {
    if (anchorDone.current || !PROFILE_ANCHORS.includes(anchor)) return
    anchorDone.current = true
    requestAnimationFrame(() => focusField(formRef.current, anchor))
  }, [anchor])

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
    return { active: 'custom', mapped: `counted as ${custom.duplicateOf}`, rejected: 'not supported' }[custom.status] || ''
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

  const scoring = (
    <p className="settings-copy">
      Every job gets a fit score from 0 to 100, in points that add up to it: {POINTS}. <strong>For you</strong> shows
      jobs in your roles or roles close to them with fit {MATCH_MIN_FIT}+, leaving out jobs that ask for over{' '}
      {EXPERIENCE_HIDE_GAP} years more than your maximum (stated, or implied by a level such as Lead/Manager).{' '}
      <strong>Everything</strong> lists every job, best fit first. Core skills count fully and Also know skills half as
      much, so they lift a job&rsquo;s score without outweighing your core skills.
    </p>
  )
  // One line of help per field while you set up your profile, the full text afterwards
  const help = (short, full) => (onboarding ? short : full)

  return (
    <form ref={formRef} onSubmit={save} className="settings-card profile-form">
      <div className="settings-card-header">
        <h3>{onboarding ? 'Welcome! Set up your profile' : 'Your profile'}</h3>
        {!onboarding && profile?.updated_at && <small className="muted-text">Last saved {new Date(profile.updated_at).toLocaleString()}</small>}
      </div>
      {onboarding ? (
        <>
          <p className="settings-copy">We&rsquo;ll score every new job 0-100 against this.</p>
          <details className="profile-scoring">
            <summary>How scores work</summary>
            {scoring}
          </details>
        </>
      ) : scoring}

      <div className="settings-form-grid">
        <ChipInput
          id="roles"
          label={`Roles (1–${MAX_ROLES}, most important first)`}
          values={form.target_roles}
          onChange={value => update('target_roles', value)}
          suggestions={roleOptions}
          resolve={resolveRole}
          validate={entryProblem}
          noteFor={roleNote}
          placeholder="e.g. Data Engineer"
          help={help(
            'Data, full stack / backend, DevOps and cloud roles. LinkedIn is searched for them.',
            'Data, full stack / backend, DevOps and cloud roles. Not in the list? Type it and add it as your own: it is checked with the next update (every ~4 hours), and until then jobs with it in the title count as your role. LinkedIn is also searched for these roles.',
          )}
          maxItems={MAX_ROLES}
          numbered
        />

        <ChipInput
          id="skills"
          label={`Core skills (1–${MAX_SKILLS}, count fully)`}
          values={form.skills}
          onChange={value => update('skills', value)}
          suggestions={skillOptions}
          resolve={resolveCoreSkill}
          validate={entryProblem}
          noteFor={skillNote}
          placeholder="e.g. PySpark, Azure, SQL"
          help={help(
            'The skills you would lead on.',
            'The skills you would lead on. Skill groups (e.g. Cloud) cover any skill in the group. Skills you add yourself are looked for in job descriptions from the next update (every ~4 hours).',
          )}
          maxItems={MAX_SKILLS}
        />

        <ChipInput
          id="also-skills"
          label={`Also know (up to ${MAX_ALSO_SKILLS}, count half)`}
          values={form.also_skills}
          onChange={value => update('also_skills', value)}
          suggestions={skillOptions}
          resolve={resolveAlsoSkill}
          validate={text => alsoSkillProblem(text, form.skills)}
          noteFor={skillNote}
          placeholder="e.g. Kafka, Docker"
          help={help(
            'Skills you can work with but would not lead on.',
            'Skills you can work with but would not lead on. A job asking for them scores higher, by half as much as a core skill, and they show under In your profile instead of Not in your profile.',
          )}
          maxItems={MAX_ALSO_SKILLS}
        />

        <div id="experience" className="settings-field">
          <label htmlFor={minYearsId}>Experience from (years)</label>
          <input id={minYearsId} type="number" min="0" max="40" value={form.min_years} onChange={e => update('min_years', e.target.value)} className="settings-input" />
        </div>
        <div className="settings-field">
          <label htmlFor={maxYearsId}>Experience to (years)</label>
          <input id={maxYearsId} type="number" min="0" max="40" value={form.max_years} onChange={e => update('max_years', e.target.value)} className="settings-input" />
        </div>

        <ChipInput
          id="cities"
          label={`Preferred cities (optional, up to ${MAX_CITIES})`}
          values={form.preferred_cities}
          onChange={value => update('preferred_cities', value)}
          suggestions={cityOptions}
          resolve={resolveCity}
          placeholder="e.g. Bengaluru"
          help={help(
            'Optional: LinkedIn is also searched in these cities.',
            'Widens the LinkedIn search: your roles are also searched in each city, from the next update (every ~4 hours). Leave empty to search all of India. Your job list is not limited to these cities.',
          )}
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
