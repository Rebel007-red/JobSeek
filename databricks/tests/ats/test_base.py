"""Offline tests of the ATS framework (ats/base.py, ats/registry.py): dates, India, robots, HTTP, run_company.

    python -m unittest discover -s databricks/tests/ats -t databricks/tests/ats
"""
import hashlib
import unittest
from datetime import date

from harness import FakeSession, fixture_path, load_json, no_sleep, run_offline  # noqa: F401

from ats import base, registry
from ats.base import (
    AtsAdapter,
    Http,
    HttpError,
    Posting,
    RobotsDisallowed,
    RobotsRules,
    Settings,
    classify_india,
    date_from_epoch,
    date_from_iso,
    date_from_java,
    date_from_text,
    html_to_text,
    job_key,
    location_text,
    normalize_employment,
    normalize_seniority,
)
from scraper_common import ScrapeFailed

TODAY = date(2026, 10, 9)


class DatesTest(unittest.TestCase):
    def test_epoch_ms_and_s_in_ist(self):
        # 2026-10-08 18:30 UTC = 2026-10-09 00:00 IST
        self.assertEqual(date_from_epoch(1791397800000, "ms"), date(2026, 10, 8))  # 2026-10-07 18:30 UTC
        self.assertEqual(date_from_epoch(1791397800, "s"), date(2026, 10, 8))
        self.assertEqual(date_from_epoch(1783043640931), date(2026, 7, 3))
        self.assertIsNone(date_from_epoch(None))
        self.assertIsNone(date_from_epoch("x"))
        self.assertIsNone(date_from_epoch(0))

    def test_iso(self):
        self.assertEqual(date_from_iso("2026-10-09"), date(2026, 10, 9))                 # date only: as is
        self.assertEqual(date_from_iso("2026-10-08T20:00:00Z"), date(2026, 10, 9))      # 01:30 IST next day
        self.assertEqual(date_from_iso("2026-10-07T01:16:00.83Z"), date(2026, 10, 7))   # 2-digit fraction
        self.assertEqual(date_from_iso("2026-04-17T11:46:39.214+00:00"), date(2026, 4, 17))
        self.assertEqual(date_from_iso("2026-10-09T09:27:12.993Z"), date(2026, 10, 9))
        self.assertEqual(date_from_iso("2026-10-08T19:00:00"), date(2026, 10, 9))       # naive = UTC
        self.assertIsNone(date_from_iso(""))
        self.assertIsNone(date_from_iso("yesterday"))

    def test_text_and_java(self):
        self.assertEqual(date_from_text("Oct 9, 2026"), date(2026, 10, 9))
        self.assertEqual(date_from_text("9 October 2026"), date(2026, 10, 9))
        self.assertIsNone(date_from_text("soon"))
        self.assertEqual(date_from_java("Fri Oct 09 02:00:00 UTC 2026"), date(2026, 10, 9))
        self.assertEqual(date_from_java("Thu Oct 08 20:00:00 UTC 2026"), date(2026, 10, 9))  # 01:30 IST
        self.assertIsNone(date_from_java("2026-10-09"))

    def test_days_ago_clamps_future(self):
        self.assertEqual(base.days_ago(date(2026, 10, 10), TODAY), 0)
        self.assertEqual(base.days_ago(date(2026, 10, 2), TODAY), 7)


class TextTest(unittest.TestCase):
    def test_html_to_text(self):
        self.assertEqual(html_to_text("<p>Build <b>APIs</b></p><ul><li>Python</li></ul>"), "Build APIs Python")
        self.assertEqual(html_to_text("&lt;p&gt;You&#039;ll code&lt;/p&gt;", unescape=True), "You'll code")
        self.assertEqual(html_to_text("plain\n text"), "plain text")
        self.assertEqual(html_to_text(None), "")

    def test_employment_and_seniority(self):
        cases = {"Full-time Employment": "Full-time", "Full Time Employee": "Full-time", "full time": "Full-time",
                 "FullTime": "Full-time", "Permanent": "Full-time", "Intern": "Internship", "Trainee - Contract":
                 "Internship", "Contractual": "Contract", "Part Time": "Part-time", "Temporary": "Temporary",
                 "": "", None: "", "Something": "", "Internship": "Internship", "Summer Interns": "Internship",
                 "Internal": "", "International Assignment": "", "Internal - Full Time": "Full-time"}
        for value, expected in cases.items():
            self.assertEqual(normalize_employment(value), expected, value)
        self.assertEqual(normalize_seniority("Mid-Senior Level"), "Mid-Senior level")
        self.assertEqual(normalize_seniority("Entry level"), "Entry level")
        self.assertEqual(normalize_seniority("Not Applicable"), "")


