"""SmartRecruiters: the public Posting API (the one career sites call), list + one detail GET per job.

LIST    GET https://api.smartrecruiters.com/v1/companies/{id}/postings?limit=100&offset={n}&country=in&releasedAfter=...
        {offset, limit, totalFound, content: [...]}, newest first by releasedDate. limit is capped at 100 without an
        error; country must be lower-case ISO-2 ('IN' quietly returns 0); releasedAfter is undocumented, so the
        posted-date window is also applied client-side (run_company).
DETAIL  GET .../postings/{postingId} (the list item's 'ref'): jobAd.sections {jobDescription, qualifications,
        additionalInformation, companyDescription} as HTML, and postingUrl.

An unknown company identifier is indistinguishable from an empty board in the API (200, totalFound 0), so an empty
result is checked against careers.smartrecruiters.com/{id}: an unknown company redirects to the site root.

robots.txt: api.smartrecruiters.com allows only LinkedInBot on /v1/companies/, so with the default settings every
company fails with the robots reason; the owner opts in with ATS_ROBOTS_OVERRIDE=smartrecruiters.

companies row: ats_type='smartrecruiters', slug={CompanyIdentifier},
api_url=https://api.smartrecruiters.com/v1/companies/{CompanyIdentifier}/postings. Companies on their own careers domain
(careers.servicenow.com) cannot be derived from it: paste a jobs.smartrecruiters.com job link.
"""
import re
from datetime import datetime, time as dtime, timezone
from urllib.parse import quote, urljoin, urlparse

from ats.base import (
    IST,
    AtsAdapter,
    Posting,
    company_values,
    date_from_iso,
    normalize_employment,
    normalize_seniority,
)
from scraper_common import ScrapeFailed

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
BOARD_HOSTS = {"jobs.smartrecruiters.com", "careers.smartrecruiters.com", "www.smartrecruiters.com",
               "smartrecruiters.com"}
# first path segments of the board hosts that are SmartRecruiters' own pages, not companies
RESERVED = {"external-referrals", "oneclick-ui", "sr-jobs", "search", "app", "account", "privacy-policy", "legal",
            "about", "blog", "resources", "customers", "product", "pricing", "contact", "partners", "careers", "jobs"}
API = "https://api.smartrecruiters.com/v1/companies/{id}/postings"
PAGE = 100


def parse_board(value):
    """The CompanyIdentifier of a SmartRecruiters URL or bare identifier (case kept), or None."""
    text = str(value or "").strip()
    if not text:
        return None
    if "/" not in text and "." not in text:
        return text if ID_RE.fullmatch(text) else None
    parsed = urlparse(text if "://" in text else f"https://{text}")
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower()
    segments = [segment for segment in parsed.path.split("/") if segment]
    candidate = None
    if host == "api.smartrecruiters.com":
        if segments[:2] == ["v1", "companies"] and len(segments) > 2:
            candidate = segments[2]
    elif host in BOARD_HOSTS and segments and segments[0].lower() not in RESERVED:
        candidate = segments[0]
    return candidate if candidate and ID_RE.fullmatch(candidate) else None


def _clean_location(text):
    """'Hyderabad, , India' -> 'Hyderabad, India'."""
    return ", ".join(part.strip() for part in str(text or "").split(",") if part.strip())


def released_after(cutoff):
    """Midnight IST of the cutoff date as the API's UTC ISO timestamp."""
    moment = datetime.combine(cutoff, dtime(0, 0), IST).astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _label(value):
    return str((value or {}).get("label") or "").strip() if isinstance(value, dict) else ""


