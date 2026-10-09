import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { authLinkType, supabase } from '../lib/supabase'
import { clearApiCache, onAccessDenied } from '../lib/api'
import { sessionUser, setSessionUser } from '../lib/session'
import { AccessDenied } from './layout/AccessDenied'

// Renders the page only with a Supabase session (no API calls while signed out); sends you to /login otherwise.
// An invite / recovery link signs you in first, so it is sent on to /set-password. The page you asked for (a shared
// /?job=<key> link) goes along as state.from, so LoginPage can return to it after sign-in.
// A signed-in account that is not on the allow list (any API call failing with "not allowed to use the job data") sees
// only the "No access yet" page instead of the page's own errors.
export function ProtectedRoute({ children }) {
  const navigate = useNavigate()
  const location = useLocation()
  const fromRef = useRef(location.pathname + location.search)
  const [ready, setReady] = useState(false)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    // Subscribed before the page mounts, so the page's first calls are covered
    const unsubscribeDenied = onAccessDenied(() => setDenied(true))

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        navigate('/login', { replace: true, state: { from: fromRef.current } })
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
      setDenied(false)
      clearApiCache()
      navigate('/login', { replace: true })
    })

    return () => {
      unsubscribeDenied()
      subscription.unsubscribe()
    }
  }, [navigate])

  if (!ready) return null
  return denied ? <AccessDenied email={sessionUser()?.email} /> : children
}
