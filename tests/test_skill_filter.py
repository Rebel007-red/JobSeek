import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from scraper.skill_Filter import SkillFilter


class SkillFilterTests(unittest.TestCase):
    def test_extracts_2_plus_years_and_keeps_skill_matching_compatible(self):
        skill_filter = SkillFilter(['python', 'sql'])
        jobs = [{
            'title': 'Senior Data Engineer',
            'description': 'We are looking for a candidate with 2-5 years of experience in Python and SQL. Must have strong data modeling skills.',
        }]

        filtered = skill_filter.filter(jobs)

        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]['experience_years'], 2)
        self.assertEqual(filtered[0]['experience_text'], '2-5 years')
        self.assertIn('python', filtered[0]['matched_skills'])
        self.assertIn('sql', filtered[0]['matched_skills'])

    def test_keeps_current_app_behavior_when_experience_is_below_2_years(self):
        skill_filter = SkillFilter(['python'])
        jobs = [{
            'title': 'Data Engineer',
            'description': 'Build ETL pipelines and handle data warehousing. 1 year of experience preferred.',
        }]

        filtered = skill_filter.filter(jobs)

        self.assertEqual(len(filtered), 1)
        self.assertNotIn('experience_years', filtered[0])


if __name__ == '__main__':
    unittest.main()
