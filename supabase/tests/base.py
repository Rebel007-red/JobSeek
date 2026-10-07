"""Shared helpers for the Supabase tests (python -m unittest discover -s supabase/tests -v).

Target: TEST_DATABASE_URL, else SUPABASE_DB_URL (environment, repo-root .env or databricks/.env). Without either, every
test is skipped. Each test runs inside one transaction that is rolled back at the end, so the database never changes.
Fixtures are additive and use names that cannot clash with real data (users 00000000-0000-4000-8000-0000000000xx,
job keys sha256('fixture-...'), roles / skills / companies 'Zz Fixture ...').

A plain local PostgreSQL works too: python supabase/apply.py --url-env TEST_DATABASE_URL --local-stub
"""
import datetime as dt
import hashlib
import json
import os
import unittest
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "databricks" / ".env")

try:
    import psycopg
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - reported as a skip
    psycopg = None
    Jsonb = None


def env(name):
    return (os.getenv(name) or "").strip().strip('"')


DB_URL = env("TEST_DATABASE_URL") or env("SUPABASE_DB_URL")
SKIP_REASON = ("psycopg 3 is not installed (pip install 'psycopg[binary]')" if psycopg is None
               else "" if DB_URL else "set TEST_DATABASE_URL or SUPABASE_DB_URL to run the Supabase tests")

UTC = dt.timezone.utc
NOW = dt.datetime.now(UTC)
TODAY = NOW.date()


def fixture_key(name):
    return hashlib.sha256(f"fixture-{name}".encode()).hexdigest()


def fixture_uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


# Users
U_MAIN = fixture_uid(1)       # two roles (one a mapped custom role), four skills, 2-5 years, related roles ready
U_FALLBACK = fixture_uid(2)   # an active custom role without similarity rows: alternative / category fallback
U_NOPROFILE = fixture_uid(3)  # signed in, no profile
U_OTHER = fixture_uid(4)      # someone else (state isolation)
U_ADMIN = fixture_uid(5)      # admin claims
EMAILS = {uid: f"fixture.user{n}@jobseeker.test" for n, uid in enumerate([U_MAIN, U_FALLBACK, U_NOPROFILE, U_OTHER, U_ADMIN], 1)}

# Roles
R_DE = "Zz Fixture Data Engineer"
R_AE = "Zz Fixture Analytics Engineer"
R_PE = "Zz Fixture Platform Engineer"
R_ML = "Zz Fixture ML Engineer"
R_BI = "Zz Fixture BI Developer"
R_OUT = "Zz Fixture Sales Manager"
CR_MAPPED = "Zz Fixture DE Alias"
CR_ACTIVE = "Zz Fixture Lakehouse Engineer"
CR_REJECTED = "Zz Fixture Astrologer"
CR_PENDING = "Zz Fixture Pending Role"
COMPANY = "Zz Fixture Co"
OTHER_COMPANY = "Zz Fixture Other Co"
CITY = "Zz Fixture City"

REF_ROLES = [
    (R_DE, "Zz Fixture Data", True),
    (R_AE, "Zz Fixture Data", True),
    (R_PE, "Zz Fixture Ops", True),
    (R_ML, "Zz Fixture Science", True),
    (R_BI, "Zz Fixture Data", True),
    (R_OUT, "Zz Fixture Sales", False),
]
CUSTOM_ROLES = [
    {"role_title": CR_MAPPED, "status": "mapped", "category": None, "duplicate_of": R_DE},
    {"role_title": CR_ACTIVE, "status": "active", "category": "Zz Fixture Lake", "duplicate_of": None},
    {"role_title": CR_REJECTED, "status": "rejected", "category": None, "duplicate_of": None},
    {"role_title": CR_PENDING, "status": "pending", "category": None, "duplicate_of": None},
]
SKILL_STATS = [
    ("zz fixture spark", 1.25),
    ("zz fixture sql", 0.4),
    ("zz fixture cloud", 2.1),
    ("zz fixture python", 0.9),
]
ROLE_SIMILARITY = [
    (R_DE, R_DE, 1.0),
    (R_DE, R_PE, 0.80),
    (R_DE, R_ML, 0.9),
    (R_DE, R_BI, 0.80),
    (R_AE, R_AE, 1.0),
    (R_AE, R_PE, 0.86),
    (R_AE, R_ML, 0.70),
    (R_PE, R_DE, 0.80),
]
REF_SKILLS = [
    ("Zz Fixture Spark", "Zz Fixture Cloud", ["zz fixture pyspark"]),
    ("Zz Fixture SQL", None, None),
]
REF_CITIES = [
    ("Zz Fixture City", CITY, "Zz Fixture State"),
    ("Zz Fixture Town", CITY, "Zz Fixture State"),
    ("Zz Fixture Village", "Zz Fixture Village", "Zz Fixture State"),
]

