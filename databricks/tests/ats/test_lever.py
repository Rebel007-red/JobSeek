"""Lever adapter against the recorded fixtures (the template for every adapter's test file)."""
import unittest
from datetime import date

from harness import FakeSession, assert_rows_valid, load_json, run_offline

from ats.lever import LeverAdapter, parse_board

TODAY = date(2026, 10, 2)  # 2026-09-28 (cred) and 2026-10-02 within 7 days; paytm (07-03), zeta (09-03) older


def board():
    return [load_json("lever", f"{site}_one_posting_trimmed.json") for site in ("paytm", "meesho", "zeta", "cred")]


class LeverTest(unittest.TestCase):
    def test_board_urls(self):
        cases = {
            "https://jobs.lever.co/paytm": ("paytm", False),
            "https://jobs.lever.co/paytm/9eed4fec-73f7-4114-a5d3-b2f689c92e8c/apply": ("paytm", False),
            "https://jobs.eu.lever.co/mistral?team=x": ("mistral", True),
            "https://api.lever.co/v0/postings/Paytm?mode=json": ("Paytm", False),
            "https://api.eu.lever.co/v0/postings/qonto": ("qonto", True),
            "jobs.lever.co/cred": ("cred", False),
            "cred": ("cred", None),
            "https://example.com/careers": (None, None),
        }
        for value, expected in cases.items():
            self.assertEqual(parse_board(value), expected, value)

    def test_rows_from_fixtures(self):
        posting = board()
        posting[3] = {**posting[3], "createdAt": 1790899200000}  # cred -> 2026-10-02 IST
        session = FakeSession().add("GET", r"^https://api\.lever\.co/v0/postings/cred\?mode=json$", json=posting)
        result = run_offline(LeverAdapter(), {"name": "CRED", "ats_type": "lever", "slug": "cred"}, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual((result.found, result.parsed, result.india), (4, 4, 4))
        self.assertEqual([row["job_id"] for row in result.rows], ["aa98a938-af3a-45f5-851d-966b2b5bad33"])
        row = result.rows[0]
        assert_rows_valid(self, result.rows, "lever", today=TODAY)
        self.assertEqual(row["company_url"], "https://jobs.lever.co/cred")
        self.assertEqual(row["employment_type"], "Full-time")
        self.assertEqual(row["location"], "hyderabad (Onsite)")
        self.assertEqual(row["posted_date"], "02/10/2026")

    def test_paytm_dubai_primary_with_india_secondary_is_india(self):
        result = run_offline(LeverAdapter(), {"name": "Paytm", "slug": "paytm"},
                             FakeSession().add("GET", r"postings/paytm", json=[board()[0]]), today=date(2026, 7, 5))
        self.assertEqual(len(result.rows), 1)
        self.assertTrue(result.rows[0]["location"].startswith("Noida, Uttar Pradesh; Mumbai, Maharashtra; Dubai"))

    def test_eu_fallback_and_case_retry(self):
        session = (FakeSession()
                   .add("GET", r"^https://api\.lever\.co/", status=404, text='{"ok":false}')
                   .add("GET", r"^https://api\.eu\.lever\.co/v0/postings/Qonto", status=404, text='{"ok":false}')
                   .add("GET", r"^https://api\.eu\.lever\.co/v0/postings/qonto", json=[]))
        adapter = LeverAdapter()
        result = run_offline(adapter, {"name": "Qonto", "slug": "Qonto"}, session)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.found, 0)

    def test_unknown_board_fails_the_company(self):
        session = FakeSession().add("GET", r"lever\.co/v0/postings/", status=404, text='{"ok":false}')
        result = run_offline(LeverAdapter(), {"name": "Nope", "api_url": "https://jobs.lever.co/nope"}, session)
        self.assertFalse(result.ok)
        self.assertIn("HTTP 404", result.error)


if __name__ == "__main__":
    unittest.main()
