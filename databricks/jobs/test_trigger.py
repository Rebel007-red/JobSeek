"""Offline tests for the ATS Scrapers workflow's compute saving (no network, HTTP mocked): upload_to_volume.py's new-job
counters, trigger_job.py's decisions (--no-new-files and the daily run), record_trigger.py's report, and the constants
that must agree with the SQL (app.c_trigger_decisions(), app.c_daily_floor_hours()) and the workflow.

    python databricks/jobs/test_trigger.py
"""
import contextlib
import io
import json
import os
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import dotenv
import requests

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(HERE), str(HERE.parent)]

# The modules load databricks/.env and the repo .env on import; these tests must never see real credentials
with mock.patch.object(dotenv, "load_dotenv", lambda *args, **kwargs: False):
    import record_trigger  # noqa: E402
    import supabase_api  # noqa: E402
    import trigger_job  # noqa: E402
    import upload_to_volume  # noqa: E402

FAKE_ENV = {"DATABRICKS_HOST": "https://dbc.example.test", "DATABRICKS_TOKEN": "test-token",
            "SUPABASE_URL": "https://supabase.example.test", "SUPABASE_SERVICE_ROLE_KEY": "test-key"}
GITHUB_ENV = {"GITHUB_RUN_ID": "987", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_WORKFLOW": "ATS Scrapers",
              "GITHUB_EVENT_NAME": "schedule"}
HEADER = "company_name,ats_type,company_url,job_id,title,location,posted_date,job_url,description\n"


def setUpModule():
    # A safety net: any HTTP request a test forgot to mock fails instead of reaching a real service
    def no_network(*args, **kwargs):
        raise AssertionError("network request in an offline test")

    patchers = [mock.patch.object(requests.sessions.Session, "request", no_network),
                mock.patch.dict(os.environ, FAKE_ENV)]
    for patcher in patchers:
        patcher.start()
        unittest.addModuleCleanup(patcher.stop)


def quiet(function, *args, **kwargs):
    """Runs function with stdout and stderr captured; returns (result, output)."""
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        result = function(*args, **kwargs)
    return result, output.getvalue()


def read_outputs(path):
    """$GITHUB_OUTPUT as a dict (a key written twice keeps its last value, as in Actions)."""
    values = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        key, _, value = line.partition("=")
        values[key] = value
    return values


class FakeResponse:
    def __init__(self, status_code, body=None):
        self.status_code = status_code
        self._body = body
        self.text = json.dumps(body) if body is not None else ""

    def json(self):
        if isinstance(self._body, str):
            raise ValueError("not JSON")
        return self._body


def seen_response(*keys):
    return FakeResponse(200, {"generated_at": "2026-10-13T00:00:00Z", "job_keys": list(keys)})


class TempDirTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        cwd = os.getcwd()
        os.chdir(self.dir)  # the upload patterns are relative globs, as in the workflow
        self.addCleanup(os.chdir, cwd)
        self.output = self.dir / "github_output"
        self.output.write_text("", encoding="utf-8")
        env = mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(self.output)})
        env.start()
        self.addCleanup(env.stop)

    def write_csv(self, name, rows):
        path = self.dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [",".join([company, ats, "", job_id, "Engineer", "Pune", "2026-10-12", "", '"line one\nline two"'])
                 for company, ats, job_id in rows]
        path.write_text(HEADER + "".join(line + "\n" for line in lines), encoding="utf-8")
        return path


