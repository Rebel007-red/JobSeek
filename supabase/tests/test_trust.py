"""Trust release: one definition per number (summary inbox / saved / applied, inbox_strong, new_since, expiring), the
expiring list and sort, tab inbox, ping and last_list_seen_at, fit_at_action, the activity counters, setNote keys left
out, missed_strong and the activity prune in pipeline_publish_finish, the admin metrics read and the allowedEmails
extras.

Extra fixture jobs (names "t_...") are added per test on top of base.py's world. As in test_features.py, lists with scope
"all" are narrowed to fixture jobs (q "zz fixture" or the fixture company) where the real jobs in the database would
make the expected sets unwieldy; the counts-add-up checks also run once over everything.
"""
import datetime as dt
from decimal import ROUND_HALF_UP, Decimal

import test_pipeline
from base import (COMPANY, EMAILS, KEY, NOW, R_DE, TODAY, U_ADMIN, U_FALLBACK, U_MAIN, U_NOPROFILE, U_OTHER, DbTestCase,
                  _job, fixture_key, fixture_uid)

FIXTURES = {"q": "zz fixture"}
STRONG = 70
MUTED_CO = "Zz Fixture Muted Co"
WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"]


def strong_job(name, **fields):
    """A job U_MAIN scores 80 (as base.py rank1: first role, three skills, experience in range) and For you"""
    return _job(name, **{"role_title": R_DE, "title": f"Zz Fixture {name.replace('_', ' ').title()}",
                         "skills": ["Zz Fixture Spark", "Zz Fixture SQL"], "skill_groups": ["Zz Fixture Cloud"],
                         "experience_min_years": 3, "experience_max_years": 6, "role_score": 0.9, **fields})


def days_ago(n):
    return {"posted_date": TODAY - dt.timedelta(days=n), "first_seen_at": NOW - dt.timedelta(days=n)}


EXTRA = [
    strong_job("t_exp_two", **days_ago(2)),                           # its last day: expiring
    strong_job("t_exp_five", **days_ago(5)),                          # overdue: still expiring until the publish
    strong_job("t_exp_nodate", posted_date=None, first_seen_at=NOW - dt.timedelta(days=3)),  # job date from first_seen_at
    strong_job("t_exp_one", **days_ago(1)),                           # a day left: not expiring
    strong_job("t_exp_muted", company_name=MUTED_CO, **days_ago(2)),  # muted (see setUp): not expiring
    strong_job("t_exp_weak", experience_min_years=None, experience_max_years=None, skills=[], skill_groups=[],
               **days_ago(2)),                                        # For you, but not a strong fit
    _job("t_exp_notforyou", role_title="Zz Fixture Unrelated", **days_ago(2)),  # not For you: never expiring
]
T = {row["job_key"]: row for row in EXTRA}
K = {name: fixture_key(name) for name in ("t_exp_two", "t_exp_five", "t_exp_nodate", "t_exp_one", "t_exp_muted",
                                          "t_exp_weak", "t_exp_notforyou")}


