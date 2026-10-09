"""app_read: jobs (filters, sorts, paging), summary, trend, facets, job, hiddenJobs, profile, refs, status.

The feature-wave reads and filters (collapse, mute rules, statuses, cities, ...) are in test_features.py.
"""
import datetime as dt

from base import (CITY, COMPANY, CR_ACTIVE, CR_MAPPED, FIXTURE_KEYS, JOB_BY_NAME, KEY, NOW, OTHER_COMPANY, R_DE, R_OUT,
                  STATE, TODAY, U_FALLBACK, U_MAIN, U_NOPROFILE, DbTestCase)

LIST_COLUMNS = {
    "job_key", "source", "company_name", "title", "location", "posted_date", "job_url", "seniority_level",
    "employment_type", "experience_min_years", "experience_max_years", "experience_level", "skills", "category",
    "role_title", "role_score", "role_alternative", "role_match", "fit_score", "fit_role", "fit_skills",
    "fit_experience", "fit_matched_skills", "first_seen_at", "last_seen_at", "times_seen", "is_applied", "applied_at",
    "total_count",
    # added with the feature wave
    "is_active", "application_status", "status_updated_at", "next_action_at", "has_note", "follow_up",
    "above_experience", "in_for_you", "fit_role_reason", "fit_role_sim", "fit_core_matched", "fit_exp_years",
    "job_skills_known", "city", "cities", "work_mode", "employment_kind", "company_key", "dup_group", "dup_count",
    "dup_keys", "dup_locations", "dup_applied_at", "dup_applied_key", "muted_by", "muted_value",
}
NAME = {key: name for name, key in KEY.items()}


