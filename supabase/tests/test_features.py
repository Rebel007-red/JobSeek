"""Feature-wave reads and writes: statuses, notes, follow-up, tabs, closed jobs, mute rules, duplicate groups, derived
job columns, city / work mode / employment filters and facets, search exclusions, also-know skills, the new reads
(jobRow, jobGroup, jobNote, trackedJobs, systemStatus) and companyHealth with scrape results.

Extra fixture jobs (names "f_...") are added per test on top of base.py's world. Their titles and locations use only
the fixture city aliases (the real app.ref_cities rows are in the same database), and lists with scope "all" are
narrowed to fixture jobs (q "zz fixture" or the fixture company), since real jobs share that scope.
"""
import datetime as dt

from base import (CITY, COMPANY, FIXTURE_KEYS, KEY, NOW, OTHER_COMPANY, R_DE, TODAY, U_ADMIN, U_FALLBACK, U_MAIN,
                  U_NOPROFILE, U_OTHER, DbTestCase, _job, fixture_key)

VILLAGE = "Zz Fixture Village"
EXTRA = [
    # three postings of one job (city and req-code noise in the title); f_dup_a has the best fit, then b, then c
    _job("f_dup_a", role_title=R_DE, title="Zz Fixture Dup Engineer - Zz Fixture Town", location="Zz Fixture Town",
         skills=["Zz Fixture Spark", "Zz Fixture SQL"], experience_min_years=3, role_score=0.9),
    _job("f_dup_b", role_title=R_DE, title="Zz Fixture Dup Engineer, Zz Fixture Village", location=VILLAGE,
         skills=["Zz Fixture Spark"], experience_min_years=3, role_score=0.9),
    _job("f_dup_c", role_title=R_DE, title="Zz Fixture Dup Engineer 104124", location="Zz Fixture Nowhere",
         skills=["Zz Fixture Excel"], experience_min_years=3, role_score=0.9, first_seen_at=NOW - dt.timedelta(hours=5)),
    # work modes and employment kinds
    _job("f_remote", role_title=R_DE, title="Zz Fixture Remote Thing", location="Zz Fixture Nowhere",
         description="This is a fully remote role.", employment_type="Contract", skills=["Zz Fixture Spark"],
         experience_min_years=3),
    _job("f_teams", role_title=R_DE, title="Zz Fixture Teams Thing", location=VILLAGE,
         description="We work with remote teams.", employment_type=None, skills=["Zz Fixture Spark"], experience_min_years=3),
    _job("f_intern", role_title=R_DE, title="Zz Fixture Intern Thing", location=VILLAGE,
         description="Work from office five days.", employment_type=None, skills=["Zz Fixture Spark"], experience_min_years=3),
]
K = {name: fixture_key(name) for name in ("f_dup_a", "f_dup_b", "f_dup_c", "f_remote", "f_teams", "f_intern")}
ALL_KEYS = FIXTURE_KEYS + list(K.values())
FIXTURES = {"q": "zz fixture"}  # every fixture title has it, no real job does


def affected(rows):
    return rows[0]["num_affected_rows"]


class FeatureTestCase(DbTestCase):
    def setUp(self):
        super().setUp()
        self.insert_jobs(EXTRA)

    def mine(self, rows):
        keys = set(ALL_KEYS)
        return [r for r in rows if r["job_key"] in keys]

    def list(self, params=None, uid=U_MAIN):
        return self.mine(self.read("jobs", {"scope": "all", "limit": 100, **FIXTURES, **(params or {})}, uid=uid))

    def keys(self, params=None, uid=U_MAIN):
        return [r["job_key"] for r in self.list(params, uid)]

    def state(self, job_key, uid=U_MAIN):
        row = self.conn.execute("""SELECT is_applied, applied_at, is_hidden, hidden_at, application_status, status_updated_at,
                                          note, next_action_at, hide_reason
                                   FROM app.user_job_state WHERE user_id = %s AND job_key = %s""", [uid, job_key]).fetchone()
        return None if row is None else dict(zip(["is_applied", "applied_at", "is_hidden", "hidden_at", "application_status",
                                                  "status_updated_at", "note", "next_action_at", "hide_reason"], row))

    def job_row(self, job_key, uid=U_MAIN):
        rows = self.read("jobRow", {"jobKey": job_key}, uid=uid)
        return rows[0] if rows else None


