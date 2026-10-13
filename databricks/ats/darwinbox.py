"""Darwinbox: the career site's own JSON API (no auth), on the tenant's host.

LIST   POST https://{host}/ms/candidateapi/job/alljobs?companyId={companyId}  body {"page": n, "limit": 100}
       -> {status: 'success', data: [...], job_counts: total}. Pages start at 1, at most 100 jobs a page, newest first by
       posted_on, so paging stops once a page ends before the window. The list carries the description (jd, entity-
       escaped once); the detail endpoint has the same jd, so there is no detail fetch. jd is empty for some jobs.
Errors: HTTP 500 JSON 'Invalid subdomain' / 'Error while getting tenant info' (no Darwinbox tenant behind the host).
Cloudflare answers 403 'Sorry, you have been blocked' to any request without a browser fetch-metadata header, whatever the
User-Agent, so every request sends 'sec-fetch-mode: cors' with the honest User-Agent. This was verified from one Indian
IP only; a challenge from GitHub runner IPs shows as 'HTTP 403 blocked by the site's bot protection' (no browser fallback).
robots.txt redirects to the login page (there is none), so nothing is disallowed.

companies row: api_url=https://{host}/ms/candidateapi/ (companyId 'main') or https://{host}/ms/candidateapi/?companyId={id}
(a group company), slug={companyId}. Board links .../ms/candidatev2/{companyId}/careers/... and the older
.../ms/candidate/[{companyId}/]careers... are accepted on *.darwinbox.in and *.darwinbox.com hosts.
"""
import html as html_lib
import re
from urllib.parse import parse_qs, quote, urlparse

from ats.base import (
    AtsAdapter,
    HttpError,
    Posting,
    company_values,
    date_from_epoch,
    normalize_employment,
)
from scraper_common import ScrapeFailed

PAGE_SIZE = 100
HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.darwinbox\.(in|com)$")
COMPANY_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NO_TENANT_MARKERS = ("invalid subdomain", "error while getting tenant info")
# Darwinbox appends the internal code to some labels: 'Collections (FA_0011)', 'Collections (CM_005)'
CODE_SUFFIX_RE = re.compile(r"\s*\((?:[A-Za-z0-9]+_[A-Za-z0-9_]+|[A-Z]{1,6}\d+)\)\s*$")


def parse_board(value):
    """(host, companyId) of a Darwinbox career / API link (companyId 'main' when the link names none); None otherwise."""
    text = str(value or "").strip()
    if not text or any(ch.isspace() for ch in text):
        return None
    parsed = urlparse(text if "://" in text else f"https://{text}")
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower()
    if not HOST_RE.fullmatch(host):
        return None
    parts = [part for part in (parsed.path or "").split("/") if part]
    company_id = "main"
    if len(parts) >= 2 and parts[0].lower() == "ms":
        section = parts[1].lower()
        if section in ("candidatev2", "candidate"):
            if len(parts) >= 3 and parts[2].lower() != "careers":
                company_id = parts[2]
        elif section == "candidateapi":
            company_id = (parse_qs(parsed.query).get("companyId") or ["main"])[0] or "main"
        else:
            return None
    elif parts:
        return None  # another page of the tenant (login, admin): not a career link
    if not COMPANY_ID_RE.fullmatch(company_id):
        return None
    return host, company_id


def api_base(host, company_id):
    return f"https://{host}/ms/candidateapi/" + ("" if company_id == "main" else f"?companyId={company_id}")


def strip_code(value):
    """'Collections (FA_0011)' -> 'Collections'; 'Engineering (Backend)' stays."""
    return CODE_SUFFIX_RE.sub("", str(value or "")).strip()


def clean_location(value):
    """'Gurugram, Haryana\\r, India' -> 'Gurugram, Haryana, India'."""
    text = re.sub(r"\s+", " ", str(value or "").replace("\r", " ")).strip()
    return re.sub(r"\s+,", ",", text).strip(" ,")


