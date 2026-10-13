// Settings > Companies: the careers / board link the admin pastes for a company -> the public.companies columns the
// scraper reads ({ slug, api_url }). One parser per ats_type; no network (the browser cannot call the boards: CORS).
// Anything that needs a fetch (a vanity career domain, a Workable /j/ job link) is resolved by the scraper when it runs,
// and its errors show as the company's "Failing" badge.
//
// keep in sync: source_columns() of databricks/ats/<type>.py (the answers for the 8 API / HTML boards are pinned by
// databricks/tests/ats/fixtures/<type>/url_cases.json, read by atsSources.test.js and by the Python tests), board_token()
// of databricks/greenhouse.py.
import { SOURCE_LABELS } from './sources.js'

// --- shared helpers ------------------------------------------------------------------------------------------------

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const SPACE_RE = /\s/

const trimmed = (value) => String(value ?? '').trim()
const stripSlashes = (text) => text.replace(/^\/+|\/+$/g, '')

// A URL (https:// is assumed when no scheme is given) as { url, host, parts, explicit }: parts = the non-empty path
// segments, explicit = the text had a scheme; null when it is not an http(s) URL
function parseUrl(text) {
  const explicit = text.includes('://')
  let url
  try {
    url = new URL(explicit ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return { url, host: url.hostname.toLowerCase(), parts: url.pathname.split('/').filter(Boolean), explicit }
}

// Python's urllib.parse.unquote: %XX decoded, a malformed sequence left as it is
function unquote(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run)
      } catch {
        return run
      }
    })
  }
}

// Python's urllib.parse.quote(text, safe=''): everything but letters, digits and _.-~ is percent-encoded
const quote = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)

const lowerList = (list) => list.map(part => part.toLowerCase())

// --- Greenhouse and Workday (own scrapers) ---------------------------------------------------------------------------

const BOARD_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