class StatusTest(FeatureTestCase):
    def test_set_status_semantics(self):
        key = KEY["level"]
        self.assertEqual(self.write("setStatus", {"jobKey": key, "status": "saved"}), [{"num_affected_rows": 1, "status": "saved"}])
        st = self.state(key)
        self.assertEqual((st["application_status"], st["is_applied"], st["applied_at"]), ("saved", False, None))
        self.write("setStatus", {"jobKey": key, "status": "interviewing"})
        st = self.state(key)
        self.assertTrue(st["is_applied"])
        self.assertIsNotNone(st["applied_at"])
        # same status again: status_updated_at stays; applied_at stays the first time
        self.sql("""UPDATE app.user_job_state SET status_updated_at = '2026-01-01Z', applied_at = '2026-01-02Z'
                    WHERE user_id = %s AND job_key = %s""", [U_MAIN, key])
        self.write("setStatus", {"jobKey": key, "status": "interviewing"})
        self.assertEqual(self.state(key)["status_updated_at"], dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc))
        self.write("setStatus", {"jobKey": key, "status": "offer"})
        st = self.state(key)
        self.assertEqual(st["applied_at"], dt.datetime(2026, 1, 2, tzinfo=dt.timezone.utc))
        self.assertGreater(st["status_updated_at"], dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc))
        # back to not_applied clears applied
        self.write("setStatus", {"jobKey": key, "status": "not_applied"})
        st = self.state(key)
        self.assertEqual((st["application_status"], st["is_applied"], st["applied_at"]), ("not_applied", False, None))

    def test_tracked_status_unhides_and_keeps_note(self):
        key = KEY["hidden"]
        self.write("setHidden", {"jobKey": key, "hidden": True, "reason": "wrong_role"})
        self.sql("UPDATE app.user_job_state SET note = 'keep me' WHERE user_id = %s AND job_key = %s", [U_MAIN, key])
        self.write("setStatus", {"jobKey": key, "status": "saved"})
        st = self.state(key)
        self.assertEqual((st["is_hidden"], st["hidden_at"], st["hide_reason"], st["note"]), (False, None, None, "keep me"))
        # not_applied leaves the hidden flag alone
        self.write("setHidden", {"jobKey": key, "hidden": True})
        self.write("setStatus", {"jobKey": key, "status": "not_applied"})
        self.assertTrue(self.state(key)["is_hidden"])

    def test_bulk_keys(self):
        keys = [KEY["level"], KEY["below"], KEY["level"], "f" * 64]
        # the duplicate is ignored, a job that does not exist writes nothing
        self.assertEqual(affected(self.write("setStatus", {"jobKeys": keys, "status": "saved"})), 2)
        self.assertEqual(self.state(KEY["below"])["application_status"], "saved")
        self.assertEqual(affected(self.write("setHidden", {"jobKeys": [KEY["rank1"], KEY["title"]], "hidden": True,
                                                           "reason": "too_senior"})), 2)
        self.assertEqual(self.state(KEY["title"])["hide_reason"], "too_senior")
        for bad in ([], [KEY["rank1"]] * 101, "x", {"a": 1}):
            with self.subTest(bad=str(bad)[:20]):
                with self.assertSqlError("Pick between 1 and 100 jobs"):
                    self.write("setStatus", {"jobKeys": bad, "status": "saved"})
        with self.assertSqlError("Invalid job key"):
            self.write("setHidden", {"jobKeys": [KEY["rank1"], "nope"], "hidden": True})
        # 100 distinct keys are fine
        self.assertEqual(affected(self.write("setStatus", {"jobKeys": [f"{i:064x}" for i in range(99)] + [KEY["level"]],
                                                           "status": "saved"})), 1)

    def test_status_validation(self):
        for bad in ("Applied", "", None, 5, "maybe"):
            with self.assertSqlError("Invalid status"):
                self.write("setStatus", {"jobKey": KEY["level"], "status": bad})
        with self.assertSqlError("Invalid job key"):
            self.write("setStatus", {"status": "saved"})

    def test_set_applied_keeps_stage(self):
        key = KEY["level"]
        self.write("setStatus", {"jobKey": key, "status": "interviewing"})
        self.sql("UPDATE app.user_job_state SET status_updated_at = '2026-01-01Z' WHERE user_id = %s AND job_key = %s", [U_MAIN, key])
        self.write("setApplied", {"jobKey": key, "applied": True})
        st = self.state(key)
        self.assertEqual(st["application_status"], "interviewing")
        self.assertEqual(st["status_updated_at"], dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc))  # no change, no move
        self.write("setStatus", {"jobKey": key, "status": "saved"})
        self.write("setApplied", {"jobKey": key, "applied": True})
        self.assertEqual(self.state(key)["application_status"], "applied")
        self.write("setApplied", {"jobKey": key, "applied": False})
        self.assertEqual(self.state(key)["application_status"], "not_applied")

    def test_hide_reason_and_feedback(self):
        key = KEY["rank1"]
        self.write("setHidden", {"jobKey": key, "hidden": True})
        self.assertIsNone(self.state(key)["hide_reason"])
        self.assertEqual(self.value("SELECT count(*) FROM app.job_feedback WHERE user_id = %s", [U_MAIN]), 0)
        self.write("setHidden", {"jobKey": key, "hidden": True, "reason": "too_senior"})
        self.write("setHidden", {"jobKey": key, "hidden": True})  # a later hide without a reason keeps it
        self.assertEqual(self.state(key)["hide_reason"], "too_senior")
        self.assertEqual(self.rows("""SELECT reason, title, company_name, role_title FROM app.job_feedback
                                      WHERE user_id = %s AND job_key = %s""", [U_MAIN, key]),
                         [("too_senior", "Zz Fixture Senior Data Engineer", COMPANY, R_DE)])
        self.write("setHidden", {"jobKey": key, "hidden": True, "reason": "wrong_role"})
        self.assertEqual(self.value("SELECT reason FROM app.job_feedback WHERE user_id = %s AND job_key = %s", [U_MAIN, key]),
                         "wrong_role")
        self.assertEqual(next(r for r in self.read("hiddenJobs") if r["job_key"] == key)["hide_reason"], "wrong_role")
        self.write("setHidden", {"jobKey": key, "hidden": False})  # an undo or a restore takes the judgement back
        self.assertIsNone(self.state(key)["hide_reason"])
        self.assertEqual(self.value("SELECT count(*) FROM app.job_feedback WHERE user_id = %s", [U_MAIN]), 0)
        for bad in ("bored", 3, ""):
            with self.assertSqlError("Invalid hide reason"):
                self.write("setHidden", {"jobKey": key, "hidden": True, "reason": bad})
        self.write("setHidden", {"jobKey": key, "hidden": True, "reason": None})
        self.write("restoreHidden")
        self.assertIsNone(self.state(key)["hide_reason"])

    def test_restore_drops_only_restored_feedback(self):
        self.write("setHidden", {"jobKeys": [KEY["rank1"], KEY["title"]], "hidden": True, "reason": "wrong_role"})
        self.write("setStatus", {"jobKey": KEY["title"], "status": "saved"})  # unhidden by saving: its feedback stays
        self.write("setHidden", {"jobKey": KEY["rank1"], "hidden": True, "reason": "wrong_role"}, uid=U_OTHER)
        self.write("restoreHidden")
        self.assertEqual(self.rows("SELECT job_key FROM app.job_feedback WHERE user_id = %s", [U_MAIN]), [(KEY["title"],)])
        self.assertEqual(self.value("SELECT count(*) FROM app.job_feedback WHERE user_id = %s", [U_OTHER]), 1)

    def test_undo_restores_times(self):
        key = KEY["level"]
        self.write("setStatus", {"jobKey": key, "status": "applied"})
        self.sql("UPDATE app.user_job_state SET applied_at = '2026-01-02Z', status_updated_at = '2026-01-03Z' "
                 "WHERE user_id = %s AND job_key = %s", [U_MAIN, key])
        self.write("setStatus", {"jobKey": key, "status": "not_applied"})
        self.assertIsNone(self.state(key)["applied_at"])
        # the undo puts both times back (applied_at only fills a missing one)
        self.write("setStatus", {"jobKey": key, "status": "applied", "appliedAt": "2026-01-02T00:00:00.000Z",
                                 "statusUpdatedAt": "2026-01-03T00:00:00.000Z"})
        st = self.state(key)
        self.assertEqual((st["applied_at"], st["status_updated_at"]),
                         (dt.datetime(2026, 1, 2, tzinfo=dt.timezone.utc), dt.datetime(2026, 1, 3, tzinfo=dt.timezone.utc)))
        self.write("setStatus", {"jobKey": key, "status": "interviewing", "appliedAt": "2025-05-05T00:00:00Z"})
        st = self.state(key)
        self.assertEqual(st["applied_at"], dt.datetime(2026, 1, 2, tzinfo=dt.timezone.utc))  # kept
        self.assertGreater(st["status_updated_at"], NOW - dt.timedelta(minutes=5))  # no time given: now
        # a time in the future is read as now; a status that does not change keeps its time
        self.write("setStatus", {"jobKey": key, "status": "offer", "statusUpdatedAt": "2999-01-01T00:00:00Z"})
        self.assertLess(self.state(key)["status_updated_at"], dt.datetime(2999, 1, 1, tzinfo=dt.timezone.utc))
        before = self.state(key)["status_updated_at"]
        self.write("setStatus", {"jobKey": key, "status": "offer", "statusUpdatedAt": "2026-01-01T00:00:00Z"})
        self.assertEqual(self.state(key)["status_updated_at"], before)
        for bad in ("yesterday", 5, True, "2026-13-45"):
            with self.subTest(bad=bad):
                with self.assertSqlError("Invalid date"):
                    self.write("setStatus", {"jobKey": key, "status": "saved", "statusUpdatedAt": bad})
        self.write("setStatus", {"jobKey": key, "status": "saved", "appliedAt": None, "statusUpdatedAt": None})


