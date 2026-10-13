"""Ashby adapter against the recorded fixtures."""
import copy
import unittest
from datetime import date

from harness import FakeSession, assert_rows_valid, load_json, run_offline

from ats.ashby import AshbyAdapter, parse_board

TODAY = date(2026, 10, 9)
RECENT = "2026-10-08T05:00:00.000+00:00"  # 08/10/2026 IST


def jobs():
    return [copy.deepcopy(load_json("ashby", f"{board}_one_job_trimmed.json")["jobs"][0])
            for board in ("sarvam", "atlan", "composio", "notion")]


def board(*items):
    return {"apiVersion": "1", "jobs": list(items)}


class AshbyTest(unittest.TestCase):
    def test_parse_board(self):
        self.assertEqual(parse_board("https://jobs.ashbyhq.com/Acme%20Labs/123"), "Acme Labs")
        self.assertEqual(parse_board("https://api.ashbyhq.com/posting-api/job-board/notion"), "notion")
        self.assertIsNone(parse_board("https://jobs.ashbyhq.com/api/non-user-graphql"))
        self.assertIsNone(parse_board("https://notion.com/careers"))

    def test_rows_india_filter_and_fields(self):
        sarvam, atlan, composio, notion = jobs()
        for job in (sarvam, atlan, composio, notion):
            job["publishedAt"] = RECENT
        session = FakeSession().add("GET", r"^https://api\.ashbyhq\.com/posting-api/job-board/sarvam$",
                                    json=board(sarvam, atlan, composio, notion))
        result = run_offline(AshbyAdapter(), {"name": "Sarvam AI", "ats_type": "ashby", "slug": "sarvam"}, session,
                             today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual((result.found, result.parsed, result.india), (4, 4, 2))
        assert_rows_valid(self, result.rows, "ashby", today=TODAY)
        rows = {row["job_id"]: row for row in result.rows}
        self.assertEqual(set(rows), {sarvam["id"], atlan["id"]})  # composio (sf, USA) and notion (US) dropped
        row = rows[sarvam["id"]]
        self.assertEqual(row["location"], "Delhi, India (Onsite)")
        self.assertEqual(row["employment_type"], "Full-time")
        self.assertEqual(row["job_function"], "Business Development")
        self.assertEqual(row["posted_date"], "08/10/2026")
        self.assertEqual(row["company_url"], "https://jobs.ashbyhq.com/sarvam")
        self.assertEqual(row["job_url"], sarvam["jobUrl"])
        self.assertTrue(row["description"].startswith("About Sarvam"))
        self.assertEqual(rows[atlan["id"]]["location"], "India (Remote)")
        self.assertEqual(rows[atlan["id"]]["job_function"], "IT & Security")
        # never the robots-disallowed jobs.ashbyhq.com/api
        self.assertFalse([url for url in session.urls() if "jobs.ashbyhq.com" in url])

    def test_old_and_unlisted_jobs_are_dropped(self):
        sarvam, atlan, *_ = jobs()  # sarvam published 2026-04-17
        atlan["publishedAt"] = RECENT
        atlan["isListed"] = False
        session = FakeSession().add("GET", r"job-board/sarvam", json=board(sarvam, atlan))
        result = run_offline(AshbyAdapter(), {"name": "Sarvam AI", "slug": "sarvam"}, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual((result.found, result.parsed, len(result.rows)), (2, 1, 0))

    def test_secondary_india_location_makes_it_india(self):
        notion = jobs()[3]
        notion["publishedAt"] = RECENT
        notion["secondaryLocations"].append({"location": "Bengaluru", "address": {"postalAddress": {
            "addressLocality": "Bengaluru", "addressRegion": "Karnataka", "addressCountry": "India"}}})
        session = FakeSession().add("GET", r"job-board/notion", json=board(notion))
        result = run_offline(AshbyAdapter(), {"name": "Notion", "api_url": "https://jobs.ashbyhq.com/notion"}, session,
                             today=TODAY)
        self.assertEqual(len(result.rows), 1)
        self.assertTrue(result.rows[0]["location"].startswith("Bengaluru, India; San Francisco, California"))
        self.assertTrue(result.rows[0]["location"].endswith("(Hybrid)"))

    def test_location_from_address_and_remote_flag(self):
        job = jobs()[0]
        job.update(publishedAt=RECENT, location="", workplaceType=None, isRemote=True, employmentType="Intern")
        job["address"] = {"postalAddress": {"addressLocality": "Pune", "addressRegion": "Maharashtra",
                                            "addressCountry": "India"}}
        result = run_offline(AshbyAdapter(), {"name": "Sarvam AI", "slug": "sarvam"},
                             FakeSession().add("GET", r"job-board/sarvam", json=board(job)), today=TODAY)
        self.assertEqual(result.rows[0]["location"], "Pune, Maharashtra, India (Remote)")
        self.assertEqual(result.rows[0]["employment_type"], "Internship")

    def test_board_name_with_space_is_encoded(self):
        session = FakeSession().add("GET", r"^https://api\.ashbyhq\.com/posting-api/job-board/Acme%20Labs$",
                                    json=board())
        result = run_offline(AshbyAdapter(), {"name": "Acme", "slug": "Acme Labs"}, session)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.found, 0)

    def test_unknown_board_fails_the_company(self):
        session = FakeSession().add("GET", r"job-board/", status=404, text="Not Found")
        result = run_offline(AshbyAdapter(), {"name": "Nope", "slug": "nope"}, session)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "HTTP 404 (no Ashby board 'nope')")

    def test_unexpected_response_fails_the_company(self):
        session = FakeSession().add("GET", r"job-board/", json=[1, 2])
        result = run_offline(AshbyAdapter(), {"name": "Odd", "slug": "odd"}, session)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "unexpected Ashby response")

    def test_one_bad_job_does_not_fail_the_company(self):
        good = jobs()[0]
        good["publishedAt"] = RECENT
        bad = {"id": "x", "title": "Broken", "jobUrl": "https://jobs.ashbyhq.com/sarvam/x",
               "secondaryLocations": "not-a-list-of-dicts", "publishedAt": RECENT}
        result = run_offline(AshbyAdapter(), {"name": "Sarvam AI", "slug": "sarvam"},
                             FakeSession().add("GET", r"job-board/sarvam", json=board(bad, good, 42)), today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertIn(good["id"], [row["job_id"] for row in result.rows])


if __name__ == "__main__":
    unittest.main()
