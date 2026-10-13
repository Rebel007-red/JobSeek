"""Workable: the jobs widget API, one GET per company with descriptions.

GET https://apply.workable.com/api/v1/widget/accounts/{sub}?details=true returns {name, description, jobs: [...]}: every
published job with its full description, no pagination. The widget repeats a job once per location (same shortcode),
so parse() emits one Posting per row and run_company merges them by job_id. An unknown account is a 404; an account
with no openings (many Indian companies that left Workable) is 200 with jobs: []. robots.txt of apply.workable.com
allows everything.

companies row: ats_type='workable', slug={sub} (lower case),
api_url=https://apply.workable.com/api/v1/widget/accounts/{sub}?details=true. A bare job link
https://apply.workable.com/j/{code} carries no account name: it is stored as api_url with slug='' and resolved at run
time from its redirect (apply.workable.com/j/{code} -> /{sub}/j/{code}/).
"""
import re
from urllib.parse import urljoin, urlparse

from ats.base import (
    AtsAdapter,
    HttpError,
    Posting,
    company_values,
    date_from_iso,
    normalize_employment,
    normalize_seniority,
)
from scraper_common import ScrapeFailed

SUB_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,99}$")
CODE_RE = re.compile(r"^[A-Za-z0-9]{4,20}$")
# {x}.workable.com hosts that are Workable's own sites, not legacy company boards
NOT_ACCOUNTS = {"www", "apply", "jobs", "help", "resources", "api", "blog", "support", "status", "careers-page",
                "developers", "workable"}
WIDGET = "https://apply.workable.com/api/v1/widget/accounts/{sub}"


def parse_board(value):
    """('sub', None) for an account URL or bare name, (None, code) for an apply.workable.com/j/{code} link,
    (None, None) when the value is not a Workable board."""
    text = str(value or "").strip()
    if not text:
        return None, None
    if "/" not in text and "." not in text:
        return (text.lower(), None) if SUB_RE.fullmatch(text) else (None, None)
    parsed = urlparse(text if "://" in text else f"https://{text}")
    if parsed.scheme not in ("http", "https"):
        return None, None
    host = (parsed.hostname or "").lower()
    segments = [segment for segment in parsed.path.split("/") if segment]
    sub = None
    if host == "apply.workable.com":
        if segments[:1] == ["j"]:
            code = segments[1] if len(segments) > 1 else ""
            return (None, code) if CODE_RE.fullmatch(code) else (None, None)
        if segments[:1] == ["api"]:
            # /api/v1/widget/accounts/{sub}, /api/v3/accounts/{sub}/jobs, /api/v1/accounts/{sub}/...
            if "accounts" in segments and segments.index("accounts") + 1 < len(segments):
                sub = segments[segments.index("accounts") + 1]
        elif segments:
            sub = segments[0]
    elif host == "www.workable.com":
        if segments[:2] == ["api", "accounts"] and len(segments) > 2:
            sub = segments[2]
    elif host.endswith(".workable.com") and host.count(".") == 2:
        label = host.split(".")[0]
        if label not in NOT_ACCOUNTS:
            sub = label
    if sub and SUB_RE.fullmatch(sub):
        return sub.lower(), None
    return None, None


def job_link(code):
    return f"https://apply.workable.com/j/{code}"


class WorkableAdapter(AtsAdapter):
    name = "workable"
    label = "Workable"
    request_delay = 1.5  # Workable answers bursts with 429
    timeout = 45

    def source_columns(self, value):
        sub, code = parse_board(value)
        if sub:
            return {"slug": sub, "api_url": WIDGET.format(sub=sub) + "?details=true"}
        if code:
            return {"slug": "", "api_url": job_link(code)}
        return None

    def identify(self, company):
        values = company_values(company)
        if not values:
            raise ScrapeFailed("Missing Workable board URL")
        code = None
        for value in values:
            sub, found_code = parse_board(value)
            if sub:
                return {"sub": sub}
            code = code or found_code
        if code:
            return {"sub": None, "code": code}
        raise ScrapeFailed("Unable to derive Workable board")

    def _resolve(self, http, target):
        """The account of a /j/{code} link, from its redirect (Location: /{sub}/j/{code}/)."""
        link = job_link(target["code"])
        try:
            response = http.get(link, allow_redirects=False, ok=(301, 302, 303, 307, 308))
        except HttpError as exc:
            if exc.status in (404, 410):
                raise ScrapeFailed(f"Workable job link {link} no longer resolves (job closed?); paste the "
                                   "company's apply.workable.com link") from exc
            if exc.status == 200:  # no redirect: nothing names the account
                raise ScrapeFailed("Unable to derive Workable board") from exc
            raise
        location = urljoin(link, (response.headers or {}).get("Location") or "")
        sub, _code = parse_board(location)
        if not sub:
            raise ScrapeFailed("Unable to derive Workable board")
        target["sub"] = sub

    def fetch(self, http, target, ctx):
        if not target.get("sub"):
            self._resolve(http, target)
        sub = target["sub"]
        try:
            data = http.get_json(WIDGET.format(sub=sub), params={"details": "true"})
        except HttpError as exc:
            if exc.status == 404:
                raise ScrapeFailed(f"HTTP 404 (no Workable account {sub!r})") from exc
            raise
        if not isinstance(data, dict) or not isinstance(data.get("jobs", []), list):
            raise ScrapeFailed("unexpected Workable response")
        return data.get("jobs") or []

    def parse(self, raw, target, ctx):
        if not isinstance(raw, dict):
            return None
        code = str(raw.get("shortcode") or "").strip()
        places = [item for item in raw.get("locations") or [] if isinstance(item, dict)]
        shown = [item for item in places if not item.get("hidden")] or places
        if not shown and (raw.get("city") or raw.get("state") or raw.get("country")):
            shown = [{"city": raw.get("city"), "region": raw.get("state"), "country": raw.get("country")}]
        locations, countries = [], []
        for place in shown:
            parts = [str(place.get(key) or "").strip() for key in ("city", "region", "country")]
            text = ", ".join(part for i, part in enumerate(parts) if part and part not in parts[:i])
            if text:
                locations.append(text)
            country = str(place.get("countryCode") or place.get("country") or "").strip()
            if country:
                countries.append(country)
        return Posting(
            job_id=code,
            title=raw.get("title") or "",
            job_url=f"https://apply.workable.com/{target['sub']}/j/{code}/" if code else "",
            locations=locations,
            countries=countries,
            posted_on=date_from_iso(raw.get("published_on")),  # date only; created_at can be weeks earlier
            description=raw.get("description") or "",
            workplace="remote" if raw.get("telecommuting") is True else None,
            employment_type=normalize_employment(raw.get("employment_type")),
            seniority_level=normalize_seniority(raw.get("experience")),
            job_function=raw.get("function") or raw.get("department") or "",
            industries=raw.get("industry") or "",
        )

    def board_url(self, target):
        return f"https://apply.workable.com/{target['sub']}/" if target.get("sub") else job_link(target["code"])