class NoteTest(FeatureTestCase):
    def test_note_promotes_to_saved(self):
        key = KEY["level"]
        rows = self.write("setNote", {"jobKey": key, "note": "  Call the recruiter  ", "nextActionAt": None})
        self.assertEqual(rows, [{"num_affected_rows": 1, "application_status": "saved"}])
        st = self.state(key)
        self.assertEqual((st["note"], st["next_action_at"], st["application_status"]), ("Call the recruiter", None, "saved"))
        self.assertEqual(self.read("jobNote", {"jobKey": key})[0]["note"], "Call the recruiter")
        self.assertTrue(self.job_row(key)["has_note"])
        # an applied job stays applied; clearing the note keeps the status
        self.write("setStatus", {"jobKey": key, "status": "applied"})
        date = TODAY + dt.timedelta(days=10)
        self.assertEqual(self.write("setNote", {"jobKey": key, "note": "", "nextActionAt": date.isoformat()})[0]["application_status"],
                         "applied")
        st = self.state(key)
        self.assertEqual((st["note"], st["next_action_at"]), (None, date))
        self.assertFalse(self.job_row(key)["has_note"])
        self.assertEqual(self.read("jobNote", {"jobKey": key})[0]["next_action_at"], date.isoformat())
        # a date alone also saves an untracked job; nothing at all does not
        self.assertEqual(self.write("setNote", {"jobKey": KEY["below"], "note": None, "nextActionAt": date.isoformat()})[0]
                         ["application_status"], "saved")
        self.assertEqual(self.write("setNote", {"jobKey": KEY["title"], "note": " ", "nextActionAt": ""})[0]["application_status"],
                         "not_applied")
        self.assertEqual(self.write("setNote", {"jobKey": "f" * 64, "note": "x"}), [{"num_affected_rows": 0, "application_status": None}])
        # saving a hidden job by a note unhides it (as setStatus 'saved' does), so it is listed on the Saved tab
        self.write("setNote", {"jobKey": KEY["hidden"], "note": "Ask about the team", "nextActionAt": None})
        st = self.state(KEY["hidden"])
        self.assertEqual((st["application_status"], st["is_hidden"], st["hidden_at"]), ("saved", False, None))
        self.assertIn(KEY["hidden"], [r["job_key"] for r in self.read("jobs", {"tab": "saved", "scope": "all"})])

    def test_note_validation(self):
        key = KEY["level"]
        self.write("setNote", {"jobKey": key, "note": "n" * 2000})
        with self.assertSqlError("Note: at most 2000 characters"):
            self.write("setNote", {"jobKey": key, "note": "n" * 2001})
        for bad in (5, ["a"], {"a": 1}, True):
            with self.assertSqlError("Note must be text"):
                self.write("setNote", {"jobKey": key, "note": bad})
        for bad in ("2026-02-30", "tomorrow", "2026-1-5", 20260101, (TODAY + dt.timedelta(days=367)).isoformat(),
                    (TODAY - dt.timedelta(days=367)).isoformat(), "2026-01-01T00:00:00Z"):
            with self.subTest(date=bad):
                with self.assertSqlError("Invalid follow-up date"):
                    self.write("setNote", {"jobKey": key, "note": "x", "nextActionAt": bad})
        self.write("setNote", {"jobKey": key, "note": "x", "nextActionAt": (TODAY - dt.timedelta(days=366)).isoformat()})
        with self.assertSqlError("Invalid job key"):
            self.write("setNote", {"note": "x"})
        with self.assertSqlError("Invalid job key"):
            self.read("jobNote", {"jobKey": "x"})
        self.assertEqual(self.read("jobNote", {"jobKey": KEY["rank1"]}), [])

    def test_follow_up(self):
        key = KEY["level"]
        self.write("setStatus", {"jobKey": key, "status": "applied"})
        self.assertFalse(self.job_row(key)["follow_up"])
        self.sql("UPDATE app.user_job_state SET status_updated_at = now() - interval '15 days' WHERE user_id = %s AND job_key = %s",
                 [U_MAIN, key])
        self.assertTrue(self.job_row(key)["follow_up"])
        # a follow-up date in the future wins over the 14 days
        self.write("setNote", {"jobKey": key, "note": None, "nextActionAt": (TODAY + dt.timedelta(days=3)).isoformat()})
        self.assertFalse(self.job_row(key)["follow_up"])
        self.write("setNote", {"jobKey": key, "note": None, "nextActionAt": TODAY.isoformat()})
        self.assertTrue(self.job_row(key)["follow_up"])
        self.assertEqual(self.keys({"tab": "applied", "followUp": True}), [key])
        self.assertEqual(self.read("summary", {"scope": "all"})[0]["follow_up"], 1)
        # only while the status is 'applied'
        self.write("setStatus", {"jobKey": key, "status": "interviewing"})
        self.assertFalse(self.job_row(key)["follow_up"])


