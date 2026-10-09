// "Since your last visit" bookkeeping for hooks/useVisit.js, per user on this device:
// localStorage['jobseeker:visit:<uid>'] = { pingAt, since, pending: { opened, promptYes, promptNo, promptSaved } }
// pingAt: when this device's last ping was answered (ms, 0 = never); since: the ISO time of the previous visit for the
// visit going on now (null = a first visit, undefined = not known); pending: counters not sent yet.
export const VISIT_COUNTERS = ['opened', 'promptYes', 'promptNo', 'promptSaved']

const memory = new Map() // storage key -> entry, for when localStorage is unavailable

export const visitKey = (uid) => `jobseeker:visit:${uid || 'anon'}`

export function emptyPending() {
  return Object.fromEntries(VISIT_COUNTERS.map(counter => [counter, 0]))
}

// A stored value as a clean entry (anything broken reads as nothing stored)
export function normalizeVisit(value) {
  const pending = emptyPending()
  for (const counter of VISIT_COUNTERS) {
    const count = Number(value?.pending?.[counter])
    if (Number.isInteger(count) && count > 0) pending[counter] = count
  }
  const pingAt = Number(value?.pingAt)
  const since = value?.since === null || typeof value?.since === 'string' ? value.since : undefined
  return { pingAt: Number.isFinite(pingAt) && pingAt > 0 ? pingAt : 0, since, pending }
}

export function readVisit(key) {
  let value = memory.get(key) ?? null
  try {
    const raw = localStorage.getItem(key)
    if (raw) value = JSON.parse(raw)
  } catch {
    // storage unavailable or broken: the memory copy (if any)
  }
  return normalizeVisit(value)
}

export function saveVisit(key, entry) {
  memory.set(key, entry)
  try {
    localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    // the memory copy still works for this tab
  }
}

// A new visit when this device has not pinged for gapMs (pingAt approximates the server's last_list_seen_at)
export const isNewVisit = (entry, now, gapMs) => !entry.pingAt || now - entry.pingAt >= gapMs

// What `since` is before the server answers: on a new visit the last ping of this device, else (a reload, a second tab)
// the visit's stored value; undefined with nothing stored
export function localSince(entry, now, gapMs) {
  if (!entry.pingAt) return entry.since
  return isNewVisit(entry, now, gapMs) ? new Date(entry.pingAt).toISOString() : entry.since
}

// Whether to ping now: null while throttled (a ping answered less than everyMs ago), else { newVisit, sent } with the
// counters to send (at most maxCount each; the rest waits for the next ping)
export function planPing(entry, now, { gapMs, everyMs, maxCount }) {
  // A pingAt in the future (the device clock was turned back) does not throttle
  if (entry.pingAt && now >= entry.pingAt && now - entry.pingAt < everyMs) return null
  const sent = Object.fromEntries(VISIT_COUNTERS.map(counter => [counter, Math.min(entry.pending[counter], maxCount)]))
  return { newVisit: isNewVisit(entry, now, gapMs), sent }
}

// The entry after an answered ping. latest = the entry as stored now (counters recorded during the call stay pending).
// On a new visit, or with no since known, since becomes the server's previous_seen_at (it knows the other devices);
// otherwise the visit keeps its since.
export function afterPing(latest, { newVisit, sent }, previousSeenAt, now) {
  const pending = emptyPending()
  for (const counter of VISIT_COUNTERS) pending[counter] = Math.max(0, latest.pending[counter] - (sent[counter] || 0))
  const since = newVisit || latest.since === undefined ? previousSeenAt ?? null : latest.since
  return { pingAt: now, since, pending }
}

// One more of a counter
export function addCount(entry, counter) {
  if (!VISIT_COUNTERS.includes(counter)) return entry
  return { ...entry, pending: { ...entry.pending, [counter]: entry.pending[counter] + 1 } }
}