class UploadCountTest(TempDirTest):
    def run_upload(self, patterns, seen=None, fail=(), seen_keys_path="/Volumes/x/config/ats_seen_keys.json"):
        """Runs upload_to_volume.run with the HTTP parts patched; returns (exit code, outputs, log, uploaded names)."""
        uploaded = []

        def fake_upload(local_file, remote_path, attempts=3):
            if local_file.name in fail:
                raise RuntimeError("Upload failed with status 500")
            uploaded.append(local_file.name)

        get = mock.Mock(return_value=seen if seen is not None else FakeResponse(404))
        with mock.patch.object(upload_to_volume.requests, "get", get), \
                mock.patch.object(upload_to_volume, "create_remote_directory"), \
                mock.patch.object(upload_to_volume, "upload_file", fake_upload):
            code, log = quiet(upload_to_volume.run, "/Volumes/jobseeker/default/scrapes", patterns, seen_keys_path)
        return code, read_outputs(self.output), log, uploaded

    def test_seen_rows_are_not_new(self):
        self.write_csv("workday_1.csv", [("Acme", "workday", "JR-1"), ("Acme", "workday", "JR-2"),
                                         ("Beta", "workday", "JR-1")])
        seen = seen_response(upload_to_volume.job_key("workday", "Acme", "JR-1"))
        code, outputs, log, uploaded = self.run_upload(["workday_1.csv"], seen)
        self.assertEqual(code, 0)
        self.assertEqual(uploaded, ["workday_1.csv"])
        self.assertEqual(outputs, {"uploaded": "1", "new_files": "1", "new_jobs": "2", "empty_files": "0",
                                   "seen_keys": "loaded"})
        self.assertIn("[SUMMARY] uploaded 1 file(s), 1 with new jobs (2 new jobs), 0 empty; seen keys: loaded (1)", log)

    def test_a_file_of_seen_jobs_is_uploaded_but_not_new(self):
        self.write_csv("greenhouse_1.csv", [("Acme", "greenhouse", "11"), (" ACME ", "Greenhouse", "12")])
        seen = seen_response(upload_to_volume.job_key("greenhouse", "acme", "11"),
                             upload_to_volume.job_key("greenhouse", "acme", "12"))
        code, outputs, _, uploaded = self.run_upload(["greenhouse_1.csv"], seen)
        self.assertEqual((code, uploaded), (0, ["greenhouse_1.csv"]))  # the sightings still reach the pipeline
        self.assertEqual((outputs["uploaded"], outputs["new_files"], outputs["new_jobs"]), ("1", "0", "0"))

    def test_unknown_seen_set_counts_every_row(self):
        self.write_csv("workday_1.csv", [("Acme", "workday", "JR-1"), ("Acme", "workday", "JR-2")])
        for response in (FakeResponse(404), FakeResponse(500, {"error": "x"}), FakeResponse(200, "not json"),
                         FakeResponse(200, ["a list"])):
            with self.subTest(status=response.status_code, body=response._body):
                self.output.write_text("", encoding="utf-8")
                code, outputs, log, _ = self.run_upload(["workday_1.csv"], response)
                self.assertEqual(code, 0)
                self.assertEqual((outputs["new_files"], outputs["new_jobs"], outputs["seen_keys"]),
                                 ("1", "2", "unavailable"))
                self.assertIn("[WARN] seen job keys unavailable (", log)
                self.assertIn("every row counts as new", log)

    def test_network_error_and_no_seen_keys(self):
        self.write_csv("workday_1.csv", [("Acme", "workday", "JR-1")])
        with mock.patch.object(upload_to_volume.requests, "get", side_effect=requests.ConnectionError("down")), \
                mock.patch.object(upload_to_volume, "create_remote_directory"), \
                mock.patch.object(upload_to_volume, "upload_file"):
            code, log = quiet(upload_to_volume.run, "/Volumes/a/b/c", ["workday_1.csv"])
        self.assertEqual(code, 0)
        self.assertIn("ConnectionError", log)
        self.assertEqual(read_outputs(self.output)["new_jobs"], "1")
        # --no-seen-keys: no request at all
        self.output.write_text("", encoding="utf-8")
        code, outputs, _, _ = self.run_upload(["workday_1.csv"], seen_keys_path=None)
        self.assertEqual((code, outputs["new_jobs"], outputs["seen_keys"]), (0, "1", "unavailable"))

    def test_rows_without_job_id_or_ats_type_are_new(self):
        path = self.dir / "ats" / "lever_1.csv"
        path.parent.mkdir()
        path.write_text("company_name,title\nAcme,Engineer\n", encoding="utf-8")  # no job_id / ats_type columns
        self.write_csv("ats/ashby_1.csv", [("Acme", "", "1"), ("Acme", "ashby", "")])
        seen = seen_response(upload_to_volume.job_key("ashby", "Acme", "1"), upload_to_volume.job_key("", "Acme", "1"))
        code, outputs, _, uploaded = self.run_upload(["ats/lever_1.csv", "ats/ashby_1.csv"], seen)
        self.assertEqual((code, sorted(uploaded)), (0, ["ashby_1.csv", "lever_1.csv"]))
        self.assertEqual((outputs["uploaded"], outputs["new_files"], outputs["new_jobs"]), ("2", "2", "3"))

    def test_header_only_and_empty_files_are_skipped(self):
        (self.dir / "ats").mkdir()
        (self.dir / "ats" / "keka_1.csv").write_text(HEADER, encoding="utf-8")
        (self.dir / "ats" / "darwinbox_1.csv").write_text("", encoding="utf-8")
        self.write_csv("ats/lever_1.csv", [("Acme", "lever", "a")])
        code, outputs, log, uploaded = self.run_upload(
            ["ats/keka_1.csv", "ats/darwinbox_1.csv", "ats/lever_1.csv"], seen_response())
        self.assertEqual((code, uploaded), (0, ["lever_1.csv"]))
        self.assertEqual(outputs, {"uploaded": "1", "new_files": "1", "new_jobs": "1", "empty_files": "2",
                                   "seen_keys": "loaded"})
        self.assertRegex(log, r"\[SKIP\] .*keka_1\.csv: no rows")

    def test_failed_upload_counts_nowhere_and_outputs_are_still_written(self):
        self.write_csv("ats/lever_1.csv", [("Acme", "lever", "a")])
        self.write_csv("ats/ashby_1.csv", [("Acme", "ashby", "b"), ("Acme", "ashby", "c")])
        code, outputs, log, uploaded = self.run_upload(["ats/lever_1.csv", "ats/ashby_1.csv"], seen_response(),
                                                      fail={"ashby_1.csv"})
        self.assertEqual((code, uploaded), (1, ["lever_1.csv"]))
        self.assertEqual((outputs["uploaded"], outputs["new_files"], outputs["new_jobs"]), ("1", "1", "1"))
        self.assertIn("[ERROR]", log)
        self.assertIn("[SUMMARY] uploaded 1 file(s)", log)

    def test_unexpected_error_still_writes_the_outputs(self):
        self.write_csv("workday_1.csv", [("Acme", "workday", "JR-1")])
        with mock.patch.object(upload_to_volume, "resolve_files", side_effect=OSError("disk")):
            code, _ = quiet(upload_to_volume.run, "/Volumes/a/b/c", ["workday_1.csv"])
        self.assertEqual(code, 1)
        self.assertEqual(read_outputs(self.output)["uploaded"], "0")

    def test_missing_pattern_fails_after_the_others(self):
        self.write_csv("workday_1.csv", [("Acme", "workday", "JR-1")])
        code, outputs, log, uploaded = self.run_upload(["workday_1.csv", "greenhouse*.csv"], seen_response())
        self.assertEqual((code, uploaded, outputs["uploaded"]), (1, ["workday_1.csv"], "1"))
        self.assertIn("No files matched pattern: greenhouse*.csv", log)

    def test_newest_match_and_the_same_file_once(self):
        old = self.write_csv("workday_1.csv", [("Acme", "workday", "JR-1")])
        self.write_csv("workday_2.csv", [("Acme", "workday", "JR-2")])
        os.utime(old, (time.time() - 3600, time.time() - 3600))
        code, outputs, _, uploaded = self.run_upload(["workday*.csv", "workday_2.csv"], seen_response())
        self.assertEqual((code, uploaded, outputs["uploaded"]), (0, ["workday_2.csv"], "1"))

    def test_no_github_output_is_fine(self):
        self.write_csv("workday_1.csv", [("Acme", "workday", "JR-1")])
        with mock.patch.dict(os.environ, {"GITHUB_OUTPUT": ""}):
            code, _, log, _ = self.run_upload(["workday_1.csv"], seen_response())
        self.assertEqual(code, 0)
        self.assertIn("[SUMMARY]", log)

    def test_long_descriptions_and_a_byte_order_mark(self):
        path = self.dir / "workday_1.csv"
        path.write_text("\ufeff" + HEADER + f'Acme,workday,,JR-1,T,Pune,2026-10-12,,"{"x" * 300_000}"\n',
                        encoding="utf-8")
        self.assertEqual(upload_to_volume.count_rows(path, set()), (1, 1))
        self.assertEqual(upload_to_volume.count_rows(path, {upload_to_volume.job_key("workday", "Acme", "JR-1")}),
                         (1, 0))

    def test_job_key_matches_the_scrapers(self):
        try:
            with mock.patch.object(dotenv, "load_dotenv", lambda *args, **kwargs: False):
                import scraper_common
        except ImportError as exc:  # Playwright / pandas missing: the hash itself is pinned below
            self.skipTest(f"scraper_common not importable: {exc}")
        for args in (("Workday", " Acme Corp ", "JR-1"), ("greenhouse", "Acme", " 12 "), ("", None, None)):
            self.assertEqual(upload_to_volume.job_key(*args), scraper_common.job_key(*args))
        self.assertEqual(upload_to_volume.ATS_SEEN_KEYS_FILE, scraper_common.ATS_SEEN_KEYS_FILE)

    def test_job_key_hash(self):
        import hashlib
        self.assertEqual(upload_to_volume.job_key("Workday", " Acme ", "JR-1"),
                         hashlib.sha256(b"workday|acme|JR-1").hexdigest())


