// Job list layout ('list' | 'grid'), remembered per device.
const VIEW_KEY = 'jobseeker.view'

export function readView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

export function saveView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
}
