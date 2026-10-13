"""Oracle Recruiting Cloud adapter against the recorded fixtures (no network)."""
import copy
import re
import unittest
from datetime import date

from harness import FakeSession, assert_rows_valid, load_json, run_offline

from ats.oracle import OracleAdapter, parse_board
from scraper_common import ScrapeFailed

TODAY = date(2026, 10, 9)
JPMC = {"name": "JPMorgan Chase", "ats_type": "oracle", "slug": "CX_1001",
        "api_url": "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001"}
LIST_RE = r"recruitingCEJobRequisitions\?"
DETAIL_RE = r"recruitingCEJobRequisitionDetails\?"


def listing(name, total=None):
    """A list fixture whose TotalJobsCount matches the trimmed requisitionList (one page)."""
    payload = copy.deepcopy(load_json("oracle", f"{name}_list_india_7d.json"))
    search = payload["items"][0]
    search["TotalJobsCount"] = len(search["requisitionList"]) if total is None else total
    return payload


def synthetic_page(count, start, country="IN", posted="2026-10-09", total=0):
    jobs = [{"Id": str(start + i), "Title": f"Engineer {start + i}", "PostedDate": posted,
             "PrimaryLocation": "Bengaluru, Karnataka, India" if country == "IN" else "Austin, TX, United States",
             "PrimaryLocationCountry": country, "secondaryLocations": []} for i in range(count)]
    return {"items": [{"TotalJobsCount": total, "requisitionList": jobs}], "count": 1, "hasMore": False}


def offset_of(url):
    return int(re.search(r"offset=(\d+)", url).group(1))