HOUR_MS = 3_600_000


class FakeDatabricks:
    """The Jobs API calls trigger_job.py makes, answered from a list of runs (newest first)."""

    def __init__(self, active=(), latest_hours=None, run_now_error=None, result="SUCCESS", latest_result="SUCCESS"):
        self.active = list(active)
        self.latest_hours = latest_hours
        self.latest_result = latest_result
        self.run_now_error = run_now_error
        self.result = result
        self.calls = []

    def __call__(self, method, path, **kwargs):
        self.calls.append((method, path))
        params = kwargs.get("params") or {}
        if path.endswith("/runs/list") and params.get("active_only") == "true":
            return {"runs": self.active}
        if path.endswith("/runs/list"):
            if self.active:
                return {"runs": [self.active[0]]}
            if self.latest_hours is None:
                return {}
            return {"runs": [{"run_id": 50, "start_time": time.time() * 1000 - self.latest_hours * HOUR_MS,
                              "state": {"life_cycle_state": "TERMINATED", "result_state": self.latest_result}}]}
        if path.endswith("/run-now"):
            if self.run_now_error:
                raise RuntimeError(self.run_now_error)
            return {"run_id": 77}
        if path.endswith("/runs/get"):
            return {"state": {"life_cycle_state": "TERMINATED", "result_state": self.result},
                    "run_page_url": "https://dbc.example.test/run"}
        raise AssertionError(f"unexpected call {method} {path}")

    def paths(self, suffix):
        return [path for _, path in self.calls if path.endswith(suffix)]


