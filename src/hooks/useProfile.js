import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

// Your profile (roles, skills, years) in Databricks ops.user_profile; the API scores jobs against it per request.
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

  const save = useCallback(async (next) => {
    await api.saveProfile(next)
    setProfile(prev => ({ ...prev, ...next, updated_at: new Date().toISOString() }))
  }, [])

  return { profile, loading, error, reload, save }
}
