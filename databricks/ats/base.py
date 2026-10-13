"""The ATS adapter framework: what an adapter implements, and everything it shares.

An adapter (one per ATS, e.g. ats/lever.py) implements five small methods:

    source_columns(value)          -> {slug, api_url} | None   what Settings > Companies stores for a pasted URL
    identify(company)              -> target dict   which board to read, from the companies row (slug / api_url)
    fetch(http, target, ctx)       -> [raw, ...]    every posting of the board (pagination, server-side filters)
    parse(raw, target, ctx)        -> Posting|None  one posting, normalised (None = skip it)
    fetch_detail(http, target, posting, ctx) -> Posting   optional: fills the description (and date / location)
                                                          for postings the list left incomplete

and run_company() does the rest the same way for every ATS: dedupe by job_id, the India filter, the posted-date window
(scraper_common.MAX_POSTED_DAYS, the owner's 7-day rule), capped detail fetches (skipping jobs the pipeline already has),
and the CSV rows in scraper_common.OUTPUT_COLUMNS order. Errors of one company become its report outcome
(CompanyResult.error, e.g. "HTTP 404"); they never stop the other companies.

HTTP goes through Http only: an honest User-Agent, one request at a time per host with a delay (or the host's robots.txt
Crawl-delay), timeouts, retries with exponential backoff (Retry-After honoured) on 429 / 5xx / timeouts, robots.txt
checked before the first request to a host (an ATS whose API path robots.txt disallows fails with that reason unless the
owner lists it in ATS_ROBOTS_OVERRIDE), a request budget per company and a response size cap.

Dates: a Posting carries posted_on, the posting's calendar date in India (IST, UTC+5:30, no DST), built with the
date_from_* helpers. posted_days = today (IST) - posted_on, clamped at 0.
"""
from __future__ import annotations

import hashlib
import html as html_lib
import os
import re
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

from scraper_common import ScrapeFailed, format_calendar_date, sanitize_text, short_error

IST = timezone(timedelta(hours=5, minutes=30), "IST")

BOT_NAME = "JobSeekerBot"
BOT_VERSION = "1.0"
MAX_DESCRIPTION_CHARS = 30000


def user_agent():
    """Honest User-Agent: who we are and where the code lives (the GitHub repo when running in Actions)."""
    repo = os.getenv("GITHUB_REPOSITORY")
    contact = f"+https://github.com/{repo}; " if repo else ""
    return f"{BOT_NAME}/{BOT_VERSION} ({contact}personal job search; low volume)"


def env_int(name, default):
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


@dataclass
class Settings:
    """Run limits (env overrides in brackets)."""
    max_details_per_company: int = 150   # [ATS_MAX_DETAILS_PER_COMPANY] detail GETs per company per run, newest first
    max_requests_per_company: int = 600  # [ATS_MAX_REQUESTS_PER_COMPANY] any request; guards runaway pagination
    company_time_budget_s: int = 900     # [ATS_COMPANY_TIME_BUDGET_S] no new detail fetches after this
    ats_time_budget_s: int = 3600        # [ATS_TIME_BUDGET_S] no new companies of one ATS after this
    max_body_mb: int = 50                # [ATS_MAX_BODY_MB] larger responses fail the company
    detail_failures_stop: int = 5        # consecutive failed detail fetches that stop the company's detail fetches
    robots_override: frozenset = frozenset()  # [ATS_ROBOTS_OVERRIDE] ats names allowed despite a robots.txt disallow

    @classmethod
    def from_env(cls):
        override = {part.strip().lower() for part in (os.getenv("ATS_ROBOTS_OVERRIDE") or "").split(",") if part.strip()}
        return cls(
            max_details_per_company=env_int("ATS_MAX_DETAILS_PER_COMPANY", cls.max_details_per_company),
            max_requests_per_company=env_int("ATS_MAX_REQUESTS_PER_COMPANY", cls.max_requests_per_company),
            company_time_budget_s=env_int("ATS_COMPANY_TIME_BUDGET_S", cls.company_time_budget_s),
            ats_time_budget_s=env_int("ATS_TIME_BUDGET_S", cls.ats_time_budget_s),
            max_body_mb=env_int("ATS_MAX_BODY_MB", cls.max_body_mb),
            robots_override=frozenset(override),
        )


