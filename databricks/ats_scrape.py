"""Scrape the API / HTML job boards (Lever, Ashby, SmartRecruiters, Workable, Oracle, SuccessFactors, Darwinbox, Keka).

Usage:
    python databricks/ats_scrape.py --all-api                 # every adapter in ats/registry.py
    python databricks/ats_scrape.py --ats lever,ashby         # some of them
    python databricks/ats_scrape.py --ats lever --company Paytm --dry-run    # one company, write nothing
    python databricks/ats_scrape.py --ats lever --companies-file rows.json   # companies from a file, not Supabase

Companies come from Supabase public.companies (ats_type in the selected names, disabled = false), like the other
scrapers. Each ATS with at least one company writes:
    output/ats/<ats>_<YYYYmmdd_HHMMSS>.csv   rows in scraper_common.OUTPUT_COLUMNS (only India / unknown-country jobs
                                             posted within MAX_POSTED_DAYS), uploaded by upload_to_volume.py
    output/<ats>_report.json                 format jobseeker.scrape_report.v1 (jobs/record_scrape_report.py)
and the run writes output/ats_scrape_manifest.json (format jobseeker.ats_manifest.v1): which sources ran, their status,
CSV and report, so the record step knows which reports belong to this run. An ATS without companies is 'skipped' (no
CSV, no report).

ATS run in parallel threads (different hosts), the companies of one ATS one after another (polite to each host).
Exit code 1 when the companies cannot be read or every ATS that had companies failed or crashed; else 0 (a partial run
still gets uploaded and ingested).
"""
import argparse
import json
import os
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import requests  # noqa: E402

import scraper_common as sc  # noqa: E402
from ats import registry  # noqa: E402
from ats.base import Context, Settings, run_company, short_error, today_ist  # noqa: E402

MANIFEST_FORMAT = "jobseeker.ats_manifest.v1"
MANIFEST_NAME = "ats_scrape_manifest.json"
CSV_SUBDIR = "ats"
# Written by 04_gold_cleanup next to linkedin_seen_ids.json: {"generated_at", "job_keys": [...]}, the job_key of every
# Workday or new-ATS silver job posted (else first seen) within job_delete_after_days (7) that has a description. Optional: without it every detail is
# fetched (within the caps).
SEEN_KEYS_FILE = os.getenv("ATS_SEEN_KEYS_FILE", f"{sc.CONFIG_DIR}/ats_seen_keys.json")
COMPANY_COLUMNS = "name,ats_type,slug,api_url,disabled"

_print_lock = threading.Lock()


def log(message):
    with _print_lock:
        print(message, flush=True)


class CompaniesUnavailable(Exception):
    pass


def fetch_companies(names):
    """Enabled companies of the given ATS types from Supabase public.companies; raises CompaniesUnavailable."""
    if not sc.BASE_URL:
        raise CompaniesUnavailable("SUPABASE_URL not configured")
    if not sc.HEADERS.get("apikey"):
        raise CompaniesUnavailable("no Supabase API key configured")
    params = {"select": COMPANY_COLUMNS, "ats_type": f"in.({','.join(names)})", "disabled": "eq.false",
              "order": "name.asc"}
    try:
        response = requests.get(f"{sc.BASE_URL}/companies", params=params, headers=sc.HEADERS, timeout=30)
    except requests.RequestException as exc:
        raise CompaniesUnavailable(f"{type(exc).__name__}: {short_error(exc)}") from exc
    if response.status_code != 200:
        raise CompaniesUnavailable(f"HTTP {response.status_code}: {response.text[:200]}")
    rows = response.json()
    if not isinstance(rows, list):
        raise CompaniesUnavailable("unexpected companies response")
    return rows


def load_companies_file(path):
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise CompaniesUnavailable(f"{path}: expected a JSON list of companies rows")
    return [row for row in rows if isinstance(row, dict) and not row.get("disabled")]


def group_companies(rows, names, only=None):
    """{ats: [rows]} for the selected names; names in `only` (lower-cased) filter the companies."""
    groups = {name: [] for name in names}
    for row in rows:
        ats = str(row.get("ats_type") or "").strip().lower()
        if ats not in groups:
            continue
        if only and str(row.get("name") or "").strip().lower() not in only:
            continue
        groups[ats].append(row)
    return groups


