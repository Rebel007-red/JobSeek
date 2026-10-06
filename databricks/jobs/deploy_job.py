"""Create or update the `JobSeeeker` pipeline job (jobs/jobseeker_pipeline.json) and the unscheduled `JobSeeker setup`
job (jobs/jobseeker_setup.json, runs 01_setup).

Usage:
    py databricks/jobs/deploy_job.py --import-notebooks --run-setup --notify-email you@example.com   # after notebook changes
    py databricks/jobs/deploy_job.py --notify-email you@example.com
    py databricks/jobs/deploy_job.py --dry-run           # print the resolved job settings only
    py databricks/jobs/deploy_job.py --run-now           # deploy and start a pipeline run

--import-notebooks  imports every databricks/notebooks/*.ipynb into the notebook folder (overwrites, creates the folder)
--run-setup         runs the setup job and waits for it, before the pipeline job is updated; fails (pipeline job untouched)
                    when it does not succeed

Jobs are matched by name; an existing job with that name is fully replaced by the JSON (jobs/reset).
Notebooks are expected in --notebook-dir, else DATABRICKS_NOTEBOOK_DIR, else /Workspace/Users/<you>/JobSeeker.
Uses DATABRICKS_HOST and DATABRICKS_TOKEN from the environment or .env (same as upload_to_volume.py).
"""
import argparse
import base64
import json
import re
import sys
import time
from pathlib import Path

from databricks_api import api, env, find_job_id, host

HERE = Path(__file__).resolve().parent
NOTEBOOK_SOURCE_DIR = HERE.parent / "notebooks"
PIPELINE_TEMPLATE = HERE / "jobseeker_pipeline.json"
SETUP_TEMPLATE = HERE / "jobseeker_setup.json"
# Notebooks the jobs run or %run; 00_capability_check is imported too but only run by hand
NOTEBOOKS = ["_common", "01_setup", "02_ingest_silver", "03_enrich", "04_gold_cleanup"]
SETUP_TIMEOUT_SECONDS = 1800
TERMINAL_STATES = {"TERMINATED", "SKIPPED", "INTERNAL_ERROR"}


def default_notebook_dir():
    configured = env("DATABRICKS_NOTEBOOK_DIR")
    if configured:
        return configured
    user = api("GET", "/api/2.0/preview/scim/v2/Me").get("userName")
    if not user:
        raise RuntimeError("Could not resolve the workspace user; pass --notebook-dir")
    return f"/Workspace/Users/{user}/JobSeeker"


def build_settings(template, notebook_dir, catalog, landing_path, notify_email):
    text = template.read_text(encoding="utf-8")
    for placeholder, value in {
        "{{NOTEBOOK_DIR}}": notebook_dir, "{{CATALOG}}": catalog,
        "{{LANDING_PATH}}": landing_path, "{{NOTIFY_EMAIL}}": notify_email or "",
    }.items():
        text = text.replace(placeholder, value)
    settings = json.loads(text)
    if not notify_email:
        settings.pop("email_notifications", None)
    unresolved = re.findall(r"\{\{(?!job\.)[A-Z_]+\}\}", json.dumps(settings))
    if unresolved:
        raise ValueError(f"Unresolved placeholders in {template.name}: {unresolved}")
    return settings


def local_notebooks():
    paths = sorted(NOTEBOOK_SOURCE_DIR.glob("*.ipynb"))
    missing = sorted(set(NOTEBOOKS) - {path.stem for path in paths})
    if missing:
        raise FileNotFoundError(f"Missing in {NOTEBOOK_SOURCE_DIR}: {missing}")
    return paths


def import_notebooks(notebook_dir):
    """Imports every local notebook (Jupyter format, overwrite) and warns about workspace notebooks no longer in the repo."""
    paths = local_notebooks()
    api("POST", "/api/2.0/workspace/mkdirs", json={"path": notebook_dir})
    for path in paths:
        api("POST", "/api/2.0/workspace/import", json={
            "path": f"{notebook_dir}/{path.stem}", "format": "JUPYTER", "overwrite": True,
            "content": base64.b64encode(path.read_bytes()).decode("ascii"),
        })
        print(f"[IMPORTED] {notebook_dir}/{path.stem}")
    local = {path.stem for path in paths}
    objects = api("GET", "/api/2.0/workspace/list", params={"path": notebook_dir}).get("objects", [])
    stale = sorted(
        obj["path"] for obj in objects
        if obj.get("object_type") == "NOTEBOOK" and obj["path"].rsplit("/", 1)[-1] not in local
    )
    if stale:
        print(f"[WARN] notebooks in {notebook_dir} that are no longer in the repo (delete them if unused): {stale}")


