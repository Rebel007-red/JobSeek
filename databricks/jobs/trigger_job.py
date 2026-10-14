"""Start the JobSeeeker Databricks job after new CSVs were uploaded to the landing volume, optionally waiting for it.

Usage:
    python databricks/jobs/trigger_job.py                          # job name "JobSeeeker"
    python databricks/jobs/trigger_job.py --job-name Other
    python databricks/jobs/trigger_job.py --min-interval-hours 3   # or PIPELINE_MIN_INTERVAL_HOURS=3
    python databricks/jobs/trigger_job.py --wait --wait-timeout-minutes 100 --poll-seconds 30
    python databricks/jobs/trigger_job.py --no-new-files --idle-hours 20 --wait   # the upload found no new job

Skips starting a run when one is already waiting to start (QUEUED / PENDING / BLOCKED): that run has not ingested yet,
so it will pick up the new files anyway. A RUNNING job may already be past ingestion, so a new run is queued behind it
(the job has max_concurrent_runs = 1 and queueing enabled).
With --min-interval-hours N > 0 it also skips when the latest run (any state) started less than N hours ago, so manual
workflow dispatches don't double the scheduled runs; skipped files are ingested by the next run (Auto Loader).

--no-new-files (the ATS Scrapers workflow passes it when upload_to_volume.py counted no new job) saves the compute of a
run that would only re-read jobs the pipeline already has: it starts no run while one is active (any state; nothing is
waited for), nor when the newest run started less than --idle-hours ago (default 20; keep in sync:
app.c_daily_floor_hours() in supabase/app_api.sql). Otherwise it starts the daily run, so expiry, the deletion of
week-old jobs and the daily retention still happen on a quiet day. A latest run that ended FAILED / TIMEDOUT /
INTERNAL_ERROR is retried at once (decision started_daily): it may have written the seen keys without publishing.

--wait polls the run until it ends: the run it started; or, when skipped because a run is waiting, that run; or, when
skipped by --min-interval-hours, the newest active run (nothing to wait for = exit 0). A run QUEUED behind a RUNNING
one is normal. SUCCESS exits 0, any other result exits 1 (with the run page URL); hitting --wait-timeout-minutes prints
a ::warning:: and exits 0 (the hourly publish-supabase workflow picks the run up later).
Databricks pausing new runs (FEATURE_DISABLED, Free Edition over its allowance) is a warning and exit 0, not a failure.

With $GITHUB_OUTPUT set, appends decision=... and run_id=... as soon as the decision is made, and result=... when it
is known. decision (keep in sync: record_trigger.py DECISIONS, app.c_trigger_decisions()): started (a new run),
started_daily (no new jobs, but the daily run was due), waiting (joined a run waiting to start), recent (skipped by
--min-interval-hours), paused (FEATURE_DISABLED), no_new (no new jobs and no daily run due). result: SUCCESS / FAILED /
TIMEDOUT / ... / TIMEOUT (the wait gave up) / NONE (nothing to wait for) / STARTED (no --wait) / PAUSED / SKIPPED
(no_new) / ERROR (this script failed after deciding). An error before a decision writes none; the workflow then records
the decision as failed.
Uses DATABRICKS_HOST and DATABRICKS_TOKEN from the environment or .env.
"""
import argparse
import os
import sys
import time

from databricks_api import api, env, find_job_id, host

WAITING_STATES = {"QUEUED", "PENDING", "BLOCKED"}
TERMINAL_STATES = {"TERMINATED", "SKIPPED", "INTERNAL_ERROR"}
MAX_POLL_ERRORS = 5  # consecutive failed runs/get calls before giving up
# --idle-hours default: with no new jobs, the daily run is due this long after the latest run started
# (keep in sync: app.c_daily_floor_hours() in supabase/app_api.sql; test_trigger.py pins it)
IDLE_HOURS = 20.0
# --no-new-files: a latest run that ended like this is run again (not CANCELED: someone stopped it on purpose)
RETRY_RESULTS = {"FAILED", "TIMEDOUT", "INTERNAL_ERROR"}


def write_output(**values):
    path = os.getenv("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={'' if value is None else value}\n")