class SmartRecruitersAdapter(AtsAdapter):
    name = "smartrecruiters"
    label = "SmartRecruiters"
    request_delay = 1.0
    timeout = 30

    def source_columns(self, value):
        company = parse_board(value)
        if not company:
            return None
        return {"slug": company, "api_url": API.format(id=company)}

    def identify(self, company):
        values = company_values(company)
        if not values:
            raise ScrapeFailed("Missing SmartRecruiters board URL")
        for value in values:
            identifier = parse_board(value)
            if identifier:
                return {"company": identifier}
        raise ScrapeFailed("Unable to derive SmartRecruiters board")

    def fetch(self, http, target, ctx):
        identifier = target["company"]
        url = API.format(id=quote(identifier, safe=""))
        since = released_after(ctx.cutoff)
        postings, offset, seen = [], 0, set()
        while True:
            data = http.get_json(url, params={"limit": PAGE, "offset": offset, "country": "in",
                                              "releasedAfter": since})
            if not isinstance(data, dict) or not isinstance(data.get("content", []), list):
                raise ScrapeFailed("unexpected SmartRecruiters response")
            page = [item for item in data.get("content") or [] if isinstance(item, dict)]
            fresh = [item for item in page if item.get("id") not in seen]
            seen.update(item.get("id") for item in fresh)
            postings.extend(fresh)
            for item in page:
                canonical = ((item.get("company") or {}).get("identifier") or "").strip()
                if canonical:
                    target["company"] = canonical  # canonical casing for job URLs
                    break
            total = data.get("totalFound") or 0
            offset += PAGE
            if (len(page) < PAGE or not fresh or offset >= total
                    or ctx.too_old(date_from_iso(page[-1].get("releasedDate")))):
                break
        if not postings:
            self._check_company(http, identifier)
        return postings

    def _check_company(self, http, identifier):
        """An empty answer: is the company real? careers.smartrecruiters.com/{id} stays put for a real company and
        redirects to the site root for an unknown one. Best effort: anything else counts as real."""
        page = f"https://careers.smartrecruiters.com/{quote(identifier, safe='')}"
        try:
            response = http.get(page, allow_redirects=False, ok=(200, 301, 302, 303, 307, 308))
        except ScrapeFailed:  # HttpError, RobotsDisallowed, budget: cannot tell, so keep the empty board
            return
        if response.status_code in (301, 302, 303, 307, 308):
            location = urljoin(page, (response.headers or {}).get("Location") or "")
            if urlparse(location).path.strip("/") == "":
                raise ScrapeFailed(f"unknown SmartRecruiters company {identifier!r}")

    def parse(self, raw, target, ctx):
        if not isinstance(raw, dict):
            return None
        job_id = str(raw.get("id") or "").strip()
        location = raw.get("location") if isinstance(raw.get("location"), dict) else {}
        text = _clean_location(location.get("fullLocation")) or _clean_location(
            ", ".join(str(location.get(key) or "") for key in ("city", "region", "country")))
        country = str(location.get("country") or "").strip().upper()
        workplace = "remote" if location.get("remote") else "hybrid" if location.get("hybrid") else None
        identifier = ((raw.get("company") or {}).get("identifier") or target["company"]).strip()
        return Posting(
            job_id=job_id,
            title=raw.get("name") or "",
            job_url=f"https://jobs.smartrecruiters.com/{quote(identifier, safe='')}/{job_id}" if job_id else "",
            locations=[text] if text else [],
            countries=[country] if country else [],
            posted_on=date_from_iso(raw.get("releasedDate")),  # latest (re)publish time
            workplace=workplace,
            employment_type=normalize_employment(_label(raw.get("typeOfEmployment"))),
            seniority_level=normalize_seniority(_label(raw.get("experienceLevel"))),  # 'Not Applicable' -> ''
            job_function=_label(raw.get("function")) or _label(raw.get("department")),
            industries=_label(raw.get("industry")),
            needs_detail=True,  # the list has no description
            extra={"ref": raw.get("ref") or ""},
        )

    def fetch_detail(self, http, target, posting, ctx):
        ref = posting.extra.get("ref") or ""
        if not ref.startswith("https://api.smartrecruiters.com/"):
            ref = f"{API.format(id=quote(target['company'], safe=''))}/{quote(posting.job_id, safe='')}"
        data = http.get_json(ref)
        if not isinstance(data, dict):
            raise ScrapeFailed("unexpected SmartRecruiters detail")
        sections = ((data.get("jobAd") or {}).get("sections") or {})
        parts = []
        for key in ("jobDescription", "qualifications", "additionalInformation"):
            section = sections.get(key) or {}
            body = str(section.get("text") or "").strip() if isinstance(section, dict) else ""
            if body:
                title = str(section.get("title") or "").strip()
                parts.append((f"<h3>{title}</h3>" if title else "") + body)
        posting.description = "\n".join(parts)
        posting.description_html = True
        url = str(data.get("postingUrl") or "")
        if url.startswith("https://"):
            posting.job_url = url
        return posting

    def board_url(self, target):
        return f"https://careers.smartrecruiters.com/{quote(target['company'], safe='')}"
