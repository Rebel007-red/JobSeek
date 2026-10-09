import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { ChipInput } from '../common/ChipInput'
import { EXPERIENCE_LEVELS, LEVEL_YEARS, facetOptions } from '../../utils/gold'
import { MUTE_LIMITS, muteRuleProblem } from '../../utils/entries'

const KINDS = ['companies', 'titleWords', 'levels']

const toLists = (profile) => ({
  companies: profile?.muted_companies || [],
  titleWords: profile?.muted_title_words || [],
  levels: profile?.muted_levels || [],
})

const sameList = (a, b) => a.join('\n') === b.join('\n')
// Levels are kept in EXPERIENCE_LEVELS order
const ordered = (kind, list) => (kind === 'levels' ? EXPERIENCE_LEVELS.filter(level => list.includes(level)) : list)

// Typed entries are checked like the server checks them (saveMuteRules), so most mistakes show before saving
const resolverFor = (kind) => (text) => {
  const problem = muteRuleProblem(kind, text)
  return problem ? { blocked: `"${text.slice(0, 30)}": ${problem}` } : { value: text }
}

// The toast after a change: "Muted Acme", "Unmuted titles with “Urgent”", "Muted Senior jobs"
function changeMessage(kind, added, removed) {
  const verb = added.length ? 'Muted' : 'Unmuted'
  const values = added.length ? added : removed
  const many = values.length > 1
  if (kind === 'companies') return `${verb} ${many ? `${values.length} companies` : values[0]}`
  if (kind === 'titleWords') return `${verb} ${many ? `${values.length} title words` : `titles with “${values[0]}”`}`
  return `${verb} ${many ? `${values.length} levels` : `${values[0]} jobs`}`
}

// Mute rules: untracked jobs of these companies, with these words in the title or at these levels are left out of the
// lists (app.user_jobs muted_by). Every change saves right away (one save at a time, in order) and the toast offers
// Undo, which takes back just that change. profile / onSave from useProfile (saveMuteRules); showToast from useToast.
export function MuteRulesPanel({ profile, onSave, onOpenProfile, showToast }) {
  const [form, setForm] = useState(() => toLists(profile))
  const formRef = useRef(form) // the lists as last changed here (for queued saves and Undo)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [companyNames, setCompanyNames] = useState([])
  const queueRef = useRef(Promise.resolve())
  const pendingRef = useRef(0)
  const levelsId = useId()

  const saved = useMemo(() => toLists(profile), [profile])
  const savedRef = useRef(saved)
  savedRef.current = saved

  // A newer copy of the profile (cache, then server, then each save's answer) replaces the form between saves
  useEffect(() => {
    if (pendingRef.current) return
    formRef.current = saved
    setForm(saved)
  }, [saved])

  // Company names of the current jobs, as suggestions
  useEffect(() => {
    api.facets({ scope: 'all' })
      .then(rows => setCompanyNames(facetOptions(rows, 'company').map(option => option.value)))
      .catch(err => console.error('Failed to load company names:', err))
  }, [])

  if (!profile) {
    return (
      <div className="settings-card">
        <p className="settings-copy">Save your profile first: mute rules are kept with it.</p>
        <div className="settings-actions-row">
          <button type="button" className="primary-button compact-button" onClick={onOpenProfile}>Open profile</button>
        </div>
      </div>
    )
  }

  const setList = (kind, list) => {
    formRef.current = { ...formRef.current, [kind]: list }
    setForm(formRef.current)
  }

  // Saves one list after the saves before it; resolves to true when it was saved. A failed save puts back the saved
  // lists (the profile's copy) and says why.
  const persist = (kind, list) => {
    pendingRef.current += 1
    setBusy(true)
    setError('')
    const run = () => onSave({ [kind]: list })
    const result = queueRef.current.then(run, run)
    queueRef.current = result.catch(() => {})
    return result
      .then(() => true, err => {
        setError(`Could not save the mute rules: ${err.message}`)
        if (pendingRef.current === 1) {
          formRef.current = savedRef.current
          setForm(savedRef.current)
        }
        return false
      })
      .finally(() => {
        pendingRef.current -= 1
        if (!pendingRef.current) setBusy(false)
      })
  }

  // Undo of one change, applied to the lists as they are now (later changes stay)
  const undoChange = async (kind, added, removed) => {
    const current = formRef.current[kind]
    const next = ordered(kind, [...current.filter(item => !added.includes(item)), ...removed.filter(item => !current.includes(item))])
    if (sameList(next, current)) return
    setList(kind, next)
    if (!(await persist(kind, next))) throw new Error('Could not undo the mute rule change')
  }

  const change = async (kind, value) => {
    const before = formRef.current[kind]
    const next = ordered(kind, value)
    if (sameList(next, before)) return
    const added = next.filter(item => !before.includes(item))
    const removed = before.filter(item => !next.includes(item))
    setList(kind, next)
    if (await persist(kind, next)) showToast?.(changeMessage(kind, added, removed), () => undoChange(kind, added, removed))
  }

  const toggleLevel = (level) => change('levels', form.levels.includes(level)
    ? form.levels.filter(item => item !== level)
    : [...form.levels, level])

  const total = KINDS.reduce((sum, kind) => sum + form[kind].length, 0)

  return (
    <div className="settings-card profile-form">
      <div className="settings-card-header">
        <h3>Mute rules</h3>
        <small className="muted-text" role="status">
          {busy ? 'Saving…' : total === 0 ? 'No rules' : `${total} ${total === 1 ? 'rule' : 'rules'}`}
        </small>
      </div>
      <p className="settings-copy">
        Jobs a rule covers are muted: left out of your lists, but never jobs you saved or applied to. The jobs page shows
        how many are muted, and you can review them there. Changes save right away.
      </p>

      <div className="settings-form-grid">
        <ChipInput
          label={`Companies (up to ${MUTE_LIMITS.companies})`}
          values={form.companies}
          onChange={value => change('companies', value)}
          suggestions={companyNames}
          resolve={resolverFor('companies')}
          placeholder="e.g. Acme Consulting"
          help="However the company is written: Barclays also mutes Barclay and Barclays India."
          maxItems={MUTE_LIMITS.companies}
        />

        <ChipInput
          label={`Title words (up to ${MUTE_LIMITS.titleWords})`}
          values={form.titleWords}
          onChange={value => change('titleWords', value)}
          resolve={resolverFor('titleWords')}
          placeholder="e.g. Urgent, Manager, SAP"
          help="Whole words or phrases, any case: Lead mutes “Lead Data Engineer” but not “Leading”."
          maxItems={MUTE_LIMITS.titleWords}
        />

        <fieldset className="settings-field settings-field-full mute-levels" aria-describedby={`${levelsId}-help`}>
          <legend>Experience levels</legend>
          <div className="mute-level-list">
            {EXPERIENCE_LEVELS.map(level => (
              <label key={level} className={`pill-toggle ${form.levels.includes(level) ? 'active' : ''}`}>
                <input
                  type="checkbox"
                  checked={form.levels.includes(level)}
                  onChange={() => toggleLevel(level)}
                />
                {level}
                {LEVEL_YEARS[level] > 0 && <span className="muted-text">{LEVEL_YEARS[level]}+ yrs</span>}
              </label>
            ))}
          </div>
          <small id={`${levelsId}-help`}>
            The level the posting states or that we detected from it; jobs without a level are never muted by it.
          </small>
        </fieldset>
      </div>

      {error && <p className="settings-form-error" role="alert">{error}</p>}
    </div>
  )
}
