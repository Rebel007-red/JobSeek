import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { MANUAL_SOURCES, SCRAPE_SOURCES, SOURCE_LABELS, sourceLabel } from './sources.js'

const REGISTRY = fs.readFileSync(new URL('../../databricks/ats/registry.py', import.meta.url), 'utf8')

// The "name": value pairs of a Python dict literal in registry.py
function pyDict(name) {
  const body = new RegExp(`^${name} = \\{([\\s\\S]*?)^\\}`, 'm').exec(REGISTRY)
  assert.ok(body, `${name} not found in registry.py`)
  return Object.fromEntries([...body[1].matchAll(/"([^"]+)":\s*"([^"]*)"/g)].map(m => [m[1], m[2]]))
}

test('SOURCE_LABELS match databricks/ats/registry.py LABELS and ALL_SOURCES', () => {
  assert.deepEqual(SOURCE_LABELS, pyDict('LABELS'))
  const scripts = /^SCRIPT_SOURCES = \(([^)]*)\)/m.exec(REGISTRY)
  assert.ok(scripts, 'SCRIPT_SOURCES not found')
  assert.match(REGISTRY, /^ALL_SOURCES = \(\*SCRIPT_SOURCES, \*ADAPTERS\)/m)
  const all = [...[...scripts[1].matchAll(/"([^"]+)"/g)].map(m => m[1]), ...Object.keys(pyDict('ADAPTERS'))]
  assert.deepEqual(SCRAPE_SOURCES, all)
  for (const name of SCRAPE_SOURCES) assert.match(name, /^[a-z]+$/) // 02_ingest_silver splits file names on '_'
})

test('sourceLabel', () => {
  assert.equal(sourceLabel('successfactors'), 'SAP SuccessFactors')
  assert.equal(sourceLabel('SmartRecruiters'), 'SmartRecruiters')
  assert.equal(sourceLabel('phenom'), 'phenom')
  assert.equal(sourceLabel('constructor'), 'constructor')
  assert.equal(sourceLabel(null), '')
  assert.deepEqual(MANUAL_SOURCES, ['linkedin'])
})
