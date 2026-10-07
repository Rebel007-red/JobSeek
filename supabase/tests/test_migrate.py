"""databricks/jobs/migrate_user_data.py: planning rules (no database) and the writes (rolled back)."""
import datetime as dt
import sys
import unittest
from collections import Counter

from base import CR_PENDING, KEY, NOW, ROOT, U_FALLBACK, U_MAIN, U_NOPROFILE, DbTestCase

sys.path.insert(0, str(ROOT / "databricks" / "jobs"))
import migrate_user_data as m  # noqa: E402

UTC = dt.timezone.utc


def us(ts):
    return int((ts - m.EPOCH) / dt.timedelta(microseconds=1))


T1 = dt.datetime(2026, 9, 1, 10, 0, 0, 123456, tzinfo=UTC)
T2 = dt.datetime(2026, 9, 2, 10, 0, 0, tzinfo=UTC)
A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
JK = "a" * 64


class PlanTest(unittest.TestCase):
    def test_micros_round_trip(self):
        self.assertEqual(m.micros_to_ts(us(T1)), T1)
        self.assertIsNone(m.micros_to_ts(None))

    def test_profiles_newest_wins(self):
        skipped = Counter()
        rows = [
            {"profile_id": A.upper(), "email": None, "target_roles": ["Data Engineer"], "skills": ["SQL"], "updated_us": us(T1)},
            {"profile_id": A, "email": "x@y.z", "target_roles": ["ML Engineer"], "skills": ["SQL"], "updated_us": us(T2)},
            {"profile_id": B, "target_roles": ["X"], "skills": [], "updated_us": us(T1)},
            {"profile_id": "default", "target_roles": [], "skills": []},
            {"profile_id": "33333333-3333-4333-8333-333333333333", "target_roles": [], "skills": []},
        ]
        eligible, upserts = m.plan_profiles(rows, {A: "a@x.test", B: "b@x.test"}, {B: T2}, skipped)
        self.assertEqual(sorted(eligible), [A, B])
        self.assertEqual([(u["profile_id"], u["action"], u["target_roles"], u["email"]) for u in upserts],
                         [(A, "insert", ["ML Engineer"], "x@y.z")])
        self.assertEqual(skipped, Counter({"profiles: id is not a uuid": 1, "profiles: no such Supabase user": 1,
                                           "profiles: duplicate row": 1, "profiles: Supabase is newer or equal": 1}))
        # older existing row: update; email falls back to the login email
        _, upserts = m.plan_profiles(rows[2:3], {B: "b@x.test"}, {B: T1 - dt.timedelta(seconds=1)}, Counter())
        self.assertEqual((upserts[0]["action"], upserts[0]["email"], upserts[0]["preferred_cities"]), ("update", "b@x.test", []))

    def test_states(self):
        skipped = Counter()
        rows = [
            {"user_id": A, "job_key": JK, "is_applied": True, "applied_us": us(T1), "hidden_us": None, "status_us": us(T2),
             "application_status": None, "is_hidden": None},
            {"user_id": A, "job_key": "b" * 64, "is_applied": False, "hidden_us": us(T1), "is_hidden": True},
            {"user_id": B, "job_key": JK, "is_applied": True},
            {"user_id": A, "job_key": "not-a-key"},
            {"user_id": "nope", "job_key": JK},
        ]
        upserts = m.plan_states(rows, {A: "", B: ""}, {JK}, {(B, JK): m.EPOCH}, skipped)
        self.assertEqual(len(upserts), 1)
        state = upserts[0]
        self.assertEqual((state["user_id"], state["action"], state["application_status"], state["is_hidden"]),
                         (A, "insert", "applied", False))
        self.assertEqual(state["updated_at"], T2)  # latest of the three times
        self.assertEqual(skipped, Counter({"job state: job not in app.jobs": 1, "job state: Supabase is newer or equal": 1,
                                           "job state: invalid job key": 1, "job state: user id is not a uuid": 1}))

    def test_custom_roles_and_skills(self):
        skipped = Counter()
        rows = [
            {"role_title": "New Role", "status": "pending"},
            {"role_title": "Checked", "status": "active", "checked_us": us(T2)},
            {"role_title": "Stale", "status": "rejected", "checked_us": us(T1)},
            {"role_title": "Odd", "status": "weird"},
            {"role_title": "No Status", "status": None},
        ]
        changes = m.plan_custom_roles(rows, {"checked": T1, "stale": T2}, skipped)
        self.assertEqual([(c["role_title"], c["action"]) for c in changes], [("New Role", "insert"), ("Checked", "update")])
        self.assertEqual(skipped, Counter({"custom roles: unknown status": 2, "custom roles: Supabase is newer or equal": 1}))
        inserts = m.plan_custom_skills([{"skill": "dbt"}, {"skill": "DBT"}, {"skill": "Kafka"}], {"kafka"}, Counter())
        self.assertEqual([s["skill"] for s in inserts], ["dbt"])


