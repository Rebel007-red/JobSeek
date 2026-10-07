// The undo history behind the u key and the toast's Undo button: the newest UNDO_MAX actions of the last 10 minutes.
export const UNDO_MAX = 5
export const UNDO_TTL_MS = 10 * 60_000

// entries: [{ undo, label, at }], oldest first. Each function returns a new array.
export function pruneUndo(entries, now = Date.now()) {
  return entries.filter(entry => now - entry.at < UNDO_TTL_MS).slice(-UNDO_MAX)
}

export function pushUndo(entries, undo, label = '', now = Date.now()) {
  return pruneUndo([...entries, { undo, label, at: now }], now)
}

// -> [newest entry or null, the rest]
export function popUndo(entries, now = Date.now()) {
  const live = pruneUndo(entries, now)
  return live.length ? [live[live.length - 1], live.slice(0, -1)] : [null, live]
}
