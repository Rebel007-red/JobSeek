"""Keka Hire: the JSON API behind the stock career page, one GET per company (no auth, no pagination).

GET https://{tenant}.keka.com/careers/api/jobs/{portal}/active returns a bare array of every active job with its HTML
description (portal 'default' unless the board link names one). A job without a 'description' key gets its description
from the server-rendered page /careers/jobdetails/{id} (div.job-description-container).
The API answers an unknown tenant or a disabled portal with a 302 (to Content/TenantNotFound.html / Content/403.html),
so it is read with allow_redirects=False. A wrong portal name returns 200 [] (0 jobs, like an empty board).
robots.txt on every tenant: 'Disallow: /' + 'Allow: /careers', so only paths under /careers/ are used.
Custom career domains (careersPortalDomain not on keka.com) use the same paths without the /careers prefix
(from Keka's own JS; no live tenant found to verify it).

companies row: api_url=https://{host}/careers/api/jobs/{portal}/active, slug={tenant}
               (custom domain: api_url=https://{host}/api/jobs/{portal}/active, slug={host})
"""
import re
from urllib.parse import quote, urlparse

from bs4 import BeautifulSoup

from ats.base import AtsAdapter, Posting, company_values, date_from_iso, is_india_country
from scraper_common import ScrapeFailed

HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
TENANT_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
PORTAL_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NOT_PORTALS = {"", "jobdetails", "applyjob", "content", "api", "jobs"}
JOB_TYPES = {"1": "Part-time", "2": "Full-time"}
INTERN_RE = re.compile(r"\b(intern|internship|trainee|apprentice)\b", re.I)


def is_keka_host(host):
    return host.endswith(".keka.com")


def parse_board(value):
    """{'host', 'tenant', 'portal', 'custom'} of a Keka career / API link or a bare tenant name; None otherwise."""
    text = str(value or "").strip()
    if not text or any(ch.isspace() for ch in text):
        return None
    if TENANT_RE.fullmatch(text.lower()) and "." not in text:
        return {"host": f"{text.lower()}.keka.com", "tenant": text.lower(), "portal": "default", "custom": False}
    parsed = urlparse(text if "://" in text else f"https://{text}")
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower()
    if not HOST_RE.fullmatch(host):
        return None
    parts = [part for part in (parsed.path or "").split("/") if part]
    portal = "default"
    if is_keka_host(host):
        tenant = host[: -len(".keka.com")]
        if not TENANT_RE.fullmatch(tenant):
            return None
        if parts and parts[0].lower() == "careers":
            rest = parts[1:]
            if len(rest) >= 3 and [p.lower() for p in rest[:2]] == ["api", "jobs"]:
                portal = rest[2]
            elif rest and rest[0].lower() not in NOT_PORTALS:
                portal = rest[0]
        elif parts:
            return None  # robots allows only /careers/...: another page of the tenant is not a career link
        custom = False
    else:
        if "://" not in text or parsed.scheme != "https":
            return None  # a custom domain must be pasted as a full https:// link
        tenant = host
        if len(parts) >= 3 and [p.lower() for p in parts[:2]] == ["api", "jobs"]:
            portal = parts[2]
        custom = True
    if not PORTAL_RE.fullmatch(portal):
        return None
    return {"host": host, "tenant": tenant, "portal": portal, "custom": custom}


def api_url(board):
    prefix = "" if board["custom"] else "/careers"
    return f"https://{board['host']}{prefix}/api/jobs/{board['portal']}/active"


