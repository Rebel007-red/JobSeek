import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

// Fit profile stored in Databricks ops.user_profile (drives fit_score in gold.jobs).
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