PROFILES = {
    U_MAIN: {"target_roles": [CR_MAPPED, R_AE], "skills": ["Zz Fixture Spark", "Zz Fixture SQL", "Zz Fixture Cloud", "Zz Fixture Unseen"],
             "min_years": 2, "max_years": 5, "preferred_cities": [CITY]},
    U_FALLBACK: {"target_roles": [CR_ACTIVE], "skills": ["Zz Fixture Python"], "min_years": None, "max_years": None,
                 "preferred_cities": []},
    U_OTHER: {"target_roles": [R_DE], "skills": ["Zz Fixture SQL"], "min_years": 0, "max_years": 3, "preferred_cities": []},
}


def _job(name, **fields):
    row = {
        "job_key": fixture_key(name), "source": "linkedin", "company_name": COMPANY, "title": f"Zz Fixture {name}",
        "location": "Zz Fixture City, India", "posted_date": TODAY, "job_url": f"https://jobs.example.test/{name}",
        "seniority_level": None, "employment_type": "Full-time", "experience_min_years": None,
        "experience_max_years": None, "experience_level": None, "skills": [], "skill_groups": [], "category": None,
        "role_title": None, "role_score": 0.5, "role_alternative": None, "role_method": "embedding",
        "first_seen_at": NOW - dt.timedelta(hours=1), "last_seen_at": NOW - dt.timedelta(minutes=30), "times_seen": 1,
        "is_active": True, "description": f"Fixture job {name}", "job_function": None, "industries": None,
    }
    row.update(fields)
    return row