class OracleTest(unittest.TestCase):
    def test_parse_board(self):
        self.assertEqual(parse_board("https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/1"),
                         {"host": "jpmc.fa.oraclecloud.com", "site": "CX_1001"})
        self.assertEqual(parse_board("https://careers.honeywell.com/en/sites/Honeywell"),
                         {"page": "https://careers.honeywell.com/en/sites/Honeywell"})
        self.assertIsNone(parse_board("careers.honeywell.com"))
        self.assertIsNone(parse_board("not a url"))

    def test_rows_with_detail(self):
        session = (FakeSession()
                   .add("GET", LIST_RE, json=listing("jpmc"))
                   .add("GET", DETAIL_RE + r".*%22210771474%22", json=load_json("oracle", "jpmc_detail_210771474.json"))
                   .add("GET", DETAIL_RE, status=404, text="{}"))
        result = run_offline(OracleAdapter(), JPMC, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual((result.found, result.parsed, result.india, len(result.rows)), (3, 3, 3, 3))
        assert_rows_valid(self, result.rows, "oracle", today=TODAY)
        self.assertEqual((result.details_fetched, result.details_failed), (1, 2))
        row = next(row for row in result.rows if row["job_id"] == "210771474")
        self.assertEqual(row["title"], "Software Engineer III - Python and React")
        self.assertEqual(row["job_url"], "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001"
                                         "/job/210771474")
        self.assertEqual(row["company_url"], "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/"
                                             "CX_1001/requisitions")
        self.assertEqual(row["location"], "Mumbai, Maharashtra, India")
        self.assertEqual(row["posted_date"], "09/10/2026")
        self.assertTrue(row["description"].startswith("We have an exciting and rewarding opportunity"))
        self.assertEqual(row["employment_type"], "Full-time")
        self.assertEqual(row["job_function"], "Software Engineering")
        # a failed detail leaves the description empty (not the list teaser), so a later run fetches it again
        other = next(row for row in result.rows if row["job_id"] == "210779073")
        self.assertEqual(other["description"], "")
        self.assertEqual(result.missing_descriptions, 2)

        list_url = next(url for url in session.urls("GET") if "recruitingCEJobRequisitions?" in url)
        self.assertIn("finder=findReqs;siteNumber=CX_1001,facetsList=LOCATIONS;POSTING_DATES,limit=100,offset=0,"
                      "sortBy=POSTING_DATES_DESC,location=India,selectedPostingDatesFacet=7", list_url)
        self.assertIn("expand=requisitionList.secondaryLocations", list_url)
        detail_url = next(url for url in session.urls("GET") if "%22210771474%22" in url)
        self.assertIn("finder=ById;Id=%22210771474%22,siteNumber=CX_1001", detail_url)

    def test_secondary_locations_and_workplace(self):
        session = (FakeSession().add("GET", LIST_RE, json=listing("nokia"))
                   .add("GET", DETAIL_RE + r".*%2241278%22", json=load_json("oracle", "nokia_detail_41278.json"))
                   .add("GET", DETAIL_RE, status=404, text="{}"))
        company = {"name": "Nokia", "api_url": "https://fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/"
                                               "CandidateExperience/en/sites/CX_1"}
        result = run_offline(OracleAdapter(), company, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        rows = {row["job_id"]: row for row in result.rows}
        self.assertEqual(rows["41355"]["location"], "India; Portugal (Hybrid)")  # India primary, Portugal secondary
        self.assertEqual(rows["41278"]["location"], "India (Onsite)")
        self.assertEqual(rows["41278"]["employment_type"], "Full-time")
        self.assertEqual(rows["41278"]["job_function"], "Applied R&D")

    def test_empty_external_description_falls_back_to_the_teaser(self):
        listing_payload = listing("honeywell")
        session = (FakeSession().add("GET", LIST_RE, json=listing_payload)
                   .add("GET", DETAIL_RE + r".*%22158797%22", json=load_json("oracle", "honeywell_detail_158797.json"))
                   .add("GET", DETAIL_RE, status=404, text="{}"))
        company = {"name": "Honeywell", "slug": "CX_1", "api_url": "https://ibqbjb.fa.ocs.oraclecloud.com"}
        result = run_offline(OracleAdapter(), company, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        row = next(row for row in result.rows if row["job_id"] == "158797")
        self.assertTrue(row["description"].startswith("As a Sr Channel Sales Rep"), row["description"][:80])
        self.assertNotIn("pure-play automation", row["description"])  # the company blurb is not the job
        self.assertEqual(row["location"], "Gurugram, Haryana, India (Hybrid)")

    def test_pagination_by_total(self):
        def responder(_method, url, _kwargs):
            from harness import FakeResponse
            start = offset_of(url)
            return FakeResponse(json_body=synthetic_page(100 if start == 0 else 50, start, total=150))

        session = FakeSession().add("GET", LIST_RE, responder=responder).add("GET", DETAIL_RE, status=404, text="{}")
        result = run_offline(OracleAdapter(), JPMC, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.found, 150)
        self.assertEqual([offset_of(url) for url in session.urls() if "recruitingCEJobRequisitions?" in url], [0, 100])

    def test_location_filter_ignored_by_the_tenant_stops_paging(self):
        session = FakeSession().add("GET", LIST_RE, json=synthetic_page(100, 0, country="US", total=2324))
        result = run_offline(OracleAdapter(), JPMC, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual((result.found, result.india, len(result.rows)), (100, 0, 0))
        self.assertEqual(len([url for url in session.urls() if "recruitingCEJobRequisitions?" in url]), 1)

    def test_old_page_stops_paging(self):
        session = (FakeSession().add("GET", LIST_RE, json=synthetic_page(100, 0, posted="2026-09-01", total=900))
                   .add("GET", DETAIL_RE, status=404, text="{}"))
        result = run_offline(OracleAdapter(), JPMC, session, today=TODAY)
        self.assertEqual((result.found, len(result.rows)), (100, 0))
        self.assertEqual(len([url for url in session.urls() if "recruitingCEJobRequisitions?" in url]), 1)

    def test_wider_window_uses_the_30_day_facet(self):
        session = FakeSession().add("GET", LIST_RE, json=synthetic_page(0, 0))
        run_offline(OracleAdapter(), JPMC, session, today=TODAY, max_days=30)
        self.assertIn("selectedPostingDatesFacet=30", session.urls()[-1])

    def test_vanity_domain_discovery(self):
        page = ('<html><body><div id="root" data-apibaseurl="https://ibqbjb.fa.ocs.oraclecloud.com:443" '
                'data-sitenumber="CX_1" data-vanitybaseurl="https://careers.honeywell.com/"></div></body></html>')
        session = (FakeSession()
                   .add("GET", r"^https://careers\.honeywell\.com/en/sites/Honeywell$", text=page)
                   .add("GET", r"^https://ibqbjb\.fa\.ocs\.oraclecloud\.com/hcmRestApi/.*" + LIST_RE[:-2],
                        json=listing("honeywell"))
                   .add("GET", DETAIL_RE, status=404, text="{}"))
        company = {"name": "Honeywell", "slug": "", "api_url": "https://careers.honeywell.com/en/sites/Honeywell"}
        result = run_offline(OracleAdapter(), company, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(len(result.rows), 3)
        self.assertIn("siteNumber=CX_1,", next(url for url in session.urls() if "Requisitions?" in url))
        self.assertEqual(result.rows[0]["company_url"], "https://careers.honeywell.com/en/sites/Honeywell")
        self.assertTrue(result.rows[0]["job_url"].startswith(
            "https://ibqbjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/"))

    def test_page_without_oracle_attributes_fails(self):
        session = FakeSession().add("GET", r"careers\.example\.com", text="<html><body>Careers</body></html>")
        result = run_offline(OracleAdapter(), {"name": "X", "api_url": "https://careers.example.com/jobs"}, session)
        self.assertFalse(result.ok)
        self.assertIn("not an Oracle Recruiting career site", result.error)

    def test_waf_block_fails_the_company(self):
        session = FakeSession().add("GET", LIST_RE, status=403, text="W4S-402: Blocked by WAF4SaaS",
                                    headers={"Content-Type": "text/plain"})
        result = run_offline(OracleAdapter(), JPMC, session, today=TODAY)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "HTTP 403 blocked by the site's bot protection")

    def test_identify(self):
        adapter = OracleAdapter()
        with self.assertRaisesRegex(ScrapeFailed, "^Missing Oracle Recruiting board URL$"):
            adapter.identify({"slug": "", "api_url": ""})
        with self.assertRaisesRegex(ScrapeFailed, "^Unable to derive Oracle Recruiting board$"):
            adapter.identify({"slug": "CX_1", "api_url": ""})
        self.assertEqual(adapter.identify({"slug": "CX_1001", "api_url": "https://jpmc.fa.oraclecloud.com"}),
                         {"host": "jpmc.fa.oraclecloud.com", "site": "CX_1001"})


if __name__ == "__main__":
    unittest.main()
