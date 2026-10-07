"""Copy the app user data from Supabase to the Databricks volume, for 02_ingest_silver (task load_user_data).

Usage:
    python databricks/jobs/sync_user_data.py                    # catalog jobseeker
    python databricks/jobs/sync_user_data.py --catalog other --dry-run

Calls the service-only RPC public.pipeline_export_user_data() (profiles, tracked job state, custom roles / skills),
checks the document and writes it to /Volumes/<catalog>/ops/pipeline/config/user_data.json with the Files API.
Databricks never receives a Supabase credential: this script (GitHub Actions or a local shell) moves the file.
Prints counts only (no ids, emails or keys). --dry-run exports and checks but does not upload.
Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and DATABRICKS_HOST + DATABRICKS_TOKEN from the environment or .env.
"""
import argparse
import json
import re
import sys
import time

from databricks_api import dirs_create, env, files_put
from supabase_api import rpc

FORMAT = "jobseeker.user_data.v1"
LISTS = ("profiles", "job_state", "custom_roles", "custom_skills")


def check_document(doc):
    """Raises ValueError when the export is not a user_data.v1 document whose counts match its lists."""
    if not isinstance(doc, dict):
        raise ValueError(f"export is a {type(doc).__name__}, expected an object")
    if doc.get("format") != FORMAT:
        raise ValueError(f"export format is {str(doc.get('format'))[:40]!r}, expected {FORMAT!r}")
    if not isinstance(doc.get("exported_at"), str) or not doc["exported_at"]:
        raise ValueError("export has no exported_at")
    counts = doc.get("counts")
    if not isinstance(counts, dict):
        raise ValueError("export has no counts")
    for name in LISTS:
        rows = doc.get(name)
        if not isinstance(rows, list):
            raise ValueError(f"export.{name} is not a list")
        if counts.get(name) != len(rows):
            raise ValueError(f"export.counts.{name} = {counts.get(name)!r} but the list has {len(rows)} rows")
    return {name: len(doc[name]) for name in LISTS}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalog", default=env("DATABRICKS_CATALOG") or "jobseeker")
    parser.add_argument("--dry-run", action="store_true", help="Export and check, but do not upload")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_]+", args.catalog):
        raise ValueError(f"Invalid catalog: {args.catalog!r}")

    started = time.monotonic()
    doc = rpc("pipeline_export_user_data", {})
    counts = check_document(doc)
    data = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    summary = " ".join(f"{name}={count}" for name, count in counts.items())
    if not counts["profiles"]:
        print("[WARN] the export has no profiles; 02_ingest_silver keeps the Databricks user tables while they have any")

    config_dir = f"/Volumes/{args.catalog}/ops/pipeline/config"
    target = f"{config_dir}/user_data.json"
    if args.dry_run:
        print(f"[DRY RUN] would write {target}: {summary} exported_at={doc['exported_at']} bytes={len(data)}")
        return
    dirs_create(config_dir)
    files_put(target, data)
    print(f"[OK] {target}: {summary} exported_at={doc['exported_at']} bytes={len(data)} "
          f"in {time.monotonic() - started:.1f} s")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[ERROR] {type(exc).__name__}: {str(exc)[:500]}", file=sys.stderr)
        sys.exit(1)