def load_seen_keys():
    """job_keys the pipeline already has a description for (empty set when unavailable: then details are fetched)."""
    host = (os.getenv("DATABRICKS_HOST") or "").strip().strip('"').rstrip("/")
    token = (os.getenv("DATABRICKS_TOKEN") or "").strip().strip('"')
    if not host or not token:
        log("[INFO] No Databricks credentials: fetching every missing description (within the caps).")
        return frozenset()
    try:
        response = requests.get(f"{host}/api/2.0/fs/files{SEEN_KEYS_FILE}",
                                headers={"Authorization": f"Bearer {token}"}, timeout=60)
    except requests.RequestException as exc:
        log(f"[WARN] Could not read {SEEN_KEYS_FILE}: {type(exc).__name__}")
        return frozenset()
    if response.status_code == 404:
        log(f"[INFO] {SEEN_KEYS_FILE} not found yet (written by the pipeline).")
        return frozenset()
    if response.status_code != 200:
        log(f"[WARN] Could not read {SEEN_KEYS_FILE}: HTTP {response.status_code}")
        return frozenset()
    try:
        data = response.json()
    except ValueError:
        log(f"[WARN] {SEEN_KEYS_FILE} is not JSON")
        return frozenset()
    if not isinstance(data, dict):
        log(f"[WARN] {SEEN_KEYS_FILE} is not a JSON object: fetching every missing description")
        return frozenset()
    keys = frozenset(str(key).strip() for key in data.get("job_keys") or [] if str(key).strip())
    log(f"[INFO] Seen job keys: {len(keys)}, file generated {data.get('generated_at')}")
    return keys


