"""SAP SuccessFactors Recruiting Marketing ('Career Site Builder' / RMK) career sites: server-rendered HTML, no browser.

LIST   GET https://{host}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow={k}[&optionsFacetsDD_country=IN]
       25 rows a page, newest first. Two templates: a table (tr.data-row) and tiles (li.job-tile); which columns appear
       (location, date, department) is configured per site. The total is the last number of span.paginationLabel
       ('Results 1 - 25 of 601') or #tile-search-results-label ('Showing 1 to 25 of 67 Jobs').
       The country facet is used only on boards with more than 200 jobs: sites that leave the country empty lose their
       India jobs under the facet (Air India: 17 jobs, all in India, 1 under the facet), so smaller boards are read
       unfiltered and classified here. Paging stops at the first row older than the window.
DETAIL GET https://{host}/job/{slug}/{id}/ : schema.org microdata (datePosted as Java Date.toString, address parts) and
       span.jobdescription. The list has no description, so every row has needs_detail=True.
robots.txt (the same on every RMK host) allows /search/ and /job/ and disallows /services/ (the RSS / XML feeds) and the
classic career{N}.successfactors.* / *.sapsf.com hosts disallow everything, so those links are rejected.

companies row: api_url=https://{host}, slug={host}
"""
import re
from datetime import timedelta
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from ats.base import (
    AtsAdapter,
    Posting,
    company_values,
    date_from_java,
    date_from_text,
    mentions_india,
)
from scraper_common import ScrapeFailed

PAGE_SIZE = 25
UNFILTERED_MAX = 200     # boards up to this size are read without the country facet
HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
CLASSIC_RE = re.compile(r"(^|\.)career\d*\.successfactors\.[a-z]+$|(^|\.)sapsf\.(com|eu|cn)$|(^|\.)successfactors\.(com|eu)$")
JOB_ID_RE = re.compile(r"/job/[^/?#]+/(\d+)/?")
DATE_FORMATS = ("%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y", "%Y-%m-%d", "%d/%m/%Y", "%d.%m.%Y", "%m/%d/%Y",
                "%b %d %Y")
# a site whose numeric dates are month-first (en_US '10/13/2026'): detected from the rows, see date_order()
MDY_FORMATS = ("%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y", "%Y-%m-%d", "%m/%d/%Y", "%m.%d.%Y", "%d/%m/%Y",
               "%b %d %Y")
NUMERIC_DATE_RE = re.compile(r"^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s*$")
COUNTRY_CODE_RE = re.compile(r"^[A-Z]{2}$")
# a trailing country token: 'IN', or a code followed by its name ('IN India', 'US United States')
COUNTRY_TOKEN_RE = re.compile(r"^([A-Z]{2})(?:\s+[A-Za-z][A-Za-z .()'&-]*)?$")
TILE_FIELD_RE = re.compile(r"-desktop-section-([a-z0-9_]+)-value$")
LOCATION_FIELDS = ("location", "city", "state", "country", "multilocation")
DATE_FIELDS = ("date", "referencedate", "posteddate")
DEPARTMENT_FIELDS = ("department", "dept", "category", "jobfunction")


def parse_host(value):
    """The career site's host from a URL or bare domain; None for anything else and for the robots-disallowed classic
    SuccessFactors hosts."""
    text = str(value or "").strip()
    if not text or any(ch.isspace() for ch in text):
        return None
    parsed = urlparse(text if "://" in text else f"https://{text}")
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower()
    if not HOST_RE.fullmatch(host) or CLASSIC_RE.search(host):
        return None
    return host


def last_number(text):
    numbers = re.findall(r"\d[\d,.]*", str(text or ""))
    if not numbers:
        return None
    try:
        return int(re.sub(r"[,.]", "", numbers[-1]))
    except ValueError:
        return None


def _text(element):
    return re.sub(r"\s+", " ", element.get_text(" ", strip=True)).strip() if element is not None else ""


