"""Minimal Databricks REST client shared by deploy_job.py and trigger_job.py.

Uses DATABRICKS_HOST and DATABRICKS_TOKEN from the environment, databricks/.env or the repo-root .env.
"""
import os
from pathlib import Path

import requests
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")
load_dotenv(HERE.parents[1] / ".env")


def env(name):
    return (os.getenv(name) or "").strip().strip('"')


def host():
    return env("DATABRICKS_HOST").rstrip("/")


def api(method, path, **kwargs):
    token = env("DATABRICKS_TOKEN")
    if not host() or not token:
        raise EnvironmentError("DATABRICKS_HOST and DATABRICKS_TOKEN must be set")
    response = requests.request(method, f"{host()}{path}", headers={"Authorization": f"Bearer {token}"}, timeout=60, **kwargs)
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {path} failed with {response.status_code}: {response.text[:500]}")
    return response.json() if response.content else {}


def find_job_id(job_name):
    """The id of the single job with this name (the Jobs API allows duplicates, we don't)."""
    jobs = api("GET", "/api/2.2/jobs/list", params={"name": job_name}).get("jobs", [])
    if len(jobs) > 1:
        raise RuntimeError(f"{len(jobs)} jobs named {job_name!r}; delete the duplicates first")
    return jobs[0]["job_id"] if jobs else None
