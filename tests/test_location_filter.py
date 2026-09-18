import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from scraper.location_Filter import LocationFilter


class LocationFilterTests(unittest.TestCase):
    def test_filters_india_locations(self):
        location_filter = LocationFilter('India')
        jobs = [
            {'location': 'Bengaluru, KA'},
            {'location': 'Remote'},
            {'location': 'New York, NY'},
            {'location': 'London, UK'},
        ]

        filtered = location_filter.filter(jobs)

        self.assertEqual(len(filtered), 2)
        self.assertEqual([job['location'] for job in filtered], ['Bengaluru, KA', 'Remote'])

    def test_keeps_remote_when_target_is_india(self):
        location_filter = LocationFilter('India')
        jobs = [{'location': 'Remote - India'}]

        filtered = location_filter.filter(jobs)

        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]['location'], 'Remote - India')


if __name__ == '__main__':
    unittest.main()
