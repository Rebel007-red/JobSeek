"""Ashby: the documented public Job Postings API, one GET per company.

GET https://api.ashbyhq.com/posting-api/job-board/{board} returns {"apiVersion": "1", "jobs": [...]} with every published
job and its full description (no pagination, no filters). An unknown board is a plain-text 404; a board with no
openings is 200 {"jobs": []}. Board names are case-insensitive and may contain spaces (%20). Never use
jobs.ashbyhq.com/api/* (robots.txt disallows it); the posting API has everything.

companies row: ats_type='ashby', slug={board}, api_url=https://api.ashbyhq.com/posting-api/job-board/{board}
(either column may also hold a jobs.ashbyhq.com board / job / embed link).
"""
import re
from urllib.parse import quote, unquote

from ats.base import (
    AtsAdapter,
    HttpError,
    Posting,
    company_values,
    date_from_iso,
    normalize_employment,
)
from scraper_common import ScrapeFailed

URL_RE = re.compile(
    r"^(?:https?://)?(?:jobs\.ashbyhq\.com|api\.ashbyhq\.com/posting-api/job-board)/([A-Za-z0-9._%-]+)", re.I)
BOARD_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._% -]{0,99}$")  # a stored slug may hold a space
RESERVED = {"api", "b", "meeting"}  # jobs.ashbyhq.com paths that are not boards
WORKPLACES = {"onsite": "onsite", "remote": "remote", "hybrid": "hybrid"}
API_BASE = "https://api.ashbyhq.com/posting-api/job-board/"


def parse_board(value):
    """The board name of an Ashby URL or bare board name (URL-decoded, case kept), or None."""
    text = str(value or "").strip()
    match = URL_RE.match(text)
    if match:
        raw = match.group(1)
    elif BOARD_RE.fullmatch(text.strip("/")):
        raw = text.strip("/")
    else:
        return None
    board = unquote(raw).strip()
    if not board or board.lower() in RESERVED or "/" in board:
        return None
    return board


def _parts(*values):
    """Distinct non-empty parts, in order, ignoring case ('Delhi', 'Delhi', 'India' -> 'Delhi', 'India')."""
    seen, result = set(), []
    for value in values:
        text = str(value or "").strip()
        if text and text.lower() not in seen:
            seen.add(text.lower())
            result.append(text)
    return result


def _place(location, address):
    """('Delhi', {addressLocality, addressRegion, addressCountry}) -> ('Delhi, India', 'India'); a location text
    without the country gets it appended so the row says where the job is."""
    postal = address.get("postalAddress") if isinstance(address, dict) else None
    postal = postal if isinstance(postal, dict) else {}
    country = str(postal.get("addressCountry") or "").strip()
    text = str(location or "").strip()
    if not text:
        text = ", ".join(_parts(postal.get("addressLocality"), postal.get("addressRegion"), country))
    elif country and country.lower() not in text.lower():
        text = f"{text}, {country}"
    return text, country


class AshbyAdapter(AtsAdapter):
    name = "ashby"
    label = "Ashby"
    request_delay = 1.0
    timeout = 60  # big boards (openai) are over 10 MB

    def source_columns(self, value):
        board = parse_board(value)
        if not board:
            return None
        return {"slug": board, "api_url": API_BASE + quote(board, safe="")}

    def identify(self, company):
        values = company_values(company)
        if not values:
            raise ScrapeFailed("Missing Ashby board URL")
        for value in values:
            board = parse_board(value)
            if board:
                return {"board": board}
        raise ScrapeFailed("Unable to derive Ashby board")

    def fetch(self, http, target, ctx):
        board = target["board"]
        try:
            data = http.get_json(API_BASE + quote(board, safe=""))
        except HttpError as exc:
            if exc.status == 404:
                raise ScrapeFailed(f"HTTP 404 (no Ashby board {board!r})") from exc
            raise
        if not isinstance(data, dict) or not isinstance(data.get("jobs", []), list):
            raise ScrapeFailed("unexpected Ashby response")
        return data.get("jobs") or []

    def parse(self, raw, target, ctx):
        if not isinstance(raw, dict) or raw.get("isListed") is False:  # unlisted: reachable by direct link only
            return None
        locations, countries = [], []
        places = [(raw.get("location"), raw.get("address"))]
        places += [(item.get("location"), item.get("address")) for item in raw.get("secondaryLocations") or []
                   if isinstance(item, dict)]
        for location, address in places:
            text, country = _place(location, address)
            if text:
                locations.append(text)
            if country:
                countries.append(country)
        workplace = WORKPLACES.get(str(raw.get("workplaceType") or "").lower())
        if workplace is None and raw.get("isRemote") is True:
            workplace = "remote"
        html = raw.get("descriptionHtml") or ""
        job_id = str(raw.get("id") or "")
        return Posting(
            job_id=job_id,
            title=raw.get("title") or "",
            job_url=raw.get("jobUrl") or (f"https://jobs.ashbyhq.com/{quote(target['board'], safe='')}/{job_id}"
                                          if job_id else ""),
            locations=locations,
            countries=countries,                         # free text ('India', 'USA', 'United States')
            posted_on=date_from_iso(raw.get("publishedAt")),  # last (re)publish time
            description=html or raw.get("descriptionPlain") or "",
            description_html=bool(html),
            workplace=workplace,
            employment_type=normalize_employment(raw.get("employmentType")),  # FullTime / PartTime / Intern / ...
            job_function=raw.get("department") or raw.get("team") or "",
        )

    def board_url(self, target):
        return f"https://jobs.ashbyhq.com/{quote(target['board'], safe='')}"
