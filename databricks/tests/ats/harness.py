"""Offline test harness for the ATS adapters: recorded fixtures, a fake HTTP session and a row-contract check.

    from harness import FakeSession, assert_rows_valid, load_json, run_offline

    session = FakeSession().add("GET", r"api\\.lever\\.co/v0/postings/paytm", json=[posting])
    result = run_offline(LeverAdapter(), {"name": "Paytm", "ats_type": "lever", "slug": "paytm"}, session,
                         today=date(2026, 10, 9))
    assert_rows_valid(self, result.rows, "lever")

Fixtures live in fixtures/<ats>/ (trimmed live responses recorded on 2026-10-09; each file's "_request" says what was
called, and list fixtures keep only the first few postings). Refresh them from the research samples with
    python databricks/tests/ats/harness.py --sync [--samples DIR]
No test touches the network: FakeSession answers every request, and an unmatched one fails the test.
"""
import json
import os
import re
import shutil
import sys
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATABRICKS = HERE.parents[1]
for path in (str(HERE), str(DATABRICKS)):
    if path not in sys.path:
        sys.path.insert(0, path)

from ats.base import Context, Settings, run_company  # noqa: E402
from scraper_common import OUTPUT_COLUMNS  # noqa: E402

FIXTURES = HERE / "fixtures"
# The research probes' sample folder (set ATS_SAMPLES_DIR or pass --samples)
DEFAULT_SAMPLES = os.getenv("ATS_SAMPLES_DIR", "")


def fixture_path(ats, name):
    return FIXTURES / ats / name


def load_json(ats, name):
    return json.loads(fixture_path(ats, name).read_text(encoding="utf-8"))


def load_text(ats, name):
    return fixture_path(ats, name).read_text(encoding="utf-8")


class FakeResponse:
    """The parts of requests.Response the framework uses."""

    def __init__(self, status=200, json_body=None, text=None, headers=None, url=""):
        self.status_code = status
        if text is None:
            text = json.dumps(json_body) if json_body is not None else ""
        self.text = text
        self.content = text.encode("utf-8")
        self.headers = {"Content-Type": "application/json" if json_body is not None else "text/html", **(headers or {})}
        self.url = url
        self._json = json_body

    def json(self):
        if self._json is not None:
            return self._json
        return json.loads(self.text)


class FakeSession:
    """Answers requests from routes: add(method, url_regex, status=200, json=..., text=..., headers=...).

    A route may also be a callable(method, url, kwargs) -> FakeResponse. Routes match in order (re.search on the full
    URL with its query string); a route added with times=N answers N times, then the next matching route takes over.
    robots.txt is answered 404 unless a route matches it. Unmatched requests raise AssertionError.
    calls = [(method, url, kwargs), ...] for assertions.
    """

    def __init__(self):
        self.routes = []
        self.calls = []

    def add(self, method, pattern, status=200, json=None, text=None, headers=None, times=None, responder=None):
        self.routes.append({"method": method.upper(), "re": re.compile(pattern), "status": status, "json": json,
                            "text": text, "headers": headers, "times": times, "responder": responder})
        return self

    def request(self, method, url, params=None, **kwargs):
        full = url
        if params:
            from urllib.parse import urlencode
            full = f"{url}{'&' if '?' in url else '?'}{urlencode(params, doseq=True)}"
        self.calls.append((method.upper(), full, {"params": params, **kwargs}))
        for route in self.routes:
            if route["method"] != method.upper() or not route["re"].search(full):
                continue
            if route["times"] is not None:
                if route["times"] <= 0:
                    continue
                route["times"] -= 1
            if route["responder"]:
                return route["responder"](method.upper(), full, kwargs)
            return FakeResponse(route["status"], route["json"], route["text"], route["headers"], full)
        if full.endswith("/robots.txt"):
            return FakeResponse(404, text="Not Found", url=full)
        raise AssertionError(f"unexpected request {method} {full}")

    def urls(self, method=None):
        return [url for m, url, _ in self.calls if method is None or m == method.upper()]


def no_sleep(_seconds):
    return None


def run_offline(adapter, company, session, today=date(2026, 10, 9), max_days=7, seen_keys=frozenset(), settings=None):
    """run_company() with the fake session, no sleeping, and the given 'today' (IST)."""
    ctx = Context(today=today, max_days=max_days, seen_keys=frozenset(seen_keys), settings=settings or Settings())
    http = adapter.make_http(settings=ctx.settings, session=session, sleep=no_sleep)
    return run_company(adapter, http, company, ctx, log=lambda _message: None)


DMY_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")


def assert_rows_valid(case, rows, ats, today=date(2026, 10, 9), max_days=7):
    """The CSV row contract every adapter must meet (see contract.md, 'Rows')."""
    for row in rows:
        case.assertEqual(list(row), OUTPUT_COLUMNS, "row keys must be scraper_common.OUTPUT_COLUMNS in order")
        case.assertEqual(row["ats_type"], ats)
        for column in ("company_name", "job_id", "title", "job_url", "posted_date", "collected_on"):
            case.assertTrue(str(row[column]).strip(), f"{column} is empty: {row}")
        case.assertTrue(row["job_url"].startswith("https://"), row["job_url"])
        case.assertTrue(str(row["company_url"]).startswith("https://"), row["company_url"])
        case.assertRegex(row["posted_date"], DMY_RE)
        case.assertEqual(row["collected_on"], today.strftime("%d/%m/%Y"))
        posted = datetime.strptime(row["posted_date"], "%d/%m/%Y").date()
        case.assertEqual(row["posted_days"], max(0, (today - posted).days))
        case.assertGreaterEqual(row["posted_days"], 0)
        case.assertLessEqual(row["posted_days"], max_days)
        case.assertNotIn("\n", row["description"])
        case.assertNotRegex(row["description"], r"<(p|div|br|li|ul|span|strong)\b", "description must be plain text")
        for column in ("title", "location", "seniority_level", "employment_type", "job_function", "industries"):
            case.assertNotIn("\n", str(row[column]))
        case.assertIn(row["employment_type"], ("", "Full-time", "Part-time", "Contract", "Temporary", "Internship",
                                               "Volunteer", "Other"))


def sync(samples=DEFAULT_SAMPLES):
    """Copy the research samples into fixtures/ (overwrites files of the same name)."""
    samples = Path(samples) if samples else None
    if not samples or not samples.is_dir():
        raise SystemExit(f"no samples at {samples}")
    for source in samples.rglob("*"):
        if source.is_file():
            target = FIXTURES / source.relative_to(samples)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            print(f"[SYNC] {target.relative_to(HERE)}")


if __name__ == "__main__":
    if "--sync" in sys.argv:
        index = sys.argv.index("--samples") + 1 if "--samples" in sys.argv else None
        sync(sys.argv[index] if index else DEFAULT_SAMPLES)
    else:
        print(__doc__)