class KekaAdapter(AtsAdapter):
    name = "keka"
    label = "Keka"
    request_delay = 1.0
    timeout = 30

    def source_columns(self, value):
        board = parse_board(value)
        if not board:
            return None
        return {"slug": board["tenant"], "api_url": api_url(board)}

    def identify(self, company):
        values = company_values(company)
        if not values:
            raise ScrapeFailed("Missing Keka board URL")
        for value in values:
            board = parse_board(value)
            if board:
                return board
        raise ScrapeFailed("Unable to derive Keka board")

    def fetch(self, http, target, ctx):
        response = http.get(api_url(target), allow_redirects=False, ok=(200, 301, 302, 303, 307, 308))
        if response.status_code != 200:
            location = str((response.headers or {}).get("Location") or "")
            if "tenantnotfound" in location.lower():
                raise ScrapeFailed(f"no Keka tenant {target['tenant']!r}")
            if "403" in location:
                raise ScrapeFailed("Keka careers portal disabled")
            raise ScrapeFailed(f"HTTP {response.status_code} (redirect to {location[:80] or 'nowhere'})")
        try:
            jobs = response.json()
        except ValueError as exc:
            raise ScrapeFailed("not a Keka careers portal (no job list)") from exc
        if not isinstance(jobs, list):
            raise ScrapeFailed("not a Keka careers portal (no job list)")
        # jobs without any location: in India when every located job of the company is (an India-only employer);
        # otherwise unknown, and the pipeline's location check decides
        located = [self._country_values(job) for job in jobs if isinstance(job, dict) and self._country_values(job)]
        target["unlocated_india"] = bool(located) and all(any(is_india_country(c) for c in codes) for codes in located)
        return jobs

    @staticmethod
    def _country_values(job):
        return [str(place.get("countryCode") or place.get("countryName") or "").strip()
                for place in job.get("jobLocations") or []
                if isinstance(place, dict) and str(place.get("countryCode") or place.get("countryName") or "").strip()]

    def job_url(self, target, job_id):
        prefix = "" if target["custom"] else "/careers"
        portal = "" if target["portal"].lower() == "default" else f"/{target['portal']}"
        return f"https://{target['host']}{prefix}{portal}/jobdetails/{quote(str(job_id), safe='')}"

    def parse(self, raw, target, ctx):
        if not isinstance(raw, dict) or not raw.get("id"):
            return None
        job_id = str(raw["id"]).strip()
        locations, countries = [], []
        for place in raw.get("jobLocations") or []:
            if not isinstance(place, dict):
                continue
            # 'name' is the office label ('Bangalore - Head Office', 'Gurugram'); 'city' can be wrong ('Haryana')
            name = str(place.get("name") or "").strip() or str(place.get("city") or "").strip()
            country = str(place.get("countryName") or "").strip()
            if name and country and country.lower() not in name.lower():
                locations.append(f"{name}, {country}")
            elif name or country:
                locations.append(name or country)
            if place.get("countryCode"):
                countries.append(str(place["countryCode"]).strip())
            elif country:
                countries.append(country)
        title = str(raw.get("title") or "")
        employment = "Internship" if INTERN_RE.search(title) else JOB_TYPES.get(str(raw.get("jobType") or ""), "")
        description = raw.get("description")
        return Posting(
            job_id=job_id,
            title=title,
            job_url=self.job_url(target, job_id),
            locations=locations,
            countries=countries,
            india=True if not locations and not countries and target.get("unlocated_india") else None,
            posted_on=date_from_iso(raw.get("publishedOn")),
            description=description or "",
            employment_type=employment,
            job_function=raw.get("departmentName") or "",
            needs_detail=not str(description or "").strip(),
        )

    def fetch_detail(self, http, target, posting, ctx):
        soup = BeautifulSoup(http.get_text(posting.job_url, allow_redirects=False), "html.parser")
        container = soup.select_one("div.job-description-container")
        if container is None:
            raise ScrapeFailed("no description on the job page")
        posting.description = container.decode_contents()
        posting.description_html = True
        return posting

    def board_url(self, target):
        prefix = "" if target["custom"] else "/careers"
        portal = "" if target["portal"].lower() == "default" else f"/{target['portal']}"
        return f"https://{target['host']}{prefix}{portal}/"
