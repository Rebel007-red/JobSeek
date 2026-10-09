// When the scheduled workflows start, and when the next new jobs should arrive (the caught-up line, the System tab).

// When the scheduled workflows start (UTC). keep in sync: the `cron` lines of .github/workflows/linkedin-databricks.yml
// ('0 */4 * * *'), databricks-scrapers.yml ('7 2,14 * * *') and publish-supabase.yml ('50 * * * *')
const EVERY_HOUR = Array.from({ length: 24 }, (_, hour) => hour)
export const SCHEDULES = [
  { label: 'LinkedIn scrape, then the pipeline and publish', hours: [0, 4, 8, 12, 16, 20], minute: 0 },
  { label: 'Workday and Greenhouse scrape', hours: [2, 14], minute: 7 },
  { label: 'Catch-up publish', hours: EVERY_HOUR, minute: 50 },
]

// The next start of a schedule after `now` (today or tomorrow, UTC)
export function nextStart({ hours, minute }, now = new Date()) {
  for (let day = 0; day <= 1; day += 1) {
    for (const hour of hours) {
      const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, hour, minute))
      if (at > now) return at
    }
  }
  return null
}

// A LinkedIn run's jobs are published about this long after it starts (estimated from the README: the 00:00 UTC run
// publishes around 05:50 IST; not measured)
export const PUBLISH_LAG_MINUTES = 20
const LAG_MS = PUBLISH_LAG_MINUTES * 60_000

// When the next new jobs should arrive: the first LinkedIn start s with s + lag > now, plus the lag
export function nextJobsAt(now = new Date()) {
  const start = nextStart(SCHEDULES[0], new Date(now.getTime() - LAG_MS))
  return new Date(start.getTime() + LAG_MS)
}

let clockFormat = null // shared: an Intl formatter per call is slow

// '1:50 PM' (local time)
export function clockLabel(date) {
  clockFormat ??= new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  return clockFormat.format(date)
}

// The caught-up state of an empty Inbox: "3 triaged, 1 applied today. Next jobs around 1:50 PM." (triaged = saved +
// applied + hidden today, summary.triaged_today; applied = applied today from the trend). Without either:
// "Next jobs around 1:50 PM."
export function caughtUpText({ triaged, applied } = {}, now = new Date()) {
  const next = `Next jobs around ${clockLabel(nextJobsAt(now))}.`
  const t = Number(triaged) || 0
  const a = Number(applied) || 0
  return t || a ? `${t} triaged, ${a} applied today. ${next}` : next
}

// The line under the last row: "That's all 37. Next jobs around 1:50 PM." on the Inbox, "That's all 37" elsewhere
export function endOfListText(count, tab, now = new Date()) {
  const all = `That's all ${Number(count) || 0}`
  return tab === 'inbox' ? `${all}. Next jobs around ${clockLabel(nextJobsAt(now))}.` : all
}