JOBS = [
    # role rank 1 (mapped custom role -> R_DE), skills + group matched, experience in range
    _job("rank1", role_title=R_DE, title="Zz Fixture Senior Data Engineer", skills=["Zz Fixture Spark", "Zz Fixture SQL"],
         skill_groups=["Zz Fixture Cloud"], experience_min_years=3, experience_max_years=6, role_score=0.93,
         category="Zz Fixture Data"),
    # role rank 2, asks 8+ years: experience 0.1 and above_experience
    _job("rank2", role_title=R_AE, title="Zz Fixture Analytics Role", skills=["Zz Fixture Spark"], experience_min_years=8,
         role_score=0.81),
    # title contains a role
    _job("title", role_title=R_OUT, title="Zz Fixture Analytics Engineer II", skills=["Zz Fixture SQL", "Zz Fixture Python"],
         experience_level="Mid", role_score=0.6),
    # related role at sim 0.86 via the second role (match), no skills found (neutral), level only
    _job("related_match", role_title=R_PE, title="Zz Fixture Platform Person", experience_level="Senior", role_score=0.7),
    # related role at 0.80 (low score, no match)
    _job("related_low", role_title=R_BI, title="Zz Fixture Reporting", skills=["Zz Fixture Cloud"],
         experience_min_years=1, role_score=0.66),
    # related roles ready but this role has none: 0 even with the alternative role set
    _job("related_none", role_title="Zz Fixture Unrelated", role_alternative=R_AE, category="Zz Fixture Data",
         title="Zz Fixture Something", skills=["Zz Fixture Excel"], role_score=0.4),
    # nothing matches, unknown experience: 100 * 0.15 * 0.7 = 10.5 -> 11 (HALF_UP)
    _job("halfup", title="Zz Fixture Office Assistant", skills=["Zz Fixture Excel"], role_score=None),
    # experience below the profile minimum: 1 - 0.15 * 1 = 0.85
    _job("below", role_title=R_DE, title="Zz Fixture Junior DE", experience_min_years=0, experience_max_years=1,
         skills=["Zz Fixture SQL"], role_score=0.9),
    # level only (Junior -> 1..4 years)
    _job("level", role_title=R_DE, title="Zz Fixture Level DE", experience_level="Junior", skills=["Zz Fixture Unseen"],
         role_score=0.88),
    # inactive (expired) and not applied: never visible
    _job("inactive", role_title=R_DE, is_active=False, skills=["Zz Fixture Spark"], experience_min_years=3, role_score=0.9),
    # inactive but applied by U_MAIN: visible, always "For you"
    _job("inactive_applied", role_title=R_OUT, title="Zz Fixture Old Sales", is_active=False, role_score=0.2,
         posted_date=TODAY - dt.timedelta(days=20), first_seen_at=NOW - dt.timedelta(days=20)),
    # hidden by U_MAIN
    _job("hidden", role_title=R_DE, title="Zz Fixture Hidden DE", skills=["Zz Fixture Spark"], experience_min_years=3,
         role_score=0.91),
    # old: posted and first seen 10 days ago
    _job("old", role_title=R_DE, title="Zz Fixture Old DE", skills=["Zz Fixture Spark"], posted_date=TODAY - dt.timedelta(days=10),
         first_seen_at=NOW - dt.timedelta(days=10), experience_min_years=3, role_score=0.92),
    # no posted_date, first seen 2 hours ago; other company / source / location
    _job("other_company", role_title=R_DE, title="Zz Fixture DE at Other", company_name=OTHER_COMPANY, source="greenhouse",
         location="Zz Fixture Town", posted_date=None, first_seen_at=NOW - dt.timedelta(hours=2), skills=["Zz Fixture Spark"],
         experience_min_years=3, role_score=0.95),
    # fallback user: alternative role (0.5) and category (0.3)
    _job("alternative", role_title="Zz Fixture Unrelated", role_alternative=CR_ACTIVE, title="Zz Fixture Alt",
         skills=["Zz Fixture Python"], role_score=0.5),
    _job("category", role_title="Zz Fixture Unrelated", category="Zz Fixture Lake", title="Zz Fixture Cat",
         skills=["Zz Fixture Python"], experience_min_years=4, role_score=0.45),
]
JOB_BY_NAME = {name: row for name, row in zip(
    ["rank1", "rank2", "title", "related_match", "related_low", "related_none", "halfup", "below", "level", "inactive",
     "inactive_applied", "hidden", "old", "other_company", "alternative", "category"], JOBS)}
KEY = {name: row["job_key"] for name, row in JOB_BY_NAME.items()}
FIXTURE_KEYS = [row["job_key"] for row in JOBS]

STATE = {
    U_MAIN: {
        KEY["inactive_applied"]: {"is_applied": True, "applied_at": NOW - dt.timedelta(days=2), "is_hidden": False,
                                  "application_status": "applied"},
        KEY["rank2"]: {"is_applied": True, "applied_at": NOW - dt.timedelta(days=1), "is_hidden": False,
                       "application_status": "applied"},
        KEY["hidden"]: {"is_applied": False, "applied_at": None, "is_hidden": True, "hidden_at": NOW - dt.timedelta(hours=3),
                        "application_status": "not_applied"},
    },
    U_OTHER: {
        KEY["rank1"]: {"is_applied": True, "applied_at": NOW - dt.timedelta(days=3), "is_hidden": False,
                       "application_status": "applied"},
        KEY["below"]: {"is_applied": False, "applied_at": None, "is_hidden": True, "hidden_at": NOW,
                       "application_status": "not_applied"},
    },
}

JOB_COLUMNS = list(_job("x").keys())


class SqlError(AssertionError):
    pass


