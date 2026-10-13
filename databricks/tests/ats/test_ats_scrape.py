"""databricks/ats_scrape.py end to end, offline: companies file -> CSV per ATS + reports + manifest."""
import contextlib
import csv
import io
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from harness import FakeSession, no_sleep

import ats_scrape
from ats import registry
from ats.lever import LeverAdapter
from scraper_common import OUTPUT_COLUMNS, REPORT_FORMAT

POSTING = {"id": "p1", "text": "Data Engineer", "hostedUrl": "https://jobs.lever.co/acme/p1", "country": "IN",
           "categories": {"location": "Pune", "allLocations": ["Pune"], "commitment": "Full-time"},
           "createdAt": 1791397800000, "descriptionPlain": "Build pipelines", "lists": []}


def fake_get(session):
    def get(name):
        if name == "lever":
            return LeverAdapter()
        raise registry.AdapterNotAvailable(f"{name} scraper not built yet")
    return get


class AtsScrapeTest(unittest.TestCase):
    def run_main(self, companies, argv, session):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        out = Path(self.dir.name)
        companies_file = out / "companies.json"
        companies_file.write_text(json.dumps(companies), encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            code = ats_scrape.main([*argv, "--companies-file", str(companies_file), "--output-dir", str(out),
                                    "--max-days", "7"],
                                   get_adapter=fake_get(session),
                                   http_kwargs={"session": session, "sleep": no_sleep},
                                   seen_keys=frozenset(), today=date(2026, 10, 9))
        return code, out

    def test_writes_csv_report_and_manifest(self):
        session = (FakeSession().add("GET", r"postings/acme", json=[POSTING])
                   .add("GET", r"postings/gone", status=404, text="{}"))
        companies = [{"name": "Acme", "ats_type": "lever", "slug": "acme"},
                     {"name": "Gone", "ats_type": "lever", "slug": "gone"},
                     {"name": "Off", "ats_type": "lever", "slug": "off", "disabled": True},
                     {"name": "Sarvam", "ats_type": "ashby", "slug": "sarvam"},
                     {"name": "Stripe", "ats_type": "greenhouse", "slug": "stripe"}]
        code, out = self.run_main(companies, ["--ats", "lever,ashby,keka"], session)
        self.assertEqual(code, 0)

        csvs = sorted((out / "ats").glob("*.csv"))
        self.assertEqual([path.name.split("_")[0] for path in csvs], ["lever"])
        with csvs[0].open(encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(list(rows[0]), OUTPUT_COLUMNS)
        self.assertEqual((rows[0]["ats_type"], rows[0]["job_id"], rows[0]["posted_days"]), ("lever", "p1", "1"))

        lever = json.loads((out / "lever_report.json").read_text(encoding="utf-8"))
        self.assertEqual((lever["format"], lever["source"], lever["run"]["status"]), (REPORT_FORMAT, "lever", "partial"))
        self.assertEqual(lever["totals"]["companies"], 2)
        self.assertEqual(lever["totals"]["jobs_written"], 1)
        outcomes = {c["name"]: (c["ok"], c["jobs_found"], c["error"]) for c in lever["companies"]}
        self.assertEqual(outcomes, {"Acme": (True, 1, None), "Gone": (False, None, "HTTP 404 (no Lever board 'gone')")})

        ashby = json.loads((out / "ashby_report.json").read_text(encoding="utf-8"))
        self.assertEqual(ashby["run"]["status"], "failed")
        self.assertEqual(ashby["companies"][0]["error"], "ashby scraper not built yet")
        self.assertFalse((out / "keka_report.json").exists())  # no companies: skipped

        manifest = json.loads((out / ats_scrape.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(manifest["format"], ats_scrape.MANIFEST_FORMAT)
        self.assertEqual(manifest["status"], "partial")
        self.assertEqual({name: s["status"] for name, s in manifest["sources"].items()},
                         {"lever": "partial", "ashby": "failed", "keka": "skipped"})
        self.assertTrue(manifest["sources"]["lever"]["csv"].endswith(".csv"))

    def test_exit_1_when_every_ats_fails(self):
        session = FakeSession().add("GET", r"postings/", status=404, text="{}")
        code, out = self.run_main([{"name": "Gone", "ats_type": "lever", "slug": "gone"}], ["--ats", "lever"], session)
        self.assertEqual(code, 1)
        # the CSV is still written (empty), so the report says failed because every company failed
        report = json.loads((out / "lever_report.json").read_text(encoding="utf-8"))
        self.assertEqual((report["run"]["status"], report["run"]["message"]), ("failed", "All Lever companies failed"))

    def test_no_companies_is_not_an_error(self):
        code, out = self.run_main([], ["--all-api"], FakeSession())
        self.assertEqual(code, 0)
        manifest = json.loads((out / ats_scrape.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(manifest["status"], "skipped")
        self.assertEqual(list((out / "ats").glob("*.csv")) if (out / "ats").exists() else [], [])

    def test_dry_run_writes_nothing(self):
        session = FakeSession().add("GET", r"postings/acme", json=[POSTING])
        code, out = self.run_main([{"name": "Acme", "ats_type": "lever", "slug": "acme"}],
                                  ["--ats", "lever", "--dry-run"], session)
        self.assertEqual(code, 0)
        self.assertEqual(sorted(path.name for path in out.iterdir()), ["companies.json"])

    def test_company_filter(self):
        session = FakeSession().add("GET", r"postings/acme", json=[POSTING])
        companies = [{"name": "Acme", "ats_type": "lever", "slug": "acme"},
                     {"name": "Other", "ats_type": "lever", "slug": "other"}]
        code, out = self.run_main(companies, ["--ats", "lever", "--company", "acme"], session)
        self.assertEqual(code, 0)
        report = json.loads((out / "lever_report.json").read_text(encoding="utf-8"))
        self.assertEqual([c["name"] for c in report["companies"]], ["Acme"])


if __name__ == "__main__":
    unittest.main()