class TabsTest(FeatureTestCase):
    def test_saved_tab_and_closed_saved_jobs(self):
        self.write("setStatus", {"jobKeys": [KEY["level"], KEY["inactive"], KEY["old"]], "status": "saved"})
        self.assertEqual(set(self.keys({"tab": "saved"})), {KEY["level"], KEY["inactive"], KEY["old"]})
        # saved jobs pass the time window on the Saved tab, and stay visible after the posting closed
        self.assertEqual(set(self.keys({"tab": "saved", "postedWithin": 24})), {KEY["level"], KEY["inactive"], KEY["old"]})
        self.assertNotIn(KEY["old"], self.keys({"tab": "pending", "postedWithin": 24}))
        self.assertIn(KEY["old"], self.keys({"tab": "pending"}))  # saved jobs are on To apply too
        # VISIBLE / MATCH: a saved job is For you whatever its fit
        self.write("setStatus", {"jobKey": KEY["halfup"], "status": "saved"})
        self.assertIn(KEY["halfup"], [r["job_key"] for r in self.read("jobs", {"tab": "saved", "limit": 100})])
        row = self.job_row(KEY["inactive"])
        self.assertEqual((row["is_active"], row["in_for_you"], row["application_status"]), (False, True, "saved"))
        summary = self.read("summary", {"scope": "all"})[0]
        self.assertEqual(summary["saved"], 4)
        self.assertEqual(summary["closed"], 2)  # inactive_applied + the saved inactive job

    def test_closed_and_stage_filters(self):
        self.write("setStatus", {"jobKey": KEY["rank2"], "status": "rejected"})
        applied = set(self.keys({"tab": "applied"}))
        self.assertEqual(applied, {KEY["rank2"], KEY["inactive_applied"]})
        self.assertEqual(self.keys({"tab": "applied", "closed": "only"}), [KEY["inactive_applied"]])
        self.assertEqual(self.keys({"tab": "applied", "closed": "hide"}), [KEY["rank2"]])
        self.assertEqual(set(self.keys({"tab": "applied", "closed": "other"})), applied)  # invalid: no clause
        self.assertEqual(self.keys({"tab": "applied", "stage": "rejected"}), [KEY["rank2"]])
        self.assertEqual(self.keys({"tab": "applied", "stage": "applied"}), [KEY["inactive_applied"]])
        self.assertEqual(set(self.keys({"tab": "applied", "stage": "saved"})), applied)  # not an applied stage: ignored
        stages = self.read("summary", {"scope": "all"})[0]["stages"]
        self.assertEqual(stages, {"applied": 1, "interviewing": 0, "offer": 0, "rejected": 1, "withdrawn": 0})

    def test_summary_matches_tab_totals(self):
        self.write("setStatus", {"jobKeys": [KEY["level"], KEY["below"]], "status": "saved"})
        for params in ({}, {"scope": "all"}, {"postedWithin": 24}, {"scope": "all", "postedWithin": 48}):
            with self.subTest(params=params):
                summary = self.read("summary", {**params, "company": COMPANY})[0]
                for tab, count in (("pending", "pending"), ("saved", "saved"), ("applied", "applied"), ("all", "total")):
                    rows = self.read("jobs", {**params, "company": COMPANY, "tab": tab, "limit": 100})
                    self.assertEqual(rows[0]["total_count"] if rows else 0, summary[count], f"{tab} vs {count}")