def check_notebooks(notebook_dir):
    missing = []
    for name in NOTEBOOKS:
        try:
            status = api("GET", "/api/2.0/workspace/get-status", params={"path": f"{notebook_dir}/{name}"})
            if status.get("object_type") != "NOTEBOOK":
                missing.append(f"{name} (is {status.get('object_type')})")
        except RuntimeError:
            missing.append(name)
    if missing:
        raise FileNotFoundError(f"Not found as notebooks under {notebook_dir}: {missing} (use --import-notebooks)")


def deploy(settings):
    job_id = find_job_id(settings["name"])
    if job_id:
        api("POST", "/api/2.2/jobs/reset", json={"job_id": job_id, "new_settings": settings})
        print(f"[UPDATED] job {settings['name']} id={job_id}")
    else:
        job_id = api("POST", "/api/2.2/jobs/create", json=settings)["job_id"]
        print(f"[CREATED] job {settings['name']} id={job_id}")
    return job_id


def run_and_wait(job_id, name, timeout_seconds):
    run_id = api("POST", "/api/2.2/jobs/run-now", json={"job_id": job_id})["run_id"]
    print(f"[RUN] {name} run_id={run_id} {host()}/jobs/{job_id}/runs/{run_id}")
    deadline = time.monotonic() + timeout_seconds
    while True:
        run = api("GET", "/api/2.2/jobs/runs/get", params={"run_id": run_id})
        state = run.get("state", {})
        if state.get("life_cycle_state") in TERMINAL_STATES:
            break
        if time.monotonic() > deadline:
            raise TimeoutError(f"{name} run {run_id} still {state.get('life_cycle_state')} after {timeout_seconds}s")
        time.sleep(15)
    result = state.get("result_state") or state.get("life_cycle_state")
    print(f"[{result}] {name} run_id={run_id} {state.get('state_message') or ''}".rstrip())
    if result != "SUCCESS":
        raise RuntimeError(f"{name} run {run_id} finished with {result}; see {run.get('run_page_url') or host()}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--notebook-dir", default=None, help="Workspace folder with the imported notebooks (default: DATABRICKS_NOTEBOOK_DIR or /Workspace/Users/<you>/JobSeeker)")
    parser.add_argument("--catalog", default="jobseeker")
    parser.add_argument("--landing-path", default="/Volumes/jobseeker/default/scrapes")
    parser.add_argument("--notify-email", default="", help="Email for failure notifications (optional)")
    parser.add_argument("--import-notebooks", action="store_true", help="Import databricks/notebooks/*.ipynb into the notebook folder first")
    parser.add_argument("--run-setup", action="store_true", help="Run the 'JobSeeker setup' job (01_setup) and wait for it")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--run-now", action="store_true", help="Start a pipeline run after deploying")
    args = parser.parse_args()

    notebook_dir = (args.notebook_dir or default_notebook_dir()).rstrip("/")
    if not notebook_dir.startswith(("/Workspace/", "/Users/", "/Shared/")):
        raise ValueError("--notebook-dir must be an absolute workspace path (/Workspace/..., /Users/... or /Shared/...)")
    if not re.fullmatch(r"[A-Za-z0-9_]+", args.catalog):
        raise ValueError(f"Invalid catalog: {args.catalog!r}")
    if not args.landing_path.startswith("/Volumes/"):
        raise ValueError("--landing-path must be a /Volumes/... path")

    landing_path = args.landing_path.rstrip("/")
    pipeline = build_settings(PIPELINE_TEMPLATE, notebook_dir, args.catalog, landing_path, args.notify_email)
    setup = build_settings(SETUP_TEMPLATE, notebook_dir, args.catalog, landing_path, args.notify_email)
    if args.dry_run:
        if args.import_notebooks:
            print(f"would import into {notebook_dir}: {[path.stem for path in local_notebooks()]}")
        print(json.dumps({"pipeline": pipeline, "setup": setup}, indent=2))
        return

    if args.import_notebooks:
        import_notebooks(notebook_dir)
    check_notebooks(notebook_dir)

    # Setup first: the new pipeline tasks stop until the setup marker exists, so keep that window short
    setup_job_id = deploy(setup)
    if args.run_setup:
        run_and_wait(setup_job_id, setup["name"], SETUP_TIMEOUT_SECONDS)
    pipeline_job_id = deploy(pipeline)

    if args.run_now:
        run_id = api("POST", "/api/2.2/jobs/run-now", json={"job_id": pipeline_job_id})["run_id"]
        print(f"[RUN] started {pipeline['name']} run_id={run_id}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
