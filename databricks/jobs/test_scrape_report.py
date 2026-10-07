"""Offline tests for the scrape reports, the Greenhouse board token and the run history (no network, HTTP mocked).

    python databricks/jobs/test_scrape_report.py
"""
import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import greenhouse  # noqa: E402
import linkedin  # noqa: E402
import publish_to_supabase  # noqa: E402
import record_scrape_report  # noqa: E402
import scraper_common  # noqa: E402
from scraper_common import ScrapeFailed, ScrapeReport, build_report, report_status, scrape_report  # noqa: E402

GITHUB_ENV = {"GITHUB_RUN_ID": "987", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_WORKFLOW": "Databricks Scrapers"}
NO_GITHUB_ENV = {key: "" for key in GITHUB_ENV}


def quiet(function, *args, **kwargs):
    """Runs function with stdout captured; returns (result, output)."""
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = function(*args, **kwargs)
    return result, output.getvalue()


class BoardTokenTest(unittest.TestCase):
    def test_tokens_board_urls_and_api_urls(self):
        cases = {
            "stripe": "stripe",
            " stripe ": "stripe",
            "/stripe/": "stripe",
            "https://job-boards.greenhouse.io/stripe": "stripe",
            "https://job-boards.greenhouse.io/stripe/": "stripe",
            "job-boards.greenhouse.io/stripe": "stripe",
            "boards.greenhouse.io/stripe": "stripe",
            "https://boards.greenhouse.io/stripe/jobs/6012345": "stripe",
            "https://job-boards.eu.greenhouse.io/acme-co/jobs/123?gh_src=x": "acme-co",
            "https://boards-api.greenhouse.io/v1/boards/stripe/jobs": "stripe",
            "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true": "stripe",
            "https://boards.greenhouse.io/embed/job_board?for=stripe": "stripe",
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(greenhouse.board_token(value), expected)

    def test_invalid_values(self):
        for value in (None, "", "   ", "https://example.com/stripe", "https://job-boards.greenhouse.io/",
                      "https://boards-api.greenhouse.io/v1/boards/", "stripe inc", "https://greenhouse.io.evil.com/x"):
            with self.subTest(value=value):
                self.assertIsNone(greenhouse.board_token(value))

    def test_api_url_is_built_from_the_token(self):
        self.assertEqual(greenhouse.board_api_url("stripe"),
                         "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true")

    def test_company_token_slug_wins_over_api_url(self):
        company = {"slug": "stripe", "api_url": "https://boards-api.greenhouse.io/v1/boards/other/jobs"}
        self.assertEqual(greenhouse.company_board_token(company), "stripe")
        self.assertEqual(greenhouse.company_board_token({"slug": None, "api_url": company["api_url"]}), "other")
        self.assertEqual(greenhouse.company_board_token({"slug": "not a url!", "api_url": company["api_url"]}), "other")

    def test_company_token_failures(self):
        with self.assertRaisesRegex(ScrapeFailed, "^Missing Greenhouse board URL$"):
            greenhouse.company_board_token({"slug": "", "api_url": None})
        with self.assertRaisesRegex(ScrapeFailed, "^Unable to derive Greenhouse board$"):
            greenhouse.company_board_token({"slug": "https://example.com/x"})


class GreenhouseOutcomesTest(unittest.TestCase):
    def test_one_outcome_per_company_with_the_reason(self):
        requested = []

        async def fake_fetch(session, api_url, attempts=3):
            requested.append(api_url)
            if "/broken/" in api_url:
                raise ScrapeFailed("HTTP 404")
            return {"jobs": [{"id": 1, "title": "Engineer", "first_published": "2026-10-07T05:00:00Z",
                              "absolute_url": "https://job-boards.greenhouse.io/stripe/jobs/1", "content": "x"}]}

        companies = [
            {"name": "Stripe", "slug": None, "api_url": "https://boards-api.greenhouse.io/v1/boards/stripe/jobs"},
            {"name": "Broken", "slug": "broken"},
            {"name": "Empty", "slug": ""},
            {"name": "Bad", "slug": "https://example.com/bad"},
        ]
        report = ScrapeReport("greenhouse")
        with mock.patch.object(greenhouse, "fetch_board_jobs", fake_fetch):
            jobs, _ = quiet(asyncio.run, greenhouse.collect_greenhouse_jobs(companies, report))
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["company_url"], "https://job-boards.greenhouse.io/stripe")
        self.assertEqual(requested[0], "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true")
        self.assertEqual(report.companies, [
            {"name": "Stripe", "ok": True, "jobs_found": 1, "error": None},
            {"name": "Broken", "ok": False, "jobs_found": None, "error": "HTTP 404"},
            {"name": "Empty", "ok": False, "jobs_found": None, "error": "Missing Greenhouse board URL"},
            {"name": "Bad", "ok": False, "jobs_found": None, "error": "Unable to derive Greenhouse board"},
        ])
        self.assertEqual(report.failed_names, ["Broken", "Empty", "Bad"])


class LinkedInSearchesTest(unittest.TestCase):
    def test_dropped_searches_are_returned(self):
        companies = [{"name": "Data Engineer India", "api_url": "Data Engineer"}]
        user = [("Data Engineer", None), ("Analyst", "Pune"), ("Analyst", "Chennai")]
        with mock.patch.object(linkedin, "MAX_LINKEDIN_SEARCHES", 2):
            (searches, dropped), output = quiet(linkedin.build_searches, companies, user)
        self.assertEqual([search["name"] for search in searches], ["Data Engineer India", "Role | Analyst | Pune"])
        self.assertEqual(dropped, ["Role | Analyst | Chennai"])
        self.assertIn("skipping: Role | Analyst | Chennai", output)
        with mock.patch.object(linkedin, "MAX_LINKEDIN_SEARCHES", 90):
            self.assertEqual(linkedin.build_searches(companies, user)[1], [])

    def test_search_failures_raise_with_a_reason(self):
        with self.assertRaisesRegex(ScrapeFailed, "No search keywords"):
            quiet(asyncio.run, linkedin.scrape_linkedin_jobs({"name": "x", "api_url": "  "}))


class ReportShapeTest(unittest.TestCase):
    def test_status_rules(self):
        ok = {"name": "a", "ok": True}
        bad = {"name": "b", "ok": False}
        self.assertEqual(report_status([ok, ok], "out.csv"), "ok")
        self.assertEqual(report_status([ok, bad], "out.csv"), "partial")
        self.assertEqual(report_status([bad, bad], "out.csv"), "failed")
        self.assertEqual(report_status([ok], None), "failed")
        self.assertEqual(report_status([], "out.csv"), "failed")

    def test_outcome_fields(self):
        report = ScrapeReport("workday")
        report.outcome("A", True, jobs_found=3, error="ignored")
        report.outcome("B", False, jobs_found=7)
        self.assertEqual(report.companies, [{"name": "A", "ok": True, "jobs_found": 3, "error": None},
                                            {"name": "B", "ok": False, "jobs_found": None, "error": "failed"}])

    def test_document_shape(self):
        companies = [{"name": "A", "ok": True, "jobs_found": 3, "error": None},
                     {"name": "B", "ok": False, "jobs_found": None, "error": "HTTP 404"}]
        with mock.patch.dict(os.environ, GITHUB_ENV):
            doc = build_report("linkedin", status="partial", totals={"companies": 2, "jobs_scraped": 3},
                               companies=companies, started_at="2026-10-07T00:00:00Z",
                               linkedin={"searches_total": 95, "searches_cap": 90, "dropped": ["x"]})
        self.assertEqual(doc["format"], "jobseeker.scrape_report.v1")
        self.assertEqual(doc["source"], "linkedin")
        self.assertEqual(set(doc), {"format", "source", "run", "totals", "linkedin", "companies"})
        run = doc["run"]
        self.assertEqual((run["github_run_id"], run["github_run_attempt"], run["workflow"]),
                         ("987", 2, "Databricks Scrapers"))
        self.assertEqual(run["status"], "partial")
        self.assertRegex(run["finished_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(doc["totals"], {"companies": 2, "failed": 1, "jobs_scraped": 3, "jobs_written": None,
                                         "missing_descriptions": None, "already_seen": None})
        self.assertEqual(doc["linkedin"]["dropped"], ["x"])
        with mock.patch.dict(os.environ, NO_GITHUB_ENV):
            run = build_report("workday", status="ok", totals={}, companies=[], started_at=None)["run"]
        self.assertEqual((run["github_run_id"], run["github_run_attempt"], run["workflow"]), (None, None, None))


class ScrapeReportContextTest(unittest.TestCase):
    def run_body(self, body):
        """Runs body(report) inside scrape_report("workday") writing to a temp dir; returns (written doc, exception)."""
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(scraper_common, "OUTPUT_DIR", Path(tmp)):
            # write_report's default output_dir was bound at import time, so route it to the temp dir
            real_write = scraper_common.write_report
            with mock.patch.object(scraper_common, "write_report",
                                   lambda *a, **k: real_write(*a, **k, output_dir=tmp)):
                error = None
                try:
                    quiet(self._run, body)
                except BaseException as exc:  # noqa: BLE001 - SystemExit included
                    error = exc
            doc = json.loads((Path(tmp) / "workday_report.json").read_text(encoding="utf-8"))
        return doc, error

    @staticmethod
    def _run(body):
        with scrape_report("workday") as report:
            body(report)

    def test_finished_run(self):
        def body(report):
            report.totals.update(companies=2, jobs_scraped=5, jobs_written=4, missing_descriptions=0)
            report.outcome("A", True, jobs_found=5)
            report.outcome("B", False, error="Missing Workday URL")
            report.finish("out.csv")

        doc, error = self.run_body(body)
        self.assertIsNone(error)
        self.assertEqual(doc["run"]["status"], "partial")
        self.assertEqual(doc["totals"]["failed"], 1)
        self.assertEqual(doc["companies"][1]["error"], "Missing Workday URL")

    def test_crash_is_reported_and_reraised(self):
        def body(report):
            report.outcome("A", True, jobs_found=1)
            raise RuntimeError("browser died\nCall log: ...")

        doc, error = self.run_body(body)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(doc["run"]["status"], "crashed")
        self.assertEqual(doc["run"]["message"], "RuntimeError: browser died")
        self.assertEqual(len(doc["companies"]), 1)

    def test_exit_before_finish_is_failed(self):
        def body(report):
            report.message = "No Workday companies to scrape"
            sys.exit(1)

        doc, error = self.run_body(body)
        self.assertIsInstance(error, SystemExit)
        self.assertEqual((doc["run"]["status"], doc["run"]["message"]), ("failed", "No Workday companies to scrape"))


class RecordScrapeReportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "workday_report.json"

    def record(self, *extra, rpc=None, env=None):
        """Runs the script's main(); returns (exit code, output, payloads sent)."""
        sent = []

        def fake_rpc(name, payload, timeout=60):
            sent.append((name, payload))
            if rpc:
                return rpc(name, payload)
            return {"recorded": True, "companies": len(payload["report"]["companies"])}

        with mock.patch.object(record_scrape_report, "rpc", fake_rpc), mock.patch.dict(os.environ, env or NO_GITHUB_ENV):
            code, output = quiet(record_scrape_report.main,
                                 ["--scraper", "databricks/workday.py", "--report", str(self.path), *extra])
        return code, output, sent

    def write(self, **run):
        companies = [{"name": "A", "ok": True, "jobs_found": 2, "error": None}]
        with mock.patch.dict(os.environ, {**NO_GITHUB_ENV, **run}):
            doc = build_report("workday", status="ok", totals={"companies": 1}, companies=companies,
                               started_at="2026-10-07T00:00:00Z")
        self.path.write_text(json.dumps(doc), encoding="utf-8")
        return doc

    def test_sends_the_report(self):
        doc = self.write()
        code, output, sent = self.record()
        self.assertEqual(code, 0)
        self.assertEqual(sent, [("pipeline_record_scrape", {"report": doc})])
        self.assertIn("[RECORDED] source=workday status=ok companies=1", output)

    def test_missing_report_sends_a_crashed_one(self):
        with mock.patch.dict(os.environ, GITHUB_ENV):
            code, _, sent = self.record(env=GITHUB_ENV)
        self.assertEqual(code, 0)
        report = sent[0][1]["report"]
        self.assertEqual(report["format"], "jobseeker.scrape_report.v1")
        self.assertEqual(report["source"], "workday")
        self.assertEqual(report["run"]["status"], "crashed")
        self.assertEqual(report["run"]["message"], "scraper wrote no report")
        self.assertEqual(report["run"]["github_run_id"], "987")
        self.assertEqual(report["run"]["github_run_attempt"], 2)
        self.assertRegex(report["run"]["finished_at"], r"Z$")
        self.assertEqual(report["companies"], [])

    def test_report_of_another_run_counts_as_missing(self):
        self.write(GITHUB_RUN_ID="111")
        _, _, sent = self.record(env=GITHUB_ENV)
        self.assertEqual(sent[0][1]["report"]["run"]["status"], "crashed")
        self.write(GITHUB_RUN_ID="987")
        _, _, sent = self.record(env=GITHUB_ENV)
        self.assertEqual(sent[0][1]["report"]["run"]["status"], "ok")

    def test_unreadable_report_is_crashed(self):
        self.path.write_text("{not json", encoding="utf-8")
        _, _, sent = self.record()
        self.assertEqual(sent[0][1]["report"]["run"]["message"], "unreadable report: JSONDecodeError")

    def test_always_exits_0(self):
        self.write()

        def failing(name, payload):
            raise RuntimeError("pipeline_record_scrape failed with 400: Invalid status")

        code, output, _ = self.record(rpc=failing)
        self.assertEqual(code, 0)
        self.assertIn("::warning::Could not record the scrape report: RuntimeError", output)

    def test_dry_run_sends_nothing(self):
        self.write()
        code, output, sent = self.record("--dry-run")
        self.assertEqual((code, sent), (0, []))
        self.assertIn("[DRY RUN] would record source=workday status=ok", output)

    def test_unknown_scraper(self):
        with mock.patch.object(record_scrape_report, "rpc") as rpc:
            code, output = quiet(record_scrape_report.main, ["--scraper", "databricks/upload_to_volume.py"])
        self.assertEqual(code, 0)
        rpc.assert_not_called()
        self.assertIn("::warning::", output)


RUN = {
    "run_id": 123456789,
    "start_time": 1759795200000,  # 2025-10-07T00:00:00Z
    "end_time": 1759796720000,
    "run_duration": 1520000,
    "trigger": "ONE_TIME",
    "state": {"life_cycle_state": "TERMINATED", "result_state": "SUCCESS", "state_message": "x" * 400},
    "tasks": [
        {"task_key": "Step_02", "attempt_number": 0, "start_time": 1759795500000, "run_duration": 60000,
         "state": {"life_cycle_state": "TERMINATED", "result_state": "FAILED"}},
        {"task_key": "Step_01", "start_time": 1759795200000, "setup_duration": 1000, "execution_duration": 299000,
         "cleanup_duration": 0, "state": {"life_cycle_state": "TERMINATED", "result_state": "SUCCESS"}},
        {"task_key": "Step_02", "attempt_number": 1, "start_time": 1759795600000, "run_duration": 90000,
         "state": {"life_cycle_state": "TERMINATED", "result_state": "SUCCESS"}},
    ],
}


class RunHistoryTest(unittest.TestCase):
    def test_map_run(self):
        row = publish_to_supabase.map_run(RUN)
        self.assertEqual(row["run_id"], "123456789")
        self.assertEqual(row["started_at"], "2025-10-07T00:00:00Z")
        self.assertEqual(row["ended_at"], "2025-10-07T00:25:20Z")
        self.assertEqual(row["duration_s"], 1520)
        self.assertEqual((row["state"], row["result"], row["trigger"]), ("TERMINATED", "SUCCESS", "ONE_TIME"))
        self.assertEqual(len(row["message"]), 300)
        self.assertEqual(row["tasks"], [
            {"task_key": "Step_01", "state": "TERMINATED", "result": "SUCCESS", "started_at": "2025-10-07T00:00:00Z",
             "duration_s": 300},
            {"task_key": "Step_02", "state": "TERMINATED", "result": "SUCCESS", "started_at": "2025-10-07T00:06:40Z",
             "duration_s": 90},
        ])

    def test_running_run(self):
        row = publish_to_supabase.map_run({"run_id": 5, "start_time": 1759795200000, "end_time": 0,
                                           "state": {"life_cycle_state": "RUNNING"}})
        self.assertEqual((row["ended_at"], row["duration_s"], row["result"], row["message"], row["tasks"]),
                         (None, None, None, "", []))

    def test_record_runs(self):
        calls = []
        with mock.patch.object(publish_to_supabase, "find_job_id", return_value=42) as find, \
                mock.patch.object(publish_to_supabase, "api", return_value={"runs": [RUN]}) as api, \
                mock.patch.object(publish_to_supabase, "rpc", lambda name, payload, **_: calls.append((name, payload))
                                  or {"recorded": 1}), \
                mock.patch.dict(os.environ, {"DATABRICKS_JOB_NAME": ""}):
            _, output = quiet(publish_to_supabase.record_runs)
        find.assert_called_once_with("JobSeeeker")
        api.assert_called_once_with("GET", "/api/2.2/jobs/runs/list",
                                    params={"job_id": 42, "limit": 20, "expand_tasks": "true"})
        self.assertEqual(calls[0][0], "pipeline_record_runs")
        self.assertEqual(calls[0][1]["batch"]["runs"][0]["run_id"], "123456789")
        self.assertIn("[RUNS] recorded 1 pipeline runs (latest 123456789 TERMINATED/SUCCESS)", output)

    def test_record_runs_never_raises(self):
        with mock.patch.object(publish_to_supabase, "find_job_id", side_effect=RuntimeError("HTTP 403")):
            _, output = quiet(publish_to_supabase.record_runs)
        self.assertIn("[WARN] run history not recorded: RuntimeError: HTTP 403", output)
        with mock.patch.object(publish_to_supabase, "find_job_id", return_value=None):
            _, output = quiet(publish_to_supabase.record_runs)
        self.assertIn("no Databricks job named", output)

    def run_main(self, *argv, manifest=None, find_error=None):
        record = mock.Mock()
        find = mock.Mock(side_effect=find_error, return_value=manifest)
        with mock.patch.object(sys, "argv", ["publish_to_supabase.py", *argv]), \
                mock.patch.object(publish_to_supabase, "record_runs", record), \
                mock.patch.object(publish_to_supabase, "find_manifest", find):
            try:
                code, _ = quiet(publish_to_supabase.main)
            except RuntimeError:
                code = "raised"
        return code, record.call_count

    def test_main_records_runs_after_every_non_dry_run(self):
        self.assertEqual(self.run_main(), (0, 1))  # [SKIP] no complete publish yet
        self.assertEqual(self.run_main(find_error=RuntimeError("volume down")), ("raised", 1))
        self.assertEqual(self.run_main("--dry-run"), (0, 0))

    def test_main_records_runs_after_already_published(self):
        manifest = {"run_id": "77", "snapshot_at": "2026-10-07T00:00:00Z", "counts": {}}
        state = {"run_id": "77", "snapshot_at": "2026-10-07T00:00:00Z", "published_at": "2026-10-07T00:10:00Z"}
        with mock.patch.object(publish_to_supabase, "rpc", return_value=state):
            self.assertEqual(self.run_main(manifest=manifest), (0, 1))


if __name__ == "__main__":
    unittest.main()