class IndiaTest(unittest.TestCase):
    def posting(self, **kwargs):
        return Posting(job_id="1", title="Engineer", job_url="https://x", **kwargs)

    def test_classify(self):
        self.assertTrue(classify_india(self.posting(countries=["IN"])))
        self.assertTrue(classify_india(self.posting(countries=["AE"], locations=["Dubai", "Noida, Uttar Pradesh"])))
        self.assertTrue(classify_india(self.posting(locations=["Bangalore - DD"])))
        self.assertTrue(classify_india(self.posting(countries=["India"])))
        self.assertFalse(classify_india(self.posting(countries=["US"], locations=["Indianapolis, Indiana"])))
        self.assertFalse(classify_india(self.posting(countries=["USA"], locations=["sf"])))
        self.assertIsNone(classify_india(self.posting(locations=["Remote"])))
        self.assertIsNone(classify_india(self.posting()))
        self.assertFalse(classify_india(self.posting(countries=["IN"], india=False)))  # adapter override wins

    def test_location_text(self):
        posting = self.posting(locations=["Dubai", "Noida, Uttar Pradesh", "Mumbai, Maharashtra", "dubai"])
        self.assertEqual(location_text(posting, True), "Noida, Uttar Pradesh; Mumbai, Maharashtra; Dubai")
        # India by country code only: an India segment first, so 02_ingest_silver keeps the job
        self.assertEqual(location_text(self.posting(locations=["Plant 7"], countries=["IN"]), True),
                         "India; Plant 7")
        self.assertEqual(location_text(self.posting(countries=["IN"]), True), "India")
        # placeholder segments without a letter are not places (Air India publishes '.')
        self.assertEqual(location_text(self.posting(locations=[".", "-", "Gurugram"]), None), "Gurugram")
        self.assertEqual(location_text(self.posting(locations=["."]), None), "")
        self.assertEqual(location_text(self.posting(locations=["Pune"], workplace="hybrid"), True), "Pune (Hybrid)")
        self.assertEqual(location_text(self.posting(locations=["India - Remote"], workplace="remote"), True),
                         "India - Remote")
        self.assertEqual(location_text(self.posting(locations=["Remote"]), None), "Remote")

    def test_job_key_matches_the_pipeline(self):
        # sha2('lever|paytm|abc', 256), what 02_ingest_silver computes for ats_type lever, company ' Paytm ', job abc
        self.assertEqual(job_key("Lever", " Paytm ", "abc"), hashlib.sha256(b"lever|paytm|abc").hexdigest())


class RobotsTest(unittest.TestCase):
    def test_keka_longest_match_allows_careers(self):
        rules = RobotsRules("User-agent: *\nDisallow: /\nAllow: /careers\nAllow: /careers/\n")
        self.assertTrue(rules.allowed("/careers/api/jobs/default/active"))
        self.assertFalse(rules.allowed("/api/jobs/default/active"))
        self.assertFalse(rules.allowed("/ats/documents/x"))

    def test_smartrecruiters_only_linkedinbot(self):
        rules = RobotsRules("User-agent: LinkedInBot\nAllow: /v1/companies/\n\nUser-agent: *\nDisallow: /\n")
        self.assertFalse(rules.allowed("/v1/companies/ServiceNow/postings"))
        self.assertTrue(RobotsRules("User-agent: LinkedInBot\nAllow: /\nUser-agent: *\nDisallow: /",
                                    agent="LinkedInBot/1.0").allowed("/v1/companies/x"))

    def test_lever_and_rmk(self):
        lever = RobotsRules("User-agent: *\nAllow: /\nCrawl-delay: 1\n")
        self.assertTrue(lever.allowed("/v0/postings/paytm?mode=json"))
        self.assertEqual(lever.crawl_delay, 1.0)
        rmk = RobotsRules("User-agent: *\nDisallow: /services/\nDisallow: /applybutton/\nDisallow: /*company\n")
        self.assertTrue(rmk.allowed("/search/?q=&startrow=25"))
        self.assertFalse(rmk.allowed("/services/rss/job/"))
        self.assertFalse(rmk.allowed("/career?company=birlasoftl"))
        self.assertTrue(RobotsRules("User-agent: *\nDisallow:\n").allowed("/anything"))
        wildcard_end = RobotsRules("User-agent: *\nDisallow: /*.pdf$\n")
        self.assertFalse(wildcard_end.allowed("/a/b.pdf"))
        self.assertTrue(wildcard_end.allowed("/a/b.pdf?x=1"))


