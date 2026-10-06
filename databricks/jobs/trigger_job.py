"""Start the JobSeeeker Databricks job after new CSVs were uploaded to the landing volume.

Usage:
    python databricks/jobs/trigger_job.py                          # job name "JobSeeeker"
    python databricks/jobs/trigger_job.py --job-name Other
    python databricks/jobs/trigger_job.py --min-interval-hours 3   # or PIPELINE_MIN_INTERVAL_HOURS=3

Skips starting a run when one is already waiting to start (QUEUED / PENDING / BLOCKED): that run has not ingested yet,
so it will pick up the new files anyway. A RUNNING job may already be past ingestion, so a new run is queued behind it
(the job has max_concurrent_runs = 1 and queueing enabled).
With --min-interval-hours N > 0 it also skips when the latest run (any state) started less than N hours ago, so manual
workflow dispatches don't double the scheduled runs; skipped files are ingested by the next run (Auto Loader).
Uses DATABRICKS_HOST and DATABRICKS_TOKEN from the environment or .env.
"""
import argparse
import sys
import time

from databricks_api import api, env, find_job_id, host

WAITING_STATES = {"QUEUED", "PENDING", "BLOCKED"}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--job-name", default=env("DATABRICKS_JOB_NAME") or "JobSeeeker")
    parser.add_argument("--min-interval-hours", type=float, default=float(env("PIPELINE_MIN_INTERVAL_HOURS") or 0),
                        help="Skip when the latest run started less than N hours ago (default: PIPELINE_MIN_INTERVAL_HOURS or 0 = off)")
    args = parser.parse_args()

    job_id = find_job_id(args.job_name)
    if not job_id:
        raise RuntimeError(f"No Databricks job named {args.job_name!r}; deploy it with databricks/jobs/deploy_job.py")

    active_runs = api("GET", "/api/2.2/jobs/runs/list", params={"job_id": job_id, "active_only": "true"}).get("runs", [])
    waiting = [run for run in active_runs if run.get("state", {}).get("life_cycle_state") in WAITING_STATES]
    if waiting:
        print(f"[SKIP] job {args.job_name} id={job_id} already has a run waiting to start (run_id={waiting[0]['run_id']})")
        return

    if args.min_interval_hours > 0:
        # runs/list returns the newest run first
        latest = api("GET", "/api/2.2/jobs/runs/list", params={"job_id": job_id, "limit": 1}).get("runs", [])
        if latest and latest[0].get("start_time"):
            age_hours = (time.time() * 1000 - latest[0]["start_time"]) / 3_600_000
            if age_hours < args.min_interval_hours:
                print(f"[SKIP] job {args.job_name} id={job_id}: latest run {latest[0]['run_id']} started {age_hours:.1f} h ago "
                      f"(< {args.min_interval_hours:g} h); the next run ingests the new files")
                return

    run_id = api("POST", "/api/2.2/jobs/run-now", json={"job_id": job_id})["run_id"]
    print(f"[RUN] job {args.job_name} id={job_id} run_id={run_id} ({len(active_runs)} active before) {host()}/jobs/{job_id}/runs/{run_id}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
