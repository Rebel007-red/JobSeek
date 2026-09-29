"""Start the JobSeeeker Databricks job after new CSVs were uploaded to the landing volume.

Usage:
    python databricks/jobs/trigger_job.py                  # job name "JobSeeeker"
    python databricks/jobs/trigger_job.py --job-name Other

Skips starting a run when one is already waiting to start (QUEUED / PENDING / BLOCKED): that run has not ingested yet,
so it will pick up the new files anyway. A RUNNING job may already be past ingestion, so a new run is queued behind it
(the job has max_concurrent_runs = 1 and queueing enabled).
Uses DATABRICKS_HOST and DATABRICKS_TOKEN from the environment or .env.
"""
import argparse
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")
load_dotenv(HERE.parents[1] / ".env")

WAITING_STATES = {"QUEUED", "PENDING", "BLOCKED"}


def api(method, path, **kwargs):
    host = (os.getenv("DATABRICKS_HOST") or "").strip().strip('"').rstrip("/")
    token = (os.getenv("DATABRICKS_TOKEN") or "").strip().strip('"')
    if not host or not token:
        raise EnvironmentError("DATABRICKS_HOST and DATABRICKS_TOKEN must be set")
    response = requests.request(method, f"{host}{path}", headers={"Authorization": f"Bearer {token}"}, timeout=60, **kwargs)
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {path} failed with {response.status_code}: {response.text[:500]}")
    return response.json() if response.content else {}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--job-name", default=os.getenv("DATABRICKS_JOB_NAME") or "JobSeeeker")
    args = parser.parse_args()

    jobs = api("GET", "/api/2.2/jobs/list", params={"name": args.job_name}).get("jobs", [])
    if len(jobs) != 1:
        raise RuntimeError(f"Expected exactly 1 job named {args.job_name!r}, found {len(jobs)}")
    job_id = jobs[0]["job_id"]

    active_runs = api("GET", "/api/2.2/jobs/runs/list", params={"job_id": job_id, "active_only": "true"}).get("runs", [])
    waiting = [run for run in active_runs if run.get("state", {}).get("life_cycle_state") in WAITING_STATES]
    if waiting:
        print(f"[SKIP] job {args.job_name} id={job_id} already has a run waiting to start (run_id={waiting[0]['run_id']})")
        return

    run_id = api("POST", "/api/2.2/jobs/run-now", json={"job_id": job_id})["run_id"]
    host = (os.getenv("DATABRICKS_HOST") or "").strip().strip('"').rstrip("/")
    print(f"[RUN] job {args.job_name} id={job_id} run_id={run_id} ({len(active_runs)} active before) {host}/jobs/{job_id}/runs/{run_id}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
