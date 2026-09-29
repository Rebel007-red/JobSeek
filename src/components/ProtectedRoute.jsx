import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { clearApiCache } from '../lib/api'

// Renders the page only with a Supabase session (no API calls while signed out); sends you to /login otherwise.
export function ProtectedRoute({ children }) {
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setReady(true)
      else navigate('/login', { replace: true })
    })

    // Sign-out (this tab or another) and token expiry
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) return
      clearApiCache()
      navigate('/login', { replace: true })
    })

    return () => subscription.unsubscribe()
  }, [navigate])

  return ready ? children : null
}
