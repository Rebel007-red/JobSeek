"""Oracle Recruiting Cloud (Oracle Fusion HCM Candidate Experience): the public REST API the career site itself calls.

LIST   GET https://{apiHost}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true
           &expand=requisitionList.secondaryLocations
           &finder=findReqs;siteNumber={site},facetsList=LOCATIONS;POSTING_DATES,limit=100,offset={k},
                   sortBy=POSTING_DATES_DESC,location=India,selectedPostingDatesFacet=7
       The finder parameters are one value with literal ';' and ',' (the query string is built by hand). items[0] holds
       TotalJobsCount and requisitionList; limit is capped at 200 by the server; the count can be off by one (dedupe by
       Id). An unrecognised location is silently ignored (the tenant then returns every job), so the client-side India
       check stays and paging stops at a page with no India job at all.
DETAIL GET .../recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id="{Id}",siteNumber={site}
       The list has only a 1-3 sentence teaser (ShortDescriptionStr); the detail has the description, JobSchedule and
       Category, so every list row has needs_detail=True.
Vanity career domains (careers.honeywell.com) do not proxy /hcmRestApi: the board page's root element carries
data-apibaseurl / data-sitenumber, read at run time. The tenants sit behind Oracle WAF4SaaS; a 403 'W4S-...' page is a
block (the company fails for this run). No robots.txt exists on the API hosts.

companies row (Settings > Companies):
  *.oraclecloud.com/.../sites/{site}/...  -> api_url=https://{host}/hcmUI/CandidateExperience/en/sites/{site}, slug={site}
  any other https:// URL (vanity domain)  -> api_url=the URL as given, slug=''  (discovered at run time)
A row with api_url=https://{host} (an oraclecloud host without a path) and slug={site} is read too.
"""
import re
from urllib.parse import quote, urlparse

from ats.base import (
    AtsAdapter,
    Posting,
    company_values,
    date_from_iso,
    mentions_india,
    normalize_employment,
    normalize_seniority,
)
from scraper_common import ScrapeFailed

PAGE_SIZE = 100
SITE_PATH_RE = re.compile(r"/sites/([^/?#]+)", re.I)
SITE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,60}$")
API_BASE_RE = re.compile(r"""data-apibaseurl\s*=\s*["']([^"']+)["']""", re.I)
SITE_NUMBER_RE = re.compile(r"""data-sitenumber\s*=\s*["']([^"']+)["']""", re.I)
VANITY_BASE_RE = re.compile(r"""data-vanitybaseurl\s*=\s*["']([^"']+)["']""", re.I)
WORKPLACES = {"ORA_HYBRID": "hybrid", "ORA_ON_SITE": "onsite", "ORA_REMOTE": "remote",
              "hybrid": "hybrid", "onsite": "onsite", "on-site": "onsite", "on site": "onsite", "remote": "remote"}
SENIORITY_PROMPTS = re.compile(r"experience level|career level|seniority|job level", re.I)


def is_oracle_host(host):
    return host == "oraclecloud.com" or host.endswith(".oraclecloud.com")


def parse_board(value):
    """{'host', 'site'} for an *.oraclecloud.com URL (site None when the URL has no /sites/ segment), {'page': url} for
    any other https:// URL, None otherwise."""
    text = str(value or "").strip()
    if not text or any(ch.isspace() for ch in text):
        return None
    candidate = text if "://" in text else f"https://{text}"
    parsed = urlparse(candidate)
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower()
    if not host or "." not in host:
        return None
    if is_oracle_host(host):
        match = SITE_PATH_RE.search(parsed.path or "")
        site = match.group(1) if match and SITE_RE.fullmatch(match.group(1)) else None
        return {"host": host, "site": site}
    if "://" not in text or parsed.scheme != "https":
        return None  # a vanity page must be pasted as a full https:// link
    return {"page": text}


def site_url(host, site):
    return f"https://{host}/hcmUI/CandidateExperience/en/sites/{site}"