def latest_run_age_hours(job_id):
    """(newest run, hours since it started) of the job; (None, None) without a run, hours None without a start time."""
    # runs/list returns the newest run first
    latest = api("GET", "/api/2.2/jobs/runs/list", params={"job_id": job_id, "limit": 1}).get("runs", [])
    if not latest:
        return None, None
    start_time = latest[0].get("start_time")
    return latest[0], ((time.time() * 1000 - start_time) / 3_600_000 if start_time else None)


def run_now(args, job_id, active_count, decision):
    """Starts a run: (run_id, decision), or (None, 'paused') while Databricks accepts no new runs."""
    try:
        run_id = api("POST", "/api/2.2/jobs/run-now", json={"job_id": job_id})["run_id"]
    except RuntimeError as exc:
        # Free Edition pauses new runs account-wide (e.g. over its compute allowance): not a scraper failure.
        # The uploaded files stay on the volume and the next allowed run ingests them (Auto Loader).
        if "FEATURE_DISABLED" not in str(exc):
            raise
        print(f"::warning::Databricks is not accepting new runs right now (FEATURE_DISABLED); the uploaded files are "
              f"kept and ingested by the next run. {str(exc)[:200]}")
        return None, "paused"
    print(f"[RUN] job {args.job_name} id={job_id} run_id={run_id} ({active_count} active before) {host()}/jobs/{job_id}/runs/{run_id}")
    return run_id, decision


def start_if_due(args, job_id):
    """--no-new-files: (None, 'no_new') unless the daily run is due, else the started run (run_id, 'started_daily')."""
    active_runs = api("GET", "/api/2.2/jobs/runs/list", params={"job_id": job_id, "active_only": "true"}).get("runs", [])
    if active_runs:
        # Whatever state it is in, it ingests what is on the volume (or already did): nothing to start or wait for
        state = active_runs[0].get("state", {}).get("life_cycle_state") or "active"
        print(f"[SKIP] no new jobs in this scrape; run {active_runs[0]['run_id']} is {state}, so no run is started")
        return None, "no_new"
    latest, age_hours = latest_run_age_hours(job_id)
    # A run that failed after 04_gold_cleanup wrote the seen keys leaves its new jobs "seen" but never published: the
    # next scrape finds no new job, so without this retry they would wait for the daily run
    failed = (latest or {}).get("state", {}).get("result_state") in RETRY_RESULTS
    if age_hours is not None and age_hours < args.idle_hours and not failed:
        print(f"[SKIP] no new jobs in this scrape; the latest run started {age_hours:.1f} h ago "
              f"(< {args.idle_hours:g} h), so the daily run is not due")
        return None, "no_new"
    since = "there is no earlier run" if latest is None else (
        f"the latest run ended {latest['state']['result_state']}, so it runs again" if failed else
        "the latest run has no start time" if age_hours is None else f"the latest run started {age_hours:.1f} h ago")
    print(f"[RUN] daily run: no new jobs, but {since}")
    return run_now(args, job_id, 0, "started_daily")


def start_or_find_run(args, job_id):
    """Returns (run_id to wait for or None, decision): started / waiting / recent / paused, or with --no-new-files
    no_new / started_daily / paused."""
    if args.no_new_files:
        return start_if_due(args, job_id)

    active_runs = api("GET", "/api/2.2/jobs/runs/list", params={"job_id": job_id, "active_only": "true"}).get("runs", [])
    waiting = [run for run in active_runs if run.get("state", {}).get("life_cycle_state") in WAITING_STATES]
    if waiting:
        print(f"[SKIP] job {args.job_name} id={job_id} already has a run waiting to start (run_id={waiting[0]['run_id']})")
        return waiting[0]["run_id"], "waiting"

    if args.min_interval_hours > 0:
        latest, age_hours = latest_run_age_hours(job_id)
        if age_hours is not None and age_hours < args.min_interval_hours:
            print(f"[SKIP] job {args.job_name} id={job_id}: latest run {latest['run_id']} started {age_hours:.1f} h ago "
                  f"(< {args.min_interval_hours:g} h); the next run ingests the new files")
            # waits for the newest active run, if any
            return (active_runs[0]["run_id"] if active_runs else None), "recent"

    return run_now(args, job_id, len(active_runs), "started")


