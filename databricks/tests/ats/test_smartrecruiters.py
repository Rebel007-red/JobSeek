"""SmartRecruiters adapter against the recorded fixtures (list + detail)."""
import copy
import unittest
from datetime import date
from urllib.parse import parse_qs, urlparse

from harness import FakeResponse, FakeSession, assert_rows_valid, load_json, run_offline

from ats.base import Settings, job_key
from ats.smartrecruiters import SmartRecruitersAdapter, parse_board, released_after

TODAY = date(2026, 10, 9)
OVERRIDE = Settings(robots_override=frozenset({"smartrecruiters"}))
ROBOTS = "User-agent: LinkedInBot\nAllow: /v1/companies/\n\nUser-agent: *\nDisallow: /\n"
LIST = r"^https://api\.smartrecruiters\.com/v1/companies/{}/postings\?"
DETAIL = r"^https://api\.smartrecruiters\.com/v1/companies/{}/postings/\d+$"


def listing(company):
    return copy.deepcopy(load_json("smartrecruiters", f"{company}_list_india_7d.json"))


def detail(company):
    return copy.deepcopy(load_json("smartrecruiters", f"{company}_detail.json"))


def detail_responder(company):
    body = detail(company)

    def respond(_method, url, _kwargs):
        return FakeResponse(200, {**body, "id": url.rsplit("/", 1)[1]}, url=url)
    return respond