def half_up(value, digits):
    """PostgreSQL round(numeric, n): half away from zero (Python's round() is half to even)"""
    return float(Decimal(str(value)).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def iso(value):
    return value.astimezone(dt.timezone.utc).isoformat()


class TrustTestCase(DbTestCase):
    def setUp(self):
        super().setUp()
        self.insert_jobs(EXTRA)
        self.sql("UPDATE app.user_profile SET muted_companies = %s WHERE profile_id = %s", [[MUTED_CO], U_MAIN])
        # base.py hides "hidden" 3 hours ago, which is yesterday shortly after midnight UTC: make it unambiguous
        self.sql("UPDATE app.user_job_state SET hidden_at = now() - interval '2 days' WHERE user_id = %s AND job_key = %s",
                 [U_MAIN, KEY["hidden"]])

    def jobs(self, params=None, uid=U_MAIN):
        return self.read("jobs", {"limit": 100, **(params or {})}, uid=uid)

    def keys(self, params=None, uid=U_MAIN):
        return [r["job_key"] for r in self.jobs(params, uid)]

    def total(self, params=None, uid=U_MAIN):
        rows = self.read("jobs", {"limit": 1, **(params or {})}, uid=uid)
        return rows[0]["total_count"] if rows else 0

    def summary(self, params=None, uid=U_MAIN):
        return self.read("summary", params or {}, uid=uid)[0]

    def job_row(self, job_key, uid=U_MAIN):
        rows = self.read("jobRow", {"jobKey": job_key}, uid=uid)
        return rows[0] if rows else None

    def strong(self, job_key, uid=U_MAIN):
        row = self.job_row(job_key, uid)
        return row["in_for_you"] and row["muted_by"] is None and row["fit_score"] >= STRONG

    def activity(self, uid=U_MAIN, day=None):
        row = self.conn.execute("""SELECT visits, opened, saved, applied, hidden, prompt_yes, prompt_no, prompt_saved,
                                          acted_strong, missed_strong, first_at, last_at
                                   FROM app.user_activity_day WHERE user_id = %s AND day = coalesce(%s, current_date)""",
                                [uid, day]).fetchone()
        names = ["visits", "opened", "saved", "applied", "hidden", "prompt_yes", "prompt_no", "prompt_saved",
                 "acted_strong", "missed_strong", "first_at", "last_at"]
        return None if row is None else dict(zip(names, row))

    def counters(self, uid=U_MAIN):
        a = self.activity(uid)
        return None if a is None else (a["saved"], a["applied"], a["hidden"], a["acted_strong"])

    def fit_at_action(self, job_key, uid=U_MAIN):
        return self.value("SELECT fit_at_action FROM app.user_job_state WHERE user_id = %s AND job_key = %s", [uid, job_key])


class SummaryTest(TrustTestCase):
    def test_tabs_are_disjoint_and_match_their_lists(self):
        self.write("setStatus", {"jobKeys": [KEY["level"], KEY["below"], K["t_exp_two"]], "status": "saved"})
        self.write("setStatus", {"jobKey": KEY["title"], "status": "interviewing"})
        variants = [{}, {"postedWithin": 24}, {"postedWithin": 48}, {"scope": "all", "company": COMPANY},
                    {"scope": "all", "company": COMPANY, "postedWithin": 24}, {"scope": "all"}, {"collapse": False}]
        for params in variants:
            with self.subTest(params=params):
                summary = self.summary(params)
                for tab in ("inbox", "saved", "applied"):
                    self.assertEqual(self.total({**params, "tab": tab}), summary[tab], tab)
                # the old keys keep their meaning
                self.assertEqual(self.total({**params, "tab": "pending"}), summary["pending"])
                self.assertEqual(self.total({**params, "tab": "all"}), summary["total"])
        sets = {tab: set(self.keys({**FIXTURES, "scope": "all", "collapse": False, "tab": tab}))
                for tab in ("inbox", "saved", "applied")}
        self.assertEqual(sets["inbox"] & sets["saved"], set())
        self.assertEqual(sets["inbox"] & sets["applied"], set())
        self.assertEqual(sets["saved"] & sets["applied"], set())
        self.assertEqual(sets["saved"], {KEY["level"], KEY["below"], K["t_exp_two"]})
        self.assertEqual(sets["applied"], {KEY["title"], KEY["rank2"], KEY["inactive_applied"]})
        # every untracked visible job is in the Inbox (no time window here)
        everything = set(self.keys({**FIXTURES, "scope": "all", "collapse": False, "tab": "all"}))
        self.assertEqual(sets["inbox"], everything - sets["saved"] - sets["applied"])

    def test_inbox_tab(self):
        self.write("setStatus", {"jobKey": KEY["level"], "status": "saved"})
        inbox = set(self.keys({"tab": "inbox"}))
        self.assertNotIn(KEY["level"], inbox)                # saved
        self.assertNotIn(KEY["rank2"], inbox)                # applied
        self.assertNotIn(KEY["hidden"], inbox)               # hidden
        self.assertNotIn(K["t_exp_muted"], inbox)            # muted
        self.assertIn(KEY["old"], inbox)                     # no time window given
        self.assertIn(KEY["rank1"], inbox)
        recent = set(self.keys({"tab": "inbox", "postedWithin": 24}))
        self.assertNotIn(KEY["old"], recent)                 # the time window applies to the Inbox
        self.assertIn(KEY["rank1"], recent)
        self.assertEqual(inbox, set(self.keys({"tab": "pending"})) - {KEY["level"]})

    def test_inbox_strong_is_the_inbox_at_fit_70(self):
        self.write("setStatus", {"jobKey": KEY["rank1"], "status": "saved"})  # tracked strong jobs do not count
        for params in ({}, {"postedWithin": 24}, {"scope": "all", "company": COMPANY}, {"scope": "all"}):
            with self.subTest(params=params):
                summary = self.summary(params)
                self.assertEqual(summary["inbox_strong"], self.total({**params, "tab": "inbox", "minFit": STRONG}))
                # strong_fit keeps its old meaning (tracked jobs too)
                self.assertGreaterEqual(summary["strong_fit"], summary["inbox_strong"])
        self.assertGreater(self.summary()["inbox_strong"], 0)

    def test_new_since(self):
        since = (NOW - dt.timedelta(minutes=30)).replace(microsecond=0)
        self.insert_jobs([
            strong_job("t_new_boundary", first_seen_at=since),                          # exactly at since: not new
            strong_job("t_new_after", first_seen_at=since + dt.timedelta(seconds=1)),   # new
            strong_job("t_new_saved", first_seen_at=since + dt.timedelta(seconds=1)),   # new but saved: not in the Inbox
            strong_job("t_new_muted", company_name=MUTED_CO, first_seen_at=since + dt.timedelta(minutes=1)),
        ])
        self.write("setStatus", {"jobKey": fixture_key("t_new_saved"), "status": "saved"})
        self.assertIsNone(self.summary()["new_since"])
        for bad in ("yesterday", 5, None, "", True):
            with self.subTest(since=bad):
                self.assertIsNone(self.summary({"since": bad})["new_since"])
        self.assertEqual(self.summary({"since": iso(since)})["new_since"], 1)
        self.assertEqual(self.summary({"since": since.strftime("%Y-%m-%dT%H:%M:%S.000Z")})["new_since"], 1)
        # the same jobs as the Inbox list filtered by first_seen_at
        inbox = self.jobs({"tab": "inbox"})
        self.assertEqual([r["job_key"] for r in inbox if dt.datetime.fromisoformat(r["first_seen_at"]) > since],
                         [fixture_key("t_new_after")])
        # far back: every Inbox job is new; in the future: none
        self.assertEqual(self.summary({"since": "2000-01-01T00:00:00Z"})["new_since"], self.summary()["inbox"])
        self.assertEqual(self.summary({"since": iso(NOW + dt.timedelta(days=1))})["new_since"], 0)

    def test_triaged_today(self):
        self.assertEqual(self.summary()["triaged_today"], 0)
        self.write("setStatus", {"jobKey": KEY["level"], "status": "saved"})
        self.write("setStatus", {"jobKey": KEY["below"], "status": "applied"})
        self.write("setHidden", {"jobKey": KEY["rank1"], "hidden": True})
        self.assertEqual(self.summary()["triaged_today"], 3)
        self.assertEqual(self.summary(uid=U_OTHER)["triaged_today"], 0)  # per user
        self.write("setHidden", {"jobKey": KEY["rank1"], "hidden": False})  # an undo takes it back
        self.assertEqual(self.summary()["triaged_today"], 2)


class ExpiringTest(TrustTestCase):
    EXPECTED = {K["t_exp_two"], K["t_exp_five"], K["t_exp_nodate"], K["t_exp_weak"], KEY["old"]}

    def test_expiring_list_and_summary(self):
        listed = set(self.keys({"expiring": True}))
        self.assertEqual(listed, self.EXPECTED)
        # the time window, the tab, the scope and the mute view do not matter; the text and panel filters do
        for params in ({"postedWithin": 24}, {"scope": "all"}, {"tab": "saved"}, {"tab": "applied", "postedWithin": 1},
                       {"muteView": "only"}, {"closed": "only"}, {"followUp": True}, {"stage": "offer"}):
            with self.subTest(params=params):
                self.assertEqual(set(self.keys({"expiring": True, **params})), self.EXPECTED)
        self.assertEqual(set(self.keys({"expiring": True, "q": "nodate"})), {K["t_exp_nodate"]})
        # summary: the same count, whatever the window and scope
        for params in ({}, {"postedWithin": 24}, {"scope": "all"}, {"scope": "all", "postedWithin": 24}):
            with self.subTest(summary=params):
                summary = self.summary(params)
                self.assertEqual(summary["expiring"], len(self.EXPECTED))
                self.assertEqual(summary["expiring_strong"], self.total({"expiring": True, "minFit": STRONG}))
        strong = {k for k in self.EXPECTED if self.job_row(k)["fit_score"] >= STRONG}
        self.assertEqual(strong, {K["t_exp_two"], K["t_exp_five"], K["t_exp_nodate"]})  # not t_exp_weak, not base.py's old
        self.assertEqual(self.summary()["expiring_strong"], len(strong))
        self.assertLess(self.job_row(K["t_exp_weak"])["fit_score"], STRONG)
        self.assertTrue(self.job_row(K["t_exp_weak"])["in_for_you"])
        # only JSON true turns it on
        self.assertIn(KEY["rank1"], self.keys({"expiring": "true"}))

    def test_tracked_hidden_and_muted_leave_the_list(self):
        self.write("setStatus", {"jobKey": K["t_exp_two"], "status": "saved"})
        self.write("setStatus", {"jobKey": K["t_exp_five"], "status": "applied"})
        self.write("setHidden", {"jobKey": K["t_exp_nodate"], "hidden": True})
        left = self.EXPECTED - {K["t_exp_two"], K["t_exp_five"], K["t_exp_nodate"]}
        self.assertEqual(set(self.keys({"expiring": True})), left)
        self.assertEqual(self.summary()["expiring"], len(left))
        self.assertIn(K["t_exp_two"], self.keys({"tab": "saved"}))  # saving keeps it
        # unmuted, the muted job is expiring too
        self.write("saveMuteRules", {"companies": []})
        self.assertIn(K["t_exp_muted"], self.keys({"expiring": True}))
        self.assertEqual(self.summary()["expiring"], len(left) + 1)

    def test_cap_total_and_sort(self):
        self.insert_jobs([strong_job(f"t_cap_{w}", title=f"Zz Fixture Expiring {w.title()}", **days_ago(2 + i % 3))
                          for i, w in enumerate(WORDS)])
        expected_total = len(self.EXPECTED) + len(WORDS)
        rows = self.jobs({"expiring": True})
        self.assertEqual(len(rows), 10)  # app.c_expiring_max(), whatever the limit asked
        self.assertEqual(rows[0]["total_count"], expected_total)
        self.assertEqual(len(self.jobs({"expiring": True, "limit": 3})), 3)
        self.assertEqual(len(self.read("jobs", {"expiring": True})), 10)  # no limit given
        self.assertEqual(self.summary()["expiring"], expected_total)
        # paging reaches the rest
        rest = self.jobs({"expiring": True, "offset": 10})
        self.assertEqual(len(rest), expected_total - 10)
        # sort expiring: job date ascending (soonest gone first), then fit
        everything = self.jobs({"expiring": True, "sort": "expiring"}) + self.jobs({"expiring": True, "sort": "expiring", "offset": 10})
        keys = [(r["posted_date"] or r["first_seen_at"][:10], -r["fit_score"]) for r in everything]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(everything[0]["job_key"], KEY["old"])  # 10 days old
        self.assertNotIn("k0", everything[0])

    def test_expiring_sort_on_the_inbox(self):
        rows = self.jobs({"tab": "inbox", "sort": "expiring"})
        dates = [r["posted_date"] or r["first_seen_at"][:10] for r in rows]
        self.assertEqual(dates, sorted(dates))
        self.assertEqual(rows[0]["job_key"], KEY["old"])
        self.assertEqual(len(rows), self.total({"tab": "inbox"}))  # not capped without expiring: true
        self.assertEqual(self.keys({"sort": "bogus"}), self.keys({"sort": "fit"}))


class PingTest(TrustTestCase):
    def ping(self, params=None, uid=U_MAIN, **claim_options):
        return self.write("ping", params or {}, uid=uid, **claim_options)[0]

    def seen(self, uid=U_MAIN):
        return self.value("SELECT last_list_seen_at FROM app.user_profile WHERE profile_id = %s", [uid])

    def test_previous_seen_round_trip(self):
        self.assertIsNone(self.seen())
        first = self.ping()
        self.assertEqual(set(first), {"previous_seen_at", "seen_at", "has_profile"})
        self.assertEqual((first["previous_seen_at"], first["has_profile"]), (None, True))
        now = self.value("SELECT now()")
        self.assertEqual(dt.datetime.fromisoformat(first["seen_at"]), now)
        self.assertEqual(self.seen(), now)
        earlier = now - dt.timedelta(hours=5)
        self.sql("UPDATE app.user_profile SET last_list_seen_at = %s WHERE profile_id = %s", [earlier, U_MAIN])
        self.assertEqual(dt.datetime.fromisoformat(self.ping()["previous_seen_at"]), earlier)
        self.assertEqual(dt.datetime.fromisoformat(self.ping()["previous_seen_at"]), now)
        # the profile itself is untouched (updated_at is exported to the pipeline)
        updated = self.value("SELECT updated_at FROM app.user_profile WHERE profile_id = %s", [U_MAIN])
        self.ping()
        self.assertEqual(self.value("SELECT updated_at FROM app.user_profile WHERE profile_id = %s", [U_MAIN]), updated)
        self.assertNotIn("last_list_seen_at", self.read("profile")[0])
        self.assertIsNone(self.seen(U_OTHER))  # per user

    def test_no_profile_is_never_created(self):
        row = self.ping(uid=U_NOPROFILE)
        self.assertEqual((row["previous_seen_at"], row["has_profile"]), (None, False))
        self.assertEqual(self.value("SELECT count(*) FROM app.user_profile WHERE profile_id = %s", [U_NOPROFILE]), 0)
        self.assertEqual(self.read("profile", uid=U_NOPROFILE), [])
        self.assertEqual(self.activity(U_NOPROFILE)["visits"], 1)  # the visit still counts

    def test_visits_and_gap(self):
        self.ping()
        self.ping()
        self.assertEqual(self.activity()["visits"], 1)  # no gap
        self.sql("UPDATE app.user_activity_day SET last_at = now() - interval '29 minutes' WHERE user_id = %s", [U_MAIN])
        self.ping()
        self.assertEqual(self.activity()["visits"], 1)
        self.sql("UPDATE app.user_activity_day SET last_at = now() - interval '30 minutes' WHERE user_id = %s", [U_MAIN])
        self.ping()
        self.assertEqual(self.activity()["visits"], 2)  # 30 minutes = app.c_visit_gap_minutes()
        # a row only writes (or the publish) made has no visit yet: the first ping counts
        self.write("setHidden", {"jobKey": KEY["rank1"], "hidden": True}, uid=U_OTHER)
        self.assertEqual(self.activity(U_OTHER)["visits"], 0)
        self.ping(uid=U_OTHER)
        self.assertEqual(self.activity(U_OTHER)["visits"], 1)
        self.sql("""INSERT INTO app.user_activity_day (user_id, day, missed_strong) VALUES (%s, current_date, 2)""", [U_FALLBACK])
        self.ping(uid=U_FALLBACK)
        a = self.activity(U_FALLBACK)
        self.assertEqual((a["visits"], a["missed_strong"]), (1, 2))
        self.assertIsNotNone(a["first_at"])
        # a write after the ping moves last_at, so it is still the same visit
        self.sql("UPDATE app.user_activity_day SET last_at = now() - interval '1 hour' WHERE user_id = %s", [U_MAIN])
        self.write("setStatus", {"jobKey": KEY["level"], "status": "saved"})
        self.ping()
        self.assertEqual(self.activity()["visits"], 2)

    def test_counters_and_validation(self):
        self.ping({"opened": 3, "promptYes": 1})
        self.ping({"opened": 2, "promptNo": 4, "promptSaved": 5, "promptYes": None})
        self.ping({"opened": 500})
        a = self.activity()
        self.assertEqual((a["opened"], a["prompt_yes"], a["prompt_no"], a["prompt_saved"]), (505, 1, 4, 5))
        for name in ("opened", "promptYes", "promptNo", "promptSaved"):
            for bad in (-1, 501, 1.5, "3", True, [], {}, 10 ** 12):
                with self.subTest(name=name, bad=bad):
                    with self.assertSqlError("Invalid count"):
                        self.ping({name: bad})
        self.assertEqual(self.activity()["opened"], 505)  # failed pings add nothing
        self.assertEqual(self.ping({"unknown": 7})["has_profile"], True)  # other keys are ignored

    def test_allow_list_applies(self):
        with self.assertSqlError("This account is not allowed to use the job data", "42501"):
            self.ping(email="fixture.stranger@jobseeker.test")
        with self.assertSqlError("Sign in required", "28000"):
            self.call("app_write", "ping", {}, claims={"role": "authenticated"})
        with self.assertSqlError("Unknown action: ping"):
            self.read("ping")  # a write


class FitAtActionTest(TrustTestCase):
    def fit(self, job_key):
        return self.job_row(job_key)["fit_score"]

    def test_rules(self):
        key = KEY["level"]
        self.write("setStatus", {"jobKey": key, "status": "saved"})
        self.assertEqual(self.fit_at_action(key), self.fit(key))
        # saved -> applied overwrites it; staying tracked does not
        self.sql("UPDATE app.user_job_state SET fit_at_action = 1 WHERE user_id = %s AND job_key = %s", [U_MAIN, key])
        self.write("setStatus", {"jobKey": key, "status": "applied"})
        self.assertEqual(self.fit_at_action(key), self.fit(key))
        self.sql("UPDATE app.user_job_state SET fit_at_action = 2 WHERE user_id = %s AND job_key = %s", [U_MAIN, key])
        self.write("setStatus", {"jobKey": key, "status": "interviewing"})
        self.write("setStatus", {"jobKey": key, "status": "offer"})
        self.write("setNote", {"jobKey": key, "note": "x"})
        self.assertEqual(self.fit_at_action(key), 2)
        # back to not_applied (an unsave or an undo) keeps it
        self.write("setStatus", {"jobKey": key, "status": "not_applied"})
        self.assertEqual(self.fit_at_action(key), 2)
        # an untracked row (hidden) that gets saved: set
        self.write("setHidden", {"jobKey": KEY["below"], "hidden": True})
        self.assertIsNone(self.fit_at_action(KEY["below"]))
        self.write("setStatus", {"jobKey": KEY["below"], "status": "saved"})
        self.assertEqual(self.fit_at_action(KEY["below"]), self.fit(KEY["below"]))

    def test_note_auto_save_old_set_applied_and_bulk(self):
        self.write("setNote", {"jobKey": KEY["title"], "note": "call", "nextActionAt": None})
        self.assertEqual(self.fit_at_action(KEY["title"]), self.fit(KEY["title"]))
        self.write("setNote", {"jobKey": KEY["related_low"], "note": "", "nextActionAt": None})  # nothing saved
        self.assertIsNone(self.fit_at_action(KEY["related_low"]))
        self.write("setApplied", {"jobKey": KEY["rank1"], "applied": True})
        self.assertEqual(self.fit_at_action(KEY["rank1"]), self.fit(KEY["rank1"]))
        self.write("setApplied", {"jobKey": KEY["rank1"], "applied": False})
        self.assertEqual(self.fit_at_action(KEY["rank1"]), self.fit(KEY["rank1"]))
        keys = [KEY["old"], K["t_exp_two"], K["t_exp_weak"]]
        self.write("setStatus", {"jobKeys": keys, "status": "applied"})
        for key in keys:
            self.assertEqual(self.fit_at_action(key), self.fit(key))
        # rows tracked before the column existed stay NULL until they move
        self.assertIsNone(self.fit_at_action(KEY["rank2"]))
        self.write("setStatus", {"jobKey": KEY["rank2"], "status": "rejected"})
        self.assertIsNone(self.fit_at_action(KEY["rank2"]))
        self.assertIsNone(self.fit_at_action(KEY["rank1"], uid=U_OTHER))  # per user
        # never exported
        state = next(s for s in self.service("pipeline_export_user_data")["job_state"]
                     if s["user_id"] == U_MAIN and s["job_key"] == KEY["old"])
        self.assertNotIn("fit_at_action", state)


class ActivityTest(TrustTestCase):
    def test_saves_applies_hides_net_of_same_day_undos(self):
        self.assertIsNone(self.activity())
        strong = [k for k in (KEY["level"], KEY["below"], KEY["rank1"]) if self.strong(k)]
        self.write("setStatus", {"jobKeys": [KEY["level"], KEY["below"], KEY["rank1"]], "status": "saved"})
        self.assertEqual(self.counters(), (3, 0, 0, len(strong)))
        a = self.activity()
        self.assertEqual(a["first_at"], a["last_at"])
        self.assertEqual(a["visits"], 0)  # only pings count visits
        # an unsave of today's save takes it back; saved -> applied is progress, not an undo
        self.write("setStatus", {"jobKey": KEY["level"], "status": "not_applied"})
        self.write("setStatus", {"jobKey": KEY["below"], "status": "applied"})
        level_strong = int(KEY["level"] in strong)
        self.assertEqual(self.counters(), (2, 1, 0, len(strong) - level_strong))
        # undo applied (today): -1, and it is untouched again
        self.write("setStatus", {"jobKey": KEY["below"], "status": "not_applied"})
        below_strong = int(KEY["below"] in strong)
        self.assertEqual(self.counters(), (2, 0, 0, len(strong) - level_strong - below_strong))
        # a save from yesterday undone today: not taken back
        self.sql("UPDATE app.user_job_state SET status_updated_at = now() - interval '1 day' WHERE user_id = %s AND job_key = %s",
                 [U_MAIN, KEY["rank1"]])
        self.write("setStatus", {"jobKey": KEY["rank1"], "status": "not_applied"})
        self.assertEqual(self.counters(), (2, 0, 0, len(strong) - level_strong - below_strong))

    def test_hides_bulk_and_restore(self):
        keys = [KEY["rank1"], KEY["title"], K["t_exp_two"]]
        strong = sum(self.strong(k) for k in keys)
        self.write("setHidden", {"jobKeys": keys, "hidden": True, "reason": "too_senior"})
        self.assertEqual(self.counters(), (0, 0, 3, strong))
        self.write("setHidden", {"jobKeys": keys, "hidden": True})  # hiding again changes nothing
        self.assertEqual(self.counters(), (0, 0, 3, strong))
        self.write("setHidden", {"jobKey": KEY["title"], "hidden": False})
        title_strong = int(self.strong(KEY["title"]))
        self.assertEqual(self.counters(), (0, 0, 2, strong - title_strong))
        # restoreHidden takes back today's hides only (base.py's "hidden" was hidden two days ago)
        self.write("restoreHidden")
        self.assertEqual(self.counters(), (0, 0, 0, 0))
        self.assertFalse(self.job_row(KEY["hidden"])["is_hidden"])
        # saving a job hidden today: the hide is replaced by the save
        self.write("setHidden", {"jobKey": KEY["level"], "hidden": True})
        self.write("setStatus", {"jobKey": KEY["level"], "status": "saved"})
        self.assertEqual(self.counters()[:3], (1, 0, 0))

    def test_acted_strong_only_for_untouched_strong_for_you_jobs(self):
        self.assertTrue(self.strong(K["t_exp_two"]))
        self.assertFalse(self.strong(K["t_exp_weak"]))
        self.assertIsNotNone(self.job_row(K["t_exp_muted"])["muted_by"])
        self.assertFalse(self.job_row(K["t_exp_notforyou"])["in_for_you"])
        self.write("setStatus", {"jobKeys": [K["t_exp_weak"], K["t_exp_muted"], K["t_exp_notforyou"]], "status": "saved"})
        self.assertEqual(self.counters(), (3, 0, 0, 0))
        self.write("setStatus", {"jobKey": K["t_exp_two"], "status": "applied"})
        self.assertEqual(self.counters(), (3, 1, 0, 1))
        self.write("setStatus", {"jobKey": K["t_exp_two"], "status": "interviewing"})  # already tracked
        self.assertEqual(self.counters(), (3, 1, 0, 1))
        self.write("setHidden", {"jobKey": KEY["rank1"], "hidden": True})
        self.write("setStatus", {"jobKey": KEY["rank1"], "status": "saved"})  # was hidden, not untouched
        self.assertEqual(self.counters(), (4, 1, 0, 2))

    def test_floor_and_other_users(self):
        # a save written before this release (no activity row) undone today: never below 0
        self.insert_state(U_MAIN, KEY["level"], {"application_status": "saved"})
        self.write("setStatus", {"jobKey": KEY["level"], "status": "not_applied"})
        self.assertEqual(self.counters(), (0, 0, 0, 0))
        self.write("setStatus", {"jobKey": "f" * 64, "status": "saved"}, uid=U_OTHER)  # no such job: nothing recorded
        self.assertIsNone(self.activity(U_OTHER))
        self.write("setNote", {"jobKey": KEY["rank1"], "note": "x"}, uid=U_OTHER)  # the auto-save counts as a save
        self.assertEqual(self.counters(U_OTHER)[:3], (0, 0, 0))  # rank1 is applied for U_OTHER: no change
        self.write("setNote", {"jobKey": KEY["title"], "note": "x"}, uid=U_OTHER)
        self.assertEqual(self.counters(U_OTHER)[:3], (1, 0, 0))
        self.assertEqual(self.counters(), (0, 0, 0, 0))
        self.assertEqual(self.value("SELECT count(*) FROM app.user_activity_day WHERE saved < 0 OR hidden < 0"), 0)

    def stamps(self, job_key, uid=U_MAIN):
        row = self.rows("SELECT applied_at, status_updated_at FROM app.user_job_state WHERE user_id = %s AND job_key = %s",
                        [uid, job_key])[0]
        return {"appliedAt": row[0] and iso(row[0]), "statusUpdatedAt": row[1] and iso(row[1])}

    def test_undo_puts_back_without_counting_again(self):
        # The client's Undo is setStatus(<previous status>, {appliedAt, statusUpdatedAt} of before)
        key = K["t_exp_two"]
        self.assertTrue(self.strong(key))
        self.write("setStatus", {"jobKey": key, "status": "saved"})
        # the save a moment before the apply (inside one test transaction now() never moves)
        self.sql("""UPDATE app.user_job_state SET status_updated_at = status_updated_at - interval '1 microsecond'
                    WHERE user_id = %s AND job_key = %s""", [U_MAIN, key])
        saved = self.stamps(key)
        self.write("setStatus", {"jobKey": key, "status": "applied"})
        self.assertEqual(self.counters(), (1, 1, 0, 1))
        self.write("setStatus", {"jobKey": key, "status": "saved", **saved})  # Undo of saved -> applied
        self.assertEqual(self.counters(), (1, 0, 0, 1))
        self.write("setStatus", {"jobKey": key, "status": "not_applied"})  # unsave today's save
        self.assertEqual(self.counters(), (0, 0, 0, 0))
        self.write("setStatus", {"jobKey": key, "status": "saved", **saved})  # Undo of the unsave: saved again
        self.assertEqual(self.counters(), (1, 0, 0, 1))
        # Undo of an unsave / unapply of an earlier day's save / application: nothing today
        old = NOW - dt.timedelta(days=3)
        self.insert_state(U_MAIN, KEY["level"], {"application_status": "saved", "status_updated_at": old})
        before = self.stamps(KEY["level"])
        self.write("setStatus", {"jobKey": KEY["level"], "status": "not_applied"})
        self.write("setStatus", {"jobKey": KEY["level"], "status": "saved", **before})
        self.insert_state(U_MAIN, KEY["below"], {"application_status": "applied", "is_applied": True, "applied_at": old,
                                                 "status_updated_at": old})
        before = self.stamps(KEY["below"])
        self.write("setStatus", {"jobKey": KEY["below"], "status": "not_applied"})
        self.write("setStatus", {"jobKey": KEY["below"], "status": "applied", **before})
        self.assertEqual(self.counters(), (1, 0, 0, 1))
        # moving today's application to Saved in the status picker (no stamps) is a save
        self.write("setStatus", {"jobKey": KEY["rank1"], "status": "applied"})
        self.write("setStatus", {"jobKey": KEY["rank1"], "status": "saved"})
        self.assertEqual(self.counters()[:3], (2, 0, 0))


class NoteKeysTest(TrustTestCase):
    def note(self, job_key=None):
        return self.rows("SELECT note, next_action_at, application_status FROM app.user_job_state WHERE user_id = %s AND job_key = %s",
                         [U_MAIN, job_key or KEY["level"]])[0]

    def test_left_out_keys_keep_the_stored_value(self):
        key = KEY["level"]
        d1, d2 = TODAY + dt.timedelta(days=7), TODAY + dt.timedelta(days=9)
        self.write("setNote", {"jobKey": key, "note": "a", "nextActionAt": d1.isoformat()})
        self.write("setNote", {"jobKey": key, "nextActionAt": d2.isoformat()})  # a snooze: the note stays
        self.assertEqual(self.note(), ("a", d2, "saved"))
        self.write("setNote", {"jobKey": key, "note": "b"})
        self.assertEqual(self.note(), ("b", d2, "saved"))
        self.write("setNote", {"jobKey": key, "note": None})  # an explicit null still clears
        self.assertEqual(self.note(), (None, d2, "saved"))
        self.write("setNote", {"jobKey": key, "nextActionAt": None})
        self.assertEqual(self.note(), (None, None, "saved"))
        self.write("setNote", {"jobKey": key, "note": "c", "nextActionAt": ""})
        self.write("setNote", {"jobKey": key})  # nothing given: nothing changes
        self.assertEqual(self.note(), ("c", None, "saved"))
        self.assertEqual(self.read("jobNote", {"jobKey": key})[0]["note"], "c")

    def test_auto_save_uses_the_merged_values(self):
        key = KEY["title"]
        self.write("setNote", {"jobKey": key, "note": "keep"})
        self.write("setStatus", {"jobKey": key, "status": "not_applied"})  # the note stays, the job is untracked
        self.assertEqual(self.note(key), ("keep", None, "not_applied"))
        rows = self.write("setNote", {"jobKey": key, "nextActionAt": None})
        self.assertEqual(rows, [{"num_affected_rows": 1, "application_status": "saved"}])
        # no row yet and only a date: a new saved row with no note
        rows = self.write("setNote", {"jobKey": KEY["related_low"], "nextActionAt": (TODAY + dt.timedelta(days=7)).isoformat()})
        self.assertEqual(rows[0]["application_status"], "saved")
        self.assertEqual(self.note(KEY["related_low"]), (None, TODAY + dt.timedelta(days=7), "saved"))
        # no row and nothing given: an untracked row, as before
        self.assertEqual(self.write("setNote", {"jobKey": KEY["rank1"]})[0]["application_status"], "not_applied")
        with self.assertSqlError("Invalid follow-up date"):
            self.write("setNote", {"jobKey": key, "nextActionAt": "soon"})


class PublishTest(TrustTestCase):
    current = test_pipeline.PipelineTest.current
    json_rows = test_pipeline.PipelineTest.json_rows
    stage = test_pipeline.PipelineTest.stage
    finish = test_pipeline.PipelineTest.finish

    GONE = [strong_job("t_gone_strong"), strong_job("t_gone_hidden"), strong_job("t_gone_muted", company_name=MUTED_CO),
            strong_job("t_gone_tracked"), strong_job("t_gone_weak", skills=[], skill_groups=[], experience_min_years=None,
                                                     experience_max_years=None)]

    def setUp(self):
        super().setUp()
        self.insert_jobs(self.GONE)
        self.write("setHidden", {"jobKey": fixture_key("t_gone_hidden"), "hidden": True})
        self.write("setStatus", {"jobKey": fixture_key("t_gone_tracked"), "status": "applied"}, uid=U_OTHER)
        self.sql("DELETE FROM app.user_activity_day WHERE user_id IN (%s, %s, %s)", [U_MAIN, U_OTHER, U_FALLBACK])

    def expected_missed(self, uid):
        n = 0
        for job in self.GONE:
            row = self.job_row(job["job_key"], uid)
            has_state = self.value("SELECT count(*) FROM app.user_job_state WHERE user_id = %s AND job_key = %s",
                                   [uid, job["job_key"]])
            tracked = self.value("""SELECT count(*) FROM app.user_job_state WHERE job_key = %s
                                    AND (is_applied OR application_status <> 'not_applied')""", [job["job_key"]])
            if row["in_for_you"] and row["muted_by"] is None and row["fit_score"] >= STRONG and not has_state and not tracked:
                n += 1
        return n

    def test_missed_strong_counted_before_the_delete(self):
        self.assertEqual(self.expected_missed(U_MAIN), 1)  # t_gone_strong only
        expected = {uid: self.expected_missed(uid) for uid in (U_MAIN, U_OTHER, U_FALLBACK)}
        self.assertEqual(expected[U_FALLBACK], 0)
        # an existing row today gains the count
        self.sql("INSERT INTO app.user_activity_day (user_id, day, first_at, last_at, visits, missed_strong) "
                 "VALUES (%s, current_date, now(), now(), 1, 2)", [U_MAIN])
        before = self.value("SELECT coalesce(sum(missed_strong), 0) FROM app.user_activity_day WHERE day = current_date")
        snap = self.current()
        for job in self.GONE:
            del snap["keys"][job["job_key"]]
        result = self.finish("fixture-run-trust", self.stage("fixture-run-trust", snap))
        after = self.value("SELECT coalesce(sum(missed_strong), 0) FROM app.user_activity_day WHERE day = current_date")
        self.assertEqual(result["missed_strong"], after - before)
        self.assertEqual(result["missed_strong"], sum(expected.values()))
        self.assertEqual(self.activity(U_MAIN)["missed_strong"], 3)
        self.assertEqual(self.activity(U_MAIN)["visits"], 1)
        if expected[U_OTHER]:
            a = self.activity(U_OTHER)
            self.assertEqual((a["missed_strong"], a["visits"], a["first_at"], a["last_at"]), (expected[U_OTHER], 0, None, None))
        self.assertIsNone(self.activity(U_FALLBACK))  # nothing missed: no row
        # and the jobs are gone (tracked t_gone_tracked stays)
        gone = [j["job_key"] for j in self.GONE]
        self.assertEqual(self.rows("SELECT job_key FROM app.jobs WHERE job_key = ANY(%s)", [gone]), [(fixture_key("t_gone_tracked"),)])
        for key in ("run_id", "upserted_before_finish", "deleted_jobs", "kept_tracked_not_in_snapshot", "pruned_state",
                    "derivations_refreshed", "counts"):
            self.assertIn(key, result)

    def test_prune(self):
        self.many("INSERT INTO app.user_activity_day (user_id, day, visits) VALUES (%s, current_date - %s, 1)",
                  [[U_MAIN, 181], [U_MAIN, 180], [U_MAIN, 1], [U_OTHER, 400]])
        self.finish("fixture-run-trust-2", self.stage("fixture-run-trust-2", self.current()))
        days = self.rows("""SELECT user_id::text, current_date - day FROM app.user_activity_day
                            WHERE user_id IN (%s, %s) ORDER BY 1, 2""", [U_MAIN, U_OTHER])
        self.assertEqual(days, [(U_MAIN, 1), (U_MAIN, 180)])


class AdminReadsTest(TrustTestCase):
    def metrics(self):
        return self.read("metrics", uid=U_ADMIN, admin=True)[0]

    def week(self, m, monday):
        return next(w for w in m["weeks"] if w["week"] == monday.isoformat())

    def test_metrics_is_admin_only(self):
        with self.assertSqlError("Admins only", "42501"):
            self.read("metrics")
        with self.assertSqlError("Admins only", "42501"):
            self.read("metrics", uid=U_OTHER)
        with self.assertSqlError("Unknown action: metrics"):
            self.write("metrics", uid=U_ADMIN, admin=True)

    def test_metrics_shape(self):
        m = self.metrics()
        self.assertEqual(set(m), {"generated_at", "collecting_since", "weeks", "weekly_return", "retention",
                                  "outcome_capture", "guardrails"})
        today = self.value("SELECT current_date")
        monday = today - dt.timedelta(days=today.weekday())
        self.assertEqual([w["week"] for w in m["weeks"]], [(monday - dt.timedelta(weeks=i)).isoformat() for i in range(8)])
        for w in m["weeks"]:
            self.assertEqual(set(w), {"week", "active_users", "strong_applications", "north_star", "acted_strong",
                                      "missed_strong", "coverage"})
        self.assertEqual(set(m["weekly_return"]), {"active_7d", "habitual_7d", "share"})
        self.assertEqual(set(m["retention"]), {"new_users", "d1_eligible", "d1", "d7_eligible", "d7"})
        self.assertEqual(set(m["outcome_capture"]), {"eligible", "moved", "share"})
        self.assertEqual(set(m["guardrails"]), {"applications_28d", "duplicate_applications_28d", "duplicate_rate",
                                                "median_hours_to_apply"})

    def test_metrics_values(self):
        base = self.metrics()
        today = self.value("SELECT current_date")
        monday = today - dt.timedelta(days=today.weekday())
        # activity: U_MAIN active today, U_OTHER on 3 of the last 7 days; acted / missed this week
        self.write("ping", {})
        self.many("""INSERT INTO app.user_activity_day (user_id, day, visits, acted_strong, missed_strong)
                     VALUES (%s, %s, 1, %s, %s)""",
                  [[U_OTHER, today, 3, 1], [U_OTHER, today - dt.timedelta(days=1), 0, 0],
                   [U_OTHER, today - dt.timedelta(days=2), 0, 0]])
        # a strong application now (fit_at_action set by the write) and a weak one
        self.assertGreaterEqual(self.job_row(K["t_exp_two"])["fit_score"], STRONG)
        self.write("setStatus", {"jobKey": K["t_exp_two"], "status": "applied"})
        self.write("setStatus", {"jobKey": K["t_exp_weak"], "status": "applied"})
        # outcomes: two applications 30 days ago (14+ days old, outside the 28-day guardrails), one moved on
        self.insert_state(U_OTHER, KEY["level"], {"is_applied": True, "applied_at": NOW - dt.timedelta(days=30),
                                                  "application_status": "interviewing"})
        self.insert_state(U_OTHER, KEY["title"], {"is_applied": True, "applied_at": NOW - dt.timedelta(days=30),
                                                  "application_status": "applied"})
        # duplicates: two postings of one job applied to by one user
        self.insert_jobs([strong_job("t_dup_a", title="Zz Fixture Dup Thing - Zz Fixture Town"),
                          strong_job("t_dup_b", title="Zz Fixture Dup Thing, Zz Fixture Village")])
        self.assertEqual(self.value("SELECT count(DISTINCT dup_group) FROM app.jobs WHERE job_key = ANY(%s)",
                                    [[fixture_key("t_dup_a"), fixture_key("t_dup_b")]]), 1)
        self.insert_state(U_FALLBACK, fixture_key("t_dup_a"), {"is_applied": True, "applied_at": NOW - dt.timedelta(hours=1),
                                                               "application_status": "applied"})
        self.insert_state(U_FALLBACK, fixture_key("t_dup_b"), {"is_applied": True, "applied_at": NOW - dt.timedelta(minutes=10),
                                                               "application_status": "applied"})
        # a new user: signed up 8 days ago, back the next day and on day 7
        new_uid = fixture_uid(42)
        self.sql("""INSERT INTO auth.users (id, email, aud, role, created_at)
                    VALUES (%s, 'fixture.new@jobseeker.test', 'authenticated', 'authenticated', now() - interval '8 days')""",
                 [new_uid])
        self.many("INSERT INTO app.user_activity_day (user_id, day, visits) VALUES (%s, %s, 1)",
                  [[new_uid, today - dt.timedelta(days=7)], [new_uid, today - dt.timedelta(days=1)]])

        m = self.metrics()
        week, base_week = self.week(m, monday), self.week(base, monday)
        self.assertEqual(week["active_users"] - base_week["active_users"], 2 + int(today - dt.timedelta(days=1) >= monday))
        self.assertEqual(week["strong_applications"] - base_week["strong_applications"], 1)
        self.assertEqual(week["acted_strong"] - base_week["acted_strong"], 3 + 1)  # U_OTHER's 3 + the write's 1
        self.assertEqual(week["missed_strong"] - base_week["missed_strong"], 1)
        if base_week["active_users"] == 0:
            self.assertEqual(week["north_star"], half_up(week["strong_applications"] / week["active_users"], 2))
        if base_week["acted_strong"] + base_week["missed_strong"] == 0:
            self.assertEqual(week["coverage"], 0.8)
        wr, base_wr = m["weekly_return"], base["weekly_return"]
        self.assertEqual(wr["active_7d"] - base_wr["active_7d"], 3)       # U_MAIN, U_OTHER, the new user
        self.assertEqual(wr["habitual_7d"] - base_wr["habitual_7d"], 1)   # U_OTHER
        ret, base_ret = m["retention"], base["retention"]
        self.assertEqual({k: ret[k] - base_ret[k] for k in ret}, {"new_users": 1, "d1_eligible": 1, "d1": 1, "d7_eligible": 1, "d7": 1})
        out, base_out = m["outcome_capture"], base["outcome_capture"]
        self.assertEqual((out["eligible"] - base_out["eligible"], out["moved"] - base_out["moved"]), (2, 1))
        g, base_g = m["guardrails"], base["guardrails"]
        self.assertEqual(g["applications_28d"] - base_g["applications_28d"], 4)
        self.assertEqual(g["duplicate_applications_28d"] - base_g["duplicate_applications_28d"], 1)
        self.assertIsNotNone(g["median_hours_to_apply"])
        self.assertEqual(round(g["median_hours_to_apply"], 1), g["median_hours_to_apply"])
        self.assertEqual(g["duplicate_rate"], half_up(g["duplicate_applications_28d"] / g["applications_28d"], 2))
        self.assertLessEqual(m["collecting_since"], (today - dt.timedelta(days=7)).isoformat())
        # counters only: nothing that names a job
        text = str(m)
        self.assertNotIn(K["t_exp_two"], text)
        self.assertNotIn("http", text)

    def test_empty_values_are_null(self):
        self.sql("DELETE FROM app.user_activity_day WHERE true")
        m = self.metrics()
        self.assertIsNone(m["collecting_since"])
        self.assertTrue(all(w["active_users"] == 0 and w["north_star"] is None and w["coverage"] is None for w in m["weeks"]))
        self.assertEqual(m["weekly_return"], {"active_7d": 0, "habitual_7d": 0, "share": None})

    def test_allowed_emails_extras(self):
        self.write("ping", {})
        now = self.value("SELECT now()")
        self.sql("UPDATE auth.users SET email = upper(email) WHERE id = %s", [U_OTHER])  # matched case-insensitively
        self.write("setStatus", {"jobKey": KEY["level"], "status": "applied"}, uid=U_OTHER)
        self.insert_state(U_OTHER, KEY["title"], {"is_applied": True, "applied_at": NOW - dt.timedelta(days=8),
                                                  "application_status": "applied"})
        rows = {r["email"]: r for r in self.read("allowedEmails", uid=U_ADMIN, admin=True)}
        main = rows[EMAILS[U_MAIN]]
        self.assertEqual(set(main), {"email", "added_at", "last_active_at", "applied_7d"})
        self.assertEqual(dt.datetime.fromisoformat(main["last_active_at"]), now)
        self.assertEqual(main["applied_7d"], 2)  # base.py: rank2 (1 day ago) and inactive_applied (2 days ago)
        other = rows[EMAILS[U_OTHER]]
        self.assertEqual(other["applied_7d"], 2)  # rank1 (3 days ago) and level now; title is 8 days old
        self.assertIsNotNone(other["last_active_at"])  # the write
        fallback = rows[EMAILS[U_FALLBACK]]
        self.assertEqual((fallback["last_active_at"], fallback["applied_7d"]), (None, 0))
        self.sql("INSERT INTO app.allowed_emails (email) VALUES ('fixture.nobody@jobseeker.test')")
        nobody = next(r for r in self.read("allowedEmails", uid=U_ADMIN, admin=True) if r["email"] == "fixture.nobody@jobseeker.test")
        self.assertEqual((nobody["last_active_at"], nobody["applied_7d"]), (None, 0))

    def test_allowed_emails_without_auth_users_access(self):
        # The function run as an owner that may read the app tables but not auth.users (the old client's Access tab
        # must keep working): the list in the old shape plus null extras
        full = self.read("allowedEmails", uid=U_ADMIN, admin=True)
        self.sql("CREATE ROLE zz_fixture_no_auth NOLOGIN BYPASSRLS")  # like the real owner, minus auth.users
        self.sql("GRANT USAGE, CREATE ON SCHEMA app TO zz_fixture_no_auth")
        self.sql("GRANT SELECT ON app.allowed_emails, app.user_activity_day, app.user_job_state TO zz_fixture_no_auth")
        # Supabase's postgres is not a superuser: handing ownership to a role needs membership with SET
        self.sql("GRANT zz_fixture_no_auth TO CURRENT_USER WITH SET TRUE")
        self.sql("ALTER FUNCTION app.read_allowed_emails() OWNER TO zz_fixture_no_auth")
        self.sql("ALTER FUNCTION app.read_allowed_emails() SECURITY DEFINER")
        rows = self.read("allowedEmails", uid=U_ADMIN, admin=True)
        self.assertTrue(full)
        self.assertEqual([(r["email"], r["added_at"]) for r in rows], [(r["email"], r["added_at"]) for r in full])
        self.assertTrue(all(r["last_active_at"] is None and r["applied_7d"] is None for r in rows))