class HttpTest(unittest.TestCase):
    def http(self, session, **kwargs):
        self.sleeps = []
        return Http("lever", session=session, delay=1.0, sleep=self.sleeps.append, clock=lambda: 0.0, **kwargs)

    def test_retries_429_with_retry_after_then_succeeds(self):
        session = (FakeSession()
                   .add("GET", r"/jobs$", status=429, text="slow down", headers={"Retry-After": "7"}, times=1)
                   .add("GET", r"/jobs$", json=[1, 2]))
        self.assertEqual(self.http(session).get_json("https://h.example/jobs"), [1, 2])
        self.assertIn(7.0, self.sleeps)

    def test_404_is_not_retried(self):
        session = FakeSession().add("GET", r"/jobs$", status=404, text="Not Found")
        with self.assertRaises(HttpError) as raised:
            self.http(session).get_json("https://h.example/jobs")
        self.assertEqual(str(raised.exception), "HTTP 404")
        self.assertEqual(len(session.urls("GET")), 2)  # robots.txt + one try

    def test_5xx_exhausts_retries(self):
        session = FakeSession().add("GET", r"/jobs$", status=503, text="busy")
        with self.assertRaises(ScrapeFailed) as raised:
            self.http(session).get_json("https://h.example/jobs")
        self.assertEqual(str(raised.exception), "HTTP 503")
        self.assertEqual(len([u for u in session.urls() if u.endswith("/jobs")]), 3)

    def test_cloudflare_block_page(self):
        session = FakeSession().add("GET", r"/api", status=403,
                                    text="<html><title>Attention Required! | Cloudflare</title>Sorry, you have been blocked")
        with self.assertRaises(HttpError) as raised:
            self.http(session).get_json("https://t.darwinbox.in/api")
        self.assertTrue(raised.exception.blocked)
        self.assertIn("blocked", str(raised.exception))

    def test_robots_disallow_and_override(self):
        def session():
            return (FakeSession()
                    .add("GET", r"robots\.txt$", text="User-agent: LinkedInBot\nAllow: /\nUser-agent: *\nDisallow: /\n",
                         headers={"Content-Type": "text/plain"})
                    .add("GET", r"/v1/companies/", json={"content": []}))
        with self.assertRaises(RobotsDisallowed):
            self.http(session()).get_json("https://api.smartrecruiters.com/v1/companies/X/postings")
        allowed = Http("lever", session=session(), settings=Settings(robots_override=frozenset({"lever"})),
                       sleep=no_sleep)
        self.assertEqual(allowed.get_json("https://api.smartrecruiters.com/v1/companies/X/postings"), {"content": []})

    def test_html_robots_page_allows(self):
        session = (FakeSession().add("GET", r"robots\.txt$", text="<html>login</html>Disallow: /",
                                     headers={"Content-Type": "text/html"})
                   .add("GET", r"/x$", json={}))
        self.assertEqual(self.http(session).get_json("https://h.example/x"), {})

    def test_request_budget(self):
        session = FakeSession().add("GET", r"/p", json=[])
        http = self.http(session, settings=Settings(max_requests_per_company=2), respect_robots=False)
        http.get_json("https://h.example/p1")
        http.get_json("https://h.example/p2")
        with self.assertRaises(ScrapeFailed):
            http.get_json("https://h.example/p3")
        http.reset_budget()
        self.assertEqual(http.get_json("https://h.example/p4"), [])

    def test_delay_between_requests_to_one_host(self):
        now = [100.0]
        sleeps = []
        session = FakeSession().add("GET", r"/p", json=[])
        http = Http("x", session=session, delay=1.5, respect_robots=False, sleep=sleeps.append, clock=lambda: now[0])
        http.get_json("https://h.example/p1")
        now[0] += 0.5
        http.get_json("https://h.example/p2")
        self.assertEqual(sleeps, [1.0])

    def test_honest_user_agent(self):
        session = FakeSession().add("GET", r"/p", json=[])
        self.http(session, respect_robots=False).get_json("https://h.example/p")
        self.assertIn("JobSeekerBot/", session.calls[-1][2]["headers"]["User-Agent"])