def parse_search_page(html):
    """(total | None, rows) of a /search/ page; rows are dicts href/title/location/date/department."""
    soup = BeautifulSoup(html or "", "html.parser")
    label = soup.select_one(".paginationLabel") or soup.select_one("#tile-search-results-label")
    total = last_number(_text(label)) if label is not None else None
    rows = []
    for row in soup.select("tr.data-row"):
        link = row.select_one("a.jobTitle-link")
        if link is None or not link.get("href"):
            continue
        location = row.select_one("td.colLocation .jobLocation") or row.select_one(".jobLocation")
        posted = row.select_one("td.colDate .jobDate") or row.select_one(".jobDate")
        department = row.select_one(".jobDepartment")
        rows.append({"href": link["href"], "title": _text(link), "location": _text(location),
                     "date": _text(posted), "department": _text(department)})
    for tile in soup.select("li.job-tile"):
        link = tile.select_one("a.jobTitle-link")
        href = tile.get("data-url") or (link.get("href") if link is not None else "")
        if not href:
            continue
        fields = {}
        for element in tile.select("[id*='-desktop-section-']"):
            match = TILE_FIELD_RE.search(element.get("id") or "")
            if match and match.group(1) not in fields:
                fields[match.group(1)] = _text(element)
        location = ", ".join(fields[name] for name in LOCATION_FIELDS if fields.get(name))
        rows.append({"href": href, "title": _text(link), "location": location,
                     "date": next((fields[name] for name in DATE_FIELDS if fields.get(name)), ""),
                     "department": next((fields[name] for name in DEPARTMENT_FIELDS if fields.get(name)), "")})
    return total, rows


def location_countries(location, india_facet=False):
    """Country codes a list location ends with: 'INDIA - BENGALURU - HP, IN' -> ['IN'], 'Noida, IN' -> ['IN'],
    'Fort Wayne, IN, US' (Indiana) -> ['US'], 'Bangalore, Karnataka, IN India, 560087' -> ['IN'].
    A bare 'City, IN' whose city is no known Indian place is ambiguous with the US state code ('Indianapolis, IN'):
    it counts as India only on a board read with the India country facet, otherwise the detail page decides."""
    tokens = [token.strip() for token in str(location or "").split(",") if token.strip()]
    while tokens and re.fullmatch(r"[\d\s-]+", tokens[-1]):
        tokens.pop()  # postal code
    match = COUNTRY_TOKEN_RE.fullmatch(tokens[-1]) if tokens else None
    if not match:
        return []
    code = match.group(1)
    if (code == "IN" and tokens[-1] == "IN" and len(tokens) == 2 and not india_facet
            and not mentions_india(tokens[0])):
        return []
    return [code]


def date_order(dates):
    """'dmy' / 'mdy' when a numeric date of the site shows its order (a part above 12), None when none does."""
    for text in dates:
        match = NUMERIC_DATE_RE.match(str(text or ""))
        if not match:
            continue
        first, second = int(match.group(1)), int(match.group(2))
        if first > 12 >= second:
            return "dmy"
        if second > 12 >= first:
            return "mdy"
    return None


def list_date(text, order=None, today=None):
    """The date of a list row. Numeric dates follow the site's order. When the order is unknown and the date is
    ambiguous ('10/09/2026'), the latest reading that is not after today (+1 day for time zones) is used, so neither
    an early stop nor a dropped row comes from a misread date; the detail page's datePosted then sets the real date.
    Without today, day-first."""
    if order == "mdy":
        return date_from_text(text, MDY_FORMATS)
    if order is None and today is not None and NUMERIC_DATE_RE.match(str(text or "")):
        readings = [d for d in (date_from_text(text, DATE_FORMATS), date_from_text(text, MDY_FORMATS)) if d]
        past = [d for d in readings if d <= today + timedelta(days=1)]
        return max(past) if past else (min(readings) if readings else None)
    return date_from_text(text, DATE_FORMATS)


