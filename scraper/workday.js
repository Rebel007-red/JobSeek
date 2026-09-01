/**
 * Workday handler
 *
 * Workday does not have one universal public API — each tenant has its own URL.
 * The standard undocumented JSON endpoint most Workday career sites expose is:
 *   POST {api_url}
 *   Body: { "appliedFacets": {}, "limit": 20, "offset": 0, "searchText": "" }
 *
 * The api_url for each company must be provided in companies.json.
 * Format: https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{path}/jobs
 *
 * To find the URL: open the company's careers page, open DevTools → Network,
 * filter by "jobs", and look for a POST request to a myworkdayjobs.com URL.
 */

const PAGE_SIZE = 20;

export async function fetchWorkdayJobs(company) {
  const { api_url } = company;
  if (!api_url) {
    throw new Error(`Workday company "${company.name}" is missing api_url in companies.json`);
  }

  const allJobs = [];
  let offset = 0;
  let total = null;

  while (total === null || offset < total) {
    const res = await fetch(api_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; JobAggregator/1.0)',
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: PAGE_SIZE,
        offset,
        searchText: '',
      }),
    });

    if (!res.ok) {
      throw new Error(`Workday API error for ${company.name}: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const postings = data.jobPostings || [];

    if (total === null) {
      total = data.total || postings.length;
    }

    postings.forEach((job) => {
      const tenantBase = api_url.split('/wday/')[0]
      // Extract board name from: /wday/cxs/{tenant}/{board}/jobs
      const boardName = api_url.split('/wday/cxs/')[1]?.split('/')?.[1] || ''
      const careerBase = boardName ? `${tenantBase}/en-US/${boardName}` : tenantBase
      const jobPath = job.externalPath || ''
      // Only store properly formatted dates — Workday sometimes returns "Posted X Days Ago"
      const rawDate = job.postedOn || null
      const posted_at = rawDate && /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate : null
      allJobs.push({
        job_id: job.bulletFields?.[0] || job.title + '-' + offset,
        title: job.title || 'Untitled',
        location: job.locationsText || null,
        department: job.jobFamilyGroup || null,
        url: jobPath ? `${careerBase}${jobPath}` : careerBase,
        posted_at,
      });
    });

    offset += postings.length;

    // Safety: stop if we got an empty page
    if (postings.length === 0) break;
  }

  return allJobs;
}