# ---------------------------------------------------------------------------------------------------------------------
# Dates (all return the calendar date in IST, or None)
# ---------------------------------------------------------------------------------------------------------------------

def today_ist():
    return datetime.now(IST).date()


def _as_ist_date(moment):
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)  # a naive timestamp from an API is UTC
    return moment.astimezone(IST).date()


def date_from_epoch(value, unit="ms"):
    """Epoch milliseconds (unit="ms", Lever createdAt) or seconds (unit="s", Darwinbox posted_on) -> IST date."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    seconds = number / 1000 if unit == "ms" else number
    try:
        return datetime.fromtimestamp(seconds, timezone.utc).astimezone(IST).date()
    except (OverflowError, OSError, ValueError):
        return None


_DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_FRACTION_RE = re.compile(r"(\.\d+)")


def date_from_iso(value):
    """ISO 8601 -> IST date. A date-only value ('2026-10-09', Workable published_on, Oracle PostedDate) is taken as that
    calendar day as is; a timestamp with an offset or 'Z' is converted to IST; a naive timestamp is taken as UTC."""
    text = str(value or "").strip()
    if not text:
        return None
    if _DATE_ONLY_RE.match(text):
        try:
            return date.fromisoformat(text)
        except ValueError:
            return None
    text = text.replace("Z", "+00:00").replace("z", "+00:00")
    # any number of fraction digits -> 6
    text = _FRACTION_RE.sub(lambda m: (m.group(1) + "000000")[:7], text, count=1)
    try:
        return _as_ist_date(datetime.fromisoformat(text))
    except ValueError:
        return None


def date_from_text(value, formats=("%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y", "%Y-%m-%d", "%d/%m/%Y",
                                   "%d.%m.%Y")):
    """A date-only display string ('Oct 9, 2026') -> that date; tries formats in order. Day-first for numeric dates;
    pass formats explicitly for a site that uses month-first."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text:
        return None
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


_JAVA_DATE_RE = re.compile(r"^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\w+) (\d{4})$")


def date_from_java(value):
    """Java Date.toString ('Fri Oct 09 02:00:00 UTC 2026', SuccessFactors datePosted) -> IST date. Zones other than
    UTC / GMT are read as UTC (only UTC was seen)."""
    match = _JAVA_DATE_RE.match(str(value or "").strip())
    if not match:
        return None
    month, day, hh, mm, ss, _zone, year = match.groups()
    try:
        moment = datetime.strptime(f"{year} {month} {day} {hh}:{mm}:{ss}", "%Y %b %d %H:%M:%S")
    except ValueError:
        return None
    return _as_ist_date(moment.replace(tzinfo=timezone.utc))


def days_ago(posted_on, today):
    """Whole days from posted_on to today (0 = today); a date in the future (time zones) counts as today."""
    return max(0, (today - posted_on).days)


# ---------------------------------------------------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------------------------------------------------

def html_to_text(value, unescape=False):
    """Plain one-line text of an HTML fragment (unescape=True first decodes an entity-escaped one, e.g. Darwinbox jd)."""
    text = str(value or "")
    if unescape:
        text = html_lib.unescape(text)
    if not text.strip():
        return ""
    if "<" in text or "&" in text:
        text = BeautifulSoup(text, "html.parser").get_text(" ", strip=True)
    return sanitize_text(text)


def join_text(*parts):
    """Non-empty parts joined by single spaces (each already plain text)."""
    return sanitize_text(" ".join(part for part in parts if part and str(part).strip()))


def clean_value(value):
    return sanitize_text(value)


# Employment types in the vocabulary app.employment_kind (supabase/app_api.sql) and LinkedIn use
_EMPLOYMENT_RULES = [
    (re.compile(r"\bintern(?:ship)?s?\b|\btrainee|\bapprentice", re.I), "Internship"),
    (re.compile(r"part[\s_-]*time", re.I), "Part-time"),
    (re.compile(r"contract|contractual|freelance|consultant|fixed[\s_-]*term", re.I), "Contract"),
    (re.compile(r"temp", re.I), "Temporary"),
    (re.compile(r"volunteer", re.I), "Volunteer"),
    (re.compile(r"full[\s_-]*time|permanent|regular|employee", re.I), "Full-time"),
]


