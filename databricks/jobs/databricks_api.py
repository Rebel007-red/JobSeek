"""Minimal Databricks REST client shared by deploy_job.py, trigger_job.py, sync_user_data.py, publish_to_supabase.py
and ../upload_to_volume.py.

Uses DATABRICKS_HOST and DATABRICKS_TOKEN from the environment, databricks/.env or the repo-root .env.
Files API helpers (files_get / files_put / files_list / dirs_create) read and write Unity Catalog volume paths
(/Volumes/<catalog>/<schema>/<volume>/...); they never log file contents.
"""
import os
import time
from pathlib import Path
from urllib.parse import quote

import requests
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")
load_dotenv(HERE.parents[1] / ".env")

FILES_ATTEMPTS = 3


def env(name):
    return (os.getenv(name) or "").strip().strip('"')


def host():
    return env("DATABRICKS_HOST").rstrip("/")


def auth_headers():
    token = env("DATABRICKS_TOKEN")
    if not host() or not token:
        raise EnvironmentError("DATABRICKS_HOST and DATABRICKS_TOKEN must be set")
    return {"Authorization": f"Bearer {token}"}


def api(method, path, **kwargs):
    response = requests.request(method, f"{host()}{path}", headers=auth_headers(), timeout=60, **kwargs)
    if response.status_code >= 400:
        raise RuntimeError(f"{method} {path} failed with {response.status_code}: {response.text[:500]}")
    return response.json() if response.content else {}


def find_job_id(job_name):
    """The id of the single job with this name (the Jobs API allows duplicates, we don't)."""
    jobs = api("GET", "/api/2.2/jobs/list", params={"name": job_name}).get("jobs", [])
    if len(jobs) > 1:
        raise RuntimeError(f"{len(jobs)} jobs named {job_name!r}; delete the duplicates first")
    return jobs[0]["job_id"] if jobs else None


# --- Files API (volumes) ---


def _volume_path(path):
    if not path.startswith("/Volumes/") or ".." in path.split("/"):
        raise ValueError(f"Not a volume path: {path}")
    return quote(path.rstrip("/") or "/", safe="/")


def _files_request(method, endpoint, path, ok_statuses, timeout=120, **kwargs):
    """One Files API call with up to FILES_ATTEMPTS tries on 5xx / 429 / network errors.
    Returns the response when its status is in ok_statuses or is 404; raises otherwise."""
    url = f"{host()}{endpoint}{_volume_path(path)}"
    headers = {**auth_headers(), **kwargs.pop("headers", {})}
    error = ""
    for attempt in range(1, FILES_ATTEMPTS + 1):
        try:
            response = requests.request(method, url, headers=headers, timeout=timeout, **kwargs)
        except requests.RequestException as exc:
            error = f"{type(exc).__name__}: {exc}"
        else:
            if response.status_code in ok_statuses or response.status_code == 404:
                return response
            error = f"status {response.status_code}: {response.text[:300]}"
            if response.status_code < 500 and response.status_code != 429:
                break  # auth / bad path: a retry will not help
        if attempt < FILES_ATTEMPTS:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"{method} {endpoint}{path} failed with {error}")


def files_get(path):
    """Contents of a volume file as bytes, or None when it does not exist."""
    response = _files_request("GET", "/api/2.0/fs/files", path, {200}, timeout=300)
    return None if response.status_code == 404 else response.content


def files_put(path, data: bytes):
    """Writes (overwrites) a volume file; parent directories are created by the API."""
    response = _files_request("PUT", "/api/2.0/fs/files", path, {200, 201, 204}, timeout=300,
                              params={"overwrite": "true"}, data=data,
                              headers={"Content-Type": "application/octet-stream"})
    if response.status_code == 404:
        raise RuntimeError(f"PUT {path} failed with 404 (volume missing?)")


def files_list(directory):
    """Entries of a volume directory (dicts with path, name, is_directory, file_size, last_modified);
    [] when the directory does not exist. Follows page_token."""
    entries, page_token = [], None
    while True:
        params = {"page_token": page_token} if page_token else {}
        response = _files_request("GET", "/api/2.0/fs/directories", directory, {200}, params=params)
        if response.status_code == 404:
            return entries
        body = response.json() if response.content else {}
        entries.extend(body.get("contents", []))
        page_token = body.get("next_page_token")
        if not page_token:
            return entries


def dirs_create(directory):
    """Creates a volume directory and its parents (no-op when it exists)."""
    response = _files_request("PUT", "/api/2.0/fs/directories", directory, {200, 201, 204})
    if response.status_code == 404:
        raise RuntimeError(f"PUT directory {directory} failed with 404 (volume missing?)")
