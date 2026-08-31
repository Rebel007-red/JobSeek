/**
 * Greenhouse handler
 * Greenhouse public boards API: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 * No auth required for public job boards.
 */

export async function fetchGreenhouseJobs(company) {
  const { slug } = company;
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Greenhouse API error for ${company.name}: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  return (data.jobs || []).map((job) => ({
    job_id: String(job.id),
    title: job.title || 'Untitled',
    location: job.location?.name || null,
    department: job.departments?.[0]?.name || null,
    url: job.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${job.id}`,
  }));
}
