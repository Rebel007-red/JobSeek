// CSV export (RFC 4180: quoted when needed, CRLF line ends). A cell starting with = + - @ (or a tab or CR) is prefixed
// with ' so a spreadsheet shows it as text instead of running it as a formula.
import { statusLabel } from './gold.js'
import { localDay } from './job.js'

const FORMULA_START = /^[=+\-@\t\r]/

function cell(value) {
  if (value === null || value === undefined) return ''
  let text = Array.isArray(value) ? value.join('; ') : String(value)
  if (typeof value !== 'number' && FORMULA_START.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

// columns: [{ key, label, format?(value, row) }]
export function toCsv(rows, columns) {
  const lines = [columns.map(column => cell(column.label))]
  for (const row of rows || []) {
    lines.push(columns.map(column => cell(column.format ? column.format(row?.[column.key], row) : row?.[column.key])))
  }
  return lines.map(line => line.join(',')).join('\r\n')
}

// Saves the text as a file (UTF-8 with a BOM, so Excel reads non-ASCII names correctly)
export function downloadCsv(filename, text) {
  const blob = new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked later: Safari and Firefox can still be reading the blob right after click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

// A timestamp or date as the local 'YYYY-MM-DD' ('' when missing)
function day(value) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value)
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : localDay(date)
}

// The Applied tab's export of api.trackedJobs() rows
export const TRACKED_CSV_COLUMNS = [
  { key: 'title', label: 'Title' },
  { key: 'company_name', label: 'Company' },
  { key: 'location', label: 'Location' },
  { key: 'city', label: 'City' },
  { key: 'application_status', label: 'Status', format: statusLabel },
  { key: 'applied_at', label: 'Applied on', format: day },
  { key: 'status_updated_at', label: 'Status changed', format: day },
  { key: 'next_action_at', label: 'Follow up', format: day },
  { key: 'fit_score', label: 'Fit' },
  { key: 'is_active', label: 'Posting open', format: value => (value === false ? 'No' : 'Yes') },
  { key: 'source', label: 'Source' },
  { key: 'job_url', label: 'Link', format: value => (value && value !== '#' ? value : '') },
  { key: 'note', label: 'Note' },
]

export function trackedCsvFilename(date = new Date()) {
  return `jobseeker-applications-${localDay(date)}.csv`
}