class MuteTest(FeatureTestCase):
    def mute(self, uid=U_MAIN, **rules):
        return self.write("saveMuteRules", rules, uid=uid)

    def muted(self):
        return {r["job_key"]: (r["muted_by"], r["muted_value"]) for r in self.list({"muteView": "only"})}

    def test_each_kind_and_tracked_never_muted(self):
        rows = self.mute(companies=["zz fixture other co."], titleWords=["Analytics"], levels=["Mid"])
        self.assertEqual(rows[0]["muted_companies"], ["zz fixture other co."])
        everything = set(self.keys())
        self.assertNotIn(KEY["other_company"], everything)  # company (key match: case, punctuation, "Co")
        self.assertNotIn(KEY["title"], everything)          # title "Zz Fixture Analytics Engineer II"
        self.assertIn(KEY["rank2"], everything)             # "Zz Fixture Analytics Role" is applied: never muted
        muted = self.muted()
        self.assertEqual(muted[KEY["other_company"]], ("company", "zz fixture other co."))
        self.assertEqual(muted[KEY["title"]], ("title", "analytics"))  # first match wins (it is also level Mid)
        self.assertNotIn(KEY["rank2"], muted)
        self.mute(titleWords=[])
        muted = self.muted()
        self.assertEqual(muted[KEY["title"]], ("level", "Mid"))
        self.assertEqual(muted[KEY["other_company"]], ("company", "zz fixture other co."))  # a missing list keeps the rule
        # a word only matches whole words
        self.mute(companies=[], levels=[], titleWords=["dup eng", "Remote Thing"])
        self.assertEqual(list(self.muted()), [K["f_remote"]])
        # summary.muted counts muted jobs inside the window; facets leave them out (f_remote is For you)
        self.assertEqual(self.read("summary", {"scope": "all", "company": COMPANY})[0]["muted"], 1)
        self.assertNotIn(("work_mode", "remote"), {(r["kind"], r["value"]) for r in self.read("facets")})
        self.assertEqual(self.keys({"workMode": "remote"}), [])
        self.mute(titleWords=None)  # null keeps the list
        self.assertEqual(list(self.muted()), [K["f_remote"]])
        self.mute(titleWords=[])
        self.assertEqual(self.keys({"workMode": "remote"}), [K["f_remote"]])
        self.assertIn(("work_mode", "remote"), {(r["kind"], r["value"]) for r in self.read("facets")})

    def test_validation(self):
        with self.assertSqlError("Save your profile first"):
            self.mute(uid=U_NOPROFILE, companies=["Acme"])
        cases = [
            ({"companies": "Acme"}, "Muted companies must be a list"),
            ({"companies": ["A"]}, 'Muted companies: "A" - Too short'),
            ({"companies": ["The India Pvt Ltd"]}, 'Muted companies: "The India Pvt Ltd" - Not a company name'),
            ({"companies": ["x" * 101]}, 'Muted companies: "' + "x" * 20 + '…" is longer than 100 characters'),
            ({"companies": [f"Company {i}" for i in range(51)]}, "Muted companies: at most 50 items"),
            ({"titleWords": ["a"]}, 'Muted title words: "a" - Too short'),
            ({"titleWords": ["c'est"]}, "Muted title words: \"c'est\" - Use letters, numbers, spaces and . + # & / - only"),
            ({"titleWords": ["-net"]}, 'Muted title words: "-net" - Use letters, numbers, spaces and . + # & / - only'),
            ({"titleWords": [f"word{i}" for i in range(31)]}, "Muted title words: at most 30 items"),
            ({"levels": ["Expert"]}, 'Muted levels: "Expert" is not a level'),
            ({"levels": ["senior"]}, 'Muted levels: "senior" is not a level'),
            # companies are checked before title words, title words before levels
            ({"companies": ["A"], "titleWords": ["b"], "levels": ["x"]}, 'Muted companies: "A" - Too short'),
            ({"titleWords": ["b"], "levels": ["x"]}, 'Muted title words: "b" - Too short'),
        ]
        for params, message in cases:
            with self.subTest(message=message):
                with self.assertSqlError(message):
                    self.mute(**params)
        rows = self.mute(companies=["Acme", "acme", " C++ Labs "], titleWords=["C++", "node.js", "QA/QC"], levels=["Director+"])
        self.assertEqual((rows[0]["muted_companies"], rows[0]["muted_title_words"], rows[0]["muted_levels"]),
                         (["Acme", "C++ Labs"], ["C++", "node.js", "QA/QC"], ["Director+"]))
        self.assertEqual(self.read("profile")[0]["muted_title_words"], ["C++", "node.js", "QA/QC"])
        self.assertIsInstance(self.read("jobs"), list)  # regex special characters are matched literally


class CollapseTest(FeatureTestCase):
    def test_groups(self):
        a, b, c = K["f_dup_a"], K["f_dup_b"], K["f_dup_c"]
        self.assertEqual(self.value("SELECT count(DISTINCT dup_group) FROM app.jobs WHERE job_key = ANY(%s)", [[a, b, c]]), 1)
        rows = {r["job_key"]: r for r in self.list()}
        self.assertIn(a, rows)
        self.assertNotIn(b, rows)
        self.assertNotIn(c, rows)
        self.assertEqual(rows[a]["dup_count"], 2)
        self.assertEqual(rows[a]["dup_keys"], [b, c])  # representative order: fit, then newest
        self.assertEqual(rows[a]["dup_locations"], [VILLAGE, "Zz Fixture Nowhere"])
        self.assertEqual((rows[KEY["rank1"]]["dup_count"], rows[KEY["rank1"]]["dup_keys"]), (0, []))
        flat = self.list({"collapse": False})
        self.assertEqual(len(flat), len(rows) + 2)
        self.assertEqual(flat[0]["total_count"], self.list()[0]["total_count"] + 2)
        self.assertTrue(all(r["dup_count"] == 0 for r in flat))
        summary = self.read("summary", {"scope": "all", "company": COMPANY})[0]
        flat_summary = self.read("summary", {"scope": "all", "company": COMPANY, "collapse": False})[0]
        self.assertEqual(flat_summary["total"] - summary["total"], 2)
        # a filter that keeps one member only: that member shows, alone
        self.assertEqual([(r["job_key"], r["dup_count"]) for r in self.list({"q": "104124"})], [(c, 0)])
        # jobGroup lists every visible member
        group = self.read("jobGroup", {"dupGroup": rows[a]["dup_group"]})
        self.assertEqual([r["job_key"] for r in group], [a, b, c])
        self.assertEqual(group[0]["total_count"], 3)
        for bad in ("abc", rows[a]["dup_group"].upper(), None, 5):
            with self.assertSqlError("Invalid group"):
                self.read("jobGroup", {"dupGroup": bad})

    def test_tracked_job_is_its_own_group_and_dup_applied(self):
        a, b, c = K["f_dup_a"], K["f_dup_b"], K["f_dup_c"]
        self.write("setStatus", {"jobKey": c, "status": "applied"})
        rows = {r["job_key"]: r for r in self.list()}
        self.assertEqual(rows[a]["dup_keys"], [b])
        self.assertEqual(rows[c]["dup_count"], 0)
        self.assertEqual(rows[a]["dup_applied_key"], c)
        self.assertIsNotNone(rows[a]["dup_applied_at"])
        self.assertIsNone(rows[c]["dup_applied_key"])  # the job itself does not count
        self.write("setStatus", {"jobKey": b, "status": "applied"})
        self.sql("UPDATE app.user_job_state SET applied_at = now() - interval '1 day' WHERE user_id = %s AND job_key = %s", [U_MAIN, c])
        self.assertEqual(self.job_row(a)["dup_applied_key"], b)  # the latest one
        self.assertEqual(self.job_row(b)["dup_applied_key"], c)
        self.assertIsNone(self.job_row(a, uid=U_OTHER)["dup_applied_key"])  # per user
        self.assertEqual(affected(self.write("setHidden", {"jobKeys": [a], "hidden": True})), 1)
        self.assertEqual([r["job_key"] for r in self.read("jobGroup", {"dupGroup": self.job_row(b)["dup_group"]})], [b, c])


