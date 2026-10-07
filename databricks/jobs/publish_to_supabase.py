"""Publish the latest gold snapshot that 04_gold_cleanup wrote to the Databricks volume into Supabase (schema app).

Usage:
    python databricks/jobs/publish_to_supabase.py                     # newest complete publish/<run_id>/
    python databricks/jobs/publish_to_supabase.py --run-id 1234       # a specific run
    python databricks/jobs/publish_to_supabase.py --dry-run           # read + verify + diff, write nothing
    python databricks/jobs/publish_to_supabase.py --force             # also when already published / older / shrinking

Steps:
1. List /Volumes/<catalog>/ops/pipeline/publish/, read each manifest.json (a directory without one is incomplete and
   skipped) and pick the newest snapshot_at (or --run-id). None -> "[SKIP] no complete publish yet", exit 0.
2. public.pipeline_publish_state(): same run_id and snapshot (a repaired run has a newer one) -> "[SKIP] already
   published"; older snapshot -> "[SKIP] older than published" (both exit 0 unless --force).
3. Download every file, verify sha256 + bytes from the manifest, the counts and each row hash (mismatch -> exit 1).
4. pipeline_publish_state(include_hashes) -> send only rows whose hash differs (kind jobs), then every key (kind keys),
   then the small kinds (stats, similarity, refs, custom statuses), then pipeline_publish_finish(run_id, manifest,
   force), which refuses inconsistent / older / shrinking snapshots and never deletes a job any user tracks.
5. Every run that is not a dry run (published, skipped or failed) ends with record_runs(): the newest 20 runs of the
   pipeline job (Jobs API runs/list, no compute) go to pipeline_record_runs for Settings > System. Its errors only warn.
Every call is idempotent, so a failed or interrupted publish is fixed by running it again (the hourly
publish-supabase workflow does). Batches: at most --max-batch-rows rows (keys: 10x) and --max-batch-bytes of JSON.
Prints counts only. Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and DATABRICKS_HOST + DATABRICKS_TOKEN (env or .env),
plus DATABRICKS_JOB_NAME (default "JobSeeeker") for the run history.
"""
import argparse
import gzip
import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone

from databricks_api import api, env, files_get, files_list, find_job_id
from supabase_api import rpc

FORMAT = "jobseeker.publish.v1"
# The run ids public.pipeline_publish accepts (^[A-Za-z0-9_.-]{1,100}$); job runs are numeric, manual ones manual-<ts>
RUN_ID_RE = re.compile(r"[A-Za-z0-9_.-]{1,64}")
JOB_KEY_RE = re.compile(r"[0-9a-f]{64}")
# Kinds staged by pipeline_publish and applied by pipeline_publish_finish, in send order: (kind, file key, list key)
SMALL_KINDS = [
    ("skill_stats", "skill_stats", "rows"),
    ("role_similarity", "role_similarity", "rows"),
    ("ref_roles", "refs", "ref_roles"),
    ("ref_skills", "refs", "ref_skills"),
    ("ref_cities", "refs", "ref_cities"),
    ("custom_roles", "custom_statuses", "custom_roles"),
    ("custom_skills", "custom_statuses", "custom_skills"),
]
# The app.jobs content columns every jobs-*.jsonl.gz row carries (plus "h")
JOB_COLUMNS = [
    "job_key", "source", "company_name", "title", "location", "posted_date", "job_url", "seniority_level",
    "employment_type", "experience_min_years", "experience_max_years", "experience_level", "skills", "skill_groups",
    "category", "role_title", "role_score", "role_alternative", "role_method", "first_seen_at", "last_seen_at",
    "times_seen", "is_active", "description", "job_function", "industries",
]


class PublishError(Exception):
    pass


