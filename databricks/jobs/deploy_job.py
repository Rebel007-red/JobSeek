"""Create or update the `JobSeeeker` Databricks job from jobs/jobseeker_pipeline.json.

Usage:
    py databricks/jobs/deploy_job.py --notify-email you@example.com
    py databricks/jobs/deploy_job.py --dry-run      # print the resolved job settings only
    py databricks/jobs/deploy_job.py --run-now      # deploy and start a run

The job is matched by name; an existing job with that name is fully replaced by the JSON (jobs/reset).
Uses DATABRICKS_HOST and DATABRICKS_TOKEN from the environment or .env (same as upload_to_volume.py).
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")
load_dotenv(HERE.parents[1] / ".env")

TEMPLATE = HERE / "jobseeker_pipeline.json"
DEFAULT_NOTEBOOK_DIR = "/Workspace/Users/udaykirans6101@gmail.com/JobSeeker"
NOTEBOOKS = ["_common", "01_setup", "02_bronze_ingest", "03_silver_transform", "04_enrich", "05_gold_merge", "06_cleanup"]


def api(method, path, **kwargs):
    host = (os.getenv("DATABRICKS_HOST") or "").strip().strip('"').rstrip("/")
    token = (os.getenv("DATABRICKS_TOKEN") or "").strip().strip('"')
    if not host or not token:
        raise EnvironmentError("DATABRICKS_HOST and DATABRICKS_TOKEN must be set")
    response = requests.request(method, f"{host}{path}", headers={"Authorization": f"Bearer {token}"}, timeout=60, **kwargs)
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {path} failed with {response.status_code}: {response.text[:500]}")
    return response.json() if response.content else {}


def build_settings(notebook_dir, catalog, landing_path, notify_email):
    text = TEMPLATE.read_text(encoding="utf-8")
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
        raise ValueError(f"Unresolved placeholders: {unresolved}")
    return settings


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
        raise FileNotFoundError(f"Not found as notebooks under {notebook_dir}: {missing}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--notebook-dir", default=DEFAULT_NOTEBOOK_DIR, help=f"Workspace folder with the imported notebooks (default {DEFAULT_NOTEBOOK_DIR})")
    parser.add_argument("--catalog", default="jobseeker")
    parser.add_argument("--landing-path", default="/Volumes/jobseeker/default/scrapes")
    parser.add_argument("--notify-email", default="", help="Email for failure notifications (optional)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--run-now", action="store_true")
    args = parser.parse_args()

    notebook_dir = args.notebook_dir.rstrip("/")
    if not notebook_dir.startswith(("/Workspace/", "/Users/", "/Shared/")):
        raise ValueError("--notebook-dir must be an absolute workspace path (/Workspace/..., /Users/... or /Shared/...)")
    if not re.fullmatch(r"[A-Za-z0-9_]+", args.catalog):
        raise ValueError(f"Invalid catalog: {args.catalog!r}")
    if not args.landing_path.startswith("/Volumes/"):
        raise ValueError("--landing-path must be a /Volumes/... path")

    settings = build_settings(notebook_dir, args.catalog, args.landing_path.rstrip("/"), args.notify_email)
    if args.dry_run:
        print(json.dumps(settings, indent=2))
        return

    check_notebooks(notebook_dir)

    existing = api("GET", "/api/2.2/jobs/list", params={"name": settings["name"]}).get("jobs", [])
    if len(existing) > 1:
        raise RuntimeError(f"{len(existing)} jobs named {settings['name']!r}; delete the duplicates first")
    if existing:
        job_id = existing[0]["job_id"]
        api("POST", "/api/2.2/jobs/reset", json={"job_id": job_id, "new_settings": settings})
        print(f"[UPDATED] job {settings['name']} id={job_id}")
    else:
        job_id = api("POST", "/api/2.2/jobs/create", json=settings)["job_id"]
        print(f"[CREATED] job {settings['name']} id={job_id}")

    if args.run_now:
        run_id = api("POST", "/api/2.2/jobs/run-now", json={"job_id": job_id})["run_id"]
        print(f"[RUN] started run_id={run_id}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