def normalize_employment(value):
    """'Full Time Employee' / 'FullTime' / 'Permanent' -> 'Full-time'; 'Intern' -> 'Internship'; unknown -> ''."""
    text = str(value or "").strip()
    if not text:
        return ""
    for pattern, label in _EMPLOYMENT_RULES:
        if pattern.search(text):
            return label
    return ""


# Seniority in LinkedIn's vocabulary (03_enrich LINKEDIN_LEVELS reads these)
_SENIORITY = {
    "internship": "Internship", "intern": "Internship",
    "entry level": "Entry level", "entry": "Entry level", "junior": "Entry level", "graduate": "Entry level",
    "associate": "Associate",
    "mid-senior level": "Mid-Senior level", "mid senior level": "Mid-Senior level", "mid-senior": "Mid-Senior level",
    "mid level": "Mid-Senior level", "senior": "Mid-Senior level", "experienced": "Mid-Senior level",
    "director": "Director", "executive": "Executive",
}


def normalize_seniority(value):
    """SmartRecruiters / Workable labels ('Mid-Senior Level', 'Entry level') -> LinkedIn's; 'Not Applicable' -> ''."""
    return _SENIORITY.get(re.sub(r"\s+", " ", str(value or "")).strip().lower(), "")


# ---------------------------------------------------------------------------------------------------------------------
# India
# ---------------------------------------------------------------------------------------------------------------------

INDIA_PLACES = [
    "india", "bharat",
    # metros and large tech cities (alternate spellings included)
    "bengaluru", "bangalore", "hyderabad", "secunderabad", "pune", "mumbai", "bombay", "navi mumbai", "thane",
    "noida", "greater noida", "gurgaon", "gurugram", "delhi", "new delhi", "delhi ncr", "ncr", "chennai", "madras",
    "kolkata", "calcutta", "ahmedabad", "gandhinagar", "jaipur", "kochi", "cochin", "trivandrum", "thiruvananthapuram",
    "coimbatore", "mysore", "mysuru", "mangalore", "mangaluru", "chandigarh", "mohali", "panchkula", "indore", "bhopal",
    "nagpur", "nashik", "lucknow", "kanpur", "vadodara", "baroda", "surat", "rajkot", "visakhapatnam", "vizag",
    "vijayawada", "bhubaneswar", "guwahati", "goa", "faridabad", "ghaziabad", "ludhiana", "dehradun", "patna",
    "ranchi", "raipur", "madurai", "tiruchirappalli", "trichy", "hubli", "hubballi", "belgaum", "belagavi", "udaipur",
    "jodhpur", "amritsar", "jamshedpur", "manesar", "kakinada", "warangal", "tirupati", "aurangabad",
    # states
    "karnataka", "maharashtra", "telangana", "tamil nadu", "andhra pradesh", "kerala", "haryana", "uttar pradesh",
    "gujarat", "west bengal", "rajasthan", "odisha", "madhya pradesh", "uttarakhand", "chhattisgarh", "jharkhand",
    "bihar", "assam",
]
# Word boundaries on letters, so 'Indiana' and 'Indianapolis' are not India
INDIA_RE = re.compile(r"(?<![a-z])(?:" + "|".join(re.escape(p) for p in sorted(INDIA_PLACES, key=len, reverse=True))
                      + r")(?![a-z])", re.I)
INDIA_COUNTRY_VALUES = {"in", "ind", "india", "republic of india", "bharat"}


def is_india_country(value):
    """A structured country field (ISO-2 / ISO-3 code or name, any case) that is India."""
    return str(value or "").strip().lower() in INDIA_COUNTRY_VALUES


def mentions_india(text):
    return bool(INDIA_RE.search(str(text or "")))


# ---------------------------------------------------------------------------------------------------------------------
# Postings and rows
# ---------------------------------------------------------------------------------------------------------------------

WORKPLACE_LABELS = {"remote": "Remote", "hybrid": "Hybrid", "onsite": "Onsite"}


