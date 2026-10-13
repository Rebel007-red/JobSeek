"""Darwinbox adapter against the recorded fixtures (no network)."""
import copy
import json
import unittest
from datetime import date

from harness import FakeResponse, FakeSession, assert_rows_valid, load_json, run_offline

from ats.darwinbox import DarwinboxAdapter, clean_location
from scraper_common import ScrapeFailed

TODAY = date(2026, 10, 9)
ALLJOBS = r"/ms/candidateapi/job/alljobs\?companyId="
FREIGHT_TIGER = {"name": "Freight Tiger", "ats_type": "darwinbox", "slug": "main",
                 "api_url": "https://freighttiger.darwinbox.in/ms/candidateapi/"}


def alljobs(name, job_counts=None):
    payload = copy.deepcopy(load_json("darwinbox", f"{name}_alljobs.json"))
    payload.pop("_request", None)
    if job_counts is not None:
        payload["job_counts"] = job_counts
    return payload


def synthetic(count, start, posted_on):
    return [{"id": f"j{start + i}", "title": f"Engineer {start + i}", "posted_on": posted_on, "country": "India",
             "officelocations_without_area": ["Bengaluru, Karnataka\r, India"], "jd": "&lt;p&gt;Build&lt;/p&gt;",
             "emp_type_name": "Full Time"} for i in range(count)]


