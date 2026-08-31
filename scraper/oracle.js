/**
 * Oracle Recruiting Cloud handler
 *
 * Oracle hosts career sites on Oracle Fusion HCM.
 * REST API: GET {host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *
 * The `api_url` in companies.json is the career site base URL, e.g.:
 *   https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001
 *
 * The `slug` is the siteNumber visible in that URL (e.g. CX_1001).
 *
 * To find these: open the company career page ? DevTools ? Network ? XHR/Fetch
 * ? look for a request containing "recruitingCEJobRequisitions" ? copy the
 * host+path and the siteNumber= param.
 */

const PAGE_SIZE = 100

export async function fetchOracleJobs(company) {
  const { api_url, slug: siteNumber } = company
  if (!api_url) {
    throw new Error(`Oracle company "${company.name}" is missing api_url in companies.json`)
  }
  if (!siteNumber) {
    throw new Error(`Oracle company "${company.name}" is missing slug (siteNumber) in companies.json`)
  }

  // Derive the REST API base from the career site URL
  // e.g. https://jpmc.fa.oraclecloud.com/hcmUI/... -> https://jpmc.fa.oraclecloud.com
  const host = new URL(api_url).origin
  const restBase = `${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`

  const allJobs = []
  let offset = 0
  let total = null

  while (total === null || allJobs.length < total) {
    const params = new URLSearchParams({
      expand: 'requisitionList',
      finder: `findReqs;siteNumber=${siteNumber},facetsList=TITLES%3BCATEGORIES%3BLOCATIONS`,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })

    const res = await fetch(`${restBase}?${params}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    })

    if (!res.ok) {
      throw new Error(`Oracle API error for ${company.name}: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()

    // Oracle wraps everything in items[0] which contains metadata + requisitionList
    const meta = data.items?.[0]
    if (!meta) break

    if (total === null) {
      total = meta.TotalJobsCount || 0
    }

    const jobs = meta.requisitionList || []
    if (jobs.length === 0) break

    jobs.forEach((job) => {
      const jobId = String(job.Id || `${offset}-${allJobs.length}`)
      // Build canonical job page URL
      const jobUrl = `${api_url.replace(/\/+$/, '')}/job/${jobId}`

      allJobs.push({
        job_id: jobId,
        title: job.Title || 'Untitled',
        location: job.PrimaryLocation || null,
        department: job.JobFamily || job.JobFunction || job.Department || null,
        url: jobUrl,
        posted_at: job.PostedDate || null,
      })
    })

    offset += jobs.length
    if (allJobs.length >= total) break
  }

  return allJobs
}