class SuccessFactorsAdapter(AtsAdapter):
    name = "successfactors"
    label = "SAP SuccessFactors"
    request_delay = 1.0
    timeout = 30

    def source_columns(self, value):
        host = parse_host(value)
        if not host:
            return None
        return {"slug": host, "api_url": f"https://{host}"}

    def identify(self, company):
        values = company_values(company)
        if not values:
            raise ScrapeFailed("Missing SAP SuccessFactors board URL")
        for value in values:
            host = parse_host(value)
            if host:
                return {"host": host}
        raise ScrapeFailed("Unable to derive SAP SuccessFactors board")

    def search_url(self, target, startrow, india_only):
        url = (f"https://{target['host']}/search/?q=&sortColumn=referencedate&sortDirection=desc"
               f"&startrow={startrow}")
        return url + ("&optionsFacetsDD_country=IN" if india_only else "")

    def fetch(self, http, target, ctx):
        total, rows = parse_search_page(http.get_text(self.search_url(target, 0, False)))
        if total is None and not rows:
            raise ScrapeFailed("not an SAP SuccessFactors career site (no job search results on /search/)")
        india_only = (total or 0) > UNFILTERED_MAX
        if india_only:
            unfiltered = (total, rows)
            total, rows = parse_search_page(http.get_text(self.search_url(target, 0, True)))
            if not rows:
                # no job under the country facet: the site does not fill the country (Air India) or has no such
                # facet, so the board is read unfiltered (newest first, stopped by date) and classified here
                india_only = False
                total, rows = unfiltered
        target["india_only"] = india_only
        collected = self._collect(http, target, ctx, total, rows, india_only)
        # the numeric date order of the site (a page of only ambiguous dates leaves it unknown: day-first)
        target["date_order"] = date_order(row["date"] for row in collected)
        return collected

    def _collect(self, http, target, ctx, total, rows, india_only):
        """The rows of every page from the first one (already read), newest first, until the window is passed."""
        collected, seen, startrow = [], set(), 0
        order = None
        while True:
            if not rows and (total or 0) > startrow:
                raise ScrapeFailed("unrecognised SuccessFactors page (results counted but no rows parsed)")
            new = [row for row in rows if row["href"] not in seen]
            for row in new:
                seen.add(row["href"])
                collected.append(row)
            if rows and not new:
                return collected  # the site ignored startrow and repeated a page
            startrow += len(rows) or PAGE_SIZE
            if not rows or (total is not None and startrow >= total) or (total is None and len(rows) < PAGE_SIZE):
                return collected
            order = order or date_order(row["date"] for row in collected)
            if any(ctx.too_old(list_date(row["date"], order, ctx.today)) for row in rows):
                return collected  # newest first: everything after this page is older
            total_next, rows = parse_search_page(http.get_text(self.search_url(target, startrow, india_only)))
            total = total_next if total_next is not None else total

    def parse(self, raw, target, ctx):
        if not isinstance(raw, dict):
            return None
        href = str(raw.get("href") or "")
        match = JOB_ID_RE.search(href)
        if not match:
            return None
        location = raw.get("location") or ""
        return Posting(
            job_id=match.group(1),
            title=raw.get("title") or "",
            job_url=urljoin(f"https://{target['host']}/", href),
            locations=[location] if location else [],
            countries=location_countries(location, bool(target.get("india_only"))),
            # the 'reference date' (refreshes on repost)
            posted_on=list_date(raw.get("date"), target.get("date_order"), ctx.today if ctx else None),
            job_function=raw.get("department") or "",
            needs_detail=True,
        )

    def fetch_detail(self, http, target, posting, ctx):
        soup = BeautifulSoup(http.get_text(posting.job_url), "html.parser")

        def prop(name):
            element = soup.select_one(f"[itemprop='{name}']")
            if element is None:
                return ""
            return str(element.get("content") or _text(element)).strip()

        def career_prop(name):
            return _text(soup.select_one(f"[data-careersite-propertyid='{name}']"))

        posted = date_from_java(prop("datePosted")) or list_date(career_prop("date"), target.get("date_order"), ctx.today if ctx else None)
        if posted:
            posting.posted_on = posted
        description = soup.select_one("span.jobdescription") or soup.select_one("[itemprop='description']")
        if description is not None:
            posting.description = description.decode_contents()
            posting.description_html = True
        country = prop("addressCountry") or career_prop("country")
        country = country if COUNTRY_CODE_RE.fullmatch(country) else ""  # junk values like 'No' are ignored
        if not posting.locations:
            locality = prop("addressLocality") or career_prop("city")
            location = career_prop("location") or ", ".join(part for part in (locality, country) if part)
            if location:
                posting.locations = [location]
        if country:
            posting.countries = [country]  # the job's own address beats a code guessed from the list text
        posting.job_function = posting.job_function or career_prop("department") or career_prop("dept")
        if not posting.title:
            posting.title = prop("title")
        return posting

    def board_url(self, target):
        return f"https://{target['host']}/"
