"""Upload the newest scraper CSV of each --pattern to the Databricks landing volume, and count the jobs in them that the
pipeline does not have yet.

Usage:
    python databricks/upload_to_volume.py --volume /Volumes/jobseeker/default/scrapes --pattern <glob> [--pattern ...]
                                          [--seen-keys <volume path> | --no-seen-keys]

Each --pattern uploads its newest match (the same file named twice is uploaded once); a pattern without a match is a
failure. A CSV without data rows is not uploaded ([SKIP]): there is nothing in it to ingest.

"New" jobs decide whether the ATS Scrapers workflow starts the Databricks pipeline (trigger_job.py --no-new-files):
a row is new when its job_key (ats_type, company_name, job_id) is not in the seen job keys file that 04_gold_cleanup
writes (config/ats_seen_keys.json: the jobs silver already has with a description). When that file can't be read
every row counts as new, and so does a row without job_id or ats_type: an unknown answer only ever starts a run.
Every non-empty CSV is still uploaded, also one without new jobs, so the next run ingests the sightings.

With $GITHUB_OUTPUT set it always appends (also after a failed upload) uploaded=, new_files=, new_jobs=, empty_files=
and seen_keys=loaded|unavailable. A file whose upload failed counts in none of them. Exits 1 when any upload failed.
Uses DATABRICKS_HOST and DATABRICKS_TOKEN from the environment or .env.
"""
import argparse
import csv
import hashlib
import os
import sys
import time
from datetime import date
from pathlib import Path

import requests

from jobs.databricks_api import auth_headers, host

# keep in sync: scraper_common.CONFIG_DIR / ATS_SEEN_KEYS_FILE (not imported: scraper_common pulls in Playwright)
ATS_SEEN_KEYS_FILE = os.getenv("ATS_SEEN_KEYS_FILE", "/Volumes/jobseeker/ops/pipeline/config/ats_seen_keys.json")
# Descriptions can be long; the csv module's default 128 KB field limit is not enough. A C long is 32 bits on Windows.
CSV_FIELD_LIMIT = min(sys.maxsize, 2 ** 31 - 1)


def job_key(ats_type, company_name, job_id):
    """keep in sync: scraper_common.job_key (the pipeline's job_key, 02_ingest_silver)."""
    raw = f"{str(ats_type or '').strip().lower()}|{str(company_name or '').strip().lower()}|{str(job_id or '').strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def newest_match(pattern: str) -> Path:
    matches = sorted(Path().glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True)
    if not matches:
        raise FileNotFoundError(f"No files matched pattern: {pattern}")
    return matches[0]


def build_remote_path(volume_path: str, local_file: Path) -> str:
    normalized = volume_path.rstrip("/")
    if not normalized.startswith("/Volumes/"):
        raise ValueError(f"Volume path must start with /Volumes/: {volume_path}")
    dated_folder = date.today().strftime("%d%m%Y")
    return f"{normalized}/{dated_folder}/{local_file.name}"


def create_remote_directory(remote_directory: str) -> None:
    headers = auth_headers()
    url = f"{host()}/api/2.0/fs/directories{remote_directory}"

    metadata_response = requests.head(url, headers=headers, timeout=60)
    if metadata_response.status_code == 200:
        print(f"[MKDIR] Exists: {remote_directory}")
        return
    if metadata_response.status_code != 404:
        raise RuntimeError(
            f"Directory check failed with status {metadata_response.status_code}: "
            f"{metadata_response.text[:500]}"
        )

    print(f"[MKDIR] PUT {url}")
    response = requests.put(url, headers=headers, timeout=120)
    if response.status_code != 204:
        raise RuntimeError(f"Create directory failed with status {response.status_code}: {response.text[:500]}")


def upload_file(local_file: Path, remote_path: str, attempts: int = 3) -> None:
    headers = {**auth_headers(), "Content-Type": "application/octet-stream"}
    url = f"{host()}/api/2.0/fs/files{remote_path}?overwrite=true"

    error = ""
    for attempt in range(1, attempts + 1):
        print(f"[UPLOAD] PUT {url} (attempt {attempt}/{attempts})")
        try:
            with open(local_file, "rb") as file_handle:
                response = requests.put(url, headers=headers, data=file_handle, timeout=300)
        except requests.RequestException as exc:
            error = str(exc)
        else:
            if response.status_code == 204:
                return
            error = f"status {response.status_code}: {response.text[:500]}"
            # Client errors (bad path, auth) will not succeed on retry.
            if response.status_code < 500 and response.status_code != 429:
                break

        if attempt < attempts:
            print(f"[RETRY] Upload failed ({error}); retrying")
            time.sleep(2 ** attempt)

    raise RuntimeError(f"Upload failed with {error}")


