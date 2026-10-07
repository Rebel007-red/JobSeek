import test from 'node:test'
import assert from 'node:assert/strict'

import { TRACKED_CSV_COLUMNS, toCsv, trackedCsvFilename } from './csv.js'

test('toCsv quotes per RFC 4180 and ends lines with CRLF', () => {
  const csv = toCsv(
    [{ a: 'plain', b: 'with, comma' }, { a: 'say "hi"', b: 'two\nlines' }, { a: null, b: undefined }],
    [{ key: 'a', label: 'A' }, { key: 'b', label: 'B, too' }],
  )
  assert.equal(csv, 'A,"B, too"\r\nplain,"with, comma"\r\n"say ""hi""","two\nlines"\r\n,')
})

test('toCsv keeps spreadsheet formulas from running', () => {
  const rows = [{ v: '=HYPERLINK("x")' }, { v: '+1' }, { v: '-2' }, { v: '@SUM(A1)' }, { v: '\tx' }, { v: '\rx' }, { v: -3 }, { v: 'a=b' }]
  const lines = toCsv(rows, [{ key: 'v', label: 'V' }]).split('\r\n').slice(1)
  assert.deepEqual(lines, [`"'=HYPERLINK(""x"")"`, "'+1", "'-2", "'@SUM(A1)", "'\tx", `"'\rx"`, '-3', 'a=b'])
})

test('toCsv formats cells and joins lists', () => {
  const csv = toCsv([{ n: 2, list: ['x', 'y'] }], [{ key: 'n', label: 'N', format: n => n * 2 }, { key: 'list', label: 'L' }])
  assert.equal(csv, 'N,L\r\n4,x; y')
})

test('the applications export has the agreed columns', () => {
  assert.deepEqual(TRACKED_CSV_COLUMNS.map(column => column.label), [
    'Title', 'Company', 'Location', 'City', 'Status', 'Applied on', 'Status changed', 'Follow up', 'Fit', 'Posting open',
    'Source', 'Link', 'Note',
  ])
  const csv = toCsv([{
    title: 'Data Engineer', company_name: 'Acme', application_status: 'interviewing', applied_at: '2026-10-04T10:00:00Z',
    next_action_at: '2026-10-12', is_active: false, job_url: '#', fit_score: 81, note: '=cmd',
  }], TRACKED_CSV_COLUMNS)
  const cells = csv.split('\r\n')[1].split(',')
  assert.equal(cells[4], 'Interviewing')
  assert.match(cells[5], /^2026-10-0[45]$/)
  assert.equal(cells[7], '2026-10-12')
  assert.equal(cells[8], '81')
  assert.equal(cells[9], 'No')
  assert.equal(cells[11], '')
  assert.equal(cells[12], "'=cmd")
  assert.equal(trackedCsvFilename(new Date(2026, 9, 7)), 'jobseeker-applications-2026-10-07.csv')
})
