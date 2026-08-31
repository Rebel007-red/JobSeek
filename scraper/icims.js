/**
 * iCIMS handler
 *
 * iCIMS hosts career sites at: https://{slug}.icims.com
 * The public JSON job feed endpoint is:
 *   GET https://{slug}.icims.com/jobs/search?pr=0&format=json
 *
 * To find a company's iCIMS slug:
 *   Open their career page, look at the URL — it will contain "{company}.icims.com"
 *   The slug is the subdomain portion (e.g. "careers-acme" from "careers-acme.icims.com")
 *
 * The `slug` field in companies.json should be just the subdomain, e.g. "careers-acme"
 */

const PAGE_SIZE = 100

export async function fetchICIMSJobs(company) {
  const { slug } = company
  if (!slug) {
    throw new Error(`iCIMS company "${company.name}" is missing slug in companies.json`)
  }

  const baseUrl = `https://${slug}.icims.com`
  const allJobs = []
  let page = 0
  let total = null

  while (total === null || allJobs.length < total) {
    const url = `${baseUrl}/jobs/search?pr=${page * PAGE_SIZE}&format=json&in_iframe=1`

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; JobAggregator/1.0)',
      },
    })

    if (!res.ok) {
      throw new Error(`iCIMS API error for ${company.name}: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    const jobs = data.searchResults || data.jobs || []

    if (total === null) {
      total = data.totalCount || data.count || data.total || jobs.length
    }

    if (jobs.length === 0) break

    jobs.forEach((job) => {
      const jobId = String(job.id || job.jobId || job.requisitionId || `${page}-${allJobs.length}`)
      const jobUrl = job.detailUrl || job.applyUrl || job.url || `${baseUrl}/jobs/${jobId}`

      allJobs.push({
        job_id: jobId,
        title: job.jobtitle || job.title || job.jobTitle || 'Untitled',
        location: job.joblocation || job.location || job.city || null,
        department: job.jobcategory || job.category || job.department || null,
        url: jobUrl.startsWith('http') ? jobUrl : `${baseUrl}${jobUrl}`,
      })
    })

    page++
    if (allJobs.length >= total) break
  }

  return allJobs
}
