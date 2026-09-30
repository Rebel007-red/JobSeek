// The signed-in user, set by ProtectedRoute once Supabase has a session.
// Used to keep cached API results per user and to show admin-only settings.
let current = null

export function setSessionUser(user) {
  current = user
    ? { id: user.id, email: user.email || '', isAdmin: user.app_metadata?.role === 'admin' }
    : null
}

export function sessionUser() {
  return current
}
