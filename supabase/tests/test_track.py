"""Track release: the 'no_response' status (No reply), replied_at / interviewed_at, action_rank (Needs action) with the
needsAction / stageGroup lists and the 'action' sort, the summary's needs_action and funnel, the weekly check-in read and
markCheckin, pipeline_record_trigger with systemStatus.triggers and status.checked_at, metrics.activation, and the
CHECK migration and backfill of app_schema.sql.

Extra fixture jobs (names "k_...") and their state are added per test on top of base.py's world. Times are set in SQL
relative to now() (the transaction's start, the same instant the reads see), so day boundaries are exact.
"""
import datetime as dt
import re
from decimal import ROUND_HALF_UP, Decimal

import test_pipeline
from base import (KEY, R_AE, R_BI, R_DE, R_ML, R_OUT, R_PE, ROOT, U_ADMIN, U_FALLBACK, U_MAIN, U_NOPROFILE,
                  U_OTHER, DbTestCase, _job, fixture_key, fixture_uid)

APPLIED_STATUSES = ("applied", "interviewing", "offer", "no_response", "rejected", "withdrawn")
SCHEMA = (ROOT / "supabase" / "app_schema.sql").read_text(encoding="utf-8")
ATTEMPT = 1


def half_up(value, digits):
    """PostgreSQL round(numeric, n): half away from zero (Python's round() is half to even)"""
    return float(Decimal(str(value)).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def trigger_doc(**changes):
    doc = {"format": "jobseeker.trigger_report.v1", "github_run_id": "fixture-t1", "github_run_attempt": ATTEMPT,
           "workflow": "ATS Scrapers", "event": "schedule", "decision": "no_new", "forced": False,
           "uploaded_files": 3, "new_files": 0, "new_jobs": 0, "run_id": None, "result": "SKIPPED",
           "message": "no new jobs"}
    doc.update(changes)
    return doc


class TrackTestCase(DbTestCase):
    def setUp(self):
        super().setUp()
        self.now = self.value("SELECT now()")
        self.today = self.value("SELECT current_date")

    def put(self, name, status, *, applied=None, updated=None, next_in=None, replied=None, interviewed=None,
            hidden=False, uid=U_MAIN, job=None):
        """A fixture job k_<name> (inserted once) with this user's state. applied / updated / replied / interviewed are
        days before now() (floats; None = NULL, updated defaults to applied), next_in = days from today for
        next_action_at (None = no date)."""
        key = fixture_key(f"k_{name}")
        if not self.value("SELECT count(*) FROM app.jobs WHERE job_key = %s", [key]):
            self.insert_jobs([_job(f"k_{name}", **(job or {}))])
        if updated is None:
            updated = applied
        self.sql("""INSERT INTO app.user_job_state (user_id, job_key, is_applied, applied_at, application_status,
                                                    status_updated_at, next_action_at, is_hidden, hidden_at, replied_at,
                                                    interviewed_at)
                    VALUES (%s, %s, %s, now() - %s::float8 * interval '1 day', %s, now() - %s::float8 * interval '1 day',
                            current_date + %s::int, %s, CASE WHEN %s THEN now() END, now() - %s::float8 * interval '1 day',
                            now() - %s::float8 * interval '1 day')""",
                 [uid, key, status in APPLIED_STATUSES, applied, status, updated, next_in, hidden, hidden, replied,
                  interviewed])
        return key

    def state(self, key, uid=U_MAIN):
        return self.rows("""SELECT application_status, is_applied, replied_at, interviewed_at
                            FROM app.user_job_state WHERE user_id = %s AND job_key = %s""", [uid, key])[0]

    def row(self, key, uid=U_MAIN):
        return self.read("jobRow", {"jobKey": key}, uid=uid)[0]

    def jobs(self, params=None, uid=U_MAIN):
        return self.read("jobs", {"limit": 100, **(params or {})}, uid=uid)

    def keys(self, params=None, uid=U_MAIN):
        return [r["job_key"] for r in self.jobs(params, uid)]

    def total(self, params=None, uid=U_MAIN):
        rows = self.read("jobs", {"limit": 1, **(params or {})}, uid=uid)
        return rows[0]["total_count"] if rows else 0

    def summary(self, params=None, uid=U_MAIN):
        return self.read("summary", params or {}, uid=uid)[0]

    def checkin(self, uid=U_MAIN):
        rows = self.read("checkin", {}, uid=uid)
        self.assertEqual(len(rows), 1)
        return rows[0]

    def new_job(self, name):
        key = fixture_key(f"k_{name}")
        self.insert_jobs([_job(f"k_{name}")])
        return key


class NoResponseTest(TrackTestCase):
    current = test_pipeline.PipelineTest.current
    json_rows = test_pipeline.PipelineTest.json_rows
    stage = test_pipeline.PipelineTest.stage
    finish = test_pipeline.PipelineTest.finish

    def test_accepted_applied_and_counted(self):
        key = KEY["level"]
        self.assertEqual(self.write("setStatus", {"jobKey": key, "status": "no_response"}),
                         [{"num_affected_rows": 1, "status": "no_response"}])
        status, applied, replied, interviewed = self.state(key)
        self.assertEqual((status, applied, replied, interviewed), ("no_response", True, None, None))
        row = self.row(key)
        self.assertTrue(row["is_applied"])
        self.assertIsNotNone(row["applied_at"])
        self.assertEqual(row["application_status"], "no_response")
        self.assertIn(key, self.keys({"tab": "applied"}))
        self.assertIn(key, self.keys({"tab": "applied", "stage": "no_response"}))
        self.assertNotIn(key, self.keys({"tab": "inbox"}))
        summary = self.summary()
        self.assertEqual(summary["stages"]["no_response"], 1)
        self.assertEqual(set(summary["stages"]), set(APPLIED_STATUSES))  # a JSON object: no key order
        self.assertEqual(summary["applied"], 3)  # base.py's two applications and this one
        # setApplied true keeps it (an applied stage), false undoes it
        self.write("setApplied", {"jobKey": key, "applied": True})
        self.assertEqual(self.state(key)[0], "no_response")
        self.write("setApplied", {"jobKey": key, "applied": False})
        self.assertEqual(self.state(key)[:2], ("not_applied", False))

    def test_never_muted(self):
        self.write("setStatus", {"jobKey": KEY["level"], "status": "no_response"})
        self.sql("UPDATE app.user_profile SET muted_companies = %s WHERE profile_id = %s",
                 [[self.row(KEY["level"])["company_name"]], U_MAIN])
        self.assertIsNone(self.row(KEY["level"])["muted_by"])
        self.assertIsNotNone(self.row(KEY["rank1"])["muted_by"])  # untracked jobs of that company are muted
        self.assertIn(KEY["level"], self.keys({"tab": "applied"}))

    def test_check_constraint(self):
        self.insert_state(U_OTHER, KEY["level"], {"is_applied": True, "application_status": "no_response"})
        with self.assertRaises(Exception):
            with self.conn.transaction():
                self.insert_state(U_OTHER, KEY["title"], {"application_status": "ghosted"})
        with self.assertSqlError("Invalid status"):
            self.write("setStatus", {"jobKey": KEY["level"], "status": "ghosted"})

    def test_kept_past_a_publish(self):
        self.write("setStatus", {"jobKey": KEY["level"], "status": "no_response"})
        snap = self.current()
        del snap["keys"][KEY["level"]]
        del snap["keys"][KEY["title"]]  # untracked: deleted
        self.finish("fixture-run-track", self.stage("fixture-run-track", snap))
        self.assertEqual(self.rows("SELECT job_key, is_active FROM app.jobs WHERE job_key = ANY(%s)",
                                   [[KEY["level"], KEY["title"]]]), [(KEY["level"], False)])
        self.assertIn(KEY["level"], self.keys({"tab": "applied"}))
        self.assertEqual(self.state(KEY["level"])[0], "no_response")

    def test_exported_like_any_status(self):
        self.write("setStatus", {"jobKey": KEY["level"], "status": "no_response"})
        self.write("setStatus", {"jobKey": KEY["title"], "status": "interviewing"})
        self.write("markCheckin", {})
        data = self.service("pipeline_export_user_data")
        mine = {r["job_key"]: r for r in data["job_state"] if r["user_id"] == U_MAIN}
        self.assertEqual(mine[KEY["level"]]["application_status"], "no_response")
        # replied_at / interviewed_at / last_checkin_at stay in Supabase
        self.assertEqual(set(mine[KEY["title"]]), {"user_id", "job_key", "is_applied", "applied_at", "is_hidden",
                                                    "hidden_at", "application_status", "status_updated_at"})
        profile = next(p for p in data["profiles"] if p["profile_id"] == U_MAIN)
        self.assertNotIn("last_checkin_at", profile)
        self.assertNotIn("last_checkin_at", self.read("profile")[0])


class RepliedInterviewedTest(TrackTestCase):
    """The table of contract 2.7: what setStatus / setApplied do to replied_at and interviewed_at"""

    def stamps(self, key):
        _, _, replied, interviewed = self.state(key)
        return replied, interviewed

    def test_insert_straight_into_each_status(self):
        expected = {"interviewing": (True, True), "offer": (True, True), "rejected": (True, False),
                    "withdrawn": (False, False), "applied": (False, False), "saved": (False, False),
                    "no_response": (False, False), "not_applied": (False, False)}
        for status, (has_replied, has_interviewed) in expected.items():
            with self.subTest(status=status):
                key = self.new_job(f"ins_{status}")
                self.write("setStatus", {"jobKey": key, "status": status})
                replied, interviewed = self.stamps(key)
                self.assertEqual(replied, self.now if has_replied else None)
                self.assertEqual(interviewed, self.now if has_interviewed else None)

    def test_moves_keep_the_first_answer(self):
        key = self.put("moves", "applied", applied=10)
        self.write("setStatus", {"jobKey": key, "status": "interviewing"})
        self.assertEqual(self.stamps(key), (self.now, self.now))
        first = self.now - dt.timedelta(days=3)
        self.sql("UPDATE app.user_job_state SET replied_at = %s, interviewed_at = %s WHERE user_id = %s AND job_key = %s",
                 [first, first, U_MAIN, key])
        for status in ("offer", "rejected", "withdrawn", "interviewing"):
            with self.subTest(status=status):
                self.write("setStatus", {"jobKey": key, "status": status})
                self.assertEqual(self.stamps(key), (first, first))  # an interview that ended in Rejected still counts
        # back to applied (an undo, or a wrong answer corrected): both cleared
        self.write("setStatus", {"jobKey": key, "status": "applied", "statusUpdatedAt": (self.now - dt.timedelta(days=10)).isoformat()})
        self.assertEqual(self.stamps(key), (None, None))

    def test_rejected_then_interviewing_and_no_response(self):
        key = self.put("rej", "applied", applied=10)
        self.write("setStatus", {"jobKey": key, "status": "rejected"})
        self.assertEqual(self.stamps(key), (self.now, None))
        self.write("setStatus", {"jobKey": key, "status": "withdrawn"})
        self.assertEqual(self.stamps(key), (self.now, None))
        self.write("setStatus", {"jobKey": key, "status": "interviewing"})
        self.assertEqual(self.stamps(key), (self.now, self.now))
        self.write("setStatus", {"jobKey": key, "status": "no_response"})
        self.assertEqual(self.stamps(key), (None, None))
        self.write("setStatus", {"jobKey": key, "status": "saved"})
        self.assertEqual(self.stamps(key), (None, None))

    def test_undo_restores_the_time(self):
        # An undo that puts an answer back sends the old status time: the stamps take it
        key = self.put("undo", "applied", applied=10)
        then = (self.now - dt.timedelta(days=2)).replace(microsecond=0)
        self.write("setStatus", {"jobKey": key, "status": "interviewing", "statusUpdatedAt": then.isoformat()})
        self.assertEqual(self.stamps(key), (then, then))
        later = self.put("undo_rej", "applied", applied=10)
        self.write("setStatus", {"jobKey": later, "status": "rejected", "statusUpdatedAt": then.isoformat()})
        self.assertEqual(self.stamps(later), (then, None))
        # a restore time on a row that already has stamps does not move them
        self.write("setStatus", {"jobKey": key, "status": "offer", "statusUpdatedAt": self.now.isoformat()})
        self.assertEqual(self.stamps(key), (then, then))

    def test_undo_of_a_mistap_leaves_no_answer_behind(self):
        # The page's undo sends the previous status and its time; a stamp set by the change being undone goes with it
        days = lambda n: self.now - dt.timedelta(days=n)  # noqa: E731
        undo = lambda key, status, n: self.write(  # noqa: E731
            "setStatus", {"jobKey": key, "status": status, "statusUpdatedAt": days(n).isoformat()})
        wd = self.put("mt_wd", "withdrawn", applied=10, updated=3)
        self.write("setStatus", {"jobKey": wd, "status": "interviewing"})
        undo(wd, "withdrawn", 3)
        self.assertEqual(self.stamps(wd), (None, None))
        rej = self.put("mt_rej", "rejected", applied=10, updated=3, replied=3)
        self.write("setStatus", {"jobKey": rej, "status": "interviewing"})
        undo(rej, "rejected", 3)
        self.assertEqual(self.stamps(rej), (days(3), None))  # the real answer stays, the mis-tapped interview goes
        rej_offer = self.put("mt_rej_offer", "rejected", applied=10, updated=3)  # an old row without stamps
        self.write("setStatus", {"jobKey": rej_offer, "status": "offer"})
        undo(rej_offer, "rejected", 3)
        self.assertEqual(self.stamps(rej_offer), (days(3), None))
        # a real earlier answer survives an undo
        inter = self.put("mt_int", "interviewing", applied=10, updated=5, replied=5, interviewed=5)
        self.write("setStatus", {"jobKey": inter, "status": "rejected"})
        undo(inter, "interviewing", 5)
        self.assertEqual(self.stamps(inter), (days(5), days(5)))
        self.write("setStatus", {"jobKey": inter, "status": "withdrawn"})
        undo(inter, "interviewing", 5)
        self.assertEqual(self.stamps(inter), (days(5), days(5)))
        # a bulk undo also writes rows whose status did not change: their stamps stay even when equal to the status time
        same = self.put("mt_same", "rejected", applied=10, updated=2, replied=2)
        undo(same, "rejected", 2)
        self.assertEqual(self.stamps(same), (days(2), None))

    def test_set_applied(self):
        key = self.put("sa", "interviewing", applied=10, replied=5, interviewed=5)
        stamps = self.stamps(key)
        self.write("setApplied", {"jobKey": key, "applied": True})  # keeps the stage and its stamps
        self.assertEqual(self.state(key)[0], "interviewing")
        self.assertEqual(self.stamps(key), stamps)
        self.write("setApplied", {"jobKey": key, "applied": False})
        self.assertEqual(self.stamps(key), (None, None))
        saved = self.put("sa_saved", "saved", replied=5)  # an impossible leftover is cleared too
        self.write("setApplied", {"jobKey": saved, "applied": True})
        self.assertEqual(self.state(saved)[0], "applied")
        self.assertEqual(self.stamps(saved), (None, None))
        fresh = self.new_job("sa_new")
        self.write("setApplied", {"jobKey": fresh, "applied": True})
        self.assertEqual(self.stamps(fresh), (None, None))

    def test_bulk(self):
        keys = [self.put(f"bulk{i}", "applied", applied=9) for i in range(3)]
        self.write("setStatus", {"jobKeys": keys, "status": "rejected"})
        self.assertEqual({self.stamps(k) for k in keys}, {(self.now, None)})

    def test_rows_carry_them(self):
        key = self.put("rows", "rejected", applied=10, replied=4, interviewed=6)
        row = self.row(key)
        self.assertEqual(dt.datetime.fromisoformat(row["replied_at"]), self.now - dt.timedelta(days=4))
        self.assertEqual(dt.datetime.fromisoformat(row["interviewed_at"]), self.now - dt.timedelta(days=6))
        listed = next(r for r in self.jobs({"tab": "applied"}) if r["job_key"] == key)
        self.assertEqual((listed["replied_at"], listed["interviewed_at"], listed["action_rank"]),
                         (row["replied_at"], row["interviewed_at"], 0))

    def test_backfill(self):
        statements = re.findall(r"^UPDATE app\.user_job_state SET (?:replied_at|interviewed_at) = .*?;$", SCHEMA, re.M | re.S)
        self.assertEqual(len(statements), 2)
        k = {name: self.put(f"bf_{name}", status, applied=20, updated=updated)
             for name, status, updated in [("int", "interviewing", 5), ("offer", "offer", 3), ("rej", "rejected", 2),
                                           ("wd", "withdrawn", 1), ("app", "applied", 20), ("nr", "no_response", 1)]}
        k["noupdate"] = self.put("bf_noupdate", "offer", applied=20)
        self.sql("UPDATE app.user_job_state SET status_updated_at = NULL WHERE job_key = %s", [k["noupdate"]])
        k["kept"] = self.put("bf_kept", "rejected", applied=20, updated=2, replied=9)
        for statement in statements:
            self.sql(statement)
        days = lambda n: self.now - dt.timedelta(days=n)  # noqa: E731
        expected = {"int": (days(5), days(5)), "offer": (days(3), days(3)), "rej": (days(2), None), "wd": (None, None),
                    "app": (None, None), "nr": (None, None), "noupdate": (days(20), days(20)), "kept": (days(9), None)}
        self.assertEqual({name: self.stamps(key) for name, key in k.items()}, expected)
        for statement in statements:  # idempotent
            self.assertEqual(self.sql(statement).rowcount, 0)


class ActionRankTest(TrackTestCase):
    CASES = [
        # name, status, applied, updated, next_in, rank
        ("due_fresh", "applied", 1, 1, 0, 1),               # follow-up date today
        ("due_beats_stale", "interviewing", 30, 10, -1, 1), # date due beats staleness
        ("future_date", "applied", 30, 30, 1, 0),           # a date still ahead: nothing to do yet
        ("future_int", "interviewing", 30, 30, 3, 0),
        ("int_stale", "interviewing", 20, 8, None, 2),
        ("int_7d", "interviewing", 20, 7, None, 0),         # exactly 7 days: not yet (strictly older)
        ("int_6d", "interviewing", 20, 6, None, 0),
        ("app_15d", "applied", 15, 15, None, 3),
        ("app_13d", "applied", 13, 13, None, 0),
        ("offer_due", "offer", 30, 30, -2, 1),               # offer / no reply: only by date
        ("offer_stale", "offer", 60, 60, None, 0),
        ("nr_due", "no_response", 30, 30, 0, 1),
        ("nr_stale", "no_response", 60, 60, None, 0),
        ("rej_due", "rejected", 30, 30, -1, 0),              # finished: 0
        ("wd_due", "withdrawn", 30, 30, -1, 0),
        ("saved_due", "saved", None, 10, -1, 0),             # not applied: 0
    ]

    def setUp(self):
        super().setUp()
        self.k = {name: self.put(name, status, applied=applied, updated=updated, next_in=next_in)
                  for name, status, applied, updated, next_in, _ in self.CASES}

    def test_each_branch(self):
        for name, _, _, _, _, rank in self.CASES:
            with self.subTest(name=name):
                self.assertEqual(self.row(self.k[name])["action_rank"], rank)
        self.assertEqual(self.row(KEY["rank1"])["action_rank"], 0)  # untracked
        # applied with no status time: applied_at counts
        legacy = self.put("legacy", "applied", applied=20)
        self.sql("UPDATE app.user_job_state SET status_updated_at = NULL WHERE job_key = %s", [legacy])
        self.assertEqual(self.row(legacy)["action_rank"], 3)

    def test_follow_up_equivalence(self):
        rows = [r for r in self.jobs({"tab": "all", "scope": "all", "q": "zz fixture"})]
        self.assertGreater(len(rows), len(self.CASES))
        for r in rows:
            with self.subTest(job=r["title"]):
                self.assertEqual(r["follow_up"], r["application_status"] == "applied" and r["action_rank"] in (1, 3))

    def test_lists_and_counts(self):
        needs = {self.k[n] for n, *_, rank in self.CASES if rank > 0 and n != "saved_due"}
        self.assertEqual(set(self.keys({"tab": "applied", "needsAction": True})), needs)
        self.assertEqual(self.total({"tab": "applied", "needsAction": True}), len(needs))
        self.assertEqual(self.summary()["needs_action"], len(needs))
        for params in ({"q": "due"}, {"scope": "all"}, {"postedWithin": 24}):
            with self.subTest(params=params):
                self.assertEqual(self.summary(params)["needs_action"],
                                 self.total({**params, "tab": "applied", "needsAction": True}))
        # anything but JSON true is ignored
        everything = self.total({"tab": "applied"})
        for value in ("true", 1, False, None):
            self.assertEqual(self.total({"tab": "applied", "needsAction": value}), everything)
        # combines with the other filters as AND
        self.assertEqual(set(self.keys({"tab": "applied", "needsAction": True, "stage": "interviewing"})),
                         {self.k["due_beats_stale"], self.k["int_stale"]})
        self.assertEqual(self.keys({"tab": "inbox", "needsAction": True}), [])

    def test_stage_groups(self):
        applied = set(self.keys({"tab": "applied"}))
        open_ = set(self.keys({"tab": "applied", "stageGroup": "open"}))
        finished = set(self.keys({"tab": "applied", "stageGroup": "finished"}))
        self.assertEqual(open_ | finished, applied)
        self.assertEqual(open_ & finished, set())
        self.assertEqual(finished, {self.k[n] for n in ("nr_due", "nr_stale", "rej_due", "wd_due")})
        self.assertEqual(self.total({"tab": "applied", "stageGroup": "finished"}), 4)
        summary = self.summary()
        self.assertEqual(len(finished), sum(summary["stages"][s] for s in ("no_response", "rejected", "withdrawn")))
        self.assertEqual(len(open_), sum(summary["stages"][s] for s in ("applied", "interviewing", "offer")))
        for bad in ("closed", "", 5, None):
            self.assertEqual(set(self.keys({"tab": "applied", "stageGroup": bad})), applied)
        self.assertEqual(set(self.keys({"tab": "applied", "stageGroup": "finished", "needsAction": True})),
                         {self.k["nr_due"]})
        # summary mode ignores both
        self.assertEqual(self.summary({"stageGroup": "finished", "needsAction": True}), summary)


class SortActionTest(TrackTestCase):
    def test_needs_action_first(self):
        k = {
            "a1": self.put("s_a1", "applied", applied=10, next_in=-3),
            "a2": self.put("s_a2", "interviewing", applied=10, updated=2, next_in=-1),
            "a3": self.put("s_a3", "offer", applied=5, updated=2, next_in=-1),       # same due date as a2, applied later
            "b1": self.put("s_b1", "interviewing", applied=30, updated=20),
            "b2": self.put("s_b2", "interviewing", applied=30, updated=9),
            "c1": self.put("s_c1", "applied", applied=30),
            "c2": self.put("s_c2", "applied", applied=15),
            "c3": self.put("s_c3", "applied", applied=16, updated=15),               # same last update as c2
            "d1": self.put("s_d1", "rejected", applied=40, next_in=-5),               # finished: rank 0
            "d3": self.put("s_d3", "applied", applied=20, next_in=4),                 # a date ahead: rank 0
        }
        self.put("s_saved", "saved", updated=1, next_in=-1)  # not on the Applied tab
        expected = [k["a1"], k["a3"], k["a2"], k["b1"], k["b2"], k["c1"], k["c2"], k["c3"],
                    KEY["rank2"], KEY["inactive_applied"], k["d3"], k["d1"]]  # rank 0: newest application first
        params = {"tab": "applied", "sort": "action"}
        rows = self.jobs(params)
        self.assertEqual([r["job_key"] for r in rows], expected)
        self.assertEqual([r["action_rank"] for r in rows], [1, 1, 1, 2, 2, 3, 3, 3, 0, 0, 0, 0])
        self.assertEqual(rows[0]["total_count"], len(expected))
        # pages fit together
        paged = [r["job_key"] for r in self.read("jobs", {**params, "limit": 5})]
        paged += [r["job_key"] for r in self.read("jobs", {**params, "limit": 5, "offset": 5})]
        paged += [r["job_key"] for r in self.read("jobs", {**params, "limit": 5, "offset": 10})]
        self.assertEqual(paged, expected)
        # with a chip
        self.assertEqual(self.keys({**params, "needsAction": True}), expected[:8])
        self.assertEqual(self.keys({**params, "stageGroup": "finished"}), [k["d1"]])
        # the applied sort is unchanged
        self.assertEqual(self.keys({"tab": "applied", "sort": "applied"})[:3], [KEY["rank2"], KEY["inactive_applied"], k["a3"]])

    def test_other_tabs_and_unknown_sorts(self):
        # on the Inbox every row has rank 0 and no applied_at: job_key order, no error
        inbox = self.keys({"tab": "inbox", "sort": "action", "scope": "all", "q": "zz fixture"})
        self.assertEqual(inbox, sorted(inbox))
        self.assertEqual(self.keys({"sort": "nonsense"}), self.keys({"sort": "fit"}))


class FunnelTest(TrackTestCase):
    def setUp(self):
        super().setUp()
        old = {"posted_date": self.today - dt.timedelta(days=20)}
        # base.py: rank2 (applied, LinkedIn, R_AE) and inactive_applied (applied, LinkedIn, R_OUT)
        self.k = {
            "int": self.put("f_int", "interviewing", applied=10, replied=6, interviewed=6,
                            job={"source": "greenhouse", "role_title": R_DE, **old}),
            "rej_int": self.put("f_rej_int", "rejected", applied=10, replied=8, interviewed=8,
                                job={"source": "greenhouse", "role_title": R_DE, **old}),
            "rej": self.put("f_rej", "rejected", applied=10, replied=9, job={"source": "workday", "role_title": R_DE}),
            "offer": self.put("f_offer", "offer", applied=30, replied=20, interviewed=15, job={"source": "lever"}),
            "nr": self.put("f_nr", "no_response", applied=30, job={"source": "lever", "role_title": R_DE}),
            "wd": self.put("f_wd", "withdrawn", applied=30, job={"source": "workday", "role_title": R_ML}),
            # an answer recorded before the columns existed (not backfilled): counted, not in the median
            "legacy": self.put("f_legacy", "interviewing", applied=12, job={"source": "ashby", "role_title": R_PE}),
            "sr": self.put("f_sr", "applied", applied=3, job={"source": "smartrecruiters", "role_title": R_BI}),
        }
        self.put("f_saved", "saved", updated=1)  # not an application
        self.put("f_other", "interviewing", applied=10, replied=5, uid=U_OTHER)  # someone else's

    def test_numbers(self):
        f = self.summary()["funnel"]
        self.assertEqual({key: f[key] for key in ("applied", "replied", "interviewed", "offers", "no_reply", "outcomes")},
                         {"applied": 10, "replied": 5, "interviewed": 4, "offers": 1, "no_reply": 1, "outcomes": 7})
        self.assertEqual(f["median_reply_days"], 3.0)  # replies after 4, 2, 1 and 10 days
        self.assertEqual(f["by_source"], [  # top 5 by applications, then name; smartrecruiters (1) left out
            {"source": "greenhouse", "applied": 2, "replied": 2}, {"source": "lever", "applied": 2, "replied": 1},
            {"source": "linkedin", "applied": 2, "replied": 0}, {"source": "workday", "applied": 2, "replied": 1},
            {"source": "ashby", "applied": 1, "replied": 1}])
        self.assertEqual(f["by_role"], [  # rows without a role (the offer) left out; R_OUT is sixth
            {"role": R_DE, "applied": 4, "replied": 3}, {"role": R_AE, "applied": 1, "replied": 0},
            {"role": R_BI, "applied": 1, "replied": 0}, {"role": R_ML, "applied": 1, "replied": 0},
            {"role": R_PE, "applied": 1, "replied": 1}])
        self.assertNotIn(R_OUT, [r["role"] for r in f["by_role"]])
        self.assertEqual(self.summary()["stages"]["applied"] + sum(
            self.summary()["stages"][s] for s in APPLIED_STATUSES if s != "applied"), f["applied"])

    def test_filters_apply_but_not_the_time_window(self):
        f = self.summary({"source": "greenhouse"})["funnel"]
        self.assertEqual((f["applied"], f["replied"], f["interviewed"], f["outcomes"]), (2, 2, 2, 2))
        self.assertEqual(f["median_reply_days"], 3.0)  # 4 and 2 days
        self.assertEqual(f["by_source"], [{"source": "greenhouse", "applied": 2, "replied": 2}])
        self.assertEqual(self.summary({"postedWithin": 24})["funnel"], self.summary()["funnel"])
        self.assertEqual(self.summary({"q": "k_f_int"})["funnel"]["applied"], 1)
        self.assertEqual(self.summary(uid=U_OTHER)["funnel"]["applied"], 1 + 1)  # base.py's rank1 and f_other
        none = self.summary(uid=U_FALLBACK)["funnel"]
        self.assertEqual((none["applied"], none["median_reply_days"], none["by_source"], none["by_role"]), (0, None, [], []))

    def test_median_rounds_half_up_and_skips_bad_times(self):
        # replies after 1.0 and 1.1 days: the median 1.05 rounds up; a reply before the application is left out
        self.sql("""UPDATE app.user_job_state SET replied_at = CASE job_key
                      WHEN %s THEN applied_at + interval '1 day' WHEN %s THEN applied_at + interval '26 hours 24 minutes'
                      WHEN %s THEN applied_at - interval '3 days' ELSE NULL END
                    WHERE user_id = %s AND job_key = ANY (%s)""",
                 [self.k["int"], self.k["rej_int"], self.k["rej"], U_MAIN, [self.k["int"], self.k["rej_int"], self.k["rej"], self.k["offer"]]])
        f = self.summary()["funnel"]
        self.assertEqual(f["median_reply_days"], half_up(1.05, 1))
        self.assertEqual(f["median_reply_days"], 1.1)
        self.assertEqual(f["replied"], 5)  # by status still
        self.sql("UPDATE app.user_job_state SET replied_at = applied_at + interval '7 days' WHERE job_key = %s", [self.k["int"]])
        self.sql("UPDATE app.user_job_state SET replied_at = NULL WHERE job_key = %s", [self.k["rej_int"]])
        self.assertEqual(self.summary()["funnel"]["median_reply_days"], 7.0)

    def test_writes_feed_it(self):
        before = self.summary()["funnel"]
        self.write("setStatus", {"jobKey": self.k["sr"], "status": "interviewing"})
        after = self.summary()["funnel"]
        self.assertEqual((after["replied"] - before["replied"], after["interviewed"] - before["interviewed"],
                          after["outcomes"] - before["outcomes"]), (1, 1, 1))
        self.write("setStatus", {"jobKey": self.k["sr"], "status": "rejected"})
        rejected = self.summary()["funnel"]
        self.assertEqual((rejected["replied"], rejected["interviewed"]), (after["replied"], after["interviewed"]))


class CheckinTest(TrackTestCase):
    def test_who_is_asked(self):
        self.sql("DELETE FROM app.user_job_state WHERE user_id = %s", [U_MAIN])
        k = {
            "exact7": self.put("c_exact7", "applied", applied=7),                      # exactly 7 days: asked
            "almost": self.put("c_almost", "applied", applied=7 - 1 / 1440),          # a minute short: not yet
            "int": self.put("c_int", "interviewing", applied=30, updated=10),         # interviewing: asked
            "int_recent": self.put("c_int_recent", "interviewing", applied=30, updated=3),
            "snoozed": self.put("c_snoozed", "applied", applied=12, next_in=1),       # until its date
            "due_today": self.put("c_due_today", "applied", applied=12, next_in=0),  # its date has come
            "due_past": self.put("c_due_past", "applied", applied=13, next_in=-2),
            "old_update": self.put("c_old_update", "applied", applied=40, updated=2), # recent update: not asked
        }
        for name, status in (("offer", "offer"), ("nr", "no_response"), ("rej", "rejected"), ("wd", "withdrawn"),
                             ("saved", "saved")):
            k[name] = self.put(f"c_{name}", status, applied=None if status == "saved" else 30, updated=30)
        k["hidden"] = self.put("c_hidden", "applied", applied=30, hidden=True)
        self.put("c_other", "applied", applied=30, uid=U_OTHER)
        c = self.checkin()
        asked = [j["job_key"] for j in c["jobs"]]
        self.assertEqual(asked, [k["due_past"], k["due_today"], k["int"], k["exact7"]])  # oldest update first
        self.assertEqual(c["total"], 4)
        self.assertIsNone(c["last_checkin_at"])
        by_key = {j["job_key"]: j for j in c["jobs"]}
        self.assertEqual(by_key[k["exact7"]]["days_since_update"],
                         (self.today - (self.now - dt.timedelta(days=7)).astimezone(dt.timezone.utc).date()).days)
        self.assertEqual(by_key[k["int"]]["application_status"], "interviewing")
        # the list row shape
        row = by_key[k["int"]]
        for key in ("job_key", "title", "company_name", "application_status", "applied_at", "status_updated_at",
                    "next_action_at", "fit_score", "action_rank", "replied_at", "is_active"):
            self.assertIn(key, row)
        self.assertEqual((row["dup_count"], row["dup_keys"], row["dup_locations"]), (0, [], []))
        for internal in ("is_hidden", "hidden_at", "is_tracked", "fresh"):
            self.assertNotIn(internal, row)

    def test_suggest_no_reply_from_21_days(self):
        self.sql("DELETE FROM app.user_job_state WHERE user_id = %s", [U_MAIN])
        k21 = self.put("c_21", "applied", applied=21)
        k20 = self.put("c_20", "applied", applied=21 - 1 / 1440)
        kint = self.put("c_int30", "interviewing", applied=40, updated=30)
        kupd = self.put("c_upd", "applied", applied=30, updated=8)  # suggested by applied_at, not the update
        suggest = {j["job_key"]: j["suggest"] for j in self.checkin()["jobs"]}
        self.assertEqual(suggest, {k21: "no_response", k20: None, kint: None, kupd: "no_response"})
        self.write("setStatus", {"jobKey": k21, "status": "no_response"})
        self.assertNotIn(k21, [j["job_key"] for j in self.checkin()["jobs"]])
        self.assertEqual(self.summary()["stages"]["no_response"], 1)

    def test_answers_drop_out(self):
        self.sql("DELETE FROM app.user_job_state WHERE user_id = %s", [U_MAIN])
        heard = self.put("c_heard", "applied", applied=8)
        snooze = self.put("c_snooze", "applied", applied=8)
        self.assertEqual(self.checkin()["total"], 2)
        self.write("setStatus", {"jobKey": heard, "status": "interviewing"})  # its status time is now
        self.write("setNote", {"jobKey": snooze, "nextActionAt": (self.today + dt.timedelta(days=7)).isoformat()})
        c = self.checkin()
        self.assertEqual((c["total"], c["jobs"]), (0, []))
        self.assertEqual(self.read("jobNote", {"jobKey": snooze})[0]["next_action_at"],
                         (self.today + dt.timedelta(days=7)).isoformat())

    def test_cap_and_total(self):
        self.sql("DELETE FROM app.user_job_state WHERE user_id = %s", [U_MAIN])
        keys = [self.put(f"c_cap{i:02d}", "applied", applied=8 + i) for i in range(23)]
        c = self.checkin()
        self.assertEqual(c["total"], 23)
        self.assertEqual([j["job_key"] for j in c["jobs"]], list(reversed(keys))[:20])

    def test_no_profile_and_others(self):
        self.assertEqual(self.checkin(uid=U_NOPROFILE), {"last_checkin_at": None, "total": 0, "jobs": []})
        # applications without a profile are not asked about either (markCheckin could not record the sheet)
        self.put("c_noprofile", "applied", applied=30, uid=U_NOPROFILE)
        self.assertEqual(self.checkin(uid=U_NOPROFILE), {"last_checkin_at": None, "total": 0, "jobs": []})
        self.assertEqual(self.checkin(uid=U_FALLBACK), {"last_checkin_at": None, "total": 0, "jobs": []})
        # base.py: U_OTHER applied to rank1 3 days ago (status time now): not asked
        self.assertEqual(self.checkin(uid=U_OTHER)["total"], 0)


class MarkCheckinTest(TrackTestCase):
    def test_sets_the_time(self):
        rows = self.write("markCheckin", {"anything": 1})
        self.assertEqual(len(rows), 1)
        self.assertEqual(dt.datetime.fromisoformat(rows[0]["last_checkin_at"]), self.now)
        self.assertEqual(self.value("SELECT last_checkin_at FROM app.user_profile WHERE profile_id = %s", [U_MAIN]), self.now)
        self.assertEqual(dt.datetime.fromisoformat(self.checkin()["last_checkin_at"]), self.now)
        self.assertIsNone(self.activity_row(U_MAIN))  # no activity counters
        self.assertIsNone(self.checkin(uid=U_OTHER)["last_checkin_at"])  # per user
        for params in (None, [1]):
            self.assertEqual(len(self.call("app_write", "markCheckin", params, claims=self.claims(U_MAIN))["rows"]), 1)

    def test_never_inserts_a_profile(self):
        self.assertEqual(self.write("markCheckin", {}, uid=U_NOPROFILE), [])
        self.assertEqual(self.value("SELECT count(*) FROM app.user_profile WHERE profile_id = %s", [U_NOPROFILE]), 0)
        self.assertEqual(self.read("profile", uid=U_NOPROFILE), [])

    def test_unknown_on_the_read_side(self):
        with self.assertSqlError("Unknown action: markCheckin"):
            self.read("markCheckin")
        with self.assertSqlError("Unknown action: checkin"):
            self.write("checkin")
        with self.assertSqlError("This account is not allowed to use the job data", "42501"):
            self.read("checkin", email="fixture.stranger@jobseeker.test")  # base.py's allow-list is not empty

    def activity_row(self, uid):
        return self.value("SELECT count(*) FROM app.user_activity_day WHERE user_id = %s", [uid]) or None


class TriggerTest(TrackTestCase):
    def setUp(self):
        super().setUp()
        self.sql("DELETE FROM app.pipeline_triggers WHERE true")  # rolled back

    def stored(self):
        return self.rows("""SELECT github_run_id, github_run_attempt, workflow, event, decided_at, decision, forced,
                                   uploaded_files, new_files, new_jobs, run_id, result, message
                            FROM app.pipeline_triggers ORDER BY decided_at DESC, id DESC""")

    def test_record_and_upsert(self):
        result = self.service("pipeline_record_trigger", trigger_doc(decided_at=(self.now - dt.timedelta(minutes=5)).isoformat()))
        self.assertEqual(set(result), {"recorded", "id"})
        self.assertTrue(result["recorded"])
        self.assertEqual(self.stored(), [("fixture-t1", ATTEMPT, "ATS Scrapers", "schedule", self.now - dt.timedelta(minutes=5),
                                          "no_new", False, 3, 0, 0, None, "SKIPPED", "no new jobs")])
        # the same run attempt again replaces it (same id); another attempt adds a row
        again = self.service("pipeline_record_trigger", trigger_doc(decision="started_daily", run_id=987654321012,
                                                                    result="SUCCESS", forced=True, new_files=None))
        self.assertEqual(again["id"], result["id"])
        self.assertEqual(self.stored(), [("fixture-t1", ATTEMPT, "ATS Scrapers", "schedule", self.now, "started_daily",
                                          True, 3, None, 0, "987654321012", "SUCCESS", "no new jobs")])
        self.service("pipeline_record_trigger", trigger_doc(github_run_attempt=2, decision="failed"))
        self.assertEqual(len(self.stored()), 2)
        # a local run without GitHub ids: re-recorded, still one row
        for _ in range(2):
            self.service("pipeline_record_trigger", trigger_doc(github_run_id=None, github_run_attempt=None))
        self.assertEqual(len(self.stored()), 3)
        # numbers as ids, trimmed and cut texts, defaults
        self.service("pipeline_record_trigger", {"format": "jobseeker.trigger_report.v1", "decision": "started",
                                                 "github_run_id": 4242, "github_run_attempt": "3",
                                                 "workflow": "  " + "w" * 300, "message": "m" * 1500, "event": " push "})
        row = self.rows("""SELECT github_run_id, github_run_attempt, char_length(workflow), event, decided_at, forced,
                                  uploaded_files, char_length(message) FROM app.pipeline_triggers WHERE github_run_id = '4242'""")
        self.assertEqual(row, [("4242", 3, 200, "push", self.now, False, None, 1000)])

    def test_validation(self):
        cases = [
            ({"format": "jobseeker.trigger_report.v2"}, "Unknown format"),
            ({"format": None}, "Unknown format"),
            ({"decision": "skipped"}, "Invalid decision"),
            ({"decision": None}, "Invalid decision"),
            ({"decision": 3}, "Invalid decision"),
            ({"uploaded_files": -1}, "Invalid count"),
            ({"new_files": 1.5}, "Invalid count"),
            ({"new_jobs": "3"}, "Invalid count"),
            ({"new_jobs": 1000001}, "Invalid count"),
            ({"uploaded_files": True}, "Invalid count"),
            ({"decided_at": "yesterday"}, "Invalid decided_at"),
            ({"decided_at": 5}, "Invalid decided_at"),
            ({"forced": "yes"}, "Invalid forced"),
        ]
        for changes, message in cases:
            with self.subTest(changes=changes):
                with self.assertSqlError(message):
                    self.service("pipeline_record_trigger", trigger_doc(**changes))
        with self.assertSqlError("Unknown format"):
            self.service("pipeline_record_trigger", [1])
        self.assertEqual(self.stored(), [])
        # the edges that pass: 0 and 1000000, a missing count, a future time (now)
        self.service("pipeline_record_trigger", trigger_doc(uploaded_files=0, new_files=1000000, new_jobs=None,
                                                            decided_at=(self.now + dt.timedelta(days=1)).isoformat()))
        self.assertEqual(self.stored()[0][4:10], (self.now, "no_new", False, 0, 1000000, None))
        for decision in ("started", "started_daily", "waiting", "recent", "paused", "no_new", "failed"):
            self.service("pipeline_record_trigger", trigger_doc(github_run_id=f"fixture-d-{decision}", decision=decision))

    def test_service_only(self):
        with self.assertSqlError("permission denied for function pipeline_record_trigger", "42501"):
            self.call("pipeline_record_trigger", trigger_doc(), claims=self.claims(U_MAIN))
        with self.assertSqlError("Service role only", "42501"):
            self.call("pipeline_record_trigger", trigger_doc(), claims=self.claims(U_MAIN), role="service_role")
        privileges = {role: self.value("SELECT has_function_privilege(%s, 'public.pipeline_record_trigger(jsonb)', 'EXECUTE')",
                                       [role]) for role in ("anon", "authenticated", "service_role")}
        self.assertEqual(privileges, {"anon": False, "authenticated": False, "service_role": True})
        self.assertFalse(self.value("SELECT has_table_privilege('authenticated', 'app.pipeline_triggers', 'SELECT')"))
        self.assertTrue(self.value("SELECT relrowsecurity FROM pg_class WHERE oid = 'app.pipeline_triggers'::regclass"))

    def test_keeps_the_newest_50(self):
        for i in range(55):
            self.service("pipeline_record_trigger", trigger_doc(github_run_id=f"fixture-p{i:02d}",
                                                                decided_at=(self.now - dt.timedelta(hours=60 - i)).isoformat()))
        ids = [r[0] for r in self.stored()]
        self.assertEqual(len(ids), 50)
        self.assertEqual(ids[0], "fixture-p54")
        self.assertEqual(ids[-1], "fixture-p05")

    def test_system_status_and_checked_at(self):
        self.assertEqual(self.read("systemStatus", uid=U_ADMIN, admin=True)[0]["triggers"], [])
        self.assertIsNone(self.read("status")[0]["checked_at"])
        decisions = ["started", "no_new", "recent", "no_new", "started_daily", "waiting", "paused", "failed", "no_new",
                     "started", "no_new", "started"]
        for i, decision in enumerate(decisions):
            self.service("pipeline_record_trigger", trigger_doc(github_run_id=f"fixture-s{i:02d}", decision=decision,
                                                                decided_at=(self.now - dt.timedelta(hours=24 - i)).isoformat()))
        triggers = self.read("systemStatus", uid=U_ADMIN, admin=True)[0]["triggers"]
        self.assertEqual(len(triggers), 10)
        self.assertEqual([t["github_run_id"] for t in triggers], [f"fixture-s{i:02d}" for i in range(11, 1, -1)])
        self.assertEqual(set(triggers[0]), {"decided_at", "decision", "forced", "uploaded_files", "new_files", "new_jobs",
                                            "run_id", "result", "message", "event", "workflow", "github_run_id"})
        self.assertEqual((triggers[0]["decision"], triggers[0]["uploaded_files"], triggers[0]["new_files"]), ("started", 3, 0))
        # status (every signed-in user): the newest decision's time, only when it found no new jobs. The newest here
        # started a run (new jobs): an older "no new jobs" is no longer true until that run publishes.
        self.assertIsNone(self.read("status", uid=U_OTHER)[0]["checked_at"])
        record = lambda run, decision, hours: self.service("pipeline_record_trigger", trigger_doc(  # noqa: E731
            github_run_id=run, decision=decision, decided_at=(self.now - dt.timedelta(hours=hours)).isoformat()))
        record("fixture-s12", "no_new", 1)
        checked = self.read("status", uid=U_OTHER)[0]["checked_at"]
        self.assertEqual(dt.datetime.fromisoformat(checked), self.now - dt.timedelta(hours=1))
        for decision in ("failed", "paused", "started_daily"):  # nothing published yet: no claim of "no new jobs"
            with self.subTest(decision=decision):
                record("fixture-s13", decision, 0.5)
                self.assertIsNone(self.read("status", uid=U_OTHER)[0]["checked_at"])
        with self.assertSqlError("Admins only", "42501"):
            self.read("systemStatus")


class ActivationTest(TrackTestCase):
    def activation(self):
        return self.read("metrics", uid=U_ADMIN, admin=True)[0]["activation"]

    def test_activation(self):
        base = self.activation()
        self.assertEqual(set(base), {"new_users", "activated", "share"})
        users = {}
        for n, (signed_up, day_offset, saved, applied, visits) in enumerate([
                (3, 0, 1, 0, 1),     # saved on the signup day: activated
                (5, 1, 0, 2, 1),     # applied the next day: activated
                (6, 2, 3, 0, 1),     # two days later: not
                (4, 0, 0, 0, 5),     # visits only: not
                (2, None, 0, 0, 0),  # nothing at all: not
                (70, 0, 5, 5, 1)]):  # outside the 60 days: not a new user
            uid = fixture_uid(60 + n)
            users[uid] = signed_up
            self.sql("""INSERT INTO auth.users (id, email, aud, role, created_at)
                        VALUES (%s, %s, 'authenticated', 'authenticated', now() - %s * interval '1 day')""",
                     [uid, f"fixture.act{n}@jobseeker.test", signed_up])
            if day_offset is not None:
                self.sql("""INSERT INTO app.user_activity_day (user_id, day, visits, saved, applied)
                            VALUES (%s, ((now() - %s * interval '1 day') AT TIME ZONE 'UTC')::date + %s, %s, %s, %s)""",
                         [uid, signed_up, day_offset, visits, saved, applied])
        a = self.activation()
        self.assertEqual((a["new_users"] - base["new_users"], a["activated"] - base["activated"]), (5, 2))
        self.assertEqual(a["share"], half_up(a["activated"] / a["new_users"], 2))
        retention = self.read("metrics", uid=U_ADMIN, admin=True)[0]["retention"]
        self.assertEqual(retention["new_users"], a["new_users"])  # the same accounts

    def test_empty(self):
        self.sql("DELETE FROM app.user_activity_day WHERE true")
        self.sql("UPDATE auth.users SET created_at = now() - interval '90 days' WHERE true")
        self.assertEqual(self.activation(), {"new_users": 0, "activated": 0, "share": None})


class SchemaMigrationTest(TrackTestCase):
    """The definition-aware CHECK swap of app_schema.sql, run in the test transaction"""

    BLOCK = re.search(r"^DO \$\$\nBEGIN\n  IF NOT EXISTS \(SELECT 1 FROM pg_constraint\n\s+WHERE conrelid = "
                      r"'app\.user_job_state'::regclass.*?^\$\$;$", SCHEMA, re.M | re.S).group(0)

    def constraint(self):
        rows = self.rows("""SELECT oid, pg_get_constraintdef(oid), convalidated FROM pg_constraint
                            WHERE conrelid = 'app.user_job_state'::regclass
                              AND conname = 'user_job_state_application_status_check'""")
        return rows[0] if rows else None

    def test_old_constraint_is_replaced_once(self):
        oid, definition, valid = self.constraint()
        self.assertIn("'no_response'", definition)
        self.assertTrue(valid)
        self.sql(self.BLOCK)  # an apply over the current constraint leaves it alone
        self.assertEqual(self.constraint()[0], oid)
        # the deployed (7-value) constraint
        self.sql("ALTER TABLE app.user_job_state DROP CONSTRAINT user_job_state_application_status_check")
        self.sql("""ALTER TABLE app.user_job_state ADD CONSTRAINT user_job_state_application_status_check
                    CHECK (application_status IN ('not_applied', 'saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'))""")
        with self.assertRaises(Exception):
            with self.conn.transaction():
                self.insert_state(U_OTHER, KEY["level"], {"is_applied": True, "application_status": "no_response"})
        old_oid = self.constraint()[0]
        self.sql(self.BLOCK)
        new_oid, definition, valid = self.constraint()
        self.assertNotEqual(new_oid, old_oid)
        self.assertIn("'no_response'", definition)
        self.assertTrue(valid)
        self.sql(self.BLOCK)
        self.assertEqual(self.constraint()[0], new_oid)
        self.insert_state(U_OTHER, KEY["level"], {"is_applied": True, "application_status": "no_response"})
        # no constraint at all: added
        self.sql("ALTER TABLE app.user_job_state DROP CONSTRAINT user_job_state_application_status_check")
        self.sql(self.BLOCK)
        self.assertIn("'no_response'", self.constraint()[1])

    def test_new_objects(self):
        columns = {r[0] for r in self.rows("""SELECT column_name FROM information_schema.columns
                                              WHERE table_schema = 'app' AND table_name = 'user_job_state'""")}
        self.assertLessEqual({"replied_at", "interviewed_at"}, columns)
        self.assertEqual(self.value("""SELECT data_type FROM information_schema.columns WHERE table_schema = 'app'
                                       AND table_name = 'user_profile' AND column_name = 'last_checkin_at'"""),
                         "timestamp with time zone")
        # c_trigger_decisions() is defined in both files with the same body (the CHECK calls it)
        api = (ROOT / "supabase" / "app_api.sql").read_text(encoding="utf-8")
        pattern = r"CREATE OR REPLACE FUNCTION app\.c_trigger_decisions\(\)[^$]*\$\$ SELECT ARRAY\[(.*?)\]::text\[\] \$\$;"
        bodies = [re.search(pattern, text, re.S).group(1).split() for text in (SCHEMA, api)]
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(self.value("SELECT app.c_trigger_decisions()"),
                         ["started", "started_daily", "waiting", "recent", "paused", "no_new", "failed"])
        with self.assertRaises(Exception):
            with self.conn.transaction():
                self.sql("INSERT INTO app.pipeline_triggers (decided_at, decision) VALUES (now(), 'skipped')")


if __name__ == "__main__":  # pragma: no cover
    import unittest
    unittest.main()
