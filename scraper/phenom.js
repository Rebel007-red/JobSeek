/**
 * Phenom People handler
 *
 * Phenom People powers custom career sites. The API endpoint is:
 *   POST https://{careers-domain}/api/jobs/search
 *
 * The `api_url` in companies.json should be the full search endpoint, e.g.:
 *   https://careers.services.global.ntt/api/jobs/search
 */

const PAGE_SIZE = 20

export async function fetchPhenomJobs(company) {
  const { api_url } = company
  if (!api_url) {
    throw new Error(`Phenom company "${company.name}" is missing api_url in companies.json`)
  }

  const allJobs = []
  let pageNo = 0
  let total = null

  while (total === null || allJobs.length < total) {
    const res = await fetch(api_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; JobAggregator/1.0)',
      },
      body: JSON.stringify({
        country: [],
        category: [],
        city: [],
        state: [],
        location: [],
        type: [],
        lang: 'en',
        facets: ['country', 'category', 'city', 'state', 'location', 'type'],
        pageSize: PAGE_SIZE,
        pageNo,
      }),
    })

    if (!res.ok) {
      throw new Error(`Phenom API error for ${company.name}: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    const jobs = data.data || data.jobs || data.results || []

    if (total === null) {
      total = data.total || data.totalCount || data.count || jobs.length
    }

    if (jobs.length === 0) break

    const baseUrl = new URL(api_url).origin

    jobs.forEach((job) => {
      const jobPath = job.applyUrl || job.jobUrl || job.url || ''
      const absoluteUrl = jobPath.startsWith('http') ? jobPath : `${baseUrl}${jobPath}`

      allJobs.push({
        job_id: String(job.jobId || job.id || job.reqId || job.requisitionId || `${pageNo}-${allJobs.length}`),
        title: job.title || job.jobTitle || 'Untitled',
        location: job.location || job.city || job.country || null,
        department: job.category || job.department || job.function || null,
        url: absoluteUrl || baseUrl,
      })
    })

    pageNo++

    // Stop if we fetched everything
    if (allJobs.length >= total) break
  }

  return allJobs
}
