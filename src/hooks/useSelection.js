import { useCallback, useEffect, useMemo, useState } from 'react'
import { EMPTY_SELECTION, pruneSelection, selectRange, selectedInOrder, toggleSelected } from '../utils/selection'

// Bulk selection of list rows (#12). order = the job keys on screen in list order, memoised (rows that leave it leave
// the selection). toggle(key) is Space or a checkbox; extendTo(key, from) is Shift+click or J/K (from = the current
// row when nothing is anchored yet). keys are the selected job keys in list order.
export function useSelection(order) {
  const [selection, setSelection] = useState(EMPTY_SELECTION)

  useEffect(() => {
    setSelection(prev => pruneSelection(prev, order))
  }, [order])

  const toggle = useCallback((key) => setSelection(prev => toggleSelected(prev, key)), [])
  const extendTo = useCallback((key, from) => setSelection(prev => selectRange(prev, order, key, from)), [order])
  const clear = useCallback(() => setSelection(prev => (prev.keys.size || prev.anchor ? EMPTY_SELECTION : prev)), [])
  const isSelected = useCallback((key) => selection.keys.has(key), [selection])
  const keys = useMemo(() => selectedInOrder(selection, order), [selection, order])

  return { keys, count: keys.length, isSelected, toggle, extendTo, clear, anchor: selection.anchor }
}