class DarwinboxAdapter(AtsAdapter):
    name = "darwinbox"
    label = "Darwinbox"
    request_delay = 1.0
    timeout = 30
    # Cloudflare blocks requests without a fetch-metadata header (the User-Agent stays the honest one)
    extra_headers = {"Accept": "application/json", "sec-fetch-mode": "cors"}

    def source_columns(self, value):
        board = parse_board(value)
        if not board:
            return None
        host, company_id = board
        return {"slug": company_id, "api_url": api_base(host, company_id)}

    def identify(self, company):
        values = company_values(company)
        if not values:
            raise ScrapeFailed("Missing Darwinbox board URL")
        slug = str(company.get("slug") or "").strip()
        for value in values:
            board = parse_board(value)
            if board:
                host, company_id = board
                # a bare group-company id in slug beside an api_url without companyId
                if company_id == "main" and value != slug and COMPANY_ID_RE.fullmatch(slug):
                    company_id = slug
                return {"host": host, "company_id": company_id}
        raise ScrapeFailed("Unable to derive Darwinbox board")

    def _post_page(self, http, target, page):
        url = f"https://{target['host']}/ms/candidateapi/job/alljobs?companyId={quote(target['company_id'], safe='')}"
        body = {"page": page, "limit": PAGE_SIZE}
        response = http.request("POST", url, json_body=body, ok=(200, 500))
        if response.status_code == 500:
            text = (response.text or "").lower()
            if any(marker in text for marker in NO_TENANT_MARKERS):
                raise ScrapeFailed(f"no Darwinbox careers site {target['host'].split('.')[0]!r}")
            response = http.request("POST", url, json_body=body)  # another 500: the usual retries
        try:
            payload = response.json()
        except ValueError as exc:
            raise ScrapeFailed("invalid JSON from Darwinbox") from exc
        if not isinstance(payload, dict) or str(payload.get("status") or "success").lower() != "success":
            raise ScrapeFailed("unexpected Darwinbox response")
        return payload

    def fetch(self, http, target, ctx):
        jobs, seen, page = [], set(), 1
        while True:
            try:
                payload = self._post_page(http, target, page)
            except HttpError as exc:
                if exc.status == 404:
                    raise ScrapeFailed(f"HTTP 404 (no Darwinbox careers site {target['host'].split('.')[0]!r})") from exc
                raise
            data = [job for job in payload.get("data") or [] if isinstance(job, dict)]
            added = 0
            for job in data:
                key = str(job.get("id") or "")
                if key and key not in seen:
                    seen.add(key)
                    jobs.append(job)
                    added += 1
            try:
                total = int(payload.get("job_counts") or 0)
            except (TypeError, ValueError):
                total = 0
            # job_counts decides (a tenant that pages by fewer than 100 still gets every page); without it a short
            # page is the last one; a page with nothing new means the site ignored 'page'
            if not data or not added or (total and len(jobs) >= total) or (not total and len(data) < PAGE_SIZE):
                return jobs
            if ctx.too_old(date_from_epoch(data[-1].get("posted_on"), "s")):
                return jobs  # newest first: the next pages are older still
            page += 1

    def parse(self, raw, target, ctx):
        if not isinstance(raw, dict) or not raw.get("id"):
            return None
        job_id = str(raw["id"]).strip()
        locations = [clean_location(value) for value in raw.get("officelocations_without_area") or []]
        if not any(locations):
            locations = [clean_location(value) for value in raw.get("tool_tip_locations") or []]
        country = str(raw.get("country") or "").strip()
        jd = html_lib.unescape(str(raw.get("jd") or ""))  # entity-escaped once
        try:
            remote = int(raw.get("is_remote") or 0) == 1
        except (TypeError, ValueError):
            remote = False
        return Posting(
            job_id=job_id,
            title=raw.get("title") or raw.get("designation_display_name") or raw.get("designation_name") or "",
            job_url=f"https://{target['host']}/ms/candidatev2/{target['company_id']}/careers/jobDetails/{job_id}",
            locations=[location for location in locations if location],
            countries=[country] if country else [],
            posted_on=date_from_epoch(raw.get("posted_on"), "s"),  # the careers posting start, not created_on
            description=jd,
            workplace="remote" if remote else None,
            employment_type=normalize_employment(raw.get("emp_type_name")),
            job_function=strip_code(raw.get("functional_area_name")) or strip_code(raw.get("department_name_only")
                                                                                   or raw.get("department_name")),
        )

    def board_url(self, target):
        return f"https://{target['host']}/ms/candidatev2/{target['company_id']}/careers/allJobs"
