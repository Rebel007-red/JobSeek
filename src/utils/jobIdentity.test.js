import test from 'node:test'
import assert from 'node:assert/strict'

import { collectJobUpdateIds } from './jobIdentity.js'

test('collectJobUpdateIds keeps the current job and matching duplicates', () => {
  const target = { id: 'a1', company_id: 'company-1', job_id: 'job-42', url: 'https://example.com/a' }
  const rows = [
    { id: 'b2', company_id: 'company-1', job_id: 'job-42', url: 'https://example.com/b' },
    { id: 'c3', company_id: 'other', job_id: 'job-99', url: 'https://example.com/c' },
  ]

  assert.deepEqual(collectJobUpdateIds(target, rows), ['a1', 'b2'])
})

test('collectJobUpdateIds still includes the target row when there are no matches', () => {
  const target = { id: 'a1', company_id: 'company-1', job_id: 'job-42', url: 'https://example.com/a' }
  const rows = [
    { id: 'b2', company_id: 'company-1', job_id: 'job-99', url: 'https://example.com/b' },
  ]

  assert.deepEqual(collectJobUpdateIds(target, rows), ['a1'])
})
