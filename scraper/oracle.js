/**
 * Oracle Recruiting Cloud handler
 *
 * Oracle hosts career sites on Oracle Fusion HCM / Oracle Recruiting Cloud.
 * Each company has a unique Oracle Cloud instance URL.
 *
 * The REST API endpoint follows this pattern:
 *   GET {api_url}?expand=requisitionList&finder=findReqs;siteNumber={siteNumber},
 *       facetsList=LOCATIONS%3BTITLES%3BCATEGORIES&limit=25&offset=0
 *
 * To find a company's Oracle Recruiting API URL:
 *   1. Open their career page in Chrome → DevTools → Network → filter XHR/Fetch
 *   2. Search or browse jobs on the career page
 *   3. Look for a request to a URL containing "recruitingCEJobRequisitions"
 *   4. Copy the base URL (everything before the "?") as `api_url`
 *   5. Copy the `siteNumber` query param value as `slug`
 *
 * Example api_url: https://efts.fa.us2.oraclecloud.com/fscmRestApi/resources/latest/recruitingCEJobRequisitions
 * Example slug (siteNumber): CX_1
 */

const PAGE_SIZE = 25

export async function fetchOracleJobs(company) {
  const { api_url, slug: siteNumber } = company
  if (!api_url) {
    throw new Error(`Oracle company "${company.name}" is missing api_url in companies.json`)
  }
  if (!siteNumber) {
    throw new Error(`Oracle company "${company.name}" is missing slug (siteNumber) in companies.json`)
  }

  const allJobs = []
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const params = new URLSearchParams({
      expand: 'requisitionList',
      finder: `findReqs;siteNumber=${siteNumber},facetsList=LOCATIONS%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES`,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })

    const res = await fetch(`${api_url}?${params}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; JobAggregator/1.0)',
      },
    })

    if (!res.ok) {
      throw new Error(`Oracle API error for ${company.name}: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    const items = data.requisitionList || data.items || []

    if (items.length === 0) break

    items.forEach((job) => {
      const jobId = String(job.Id || job.id || job.requisitionNumber || `${offset}-${allJobs.length}`)
      // Build job URL from the career site domain + job path
      const careerBase = api_url.replace('/fscmRestApi/resources/latest/recruitingCEJobRequisitions', '')
      const jobUrl = job.ExternalDescriptionURL || job.jobUrl ||
        `${careerBase}/hcmUI/CandidateExperience/${siteNumber}/job/${jobId}`

      allJobs.push({
        job_id: jobId,
        title: job.Title || job.title || job.DisplayJobTitle || 'Untitled',
        location: job.PrimaryLocation || job.primaryLocation || job.location || null,
        department: job.JobFunction || job.jobFunction || job.category || null,
        url: jobUrl,
      })
    })

    offset += items.length
    hasMore = items.length === PAGE_SIZE
  }

  return allJobs
}