class FakeAdapter(AtsAdapter):
    """Board of dict postings at https://fake.example/{board}; detail at /{board}/{id}."""
    name = "fake"
    label = "Fake"
    request_delay = 0

    def identify(self, company):
        board = (company.get("slug") or "").strip()
        if not board:
            raise ScrapeFailed("Missing Fake board URL")
        return {"board": board, "board_url": f"https://fake.example/{board}"}

    def fetch(self, http, target, ctx):
        return http.get_json(f"https://fake.example/{target['board']}")

    def parse(self, raw, target, ctx):
        if raw.get("boom"):
            raise KeyError("boom")
        return Posting(job_id=raw["id"], title=raw["title"], job_url=f"https://fake.example/j/{raw['id']}",
                       locations=raw.get("locations", []), countries=raw.get("countries", []),
                       posted_on=date_from_iso(raw.get("posted")), description=raw.get("description", ""),
                       needs_detail=not raw.get("description"))

    def fetch_detail(self, http, target, posting, ctx):
        detail = http.get_json(f"https://fake.example/{target['board']}/{posting.job_id}")
        posting.description = detail["description"]
        posting.posted_on = posting.posted_on or date_from_iso(detail.get("posted"))
        return posting


BOARD = [
    {"id": "1", "title": "Data Engineer", "countries": ["IN"], "locations": ["Bengaluru"], "posted": "2026-10-08",
     "description": "<p>Spark</p>"},
    {"id": "1", "title": "Data Engineer", "countries": ["IN"], "locations": ["Pune"], "posted": "2026-10-08",
     "description": "<p>Spark</p>"},                                     # same job, second location
    {"id": "2", "title": "Backend Engineer", "countries": ["US"], "locations": ["Austin"], "posted": "2026-10-08"},
    {"id": "3", "title": "SRE", "locations": ["Hyderabad"], "posted": "2026-09-20"},              # too old
    {"id": "4", "title": "ML Engineer", "locations": ["Mumbai"], "posted": "2026-10-02"},          # 7 days: kept
    {"id": "5", "title": "Analyst", "locations": ["Remote"], "posted": "2026-10-09"},              # unknown country
    {"id": "6", "title": "QA", "locations": ["Chennai"]},                                          # date from detail
    {"boom": True},
]


