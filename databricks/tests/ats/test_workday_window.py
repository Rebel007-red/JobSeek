"""Workday: only recent India jobs reach the description fetch, which stops at its time budget (no network, no browser)."""
import asyncio
import contextlib
import io
import unittest
from unittest import mock

from harness import DATABRICKS  # also puts databricks/ on sys.path

import scraper_common
import workday
from ats.base import mentions_india


def row(job_id, location, posted_days, description=""):
    return {"company_name": "Acme", "ats_type": "workday", "company_url": "https://acme.wd1.myworkdayjobs.com/x",
            "job_id": job_id, "title": f"Engineer {job_id}", "location": location, "posted_date": "", "posted_days": posted_days,
            "job_url": f"https://acme.wd1.myworkdayjobs.com/x/job/{job_id}", "description": description, "collected_on": ""}


class FakePage:
    async def close(self):
        pass


class FakeBrowser:
    async def new_page(self):
        return FakePage()

    async def close(self):
        pass


class FakePlaywright:
    class chromium:
        @staticmethod
        async def launch(headless=True):
            return FakeBrowser()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def quiet(coroutine):
    with contextlib.redirect_stdout(io.StringIO()):
        return asyncio.run(coroutine)


class WorkdayWindowTest(unittest.TestCase):
    def test_only_recent_india_jobs_are_fetched(self):
        jobs = [row("1", "Bengaluru, India", 1), row("2", "Austin, TX", 0), row("3", "3 Locations", 0),
                row("4", "IND - Hyderabad", 4), row("5", "Pune", 5)]
        captured = {}

        async def fake_fetch(found, label, read, skip_ids, skip_keys):
            captured["ids"] = [job["job_id"] for job in found]
            return found

        with mock.patch.object(scraper_common, "fetch_descriptions", fake_fetch), \
                mock.patch.object(scraper_common, "write_flat_jobs_csv", lambda df, prefix: "out.csv"):
            dataframe, output = quiet(scraper_common.write_recent_jobs(
                jobs, "Workday", "workday", None, max_days=4, keep=lambda job: mentions_india(job.get("location"))))
        self.assertEqual(captured["ids"], ["1", "4"])  # Austin and '3 Locations' are not India; Pune is 5 days old
        self.assertEqual(list(dataframe["job_id"]), ["1", "4"])
        self.assertEqual(output, "out.csv")

    def test_default_window_is_four_days(self):
        self.assertEqual(workday.WORKDAY_MAX_POSTED_DAYS, 4)

    def test_time_budget_leaves_the_rest_empty_newest_first(self):
        jobs = [row(str(i), "Bengaluru", days) for i, days in enumerate([3, 0, 2, 1])]
        opened = []

        async def read(page, job):
            opened.append(job["job_id"])
            return "text"

        # A budget of 0 lets nothing through after the first check
        with mock.patch.object(scraper_common, "async_playwright", lambda: FakePlaywright()), \
                mock.patch.object(scraper_common, "DESC_TIME_BUDGET_MINUTES", 0), \
                mock.patch.object(scraper_common, "_clock", side_effect=[0.0] + [1.0] * 10):
            result = quiet(scraper_common.fetch_descriptions(jobs, "Workday", read))
        self.assertEqual(opened, [])
        self.assertTrue(all(job["description"] == "" for job in result))

        opened.clear()
        with mock.patch.object(scraper_common, "async_playwright", lambda: FakePlaywright()), \
                mock.patch.object(scraper_common, "DESC_CONCURRENCY", 1):
            result = quiet(scraper_common.fetch_descriptions([dict(job) for job in jobs], "Workday", read))
        self.assertEqual(opened, ["1", "3", "2", "0"])  # newest (posted_days 0) first
        self.assertTrue(all(job["description"] == "text" for job in result))


if __name__ == "__main__":
    unittest.main()