def collapse(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


class OracleAdapter(AtsAdapter):
    name = "oracle"
    label = "Oracle Recruiting"
    request_delay = 1.0
    timeout = 45

    def source_columns(self, value):
        board = parse_board(value)
        if not board:
            return None
        if "page" in board:
            return {"slug": "", "api_url": board["page"]}
        if board["site"]:
            return {"slug": board["site"], "api_url": site_url(board["host"], board["site"])}
        # an oraclecloud host without /sites/: the page is read at run time like a vanity domain
        parsed = urlparse(str(value).strip() if "://" in str(value) else f"https://{str(value).strip()}")
        rest = (parsed.path or "").rstrip("/") + (f"?{parsed.query}" if parsed.query else "")
        return {"slug": "", "api_url": f"https://{board['host']}{rest}"}

    def identify(self, company):
        values = company_values(company)
        if not values:
            raise ScrapeFailed("Missing Oracle Recruiting board URL")
        slug = str(company.get("slug") or "").strip()
        bare_site = slug if SITE_RE.fullmatch(slug) and "." not in slug else None
        page = None
        for value in values:
            board = parse_board(value)
            if not board:
                continue
            if "page" in board:
                page = page or board["page"]
                continue
            site = board["site"] or bare_site
            if site:
                return {"host": board["host"], "site": site}
            page = page or (value if "://" in value else f"https://{value}")
        if page:
            return {"page": page, "site_hint": bare_site}
        raise ScrapeFailed("Unable to derive Oracle Recruiting board")

    # ------------------------------------------------------------------------------------------------------------------

    def discover(self, http, target):
        """Read data-apibaseurl / data-sitenumber from the career page (vanity domains, oraclecloud links without a
        site). The API host and site number are cached in the target."""
        page = http.get_text(target["page"])
        api_base = API_BASE_RE.search(page)
        site_number = SITE_NUMBER_RE.search(page)
        if not api_base or not (site_number or target.get("site_hint")):
            raise ScrapeFailed("not an Oracle Recruiting career site (no data-apibaseurl on the page)")
        host = (urlparse(api_base.group(1).strip()).hostname or "").lower()
        if not host:
            raise ScrapeFailed("not an Oracle Recruiting career site (bad data-apibaseurl)")
        vanity = VANITY_BASE_RE.search(page)
        target.update(host=host, site=(site_number.group(1).strip() if site_number else target["site_hint"]),
                      vanity=vanity.group(1).strip() if vanity else None)

    def list_url(self, target, offset, max_days):
        finder = (f"findReqs;siteNumber={quote(target['site'], safe='')},facetsList=LOCATIONS;POSTING_DATES,"
                  f"limit={PAGE_SIZE},offset={offset},sortBy=POSTING_DATES_DESC,location=India")
        # the date facet's buckets are 7 / 30 days; a wider window (--max-days) goes unfiltered
        if max_days <= 7:
            finder += ",selectedPostingDatesFacet=7"
        elif max_days <= 30:
            finder += ",selectedPostingDatesFacet=30"
        return (f"https://{target['host']}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true"
                f"&expand=requisitionList.secondaryLocations&finder={finder}")

    def fetch(self, http, target, ctx):
        if not target.get("host"):
            self.discover(http, target)
        jobs, seen, offset = [], set(), 0
        while True:
            payload = http.get_json(self.list_url(target, offset, ctx.max_days))
            items = payload.get("items") if isinstance(payload, dict) else None
            if not isinstance(items, list):
                raise ScrapeFailed("unexpected Oracle Recruiting response")
            if not items:
                return jobs
            search = items[0] if isinstance(items[0], dict) else {}
            page = [job for job in search.get("requisitionList") or [] if isinstance(job, dict)]
            try:
                total = int(search.get("TotalJobsCount") or 0)
            except (TypeError, ValueError):
                total = 0
            for job in page:
                key = str(job.get("Id") or "")
                if key and key not in seen:
                    seen.add(key)
                    jobs.append(job)
            offset += PAGE_SIZE
            if not page or offset >= total:
                return jobs
            # location=India ignored by a tenant without an India geography: nothing further can be in India
            if not any(self._india_codes(job) for job in page):
                return jobs
            oldest = date_from_iso(page[-1].get("PostedDate"))
            if ctx.too_old(oldest):
                return jobs

    @staticmethod
    def _india_codes(job):
        codes = [job.get("PrimaryLocationCountry")] + [loc.get("CountryCode") for loc in job.get("secondaryLocations")
                                                       or [] if isinstance(loc, dict)]
        found = [code for code in codes if str(code or "").strip().upper() == "IN"]
        # a tenant that leaves the country code empty still names the place
        return found or ([job["PrimaryLocation"]] if mentions_india(job.get("PrimaryLocation")) else [])

    def job_url(self, target, job_id):
        return f"{site_url(target['host'], target['site'])}/job/{job_id}"

    def parse(self, raw, target, ctx):
        if not isinstance(raw, dict) or not raw.get("Id"):
            return None
        job_id = str(raw["Id"]).strip()
        locations, countries = [], []
        if raw.get("PrimaryLocation"):
            locations.append(collapse(raw["PrimaryLocation"]))
        if raw.get("PrimaryLocationCountry"):
            countries.append(str(raw["PrimaryLocationCountry"]).strip())
        for secondary in raw.get("secondaryLocations") or []:
            if not isinstance(secondary, dict):
                continue
            if secondary.get("Name"):
                locations.append(collapse(secondary["Name"]))
            if secondary.get("CountryCode"):
                countries.append(str(secondary["CountryCode"]).strip())
        return Posting(
            job_id=job_id,
            title=collapse(raw.get("Title")),
            job_url=self.job_url(target, job_id),
            locations=locations,
            countries=countries,
            posted_on=date_from_iso(raw.get("PostedDate")),  # date only (UTC); the detail has the exact time
            # empty until the detail is read: a teaser stored as the description would mark the job as 'seen' (04's
            # ats_seen_keys) and its full description would never be fetched
            description="",
            workplace=self._workplace(raw),
            employment_type=normalize_employment(raw.get("JobSchedule") or raw.get("WorkerType")),
            job_function=collapse(raw.get("JobFamily") or raw.get("JobFunction")),
            needs_detail=True,
        )

    @staticmethod
    def _workplace(raw):
        code = str(raw.get("WorkplaceTypeCode") or "").strip()
        if code in WORKPLACES:
            return WORKPLACES[code]
        return WORKPLACES.get(str(raw.get("WorkplaceType") or "").strip().lower())

    def fetch_detail(self, http, target, posting, ctx):
        finder = f"ById;Id=%22{quote(str(posting.job_id), safe='')}%22,siteNumber={quote(target['site'], safe='')}"
        payload = http.get_json(f"https://{target['host']}/hcmRestApi/resources/latest/"
                                f"recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder={finder}")
        items = payload.get("items") if isinstance(payload, dict) else None
        if not items or not isinstance(items[0], dict):
            raise ScrapeFailed("job not found")
        detail = items[0]
        parts = [detail.get(key) for key in ("ExternalDescriptionStr", "ExternalResponsibilitiesStr",
                                              "ExternalQualificationsStr")]
        parts = [part for part in parts if str(part or "").strip()]
        # some tenants (Honeywell) fill only the teaser and the company blurb: the teaser is then all there is
        posting.description = "\n".join(parts) or detail.get("ShortDescriptionStr") or ""
        posting.description_html = True
        posted = date_from_iso(detail.get("ExternalPostedStartDate"))
        if posted:
            posting.posted_on = posted
        employment = ""
        for key in ("JobSchedule", "ContractType", "WorkerType", "JobType"):
            employment = normalize_employment(detail.get(key))
            if employment:
                break
        posting.employment_type = employment or posting.employment_type
        posting.job_function = collapse(detail.get("Category") or detail.get("JobFunction")) or posting.job_function
        posting.workplace = self._workplace(detail) or posting.workplace
        for flex in detail.get("requisitionFlexFields") or []:
            if isinstance(flex, dict) and SENIORITY_PROMPTS.search(str(flex.get("Prompt") or "")):
                posting.seniority_level = normalize_seniority(flex.get("Value")) or posting.seniority_level
        return posting

    def board_url(self, target):
        if str(target.get("page") or "").startswith("https://"):
            return target["page"]  # the career page the owner pasted (vanity domain)
        if not target.get("host"):
            return ""
        return f"{site_url(target['host'], target['site'])}/requisitions"
