"""SAP SuccessFactors (Career Site Builder) adapter against recorded HTML snippets (no network)."""
import re
import unittest
from datetime import date

from harness import FakeResponse, FakeSession, assert_rows_valid, load_text, run_offline

from ats.successfactors import SuccessFactorsAdapter, date_order, list_date, location_countries, parse_search_page
from scraper_common import ScrapeFailed

TODAY = date(2026, 10, 9)
BIRLASOFT = {"name": "Birlasoft", "ats_type": "successfactors", "slug": "jobs.birlasoft.com",
             "api_url": "https://jobs.birlasoft.com"}
SEARCH_RE = r"/search/\?q=&sortColumn=referencedate&sortDirection=desc&startrow="


def table_page(total, rows, start=0):
    """A table-template search page: rows = [(job_id, title, location, 'Oct 9, 2026'), ...]."""
    body = [f'<span class="paginationLabel">Results <b>{start + 1} – {start + len(rows)}</b> of <b>{total}</b></span>',
            "<table>"]
    for job_id, title, location, posted in rows:
        body.append(f'<tr class="data-row"><td class="colTitle"><a class="jobTitle-link" href="/job/X-{job_id}/{job_id}/">'
                    f'{title}</a></td><td class="colDepartment"><span class="jobDepartment">Engineering</span></td>'
                    f'<td class="colLocation"><span class="jobLocation">{location}</span></td>'
                    f'<td class="colDate"><span class="jobDate">{posted}</span></td></tr>')
    body.append("</table>")
    return "<html><body>" + "\n".join(body) + "</body></html>"


def detail_page(posted="Fri Oct 09 02:00:00 UTC 2026", country="IN", locality="Bengaluru", text="Build things."):
    return ('<div class="jobDisplayShell" itemscope="itemscope" itemtype="http://schema.org/JobPosting">'
            '<span itemprop="jobLocation"><span itemprop="address">'
            f'<meta itemprop="addressLocality" content="{locality}"><meta itemprop="addressCountry" content="{country}">'
            f'</span></span><meta itemprop="datePosted" content="{posted}">'
            f'<span itemprop="description"><span class="jobdescription"><p>{text}</p></span></span></div>')


def startrow(url):
    return int(re.search(r"startrow=(\d+)", url).group(1))


class ParsingTest(unittest.TestCase):
    def test_table_template(self):
        total, rows = parse_search_page(load_text("successfactors", "birlasoft_table_search_snippet.html"))
        self.assertEqual(total, 601)
        self.assertEqual(rows[0], {"href": "/job/Bengaluru-SAP-FICO-ARIBA-Functional-Subcontractor-INDI/59646544/",
                                   "title": "SAP FICO ARIBA Functional Subcontractor",
                                   "location": "INDIA - BENGALURU - HP, IN", "date": "Oct 9, 2026",
                                   "department": "Enterprise Applications"})
        self.assertEqual(len(rows), 2)

    def test_tile_template(self):
        total, rows = parse_search_page(load_text("successfactors", "cargill_tile_search_snippet.html"))
        self.assertEqual(total, 67)
        self.assertEqual(rows[0]["href"], "/job/Bangalore-Sr_-Consultant%2C-Enterprise-Mobility-Karn-560087/1364525157/")
        self.assertEqual(rows[0]["title"], "Sr. Consultant, Enterprise Mobility")
        self.assertEqual(rows[0]["location"], "Bangalore, Karnataka, IN India, 560087")
        self.assertEqual(rows[0]["date"], "Oct 9, 2026")

    def test_minimal_tiles_have_no_date(self):
        total, rows = parse_search_page(load_text("successfactors", "airindia_minimal_search_snippet.html"))
        self.assertEqual(total, 17)
        self.assertEqual(rows[0]["title"], "B737 Type Rated Co-Pilots (First Officer / Senior First Officer)")
        self.assertEqual((rows[0]["location"], rows[0]["date"], rows[0]["department"]), ("Gurugram", "", "Operations"))
        self.assertEqual(len(rows), 2)

    def test_brand_sub_path_job_link(self):
        posting = SuccessFactorsAdapter().parse({"href": "/aix/job/_-Manager-Route-Revenue/60495444/",
                                                 "title": "Manager - Route Revenue"}, {"host": "careers.airindia.com"},
                                                None)
        self.assertEqual(posting.job_id, "60495444")
        self.assertEqual(posting.job_url, "https://careers.airindia.com/aix/job/_-Manager-Route-Revenue/60495444/")
        self.assertTrue(posting.needs_detail)
        self.assertIsNone(posting.posted_on)

    def test_location_countries(self):
        self.assertEqual(location_countries("INDIA - BENGALURU - HP, IN"), ["IN"])
        self.assertEqual(location_countries("Noida, IN"), ["IN"])
        self.assertEqual(location_countries("Fort Wayne, IN, US"), ["US"])  # Indiana, not India
        self.assertEqual(location_countries("Bangalore, Karnataka, IN India, 560087"), ["IN"])
        self.assertEqual(location_countries("Fort Wayne, Indiana, US United States, 46802"), ["US"])
        self.assertEqual(location_countries("Chennai, TN, IN"), ["IN"])
        # 'City, IN' with a city that is no known Indian place: Indiana unless the board was read with the facet
        self.assertEqual(location_countries("Indianapolis, IN"), [])
        self.assertEqual(location_countries("Indianapolis, IN", india_facet=True), ["IN"])
        self.assertEqual(location_countries(""), [])

    def test_numeric_date_order(self):
        self.assertEqual(date_order(["Oct 9, 2026", "10/09/2026", "10/13/2026"]), "mdy")
        self.assertEqual(date_order(["13/10/2026"]), "dmy")
        self.assertIsNone(date_order(["10/09/2026", "Oct 9, 2026"]))
        self.assertEqual(list_date("10/09/2026", "mdy"), date(2026, 10, 9))
        self.assertEqual(list_date("10/09/2026"), date(2026, 9, 10))  # unknown order, no today: day-first
        self.assertEqual(list_date("10/09/2026", today=TODAY), date(2026, 10, 9))  # the latest reading
        self.assertEqual(list_date("09/10/2026", today=TODAY), date(2026, 10, 9))
        self.assertEqual(list_date("10/11/2026", today=TODAY), date(2026, 10, 11))  # Nov 10 is in the future
        self.assertEqual(list_date("13/10/2026", today=TODAY), date(2026, 10, 13))


