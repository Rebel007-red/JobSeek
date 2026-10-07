// Bulk selection of list rows (Space toggles, Shift+click or J/K extend from the anchor).
// A selection is { keys: Set<job_key>, anchor: job_key | null }; every function returns a new one.
export const EMPTY_SELECTION = { keys: new Set(), anchor: null }

export function toggleSelected(selection, key) {
  const keys = new Set(selection.keys)
  if (keys.has(key)) keys.delete(key)
  else keys.add(key)
  return { keys, anchor: key }
}

// Adds every row from the anchor (else `from`, else key itself) to key, in list order; the anchor stays
export function selectRange(selection, order, key, from) {
  const anchor = selection.anchor ?? from ?? key
  const start = order.indexOf(anchor)
  const end = order.indexOf(key)
  if (end < 0) return selection
  const keys = new Set(selection.keys)
  if (start < 0) keys.add(key)
  else order.slice(Math.min(start, end), Math.max(start, end) + 1).forEach(item => keys.add(item))
  return { keys, anchor: start < 0 ? key : anchor }
}

// Keeps only rows still in the list (a hidden or reloaded row leaves the selection)
export function pruneSelection(selection, order) {
  const present = new Set(order)
  const keys = new Set([...selection.keys].filter(key => present.has(key)))
  if (keys.size === selection.keys.size && (selection.anchor === null || present.has(selection.anchor))) return selection
  return { keys, anchor: present.has(selection.anchor) ? selection.anchor : null }
}

// The selected keys in list order
export function selectedInOrder(selection, order) {
  return order.filter(key => selection.keys.has(key))
}
