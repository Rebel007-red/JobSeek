import { useEffect, useId, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { ChipInput } from '../common/ChipInput'
import { EXPERIENCE_LEVELS, LEVEL_YEARS, facetOptions } from '../../utils/gold'
import { MUTE_LIMITS, muteRuleProblem } from '../../utils/entries'

const toLists = (profile) => ({
  companies: profile?.muted_companies || [],
  titleWords: profile?.muted_title_words || [],
  levels: profile?.muted_levels || [],
})

const sameLists = (a, b) => ['companies', 'titleWords', 'levels'].every(kind => a[kind].join('\n') === b[kind].join('\n'))

// Typed entries are checked like the server checks them (saveMuteRules), so most mistakes show before saving
const resolverFor = (kind) => (text) => {
  const problem = muteRuleProblem(kind, text)
  return problem ? { blocked: `"${text.slice(0, 30)}": ${problem}` } : { value: text }
}

// Mute rules: untracked jobs of these companies, with these words in the title or at these levels are left out of the
// lists (app.user_jobs muted_by). profile / onSave from useProfile (saveMuteRules).
export function MuteRulesPanel({ profile, onSave, onOpenProfile }) {
  const [form, setForm] = useState(() => toLists(profile))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [companyNames, setCompanyNames] = useState([])
  const levelsId = useId()

  // A newer copy of the profile (cache, then server) replaces the form until you change something
  const saved = useMemo(() => toLists(profile), [profile])
  useEffect(() => {
    if (!dirty) setForm(saved)
  }, [saved, dirty])

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

  const update = (kind, value) => {
    setForm(prev => ({ ...prev, [kind]: value }))
    setDirty(true)
    setMessage(null)
  }

  const toggleLevel = (level) => update('levels', form.levels.includes(level)
    ? form.levels.filter(item => item !== level)
    // kept in EXPERIENCE_LEVELS order
    : EXPERIENCE_LEVELS.filter(item => item === level || form.levels.includes(item)))

  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      await onSave(form)
      setDirty(false)
      setMessage({ tone: 'success', text: 'Mute rules saved. Your job lists now leave these jobs out.' })
    } catch (err) {
      setMessage({ tone: 'error', text: err.message })
    } finally {
      setSaving(false)
    }
  }

  const total = form.companies.length + form.titleWords.length + form.levels.length

  return (
    <form onSubmit={save} className="settings-card profile-form">
      <div className="settings-card-header">
        <h3>Mute rules</h3>
        <small className="muted-text">{total === 0 ? 'No rules' : `${total} ${total === 1 ? 'rule' : 'rules'}`}</small>
      </div>
      <p className="settings-copy">
        Jobs matching a rule are left out of your lists, never ones you saved or applied to. The jobs page shows how many
        were left out, and you can review them there.
      </p>

      <div className="settings-form-grid">
        <ChipInput
          label={`Companies (up to ${MUTE_LIMITS.companies})`}
          values={form.companies}
          onChange={value => update('companies', value)}
          suggestions={companyNames}
          resolve={resolverFor('companies')}
          placeholder="e.g. Acme Consulting"
          help="Matches the company however it is written: Barclays also mutes Barclay and Barclays India."
          maxItems={MUTE_LIMITS.companies}
          disabled={saving}
        />

        <ChipInput
          label={`Title words (up to ${MUTE_LIMITS.titleWords})`}
          values={form.titleWords}
          onChange={value => update('titleWords', value)}
          resolve={resolverFor('titleWords')}
          placeholder="e.g. Urgent, Manager, SAP"
          help="Whole words or phrases, any case: Lead mutes “Lead Data Engineer” but not “Leading”."
          maxItems={MUTE_LIMITS.titleWords}
          disabled={saving}
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
                  disabled={saving}
                />
                {level}
                {LEVEL_YEARS[level] > 0 && <span className="muted-text">{LEVEL_YEARS[level]}+ yrs</span>}
              </label>
            ))}
          </div>
          <small id={`${levelsId}-help`}>
            The level the posting states or the pipeline detected; jobs without a level are never muted by it.
          </small>
        </fieldset>
      </div>

      {message && <p className={message.tone === 'error' ? 'settings-form-error' : 'settings-form-success'} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}

      <div className="settings-actions-row">
        {dirty && !sameLists(form, saved) && (
          <button type="button" className="secondary-button" onClick={() => { setForm(saved); setDirty(false); setMessage(null) }} disabled={saving}>
            Discard changes
          </button>
        )}
        <button type="submit" disabled={saving || !dirty || sameLists(form, saved)} className="primary-button">
          {saving ? 'Saving…' : 'Save mute rules'}
        </button>
      </div>
    </form>
  )
}
