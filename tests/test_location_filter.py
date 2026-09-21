import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from scraper.workday.main import Scraper as WorkdayScraper
from scraper.greenhouse.main import Scraper as GreenhouseScraper


class ScraperLocationFilterTests(unittest.TestCase):
    def test_workday_filters_india_locations(self):
        scraper = WorkdayScraper({'id': 1, 'name': 'Demo', 'user_skills': [], 'location_filter': 'India'})
        jobs = [
            {'location': 'Bengaluru, KA'},
            {'location': 'Remote - India'},
            {'location': 'New York, NY'},
            {'location': 'London, UK'},
            {'location': 'Remote'},
        ]

        filtered = scraper._filter_by_location(jobs)

        self.assertEqual(len(filtered), 2)
        self.assertEqual([job['location'] for job in filtered], ['Bengaluru, KA', 'Remote - India'])

    def test_greenhouse_keeps_remote_when_target_is_india(self):
        scraper = GreenhouseScraper({'id': 2, 'name': 'Demo', 'user_skills': [], 'location_filter': 'India'})
        jobs = [{'location': 'Remote - India'}, {'location': 'Remote'}]

        filtered = scraper._filter_by_location(jobs)

        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]['location'], 'Remote - India')

    def test_scrapers_filter_recent_dates_only(self):
        workday = WorkdayScraper({'id': 3, 'name': 'Demo', 'user_skills': [], 'location_filter': 'India', 'date_filter': ['today', 'yesterday', '1 day']})
        greenhouse = GreenhouseScraper({'id': 4, 'name': 'Demo', 'user_skills': [], 'location_filter': 'India', 'date_filter': ['today', 'yesterday', '1 day', '2 days', '3 days']})

        jobs = [
            {'posted_date': 'Today'},
            {'posted_date': '2 days ago'},
            {'posted_date': '30+ days ago'},
        ]

        self.assertEqual(len(workday._filter_by_posted_date(jobs)), 1)
        self.assertEqual(len(greenhouse._filter_by_posted_date(jobs)), 2)


if __name__ == '__main__':
    unittest.main()