@unittest.skipIf(bool(SKIP_REASON), SKIP_REASON or "")
class DbTestCase(unittest.TestCase):
    """One connection per class; every test in its own transaction, rolled back in tearDown."""

    conn = None
    load_fixtures = True

    @classmethod
    def setUpClass(cls):
        cls.conn = psycopg.connect(DB_URL, prepare_threshold=None, connect_timeout=20)

    @classmethod
    def tearDownClass(cls):
        if cls.conn is not None:
            cls.conn.close()

    def setUp(self):
        self.conn.rollback()
        self.sql("SET LOCAL statement_timeout = '60s'")
        self.sql("SET LOCAL lock_timeout = '10s'")
        self.sql("SET LOCAL \"TimeZone\" = 'UTC'")
        # Supabase's server default is 0 (15 digits); the app functions set 1 themselves, direct reads need it too
        self.sql("SET LOCAL extra_float_digits = 3")
        if self.load_fixtures:
            self.insert_world()

    def tearDown(self):
        self.conn.rollback()

    # --- SQL helpers ----------------------------------------------------------------------------------------------

    def sql(self, statement, params=None):
        return self.conn.execute(statement, params)

    def rows(self, statement, params=None):
        return self.conn.execute(statement, params).fetchall()

    def value(self, statement, params=None):
        return self.conn.execute(statement, params).fetchone()[0]

    @staticmethod
    def claims(uid, *, email=None, admin=False, role="authenticated"):
        return {"sub": uid, "email": EMAILS.get(uid) if email is None else email, "role": role, "aud": "authenticated",
                "app_metadata": {"provider": "email", **({"role": "admin"} if admin else {})}}

    def call(self, function, *args, claims=None, role="authenticated"):
        """Calls public.<function>(*args) as `role` with these JWT claims; returns the jsonb result.

        Runs in a savepoint: an error rolls back only this call. Raises SqlError(message) with .sqlstate.
        """
        placeholders = ", ".join(["%s"] * len(args))
        values = [Jsonb(a) if isinstance(a, (dict, list)) else a for a in args]
        try:
            with self.conn.transaction():
                self.sql(f"SET LOCAL ROLE {role}")
                self.sql("SELECT set_config('request.jwt.claims', %s, true)", [json.dumps(claims) if claims else ""])
                result = self.value(f"SELECT public.{function}({placeholders})", values)
                self.sql("RESET ROLE")
                self.sql("SELECT set_config('request.jwt.claims', '', true)")
        except psycopg.Error as error:
            failure = SqlError(error.diag.message_primary or str(error))
            failure.sqlstate = error.sqlstate
            raise failure from None
        return result

    def read(self, action, params=None, uid=U_MAIN, **claim_options):
        return self.call("app_read", action, {} if params is None else params, claims=self.claims(uid, **claim_options))["rows"]

    def write(self, action, params=None, uid=U_MAIN, **claim_options):
        return self.call("app_write", action, {} if params is None else params, claims=self.claims(uid, **claim_options))["rows"]

    def service(self, function, *args):
        return self.call(function, *args, claims={"role": "service_role"}, role="service_role")

    @contextmanager
    def assertSqlError(self, message, sqlstate="22023"):
        with self.assertRaises(SqlError) as caught:
            yield caught
        self.assertEqual(str(caught.exception), message)
        if sqlstate:
            self.assertEqual(caught.exception.sqlstate, sqlstate, str(caught.exception))

    # --- fixtures -------------------------------------------------------------------------------------------------

    def many(self, statement, rows):
        with self.conn.cursor() as cur:
            cur.executemany(statement, rows)  # pipelined: one round trip for all rows

    def insert_users(self, uids):
        self.many("""INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, created_at)
                     VALUES (%s, %s, 'authenticated', 'authenticated', %s, now())""",
                  [[uid, EMAILS.get(uid, f"{uid}@jobseeker.test"), Jsonb({"provider": "email"})] for uid in uids])
        # The real project's allow-list may have rows (seeded by migrate_user_data.py): let the fixture users in
        self.many("INSERT INTO app.allowed_emails (email) VALUES (lower(%s)) ON CONFLICT DO NOTHING",
                  [[EMAILS.get(uid, f"{uid}@jobseeker.test")] for uid in uids])

    def insert_jobs(self, jobs):
        columns = JOB_COLUMNS + ["skill_keys", "row_hash"]
        rows = []
        for job in jobs:
            row = dict(job)
            row["skill_keys"] = [s.lower() for s in (row["skills"] or []) + (row["skill_groups"] or []) if s is not None]
            row["row_hash"] = row.get("row_hash") or hashlib.sha256(row["job_key"].encode()).hexdigest()
            rows.append([row.get(c) for c in columns])
        self.many(f"INSERT INTO app.jobs ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))})", rows)

    def insert_profile(self, uid, profile, updated_at=None):
        self.sql("""INSERT INTO app.user_profile (profile_id, email, target_roles, skills, min_years, max_years,
                                                  preferred_cities, updated_at, also_skills, muted_companies,
                                                  muted_title_words, muted_levels)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, coalesce(%s, now()), %s, %s, %s, %s)""",
                 [uid, EMAILS.get(uid), profile["target_roles"], profile["skills"], profile["min_years"],
                  profile["max_years"], profile.get("preferred_cities") or [], updated_at, profile.get("also_skills") or [],
                  profile.get("muted_companies") or [], profile.get("muted_title_words") or [],
                  profile.get("muted_levels") or []])

    def insert_state(self, uid, job_key, st):
        self.sql("""INSERT INTO app.user_job_state (user_id, job_key, is_applied, applied_at, is_hidden, hidden_at,
                                                    application_status, status_updated_at, updated_at, note,
                                                    next_action_at, hide_reason)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, coalesce(%s, now()), coalesce(%s, now()), %s, %s, %s)""",
                 [uid, job_key, st.get("is_applied", False), st.get("applied_at"), st.get("is_hidden", False),
                  st.get("hidden_at"), st.get("application_status", "not_applied"), st.get("status_updated_at"),
                  st.get("updated_at"), st.get("note"), st.get("next_action_at"), st.get("hide_reason")])

    def insert_world(self):
        self.insert_users([U_MAIN, U_FALLBACK, U_NOPROFILE, U_OTHER, U_ADMIN])
        self.many("INSERT INTO app.ref_roles (role_title, category, in_scope) VALUES (%s, %s, %s)", REF_ROLES)
        self.many("""INSERT INTO app.custom_roles (role_title, status, category, duplicate_of, first_user, created_at,
                                                   checked_at, attempts)
                     VALUES (%s, %s, %s, %s, %s, now() - interval '2 days', now() - interval '1 day', 1)""",
                  [[c["role_title"], c["status"], c["category"], c["duplicate_of"], U_MAIN] for c in CUSTOM_ROLES])
        self.sql("INSERT INTO app.custom_skills (skill, first_user, created_at) VALUES ('Zz Fixture Unseen', %s, now())", [U_MAIN])
        self.many("INSERT INTO app.skill_stats (skill, jobs, idf) VALUES (%s, 1, %s)", SKILL_STATS)
        self.many("INSERT INTO app.role_similarity (role_a, role_b, sim) VALUES (%s, %s, %s)", ROLE_SIMILARITY)
        self.many("INSERT INTO app.ref_skills (skill, skill_group, aliases) VALUES (%s, %s, %s)", REF_SKILLS)
        self.many("INSERT INTO app.ref_cities (alias, city, state) VALUES (%s, %s, %s)", REF_CITIES)
        self.insert_jobs(JOBS)
        for uid, profile in PROFILES.items():
            self.insert_profile(uid, profile)
        for uid, states in STATE.items():
            for job_key, st in states.items():
                self.insert_state(uid, job_key, st)

    def reference(self, uid):
        """Expected scores of the fixture jobs for one user (scoring_reference.user_jobs)"""
        from scoring_reference import user_jobs
        return user_jobs(JOBS, PROFILES.get(uid), custom_roles=CUSTOM_ROLES, skill_stats=SKILL_STATS,
                         role_similarity=ROLE_SIMILARITY, ref_roles=[(r, c) for r, c, _ in REF_ROLES],
                         state=STATE.get(uid, {}))

    def fixture_rows(self, rows):
        """Only the fixture jobs of an app_read result (the database may hold real jobs too)"""
        keys = set(FIXTURE_KEYS)
        return [row for row in rows if row["job_key"] in keys]
