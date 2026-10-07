"""app.user_jobs against the Python reference (scoring_reference.py) on the fixture jobs."""
from decimal import Decimal

from base import (CR_ACTIVE, CUSTOM_ROLES, FIXTURE_KEYS, JOBS, JOB_BY_NAME, KEY, PROFILES, REF_ROLES, ROLE_SIMILARITY,
                  SKILL_STATS, STATE, U_FALLBACK, U_MAIN, U_NOPROFILE, DbTestCase)
from scoring_reference import fit_score_of, half_up, user_jobs

SCORE_COLUMNS = ["job_key", "fit_score", "fit_role", "fit_skills", "fit_experience", "role_match", "above_experience",
                 "fit_matched_skills", "is_applied", "is_hidden"]


class ScoringTest(DbTestCase):
    def scored(self, uid):
        rows = self.rows(f"SELECT {', '.join(SCORE_COLUMNS)} FROM app.user_jobs(%s) WHERE job_key = ANY(%s)",
                         [uid, FIXTURE_KEYS])
        return {row[0]: dict(zip(SCORE_COLUMNS, row)) for row in rows}

    def assert_matches_reference(self, uid, expected=None):
        actual = self.scored(uid)
        expected = expected or self.reference(uid)
        self.assertEqual(set(actual), set(expected))
        for job_key, exp in expected.items():
            got = actual[job_key]
            with self.subTest(job=job_key[:8], user=uid[-2:]):
                self.assertEqual(got["fit_score"], exp["fit_score"])
                self.assertEqual(got["fit_role"], exp["fit_role"])  # exact: same double operations
                self.assertEqual(got["fit_skills"], exp["fit_skills"])
                self.assertEqual(Decimal(got["fit_experience"]), exp["fit_experience"])
                self.assertEqual(got["role_match"], exp["role_match"])
                self.assertEqual(got["above_experience"], exp["above_experience"])
                self.assertEqual(got["fit_matched_skills"], exp["fit_matched_skills"])
                self.assertEqual(got["is_applied"], exp["is_applied"])
                self.assertEqual(got["is_hidden"], exp["is_hidden"])
        return actual, expected

    def test_main_user_matches_reference(self):
        _, expected = self.assert_matches_reference(U_MAIN)
        branches = {exp["branch"] for exp in expected.values()}
        self.assertTrue({"rank1", "rank2", "title", "related"} <= branches, branches)

    def test_fallback_user_matches_reference(self):
        _, expected = self.assert_matches_reference(U_FALLBACK)
        self.assertEqual(expected[KEY["alternative"]]["branch"], "alternative")
        self.assertEqual(expected[KEY["category"]]["branch"], "category")

    def test_no_profile_user_matches_reference(self):
        actual, _ = self.assert_matches_reference(U_NOPROFILE)
        for row in actual.values():
            self.assertEqual(row["fit_role"], 0.0)
            self.assertEqual(row["fit_skills"], 0.0)
            self.assertFalse(row["role_match"])
            self.assertEqual(row["fit_matched_skills"], [])

    def test_role_branches(self):
        main = self.scored(U_MAIN)
        self.assertEqual(main[KEY["rank1"]]["fit_role"], 1.0)  # mapped custom role -> its duplicate, first role
        self.assertEqual(main[KEY["rank2"]]["fit_role"], 0.95)
        self.assertEqual(main[KEY["title"]]["fit_role"], 0.9)
        # related via the second role at sim 0.86: 0.95 * 0.85 * 1, a match
        self.assertAlmostEqual(main[KEY["related_match"]]["fit_role"], 0.8075, places=12)
        self.assertTrue(main[KEY["related_match"]]["role_match"])
        # related via the first role at 0.80: 0.85 * 0.05 / 0.11, no match
        self.assertAlmostEqual(main[KEY["related_low"]]["fit_role"], 0.85 * (0.80 - 0.75) / 0.11, places=12)
        self.assertFalse(main[KEY["related_low"]]["role_match"])
        # related roles ready: the alternative role and the category no longer count
        self.assertEqual(main[KEY["related_none"]]["fit_role"], 0.0)
        self.assertFalse(main[KEY["related_none"]]["role_match"])
        fallback = self.scored(U_FALLBACK)
        self.assertEqual(fallback[KEY["alternative"]]["fit_role"], 0.5)
        self.assertTrue(fallback[KEY["alternative"]]["role_match"])
        self.assertEqual(fallback[KEY["category"]]["fit_role"], 0.3)
        self.assertTrue(fallback[KEY["category"]]["role_match"])

    def test_skill_parts(self):
        main = self.scored(U_MAIN)
        # idf weighting: spark 1.25 + sql 0.4 + group cloud 2.1 matched of 1.25 + 0.4 + 2.1 + unseen 3 (4 skills)
        self.assertEqual(main[KEY["rank1"]]["fit_matched_skills"], ["Zz Fixture Spark", "Zz Fixture SQL", "Zz Fixture Cloud"])
        self.assertEqual(main[KEY["rank1"]]["fit_skills"], ((1.25 + 0.4) + 2.1) / ((((1.25 + 0.4) + 2.1) + 3.0) * 4.0 / 4.0))
        # an unseen skill weighs 3
        self.assertEqual(main[KEY["level"]]["fit_skills"], 3.0 / 6.75)
        # no skills found on the job: neutral 0.3
        self.assertEqual(main[KEY["related_match"]]["fit_skills"], 0.3)
        # fewer than 3 profile skills: scaled as if 3 (0.9 / (0.9 * 3))
        fallback = self.scored(U_FALLBACK)
        self.assertEqual(fallback[KEY["alternative"]]["fit_skills"], 0.9 / (0.9 * 3.0 / 1.0))
        # no profile skills at all
        self.assertEqual(self.scored(U_NOPROFILE)[KEY["rank1"]]["fit_skills"], 0.0)

    def test_experience_parts(self):
        main = self.scored(U_MAIN)
        self.assertEqual(Decimal(main[KEY["rank1"]]["fit_experience"]), Decimal("1.0"))     # 3-6 vs 2-5
        self.assertEqual(Decimal(main[KEY["rank2"]]["fit_experience"]), Decimal("0.1"))     # 8 vs max 5
        self.assertTrue(main[KEY["rank2"]]["above_experience"])                             # 8 > 5 + 2
        self.assertEqual(Decimal(main[KEY["below"]]["fit_experience"]), Decimal("0.85"))    # 0-1 vs min 2
        self.assertEqual(Decimal(main[KEY["halfup"]]["fit_experience"]), Decimal("0.7"))    # unknown
        self.assertEqual(Decimal(main[KEY["level"]]["fit_experience"]), Decimal("1.0"))     # Junior = 1-4
        self.assertFalse(main[KEY["related_low"]]["above_experience"])
        # profile without years: every known experience is fine
        fallback = self.scored(U_FALLBACK)
        self.assertEqual(Decimal(fallback[KEY["category"]]["fit_experience"]), Decimal("1.0"))
        self.assertFalse(fallback[KEY["rank2"]]["above_experience"])

    def test_half_up_rounding(self):
        raw, score = fit_score_of(0.0, 0.0, Decimal("0.7"))
        self.assertEqual(repr(raw), "10.5")
        self.assertEqual(score, 11)  # Python's round() would give 10
        self.assertEqual(self.scored(U_MAIN)[KEY["halfup"]]["fit_score"], 11)
        # rank1 + no skills matched + unknown experience: 100 * (0.4 + 0.105) = 50.5 -> 51
        self.assertEqual(half_up(fit_score_of(1.0, 0.0, Decimal("0.7"))[0]), 51)
        self.assertEqual(self.value("SELECT app.round_half_up(50.5::float8)"), 51)
        self.assertEqual(self.value("SELECT app.round_half_up(64.49999999999999::float8)"), 64)
        self.assertEqual(self.value("SELECT app.round_half_up(0.0::float8)"), 0)

    def test_states_are_per_user(self):
        main = self.scored(U_MAIN)
        self.assertTrue(main[KEY["rank2"]]["is_applied"])
        self.assertFalse(main[KEY["rank1"]]["is_applied"])  # applied by U_OTHER only
        self.assertTrue(main[KEY["hidden"]]["is_hidden"])
        self.assertFalse(main[KEY["below"]]["is_hidden"])   # hidden by U_OTHER only

    def test_profile_edits_change_scores(self):
        self.sql("UPDATE app.user_profile SET target_roles = %s WHERE profile_id = %s", [[CR_ACTIVE], U_MAIN])
        main = self.scored(U_MAIN)
        # no similarity rows for the active custom role: the alternative role counts again
        self.assertEqual(main[KEY["alternative"]]["fit_role"], 0.5)
        self.assertNotIn(None, [row["fit_score"] for row in main.values()])
        self.assertEqual(PROFILES[U_MAIN]["target_roles"][1], JOB_BY_NAME["rank2"]["role_title"])

    def test_also_know_skills_match_reference(self):
        # also-know: one the jobs list (python), one already a core skill (ignored), one nobody lists (unseen idf 3)
        also = ["Zz Fixture Python", "zz fixture sql", "Zz Fixture Nowhere"]
        self.sql("UPDATE app.user_profile SET also_skills = %s WHERE profile_id = %s", [also, U_MAIN])
        expected = user_jobs(JOBS, {**PROFILES[U_MAIN], "also_skills": also}, custom_roles=CUSTOM_ROLES,
                             skill_stats=SKILL_STATS, role_similarity=ROLE_SIMILARITY,
                             ref_roles=[(r, c) for r, c, _ in REF_ROLES], state=STATE[U_MAIN])
        self.assert_matches_reference(U_MAIN, expected)
        title = self.scored(U_MAIN)[KEY["title"]]  # SQL (core) + Python (also-know)
        self.assertEqual(title["fit_matched_skills"], ["Zz Fixture SQL", "Zz Fixture Python"])
        self.assertEqual(title["fit_skills"], (0.4 + 0.9 * 0.5) / 6.75)
        # the old values without them
        self.sql("UPDATE app.user_profile SET also_skills = '{}' WHERE profile_id = %s", [U_MAIN])
        self.assertEqual(self.scored(U_MAIN)[KEY["title"]]["fit_skills"], 0.4 / 6.75)
