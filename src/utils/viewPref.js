import { sessionUser } from '../lib/session'

// Job list preferences remembered on this device. Storage can be unavailable: the choice just isn't remembered.
function read(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable
  }
}

// Layout ('list' | 'grid'), per device
const VIEW_KEY = 'jobseeker.view'

export const readView = () => (read(VIEW_KEY) === 'grid' ? 'grid' : 'list')
export const saveView = (view) => save(VIEW_KEY, view)

// Scope ('match' = "For you" | 'all'), per user on this device
const scopeKey = () => `jobseeker:scope:${sessionUser()?.id || 'anon'}`

export const readScope = () => (read(scopeKey()) === 'all' ? 'all' : 'match')
export const saveScope = (scope) => save(scopeKey(), scope)
