import argparse
import os
import sys
import time
from datetime import date
from pathlib import Path

from dotenv import load_dotenv
import requests


load_dotenv(Path(__file__).resolve().parent / ".env")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")


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
    host = (os.getenv("DATABRICKS_HOST") or "").strip().strip('"')
    token = (os.getenv("DATABRICKS_TOKEN") or "").strip().strip('"')

    if not host or not token:
        raise EnvironmentError("DATABRICKS_HOST and DATABRICKS_TOKEN must be set before uploading.")

    metadata_url = f"{host}/api/2.0/fs/directories{remote_directory}"
    headers = {"Authorization": f"Bearer {token}"}

    metadata_response = requests.head(metadata_url, headers=headers, timeout=60)
    if metadata_response.status_code == 200:
        print(f"[MKDIR] Exists: {remote_directory}")
        return
    if metadata_response.status_code not in (404,):
        raise RuntimeError(
            f"Directory check failed with status {metadata_response.status_code}: "
            f"{metadata_response.text[:500]}"
        )

    url = f"{host}/api/2.0/fs/directories{remote_directory}"
    print(f"[MKDIR] PUT {url}")
    response = requests.put(url, headers=headers, timeout=120)
    if response.status_code != 204:
        raise RuntimeError(f"Create directory failed with status {response.status_code}: {response.text[:500]}")


def upload_file(local_file: Path, remote_path: str, attempts: int = 3) -> None:
    host = (os.getenv("DATABRICKS_HOST") or "").strip().strip('"')
    token = (os.getenv("DATABRICKS_TOKEN") or "").strip().strip('"')

    if not host or not token:
        raise EnvironmentError("DATABRICKS_HOST and DATABRICKS_TOKEN must be set before uploading.")

    url = f"{host}/api/2.0/fs/files{remote_path}?overwrite=true"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/octet-stream",
    }

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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload latest scraper outputs to a Databricks volume.")
    parser.add_argument("--volume", required=True, help="Target Databricks volume path, e.g. /Volumes/jobseeker/default/scrapes")
    parser.add_argument("--pattern", action="append", required=True, help="Glob pattern for files to upload; newest match is used")
    args = parser.parse_args()

    failures = []
    for pattern in args.pattern:
        try:
            local_file = newest_match(pattern)
            remote_path = build_remote_path(args.volume, local_file)
            remote_directory = remote_path.rsplit("/", 1)[0]
            create_remote_directory(remote_directory)
            upload_file(local_file, remote_path)
        except Exception as exc:
            failures.append(f"{pattern}: {exc}")

    if failures:
        for failure in failures:
            print(f"[ERROR] {failure}", file=sys.stderr)
        sys.exit(1)
