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
import sys

from databricks_api import api, env, find_job_id, host

WAITING_STATES = {"QUEUED", "PENDING", "BLOCKED"}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--job-name", default=env("DATABRICKS_JOB_NAME") or "JobSeeeker")
    args = parser.parse_args()

    job_id = find_job_id(args.job_name)
    if not job_id:
        raise RuntimeError(f"No Databricks job named {args.job_name!r}; deploy it with databricks/jobs/deploy_job.py")

    active_runs = api("GET", "/api/2.2/jobs/runs/list", params={"job_id": job_id, "active_only": "true"}).get("runs", [])
    waiting = [run for run in active_runs if run.get("state", {}).get("life_cycle_state") in WAITING_STATES]
    if waiting:
        print(f"[SKIP] job {args.job_name} id={job_id} already has a run waiting to start (run_id={waiting[0]['run_id']})")
        return

    run_id = api("POST", "/api/2.2/jobs/run-now", json={"job_id": job_id})["run_id"]
    print(f"[RUN] job {args.job_name} id={job_id} run_id={run_id} ({len(active_runs)} active before) {host()}/jobs/{job_id}/runs/{run_id}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