def row_hash(row):
    """Same as 04_gold_cleanup: sha256 of the canonical JSON of the row without "h"."""
    body = {key: value for key, value in row.items() if key != "h"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def parse_ts(value):
    """ISO 8601 timestamp (Z or +hh:mm offset, any fraction) -> aware UTC datetime; None for empty."""
    if not value:
        return None
    text = str(value).strip().replace(" ", "T")
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?", text)
    if not match:
        raise ValueError(f"not an ISO timestamp: {text[:40]!r}")
    base = datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S")
    micros = int((match.group(2) or "0").ljust(6, "0")[:6])
    zone = match.group(3) or "Z"
    offset_minutes = 0
    if zone != "Z":
        sign = -1 if zone[0] == "-" else 1
        digits = zone[1:].replace(":", "")
        offset_minutes = sign * (int(digits[:2]) * 60 + int(digits[2:]))
    epoch = (base - datetime(1970, 1, 1)).total_seconds() - offset_minutes * 60
    return datetime.fromtimestamp(epoch, timezone.utc).replace(microsecond=micros)


def find_manifest(publish_dir, run_id=None):
    """The newest complete publish (manifest.json present and valid), or the one for run_id. None if there is none."""
    entries = [entry for entry in files_list(publish_dir) if entry.get("is_directory")]
    names = [entry.get("name") or entry["path"].rstrip("/").rsplit("/", 1)[-1] for entry in entries]
    if run_id is not None:
        names = [name for name in names if name == run_id]
    best, incomplete, invalid = None, 0, 0
    for name in names:
        if not RUN_ID_RE.fullmatch(name or ""):
            invalid += 1
            continue
        raw = files_get(f"{publish_dir}/{name}/manifest.json")
        if raw is None:
            incomplete += 1
            continue
        try:
            manifest = json.loads(raw.decode("utf-8"))
            if manifest.get("format") != FORMAT or manifest.get("run_id") != name:
                raise ValueError("format / run_id mismatch")
            snapshot = parse_ts(manifest.get("snapshot_at"))
            if snapshot is None:
                raise ValueError("no snapshot_at")
        except Exception as exc:
            invalid += 1
            print(f"[WARN] ignoring publish/{name}/manifest.json: {str(exc)[:200]}")
            continue
        if best is None or snapshot > best[0]:
            best = (snapshot, manifest)
    print(f"[LIST] {len(names)} publish directories ({incomplete} incomplete, {invalid} invalid)")
    return best[1] if best else None


def download(run_dir, manifest, name):
    data = files_get(f"{run_dir}/{name}")
    if data is None:
        raise PublishError(f"{name} is listed in the manifest but missing")
    expected_sha = (manifest.get("sha256") or {}).get(name)
    expected_bytes = (manifest.get("bytes") or {}).get(name)
    if expected_sha != hashlib.sha256(data).hexdigest():
        raise PublishError(f"{name}: sha256 does not match the manifest")
    if expected_bytes is not None and expected_bytes != len(data):
        raise PublishError(f"{name}: {len(data)} bytes, manifest says {expected_bytes}")
    return data


def load_publish(run_dir, manifest):
    """Downloads + verifies every file; returns (jobs rows, keys, {kind: rows})."""
    files = manifest.get("files") or {}
    counts = manifest.get("counts") or {}
    if not isinstance(files.get("jobs"), list):
        raise PublishError("manifest.files.jobs is not a list")

    jobs = []
    for name in files["jobs"]:
        for line in gzip.decompress(download(run_dir, manifest, name)).decode("utf-8").splitlines():
            if line.strip():
                jobs.append(json.loads(line))
    keys_doc = json.loads(download(run_dir, manifest, files["keys"]).decode("utf-8"))
    keys = keys_doc.get("keys")
    if keys_doc.get("run_id") != manifest["run_id"] or not isinstance(keys, list):
        raise PublishError("keys.json does not belong to this run")

    documents = {}
    for file_key in sorted({file_key for _, file_key, _ in SMALL_KINDS}):
        documents[file_key] = json.loads(download(run_dir, manifest, files[file_key]).decode("utf-8"))
    small = {}
    for kind, file_key, list_key in SMALL_KINDS:
        rows = documents[file_key].get(list_key)
        if not isinstance(rows, list):
            raise PublishError(f"{files[file_key]}: {list_key} is not a list")
        small[kind] = rows

    # Counts, keys and row hashes
    problems = []
    if counts.get("jobs") != len(jobs):
        problems.append(f"jobs: {len(jobs)} rows, manifest says {counts.get('jobs')}")
    if len(keys) != len(jobs):
        problems.append(f"keys.json has {len(keys)} keys for {len(jobs)} job rows")
    for kind, rows in small.items():
        if counts.get(kind) != len(rows):
            problems.append(f"{kind}: {len(rows)} rows, manifest says {counts.get(kind)}")
    bad_hash = bad_key = bad_columns = 0
    for row in jobs:
        if not isinstance(row.get("job_key"), str) or not JOB_KEY_RE.fullmatch(row["job_key"]):
            bad_key += 1
        if row.get("h") != row_hash(row):
            bad_hash += 1
        if set(row) != {*JOB_COLUMNS, "h"}:
            bad_columns += 1
    if bad_key or bad_hash or bad_columns:
        problems.append(f"job rows with an invalid key: {bad_key}, wrong hash: {bad_hash}, unexpected columns: {bad_columns}")
    row_keys = {(row.get("job_key"), row.get("h")) for row in jobs}
    file_keys = {tuple(pair) for pair in keys if isinstance(pair, list) and len(pair) == 2}
    if len(row_keys) != len(jobs) or row_keys != file_keys:
        problems.append("keys.json does not match the job rows (duplicate or missing keys)")
    if problems:
        raise PublishError("; ".join(problems))
    return jobs, keys, small


def batches(items, max_items, max_bytes):
    """Greedy batches of at most max_items items and about max_bytes of JSON (an item larger than that goes alone)."""
    batch, size = [], 0
    for item in items:
        # json.dumps defaults (ASCII escapes, ", " separators) = what requests' json= sends, the largest encoding
        item_bytes = len(json.dumps(item)) + 2
        if batch and (len(batch) >= max_items or size + item_bytes > max_bytes):
            yield batch
            batch, size = [], 0
        if item_bytes > max_bytes:
            print(f"[WARN] one item is {item_bytes} bytes (> {max_bytes}); sent in a batch of its own")
        batch.append(item)
        size += item_bytes
    if batch:
        yield batch


def send(run_id, kind, list_key, items, max_items, max_bytes, dry_run):
    """Sends items with pipeline_publish in sequence-numbered batches; returns (batches, accepted).
    A staged kind (everything but jobs) always gets a seq 0 batch, empty if need be: seq 0 drops what an earlier attempt
    of this run staged for the kind, which would otherwise stay and fail the finish's count check."""
    sent = accepted = 0
    envelope_bytes = 200  # run_id, kind, seq and the wrapping object
    groups = list(batches(items, max_items, max_bytes - envelope_bytes))
    if not groups and kind != "jobs":
        groups = [[]]
    for seq, batch in enumerate(groups):
        sent += 1
        if dry_run:
            accepted += len(batch)
            continue
        result = rpc("pipeline_publish", {"batch": {"run_id": run_id, "kind": kind, "seq": seq, list_key: batch}})
        accepted += int((result or {}).get("accepted", len(batch)) or 0)
    return sent, accepted


def ms_to_iso(value):
    """Jobs API epoch milliseconds -> UTC ISO string; None for 0 / missing (e.g. a run that has not ended)."""
    if not value:
        return None
    return datetime.fromtimestamp(int(value) / 1000, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def duration_s(item):
    """Seconds of a run or task: run_duration (multi-task runs), else setup + execution + cleanup, else end - start."""
    if item.get("run_duration"):
        return int(item["run_duration"]) // 1000
    parts = [item.get(key) or 0 for key in ("setup_duration", "execution_duration", "cleanup_duration")]
    if any(parts):
        return int(sum(parts)) // 1000
    if item.get("start_time") and item.get("end_time"):
        return max(0, int(item["end_time"]) - int(item["start_time"])) // 1000
    return None


def map_run(run):
    """One Jobs API run -> the pipeline_record_runs row (tasks: the latest attempt per task_key, in start order)."""
    state = run.get("state") or {}
    latest = {}
    for task in run.get("tasks") or []:
        key = task.get("task_key")
        if key and (key not in latest or (task.get("attempt_number") or 0) >= (latest[key].get("attempt_number") or 0)):
            latest[key] = task
    tasks = []
    for task in sorted(latest.values(), key=lambda item: item.get("start_time") or 0)[:20]:
        task_state = task.get("state") or {}
        tasks.append({
            "task_key": task["task_key"],
            "state": task_state.get("life_cycle_state"),
            "result": task_state.get("result_state"),
            "started_at": ms_to_iso(task.get("start_time")),
            "duration_s": duration_s(task),
        })
    return {
        "run_id": str(run["run_id"]),
        "started_at": ms_to_iso(run.get("start_time")),
        "ended_at": ms_to_iso(run.get("end_time")),
        "duration_s": duration_s(run),
        "state": state.get("life_cycle_state"),
        "result": state.get("result_state"),
        "message": (state.get("state_message") or "")[:300],
        "trigger": run.get("trigger"),
        "tasks": tasks,
    }


def record_runs():
    """Sends the newest 20 runs of the pipeline job to pipeline_record_runs (run history for Settings > System).
    Never raises: a failure only prints [WARN], so it cannot change the publish's exit code."""
    try:
        job_name = env("DATABRICKS_JOB_NAME") or "JobSeeeker"
        job_id = find_job_id(job_name)
        if job_id is None:
            print(f"[WARN] run history not recorded: no Databricks job named {job_name!r}")
            return
        runs = api("GET", "/api/2.2/jobs/runs/list",
                   params={"job_id": job_id, "limit": 20, "expand_tasks": "true"}).get("runs") or []
        rows = [map_run(run) for run in runs if run.get("run_id") is not None]
        result = rpc("pipeline_record_runs", {"batch": {"runs": rows}}) or {}
        latest = f" (latest {rows[0]['run_id']} {rows[0]['state']}/{rows[0]['result']})" if rows else ""
        print(f"[RUNS] recorded {result.get('recorded', len(rows))} pipeline runs{latest}")
    except Exception as exc:
        print(f"[WARN] run history not recorded: {type(exc).__name__}: {str(exc)[:300]}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalog", default=env("DATABRICKS_CATALOG") or "jobseeker")
    parser.add_argument("--run-id", default=None, help="Publish this run instead of the newest complete one")
    parser.add_argument("--force", action="store_true",
                        help="Publish even when already published / older than the published snapshot / shrinking app.jobs")
    parser.add_argument("--dry-run", action="store_true", help="Read, verify and diff; send nothing")
    parser.add_argument("--max-batch-rows", type=int, default=500)
    parser.add_argument("--max-batch-bytes", type=int, default=900_000)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_]+", args.catalog):
        raise ValueError(f"Invalid catalog: {args.catalog!r}")
    if args.run_id is not None and not RUN_ID_RE.fullmatch(args.run_id):
        raise ValueError("Invalid --run-id")
    if not 1 <= args.max_batch_rows <= 500 or not 10_000 <= args.max_batch_bytes <= 900_000:
        raise ValueError("--max-batch-rows must be 1-500 and --max-batch-bytes 10000-900000")

    # The run history is recorded after every outcome (published, skipped or failed), never on a dry run
    try:
        return publish(args)
    finally:
        if not args.dry_run:
            record_runs()


def publish(args):
    started = time.monotonic()
    publish_dir = f"/Volumes/{args.catalog}/ops/pipeline/publish"
    manifest = find_manifest(publish_dir, args.run_id)
    if manifest is None:
        print(f"[SKIP] no complete publish yet{f' for run {args.run_id}' if args.run_id else ''} in {publish_dir}")
        return 0
    run_id = manifest["run_id"]
    snapshot_at = parse_ts(manifest["snapshot_at"])
    print(f"[PICK] run_id={run_id} snapshot_at={manifest['snapshot_at']} counts={json.dumps(manifest.get('counts'), sort_keys=True)}")

    state = rpc("pipeline_publish_state", {"include_hashes": False}) or {}
    published_snapshot = parse_ts(state.get("snapshot_at"))
    # A repaired Databricks run keeps its run id but writes a newer snapshot: publish that one
    if state.get("run_id") == run_id and not args.force and not (published_snapshot and snapshot_at > published_snapshot):
        print(f"[SKIP] already published (run_id={run_id}, published_at={state.get('published_at')})")
        return 0
    if published_snapshot and snapshot_at < published_snapshot and not args.force:
        print(f"[SKIP] older than published (run {run_id} snapshot {manifest['snapshot_at']} < "
              f"run {state.get('run_id')} snapshot {state.get('snapshot_at')})")
        return 0

    run_dir = f"{publish_dir}/{run_id}"
    jobs, keys, small = load_publish(run_dir, manifest)
    print(f"[VERIFIED] {len(manifest['files']['jobs'])} job files, {len(jobs)} jobs, "
          + ", ".join(f"{kind}={len(rows)}" for kind, rows in small.items()))

    hashes = (rpc("pipeline_publish_state", {"include_hashes": True}) or {}).get("hashes") or {}
    changed = [row for row in jobs if hashes.get(row["job_key"]) != row["h"]]
    new = sum(1 for row in changed if row["job_key"] not in hashes)
    snapshot_keys = {row["job_key"] for row in jobs}
    not_in_snapshot = sum(1 for key in hashes if key not in snapshot_keys)
    print(f"[DIFF] app.jobs has {len(hashes)} rows: send {len(changed)} ({new} new, {len(changed) - new} changed), "
          f"{len(jobs) - len(changed)} unchanged, {not_in_snapshot} not in the snapshot (deleted by finish unless tracked)")

    prefix = "[DRY RUN] would send" if args.dry_run else "[SENT]"
    batches_sent, accepted = send(run_id, "jobs", "rows", changed, args.max_batch_rows, args.max_batch_bytes, args.dry_run)
    print(f"{prefix} jobs: {len(changed)} rows in {batches_sent} batches (accepted {accepted})")
    batches_sent, accepted = send(run_id, "keys", "keys", keys, args.max_batch_rows * 10, args.max_batch_bytes, args.dry_run)
    print(f"{prefix} keys: {len(keys)} in {batches_sent} batches (accepted {accepted})")
    for kind, rows in small.items():
        batches_sent, accepted = send(run_id, kind, "rows", rows, args.max_batch_rows, args.max_batch_bytes, args.dry_run)
        print(f"{prefix} {kind}: {len(rows)} rows in {batches_sent} batches (accepted {accepted})")

    if args.dry_run:
        print(f"[DRY RUN] would finish run {run_id} (force={args.force}) in {time.monotonic() - started:.1f} s")
        return 0

    try:
        result = rpc("pipeline_publish_finish", {"run_id": run_id, "manifest": manifest, "force": args.force}, timeout=180)
    except Exception as exc:
        # A finish that timed out on the client may still have committed; the status row tells
        after = rpc("pipeline_publish_state", {"include_hashes": False}) or {}
        # same run and this snapshot: a repaired run re-publishes under the same run_id with a newer snapshot
        if after.get("run_id") != run_id or parse_ts(after.get("snapshot_at")) != snapshot_at:
            raise
        print(f"[WARN] finish reported {type(exc).__name__} but run {run_id} is published")
        result = {"run_id": run_id}
    summary = {key: value for key, value in (result or {}).items() if key != "run_id"}
    print(f"[PUBLISHED] run_id={run_id} {json.dumps(summary, sort_keys=True, default=str)} "
          f"in {time.monotonic() - started:.1f} s")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"[ERROR] {type(exc).__name__}: {str(exc)[:1000]}", file=sys.stderr)
        sys.exit(1)
