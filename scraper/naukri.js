/**
 * Naukri.com job scraper
 *
 * NOTE: Naukri's public jobapi/v3/search requires reCAPTCHA for unauthenticated
 * requests (returns 406 "recaptcha required"). Disabled until an auth solution is found.
 */

export async function fetchNaukriJobs(company) {
  throw new Error('Naukri API requires reCAPTCHA -- disabled')
}
