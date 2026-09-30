import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authLinkType, supabase } from '../lib/supabase'
import { clearApiCache } from '../lib/api'
import { setSessionUser } from '../lib/session'

// Renders the page only with a Supabase session (no API calls while signed out); sends you to /login otherwise.
// An invite / recovery link signs you in first, so it is sent on to /set-password.
export function ProtectedRoute({ children }) {
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        navigate('/login', { replace: true })
        return
      }
      setSessionUser(session.user)
      if (['invite', 'recovery'].includes(authLinkType())) navigate('/set-password', { replace: true })
      else setReady(true)
    })

    // Sign-out (this tab or another), token expiry and token refresh
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setSessionUser(session.user)
        return
      }
      setSessionUser(null)
      clearApiCache()
      navigate('/login', { replace: true })
    })

    return () => subscription.unsubscribe()
  }, [navigate])

  return ready ? children : null
}
