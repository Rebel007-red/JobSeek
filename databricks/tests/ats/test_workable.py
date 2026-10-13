"""Workable adapter against the recorded fixtures."""
import copy
import unittest
from datetime import date

from harness import FakeSession, assert_rows_valid, load_json, run_offline

from ats.workable import WorkableAdapter, parse_board

TODAY = date(2026, 9, 28)  # smartstream Mumbai (2026-09-24) inside 7 days; Pune (08-20) older; Bristol not India
WIDGET = r"^https://apply\.workable\.com/api/v1/widget/accounts/{}\?details=true$"


def widget(sub):
    return copy.deepcopy(load_json("workable", f"{sub}_widget_details.json"))


class WorkableTest(unittest.TestCase):
    def test_parse_board(self):
        self.assertEqual(parse_board("https://apply.workable.com/j/58DF5D1CD5"), (None, "58DF5D1CD5"))
        self.assertEqual(parse_board("https://Leena-AI.workable.com"), ("leena-ai", None))
        self.assertEqual(parse_board("https://jobs.workable.com/view/abc/x"), (None, None))
        self.assertEqual(parse_board("https://apply.workable.com/api/v3/accounts/zifo/jobs"), ("zifo", None))

    def test_rows_from_fixture(self):
        session = FakeSession().add("GET", WIDGET.format("smartstream"), json=widget("smartstream"))
        result = run_offline(WorkableAdapter(), {"name": "Smartstream", "ats_type": "workable",
                                                 "slug": "smartstream"}, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual((result.found, result.parsed, result.india), (3, 3, 2))
        assert_rows_valid(self, result.rows, "workable", today=TODAY)
        self.assertEqual(len(result.rows), 1)
        row = result.rows[0]
        self.assertEqual(row["job_id"], "37AC2F28C4")
        self.assertEqual(row["job_url"], "https://apply.workable.com/smartstream/j/37AC2F28C4/")
        self.assertEqual(row["company_url"], "https://apply.workable.com/smartstream/")
        self.assertEqual(row["location"], "Mumbai, Maharashtra, India")
        self.assertEqual(row["posted_date"], "24/09/2026")  # published_on, not created_at (2026-08-14)
        self.assertEqual(row["posted_days"], 4)
        self.assertEqual(row["employment_type"], "Full-time")
        self.assertEqual(row["seniority_level"], "Entry level")
        self.assertEqual(row["industries"], "Information Technology and Services")
        self.assertEqual(row["job_function"], "Consultancy & BPO")  # function is null: the department
        self.assertTrue(row["description"].startswith("Maintain static data"))

    def test_job_repeated_per_location_is_one_row(self):
        data = widget("smartstream")
        pune, mumbai = copy.deepcopy(data["jobs"][2]), copy.deepcopy(data["jobs"][2])
        pune.update(city="Pune", locations=[{"country": "India", "countryCode": "IN", "city": "Pune",
                                             "region": "Maharashtra", "hidden": False}])
        data["jobs"] = [mumbai, pune]
        result = run_offline(WorkableAdapter(), {"name": "Smartstream", "slug": "smartstream"},
                             FakeSession().add("GET", WIDGET.format("smartstream"), json=data), today=TODAY)
        self.assertEqual((result.found, result.parsed), (2, 1))
        self.assertEqual(result.rows[0]["location"], "Mumbai, Maharashtra, India; Pune, Maharashtra, India")

    def test_remote_and_top_level_location_fallback(self):
        data = widget("exponent-energy")  # 2026-10-06 x2, 2025-11-06
        job = data["jobs"][0]
        job.update(telecommuting=True, locations=[], experience="Mid-Senior level", employment_type="Contract")
        result = run_offline(WorkableAdapter(), {"name": "Exponent Energy", "slug": "exponent-energy"},
                             FakeSession().add("GET", WIDGET.format("exponent-energy"), json=data),
                             today=date(2026, 10, 9))
        self.assertEqual([row["job_id"] for row in result.rows], ["2A8AC1C0F1", "1D1AD08491"])
        row = result.rows[0]
        self.assertEqual(row["location"], "Bengaluru, Karnataka, India (Remote)")
        self.assertEqual((row["seniority_level"], row["employment_type"]), ("Mid-Senior level", "Contract"))
        self.assertEqual(row["job_function"], "Quality Assurance")

    def test_job_link_is_resolved_from_its_redirect(self):
        session = (FakeSession()
                   .add("GET", r"^https://apply\.workable\.com/j/58DF5D1CD5$", status=301,
                        headers={"Location": "https://apply.workable.com/2070health/j/58DF5D1CD5/"})
                   .add("GET", WIDGET.format("2070health"), json=widget("2070health")))
        company = {"name": "2070 Health", "ats_type": "workable", "slug": "",
                   "api_url": "https://apply.workable.com/j/58DF5D1CD5"}
        result = run_offline(WorkableAdapter(), company, session, today=date(2026, 6, 25))
        self.assertTrue(result.ok, result.error)
        self.assertEqual([row["job_id"] for row in result.rows], ["58DF5D1CD5"])
        self.assertEqual(result.rows[0]["company_url"], "https://apply.workable.com/2070health/")
        redirect_call = [kwargs for _m, url, kwargs in session.calls if url.endswith("/j/58DF5D1CD5")][0]
        self.assertFalse(redirect_call["allow_redirects"])

    def test_relative_redirect_and_closed_job_link(self):
        session = (FakeSession()
                   .add("GET", r"/j/AAAA1111$", status=302, headers={"Location": "/acme/j/AAAA1111/"})
                   .add("GET", WIDGET.format("acme"), json={"name": "Acme", "jobs": []}))
        result = run_offline(WorkableAdapter(), {"name": "Acme", "api_url": "https://apply.workable.com/j/AAAA1111"},
                             session)
        self.assertTrue(result.ok, result.error)
        closed = run_offline(WorkableAdapter(), {"name": "Acme", "api_url": "https://apply.workable.com/j/BBBB2222"},
                             FakeSession().add("GET", r"/j/BBBB2222$", status=404, text="gone"))
        self.assertFalse(closed.ok)
        self.assertIn("no longer resolves", closed.error)

    def test_unknown_account_fails_and_empty_account_is_ok(self):
        missing = run_offline(WorkableAdapter(), {"name": "Nope", "slug": "nope"},
                              FakeSession().add("GET", WIDGET.format("nope"), status=404, text="{}"))
        self.assertFalse(missing.ok)
        self.assertEqual(missing.error, "HTTP 404 (no Workable account 'nope')")
        empty = run_offline(WorkableAdapter(), {"name": "Razorpay", "slug": "razorpay"},
                            FakeSession().add("GET", WIDGET.format("razorpay"), json={"name": "Razorpay", "jobs": []}))
        self.assertTrue(empty.ok, empty.error)
        self.assertEqual(empty.found, 0)


if __name__ == "__main__":
    unittest.main()
