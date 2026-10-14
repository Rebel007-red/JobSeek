import { parseDay } from '../../utils/job'

const DAY_MS = 86_400_000

// The phone layout (DESIGN_SYSTEM.md "Layout", the MOBILE query): menus and sheets open as bottom sheets there
export const MOBILE_QUERY = '(max-width: 720px), (pointer: coarse) and (max-height: 500px), (pointer: coarse) and (max-width: 960px)'
export const isMobile = () => Boolean(globalThis.matchMedia?.(MOBILE_QUERY).matches)

let dayFormat = null // one shared formatter (building one per call is slow)

// A timestamp or a date-only value as a Date ('2026-10-20' is that local day, in every time zone); null when invalid
function toDate(value) {
  if (!value) return null
  const day = parseDay(value)
  if (day) return day
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

// "Oct 4"; null without a valid date
export function shortDay(value) {
  const date = toDate(value)
  if (!date) return null
  dayFormat ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return dayFormat.format(date)
}

// Whole local calendar days from a date to now (0 = today, never negative); null without a valid date
export function localDaysSince(value, now = Date.now()) {
  const date = toDate(value)
  if (!date) return null
  const today = new Date(now)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.max(Math.round((start - day) / DAY_MS), 0)
}
