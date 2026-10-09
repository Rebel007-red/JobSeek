import test from 'node:test'
import assert from 'node:assert/strict'

import { thud, tick } from './haptics.js'

function device({ reduced = false, vibrate } = {}) {
  const calls = []
  Object.defineProperty(globalThis, 'navigator', {
    value: vibrate === null ? {} : { vibrate: vibrate ?? (ms => calls.push(ms)) },
    configurable: true,
  })
  globalThis.matchMedia = query => ({ matches: reduced && query.includes('reduce') })
  return calls
}

test('tick and thud vibrate briefly', () => {
  const calls = device()
  tick()
  thud()
  assert.deepEqual(calls, [8, 18])
})

test('nothing under reduce motion, without vibrate, or when the browser refuses', () => {
  const calls = device({ reduced: true })
  tick()
  thud()
  assert.deepEqual(calls, [])
  device({ vibrate: null })
  assert.doesNotThrow(() => tick())
  device({ vibrate: () => { throw new Error('blocked') } })
  assert.doesNotThrow(() => thud())
})