def load_seen_keys(path):
    """The job keys the pipeline already has (a set), or None when they are unknown (a warning says why)."""
    reason = None
    try:
        response = requests.get(f"{host()}/api/2.0/fs/files{path}", headers=auth_headers(), timeout=60)
        if response.status_code == 404:
            reason = f"{path} not written yet"
        elif response.status_code != 200:
            reason = f"HTTP {response.status_code}"
        else:
            data = response.json()
            if not isinstance(data, dict) or not isinstance(data.get("job_keys") or [], list):
                reason = "not a JSON object with job_keys"
            else:
                return {str(key).strip() for key in data.get("job_keys") or []} - {""}
    except Exception as exc:  # network, auth or JSON errors: never stop the upload over the count
        reason = f"{type(exc).__name__}: {str(exc)[:200]}"
    print(f"[WARN] seen job keys unavailable ({reason}); every row counts as new")
    return None


def count_rows(local_file: Path, seen):
    """(data rows, new rows) of a scraper CSV; seen None = every row is new."""
    csv.field_size_limit(CSV_FIELD_LIMIT)
    rows = new = 0
    # utf-8-sig also reads a CSV saved with a byte order mark; a bad byte must not stop the upload
    with open(local_file, encoding="utf-8-sig", errors="replace", newline="") as handle:
        for row in csv.DictReader(handle):
            rows += 1
            job_id, ats_type = (row.get("job_id") or "").strip(), (row.get("ats_type") or "").strip()
            if seen is None or not job_id or not ats_type or job_key(ats_type, row.get("company_name"), job_id) not in seen:
                new += 1
    return rows, new


def write_outputs(values):
    path = os.getenv("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def resolve_files(patterns, failures):
    """The newest match of each pattern, each file once (a pattern without a match goes to failures)."""
    files, known = [], set()
    for pattern in patterns:
        try:
            local_file = newest_match(pattern)
        except Exception as exc:
            failures.append(f"{pattern}: {exc}")
            continue
        resolved = local_file.resolve()
        if resolved not in known:
            known.add(resolved)
            files.append(local_file)
    return files


def run(volume, patterns, seen_keys_path=ATS_SEEN_KEYS_FILE):
    """Uploads and counts; returns the exit code. The counters reach $GITHUB_OUTPUT whatever happens."""
    counts = {"uploaded": 0, "new_files": 0, "new_jobs": 0, "empty_files": 0}
    seen = None
    failures = []
    try:
        files = resolve_files(patterns, failures)
        seen = load_seen_keys(seen_keys_path) if seen_keys_path and files else None
        for local_file in files:
            try:
                try:
                    rows, new = count_rows(local_file, seen)
                except csv.Error as exc:
                    # Unreadable as CSV: upload it anyway (the pipeline decides) and count it as new, so it starts a run
                    print(f"[WARN] {local_file}: could not count rows ({exc}); counting the file as new")
                    rows, new = None, None
                if rows == 0:
                    print(f"[SKIP] {local_file}: no rows")
                    counts["empty_files"] += 1
                    continue
                remote_path = build_remote_path(volume, local_file)
                create_remote_directory(remote_path.rsplit("/", 1)[0])
                upload_file(local_file, remote_path)
            except Exception as exc:
                failures.append(f"{local_file}: {exc}")
                continue
            counts["uploaded"] += 1
            if new is None or new > 0:
                counts["new_files"] += 1
                counts["new_jobs"] += new or 0
            if rows is not None:
                print(f"[COUNT] {local_file.name}: {rows} row(s), {new} new")
    except Exception as exc:
        failures.append(f"upload: {exc}")
    finally:
        seen_state = "loaded" if seen is not None else "unavailable"
        write_outputs({**counts, "seen_keys": seen_state})
        seen_note = f"{seen_state} ({len(seen)})" if seen is not None else seen_state
        print(f"[SUMMARY] uploaded {counts['uploaded']} file(s), {counts['new_files']} with new jobs "
              f"({counts['new_jobs']} new jobs), {counts['empty_files']} empty; seen keys: {seen_note}")

    for failure in failures:
        print(f"[ERROR] {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--volume", required=True, help="Target Databricks volume path, e.g. /Volumes/jobseeker/default/scrapes")
    parser.add_argument("--pattern", action="append", required=True, help="Glob pattern for files to upload; newest match is used")
    seen_group = parser.add_mutually_exclusive_group()
    seen_group.add_argument("--seen-keys", default=ATS_SEEN_KEYS_FILE,
                            help=f"Volume path of the seen job keys file (default {ATS_SEEN_KEYS_FILE}, env ATS_SEEN_KEYS_FILE)")
    seen_group.add_argument("--no-seen-keys", action="store_true", help="Don't read the seen job keys: every row is new")
    args = parser.parse_args()
    sys.exit(run(args.volume, args.pattern, None if args.no_seen_keys else args.seen_keys))
