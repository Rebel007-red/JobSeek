const NEW_JOB_MS = 2 * 24 * 3600 * 1000 // 2 days

// One shared formatter: toLocaleDateString builds a new Intl.DateTimeFormat on every call, which is slow per row.
let dayFormat = null

export function formatDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d)) return null
  dayFormat ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return dayFormat.format(d)
}

export function formatRelativeAge(dateStr) {
  if (!dateStr) return null

  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return null

  const diffMs = Date.now() - date.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)

  if (diffHours < 1) return 'Now'
  if (diffHours < 24) return `${Math.max(1, Math.round(diffHours))}h ago`

  const diffDays = Math.round(diffHours / 24)
  if (diffDays === 1) return '1d ago'
  if (diffDays < 7) return `${diffDays}d ago`

  return 'Older'
}

// "New" = first scraped within the last 2 days.
export function isNewJob(firstSeenAt) {
  return firstSeenAt ? Date.now() - new Date(firstSeenAt).getTime() < NEW_JOB_MS : false
}