class Manifest:
    """output/ats_scrape_manifest.json, rewritten (atomically) whenever a source changes state."""

    def __init__(self, path, names, enabled=True):
        self.path = Path(path)
        self.enabled = enabled
        self._lock = threading.Lock()
        self.doc = {"format": MANIFEST_FORMAT, **sc.github_run(), "started_at": sc.utc_now_iso(), "finished_at": None,
                    "status": "running", "message": None,
                    "sources": {name: {"status": "pending", "companies": None, "csv": None, "report": None}
                                for name in names}}
        self.write()

    def update(self, name, **fields):
        with self._lock:
            self.doc["sources"][name].update(fields)
        self.write()

    def finish(self, status, message=None):
        with self._lock:
            self.doc.update(status=status, message=message, finished_at=sc.utc_now_iso())
        self.write()

    def write(self):
        if not self.enabled:
            return
        with self._lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                temp = self.path.with_suffix(".tmp")
                temp.write_text(json.dumps(self.doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
                os.replace(temp, self.path)
            except OSError as exc:
                log(f"[WARN] Could not write the manifest: {exc}")


def run_ats(name, companies, ctx, *, output_dir, csv_dir, dry_run=False, get_adapter=registry.get,
            http_kwargs=None):
    """Scrape every company of one ATS, write its CSV and report; returns the manifest fields of the source."""
    label = registry.LABELS.get(name, name)
    report = sc.ScrapeReport(name)
    report.totals["companies"] = len(companies)
    output_file, rows, started = None, [], time.monotonic()
    totals = {"jobs_scraped": 0, "jobs_written": 0, "missing_descriptions": 0, "already_seen": 0}
    try:
        try:
            adapter = get_adapter(name)
        except registry.AdapterNotAvailable as exc:
            for company in companies:
                report.outcome(str(company.get("name") or "Unknown"), False, error=str(exc))
            report.status, report.message = "failed", str(exc)
            log(f"[{name}] {exc}")
            return {"status": "failed", "csv": None}

        http = adapter.make_http(settings=ctx.settings, **(http_kwargs or {}))
        log(f"[{name}] {len(companies)} companies")
        for company in companies:
            company_name = str(company.get("name") or "").strip() or "Unknown"
            if time.monotonic() - started > ctx.settings.ats_time_budget_s:
                report.outcome(company_name, False, error="skipped: run time budget reached")
                continue
            result = run_company(adapter, http, company, ctx, log=log)
            report.outcome(company_name, result.ok, jobs_found=result.found, error=result.error)
            report.companies[-1].update(jobs_written=len(result.rows), india=result.india,
                                        details_fetched=result.details_fetched, details_failed=result.details_failed)
            rows.extend(result.rows)
            totals["jobs_scraped"] += result.parsed
            totals["already_seen"] += result.already_seen
            state = (f"found {result.found}, india {result.india}, written {len(result.rows)}" if result.ok
                     else f"failed: {result.error}")
            log(f"[{name}] {company_name}: {state}")

        dataframe = sc.jobs_to_dataframe(rows)
        totals["jobs_written"] = len(dataframe)
        totals["missing_descriptions"] = int((dataframe["description"] == "").sum()) if len(dataframe) else 0
        report.totals.update(totals)
        if dry_run:
            output_file = "(dry run)"
            log(f"[{name}] dry run: {len(dataframe)} rows not written")
        else:
            output_file = sc.write_flat_jobs_csv(dataframe, name, csv_dir)
        report.finish(output_file, None if output_file else "Failed to write the CSV")
        if output_file and len(report.failed_names) == len(report.companies):
            report.message = f"All {label} companies failed"
        log(f"[{name}] SUMMARY companies={len(companies)} failed={len(report.failed_names)} "
            f"jobs_scraped={totals['jobs_scraped']} jobs_written={totals['jobs_written']} "
            f"missing_descriptions={totals['missing_descriptions']} already_seen={totals['already_seen']}")
        return {"status": report.status, "csv": None if dry_run else output_file}
    except Exception as exc:
        report.status = "crashed"
        report.message = f"{type(exc).__name__}: {short_error(exc, 900)}"
        log(f"[{name}] CRASHED: {report.message}\n{traceback.format_exc()}")
        return {"status": "crashed", "csv": None}
    finally:
        if not dry_run:  # on every exit path, like scraper_common.scrape_report
            sc.write_report(name, status=report.status or "failed", totals=report.totals, companies=report.companies,
                            message=report.message, started_at=report.started_at, output_dir=output_dir)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--ats", help="Comma-separated ATS names, e.g. lever,ashby")
    choice.add_argument("--all-api", action="store_true", help="Every adapter in ats/registry.py")
    parser.add_argument("--company", action="append", default=[], help="Only this company name (repeatable)")
    parser.add_argument("--companies-file", help="JSON list of companies rows instead of Supabase")
    parser.add_argument("--max-days", type=int, default=None,
                        help=f"Keep jobs posted within N days (default MAX_POSTED_DAYS={sc.MAX_POSTED_DAYS})")
    parser.add_argument("--parallel", type=int, default=int(os.getenv("ATS_PARALLEL", "3")),
                        help="ATS scraped at the same time (default 3)")
    parser.add_argument("--no-seen-keys", action="store_true", help="Fetch every missing description")
    parser.add_argument("--output-dir", default=str(sc.OUTPUT_DIR), help="Reports + manifest; CSVs go to <dir>/ats")
    parser.add_argument("--dry-run", action="store_true", help="Scrape and print; write no CSV, report or manifest")
    args = parser.parse_args(argv)
    try:
        args.names = list(registry.ADAPTERS) if args.all_api else registry.parse_names(args.ats)
    except ValueError as exc:
        parser.error(str(exc))
    if not args.names:
        parser.error("no ATS selected")
    if args.max_days is not None and args.max_days < 0:
        parser.error("--max-days must be >= 0")
    return args


def main(argv=None, *, get_adapter=registry.get, http_kwargs=None, seen_keys=None, today=None):
    args = parse_args(argv)
    output_dir = Path(args.output_dir)
    csv_dir = output_dir / CSV_SUBDIR
    manifest = Manifest(output_dir / MANIFEST_NAME, args.names, enabled=not args.dry_run)
    max_days = sc.MAX_POSTED_DAYS if args.max_days is None else args.max_days
    log(f"[INFO] ATS: {', '.join(args.names)}; keeping jobs posted within {max_days} days")

    try:
        rows = load_companies_file(args.companies_file) if args.companies_file else fetch_companies(args.names)
    except (CompaniesUnavailable, OSError, ValueError) as exc:
        message = f"Could not read the companies: {exc}"
        log(f"[ERROR] {message}")
        if not args.dry_run:
            # A report per selected ATS, so the System tab shows the failure
            for name in args.names:
                path = sc.write_report(name, status="failed", totals={}, companies=[], message=message,
                                       started_at=manifest.doc["started_at"], output_dir=output_dir)
                manifest.update(name, status="failed", report=str(path) if path else None)
        manifest.finish("failed", message)
        return 1

    only = {name.strip().lower() for name in args.company if name.strip()}
    groups = group_companies(rows, args.names, only)
    for name, companies in groups.items():
        manifest.update(name, companies=len(companies), status="running" if companies else "skipped")
    active = [name for name, companies in groups.items() if companies]
    if not active:
        log("[INFO] No companies for the selected ATS: nothing to scrape.")
        manifest.finish("skipped", "no companies")
        return 0

    if seen_keys is None:
        seen_keys = frozenset() if args.no_seen_keys or args.dry_run else load_seen_keys()
    ctx = Context(today=today or today_ist(), max_days=max_days, seen_keys=frozenset(seen_keys),
                  settings=Settings.from_env())

    def scrape(name):
        outcome = run_ats(name, groups[name], ctx, output_dir=output_dir, csv_dir=csv_dir, dry_run=args.dry_run,
                          get_adapter=get_adapter, http_kwargs=http_kwargs)
        report_file = sc.report_path(name, output_dir)
        manifest.update(name, status=outcome["status"], csv=outcome["csv"],
                        report=str(report_file) if report_file.exists() and not args.dry_run else None)
        return name, outcome["status"]

    with ThreadPoolExecutor(max_workers=max(1, min(args.parallel, len(active)))) as pool:
        statuses = dict(pool.map(scrape, active))

    failed = [name for name, status in statuses.items() if status in ("failed", "crashed")]
    status = "failed" if len(failed) == len(active) else ("partial" if failed else "ok")
    message = f"failed: {', '.join(failed)}" if failed else None
    manifest.finish(status, message)
    log(f"[SUMMARY] ATS run {status}: " + ", ".join(f"{name}={statuses[name]}" for name in active))
    return 1 if status == "failed" else 0


if __name__ == "__main__":
    sys.exit(main())
