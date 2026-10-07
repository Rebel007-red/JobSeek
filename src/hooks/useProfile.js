import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

// Your profile (roles, core and also-know skills, years, cities, mute rules) in Supabase (app.user_profile); jobs are
// scored against it per request.
// profile is null until you save one (new users are sent to onboarding).
export function useProfile() {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setProfile(await api.profile({
        onCached: (cached) => {
          setProfile(cached)
          setLoading(false)
        },
      }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  // next: { target_roles, skills, also_skills, min_years, max_years, preferred_cities }; a list left out keeps the saved one
  const save = useCallback(async (next) => {
    await api.saveProfile(next)
    setProfile(prev => ({ ...prev, ...next, updated_at: new Date().toISOString() }))
  }, [])

  // Mute rules ({ companies, titleWords, levels }; a list left out keeps the saved one)
  const applyMuteLists = useCallback((lists) => {
    setProfile(prev => prev && ({
      ...prev,
      muted_companies: lists.companies ?? prev.muted_companies,
      muted_title_words: lists.titleWords ?? prev.muted_title_words,
      muted_levels: lists.levels ?? prev.muted_levels,
    }))
  }, [])

  const saveMuteRules = useCallback(async (rules) => {
    const [row] = await api.saveMuteRules(rules)
    // The server's copy (trimmed, repeats dropped) when it sent one back
    applyMuteLists(row ? { companies: row.muted_companies, titleWords: row.muted_title_words, levels: row.muted_levels } : rules)
  }, [applyMuteLists])

  // kind: 'companies' | 'titleWords' | 'levels'
  const addMuteRule = useCallback(async (kind, value) => {
    const lists = await api.addMuteRule(kind, value)
    applyMuteLists(lists)
    return lists
  }, [applyMuteLists])

  const removeMuteRule = useCallback(async (kind, value) => {
    const lists = await api.removeMuteRule(kind, value)
    applyMuteLists(lists)
    return lists
  }, [applyMuteLists])

  return { profile, loading, error, reload, save, saveMuteRules, addMuteRule, removeMuteRule }
}