@dataclass
class Posting:
    """One job, normalised by an adapter's parse() (and fetch_detail()).

    locations   display strings, most specific first ('Bengaluru, Karnataka, India'); every location of the job
    countries   structured country values the board gives (ISO codes or names); [] when it gives none
    india       adapter override of the India check (True / False); None = decide from countries + locations
    posted_on   the posting's IST calendar date (date_from_* helpers); None = unknown (dropped unless a detail sets it)
    description HTML (description_html=True, the default) or plain text; base turns it into one line of text
    workplace   'remote' | 'hybrid' | 'onsite' | None, appended to the location so the app's work_mode sees it
    needs_detail  True when fetch_detail() should run for this posting (list without description / date / location)
    extra       adapter-private values for fetch_detail() (ids, detail URL)
    """
    job_id: str
    title: str
    job_url: str
    locations: list = field(default_factory=list)
    countries: list = field(default_factory=list)
    india: bool | None = None
    posted_on: date | None = None
    description: str = ""
    description_html: bool = True
    workplace: str | None = None
    employment_type: str = ""
    seniority_level: str = ""
    job_function: str = ""
    industries: str = ""
    needs_detail: bool = False
    extra: dict = field(default_factory=dict)


def classify_india(posting):
    """True = in India (a country field or a location says so), False = only other countries, None = unknown."""
    if posting.india is not None:
        return posting.india
    if any(is_india_country(country) for country in posting.countries):
        return True
    if any(mentions_india(location) for location in posting.locations):
        return True
    if [country for country in posting.countries if str(country or "").strip()]:
        return False
    return None


def _unique(values):
    seen, result = set(), []
    for value in values:
        text = clean_value(value)
        key = text.lower()
        if text and key not in seen:
            seen.add(key)
            result.append(text)
    return result


def location_text(posting, india):
    """'; '-joined locations, India ones first (02_ingest_silver takes the country from the first one and matches
    is_india against ops.ref_india_locations). An India job whose text names no Indian place gets an 'India' segment
    first, so the pipeline keeps it. The workplace label ('Remote', 'Hybrid', 'Onsite') is appended in brackets."""
    # A segment without a single letter ('.', '-', '0') is a placeholder some boards publish, not a place
    locations = [location for location in _unique(posting.locations) if re.search(r"[^\W\d_]", location)]
    indian = [location for location in locations if mentions_india(location)]
    ordered = indian + [location for location in locations if location not in indian]
    if india and not indian:
        ordered = ["India", *ordered]
    text = "; ".join(ordered)
    label = WORKPLACE_LABELS.get((posting.workplace or "").lower())
    if label and label.lower() not in text.lower():
        text = f"{text} ({label})" if text else label
    return text


def job_key(ats, company_name, job_id):
    """The pipeline's job_key: sha2(concat_ws('|', lower(ats_type), lower(trim(company_name)), job_id), 256)."""
    raw = f"{str(ats).strip().lower()}|{str(company_name).strip().lower()}|{str(job_id).strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def posting_row(adapter, target, company_name, posting, india, today):
    """One CSV row (scraper_common.OUTPUT_COLUMNS) for a posting with a known posted_on."""
    description = posting.description or ""
    description = html_to_text(description) if posting.description_html else sanitize_text(description)
    return {
        "company_name": company_name,
        "ats_type": adapter.name,
        "company_url": adapter.board_url(target),
        "job_id": str(posting.job_id).strip(),
        "title": clean_value(posting.title),
        "location": location_text(posting, india),
        "posted_date": format_calendar_date(posting.posted_on),
        "job_url": clean_value(posting.job_url),
        "description": description[:MAX_DESCRIPTION_CHARS],
        "collected_on": format_calendar_date(today),
        "posted_days": days_ago(posting.posted_on, today),
        "seniority_level": clean_value(posting.seniority_level),
        "employment_type": clean_value(posting.employment_type),
        "job_function": clean_value(posting.job_function),
        "industries": clean_value(posting.industries),
    }


# ---------------------------------------------------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------------------------------------------------