def active_run(state, hours=1.0):
    return {"run_id": 60, "state": {"life_cycle_state": state}, "start_time": time.time() * 1000 - hours * HOUR_MS}


class TriggerDecisionTest(TempDirTest):
    def trigger(self, fake, *argv):
        with mock.patch.object(trigger_job, "api", fake), \
                mock.patch.object(trigger_job, "find_job_id", return_value=5), \
                mock.patch.object(trigger_job.time, "sleep"):
            code, log = quiet(trigger_job.main, list(argv))
        return code, read_outputs(self.output), log

    def test_no_new_files_with_an_active_run_neither_starts_nor_waits(self):
        for state in ("RUNNING", "QUEUED", "PENDING"):
            with self.subTest(state=state):
                self.output.write_text("", encoding="utf-8")
                fake = FakeDatabricks(active=[active_run(state)])
                code, outputs, log = self.trigger(fake, "--no-new-files", "--wait")
                self.assertEqual(code, 0)
                self.assertEqual((outputs["decision"], outputs["result"], outputs["run_id"]), ("no_new", "SKIPPED", ""))
                self.assertEqual((fake.paths("/run-now"), fake.paths("/runs/get")), ([], []))
                self.assertIn("[SKIP] no new jobs in this scrape", log)

    def test_no_new_files_and_a_recent_run(self):
        fake = FakeDatabricks(latest_hours=7.4)
        code, outputs, log = self.trigger(fake, "--no-new-files", "--idle-hours", "20", "--wait")
        self.assertEqual((code, outputs["decision"], outputs["result"]), (0, "no_new", "SKIPPED"))
        self.assertEqual(fake.paths("/run-now"), [])
        self.assertIn("[SKIP] no new jobs in this scrape; the latest run started 7.4 h ago (< 20 h), "
                      "so the daily run is not due", log)

    def test_no_new_files_starts_the_daily_run_and_waits(self):
        fake = FakeDatabricks(latest_hours=26)
        code, outputs, log = self.trigger(fake, "--no-new-files", "--wait", "--min-interval-hours", "3")
        self.assertEqual(code, 0)
        self.assertEqual(outputs, {"decision": "started_daily", "run_id": "77", "result": "SUCCESS"})
        self.assertEqual(len(fake.paths("/run-now")), 1)
        self.assertEqual(len(fake.paths("/runs/get")), 1)
        self.assertIn("[RUN] daily run: no new jobs, but the latest run started 26.0 h ago", log)

    def test_no_new_files_after_a_failed_run_runs_again(self):
        # The failed run may have written the seen keys without publishing its new jobs
        for state in ("FAILED", "TIMEDOUT", "INTERNAL_ERROR"):
            with self.subTest(state=state):
                self.output.write_text("", encoding="utf-8")
                fake = FakeDatabricks(latest_hours=2, latest_result=state)
                code, outputs, log = self.trigger(fake, "--no-new-files", "--wait")
                self.assertEqual((code, outputs["decision"], outputs["run_id"]), (0, "started_daily", "77"))
                self.assertIn(f"the latest run ended {state}, so it runs again", log)
        fake = FakeDatabricks(latest_hours=2, latest_result="CANCELED")
        _, outputs, _ = self.trigger(fake, "--no-new-files", "--wait")
        self.assertEqual(outputs["decision"], "no_new")

    def test_no_new_files_and_no_run_yet(self):
        fake = FakeDatabricks()
        code, outputs, log = self.trigger(fake, "--no-new-files", "--wait")
        self.assertEqual((code, outputs["decision"], outputs["run_id"]), (0, "started_daily", "77"))
        self.assertIn("there is no earlier run", log)

    def test_daily_run_paused(self):
        fake = FakeDatabricks(latest_hours=30, run_now_error="POST failed with 400: FEATURE_DISABLED quota")
        code, outputs, log = self.trigger(fake, "--no-new-files", "--wait")
        self.assertEqual((code, outputs["decision"], outputs["result"]), (0, "paused", "PAUSED"))
        self.assertIn("::warning::Databricks is not accepting new runs", log)

    def test_new_files_start_a_run(self):
        fake = FakeDatabricks(latest_hours=0.5)
        code, outputs, _ = self.trigger(fake, "--min-interval-hours", "0", "--wait")
        self.assertEqual(code, 0)
        self.assertEqual(outputs, {"decision": "started", "run_id": "77", "result": "SUCCESS"})

    def test_a_failed_run_exits_1_and_keeps_the_decision(self):
        fake = FakeDatabricks(result="FAILED")
        code, outputs, _ = self.trigger(fake, "--wait")
        self.assertEqual((code, outputs["decision"], outputs["result"]), (1, "started", "FAILED"))

    def test_no_wait_reports_started(self):
        code, outputs, _ = self.trigger(FakeDatabricks())
        self.assertEqual((code, outputs["decision"], outputs["result"]), (0, "started", "STARTED"))

    def test_joins_a_waiting_run(self):
        fake = FakeDatabricks(active=[active_run("QUEUED")])
        code, outputs, _ = self.trigger(fake, "--wait")
        self.assertEqual((code, outputs["decision"], outputs["run_id"], outputs["result"]), (0, "waiting", "60", "SUCCESS"))
        self.assertEqual(fake.paths("/run-now"), [])

    def test_recent_run_skips(self):
        fake = FakeDatabricks(latest_hours=1)
        code, outputs, log = self.trigger(fake, "--min-interval-hours", "3", "--wait")
        self.assertEqual((code, outputs["decision"], outputs["result"]), (0, "recent", "NONE"))
        self.assertEqual(fake.paths("/run-now"), [])
        # with a running run it waits for that one
        self.output.write_text("", encoding="utf-8")
        fake = FakeDatabricks(active=[active_run("RUNNING", hours=1)])
        code, outputs, _ = self.trigger(fake, "--min-interval-hours", "3", "--wait")
        self.assertEqual((code, outputs["decision"], outputs["run_id"], outputs["result"]), (0, "recent", "60", "SUCCESS"))

    def test_paused(self):
        fake = FakeDatabricks(run_now_error="POST failed with 400: FEATURE_DISABLED")
        code, outputs, _ = self.trigger(fake, "--wait")
        self.assertEqual((code, outputs["decision"], outputs["result"]), (0, "paused", "PAUSED"))

    def test_other_run_now_errors_raise_without_a_decision(self):
        fake = FakeDatabricks(run_now_error="POST failed with 403: PERMISSION_DENIED")
        with self.assertRaises(RuntimeError):
            self.trigger(fake, "--wait")
        self.assertNotIn("decision", read_outputs(self.output))