// Board token of a Greenhouse board URL (job-boards.greenhouse.io/stripe[/jobs/<id>], boards.greenhouse.io/stripe,
// the embed link with ?for=stripe), an API URL (boards-api.greenhouse.io/v1/boards/stripe/jobs) or a bare token;
// null when the value is none of these. keep in sync: board_token() in databricks/greenhouse.py
export function greenhouseBoardToken(raw) {
  const value = trimmed(raw)
  if (!value) return null
  const bare = stripSlashes(value)
  if (BOARD_TOKEN_RE.test(bare)) return bare
  let url
  try {
    url = new URL(value.includes('://') ? value : `https://${value.replace(/^\/+/, '')}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'greenhouse.io' && !host.endsWith('.greenhouse.io')) return null
  const parts = url.pathname.split('/').filter(Boolean)
  const first = (parts[0] || '').toLowerCase()
  let token
  if (first === 'v1') token = parts.length >= 3 && parts[1].toLowerCase() === 'boards' ? parts[2] : ''
  else if (first === 'embed') token = url.searchParams.get('for') || ''
  else token = parts[0] || ''
  return BOARD_TOKEN_RE.test(token) ? token : null
}

// Workday hosts its career sites on myworkdayjobs.com and, for some tenants, myworkdaysite.com
const WORKDAY_HOSTS = ['myworkdayjobs.com', 'myworkdaysite.com']

function workdayUrlOk(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && WORKDAY_HOSTS.some(base => host === base || host.endsWith(`.${base}`))
  } catch {
    return false
  }
}

// --- Lever (databricks/ats/lever.py) ---------------------------------------------------------------------------------

// 'v0' is the API path, not a site (api.lever.co/v0/postings/ with no site is rejected)
const LEVER_URL_RE = /^(?:https?:\/\/)?(?:jobs|api)\.(eu\.)?lever\.co\/(?:v0\/postings\/)?(?!v0(?:[/?#]|$))([A-Za-z0-9._-]+)/i
const LEVER_SITE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

function lever(value) {
  const text = trimmed(value)
  const match = LEVER_URL_RE.exec(text)
  let site = null
  let eu = false
  if (match) {
    site = match[2]
    eu = Boolean(match[1])
  } else if (LEVER_SITE_RE.test(stripSlashes(text))) {
    site = stripSlashes(text)
  }
  if (!site) return null
  return { slug: site, api_url: `https://api.${eu ? 'eu.' : ''}lever.co/v0/postings/${site}?mode=json` }
}

// --- Ashby (databricks/ats/ashby.py) ---------------------------------------------------------------------------------

const ASHBY_URL_RE = /^(?:https?:\/\/)?(?:jobs\.ashbyhq\.com|api\.ashbyhq\.com\/posting-api\/job-board)\/([A-Za-z0-9._%-]+)/i
const ASHBY_BOARD_RE = /^[A-Za-z0-9][A-Za-z0-9._% -]{0,99}$/
const ASHBY_RESERVED = new Set(['api', 'b', 'meeting']) // jobs.ashbyhq.com paths that are not boards

function ashby(value) {
  const text = trimmed(value)
  const match = ASHBY_URL_RE.exec(text)
  let raw
  if (match) raw = match[1]
  else if (ASHBY_BOARD_RE.test(stripSlashes(text))) raw = stripSlashes(text)
  else return null
  const board = unquote(raw).trim()
  if (!board || ASHBY_RESERVED.has(board.toLowerCase()) || board.includes('/')) return null
  return { slug: board, api_url: `https://api.ashbyhq.com/posting-api/job-board/${quote(board)}` }
}

// --- SmartRecruiters (databricks/ats/smartrecruiters.py) -------------------------------------------------------------

const SR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SR_BOARD_HOSTS = new Set(['jobs.smartrecruiters.com', 'careers.smartrecruiters.com', 'www.smartrecruiters.com',
  'smartrecruiters.com'])
// first path segments of the board hosts that are SmartRecruiters' own pages, not companies
const SR_RESERVED = new Set(['external-referrals', 'oneclick-ui', 'sr-jobs', 'search', 'app', 'account', 'privacy-policy',
  'legal', 'about', 'blog', 'resources', 'customers', 'product', 'pricing', 'contact', 'partners', 'careers', 'jobs'])

function smartRecruitersId(value) {
  const text = trimmed(value)
  if (!text) return null
  if (!text.includes('/') && !text.includes('.')) return SR_ID_RE.test(text) ? text : null
  const parsed = parseUrl(text)
  if (!parsed) return null
  const { host, parts } = parsed
  let candidate = null
  if (host === 'api.smartrecruiters.com') {
    if (parts[0] === 'v1' && parts[1] === 'companies' && parts.length > 2) candidate = parts[2]
  } else if (SR_BOARD_HOSTS.has(host) && parts.length && !SR_RESERVED.has(parts[0].toLowerCase())) {
    candidate = parts[0]
  }
  return candidate && SR_ID_RE.test(candidate) ? candidate : null
}

function smartRecruiters(value) {
  const id = smartRecruitersId(value)
  return id ? { slug: id, api_url: `https://api.smartrecruiters.com/v1/companies/${id}/postings` } : null
}

// --- Workable (databricks/ats/workable.py) ---------------------------------------------------------------------------

const WK_SUB_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/
const WK_CODE_RE = /^[A-Za-z0-9]{4,20}$/
// {x}.workable.com hosts that are Workable's own sites, not legacy company boards
const WK_NOT_ACCOUNTS = new Set(['www', 'apply', 'jobs', 'help', 'resources', 'api', 'blog', 'support', 'status',
  'careers-page', 'developers', 'workable'])

// { sub } for an account URL or bare name, { code } for an apply.workable.com/j/{code} link, null otherwise
function workableBoard(value) {
  const text = trimmed(value)
  if (!text) return null
  if (!text.includes('/') && !text.includes('.')) return WK_SUB_RE.test(text) ? { sub: text.toLowerCase() } : null
  const parsed = parseUrl(text)
  if (!parsed) return null
  const { host, parts } = parsed
  let sub = null
  if (host === 'apply.workable.com') {
    if (parts[0] === 'j') {
      const code = parts[1] || ''
      return WK_CODE_RE.test(code) ? { code } : null
    }
    if (parts[0] === 'api') {
      // /api/v1/widget/accounts/{sub}, /api/v3/accounts/{sub}/jobs, /api/v1/accounts/{sub}/...
      const at = parts.indexOf('accounts')
      if (at >= 0 && at + 1 < parts.length) sub = parts[at + 1]
    } else if (parts.length) {
      sub = parts[0]
    }
  } else if (host === 'www.workable.com') {
    if (parts[0] === 'api' && parts[1] === 'accounts' && parts.length > 2) sub = parts[2]
  } else if (host.endsWith('.workable.com') && host.split('.').length === 3) {
    const label = host.split('.')[0]
    if (!WK_NOT_ACCOUNTS.has(label)) sub = label
  }
  return sub && WK_SUB_RE.test(sub) ? { sub: sub.toLowerCase() } : null
}

function workable(value) {
  const board = workableBoard(value)
  if (board?.sub) return { slug: board.sub, api_url: `https://apply.workable.com/api/v1/widget/accounts/${board.sub}?details=true` }
  if (board?.code) return { slug: '', api_url: `https://apply.workable.com/j/${board.code}` }
  return null
}

// --- Oracle Recruiting Cloud (databricks/ats/oracle.py) --------------------------------------------------------------

const ORACLE_SITE_PATH_RE = /\/sites\/([^/?#]+)/i
const ORACLE_SITE_RE = /^[A-Za-z0-9_.-]{1,60}$/
const isOracleHost = (host) => host === 'oraclecloud.com' || host.endsWith('.oraclecloud.com')

function oracle(value) {
  const text = trimmed(value)
  if (!text || SPACE_RE.test(text)) return null
  const parsed = parseUrl(text)
  if (!parsed || !parsed.host || !parsed.host.includes('.')) return null
  const { url, host, explicit } = parsed
  if (isOracleHost(host)) {
    const match = ORACLE_SITE_PATH_RE.exec(url.pathname)
    const site = match && ORACLE_SITE_RE.test(match[1]) ? match[1] : null
    if (site) return { slug: site, api_url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}` }
    // an oraclecloud host without /sites/: the page is read at run time like a vanity domain
    return { slug: '', api_url: `https://${host}${url.pathname.replace(/\/+$/, '')}${url.search}` }
  }
  // a vanity career domain (or a page that links to one) must be a full https:// link; read at run time
  if (!explicit || url.protocol !== 'https:') return null
  return { slug: '', api_url: text }
}

// --- SAP SuccessFactors career sites (databricks/ats/successfactors.py) ----------------------------------------------

// The classic SuccessFactors hosts: robots.txt disallows everything there
const SF_CLASSIC_RE = /(^|\.)career\d*\.successfactors\.[a-z]+$|(^|\.)sapsf\.(com|eu|cn)$|(^|\.)successfactors\.(com|eu)$/

function successFactorsHost(value) {
  const text = trimmed(value)
  if (!text || SPACE_RE.test(text)) return null
  const parsed = parseUrl(text)
  if (!parsed || !HOST_RE.test(parsed.host)) return null
  return parsed.host
}

function successFactors(value) {
  const host = successFactorsHost(value)
  if (!host || SF_CLASSIC_RE.test(host)) return null
  return { slug: host, api_url: `https://${host}` }
}

// --- Darwinbox (databricks/ats/darwinbox.py) -------------------------------------------------------------------------

const DB_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.darwinbox\.(in|com)$/
const DB_COMPANY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function darwinbox(value) {
  const text = trimmed(value)
  if (!text || SPACE_RE.test(text)) return null
  const parsed = parseUrl(text)
  if (!parsed || !DB_HOST_RE.test(parsed.host)) return null
  const { url, host, parts } = parsed
  let companyId = 'main'
  if (parts.length >= 2 && parts[0].toLowerCase() === 'ms') {
    const section = parts[1].toLowerCase()
    if (section === 'candidatev2' || section === 'candidate') {
      if (parts.length >= 3 && parts[2].toLowerCase() !== 'careers') companyId = parts[2]
    } else if (section === 'candidateapi') {
      companyId = url.searchParams.get('companyId') || 'main'
    } else {
      return null
    }
  } else if (parts.length) {
    return null // another page of the tenant (login, admin): not a career link
  }
  if (!DB_COMPANY_ID_RE.test(companyId)) return null
  return { slug: companyId, api_url: `https://${host}/ms/candidateapi/${companyId === 'main' ? '' : `?companyId=${companyId}`}` }
}

// --- Keka (databricks/ats/keka.py) -----------------------------------------------------------------------------------

const KEKA_TENANT_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const KEKA_PORTAL_RE = /^[A-Za-z0-9_-]{1,64}$/
const KEKA_NOT_PORTALS = new Set(['', 'jobdetails', 'applyjob', 'content', 'api', 'jobs'])

// { host, tenant, portal, custom } of a Keka career / API link or a bare tenant name; null otherwise
function kekaBoard(value) {
  const text = trimmed(value)
  if (!text || SPACE_RE.test(text)) return null
  if (KEKA_TENANT_RE.test(text.toLowerCase()) && !text.includes('.')) {
    const tenant = text.toLowerCase()
    return { host: `${tenant}.keka.com`, tenant, portal: 'default', custom: false }
  }
  const parsed = parseUrl(text)
  if (!parsed || !HOST_RE.test(parsed.host)) return null
  const { url, host, parts, explicit } = parsed
  let portal = 'default'
  let tenant
  let custom
  if (host.endsWith('.keka.com')) {
    tenant = host.slice(0, -'.keka.com'.length)
    if (!KEKA_TENANT_RE.test(tenant)) return null
    if (parts.length && parts[0].toLowerCase() === 'careers') {
      const rest = parts.slice(1)
      if (rest.length >= 3 && lowerList(rest.slice(0, 2)).join('/') === 'api/jobs') portal = rest[2]
      else if (rest.length && !KEKA_NOT_PORTALS.has(rest[0].toLowerCase())) portal = rest[0]
    } else if (parts.length) {
      return null // robots allows only /careers/...: another page of the tenant is not a career link
    }
    custom = false
  } else {
    if (!explicit || url.protocol !== 'https:') return null // a custom domain must be a full https:// link
    tenant = host
    if (parts.length >= 3 && lowerList(parts.slice(0, 2)).join('/') === 'api/jobs') portal = parts[2]
    custom = true
  }
  if (!KEKA_PORTAL_RE.test(portal)) return null
  return { host, tenant, portal, custom }
}

function keka(value) {
  const board = kekaBoard(value)
  if (!board) return null
  return { slug: board.tenant, api_url: `https://${board.host}${board.custom ? '' : '/careers'}/api/jobs/${board.portal}/active` }
}

// --- the form ------------------------------------------------------------------------------------------------------

const label = (type) => SOURCE_LABELS[type] || type

// Per type: the field's label, placeholder, help, input type, parse(value) -> { slug, api_url } | null, and optional
// rejection hints [{ test(value), error }] tried before the generic "Paste the ... link" message. The admin form shows
// them in this order; LinkedIn last (it runs only by hand now).
export const ATS_FIELDS = {
  workday: {
    label: 'Workday jobs URL',
    placeholder: 'https://company.wd1.myworkdayjobs.com/en-US/Careers',
    help: 'The careers page on myworkdayjobs.com (or myworkdaysite.com) that lists the jobs (the scraper opens it like a browser).',
    type: 'url',
    // slug is left as it is (workday.py reads only api_url)
    parse: (value) => (workdayUrlOk(trimmed(value)) ? { api_url: trimmed(value) } : null),
    example: 'https://company.wd1.myworkdayjobs.com/en-US/Careers',
  },
  greenhouse: {
    label: 'Greenhouse board',
    placeholder: 'https://job-boards.greenhouse.io/stripe',
    help: 'The board link, its API URL or just the board token (stripe).',
    type: 'text',
    parse: (value) => {
      const token = greenhouseBoardToken(value)
      return token ? { slug: token, api_url: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs` } : null
    },
  },
  lever: {
    placeholder: 'https://jobs.lever.co/paytm',
    help: 'A jobs.lever.co (or jobs.eu.lever.co) board or job link, or just the site name (paytm). The name is case-sensitive.',
    parse: lever,
  },
  ashby: {
    placeholder: 'https://jobs.ashbyhq.com/sarvam',
    help: 'A jobs.ashbyhq.com board or job link, or just the board name. A company careers page that embeds Ashby has a jobs.ashbyhq.com link in it.',
    parse: ashby,
  },
  smartrecruiters: {
    placeholder: 'https://jobs.smartrecruiters.com/ServiceNow',
    help: 'A jobs.smartrecruiters.com or careers.smartrecruiters.com link (a job link works), or the company identifier (BoschGroup). Companies on their own careers domain: open a job and paste its jobs.smartrecruiters.com link. SmartRecruiters\' robots.txt admits only LinkedIn\'s crawler, so these companies show Failing until the owner allows the scraper (ATS_ROBOTS_OVERRIDE=smartrecruiters).',
    parse: smartRecruiters,
    hints: [{
      test: (value) => /^https?:\/\//i.test(trimmed(value)) && !/smartrecruiters\.com$/i.test(parseUrl(trimmed(value))?.host || ''),
      error: 'This is the company\'s own careers domain, which cannot be read: open a job there and paste its jobs.smartrecruiters.com link',
    }],
  },
  workable: {
    placeholder: 'https://apply.workable.com/smartstream/',
    help: 'An apply.workable.com/<account>/ board or job link (or <account>.workable.com), or just the account name. A short apply.workable.com/j/<code> job link works too: the scraper looks up its account when it runs.',
    parse: workable,
    hints: [{
      test: (value) => (parseUrl(trimmed(value))?.host || '') === 'jobs.workable.com',
      error: 'jobs.workable.com pages do not name the company\'s account: paste the company\'s apply.workable.com link',
    }],
  },
  oracle: {
    placeholder: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions',
    help: 'The career site link: an *.oraclecloud.com …/sites/<site>/ page (a job link works), or the company\'s own careers domain (e.g. https://careers.honeywell.com/en/sites/Honeywell). For an own domain the scraper reads the Oracle site from the page when it runs; a page that is not an Oracle career site shows Failing.',
    parse: oracle,
    hints: [{
      test: (value) => /^http:\/\//i.test(trimmed(value)),
      error: 'Paste the https:// link of the career site',
    }],
  },
  successfactors: {
    placeholder: 'https://jobs.birlasoft.com/',
    help: 'The company\'s SuccessFactors career site (its home, search or a job page), on the company\'s own domain. The scraper checks that it is one when it runs.',
    parse: successFactors,
    hints: [{
      test: (value) => SF_CLASSIC_RE.test(successFactorsHost(value) || ''),
      error: 'career*.successfactors.* and *.sapsf.com pages are closed to scrapers (robots.txt): paste the company\'s own careers site, e.g. https://jobs.birlasoft.com',
    }],
  },
  darwinbox: {
    placeholder: 'https://porter.darwinbox.in/ms/candidatev2/main/careers/allJobs',
    help: 'A <company>.darwinbox.in (or .darwinbox.com) careers link: …/ms/candidatev2/<id>/careers/… or …/ms/candidate/careers. If the site\'s bot protection blocks the scraper\'s servers, the company shows Failing (HTTP 403).',
    parse: darwinbox,
  },
  keka: {
    placeholder: 'https://hr.keka.com/careers/',
    help: 'A <company>.keka.com/careers link (a job link or a named portal works), or just the company name on keka.com.',
    parse: keka,
  },
  linkedin: {
    label: 'Search keywords',
    placeholder: 'e.g. Databricks',
    help: 'Only searched when the LinkedIn workflow is run by hand (it has no schedule any more). India-wide, newest first.',
    type: 'text',
    parse: (value) => {
      const text = trimmed(value)
      return text.length >= 2 && text.length <= 100 ? { api_url: text } : null
    },
    error: 'Search keywords: 2 to 100 characters',
  },
}
for (const [type, field] of Object.entries(ATS_FIELDS)) {
  field.label ??= `${label(type)} careers / board link`
  field.type ??= 'text'
  field.error ??= `Paste the ${label(type)} careers / board link, e.g. ${field.example || field.placeholder}`
}

// The types the form offers, in this order
export const ATS_TYPES = Object.keys(ATS_FIELDS)

// The columns to save for value: { slug, api_url } (Workday / LinkedIn: { api_url }), or { error }; null for a type
// the form does not handle. For the 8 API / HTML boards the answers are pinned by url_cases.json.
export function parseAtsSource(type, value) {
  const field = ATS_FIELDS[type]
  if (!field) return null
  const columns = field.parse(value)
  if (columns) return columns
  const hint = trimmed(value) ? field.hints?.find(h => h.test(value)) : null
  return { error: hint ? hint.error : field.error }
}

// The value shown in (and edited back from) the source field of a row: Greenhouse the token, others api_url || slug
export function sourceValue(company) {
  if (company?.ats_type === 'greenhouse') return company.slug || company.api_url || ''
  return company?.api_url || company?.slug || ''
}

const lower = (value) => String(value ?? '').trim().toLowerCase()
const normalise = (value) => lower(value).replace(/\/+$/, '')
const hostOf = (value) => {
  try {
    return new URL(String(value)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

// What makes two rows of one type the same board ('' when unknown): the board name for Lever / Ashby /
// SmartRecruiters / Workable, host + site for Oracle, the host for SuccessFactors, host + company id for Darwinbox,
// host + portal for Keka, the token for Greenhouse, else the URL / keywords. Stored rows are read through the same
// parser, so a pasted link and a stored API URL of the same board compare equal.
export function sourceKey(company) {
  const type = company?.ats_type
  if (type === 'greenhouse') return normalise(greenhouseBoardToken(company.slug) || greenhouseBoardToken(company.api_url))
  const field = ATS_FIELDS[type]
  const columns = (field && (field.parse(sourceValue(company)) || field.parse(company.slug))) || company || {}
  switch (type) {
    case 'lever':
    case 'ashby':
    case 'smartrecruiters':
    case 'workable':
      return lower(columns.slug) || normalise(columns.api_url)
    case 'oracle':
      return `${hostOf(columns.api_url)}/${lower(columns.slug)}`
    case 'successfactors':
      return lower(columns.slug)
    case 'darwinbox':
      return `${hostOf(columns.api_url)}/${lower(columns.slug)}`
    case 'keka':
      return normalise(columns.api_url)
    default:
      return normalise(columns.api_url) || normalise(columns.slug)
  }
}

// A short line naming what the scraper will read for a parsed value (the form shows it under the field)
export function describeSource(type, columns) {
  if (!columns || columns.error) return ''
  const { slug = '', api_url: apiUrl = '' } = columns
  const host = hostOf(apiUrl)
  switch (type) {
    case 'greenhouse': return `Greenhouse board “${slug}”`
    case 'workday': return `Workday site on ${host}`
    case 'lever': return `Lever site “${slug}”${host.startsWith('api.eu.') ? ' (EU)' : ''}`
    case 'ashby': return `Ashby board “${slug}”`
    case 'smartrecruiters': return `SmartRecruiters company “${slug}”`
    case 'workable': return slug ? `Workable account “${slug}”` : 'Workable job link: the scraper looks up its account when it runs'
    case 'oracle': return slug ? `Oracle site ${slug} on ${host}` : `Career page on ${host}: the scraper finds the Oracle site on it when it runs`
    case 'successfactors': return `Career site ${slug}`
    case 'darwinbox': return `Darwinbox site ${host}, company ${slug}`
    case 'keka': {
      const portal = /\/api\/jobs\/([^/]+)\/active$/.exec(apiUrl)?.[1] || 'default'
      return host.endsWith('.keka.com') ? `Keka company “${slug}”, portal ${portal}` : `Keka portal on ${host} (own domain), portal ${portal}`
    }
    case 'linkedin': return `LinkedIn search “${apiUrl}”`
    default: return ''
  }
}