class DerivedTest(FeatureTestCase):
    def test_company_key(self):
        vectors = {"Barclays": "barclay", "Barclay": "barclay", "PwC India": "pwc", "PWC": "pwc", "WSP in India": "wsp",
                   "Hewlett Packard Enterprise": "hpe", "HPE": "hpe", "Centotech Services Private Limited": "centotech service",
                   "India": "", "Tata Consultancy Services": "tcs", "Ernst & Young": "ey", "PricewaterhouseCoopers": "pwc",
                   "International Business Machines": "ibm", "Glass": "glass", None: "", "The Co.": ""}
        for name, key in vectors.items():
            self.assertEqual(self.value("SELECT app.company_key(%s)", [name]), key, name)

    def test_title_key(self):
        phrases, words = ["navi mumbai"], ["pune", "bangalore", "mumbai"]
        vectors = {"Data Engineer-Senior II": "data engineer senior ii", "Data Engineer - Senior II": "data engineer senior ii",
                   "Data Engineer - Pune": "data engineer", "Data Engineer, Bangalore": "data engineer",
                   "Data Engineer (Navi Mumbai)": "data engineer", "Urgent Hiring: C++ & C# Developer 104124": "c++ and c# developer",
                   "Engineer IRC303076 - Remote": "engineer", "Engineer 2": "engineer", "Engineer L2": "engineer l2", None: ""}
        for title, key in vectors.items():
            self.assertEqual(self.value("SELECT app.title_key_with(%s, %s, %s)", [title, phrases, words]), key, title)

    def test_location_cities(self):
        refs = [("bengaluru", "Bengaluru"), ("bangalore", "Bengaluru"), ("pimpri chinchwad", "Pune"), ("pune", "Pune"),
                ("new delhi", "Delhi"), ("delhi", "Delhi"), ("navi mumbai", "Navi Mumbai"), ("mumbai", "Mumbai"),
                ("hyderabad", "Hyderabad")]
        phrases = sorted((r for r in refs if " " in r[0]), key=lambda r: (-len(r[0]), r[0]))  # as app.city_match has them
        words = [r for r in refs if " " not in r[0]]
        arrays = [[r[0] for r in phrases], [r[1] for r in phrases], [r[0] for r in words], [r[1] for r in words]]
        vectors = {"Greater Bengaluru Area": ["Bengaluru"], "Bengaluru East, Karnataka, India": ["Bengaluru"],
                   "Bangalore Urban": ["Bengaluru"], "Pune/Pimpri-Chinchwad Area": ["Pune"], "New Delhi, Delhi, India": ["Delhi"],
                   "India": [], "Remote": [], None: [], "Navi Mumbai, Maharashtra": ["Navi Mumbai"],
                   "Hyderabad / Bengaluru / Mumbai": ["Hyderabad", "Bengaluru", "Mumbai"],
                   "Navi Mumbai / Navi Mumbai": ["Navi Mumbai"], "Mumbai or Navi Mumbai": ["Mumbai", "Navi Mumbai"]}
        for location, expected in vectors.items():
            self.assertEqual(self.value("SELECT app.location_cities_with(%s, %s, %s, %s, %s)", [location, *arrays]), expected, location)

    def test_work_mode_and_employment(self):
        modes = [(("Data Engineer (Hybrid)", "Pune", ""), "hybrid"), (("Data Engineer", "Remote", ""), "remote"),
                 (("Data Engineer", "x", "We offer a hybrid work model."), "hybrid"),
                 (("Data Engineer", "x", "Work mode: Hybrid"), "hybrid"),
                 (("Data Engineer", "x", "This is a 100% remote position."), "remote"),
                 (("Data Engineer", "x", "remote first company"), "remote"),
                 (("Data Engineer", "x", "We work with remote teams."), None),
                 (("Data Engineer", "x", "Work from office, Pune"), "onsite"),
                 (("Data Engineer Onsite", "x", ""), "onsite"), (("Data Engineer", None, None), None),
                 (("WFH Data Engineer", "x", "work from office"), "remote"),
                 # benefit boilerplate and delivery jargon say nothing; part-week office rules mean hybrid
                 (("Data Engineer", "x", "We offer opportunities to work from home, and paid time off."), None),
                 (("Data Engineer", "x", "We support our employees with remote work options."), None),
                 (("Data Engineer", "x", "Coordinate onsite and offshore delivery. An on-site eatery."), None),
                 (("Data Engineer", "x", "Employees are eligible for remote working arrangements up to 2 days per week."), "hybrid"),
                 (("Data Engineer", "x", "Ability to work onsite approximately 3 days per week"), "hybrid"),
                 (("Data Engineer", "x", "Location: Bangalore (4 days WFO)"), "hybrid"),
                 (("Data Engineer", "x", "Willingness to work in an onsite model (5 days per week)."), "onsite"),
                 (("Data Engineer", "x", "ManagerFully Remote, Hybrid or Fully On-site: HybridLocation: Mohali"), "hybrid"),
                 (("Data Engineer", "x", "Experience: 8+ YearsLocation: RemoteResponsibilities"), "remote"),
                 (("Data Engineer", "x", "Location: Agra, Uttar Pradesh (On-site | Relocation required)"), "onsite"),
                 (("Data Engineer", "x", "Evening shift.No Work from Home.Microsoft MCSE"), "onsite")]
        for (title, location, description), mode in modes:
            self.assertEqual(self.value("SELECT app.work_mode(%s, %s, %s)", [title, location, description]), mode,
                             f"{title} / {description}")
        kinds = [(("Full-time", "x"), "full_time"), (("Full time", "x"), "full_time"), ((" Contract ", "x"), "contract"),
                 (("Temporary", "x"), "contract"), (("Internship", "x"), "internship"), (("Part-time", "x"), "part_time"),
                 (("Volunteer", "x"), "other"), (("Other", "x"), "other"), ((None, "Data Intern"), "internship"),
                 (("Unknown", "Graduate Trainee"), "internship"), ((None, "SQL Developer (Contract to hire)"), "contract"),
                 ((None, "Part time tutor"), "part_time"), ((None, "Data Engineer"), None), (("Full-time", "Intern"), "full_time")]
        for (employment_type, title), kind in kinds:
            self.assertEqual(self.value("SELECT app.employment_kind(%s, %s)", [employment_type, title]), kind, title)

    def test_trigger_refresh_and_backfill(self):
        row = self.rows("SELECT company_key, title_key, city, cities, work_mode, employment_kind FROM app.jobs WHERE job_key = %s",
                        [K["f_dup_a"]])[0]
        self.assertEqual(row, ("zz fixture", "zz fixture dup engineer", CITY, [CITY], None, "full_time"))
        self.assertEqual(self.rows("SELECT work_mode, employment_kind FROM app.jobs WHERE job_key = %s", [K["f_remote"]]),
                         [("remote", "contract")])
        self.assertEqual(self.value("SELECT employment_kind FROM app.jobs WHERE job_key = %s", [K["f_intern"]]), "internship")
        # an update of a source column derives again
        self.sql("UPDATE app.jobs SET location = 'Zz Fixture Village / Zz Fixture Town', title = title || ' (Hybrid)' WHERE job_key = %s",
                 [K["f_dup_a"]])
        self.assertEqual(self.rows("SELECT cities, city, work_mode FROM app.jobs WHERE job_key = %s", [K["f_dup_a"]]),
                         [(["Zz Fixture Village", CITY], "Zz Fixture Village", "hybrid")])
        # a new alias: the refresh picks it up, a second refresh changes nothing
        self.sql("INSERT INTO app.ref_cities (alias, city, state) VALUES ('zz fixture nowhere', 'Zz Fixture Nowhere', NULL)")
        self.assertEqual(self.value("SELECT cities FROM app.jobs WHERE job_key = %s", [K["f_dup_c"]]), [])
        self.assertGreaterEqual(self.value("SELECT app.refresh_job_derivations()"), 2)  # f_dup_c, f_remote
        self.assertEqual(self.value("SELECT city FROM app.jobs WHERE job_key = %s", [K["f_dup_c"]]), "Zz Fixture Nowhere")
        self.assertEqual(self.value("SELECT app.refresh_job_derivations()"), 0)
        self.assertEqual(self.value("SELECT app.refresh_job_derivations(true)"), 0)  # the trigger and the backfill agree

    def test_city_filters_and_facets(self):
        village = {K["f_dup_b"], K["f_teams"], K["f_intern"]}
        self.assertEqual(set(self.keys({"city": VILLAGE, "collapse": False})), village)
        self.assertEqual(set(self.keys({"city": VILLAGE})), village)  # b is alone in its group there
        # U_MAIN prefers CITY: jobs there, or remote
        mine = set(self.keys({"myCities": True, "collapse": False}))
        self.assertIn(K["f_remote"], mine)
        self.assertIn(KEY["rank1"], mine)
        self.assertNotIn(K["f_teams"], mine)
        self.assertEqual(set(self.keys({"myCities": True}, uid=U_FALLBACK)), set(self.keys({}, uid=U_FALLBACK)))  # no cities
        self.assertEqual(self.keys({"workMode": "hybrid"}), [])  # "remote teams" says nothing
        self.assertEqual(self.keys({"workMode": "onsite"}), [K["f_intern"]])
        self.assertIn(KEY["rank1"], self.keys({"workMode": "unknown"}))
        self.assertEqual(set(self.keys({"workMode": "bogus"})), set(self.keys()))
        self.assertEqual(self.keys({"employment": "contract"}), [K["f_remote"]])
        self.assertEqual(self.keys({"employment": "unknown"}), [K["f_teams"]])
        facets = self.read("facets")  # For you: only fixture jobs can match the fixture roles
        by = {(r["kind"], r["value"]): r["n"] for r in facets}
        self.assertEqual(by[("city", VILLAGE)], 3)
        self.assertGreaterEqual(by[("work_mode", "unknown")], 1)
        self.assertEqual(by[("employment", "internship")], 1)
        order = [(r["kind"].encode(), -r["n"], r["value"].encode()) for r in facets]
        self.assertEqual(order, sorted(order))

    def test_search_exclusions(self):
        self.assertEqual(set(self.keys({"q": "zz fixture dup -town", "collapse": False})), {K["f_dup_b"], K["f_dup_c"]})
        self.assertEqual(set(self.keys({"q": "-dup -thing", "company": COMPANY})) & set(K.values()), set())
        dash = set(self.keys({"q": "-", "company": COMPANY, "collapse": False}))  # a lone "-" is a word to find
        self.assertIn(K["f_dup_a"], dash)
        self.assertNotIn(K["f_dup_b"], dash)
        self.assertEqual(set(self.keys({"q": "dup  engineer", "collapse": False})), {K["f_dup_a"], K["f_dup_b"], K["f_dup_c"]})
        self.assertEqual(set(self.keys({"q": "-zz_fixture", "company": COMPANY})),
                         set(self.keys({"q": "", "company": COMPANY})))  # LIKE characters are literal


