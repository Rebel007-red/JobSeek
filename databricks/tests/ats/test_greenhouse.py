"""Greenhouse scraper (databricks/greenhouse.py): the posted date, the 7-day window and the board metadata (no network)."""
import asyncio
import contextlib
import io
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from harness import DATABRICKS  # also puts databricks/ on sys.path

import greenhouse
import scraper_common
from scraper_common import ScrapeReport

TODAY = date(2026, 10, 9)


def job(job_id, first_published, updated_at="2026-10-09T10:00:00-04:00", **extra):
    return {"id": job_id, "title": f"Engineer {job_id}", "first_published": first_published, "updated_at": updated_at,
            "location": {"name": "Bengaluru, India"}, "content": "&lt;p&gt;Build things&lt;/p&gt;",
            "absolute_url": f"https://job-boards.greenhouse.io/acme/jobs/{job_id}", **extra}


def quiet(function, *args):
    with contextlib.redirect_stdout(io.StringIO()):
        return function(*args)


class GreenhouseDatesTest(unittest.TestCase):
    def test_the_scraper_under_test(self):
        self.assertEqual(Path(greenhouse.__file__).resolve().parent, DATABRICKS)  # databricks/greenhouse.py

    def test_dates_are_ist_whatever_the_runner_tz(self):
        self.assertEqual(greenhouse.parse_iso_date("2026-10-08T20:00:00-04:00"), date(2026, 10, 9))  # 05:30 IST
        self.assertEqual(greenhouse.parse_iso_date("2026-10-08T18:00:00Z"), date(2026, 10, 8))       # 23:30 IST
        self.assertEqual(greenhouse.parse_iso_date("2026-10-08T20:00:00"), date(2026, 10, 9))         # naive = UTC
        self.assertIsNone(greenhouse.parse_iso_date("not a date"))
        self.assertIsNone(greenhouse.parse_iso_date(None))

    def test_posted_days(self):
        self.assertEqual(greenhouse.posted_iso_to_days("2026-10-02T09:00:00Z", TODAY), 7)
        self.assertEqual(greenhouse.posted_iso_to_days("2026-10-09T20:00:00Z", TODAY), 0)  # tomorrow in IST: today
        self.assertEqual(greenhouse.format_posted_date("2026-10-08T20:00:00-04:00"), "09/10/2026")


class GreenhouseParseTest(unittest.TestCase):
    def test_first_published_not_updated_at(self):
        payload = {"jobs": [job(1, "2026-08-01T10:00:00-04:00", updated_at="2026-10-09T10:00:00-04:00"),
                            job(2, None), {"id": 3, "title": ""}]}
        jobs = quiet(greenhouse.parse_jobs_from_api, payload, "https://job-boards.greenhouse.io/acme")
        self.assertEqual([item["job_id"] for item in jobs], ["1"])  # no first_published: skipped, never updated_at
        self.assertEqual(jobs[0]["posted_date"], "2026-08-01T10:00:00-04:00")
        self.assertEqual(jobs[0]["description"], "Build things")

    def test_workplace_and_employment_metadata(self):
        metadata = [{"name": "Is this job part of ACC?", "value": False, "value_type": "yes_no"},
                    {"name": "Workplace Type", "value": "Hybrid", "value_type": "single_select"},
                    {"name": "Employment Type", "value": "Full-time", "value_type": "single_select"}]
        remote = [{"name": "Workplace Type", "value": "Remote"}, {"name": "Job Type", "value": ["Internship"]}]
        payload = {"jobs": [job(1, "2026-10-08T10:00:00Z", metadata=metadata),
                            job(2, "2026-10-08T10:00:00Z", metadata=remote, location={"name": ""}),
                            job(3, "2026-10-08T10:00:00Z", metadata=None)]}
        jobs = greenhouse.parse_jobs_from_api(payload, "https://job-boards.greenhouse.io/acme")
        self.assertEqual([(item["location"], item["employment_type"]) for item in jobs],
                         [("Bengaluru, India (Hybrid)", "Full-time"), ("Remote", "Internship"),
                          ("Bengaluru, India", "")])


class GreenhouseWindowTest(unittest.TestCase):
    def test_seven_day_window_and_polite_session(self):
        seen_headers = []

        async def fake_fetch(session, api_url, attempts=3):
            seen_headers.append(dict(session.headers))
            return {"jobs": [job(1, "2026-10-02T09:00:00Z"), job(2, "2026-10-01T09:00:00Z"),
                             job(3, "2026-10-09T03:00:00Z")]}

        companies = [{"name": "Acme", "slug": "acme"}, {"name": "Beta", "slug": "beta"}]
        report = ScrapeReport("greenhouse")
        with (mock.patch.object(greenhouse, "fetch_board_jobs", fake_fetch),
              mock.patch.object(greenhouse, "REQUEST_DELAY_S", 0),
              mock.patch.object(greenhouse, "today_ist", return_value=TODAY)):
            jobs = quiet(asyncio.run, greenhouse.collect_greenhouse_jobs(companies, report))
        self.assertEqual(len(jobs), 6)
        self.assertTrue(all(headers["User-Agent"].startswith("JobSeekerBot/1.0") for headers in seen_headers))
        self.assertEqual({item["collected_on"] for item in jobs}, {"09/10/2026"})
        with mock.patch.object(scraper_common, "MAX_POSTED_DAYS", 7):
            kept = scraper_common.keep_recent_jobs(scraper_common.jobs_to_dataframe(jobs))
        # posted 7 days ago (10-02) is still live; 8 days ago (10-01) is not
        self.assertEqual(sorted(set(kept["job_id"])), ["1", "3"])
        self.assertEqual(sorted(set(kept["posted_days"].tolist())), [0, 7])


if __name__ == "__main__":
    unittest.main()