class RecordTriggerTest(unittest.TestCase):
    def record(self, argv, env=GITHUB_ENV, rpc=None):
        sent = []

        def fake_rpc(name, payload, timeout=60):
            sent.append((name, payload))
            return {"recorded": True, "id": 3}

        with mock.patch.dict(os.environ, {**env, "GITHUB_STEP_SUMMARY": ""}), \
                mock.patch.object(supabase_api, "rpc", rpc or fake_rpc):
            code, log = quiet(record_trigger.main, argv)
        return code, log, sent

    def test_payload(self):
        code, log, sent = self.record(["--decision", "no_new", "--uploaded", "3", "--new-files", "0",
                                       "--new-jobs", "0", "--run-id", "", "--result", "SKIPPED"])
        self.assertEqual(code, 0)
        self.assertEqual(len(sent), 1)
        name, payload = sent[0]
        self.assertEqual(name, "pipeline_record_trigger")
        report = payload["report"]
        self.assertRegex(report.pop("decided_at"), r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(report, {
            "format": "jobseeker.trigger_report.v1", "github_run_id": "987", "github_run_attempt": 2,
            "workflow": "ATS Scrapers", "event": "schedule", "decision": "no_new", "forced": False,
            "uploaded_files": 3, "new_files": 0, "new_jobs": 0, "run_id": None, "result": "SKIPPED", "message": None,
        })
        self.assertIn("[RECORDED] decision=no_new uploaded_files=3 new_files=0 new_jobs=0 result=SKIPPED (id 3)", log)

    def test_forced_and_bad_numbers(self):
        _, _, sent = self.record(["--decision", "started", "--forced", "--uploaded", "x", "--new-files", "-1",
                                  "--new-jobs", "2000000", "--run-id", "77", "--result", "SUCCESS"])
        report = sent[0][1]["report"]
        self.assertEqual((report["forced"], report["uploaded_files"], report["new_files"], report["new_jobs"],
                          report["run_id"]), (True, None, None, None, "77"))

    def test_empty_or_unknown_decision_is_failed(self):
        for decision in ("", "bogus"):
            with self.subTest(decision=decision):
                _, _, sent = self.record(["--decision", decision])
                report = sent[0][1]["report"]
                self.assertEqual((report["decision"], report["message"]), ("failed", record_trigger.FAILED_MESSAGE))
        _, _, sent = self.record(["--decision", "", "--message", "  checkout failed  "])
        self.assertEqual(sent[0][1]["report"]["message"], "checkout failed")

    def test_outside_actions(self):
        _, _, sent = self.record(["--decision", "started"], env={key: "" for key in GITHUB_ENV})
        report = sent[0][1]["report"]
        self.assertEqual((report["github_run_id"], report["github_run_attempt"], report["workflow"], report["event"]),
                         (None, None, None, None))

    def test_always_exits_0(self):
        def failing(*args, **kwargs):
            raise supabase_api.SupabaseError("pipeline_record_trigger failed with 404: function not found", 404)

        code, log, _ = self.record(["--decision", "no_new"], rpc=failing)
        self.assertEqual(code, 0)
        self.assertIn("::warning::Could not record the pipeline decision: SupabaseError", log)
        code, log, _ = self.record(["--uploaded"])  # argparse error: still 0
        self.assertEqual(code, 0)
        self.assertIn("::warning::Could not record the pipeline decision", log)

    def test_dry_run_sends_nothing(self):
        code, log, sent = self.record(["--decision", "paused", "--dry-run"])
        self.assertEqual((code, sent), (0, []))
        self.assertIn("[DRY RUN] would record decision=paused", log)

    def test_step_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "summary.md"
            with mock.patch.dict(os.environ, {**GITHUB_ENV, "GITHUB_STEP_SUMMARY": str(path)}):
                quiet(record_trigger.main, ["--decision", "no_new", "--uploaded", "3", "--new-files", "0",
                                            "--new-jobs", "0", "--dry-run"])
            self.assertEqual(path.read_text(encoding="utf-8"),
                             "**Pipeline decision:** Skipped: no new files · 3 files uploaded, 0 with new jobs (0 jobs)\n")
        self.assertEqual(set(record_trigger.LABELS), set(record_trigger.DECISIONS))


def sql_array(name, filename):
    text = (ROOT / "supabase" / filename).read_text(encoding="utf-8")
    match = re.search(rf"FUNCTION app\.{name}\(\)[^$]*\$\$\s*SELECT\s+ARRAY\[(.*?)\]", text, re.S)
    if not match:
        raise AssertionError(f"app.{name}() not found in {filename}")
    return tuple(re.findall(r"'([^']*)'", match.group(1)))


class ConstantsTest(unittest.TestCase):
    def test_decisions_match_the_sql(self):
        for filename in ("app_api.sql", "app_schema.sql"):
            with self.subTest(file=filename):
                self.assertEqual(record_trigger.DECISIONS, sql_array("c_trigger_decisions", filename))

    def test_idle_hours_match_the_sql_and_the_workflow(self):
        text = (ROOT / "supabase" / "app_api.sql").read_text(encoding="utf-8")
        match = re.search(r"FUNCTION app\.c_daily_floor_hours\(\)[^$]*\$\$\s*SELECT\s+(\d+)\s*\$\$", text)
        self.assertIsNotNone(match, "app.c_daily_floor_hours() not found")
        self.assertEqual(trigger_job.IDLE_HOURS, float(match.group(1)))
        self.assertIn("default=IDLE_HOURS", (HERE / "trigger_job.py").read_text(encoding="utf-8"))
        workflow = (ROOT / ".github" / "workflows" / "databricks-scrapers.yml").read_text(encoding="utf-8")
        self.assertEqual([float(hours) for hours in re.findall(r"--idle-hours (\d+)", workflow)], [trigger_job.IDLE_HOURS])

    def test_workflow_wiring(self):
        """The pieces a dry reading of the workflow relies on (a YAML parse runs too when PyYAML is installed)."""
        workflow = (ROOT / ".github" / "workflows" / "databricks-scrapers.yml").read_text(encoding="utf-8")
        action = (ROOT / ".github" / "actions" / "scrape-to-volume" / "action.yml").read_text(encoding="utf-8")
        for needle in ("force:", "type: boolean", "id: count", "id: trigger", "--no-new-files",
                       "python databricks/jobs/record_trigger.py", "decision: ${{ steps.trigger.outputs.decision }}"):
            self.assertIn(needle, workflow)
        self.assertEqual(workflow.count("id: scrape"), 3)
        self.assertEqual(workflow.count("new_files: ${{ steps.scrape.outputs.new_files }}"), 3)
        for name in ("uploaded", "new_files", "new_jobs"):
            self.assertIn(f"value: ${{{{ steps.upload.outputs.{name} || '0' }}}}", action)
        self.assertIn("id: upload", action)
        try:
            import yaml
        except ImportError:
            return
        for text in (workflow, action):
            self.assertIsInstance(yaml.safe_load(text), dict)

    def test_gold_writes_greenhouse_seen_keys(self):
        cells = json.loads((HERE.parent / "notebooks" / "04_gold_cleanup.ipynb").read_text(encoding="utf-8"))["cells"]
        code = "\n".join("".join(cell["source"]) for cell in cells if cell["cell_type"] == "code")
        self.assertIn('SEEN_KEY_SOURCES = ("workday", "greenhouse", *ATS_SOURCES)', code)


if __name__ == "__main__":
    unittest.main()
