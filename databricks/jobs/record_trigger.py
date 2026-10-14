"""Record the ATS Scrapers workflow's pipeline decision in Supabase (Settings > System, and the app's "Checked · no new
jobs" line).

Usage:
    python databricks/jobs/record_trigger.py --decision no_new --uploaded 3 --new-files 0 --new-jobs 0 --result SKIPPED
    python databricks/jobs/record_trigger.py --decision started --uploaded 3 --new-files 1 --new-jobs 12 \\
                                             --run-id 123 --result SUCCESS --forced
    python databricks/jobs/record_trigger.py --decision "" --dry-run     # print what would be sent; send nothing

--decision is what trigger_job.py wrote to $GITHUB_OUTPUT (DECISIONS). An empty or unknown one (trigger_job.py failed
before deciding, or never ran) is recorded as failed, with a message pointing to the workflow log unless --message is
given. Empty numbers are sent as null. The GitHub run (GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW,
GITHUB_EVENT_NAME) identifies the row: public.pipeline_record_trigger (service role only) replaces the row of the
same run and attempt and keeps the newest 50 (app.pipeline_triggers).

With $GITHUB_STEP_SUMMARY set it adds one line to the run summary. Prints the decision and the counts only. Always
exits 0, also before the SQL is applied (the RPC is missing then): recording must never fail the workflow (its step
also has continue-on-error). Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env or .env).
"""
import argparse
import os
import sys
from datetime import datetime, timezone

FORMAT = "jobseeker.trigger_report.v1"
# keep in sync: trigger_job.py decisions, app.c_trigger_decisions() in supabase/app_api.sql and app_schema.sql
# (test_trigger.py pins both)
DECISIONS = ("started", "started_daily", "waiting", "recent", "paused", "no_new", "failed")
FAILED_MESSAGE = "trigger_job.py ended without a decision (see the workflow log)"
MAX_COUNT = 1_000_000  # the RPC refuses larger counts
# Settings > System badge texts, for the run summary (keep in sync: src/components/settings/StatusPanel.jsx)
LABELS = {
    "started": "Started",
    "started_daily": "Started: daily run",
    "waiting": "Joined a waiting run",
    "recent": "Skipped: ran under 3 h ago",
    "paused": "Paused by Databricks",
    "no_new": "Skipped: no new files",
    "failed": "Failed",
}


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def count(value):
    """A workflow count as an int, or None when empty or not a whole number in 0..MAX_COUNT."""
    text = str(value or "").strip()
    if not text.isdigit():
        return None
    number = int(text)
    return number if number <= MAX_COUNT else None


def text_or_none(value, limit=200):
    text = str(value or "").strip()
    return text[:limit] or None


def build_report(args):
    decision = (args.decision or "").strip().lower()
    message = text_or_none(args.message, 1000)
    if decision not in DECISIONS:
        decision = "failed"
        message = message or FAILED_MESSAGE
    attempt = (os.getenv("GITHUB_RUN_ATTEMPT") or "").strip()
    return {
        "format": FORMAT,
        "github_run_id": text_or_none(os.getenv("GITHUB_RUN_ID")),
        "github_run_attempt": int(attempt) if attempt.isdigit() else None,
        "workflow": text_or_none(os.getenv("GITHUB_WORKFLOW")),
        "event": text_or_none(os.getenv("GITHUB_EVENT_NAME")),
        "decided_at": utc_now_iso(),
        "decision": decision,
        "forced": bool(args.forced),
        "uploaded_files": count(args.uploaded),
        "new_files": count(args.new_files),
        "new_jobs": count(args.new_jobs),
        "run_id": text_or_none(args.run_id),
        "result": text_or_none(args.result),
        "message": message,
    }


def summary(report):
    parts = [f"decision={report['decision']}"]
    parts += [f"{key}={report[key]}" for key in ("uploaded_files", "new_files", "new_jobs")]
    if report["forced"]:
        parts.append("forced")
    if report["run_id"]:
        parts.append(f"run_id={report['run_id']}")
    if report["result"]:
        parts.append(f"result={report['result']}")
    return " ".join(parts)


def step_summary(report):
    """One Markdown line for the GitHub run summary, in the words of Settings > System."""
    line = f"**Pipeline decision:** {LABELS[report['decision']]}"
    if report["uploaded_files"] is not None:
        line += (f" · {report['uploaded_files']} files uploaded, {report['new_files'] or 0} with new jobs "
                 f"({report['new_jobs'] or 0} jobs)")
    if report["forced"]:
        line += " · Forced by hand"
    if report["run_id"]:
        line += f" · Run {report['run_id']}" + (f" ({report['result']})" if report["result"] else "")
    return line


def write_step_summary(report):
    path = os.getenv("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(step_summary(report) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--decision", default="", help=f"trigger_job.py's decision ({', '.join(DECISIONS)}); "
                                                       "empty or unknown = failed")
    parser.add_argument("--uploaded", default="", help="Files uploaded by the scrapers")
    parser.add_argument("--new-files", default="", help="Uploaded files with at least one new job")
    parser.add_argument("--new-jobs", default="", help="New jobs in the uploaded files")
    parser.add_argument("--forced", action="store_true", help="A manual dispatch with force: true")
    parser.add_argument("--run-id", default="", help="The Databricks run started or waited for")
    parser.add_argument("--result", default="", help="trigger_job.py's result (SUCCESS, FAILED, TIMEOUT, SKIPPED, ...)")
    parser.add_argument("--message", default="", help="A note to store with the decision")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be sent; send nothing")

    try:
        args = parser.parse_args(argv)
        report = build_report(args)
        try:
            write_step_summary(report)
        except OSError as exc:
            print(f"[WARN] Could not write the step summary: {exc}")
        if args.dry_run:
            print(f"[DRY RUN] would record {summary(report)}")
            return 0
        from supabase_api import rpc  # here, so a missing dependency is a warning like any other error

        result = rpc("pipeline_record_trigger", {"report": report}) or {}
        print(f"[RECORDED] {summary(report)} (id {result.get('id')})")
    except SystemExit as exc:  # argparse errors: still never fail the workflow
        if exc.code not in (0, None):
            print("::warning::Could not record the pipeline decision: bad arguments")
    except Exception as exc:
        # The error text never contains the key
        print(f"::warning::Could not record the pipeline decision: {type(exc).__name__}: {str(exc)[:300]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