def wait_for_run(run_id, job_id, timeout_minutes, poll_seconds):
    """Polls runs/get until the run ends. Returns the result state, or 'TIMEOUT'."""
    deadline = time.monotonic() + timeout_minutes * 60
    started = time.monotonic()
    last_state, errors, run = None, 0, {}
    while True:
        try:
            run = api("GET", "/api/2.2/jobs/runs/get", params={"run_id": run_id})
            errors = 0
        except Exception as exc:  # transient API / network errors: keep polling for a while
            errors += 1
            print(f"[WARN] runs/get failed ({errors}/{MAX_POLL_ERRORS}): {str(exc)[:200]}")
            if errors >= MAX_POLL_ERRORS:
                raise
        else:
            state = run.get("state", {})
            life_cycle = state.get("life_cycle_state")
            label = f"{life_cycle}/{state.get('result_state') or '-'}"
            if label != last_state:
                note = " (queued behind a running run: normal)" if life_cycle == "QUEUED" else ""
                print(f"[STATE] run_id={run_id} {label} after {(time.monotonic() - started) / 60:.1f} min{note}")
                last_state = label
            if life_cycle in TERMINAL_STATES:
                result = state.get("result_state") or life_cycle
                url = run.get("run_page_url") or f"{host()}/jobs/{job_id}/runs/{run_id}"
                return result, url, state.get("state_message") or ""
        if time.monotonic() + poll_seconds > deadline:
            return "TIMEOUT", run.get("run_page_url") or f"{host()}/jobs/{job_id}/runs/{run_id}", ""
        time.sleep(poll_seconds)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--job-name", default=env("DATABRICKS_JOB_NAME") or "JobSeeeker")
    parser.add_argument("--min-interval-hours", type=float, default=float(env("PIPELINE_MIN_INTERVAL_HOURS") or 0),
                        help="Skip when the latest run started less than N hours ago (default: PIPELINE_MIN_INTERVAL_HOURS or 0 = off)")
    parser.add_argument("--no-new-files", action="store_true",
                        help="The upload found no new job: start a run only when none is active and the latest started "
                             "--idle-hours or more ago (the daily run)")
    parser.add_argument("--idle-hours", type=float, default=IDLE_HOURS,
                        help=f"With --no-new-files: hours after the latest run start when the daily run is due (default {IDLE_HOURS:g})")
    parser.add_argument("--wait", action="store_true", help="Wait for the run to finish (exit 1 unless it succeeds)")
    parser.add_argument("--wait-timeout-minutes", type=float, default=100,
                        help="Stop waiting after N minutes with a warning and exit 0 (default 100)")
    parser.add_argument("--poll-seconds", type=float, default=30, help="Seconds between status checks (default 30)")
    args = parser.parse_args(argv)
    if args.poll_seconds <= 0 or args.wait_timeout_minutes <= 0:
        raise ValueError("--poll-seconds and --wait-timeout-minutes must be > 0")
    if args.idle_hours < 0:
        raise ValueError("--idle-hours must be >= 0")

    job_id = find_job_id(args.job_name)
    if not job_id:
        raise RuntimeError(f"No Databricks job named {args.job_name!r}; deploy it with databricks/jobs/deploy_job.py")

    run_id, decision = start_or_find_run(args, job_id)
    # Written now, so a run that was started is recorded as started even if the wait below fails
    write_output(decision=decision, run_id=run_id)
    if decision == "paused":
        write_output(result="PAUSED")
        return 0
    if decision == "no_new":
        write_output(result="SKIPPED")
        return 0
    if not args.wait:
        write_output(result="STARTED" if decision in ("started", "started_daily") else "NONE")
        return 0
    if run_id is None:
        print("[WAIT] no active run to wait for")
        write_output(result="NONE")
        return 0

    print(f"[WAIT] waiting for run_id={run_id} ({decision}), timeout {args.wait_timeout_minutes:g} min, poll {args.poll_seconds:g} s")
    result, url, message = wait_for_run(run_id, job_id, args.wait_timeout_minutes, args.poll_seconds)
    write_output(result=result)
    if result == "TIMEOUT":
        print(f"::warning::Databricks run {run_id} still running after {args.wait_timeout_minutes:g} min; "
              f"the hourly publish-supabase workflow publishes it once it finishes ({url})")
        return 0
    if result == "SUCCESS":
        print(f"[SUCCESS] run_id={run_id} {url}")
        return 0
    print(" ".join(part for part in (f"[{result}] run_id={run_id}", message[:300], url) if part), file=sys.stderr)
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # After a decision this marks the result (the decision stays); before one the workflow records "failed"
        write_output(result="ERROR")
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
