"""Lever: the documented public postings API, one GET per company (the reference adapter for the others).

GET https://api.lever.co/v0/postings/{site}?mode=json returns every published posting with the full description. EU
accounts live on api.eu.lever.co (404 on the other host, so the global host is tried first, then the EU one). Site names
are case-sensitive: a 404 is retried in lower case. robots.txt allows everything with Crawl-delay: 1.

companies row: ats_type='lever', slug={site}, api_url=https://api[.eu].lever.co/v0/postings/{site}?mode=json
(either column may also hold a jobs.lever.co / jobs.eu.lever.co board or posting link).
"""
import re

from ats.base import (
    AtsAdapter,
    HttpError,
    Posting,
    company_values,
    date_from_epoch,
    html_to_text,
    join_text,
    normalize_employment,
    normalize_seniority,
)
from scraper_common import ScrapeFailed

# "v0" is the API path, never a site (api.lever.co/v0/postings/ with no site must not become site "v0")
URL_RE = re.compile(r"^(?:https?://)?(?:jobs|api)\.(eu\.)?lever\.co/(?:v0/postings/)?(?!v0(?:[/?#]|$))([A-Za-z0-9._-]+)", re.I)
SITE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
WORKPLACES = {"remote": "remote", "hybrid": "hybrid", "onsite": "onsite", "on-site": "onsite"}


def parse_board(value):
    """(site, eu) of a Lever URL or bare site name; eu is True / False from the host, None for a bare name."""
    text = str(value or "").strip()
    match = URL_RE.match(text)
    if match:
        return match.group(2), bool(match.group(1))
    if SITE_RE.fullmatch(text.strip("/")):
        return text.strip("/"), None
    return None, None


class LeverAdapter(AtsAdapter):
    name = "lever"
    label = "Lever"
    request_delay = 1.0
    timeout = 60  # large boards are several MB

    def source_columns(self, value):
        site, eu = parse_board(value)
        if not site:
            return None
        return {"slug": site, "api_url": f"https://api.{'eu.' if eu else ''}lever.co/v0/postings/{site}?mode=json"}

    def identify(self, company):
        values = company_values(company)
        if not values:
            raise ScrapeFailed("Missing Lever board URL")
        eu_hint = None
        for value in values:
            site, eu = parse_board(value)
            if eu is not None:
                eu_hint = eu
            if site:
                return {"site": site, "eu": eu if eu is not None else eu_hint}
        raise ScrapeFailed("Unable to derive Lever board")

    def fetch(self, http, target, ctx):
        hosts = ["api.eu.lever.co"] if target.get("eu") else ["api.lever.co", "api.eu.lever.co"]
        sites = [target["site"]] + ([target["site"].lower()] if target["site"] != target["site"].lower() else [])
        for site in sites:
            for host in hosts:
                try:
                    postings = http.get_json(f"https://{host}/v0/postings/{site}", params={"mode": "json"})
                except HttpError as exc:
                    if exc.status == 404:
                        continue
                    raise
                if not isinstance(postings, list):
                    raise ScrapeFailed("unexpected Lever response")
                target.update(site=site, eu=host.startswith("api.eu."))
                return postings
        raise ScrapeFailed(f"HTTP 404 (no Lever board {target['site']!r})")

    def parse(self, raw, target, ctx):
        if not isinstance(raw, dict):
            return None
        categories = raw.get("categories") or {}
        locations = list(categories.get("allLocations") or [])
        if categories.get("location") and categories["location"] not in locations:
            locations.insert(0, categories["location"])
        lists = [join_text(item.get("text"), html_to_text(item.get("content"))) for item in raw.get("lists") or []
                 if isinstance(item, dict)]
        description = join_text(raw.get("descriptionPlain") or html_to_text(raw.get("description")), *lists,
                                raw.get("additionalPlain") or html_to_text(raw.get("additional")))
        job_id = str(raw.get("id") or "")
        hosted = str(raw.get("hostedUrl") or "")
        if not hosted.startswith("https://") and job_id:
            hosted = f"{self.board_url(target)}/{job_id}"
        return Posting(
            job_id=job_id,
            title=raw.get("text") or "",
            job_url=hosted,
            locations=locations,
            countries=[raw["country"]] if raw.get("country") else [],  # the primary location's country only
            posted_on=date_from_epoch(raw.get("createdAt"), "ms"),   # creation date; Lever has no repost date
            description=description,
            description_html=False,
            workplace=WORKPLACES.get(str(raw.get("workplaceType") or "").lower()),
            employment_type=normalize_employment(categories.get("commitment")),
            seniority_level=normalize_seniority(categories.get("level")),
            job_function=categories.get("department") or categories.get("team") or "",
        )

    def board_url(self, target):
        return f"https://jobs.{'eu.' if target.get('eu') else ''}lever.co/{target['site']}"