class WriteTest(DbTestCase):
    def test_write_all_newest_wins(self):
        old = NOW - dt.timedelta(days=30)
        self.sql("UPDATE app.user_profile SET updated_at = %s WHERE profile_id = %s", [old, U_MAIN])
        profiles = [
            {"profile_id": U_MAIN, "email": "m@x.test", "target_roles": ["Zz Fixture Data Engineer"], "skills": ["SQL"],
             "min_years": 1, "max_years": 2, "preferred_cities": [], "updated_at": old + dt.timedelta(days=1), "action": "update"},
            {"profile_id": U_NOPROFILE, "email": None, "target_roles": ["Zz Fixture Data Engineer"], "skills": ["SQL"],
             "min_years": None, "max_years": None, "preferred_cities": [], "updated_at": old, "action": "insert"},
            # Supabase is newer (fixture profile updated now): the guarded upsert keeps it
            {"profile_id": U_FALLBACK, "email": None, "target_roles": ["Zz Fixture Overwrite"], "skills": ["SQL"],
             "min_years": None, "max_years": None, "preferred_cities": [], "updated_at": old, "action": "update"},
        ]
        states = [{"user_id": U_NOPROFILE, "job_key": KEY["rank1"], "is_applied": True, "applied_at": old, "is_hidden": False,
                   "hidden_at": None, "application_status": "applied", "status_updated_at": old, "updated_at": old,
                   "action": "insert"}]
        roles = [{"role_title": CR_PENDING, "status": "active", "category": "Zz Fixture Data", "description": None,
                  "duplicate_of": None, "first_user": None, "checked_by": "llm", "created_at": None, "checked_at": NOW,
                  "attempts": 3, "action": "update"},
                 {"role_title": "Zz Fixture Migrated Role", "status": "pending", "category": None, "description": None,
                  "duplicate_of": None, "first_user": None, "checked_by": None, "created_at": old, "checked_at": None,
                  "attempts": 0, "action": "insert"}]
        skills = [{"skill": "Zz Fixture Migrated Skill", "first_user": None, "created_at": old}]
        counts = m.write_all(self.conn, profiles, states, roles, skills, ["fixture.allowed@jobseeker.test"])
        self.assertEqual(counts, Counter({"profiles updated": 1, "profiles inserted": 1, "job state inserted": 1,
                                          "custom roles updated": 1, "custom roles inserted": 1,
                                          "custom skills inserted": 1, "allow-list emails added": 1}))
        self.assertEqual(self.value("SELECT max_years FROM app.user_profile WHERE profile_id = %s", [U_MAIN]), 2)
        self.assertNotEqual(self.value("SELECT target_roles FROM app.user_profile WHERE profile_id = %s", [U_FALLBACK]),
                            ["Zz Fixture Overwrite"])
        self.assertEqual(self.value("SELECT updated_at FROM app.user_job_state WHERE user_id = %s AND job_key = %s",
                                    [U_NOPROFILE, KEY["rank1"]]), old)
        self.assertEqual(self.value("SELECT status FROM app.custom_roles WHERE role_title = %s", [CR_PENDING]), "active")
        # running it again changes nothing
        again = m.write_all(self.conn, profiles, states, roles, skills, ["fixture.allowed@jobseeker.test"])
        self.assertEqual(sum(again.values()), 0)