class RunCompanyTest(unittest.TestCase):
    def session(self):
        session = FakeSession().add("GET", r"fake\.example/acme$", json=BOARD)
        for job_id, posted in (("4", None), ("5", None), ("6", "2026-10-05")):
            session.add("GET", rf"fake\.example/acme/{job_id}$",
                        json={"description": f"<div>desc {job_id}</div>", "posted": posted})
        return session

    def test_filters_dedupes_and_fetches_details(self):
        session = self.session()
        result = run_offline(FakeAdapter(), {"name": "Acme", "slug": "acme"}, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.found, 8)
        self.assertEqual(result.parsed, 6)
        rows = {row["job_id"]: row for row in result.rows}
        self.assertEqual(sorted(rows), ["1", "4", "5", "6"])
        self.assertEqual(rows["1"]["location"], "Bengaluru; Pune")
        self.assertEqual(rows["1"]["description"], "Spark")
        self.assertEqual(rows["4"]["posted_days"], 7)
        self.assertEqual(rows["6"]["posted_date"], "05/10/2026")
        self.assertEqual(rows["6"]["description"], "desc 6")
        self.assertEqual(rows["5"]["location"], "Remote")
        self.assertEqual(result.details_fetched, 3)
        self.assertNotIn("https://fake.example/acme/2", session.urls())  # not India: no detail
        self.assertNotIn("https://fake.example/acme/3", session.urls())  # too old: no detail
        self.assertTrue(any("failed to parse" in warning for warning in result.warnings))

    def test_seen_jobs_skip_the_detail_but_keep_the_row(self):
        seen = {job_key("fake", "Acme", "4")}
        result = run_offline(FakeAdapter(), {"name": "Acme", "slug": "acme"}, self.session(), today=TODAY,
                             seen_keys=seen)
        self.assertEqual(result.already_seen, 1)
        self.assertEqual({row["job_id"]: row["description"] for row in result.rows}["4"], "")

    def test_detail_cap_and_failures_do_not_fail_the_company(self):
        session = FakeSession().add("GET", r"fake\.example/acme$", json=BOARD).add("GET", r"fake\.example/acme/",
                                                                                   status=500, text="x")
        result = run_offline(FakeAdapter(), {"name": "Acme", "slug": "acme"}, session, today=TODAY,
                             settings=Settings(max_details_per_company=2))
        self.assertTrue(result.ok)
        self.assertEqual(result.details_failed, 2)
        self.assertEqual(sorted(row["job_id"] for row in result.rows), ["1", "4", "5"])  # 6 has no date
        self.assertTrue(any("cap reached" in warning for warning in result.warnings))

    def test_board_errors_become_the_outcome(self):
        result = run_offline(FakeAdapter(), {"name": "Acme", "slug": ""}, FakeSession())
        self.assertEqual((result.ok, result.error), (False, "Missing Fake board URL"))
        session = FakeSession().add("GET", r"fake\.example/gone$", status=404, text="Not Found")
        result = run_offline(FakeAdapter(), {"name": "Gone", "slug": "gone"}, session)
        self.assertEqual((result.ok, result.error), (False, "HTTP 404"))


class RegistryTest(unittest.TestCase):
    def test_names_are_csv_prefixes(self):
        for name in registry.ALL_SOURCES:
            self.assertRegex(name, r"^[a-z]+$", "a CSV prefix may not contain '_' (02_ingest_silver splits on it)")
        self.assertEqual(len(set(registry.ALL_SOURCES)), len(registry.ALL_SOURCES))
        self.assertEqual(set(registry.LABELS), set(registry.ALL_SOURCES))

    def test_get_and_parse_names(self):
        self.assertEqual(registry.get("lever").name, "lever")
        with self.assertRaises(registry.AdapterNotAvailable):
            registry.get("workday")
        self.assertEqual(registry.parse_names("Lever, ashby,lever"), ["lever", "ashby"])
        with self.assertRaises(ValueError):
            registry.parse_names("lever,greenhouse")

    def test_every_built_adapter_meets_the_interface(self):
        for name in registry.available():
            adapter = registry.get(name)
            with self.subTest(adapter=name):
                self.assertEqual(adapter.name, name)
                self.assertTrue(adapter.label)
                with self.assertRaises(ScrapeFailed):
                    adapter.identify({"name": "X", "ats_type": name, "slug": "", "api_url": ""})
                path = fixture_path(name, "url_cases.json")
                self.assertTrue(path.exists(), f"{path} pins the form's URL rules; add it")
                for case in load_json(name, "url_cases.json")["cases"]:
                    self.assertEqual(adapter.source_columns(case["input"]), case["expect"], case["input"])
                    if case["expect"]:
                        # what the form stores must identify the board again, and editing the stored api_url
                        # (the value the form shows) must give the same columns
                        adapter.identify({"name": "X", "ats_type": name, **case["expect"]})
                        if case["expect"]["api_url"]:
                            self.assertEqual(adapter.source_columns(case["expect"]["api_url"]), case["expect"])


if __name__ == "__main__":
    unittest.main()