class ReadTest(DbTestCase):
    def expected(self, uid, *, scope="match", predicate=None):
        """Fixture job names the list should show (visibility + scope + an optional extra filter)"""
        ref = self.reference(uid)
        names = []
        for name, job in JOB_BY_NAME.items():
            r = ref[job["job_key"]]
            if r["is_hidden"] or not (job["is_active"] or r["is_applied"]):
                continue
            if scope != "all" and not r["is_match"]:
                continue
            if predicate and not predicate(job, r):
                continue
            names.append(name)
        return names

    def sort_fit(self, uid, names):
        """fit, then freshness (job date, first seen), then role_score, then job_key"""
        ref = self.reference(uid)

        def key(name):
            job = JOB_BY_NAME[name]
            date = job["posted_date"] or job["first_seen_at"].date()
            role_score = job["role_score"] if job["role_score"] is not None else float("-inf")
            return (-ref[job["job_key"]]["fit_score"], -date.toordinal(), -job["first_seen_at"].timestamp(), -role_score,
                    job["job_key"])
        return sorted(names, key=key)

    def names(self, rows):
        return [NAME[row["job_key"]] for row in rows]

    # --- jobs -----------------------------------------------------------------------------------------------------

    def test_jobs_default_is_for_you_sorted_by_fit(self):
        rows = self.read("jobs")
        self.assertEqual(rows, self.fixture_rows(rows), "only fixture jobs can match the fixture roles")
        expected = self.expected(U_MAIN)
        self.assertEqual(set(self.names(rows)), {"rank1", "rank2", "related_match", "level", "inactive_applied", "old",
                                                 "other_company"})
        self.assertEqual(self.names(rows), self.sort_fit(U_MAIN, expected))
        self.assertEqual(set(rows[0]), LIST_COLUMNS)
        self.assertTrue(all(row["total_count"] == len(rows) for row in rows))
        ref = self.reference(U_MAIN)
        for row in rows:
            self.assertEqual(row["fit_score"], ref[row["job_key"]]["fit_score"])

    def test_row_values_are_json_typed(self):
        row = next(r for r in self.read("jobs") if r["job_key"] == KEY["rank1"])
        self.assertEqual(row["posted_date"], TODAY.isoformat())
        self.assertTrue(row["first_seen_at"].endswith("+00:00"), row["first_seen_at"])
        self.assertEqual(row["skills"], ["Zz Fixture Spark", "Zz Fixture SQL"])
        self.assertEqual(row["fit_matched_skills"], ["Zz Fixture Spark", "Zz Fixture SQL", "Zz Fixture Cloud"])
        self.assertIsInstance(row["fit_score"], int)
        self.assertEqual(row["fit_experience"], 1.0)
        self.assertIs(row["role_match"], True)
        self.assertIs(row["is_applied"], False)
        self.assertIsNone(row["applied_at"])

    def test_scope_all_and_tabs(self):
        rows = self.read("jobs", {"scope": "all", "company": COMPANY, "limit": 100})
        self.assertEqual(set(self.names(rows)), set(self.expected(U_MAIN, scope="all", predicate=lambda j, r: j["company_name"] == COMPANY)))
        self.assertNotIn("hidden", self.names(rows))
        self.assertNotIn("inactive", self.names(rows))
        applied = self.read("jobs", {"scope": "all", "company": COMPANY, "tab": "applied"})
        self.assertEqual(set(self.names(applied)), {"rank2", "inactive_applied"})
        pending = self.read("jobs", {"scope": "all", "company": COMPANY, "tab": "pending", "limit": 100})
        self.assertEqual(set(self.names(pending)), set(self.names(rows)) - {"rank2", "inactive_applied"})
        self.assertEqual(len(self.read("jobs", {"scope": "all", "company": COMPANY, "tab": "other", "limit": 100})), len(rows))
        # scope must be exactly the string 'all'
        self.assertEqual(set(self.names(self.read("jobs", {"scope": ["all"]}))), set(self.expected(U_MAIN)))

    def test_text_and_exact_filters(self):
        def keys(params):
            return set(self.names(self.read("jobs", {"scope": "all", "limit": 100, **params})))
        self.assertEqual(keys({"q": "  ZZ FIXTURE SENIOR data "}), {"rank1"})
        self.assertEqual(keys({"q": "zz fixture cloud", "company": COMPANY}), {"related_low"})  # rank1 has it only as a group
        self.assertEqual(keys({"q": "zz fixture python"}), {"title", "alternative", "category"})  # skills are
        self.assertEqual(keys({"role": R_OUT}), {"title", "inactive_applied"})
        self.assertEqual(keys({"category": "Zz Fixture Lake"}), {"category"})
        self.assertEqual(keys({"source": "greenhouse", "company": OTHER_COMPANY}), {"other_company"})
        self.assertEqual(keys({"company": OTHER_COMPANY}), {"other_company"})
        self.assertEqual(keys({"location": "zz FIXTURE town"}), {"other_company"})
        self.assertEqual(keys({"company": COMPANY, "role": 42}), keys({"company": COMPANY}))  # non-strings are ignored

    def test_number_filters(self):
        def keys(params):
            return set(self.names(self.read("jobs", {"scope": "all", "company": COMPANY, "limit": 100, **params})))
        everything = keys({})
        self.assertEqual(keys({"maxYears": 2}),
                         {n for n in everything if (JOB_BY_NAME[n]["experience_min_years"] or 0) <= 2})
        self.assertEqual(keys({"maxYears": "2"}), keys({"maxYears": 2}))
        self.assertEqual(keys({"maxYears": ""}), everything)
        self.assertEqual(keys({"maxYears": "abc"}), everything)
        ref = self.reference(U_MAIN)
        self.assertEqual(keys({"minFit": 70}), {n for n in everything if ref[KEY[n]]["fit_score"] >= 70})
        self.assertEqual(keys({"minFit": 70}), {"rank1", "level"})
        self.assertEqual(keys({"minFit": 0}), {n for n in everything if ref[KEY[n]]["fit_score"] >= 1})  # clamped to 1
        self.assertEqual(keys({"matchedOnly": True}), {n for n in everything if ref[KEY[n]]["fit_matched_skills"]})
        self.assertEqual(keys({"matchedOnly": "true"}), everything)  # strictly JSON true

    def test_posted_within(self):
        def keys(params, scope="all"):
            return set(self.names(self.read("jobs", {"scope": scope, "limit": 100, **params})))
        recent = keys({"postedWithin": 24, "company": COMPANY})
        self.assertNotIn("old", recent)
        self.assertNotIn("inactive_applied", recent)  # applied 20 days ago: outside the window on All / To apply
        self.assertIn("rank1", recent)
        self.assertIn("rank2", recent)  # applied, but posted today
        # the Applied and Saved tabs list their jobs whatever their date
        self.assertIn("inactive_applied", keys({"postedWithin": 24, "company": COMPANY, "tab": "applied"}))
        self.assertNotIn("inactive_applied", keys({"postedWithin": 24, "company": COMPANY, "tab": "pending"}))
        # no posted_date: first_seen_at (2 hours ago)
        self.assertNotIn("other_company", keys({"postedWithin": 1, "company": OTHER_COMPANY}))
        self.assertIn("other_company", keys({"postedWithin": 3, "company": OTHER_COMPANY}))
        self.assertIn("old", keys({"postedWithin": 24 * 11, "company": COMPANY}))
        # applied jobs pass "For you" too
        self.assertIn("inactive_applied", keys({"postedWithin": 1, "tab": "applied"}, scope="match"))
        self.assertIn("inactive_applied", keys({}, scope="match"))

    def test_paging_and_clamping(self):
        full = self.read("jobs", {"scope": "all", "company": COMPANY, "limit": 100})
        page = self.read("jobs", {"scope": "all", "company": COMPANY, "limit": 3, "offset": 2})
        self.assertEqual(page, full[2:5])
        self.assertTrue(all(row["total_count"] == len(full) for row in page))
        self.assertEqual(len(self.read("jobs", {"scope": "all", "company": COMPANY, "limit": 0})), 1)
        self.assertEqual(len(self.read("jobs", {"scope": "all", "company": COMPANY, "limit": "2.9"})), 2)
        self.assertLessEqual(len(self.read("jobs", {"scope": "all", "limit": 100000})), 100)
        self.assertEqual(self.read("jobs", {"scope": "all", "company": COMPANY, "offset": 10 ** 9}), [])
        self.assertEqual(self.read("jobs", {"scope": "all", "company": COMPANY, "offset": -5, "limit": 100}), full)
        default = self.read("jobs", {"scope": "all", "company": COMPANY, "limit": "abc"})
        self.assertEqual(default, full[:48])

    def test_sorts(self):
        base = {"scope": "all", "company": COMPANY, "limit": 100}
        ref = self.reference(U_MAIN)
        names = self.names(self.read("jobs", base))

        def job_date(n):
            job = JOB_BY_NAME[n]
            return (job["posted_date"] or job["first_seen_at"].date()).toordinal()
        self.assertEqual(self.names(self.read("jobs", {**base, "sort": "fit"})), self.sort_fit(U_MAIN, names))
        self.assertEqual(self.names(self.read("jobs", {**base, "sort": "unknown"})), self.sort_fit(U_MAIN, names))
        self.assertEqual(self.names(self.read("jobs", {**base, "sort": "recent"})),
                         sorted(names, key=lambda n: (-job_date(n), -ref[KEY[n]]["fit_score"], KEY[n])))
        self.assertEqual(self.names(self.read("jobs", {**base, "sort": "found"})),
                         sorted(names, key=lambda n: (-JOB_BY_NAME[n]["first_seen_at"].timestamp(), -ref[KEY[n]]["fit_score"], KEY[n])))
        # applied date (newest first), then status change; jobs not applied to last (by key)
        by_applied = self.names(self.read("jobs", {**base, "sort": "applied"}))
        self.assertEqual(by_applied[:2], ["rank2", "inactive_applied"])  # applied 1 and 2 days ago
        self.assertEqual(by_applied[2:], sorted(by_applied[2:], key=lambda n: KEY[n]))

    def test_params_that_are_not_an_object(self):
        self.assertEqual(self.call("app_read", "jobs", [1, 2], claims=self.claims(U_MAIN))["rows"], self.read("jobs"))
        self.assertEqual(self.call("app_read", "jobs", None, claims=self.claims(U_MAIN))["rows"], self.read("jobs"))

    # --- summary / trend / facets ---------------------------------------------------------------------------------

    @staticmethod
    def summary_row(**counts):
        row = {"total": 0, "pending": 0, "new_48h": 0, "strong_fit": 0, "applied": 0, "saved": 0, "follow_up": 0,
               "closed": 0, "muted": 0,
               "stages": {"applied": 0, "interviewing": 0, "offer": 0, "rejected": 0, "withdrawn": 0},
               # added with the trust release (test_trust.py covers them in depth)
               "inbox": 0, "inbox_strong": 0, "new_since": None, "expiring": 0, "expiring_strong": 0, "triaged_today": 0}
        row.update(counts)
        return row

    def test_summary(self):
        ref = self.reference(U_MAIN)
        names = self.expected(U_MAIN)
        expected = self.summary_row(
            total=len(names),
            new_48h=sum(1 for n in names if JOB_BY_NAME[n]["first_seen_at"] >= NOW - dt.timedelta(hours=48)),
            strong_fit=sum(1 for n in names if ref[KEY[n]]["fit_score"] >= 70),
            applied=sum(1 for n in names if ref[KEY[n]]["is_applied"]),
            pending=sum(1 for n in names if not ref[KEY[n]]["is_applied"]),
            closed=1,  # inactive_applied
            stages={"applied": 2, "interviewing": 0, "offer": 0, "rejected": 0, "withdrawn": 0},
            inbox=sum(1 for n in names if not ref[KEY[n]]["is_applied"]),  # nothing saved: untracked = not applied
            inbox_strong=sum(1 for n in names if not ref[KEY[n]]["is_applied"] and ref[KEY[n]]["fit_score"] >= 70),
            expiring=1,  # old: posted 10 days ago, untracked, For you
            expiring_strong=int(ref[KEY["old"]]["fit_score"] >= 70),
        )
        self.assertEqual(self.read("summary"), [expected])
        self.assertEqual(self.read("summary", {"tab": "applied"}), [expected])  # the tab is ignored
        filtered = self.read("summary", {"scope": "all", "company": OTHER_COMPANY})
        self.assertEqual(filtered, [self.summary_row(total=1, new_48h=1, pending=1, inbox=1,
                                                     inbox_strong=int(ref[KEY["other_company"]]["fit_score"] >= 70))])
        self.assertEqual(self.read("summary", uid=U_NOPROFILE), [self.summary_row()])
        # postedWithin: total / pending count only the jobs inside the window; applied counts every applied job
        recent = self.read("summary", {"postedWithin": 24})[0]
        self.assertEqual(recent["total"], len(names) - 2)  # inactive_applied and old fall outside
        self.assertEqual(recent["applied"], 2)

    def test_trend(self):
        ref = self.reference(U_MAIN)
        added = {}
        cutoff = TODAY - dt.timedelta(days=13)
        for name, job in JOB_BY_NAME.items():
            if job["first_seen_at"].date() >= cutoff and ref[job["job_key"]]["is_match"]:
                day = job["first_seen_at"].date().isoformat()
                added[day] = added.get(day, 0) + 1
        applied = {}
        for st in STATE[U_MAIN].values():
            if st.get("applied_at") and st["applied_at"].date() >= cutoff:
                day = st["applied_at"].date().isoformat()
                applied[day] = applied.get(day, 0) + 1
        days = sorted(set(added) | set(applied))
        self.assertEqual(self.read("trend"), [{"day": d, "added": added.get(d, 0), "applied": applied.get(d, 0)} for d in days])
        # scope=all counts every job first seen in the window (hidden and expired ones too)
        total = sum(row["added"] for row in self.read("trend", {"scope": "all"}))
        self.assertEqual(total, self.value("SELECT count(*) FROM app.jobs WHERE first_seen_at >= current_date - 13"))

    def test_facets(self):
        rows = self.read("facets")
        names = self.expected(U_MAIN)
        companies = {r["value"]: r["n"] for r in rows if r["kind"] == "company"}
        self.assertEqual(companies, {COMPANY: sum(1 for n in names if JOB_BY_NAME[n]["company_name"] == COMPANY),
                                     OTHER_COMPANY: 1})
        roles = {r["value"]: r["n"] for r in rows if r["kind"] == "role"}
        self.assertEqual(roles[R_DE], sum(1 for n in names if JOB_BY_NAME[n]["role_title"] == R_DE))
        self.assertNotIn(None, [r["value"] for r in rows])
        order = [(r["kind"], -r["n"], r["value"].encode()) for r in rows]
        self.assertEqual(order, sorted(order))
        self.assertEqual(set(rows[0]), {"kind", "value", "n"})
        # other filters do not apply to the facets
        self.assertEqual(self.read("facets", {"company": OTHER_COMPANY}), rows)
        everything = self.read("facets", {"scope": "all"})
        self.assertGreaterEqual(len(everything), len(rows))

    # --- small reads ----------------------------------------------------------------------------------------------

    def test_job_detail(self):
        rows = self.read("job", {"jobKey": KEY["rank1"]})
        self.assertEqual(rows, [{"job_key": KEY["rank1"], "description": "Fixture job rank1", "job_function": None,
                                 "industries": None, "role_method": "embedding", "role_score": 0.93}])
        self.assertEqual(self.read("job", {"jobKey": "0" * 64}), [])
        with self.assertSqlError("Invalid job key"):
            self.read("job", {"jobKey": KEY["rank1"].upper()})
        with self.assertSqlError("Invalid job key"):
            self.read("job", {})

    def test_hidden_jobs(self):
        self.assertEqual(self.read("hiddenJobs"), [{
            "job_key": KEY["hidden"], "title": "Zz Fixture Hidden DE", "company_name": COMPANY,
            "location": "Zz Fixture City, India", "hidden_at": self.read("hiddenJobs")[0]["hidden_at"], "hide_reason": None}])
        self.assertEqual(self.read("hiddenJobs", uid=U_FALLBACK), [])

    def test_profile(self):
        rows = self.read("profile")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["profile_id"], U_MAIN)
        self.assertEqual(rows[0]["target_roles"], [CR_MAPPED, "Zz Fixture Analytics Engineer"])
        self.assertEqual(rows[0]["preferred_cities"], [CITY])
        self.assertEqual(set(rows[0]), {"profile_id", "target_roles", "skills", "min_years", "max_years",
                                        "preferred_cities", "updated_at", "also_skills", "muted_companies",
                                        "muted_title_words", "muted_levels"})
        self.assertEqual((rows[0]["also_skills"], rows[0]["muted_levels"]), ([], []))
        self.assertEqual(self.read("profile", uid=U_NOPROFILE), [])

    def test_refs(self):
        rows = self.read("refs")
        by = {}
        for r in rows:
            by.setdefault((r["kind"], r["value"]), []).append(r)
        self.assertEqual(by[("role", R_DE)], [{"kind": "role", "value": R_DE, "detail": "Zz Fixture Data", "aliases": None}])
        self.assertEqual(by[("role_out", R_OUT)][0]["detail"], "Zz Fixture Sales")
        self.assertNotIn(("role", R_OUT), by)
        self.assertEqual(by[("skill", "Zz Fixture Spark")][0]["aliases"], ["zz fixture pyspark"])
        self.assertEqual(by[("skill", "Zz Fixture Cloud")], [{"kind": "skill", "value": "Zz Fixture Cloud", "detail": "group", "aliases": None}])
        self.assertEqual(by[("custom_role", CR_MAPPED)][0]["aliases"], [R_DE])
        self.assertEqual(by[("custom_role", CR_ACTIVE)][0], {"kind": "custom_role", "value": CR_ACTIVE, "detail": "active", "aliases": None})
        self.assertEqual(by[("custom_skill", "Zz Fixture Unseen")][0]["detail"], "custom")
        city = by[("city", CITY)][0]
        self.assertEqual(city["detail"], "Zz Fixture State")
        self.assertEqual(sorted(city["aliases"]), ["zz fixture city", "zz fixture town"])
        order = [(r["kind"].encode(), (r["value"] or "").encode()) for r in rows]
        self.assertEqual(order, sorted(order))

    def test_status(self):
        rows = self.read("status")
        self.assertEqual(len(rows), 1)
        self.assertEqual(set(rows[0]), {"run_id", "snapshot_at", "published_at", "jobs"})
        self.sql("""UPDATE app.pipeline_status SET run_id = 'fixture-run', snapshot_at = '2026-01-02T03:04:05Z',
                    published_at = '2026-01-02T03:10:00Z', counts = '{"jobs": 12}' WHERE id = 1""")
        self.assertEqual(self.read("status"), [{"run_id": "fixture-run", "snapshot_at": "2026-01-02T03:04:05+00:00",
                                                "published_at": "2026-01-02T03:10:00+00:00", "jobs": 12}])

    def test_fixture_keys_are_unique(self):
        self.assertEqual(len(set(FIXTURE_KEYS)), len(FIXTURE_KEYS))
