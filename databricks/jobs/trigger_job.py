"""Start the JobSeeeker Databricks job after new CSVs were uploaded to the landing volume, optionally waiting for it.

Usage:
    python databricks/jobs/trigger_job.py                          # job name "JobSeeeker"
    python databricks/jobs/trigger_job.py --job-name Other
    python databricks/jobs/trigger_job.py --min-interval-hours 3   # or PIPELINE_MIN_INTERVAL_HOURS=3
    python databricks/jobs/trigger_job.py --wait --wait-timeout-minutes 100 --poll-seconds 30

Skips starting a run when one is already waiting to start (QUEUED / PENDING / BLOCKED): that run has not ingested yet,
so it will pick up the new files anyway. A RUNNING job may already be past ingestion, so a new run is queued behind it
(the job has max_concurrent_runs = 1 and queueing enabled).
With --min-interval-hours N > 0 it also skips when the latest run (any state) started less than N hours ago, so manual
workflow dispatches don't double the scheduled runs; skipped files are ingested by the next run (Auto Loader).

--wait polls the run until it ends: the run it started; or, when skipped because a run is waiting, that run; or, when
skipped by --min-interval-hours, the newest active run (nothing to wait for = exit 0). A run QUEUED behind a RUNNING
one is normal. SUCCESS exits 0, any other result exits 1 (with the run page URL); hitting --wait-timeout-minutes prints
a ::warning:: and exits 0 (the hourly publish-supabase workflow picks the run up later). With $GITHUB_OUTPUT set,
appends run_id=... and result=... (SUCCESS / FAILED / TIMEDOUT / ... / TIMEOUT / NONE).
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


def write_output(**values):
    path = os.getenv("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={'' if value is None else value}\n")


def start_or_find_run(args, job_id):
    """Returns (run_id to wait for or None, how it was chosen)."""
    active_runs = api("GET", "/api/2.2/jobs/runs/list", params={"job_id": job_id, "active_only": "true"}).get("runs", [])
    waiting = [run for run in active_runs if run.get("state", {}).get("life_cycle_state") in WAITING_STATES]
    if waiting:
        print(f"[SKIP] job {args.job_name} id={job_id} already has a run waiting to start (run_id={waiting[0]['run_id']})")
        return waiting[0]["run_id"], "waiting"

    if args.min_interval_hours > 0:
        # runs/list returns the newest run first
        latest = api("GET", "/api/2.2/jobs/runs/list", params={"job_id": job_id, "limit": 1}).get("runs", [])
        if latest and latest[0].get("start_time"):
            age_hours = (time.time() * 1000 - latest[0]["start_time"]) / 3_600_000
            if age_hours < args.min_interval_hours:
                print(f"[SKIP] job {args.job_name} id={job_id}: latest run {latest[0]['run_id']} started {age_hours:.1f} h ago "
                      f"(< {args.min_interval_hours:g} h); the next run ingests the new files")
                return (active_runs[0]["run_id"], "active") if active_runs else (None, "none")

    run_id = api("POST", "/api/2.2/jobs/run-now", json={"job_id": job_id})["run_id"]
    print(f"[RUN] job {args.job_name} id={job_id} run_id={run_id} ({len(active_runs)} active before) {host()}/jobs/{job_id}/runs/{run_id}")
    return run_id, "started"


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


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--job-name", default=env("DATABRICKS_JOB_NAME") or "JobSeeeker")
    parser.add_argument("--min-interval-hours", type=float, default=float(env("PIPELINE_MIN_INTERVAL_HOURS") or 0),
                        help="Skip when the latest run started less than N hours ago (default: PIPELINE_MIN_INTERVAL_HOURS or 0 = off)")
    parser.add_argument("--wait", action="store_true", help="Wait for the run to finish (exit 1 unless it succeeds)")
    parser.add_argument("--wait-timeout-minutes", type=float, default=100,
                        help="Stop waiting after N minutes with a warning and exit 0 (default 100)")
    parser.add_argument("--poll-seconds", type=float, default=30, help="Seconds between status checks (default 30)")
    args = parser.parse_args()
    if args.poll_seconds <= 0 or args.wait_timeout_minutes <= 0:
        raise ValueError("--poll-seconds and --wait-timeout-minutes must be > 0")

    job_id = find_job_id(args.job_name)
    if not job_id:
        raise RuntimeError(f"No Databricks job named {args.job_name!r}; deploy it with databricks/jobs/deploy_job.py")

    run_id, chosen = start_or_find_run(args, job_id)
    if not args.wait:
        write_output(run_id=run_id, result="STARTED" if chosen == "started" else "NONE")
        return 0
    if run_id is None:
        print("[WAIT] no active run to wait for")
        write_output(run_id="", result="NONE")
        return 0

    print(f"[WAIT] waiting for run_id={run_id} ({chosen}), timeout {args.wait_timeout_minutes:g} min, poll {args.poll_seconds:g} s")
    result, url, message = wait_for_run(run_id, job_id, args.wait_timeout_minutes, args.poll_seconds)
    write_output(run_id=run_id, result=result)
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
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
