import test from 'node:test'
import assert from 'node:assert/strict'

import { UNDO_MAX, UNDO_TTL_MS, popUndo, pruneUndo, pushUndo } from './undoStack.js'

test('the undo stack keeps the newest 5 actions of the last 10 minutes', () => {
  let entries = []
  for (let i = 1; i <= 7; i += 1) entries = pushUndo(entries, () => i, `step ${i}`, i * 1000)
  assert.equal(entries.length, UNDO_MAX)
  assert.deepEqual(entries.map(entry => entry.label), ['step 3', 'step 4', 'step 5', 'step 6', 'step 7'])

  const [newest, rest] = popUndo(entries, 8000)
  assert.equal(newest.label, 'step 7')
  assert.equal(rest.length, 4)
  const [next] = popUndo(rest, 8000)
  assert.equal(next.label, 'step 6')

  // older than 10 minutes: gone
  assert.deepEqual(pruneUndo(entries, 3000 + UNDO_TTL_MS).map(entry => entry.label), ['step 4', 'step 5', 'step 6', 'step 7'])
  assert.deepEqual(popUndo(entries, 8000 + UNDO_TTL_MS), [null, []])
  assert.deepEqual(popUndo([]), [null, []])
})
