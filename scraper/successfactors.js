/**
 * SAP SuccessFactors Career Site handler
 *
 * SAP SuccessFactors Career Site v2 exposes a public REST API at:
 *   GET https://{domain}/api/apply/v2/jobs?domain={domain}&start=0&num=100&locale=en_US
 *
 * The `slug` in companies.json should be the career site domain, e.g. "careers.ey.com"
 *
 * To verify a company uses SuccessFactors:
 *   Open their career page → view page source or DevTools → look for "successfactors.com"
 *   in script/CDN references (e.g. rmkcdn.successfactors.com)
 */

const PAGE_SIZE = 100

export async function fetchSuccessFactorsJobs(company) {
  const { slug } = company
  if (!slug) {
    throw new Error(
      `SuccessFactors company "${company.name}" is missing slug (career site domain) in companies.json`
    )
  }

  const domain = slug // e.g. "careers.ey.com"
  const allJobs = []
  let start = 0
  let total = null

  while (total === null || allJobs.length < total) {
    const url =
      `https://${domain}/api/apply/v2/jobs` +
      `?domain=${encodeURIComponent(domain)}&start=${start}&num=${PAGE_SIZE}&locale=en_US`

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json, text/javascript, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; JobAggregator/1.0)',
        Referer: `https://${domain}/`,
      },
    })

    if (!res.ok) {
      throw new Error(
        `SuccessFactors API error for ${company.name}: ${res.status} ${res.statusText}`
      )
    }

    const data = await res.json()
    const jobs = data.data || data.jobs || data.results || []

    if (total === null) {
      total = data.total || data.totalCount || data.count || jobs.length
    }

    if (jobs.length === 0) break

    jobs.forEach((job) => {
      const jobId = String(
        job.jobId || job.id || job.externalJobId || `${start}-${allJobs.length}`
      )
      const jobPath = job.applyUrl || job.jobUrl || job.detailUrl || ''
      const absoluteUrl = jobPath.startsWith('http')
        ? jobPath
        : `https://${domain}${jobPath || `/jobs/${jobId}`}`

      allJobs.push({
        job_id: jobId,
        title: job.title || job.jobTitle || 'Untitled',
        location: job.location || job.city || job.country || null,
        department: job.department || job.category || job.businessArea || null,
        url: absoluteUrl,
      })
    })

    start += jobs.length
    if (allJobs.length >= total) break
  }

  return allJobs
}
