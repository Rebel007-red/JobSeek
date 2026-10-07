"""Send a scraper's run report (databricks/output/<source>_report.json) to Supabase for the admin System tab.

Usage:
    python databricks/jobs/record_scrape_report.py --scraper databricks/workday.py
    python databricks/jobs/record_scrape_report.py --scraper databricks/linkedin.py --report path/to/report.json
    python databricks/jobs/record_scrape_report.py --scraper databricks/greenhouse.py --dry-run   # print, send nothing

The source is the scraper file's basename (workday, greenhouse, linkedin). The scrapers write the report on every exit
path (scraper_common.scrape_report); when it is missing, or belongs to another GitHub run, a "crashed" report with the
message "scraper wrote no report" is sent instead. public.pipeline_record_scrape (service role only) stores the run in
app.scrape_runs and one row per company in app.scrape_companies; re-sending the same run replaces it.
Prints the source, status and counts only. Always exits 0: recording must never fail a scrape (the composite action
step also has continue-on-error). Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env or .env).
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from supabase_api import rpc

FORMAT = "jobseeker.scrape_report.v1"
SOURCES = ("workday", "greenhouse", "linkedin")
MAX_COMPANIES = 500
OUTPUT_DIR = Path(__file__).resolve().parents[1] / "output"


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def github_run():
    attempt = os.getenv("GITHUB_RUN_ATTEMPT") or ""
    return {
        "github_run_id": os.getenv("GITHUB_RUN_ID") or None,
        "github_run_attempt": int(attempt) if attempt.isdigit() else None,
        "workflow": os.getenv("GITHUB_WORKFLOW") or None,
    }


def crashed_report(source, message="scraper wrote no report"):
    """The report sent when the scraper left none (killed, timed out, or failed before it started)."""
    now = utc_now_iso()
    return {
        "format": FORMAT,
        "source": source,
        "run": {**github_run(), "started_at": None, "finished_at": now, "status": "crashed", "message": message},
        "totals": {"companies": None, "failed": None, "jobs_scraped": None, "jobs_written": None,
                   "missing_descriptions": None, "already_seen": None},
        "linkedin": None,
        "companies": [],
    }


def load_report(source, path):
    """The scraper's report, or a crashed one when the file is missing, unreadable, of another source or another run."""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return crashed_report(source)
    except (OSError, ValueError) as exc:
        return crashed_report(source, f"unreadable report: {type(exc).__name__}")
    if not isinstance(doc, dict) or doc.get("format") != FORMAT or doc.get("source") != source:
        return crashed_report(source, "invalid report")
    # A report left over from an earlier run (local runs; Actions checks out fresh) is not this run's
    run_id = os.getenv("GITHUB_RUN_ID")
    if run_id and str((doc.get("run") or {}).get("github_run_id") or "") != run_id:
        return crashed_report(source)
    if isinstance(doc.get("companies"), list) and len(doc["companies"]) > MAX_COMPANIES:
        doc["companies"] = doc["companies"][:MAX_COMPANIES]  # the RPC refuses longer lists; totals keep the full counts
    return doc


def summary(doc):
    run, totals = doc.get("run") or {}, doc.get("totals") or {}
    counts = " ".join(f"{key}={totals.get(key)}" for key in ("companies", "failed", "jobs_scraped", "jobs_written"))
    line = f"source={doc.get('source')} status={run.get('status')} {counts}"
    linkedin = doc.get("linkedin")
    if isinstance(linkedin, dict):
        line += (f" searches={linkedin.get('searches_total')} cap={linkedin.get('searches_cap')}"
                 f" dropped={len(linkedin.get('dropped') or [])}")
    return line


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scraper", required=True, help="The scraper script, e.g. databricks/workday.py")
    parser.add_argument("--report", default=None, help="Report file (default databricks/output/<source>_report.json)")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be sent; send nothing")
    args = parser.parse_args(argv)

    try:
        source = Path(args.scraper).stem.lower()
        if source not in SOURCES:
            print(f"::warning::Not recording the scrape report: unknown scraper {args.scraper!r}")
            return 0
        doc = load_report(source, args.report or OUTPUT_DIR / f"{source}_report.json")
        if args.dry_run:
            print(f"[DRY RUN] would record {summary(doc)} ({len(doc.get('companies') or [])} company rows)")
            return 0
        result = rpc("pipeline_record_scrape", {"report": doc}) or {}
        print(f"[RECORDED] {summary(doc)} ({result.get('companies', 0)} company rows)")
    except Exception as exc:
        # Never fail the scrape over its report; the error text never contains the key
        print(f"::warning::Could not record the scrape report: {type(exc).__name__}: {str(exc)[:300]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