class HttpError(ScrapeFailed):
    """A response with an unexpected status; str() is the short report reason ('HTTP 404', 'HTTP 403 blocked')."""

    def __init__(self, status, url, body="", blocked=False):
        super().__init__(f"HTTP {status}" + (" blocked by the site's bot protection" if blocked else ""))
        self.status = status
        self.url = url
        self.body = (body or "")[:500]
        self.blocked = blocked


class RobotsDisallowed(ScrapeFailed):
    pass


RETRY_STATUSES = {429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
_BLOCK_MARKERS = ("attention required", "sorry, you have been blocked", "w4s-", "waf4saas", "cf-chl", "captcha",
                  "access denied", "request unsuccessful. incapsula")


def looks_blocked(status, text, content_type=""):
    """A WAF / bot-check page rather than an API answer (Cloudflare, Oracle WAF4SaaS, Incapsula)."""
    if status not in (403, 429, 503):
        return False
    sample = (text or "")[:3000].lower()
    return any(marker in sample for marker in _BLOCK_MARKERS) or ("html" in (content_type or "").lower() and status == 403)


class RobotsRules:
    """robots.txt rules for one user agent, Google's way: the most specific group (our product token, else '*'), the
    longest matching rule wins and Allow wins a tie ('Disallow: /' + 'Allow: /careers' allows /careers/api/...).
    Python's urllib.robotparser uses first match instead, which gets that case wrong."""

    def __init__(self, text, agent=BOT_NAME):
        groups, current, in_agents = [], None, False
        for raw_line in (text or "").splitlines():
            line = raw_line.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, value = (part.strip() for part in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                if not in_agents:
                    current = {"agents": [], "rules": [], "delay": None}
                    groups.append(current)
                current["agents"].append(value.lower())
                in_agents = True
                continue
            in_agents = False
            if current is None:
                continue
            if key in ("allow", "disallow"):
                if value:  # an empty Disallow allows everything: no rule
                    current["rules"].append((key == "allow", value))
            elif key == "crawl-delay":
                try:
                    current["delay"] = float(value)
                except ValueError:
                    pass
        token = agent.lower()
        specific = [g for g in groups if any(a != "*" and a in token for a in g["agents"])]
        chosen = specific or [g for g in groups if "*" in g["agents"]]
        self.rules = [rule for group in chosen for rule in group["rules"]]
        delays = [group["delay"] for group in chosen if group["delay"] is not None]
        self.crawl_delay = max(delays) if delays else None

    @staticmethod
    def _matches(pattern, path):
        regex = re.escape(pattern).replace(r"\*", ".*")
        if regex.endswith(r"\$"):
            regex = regex[:-2] + "$"
        return re.match(regex, path) is not None

    def allowed(self, path):
        best = None  # (length, allow)
        for allow, pattern in self.rules:
            if self._matches(pattern, path):
                candidate = (len(pattern), allow)
                if best is None or candidate[0] > best[0] or (candidate[0] == best[0] and allow):
                    best = candidate
        return True if best is None else best[1]


class Http:
    """Polite HTTP for one ATS run: shared by its companies (so the per-host delay holds across them).

    request() waits until `delay` seconds (or the host's Crawl-delay, at most 10 s) have passed since the last request to
    the same host, retries 429 / 5xx / timeouts / connection errors `attempts` times with exponential backoff (Retry-After
    honoured, at most 60 s), and raises HttpError for any status not in `ok`. Before the first request to a host it reads
    robots.txt (one attempt; a missing, non-text or erroring robots.txt allows everything) and raises RobotsDisallowed when
    it disallows the path, unless the ATS is in Settings.robots_override.
    """

    def __init__(self, ats, *, settings=None, session=None, delay=1.0, timeout=30, attempts=3, headers=None,
                 respect_robots=True, sleep=time.sleep, clock=time.monotonic):
        self.ats = ats
        self.settings = settings or Settings()
        self.session = session or requests.Session()
        self.delay = delay
        self.timeout = timeout
        self.attempts = attempts
        self.headers = {"User-Agent": user_agent(), "Accept": "application/json, text/html;q=0.9, */*;q=0.5",
                        **(headers or {})}
        self.respect_robots = respect_robots and ats not in self.settings.robots_override
        self.sleep = sleep
        self.clock = clock
        self.requests = 0          # this company's requests (reset_budget() per company)
        self.total_requests = 0
        self._last = {}            # host -> clock() of the last request
        self._robots = {}          # host -> RobotsRules | None

    def reset_budget(self):
        self.requests = 0

    def _wait(self, host):
        rules = self._robots.get(host)
        delay = max(self.delay, min((rules.crawl_delay if rules else None) or 0, 10))
        last = self._last.get(host)
        if last is not None:
            remaining = delay - (self.clock() - last)
            if remaining > 0:
                self.sleep(remaining)
        self._last[host] = self.clock()

    def _count(self):
        self.requests += 1
        self.total_requests += 1
        if self.requests > self.settings.max_requests_per_company:
            raise ScrapeFailed(f"request budget reached ({self.settings.max_requests_per_company} requests)")

    def _check_robots(self, url):
        parsed = urlparse(url)
        host = (parsed.netloc or "").lower()
        if host not in self._robots:
            self._robots[host] = None
            robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
            try:
                self._wait(host)
                response = self.session.request("GET", robots_url, headers=self.headers, timeout=15,
                                                allow_redirects=False)
                text = response.text or ""
                content_type = (response.headers or {}).get("Content-Type", "")
                if response.status_code == 200 and "<html" not in text[:1000].lower() and "html" not in content_type:
                    self._robots[host] = RobotsRules(text)
            except requests.RequestException:
                pass
        rules = self._robots[host]
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        if rules is not None and not rules.allowed(path):
            raise RobotsDisallowed(f"robots.txt of {host} disallows {parsed.path} (owner decision: ATS_ROBOTS_OVERRIDE)")

    def request(self, method, url, *, params=None, json_body=None, data=None, headers=None, allow_redirects=True,
                ok=(200,), timeout=None):
        if self.respect_robots:
            self._check_robots(url)
        host = (urlparse(url).netloc or "").lower()
        merged = {**self.headers, **(headers or {})}
        error = "failed"
        for attempt in range(1, self.attempts + 1):
            self._count()
            self._wait(host)
            retry_after = None
            try:
                response = self.session.request(method, url, params=params, json=json_body, data=data, headers=merged,
                                                timeout=timeout or self.timeout, allow_redirects=allow_redirects)
            except (requests.Timeout, requests.ConnectionError) as exc:
                error = f"{type(exc).__name__}: {short_error(exc, 120)}"
            except requests.RequestException as exc:
                raise ScrapeFailed(f"{type(exc).__name__}: {short_error(exc, 120)}") from exc
            else:
                status = response.status_code
                size = len(response.content or b"")
                if size > self.settings.max_body_mb * 1024 * 1024:
                    raise ScrapeFailed(f"response over {self.settings.max_body_mb} MB")
                if status in ok:
                    return response
                content_type = (response.headers or {}).get("Content-Type", "")
                text = response.text or ""
                blocked = looks_blocked(status, text, content_type)
                if status not in RETRY_STATUSES or (blocked and status == 403):
                    raise HttpError(status, url, text, blocked)
                error = f"HTTP {status}" + (" blocked by the site's bot protection" if blocked else "")
                retry_after = _retry_after_seconds((response.headers or {}).get("Retry-After"))
            if attempt < self.attempts:
                backoff = retry_after if retry_after is not None else 2 ** attempt * max(self.delay, 1)
                self.sleep(min(backoff, 60))
        raise ScrapeFailed(error)

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def get_json(self, url, **kwargs):
        return _json(self.request("GET", url, **kwargs))

    def post_json(self, url, body, **kwargs):
        return _json(self.request("POST", url, json_body=body, **kwargs))

    def get_text(self, url, **kwargs):
        return self.request("GET", url, **kwargs).text or ""


def _retry_after_seconds(value):
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            return max(0.0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError):
            return None


def _json(response):
    try:
        return response.json()
    except ValueError as exc:
        host = urlparse(getattr(response, "url", "") or "").netloc
        raise ScrapeFailed(f"invalid JSON from {host or 'the board'}") from exc


# ---------------------------------------------------------------------------------------------------------------------
# The adapter interface
# ---------------------------------------------------------------------------------------------------------------------

class AtsAdapter:
    """Base class of one ATS. Class attributes configure the run; override the four methods."""
    name = ""               # the companies.ats_type value, CSV prefix, report source and app.jobs.source (no '_')
    label = ""              # display name ('SmartRecruiters')
    request_delay = 1.0     # seconds between requests to one host (robots Crawl-delay wins when longer)
    timeout = 30            # seconds per request
    attempts = 3            # tries per request (retries only on 429 / 5xx / timeouts)
    respect_robots = True
    extra_headers = {}      # sent with every request (e.g. Darwinbox's sec-fetch-mode)

    def make_http(self, settings=None, session=None, sleep=time.sleep, clock=time.monotonic):
        return Http(self.name, settings=settings, session=session, delay=self.request_delay, timeout=self.timeout,
                    attempts=self.attempts, headers=self.extra_headers, respect_robots=self.respect_robots,
                    sleep=sleep, clock=clock)

    def source_columns(self, value):
        """What Settings > Companies stores for a pasted board URL / identifier: {"slug": ..., "api_url": ...}, or None
        when the value is not one of this ATS's accepted forms. Pure (no network). The cases in
        tests/ats/fixtures/<name>/url_cases.json pin it, and src/ (the form) must give the same answers."""
        raise NotImplementedError

    def identify(self, company):
        """The board to read, as a dict, from the companies row (keys name, ats_type, slug, api_url). Accept every URL
        form the Settings form accepts in either column, and a bare identifier. Raise ScrapeFailed('Missing <X> URL')
        when both columns are empty and ScrapeFailed('Unable to derive <X> board') when neither parses."""
        raise NotImplementedError

    def fetch(self, http, target, ctx):
        """Every raw posting of the board (follow pagination; stop early once a newest-first list passes ctx.cutoff).
        Raise ScrapeFailed / HttpError when the board cannot be read; return [] for a board with no openings."""
        raise NotImplementedError

    def parse(self, raw, target, ctx):
        """One raw posting -> Posting, or None to skip it (no id / title / URL, unlisted)."""
        raise NotImplementedError

    def fetch_detail(self, http, target, posting, ctx):
        """Optional: return the posting with its description (and posted_on / locations when the list lacks them).
        Only called for postings with needs_detail=True that passed the India and date filters."""
        return posting

    def board_url(self, target):
        """The public board URL (the CSV's company_url column)."""
        return target.get("board_url", "")

    @property
    def has_detail(self):
        return type(self).fetch_detail is not AtsAdapter.fetch_detail


def company_values(company, columns=("api_url", "slug")):
    """The non-empty, stripped values of the given companies-row columns, in order."""
    return [str(company.get(column) or "").strip() for column in columns if str(company.get(column) or "").strip()]


def url_host(value):
    """Lower-case host of a URL (scheme optional), '' when it is not one."""
    text = str(value or "").strip()
    if not text:
        return ""
    parsed = urlparse(text if "://" in text else f"https://{text}")
    return (parsed.hostname or "").lower()


# ---------------------------------------------------------------------------------------------------------------------
# One company
# ---------------------------------------------------------------------------------------------------------------------

@dataclass
class Context:
    """What a run knows: today (IST), the posted-date window and the jobs the pipeline already has."""
    today: date
    max_days: int
    seen_keys: frozenset = frozenset()
    settings: Settings = field(default_factory=Settings)

    @property
    def cutoff(self):
        """The oldest posted_on that is kept."""
        return self.today - timedelta(days=self.max_days)

    def too_old(self, posted_on):
        return posted_on is not None and posted_on < self.cutoff

    def recent(self, posted_on):
        return posted_on is not None and posted_on >= self.cutoff


@dataclass
class CompanyResult:
    name: str
    ok: bool = False
    error: str | None = None
    found: int = 0               # raw postings the board returned (the report's jobs_found)
    parsed: int = 0              # distinct postings after parse (summed into totals.jobs_scraped)
    india: int = 0               # parsed postings in India or of unknown country
    rows: list = field(default_factory=list)
    details_fetched: int = 0
    details_failed: int = 0
    already_seen: int = 0        # detail fetches skipped: the pipeline already has the job
    warnings: list = field(default_factory=list)

    @property
    def missing_descriptions(self):
        return sum(1 for row in self.rows if not row.get("description"))


def merge_duplicates(postings):
    """One Posting per job_id (Workable repeats a job once per location): locations and countries are unioned."""
    merged = {}
    for posting in postings:
        key = str(posting.job_id).strip()
        if key in merged:
            first = merged[key]
            first.locations.extend(location for location in posting.locations if location not in first.locations)
            first.countries.extend(country for country in posting.countries if country not in first.countries)
        else:
            merged[key] = posting
    return list(merged.values())


def run_company(adapter, http, company, ctx, log=print):
    """Scrape one company: identify -> fetch -> parse -> India + date filters -> detail fetches -> rows.

    Never raises for the company's own problems: they end up in CompanyResult.error (ok=False). A posting that fails to
    parse is skipped with a warning; a failed detail fetch leaves that job without a description.
    """
    name = str(company.get("name") or "").strip() or "Unknown"
    result = CompanyResult(name=name)
    started = time.monotonic()
    http.reset_budget()
    try:
        target = adapter.identify(company)
        raw_postings = list(adapter.fetch(http, target, ctx) or [])
    except ScrapeFailed as exc:
        result.error = str(exc) or "failed"
        return result
    except Exception as exc:  # an adapter bug fails this company only
        result.error = f"{type(exc).__name__}: {short_error(exc)}"
        return result

    result.found = len(raw_postings)
    postings, parse_errors = [], 0
    for raw in raw_postings:
        try:
            posting = adapter.parse(raw, target, ctx)
        except Exception as exc:
            parse_errors += 1
            if parse_errors == 1:
                result.warnings.append(f"skipped postings that failed to parse: {type(exc).__name__}: {short_error(exc)}")
            continue
        if posting and str(posting.job_id or "").strip() and str(posting.title or "").strip() and posting.job_url:
            postings.append(posting)
    postings = merge_duplicates(postings)
    result.parsed = len(postings)

    candidates = [p for p in postings if classify_india(p) is not False and not ctx.too_old(p.posted_on)]
    result.india = sum(1 for p in postings if classify_india(p) is not False)

    if adapter.has_detail:
        # newest first; an unknown date first of all (a detail may be the only way to learn it), board order kept
        pending = sorted((p for p in candidates if p.needs_detail),
                         key=lambda p: -(p.posted_on or ctx.today + timedelta(days=1)).toordinal())
        budget, failures_in_a_row = ctx.settings.max_details_per_company, 0
        position = {id(posting): index for index, posting in enumerate(candidates)}
        for posting in pending:
            if posting.posted_on is not None and job_key(adapter.name, name, posting.job_id) in ctx.seen_keys:
                result.already_seen += 1  # the pipeline has its description; the row refreshes last_seen_at
                continue
            if budget <= 0:
                result.warnings.append(f"detail fetch cap reached ({ctx.settings.max_details_per_company})")
                break
            if time.monotonic() - started > ctx.settings.company_time_budget_s:
                result.warnings.append("company time budget reached; remaining jobs keep no description")
                break
            budget -= 1
            try:
                updated = adapter.fetch_detail(http, target, posting, ctx) or posting
                candidates[position[id(posting)]] = updated
                updated.needs_detail = False
                result.details_fetched += 1
                failures_in_a_row = 0
            except Exception as exc:
                result.details_failed += 1
                failures_in_a_row += 1
                if failures_in_a_row >= ctx.settings.detail_failures_stop:
                    reason = str(exc) if isinstance(exc, ScrapeFailed) else f"{type(exc).__name__}: {short_error(exc)}"
                    result.warnings.append(f"detail fetches stopped after {failures_in_a_row} failures in a row: {reason}")
                    break

    for posting in candidates:
        india = classify_india(posting)
        if india is False or not ctx.recent(posting.posted_on):
            continue
        result.rows.append(posting_row(adapter, target, name, posting, india, ctx.today))

    result.ok = True
    for warning in result.warnings:
        log(f"    [WARN] {adapter.name} / {name}: {warning}")
    return result
