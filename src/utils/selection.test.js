import test from 'node:test'
import assert from 'node:assert/strict'

import { EMPTY_SELECTION, pruneSelection, selectRange, selectedInOrder, toggleSelected } from './selection.js'

const order = ['a', 'b', 'c', 'd', 'e']
const keys = (selection) => selectedInOrder(selection, order)

test('toggle and range selection', () => {
  let selection = toggleSelected(EMPTY_SELECTION, 'b')
  assert.deepEqual(keys(selection), ['b'])
  selection = selectRange(selection, order, 'd')
  assert.deepEqual(keys(selection), ['b', 'c', 'd'])
  assert.equal(selection.anchor, 'b')
  // ranges go both ways from the anchor and add to what is selected
  selection = selectRange(selection, order, 'a')
  assert.deepEqual(keys(selection), ['a', 'b', 'c', 'd'])
  selection = toggleSelected(selection, 'c')
  assert.deepEqual(keys(selection), ['a', 'b', 'd'])
  assert.equal(selection.anchor, 'c')
})

test('J/K extend from the current row when nothing is anchored', () => {
  let selection = selectRange(EMPTY_SELECTION, order, 'c', 'b')
  assert.deepEqual(keys(selection), ['b', 'c'])
  selection = selectRange(selection, order, 'd')
  assert.deepEqual(keys(selection), ['b', 'c', 'd'])
  assert.equal(selectRange(selection, order, 'zz'), selection)
})

test('rows that leave the list leave the selection', () => {
  const selection = selectRange(toggleSelected(EMPTY_SELECTION, 'a'), order, 'c')
  const pruned = pruneSelection(selection, ['b', 'c', 'd'])
  assert.deepEqual(selectedInOrder(pruned, ['b', 'c', 'd']), ['b', 'c'])
  assert.equal(pruned.anchor, null)
  assert.equal(pruneSelection(pruned, ['b', 'c', 'd']), pruned)
})
