import { jobLink } from '../../utils/urlState'

// Shares a link that opens this job in the app: the system share sheet where there is one, else the clipboard
// ("Link copied"), else a message showing the link. notify(message) shows the outcome; a cancelled share shows nothing.
export async function shareJob(job, notify) {
  const url = jobLink(job.job_key)
  const text = [job.title, job.company_name].filter(Boolean).join(' at ')
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: job.title || 'Job', text, url })
      return
    } catch (err) {
      if (err?.name === 'AbortError') return
      // share sheet not allowed here (e.g. no user activation): fall back to the clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(url)
    notify('Link copied')
  } catch {
    notify(`Link: ${url}`)
  }
}
