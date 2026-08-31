import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export function ProtectedRoute({ children }) {
  const navigate = useNavigate()

  useEffect(() => {
    // Check session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate('/login', { replace: true })
    })

    // Listen for auth state changes (logout, token expiry)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) navigate('/login', { replace: true })
    })

    return () => subscription.unsubscribe()
  }, [navigate])

  return children
}
