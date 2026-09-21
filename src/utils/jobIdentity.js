export function collectJobUpdateIds(target, rows = []) {
  if (!target) return []

  const targetIds = new Set([target.id])

  const matches = rows.filter(row => {
    if (!row || row.id === target.id) return false

    if (target.company_id != null && row.company_id != null && target.company_id === row.company_id && target.job_id && row.job_id && target.job_id === row.job_id) {
      return true
    }

    if (target.url && row.url && target.url === row.url) {
      return true
    }

    return false
  })

  matches.forEach(row => targetIds.add(row.id))
  return Array.from(targetIds)
}
