"""Keka Hire adapter against the recorded fixtures (no network)."""
import unittest
from datetime import date

from harness import FakeSession, assert_rows_valid, load_json, load_text, run_offline

from ats.keka import KekaAdapter, parse_board
from scraper_common import ScrapeFailed

TODAY = date(2026, 10, 9)
KEKA_ROBOTS = "User-agent: *\nDisallow: /\nAllow: /careers\nAllow: /careers/\n"


def jobs(tenant):
    return load_json("keka", f"{tenant}_jobs_active.json")["jobs"]  # the API answers the bare array


class KekaTest(unittest.TestCase):
    def test_rows_from_fixture(self):
        session = (FakeSession()
                   .add("GET", r"^https://hr\.keka\.com/robots\.txt$", text=KEKA_ROBOTS,
                        headers={"Content-Type": "text/plain"})
                   .add("GET", r"^https://hr\.keka\.com/careers/api/jobs/default/active$", json=jobs("hr")))
        company = {"name": "Keka Technologies", "ats_type": "keka", "slug": "hr",
                   "api_url": "https://hr.keka.com/careers/api/jobs/default/active"}
        result = run_offline(KekaAdapter(), company, session, today=TODAY)
        self.assertTrue(result.ok, result.error)  # robots: the longest rule (Allow: /careers) wins over Disallow: /
        self.assertEqual((result.found, result.parsed, result.india, len(result.rows)), (3, 3, 3, 3))
        assert_rows_valid(self, result.rows, "keka", today=TODAY)
        row = result.rows[0]
        self.assertEqual(row["job_id"], "143478")
        self.assertEqual(row["location"], "Delhi, India; Mumbai, India")
        self.assertEqual(row["posted_date"], "05/10/2026")
        self.assertEqual(row["job_url"], "https://hr.keka.com/careers/jobdetails/143478")
        self.assertEqual(row["company_url"], "https://hr.keka.com/careers/")
        self.assertEqual((row["employment_type"], row["job_function"]), ("Full-time", "Sales"))
        self.assertTrue(row["description"].startswith("Role Overview"))
        _method, _url, kwargs = session.calls[-1]
        self.assertFalse(kwargs["allow_redirects"])  # a 302 is how Keka says 'no tenant'

    def test_intern_title_and_old_job(self):
        session = FakeSession().add("GET", r"cloudthat\.keka\.com/careers/api/jobs/default/active", json=jobs("cloudthat"))
        result = run_offline(KekaAdapter(), {"name": "CloudThat", "slug": "cloudthat"}, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual([row["job_id"] for row in result.rows], ["143905", "143731"])  # 142588 is from 09-23
        self.assertEqual(result.rows[0]["employment_type"], "Internship")
        self.assertEqual(result.rows[0]["location"], "Bangalore - Head Office, India")

    def test_missing_description_is_read_from_the_job_page(self):
        session = (FakeSession()
                   .add("GET", r"adda247\.keka\.com/careers/api/jobs/default/active$", json=jobs("adda247"))
                   .add("GET", r"^https://adda247\.keka\.com/careers/jobdetails/143333$",
                        text=load_text("keka", "hr_jobdetails_143478_snippet.html")))
        result = run_offline(KekaAdapter(), {"name": "Adda247", "api_url": "https://adda247.keka.com/careers/"},
                             session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.details_fetched, 1)
        row = next(row for row in result.rows if row["job_id"] == "143333")
        self.assertTrue(row["description"])
        self.assertNotIn("<", row["description"])
        self.assertEqual(row["location"], "Gurugram, India")  # name, not the wrong city 'Haryana'

    def test_named_portal(self):
        session = FakeSession().add("GET", r"^https://acme\.keka\.com/careers/api/jobs/campus/active$",
                                    json=jobs("hr")[:1])
        result = run_offline(KekaAdapter(), {"name": "Acme", "api_url": "https://acme.keka.com/careers/campus/"},
                             session, today=TODAY)
        self.assertEqual(result.rows[0]["job_url"], "https://acme.keka.com/careers/campus/jobdetails/143478")
        self.assertEqual(result.rows[0]["company_url"], "https://acme.keka.com/careers/campus/")

    def test_unknown_tenant_and_disabled_portal(self):
        cases = {"/careers/Content/TenantNotFound.html": "no Keka tenant 'freshworks'",
                 "/careers/Content/403.html": "Keka careers portal disabled"}
        for location, error in cases.items():
            session = FakeSession().add("GET", r"/careers/api/jobs/", status=302, text="",
                                        headers={"Location": location})
            result = run_offline(KekaAdapter(), {"name": "X", "slug": "freshworks"}, session)
            self.assertFalse(result.ok)
            self.assertEqual(result.error, error)

    def test_html_answer_is_not_a_portal(self):
        session = FakeSession().add("GET", r"/api/jobs/default/active", text="<html>Welcome</html>")
        result = run_offline(KekaAdapter(), {"name": "X", "api_url": "https://careers.acme.com/"}, session)
        self.assertFalse(result.ok)
        self.assertIn("not a Keka careers portal", result.error)
        self.assertEqual(session.urls()[-1], "https://careers.acme.com/api/jobs/default/active")

    def test_job_without_location_is_unknown_and_kept(self):
        job = dict(jobs("hr")[1], jobLocations=[])
        session = FakeSession().add("GET", r"/careers/api/jobs/default/active", json=[job])
        result = run_offline(KekaAdapter(), {"name": "Keka", "slug": "hr"}, session, today=TODAY)
        self.assertEqual(result.india, 1)
        self.assertEqual(result.rows[0]["location"], "")

    def test_job_without_location_at_an_india_only_company_is_india(self):
        unlocated = dict(jobs("adda247")[1], id=999, jobLocations=[])
        session = FakeSession().add("GET", r"/careers/api/jobs/default/active", json=[jobs("adda247")[0], unlocated])
        result = run_offline(KekaAdapter(), {"name": "Adda247", "slug": "adda247"}, session, today=TODAY)
        row = next(row for row in result.rows if row["job_id"] == "999")
        self.assertEqual(row["location"], "India")

    def test_parse_board_and_identify(self):
        self.assertEqual(parse_board("https://hr.keka.com/careers/jobdetails/143478"),
                         {"host": "hr.keka.com", "tenant": "hr", "portal": "default", "custom": False})
        adapter = KekaAdapter()
        with self.assertRaisesRegex(ScrapeFailed, "^Missing Keka board URL$"):
            adapter.identify({"slug": " ", "api_url": None})
        with self.assertRaisesRegex(ScrapeFailed, "^Unable to derive Keka board$"):
            adapter.identify({"slug": "https://hr.keka.com/login"})


if __name__ == "__main__":
    unittest.main()