class ScoringFeatureTest(FeatureTestCase):
    def test_also_know_skills(self):
        self.many("INSERT INTO app.skill_stats (skill, jobs, idf) VALUES (%s, 1, 2.0)",
                  [["zz fixture a"], ["zz fixture b"], ["zz fixture c"], ["zz fixture d"]])
        self.insert_profile(U_NOPROFILE, {"target_roles": [R_DE], "skills": ["Zz Fixture A", "Zz Fixture B", "Zz Fixture C"],
                                          "also_skills": ["Zz Fixture D", "zz fixture a"], "min_years": None, "max_years": None})
        self.insert_jobs([_job("f_tiers", role_title=R_DE, skills=["Zz Fixture A", "Zz Fixture D"])])
        row = self.job_row(fixture_key("f_tiers"), uid=U_NOPROFILE)
        self.assertEqual(row["fit_skills"], 0.5)  # (2 + 0.5 * 2) / 6
        self.assertEqual(row["fit_matched_skills"], ["Zz Fixture A", "Zz Fixture D"])
        self.assertEqual(row["fit_core_matched"], 1)
        self.assertTrue(row["job_skills_known"])
        # without also-know skills: the old value
        self.sql("UPDATE app.user_profile SET also_skills = '{}' WHERE profile_id = %s", [U_NOPROFILE])
        self.assertEqual(self.job_row(fixture_key("f_tiers"), uid=U_NOPROFILE)["fit_skills"], 2.0 / 6.0)

    def test_explanations(self):
        rows = {r["job_key"]: r for r in self.list()}
        ref = self.reference(U_MAIN)
        for key, r in rows.items():
            if key in ref:
                with self.subTest(job=key[:8]):
                    for column in ("fit_role_reason", "fit_core_matched", "fit_exp_years", "job_skills_known", "fit_role_sim"):
                        self.assertEqual(r[column], ref[key][column], column)
                    self.assertEqual(r["in_for_you"], ref[key]["is_match"])
        self.assertEqual(rows[KEY["rank1"]]["fit_role_reason"], "first_role")
        self.assertEqual(rows[KEY["related_match"]]["fit_role_reason"], "related")
        self.assertFalse(rows[KEY["related_match"]]["job_skills_known"])
        self.assertEqual(rows[KEY["related_match"]]["fit_exp_years"], 5)  # Senior

    def test_fit_ties_break_by_freshness(self):
        # same fit: the newer posting first, although its role_score is lower (role_score used to come first)
        self.insert_jobs([
            _job("f_tie_old", role_title=R_DE, title="Zz Fixture Tie Old", skills=["Zz Fixture SQL"], experience_min_years=3,
                 role_score=0.99, posted_date=TODAY - dt.timedelta(days=1), first_seen_at=NOW - dt.timedelta(days=1)),
            _job("f_tie_new", role_title=R_DE, title="Zz Fixture Tie New", skills=["Zz Fixture SQL"], experience_min_years=3,
                 role_score=0.1),
        ])
        rows = self.read("jobs", {"scope": "all", "q": "zz fixture tie"})
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["fit_score"], rows[1]["fit_score"])
        self.assertEqual([r["job_key"] for r in rows], [fixture_key("f_tie_new"), fixture_key("f_tie_old")])

    def test_above_experience_counts_the_level(self):
        # Lead/Manager = 7 years > 3 + 2: out of For you even without stated years
        self.insert_jobs([_job("f_lead", role_title=R_DE, experience_level="Lead/Manager", skills=["Zz Fixture SQL"])])
        row = self.job_row(fixture_key("f_lead"), uid=U_OTHER)  # max 3 years
        self.assertTrue(row["above_experience"])
        self.assertFalse(row["in_for_you"])
        self.assertFalse(self.job_row(fixture_key("f_lead"))["above_experience"])  # U_MAIN: max 5, 7 is not above 7