class SmartRecruitersTest(unittest.TestCase):
    def test_parse_board(self):
        self.assertEqual(parse_board("https://careers.smartrecruiters.com/BoschGroup/india"), "BoschGroup")
        self.assertEqual(parse_board("https://api.smartrecruiters.com/v1/companies/LinkedIn3/postings"), "LinkedIn3")
        self.assertIsNone(parse_board("https://careers.servicenow.com/jobs/1"))
        self.assertIsNone(parse_board("Bosch Group"))

    def test_released_after_is_midnight_ist_of_the_cutoff(self):
        self.assertEqual(released_after(date(2026, 10, 2)), "2026-10-01T18:30:00.000Z")

    def test_robots_disallow_fails_the_company_by_default(self):
        session = FakeSession().add("GET", r"api\.smartrecruiters\.com/robots\.txt$", text=ROBOTS,
                                    headers={"Content-Type": "text/plain"})
        result = run_offline(SmartRecruitersAdapter(), {"name": "ServiceNow", "slug": "ServiceNow"}, session)
        self.assertFalse(result.ok)
        self.assertIn("robots.txt of api.smartrecruiters.com disallows", result.error)
        self.assertEqual(session.urls(), ["https://api.smartrecruiters.com/robots.txt"])

    def test_rows_with_details(self):
        session = (FakeSession()
                   .add("GET", r"api\.smartrecruiters\.com/robots\.txt$", text=ROBOTS,
                        headers={"Content-Type": "text/plain"})
                   .add("GET", LIST.format("servicenow"), json=listing("ServiceNow"))
                   .add("GET", DETAIL.format("ServiceNow"), responder=detail_responder("ServiceNow")))
        company = {"name": "ServiceNow", "ats_type": "smartrecruiters", "slug": "servicenow",
                   "api_url": "https://api.smartrecruiters.com/v1/companies/servicenow/postings"}
        result = run_offline(SmartRecruitersAdapter(), company, session, settings=OVERRIDE, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual((result.found, result.parsed, result.india, result.details_fetched), (3, 3, 3, 3))
        assert_rows_valid(self, result.rows, "smartrecruiters", today=TODAY)
        query = parse_qs(urlparse([url for url in session.urls() if "offset=" in url][0]).query)
        self.assertEqual(query, {"limit": ["100"], "offset": ["0"], "country": ["in"],
                                 "releasedAfter": ["2026-10-01T18:30:00.000Z"]})
        row = result.rows[0]
        self.assertEqual(row["job_id"], "744000154629109")
        self.assertEqual(row["location"], "Hyderabad, Telangana, India (Hybrid)")
        self.assertEqual(result.rows[1]["location"], "Hyderabad, India")  # 'Hyderabad, , India' cleaned
        self.assertEqual(row["job_url"], "https://jobs.smartrecruiters.com/ServiceNow/"
                                         "744000154629109-staff-voice-ai-engineer-core-platform")
        self.assertEqual(row["company_url"], "https://careers.smartrecruiters.com/ServiceNow")  # canonical casing
        self.assertEqual(row["posted_date"], "09/10/2026")
        self.assertEqual((row["employment_type"], row["seniority_level"]), ("Full-time", ""))  # 'Not Applicable'
        self.assertEqual((row["job_function"], row["industries"]),
                         ("Engineering", "Information Technology And Services"))
        self.assertTrue(row["description"].startswith("Job Description As a Staff Voice AI Engineer"))
        self.assertIn("Qualifications", row["description"])
        self.assertNotIn("Fred Luddy", row["description"])  # the company blurb is left out

    def test_pagination_and_seniority(self):
        page = listing("BoschGroup")
        template = page["content"][0]
        first = [{**copy.deepcopy(template), "id": str(900000000000000 + i)} for i in range(100)]
        second = [{**copy.deepcopy(template), "id": str(900000000000100 + i)} for i in range(3)]
        session = (FakeSession()
                   .add("GET", LIST.format("BoschGroup") + r".*offset=0", json={**page, "totalFound": 103,
                                                                                "content": first})
                   .add("GET", LIST.format("BoschGroup") + r".*offset=100", json={**page, "totalFound": 103,
                                                                                  "content": second})
                   .add("GET", DETAIL.format("BoschGroup"), responder=detail_responder("BoschGroup")))
        result = run_offline(SmartRecruitersAdapter(), {"name": "Bosch", "slug": "BoschGroup"}, session,
                             settings=OVERRIDE, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual((result.found, len(result.rows), result.details_fetched), (103, 103, 103))
        self.assertEqual(len([url for url in session.urls() if "offset=" in url]), 2)
        self.assertEqual(result.rows[0]["seniority_level"], "Mid-Senior level")
        self.assertEqual(result.rows[0]["location"], "bangalore, India")

    def test_paging_stops_at_a_too_old_page(self):
        page = listing("Freshworks")
        template = page["content"][0]
        items = [{**copy.deepcopy(template), "id": str(800000000000000 + i)} for i in range(100)]
        items[-1]["releasedDate"] = "2026-09-20T10:00:00.000Z"  # older than the 7-day window
        session = (FakeSession()
                   .add("GET", LIST.format("Freshworks") + r".*offset=0", json={**page, "totalFound": 250,
                                                                                "content": items})
                   .add("GET", DETAIL.format("Freshworks"), responder=detail_responder("Freshworks")))
        result = run_offline(SmartRecruitersAdapter(), {"name": "Freshworks", "slug": "Freshworks"}, session,
                             settings=OVERRIDE, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(len([url for url in session.urls() if "offset=" in url]), 1)
        self.assertEqual(len(result.rows), 99)

    def test_seen_jobs_skip_the_detail(self):
        data = listing("Freshworks")
        seen = {job_key("smartrecruiters", "Freshworks", item["id"]) for item in data["content"][:2]}
        session = (FakeSession()
                   .add("GET", LIST.format("Freshworks"), json=data)
                   .add("GET", DETAIL.format("Freshworks"), responder=detail_responder("Freshworks")))
        result = run_offline(SmartRecruitersAdapter(), {"name": "Freshworks", "slug": "Freshworks"}, session,
                             settings=OVERRIDE, today=TODAY, seen_keys=seen)
        self.assertEqual((result.already_seen, result.details_fetched, len(result.rows)), (2, 1, 3))
        self.assertEqual(len([url for url in session.urls() if "/postings/" in url]), 1)

    def test_failed_detail_keeps_the_row_without_description(self):
        session = (FakeSession()
                   .add("GET", LIST.format("Freshworks"), json=listing("Freshworks"))
                   .add("GET", DETAIL.format("Freshworks"), status=404, json={"code": "RESOURCE_NOT_FOUND"}))
        result = run_offline(SmartRecruitersAdapter(), {"name": "Freshworks", "slug": "Freshworks"}, session,
                             settings=OVERRIDE, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual((len(result.rows), result.details_failed, result.missing_descriptions), (3, 3, 3))
        self.assertTrue(result.rows[0]["job_url"].startswith("https://jobs.smartrecruiters.com/Freshworks/"))

    def test_unknown_company_and_empty_board(self):
        empty = {"offset": 0, "limit": 100, "totalFound": 0, "content": []}
        session = (FakeSession()
                   .add("GET", LIST.format("zzqqNoSuch1"), json=empty)
                   .add("GET", r"^https://careers\.smartrecruiters\.com/zzqqNoSuch1$", status=301,
                        headers={"Location": "https://jobs.smartrecruiters.com/"}))
        unknown = run_offline(SmartRecruitersAdapter(), {"name": "X", "slug": "zzqqNoSuch1"}, session,
                              settings=OVERRIDE)
        self.assertFalse(unknown.ok)
        self.assertEqual(unknown.error, "unknown SmartRecruiters company 'zzqqNoSuch1'")
        session = (FakeSession()
                   .add("GET", LIST.format("Visa"), json=empty)
                   .add("GET", r"^https://careers\.smartrecruiters\.com/Visa$", text="<html>Visa careers</html>"))
        real = run_offline(SmartRecruitersAdapter(), {"name": "Visa", "slug": "Visa"}, session, settings=OVERRIDE)
        self.assertTrue(real.ok, real.error)
        self.assertEqual(real.found, 0)


if __name__ == "__main__":
    unittest.main()
