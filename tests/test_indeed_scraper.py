import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from scraper.indeed.main import Scraper


class IndeedScraperTests(unittest.TestCase):
    def test_build_search_url_from_keywords(self):
        company = {"name": "Test Company", "id": 42, "api_url": "data engineer, pyspark", "user_skills": []}
        scraper = Scraper(company)
        self.assertIn("indeed.com/jobs", scraper.search_url)
        self.assertIn("q=data+engineer%2C+pyspark", scraper.search_url)
        self.assertIn("l=India", scraper.search_url)

    def test_parse_indeed_jobs_from_html(self):
        html = '''
        <div id="mosaic-provider-jobcards">
          <div class="job_seen_beacon">
            <a class="jcs-JobTitle" href="/viewjob?jk=abc123">Data Engineer</a>
            <span class="companyName">Acme Corp</span>
            <div class="companyLocation">Bengaluru, KA</div>
            <span class="date">2 days ago</span>
          </div>
        </div>
        '''
        company = {"name": "Test Company", "id": 42, "api_url": "data engineer", "user_skills": []}
        scraper = Scraper(company)
        jobs = scraper._parse_indeed_jobs(html)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["job_id"], "abc123")
        self.assertEqual(jobs[0]["title"], "Data Engineer")
        self.assertEqual(jobs[0]["company"], "Acme Corp")
        self.assertEqual(jobs[0]["location"], "Bengaluru, KA")

    def test_parse_indeed_jobs_from_live_dom(self):
        html = '''
        <div class="cardOutline tapItem result job_8b5dcb8b4007f7b4">
          <div class="job_seen_beacon">
            <table class="mainContentTable">
              <tbody>
                <tr>
                  <td class="resultContent">
                    <h3 class="jobTitle">
                      <a id="job_8b5dcb8b4007f7b4" class="jcs-JobTitle" href="/rc/clk?jk=8b5dcb8b4007f7b4&amp;bb=abc">
                        <span title="Data Engineer">Data Engineer</span>
                      </a>
                    </h3>
                    <div class="company_location">
                      <div>
                        <span data-testid="company-name" class="css-19eicqx">EXL Service</span>
                      </div>
                      <div data-testid="text-location" class="css-1f06pz4">Noida, Uttar Pradesh</div>
                    </div>
                    <span class="date">2 days ago</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        '''
        company = {"name": "Test Company", "id": 42, "api_url": "data engineer", "user_skills": []}
        scraper = Scraper(company)
        jobs = scraper._parse_indeed_jobs(html)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["job_id"], "8b5dcb8b4007f7b4")
        self.assertEqual(jobs[0]["title"], "Data Engineer")
        self.assertEqual(jobs[0]["company"], "EXL Service")
        self.assertEqual(jobs[0]["location"], "Noida, Uttar Pradesh")


if __name__ == "__main__":
    unittest.main()