class NewReadsTest(FeatureTestCase):
    def test_job_row(self):
        row = self.job_row(KEY["hidden"])
        self.assertTrue(row["is_hidden"])  # whatever the filters
        self.assertEqual((row["dup_count"], row["dup_keys"], row["total_count"]), (0, [], 1))
        self.assertIs(self.job_row(KEY["inactive"])["is_active"], False)
        self.assertIsNone(self.job_row("0" * 64))
        with self.assertSqlError("Invalid job key"):
            self.read("jobRow", {"jobKey": "nope"})

    def test_tracked_jobs(self):
        self.write("setNote", {"jobKey": KEY["level"], "note": "a note"})
        rows = self.read("trackedJobs")
        # newest first by applied_at, else the status change (the note saved the job just now)
        self.assertEqual([r["job_key"] for r in rows], [KEY["level"], KEY["rank2"], KEY["inactive_applied"]])
        level = rows[0]
        self.assertEqual((level["note"], level["application_status"]), ("a note", "saved"))
        self.assertEqual(set(level), {"job_key", "title", "company_name", "location", "city", "source", "job_url",
                                      "posted_date", "fit_score", "application_status", "applied_at", "status_updated_at",
                                      "next_action_at", "note", "is_active"})
        self.assertEqual(self.read("trackedJobs", uid=U_FALLBACK), [])

    def test_system_status(self):
        self.sql("""INSERT INTO app.publish_history (run_id, snapshot_at, published_at, counts, upserted, deleted_jobs)
                    VALUES ('987654321', now(), now(), '{"jobs": 12}', 3, 1)""")
        row = self.read("systemStatus", uid=U_ADMIN, admin=True)[0]
        self.assertEqual(set(row), {"database", "counts", "publish", "runs", "scrapes", "linkedin", "generated_at"})
        self.assertEqual(row["database"]["limit_bytes"], 524288000)
        self.assertGreater(row["database"]["bytes"], 0)
        self.assertEqual(row["counts"]["jobs"], self.value("SELECT count(*) FROM app.jobs"))
        if not self.value("SELECT count(*) FROM app.pipeline_runs"):
            self.assertEqual((row["runs"][0]["run_id"], row["runs"][0]["published_jobs"], row["runs"][0]["state"]),
                             ("987654321", 12, None))
        self.service("pipeline_record_runs", {"runs": [{"run_id": 987654321, "started_at": NOW.isoformat(),
                                                        "result": "SUCCESS", "state": "TERMINATED", "tasks": []}]})
        row = self.read("systemStatus", uid=U_ADMIN, admin=True)[0]
        run = next(r for r in row["runs"] if r["run_id"] == "987654321")
        self.assertEqual((run["result"], run["published_jobs"], run["upserted"], run["deleted_jobs"]), ("SUCCESS", 12, 3, 1))
        with self.assertSqlError("Admins only", "42501"):
            self.read("systemStatus")

    def test_company_health_with_scrape_rows(self):
        self.service("pipeline_record_scrape", {
            "format": "jobseeker.scrape_report.v1", "source": "greenhouse",
            "run": {"github_run_id": "fixture-1", "github_run_attempt": 1, "finished_at": NOW.isoformat(), "status": "partial"},
            "companies": [{"name": OTHER_COMPANY, "ok": False, "jobs_found": None, "error": "HTTP 404"},
                          {"name": "Zz Fixture Scrape Only", "ok": True, "jobs_found": 0, "error": None}]})
        rows = {(r["company"], r["source"]): r for r in self.read("companyHealth", uid=U_ADMIN, admin=True)}
        other = rows[("zz fixture other co", "greenhouse")]
        self.assertEqual((other["failures"], other["last_error"], other["jobs_found"]), (1, "HTTP 404", None))
        self.assertIsNotNone(other["latest_first_seen"])
        only = rows[("zz fixture scrape only", "greenhouse")]
        self.assertEqual((only["latest_first_seen"], only["failures"], only["jobs_found"]), (None, 0, 0))
        self.assertIsNotNone(only["last_ok_at"])