class DarwinboxTest(unittest.TestCase):
    def test_rows_from_fixture(self):
        session = FakeSession().add("POST", r"^https://freighttiger\.darwinbox\.in" + ALLJOBS + "main$",
                                    json=alljobs("freighttiger"))
        result = run_offline(DarwinboxAdapter(), FREIGHT_TIGER, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual((result.found, result.parsed, result.india), (3, 3, 3))
        # posted 2026-10-08 and 10-06 (IST) are kept; 09-30 is older than 7 days
        self.assertEqual([row["posted_date"] for row in result.rows], ["08/10/2026", "06/10/2026"])
        assert_rows_valid(self, result.rows, "darwinbox", today=TODAY)
        row = result.rows[0]
        self.assertEqual(row["job_url"], "https://freighttiger.darwinbox.in/ms/candidatev2/main/careers/jobDetails/"
                                         "a6ac71ce13c900")
        self.assertEqual(row["company_url"], "https://freighttiger.darwinbox.in/ms/candidatev2/main/careers/allJobs")
        self.assertEqual(row["location"], "Gurugram, Haryana, India")
        self.assertEqual(row["employment_type"], "Full-time")
        method, url, kwargs = session.calls[-1]
        self.assertEqual(kwargs["json"], {"page": 1, "limit": 100})
        self.assertEqual(kwargs["headers"]["sec-fetch-mode"], "cors")  # Cloudflare lets these through
        self.assertTrue(kwargs["headers"]["User-Agent"].startswith("JobSeekerBot/"))

    def test_non_india_job_dropped_and_description_unescaped(self):
        session = FakeSession().add("POST", ALLJOBS, json=alljobs("porter"))
        result = run_offline(DarwinboxAdapter(), {"name": "Porter", "api_url": "https://porter.darwinbox.in/ms/"
                                                                                "candidatev2/main/careers/allJobs"},
                             session, today=date(2026, 10, 2))
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.india, 2)  # the Dubai job is not India
        self.assertEqual([row["job_id"] for row in result.rows], ["a6ab640c8cee75"])
        row = result.rows[0]
        self.assertEqual(row["employment_type"], "Full-time")  # 'Permanent'
        self.assertEqual(row["location"], "Surat, Gujarat, India")
        self.assertNotIn("&lt;", row["description"])
        self.assertNotIn("<p", row["description"])
        self.assertTrue(row["description"])

    def test_pagination_and_early_stop(self):
        def responder(_method, _url, kwargs):
            page = kwargs["json"]["page"]
            return FakeResponse(json_body={"status": "success", "job_counts": 150,
                                           "data": synthetic(100 if page == 1 else 50, (page - 1) * 100, 1791397800)})

        session = FakeSession().add("POST", ALLJOBS, responder=responder)
        result = run_offline(DarwinboxAdapter(), FREIGHT_TIGER, session, today=TODAY)
        self.assertEqual((result.found, len(result.rows)), (150, 150))
        self.assertEqual([call[2]["json"]["page"] for call in session.calls if call[0] == "POST"], [1, 2])
        self.assertEqual(result.rows[0]["description"], "Build")

        old = FakeSession().add("POST", ALLJOBS, json={"status": "success", "job_counts": 300,
                                                       "data": synthetic(100, 0, 1787855400)})  # 2026-08-28
        result = run_offline(DarwinboxAdapter(), FREIGHT_TIGER, old, today=TODAY)
        self.assertEqual((result.found, len(result.rows)), (100, 0))
        self.assertEqual(len([call for call in old.calls if call[0] == "POST"]), 1)

    def test_pages_follow_job_counts_when_the_site_pages_by_fewer(self):
        def responder(_method, _url, kwargs):
            page = kwargs["json"]["page"]  # a tenant that ignores 'limit' and pages by 10
            return FakeResponse(json_body={"status": "success", "job_counts": 25,
                                           "data": synthetic(10 if page < 3 else 5, (page - 1) * 10, 1791397800)})

        session = FakeSession().add("POST", ALLJOBS, responder=responder)
        result = run_offline(DarwinboxAdapter(), FREIGHT_TIGER, session, today=TODAY)
        self.assertEqual((result.found, len(result.rows)), (25, 25))

        repeat = FakeSession().add("POST", ALLJOBS, json={"status": "success", "job_counts": 500,
                                                          "data": synthetic(100, 0, 1791397800)})
        result = run_offline(DarwinboxAdapter(), FREIGHT_TIGER, repeat, today=TODAY)
        self.assertEqual(result.found, 100)
        self.assertEqual(len([call for call in repeat.calls if call[0] == "POST"]), 2)  # page 2 repeated page 1

    def test_group_company_id(self):
        session = FakeSession().add("POST", ALLJOBS + "a664361beb2876$", json=alljobs("zepto"))
        company = {"name": "Acme", "slug": "a664361beb2876",
                   "api_url": "https://acme.darwinbox.in/ms/candidateapi/?companyId=a664361beb2876"}
        result = run_offline(DarwinboxAdapter(), company, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.rows[0]["job_url"],
                         "https://acme.darwinbox.in/ms/candidatev2/a664361beb2876/careers/jobDetails/a6abcb9fe0cca8")
        # a bare group id in slug beside an api_url without one
        target = DarwinboxAdapter().identify({"slug": "a664361beb2876",
                                              "api_url": "https://acme.darwinbox.in/ms/candidateapi/"})
        self.assertEqual(target, {"host": "acme.darwinbox.in", "company_id": "a664361beb2876"})

    def test_unknown_tenant_fails_without_retries(self):
        body = json.dumps({"message": "Internal Server Error - Invalid subdomain: swiggy"})
        session = FakeSession().add("POST", ALLJOBS, status=500, text=body)
        result = run_offline(DarwinboxAdapter(), {"name": "Swiggy", "api_url": "https://swiggy.darwinbox.in/ms/"
                                                                                "candidateapi/"}, session)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "no Darwinbox careers site 'swiggy'")
        self.assertEqual(len([call for call in session.calls if call[0] == "POST"]), 1)

    def test_transient_500_is_retried(self):
        session = (FakeSession().add("POST", ALLJOBS, status=500, text="upstream error", times=1)
                   .add("POST", ALLJOBS, json=alljobs("freighttiger")))
        result = run_offline(DarwinboxAdapter(), FREIGHT_TIGER, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(len(result.rows), 2)

    def test_cloudflare_block(self):
        session = FakeSession().add("POST", ALLJOBS, status=403,
                                    text="<html><title>Attention Required! | Cloudflare</title>Sorry, you have been "
                                         "blocked</html>")
        result = run_offline(DarwinboxAdapter(), FREIGHT_TIGER, session)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "HTTP 403 blocked by the site's bot protection")

    def test_identify_and_location_cleanup(self):
        adapter = DarwinboxAdapter()
        with self.assertRaisesRegex(ScrapeFailed, "^Missing Darwinbox board URL$"):
            adapter.identify({"slug": "", "api_url": ""})
        with self.assertRaisesRegex(ScrapeFailed, "^Unable to derive Darwinbox board$"):
            adapter.identify({"slug": "main", "api_url": ""})
        self.assertEqual(clean_location("Gurugram, Haryana\r, India"), "Gurugram, Haryana, India")


if __name__ == "__main__":
    unittest.main()