class SuccessFactorsTest(unittest.TestCase):
    def test_small_board_is_read_unfiltered_and_details_fill_dates(self):
        snippet = load_text("successfactors", "airindia_minimal_search_snippet.html").replace("of 17 Jobs", "of 2 Jobs")
        detail_html = load_text("successfactors", "birlasoft_detail_59646544_snippet.html")
        old = detail_page(posted="Mon Aug 03 02:00:00 UTC 2026", country="No", locality="Gurugram")
        session = (FakeSession()
                   .add("GET", r"careers\.airindia\.com" + SEARCH_RE + "0$", text=snippet)
                   .add("GET", r"/52871144/$", text=detail_html.replace("Bengaluru", "Gurugram"))
                   .add("GET", r"/60542344/$", text=old))
        company = {"name": "Air India", "slug": "careers.airindia.com", "api_url": "https://careers.airindia.com"}
        result = run_offline(SuccessFactorsAdapter(), company, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        searches = [url for url in session.urls() if "/search/" in url]
        self.assertEqual(len(searches), 1)
        self.assertNotIn("optionsFacetsDD_country", searches[0])
        self.assertEqual((result.found, result.details_fetched), (2, 2))
        assert_rows_valid(self, result.rows, "successfactors", today=TODAY)
        self.assertEqual(len(result.rows), 1)  # the apprentice job was posted in August
        row = next(row for row in result.rows if row["job_id"] == "52871144")
        self.assertEqual(row["posted_date"], "09/10/2026")
        self.assertEqual(row["location"], "Gurugram")
        self.assertTrue(row["description"].startswith("Area(s) of responsibility"))
        self.assertEqual(row["company_url"], "https://careers.airindia.com/")
        self.assertEqual(row["job_function"], "Operations")

    def test_large_board_uses_the_country_facet_and_stops_at_old_rows(self):
        fresh = [(1000 + i, f"Engineer {i}", "INDIA - PUNE - OFFICE, IN", "Oct 9, 2026") for i in range(25)]
        mixed = ([(2000 + i, f"Analyst {i}", "Noida, IN", "Oct 5, 2026") for i in range(10)]
                 + [(3000 + i, f"Old {i}", "Noida, IN", "Sep 20, 2026") for i in range(15)])

        def search(_method, url, _kwargs):
            if "optionsFacetsDD_country=IN" not in url:
                return FakeResponse(text=table_page(639, fresh))
            return FakeResponse(text=table_page(601, fresh if startrow(url) == 0 else mixed, startrow(url)))

        session = (FakeSession().add("GET", SEARCH_RE, responder=search)
                   .add("GET", r"/job/X-", text=detail_page()))
        result = run_offline(SuccessFactorsAdapter(), BIRLASOFT, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        searches = [url for url in session.urls() if "/search/" in url]
        self.assertEqual([("optionsFacetsDD_country=IN" in url, startrow(url)) for url in searches],
                         [(False, 0), (True, 0), (True, 25)])
        self.assertEqual(result.found, 50)
        self.assertEqual(len(result.rows), 35)
        self.assertEqual(result.details_fetched, 35)  # old rows get no detail fetch
        assert_rows_valid(self, result.rows, "successfactors", today=TODAY)
        self.assertEqual(result.rows[0]["job_url"], "https://jobs.birlasoft.com/job/X-1000/1000/")
        self.assertEqual(result.rows[0]["job_function"], "Engineering")
        self.assertEqual(result.rows[0]["description"], "Build things.")

    def test_indiana_is_not_india(self):
        rows = [(1, "A", "Fort Wayne, IN, US", "Oct 9, 2026"), (2, "B", "Noida, IN", "Oct 9, 2026"),
                (3, "C", "London, GB", "Oct 9, 2026")]
        session = (FakeSession().add("GET", SEARCH_RE + "0$", text=table_page(3, rows))
                   .add("GET", r"/job/X-2/2/", text=detail_page())
                   .add("GET", r"/job/", text=detail_page(country="US")))
        result = run_offline(SuccessFactorsAdapter(), BIRLASOFT, session, today=TODAY)
        self.assertEqual([row["job_id"] for row in result.rows], ["2"])
        self.assertEqual(result.india, 1)

    def test_not_a_career_site_and_unknown_template(self):
        session = FakeSession().add("GET", SEARCH_RE, text="<html><body>Our new jobs app</body></html>")
        result = run_offline(SuccessFactorsAdapter(), {"name": "SAP", "api_url": "https://jobs.sap.com"}, session)
        self.assertFalse(result.ok)
        self.assertIn("not an SAP SuccessFactors career site", result.error)
        session = FakeSession().add("GET", SEARCH_RE, text='<span class="paginationLabel">Results 1 – 25 of 50</span>')
        result = run_offline(SuccessFactorsAdapter(), BIRLASOFT, session)
        self.assertFalse(result.ok)
        self.assertIn("unrecognised SuccessFactors page", result.error)

    def test_indianapolis_on_an_unfiltered_board_is_decided_by_the_detail(self):
        rows = [(1, "A", "Indianapolis, IN", "Oct 9, 2026"), (2, "B", "Bawal, IN", "Oct 9, 2026")]
        session = (FakeSession().add("GET", SEARCH_RE + "0$", text=table_page(2, rows))
                   .add("GET", r"/job/X-1/1/", text=detail_page(country="US", locality="Indianapolis"))
                   .add("GET", r"/job/X-2/2/", text=detail_page(country="IN", locality="Bawal")))
        result = run_offline(SuccessFactorsAdapter(), BIRLASOFT, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual([row["job_id"] for row in result.rows], ["2"])
        self.assertTrue(result.rows[0]["location"].startswith("India; Bawal"))

    def test_month_first_site_does_not_stop_early(self):
        # en_US numeric dates: 10/09/2026 is Oct 9 (day-first would read Sep 10 and stop after page 1)
        page1 = [(i, f"Job {i}", "Pune, IN", "10/09/2026") for i in range(25)]
        page2 = [(100 + i, f"Job {i}", "Pune, IN", "10/08/2026") for i in range(5)]

        def search(_method, url, _kwargs):
            return FakeResponse(text=table_page(30, page1 if startrow(url) == 0 else page2, startrow(url)))

        session = (FakeSession().add("GET", SEARCH_RE, responder=search)
                   .add("GET", r"/job/X-", text=detail_page()))
        result = run_offline(SuccessFactorsAdapter(), BIRLASOFT, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.found, 30)
        self.assertEqual(len(result.rows), 30)

    def test_empty_country_facet_falls_back_to_the_unfiltered_board(self):
        fresh = [(1000 + i, f"Engineer {i}", "Gurugram", "Oct 9, 2026") for i in range(25)]
        older = [(2000 + i, f"Old {i}", "Gurugram", "Sep 1, 2026") for i in range(25)]

        def search(_method, url, _kwargs):
            if "optionsFacetsDD_country=IN" in url:
                return FakeResponse(text=table_page(0, []))
            return FakeResponse(text=table_page(400, fresh if startrow(url) == 0 else older, startrow(url)))

        session = (FakeSession().add("GET", SEARCH_RE, responder=search)
                   .add("GET", r"/job/X-", text=detail_page(locality="Gurugram")))
        result = run_offline(SuccessFactorsAdapter(), BIRLASOFT, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        searches = [url for url in session.urls() if "/search/" in url]
        self.assertEqual([("optionsFacetsDD_country=IN" in url, startrow(url)) for url in searches],
                         [(False, 0), (True, 0), (False, 25)])
        self.assertEqual(len(result.rows), 25)

    def test_repeated_page_stops(self):
        rows = [(i, f"Job {i}", "Pune, IN", "Oct 9, 2026") for i in range(25)]
        session = (FakeSession().add("GET", SEARCH_RE, text=table_page(100, rows))
                   .add("GET", r"/job/", text=detail_page()))
        result = run_offline(SuccessFactorsAdapter(), BIRLASOFT, session, today=TODAY)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.found, 25)
        self.assertEqual(len([url for url in session.urls() if "/search/" in url]), 2)

    def test_identify(self):
        adapter = SuccessFactorsAdapter()
        with self.assertRaisesRegex(ScrapeFailed, "^Missing SAP SuccessFactors board URL$"):
            adapter.identify({"slug": "", "api_url": None})
        with self.assertRaisesRegex(ScrapeFailed, "^Unable to derive SAP SuccessFactors board$"):
            adapter.identify({"slug": "", "api_url": "https://career44.sapsf.com/career?company=birlasoftl"})
        self.assertEqual(adapter.identify({"slug": "https://jobs.cargill.com/search/?q="}), {"host": "jobs.cargill.com"})


if __name__ == "__main__":
    unittest.main()
