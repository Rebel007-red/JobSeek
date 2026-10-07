"""Service-only RPCs: pipeline_export_user_data, pipeline_publish_state, pipeline_publish, pipeline_publish_finish,
pipeline_record_scrape, pipeline_record_runs.

The publishes here restage everything app.jobs and the small tables already hold (plus the fixture changes), so even
inside the rolled-back transaction real rows are only rewritten with their own values.
"""
import datetime as dt
import hashlib
import json
import re

from base import (CR_MAPPED, CR_PENDING, JOB_BY_NAME, KEY, NOW, U_MAIN, U_OTHER, DbTestCase, _job, fixture_key)

TS_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$")
SMALL_KINDS = ["skill_stats", "role_similarity", "ref_roles", "ref_skills", "ref_cities", "custom_roles", "custom_skills"]


def publish_row(job):
    """A job as the publish files carry it (JSON values) with its hash"""
    row = {}
    for name, value in job.items():
        if name in ("row_hash",):
            continue
        if isinstance(value, dt.datetime):
            value = value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        elif isinstance(value, dt.date):
            value = value.isoformat()
        row[name] = value
    row["h"] = hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return row


def ts(value):
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class PipelineTest(DbTestCase):
    def setUp(self):
        super().setUp()
        self.seq = 0

    # --- helpers --------------------------------------------------------------------------------------------------

    def json_rows(self, query):
        return self.value(f"SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM ({query}) t")

    def current(self):
        """What a publish of the unchanged database would send"""
        return {
            "keys": {k: h for k, h in self.rows("SELECT job_key, row_hash FROM app.jobs")},
            "skill_stats": self.json_rows("SELECT skill, jobs, idf FROM app.skill_stats"),
            "role_similarity": self.json_rows("SELECT role_a, role_b, sim FROM app.role_similarity"),
            "ref_roles": self.json_rows("SELECT role_title, category, in_scope FROM app.ref_roles"),
            "ref_skills": self.json_rows("SELECT skill, skill_group, aliases FROM app.ref_skills"),
            "ref_cities": self.json_rows("SELECT alias, city, state FROM app.ref_cities"),
            "custom_roles": self.json_rows("""SELECT role_title, status, category, description, duplicate_of, first_user,
                                                     checked_by, created_at, checked_at, attempts FROM app.custom_roles"""),
            "custom_skills": self.json_rows("SELECT skill, first_user, created_at FROM app.custom_skills"),
        }

    def stage(self, run_id, snapshot, job_rows=(), batch_rows=2):
        """Sends the jobs, keys and small kinds of a snapshot; returns the manifest"""
        job_rows = list(job_rows)
        for start in range(0, len(job_rows), batch_rows):
            self.service("pipeline_publish", {"run_id": run_id, "kind": "jobs", "seq": start // batch_rows,
                                              "rows": job_rows[start:start + batch_rows]})
        keys = sorted(snapshot["keys"].items())
        for seq, start in enumerate(range(0, max(len(keys), 1), 5000)):
            self.service("pipeline_publish", {"run_id": run_id, "kind": "keys", "seq": seq,
                                              "keys": [list(k) for k in keys[start:start + 5000]]})
        for kind in SMALL_KINDS:
            rows = snapshot[kind]
            for seq, start in enumerate(range(0, max(len(rows), 1), 500)):
                self.service("pipeline_publish", {"run_id": run_id, "kind": kind, "seq": seq, "rows": rows[start:start + 500]})
        counts = {kind: len(snapshot[kind]) for kind in SMALL_KINDS}
        counts["jobs"] = len(keys)
        return {"format": "jobseeker.publish.v1", "run_id": run_id, "catalog": "jobseeker",
                "snapshot_at": snapshot.get("snapshot_at", ts(NOW)), "counts": counts}

    def finish(self, run_id, manifest, force=False):
        return self.service("pipeline_publish_finish", run_id, manifest, force)

    def fixture_snapshot(self):
        """Current data plus: rank1 changed, a new job, halfup / hidden / inactive_applied left the snapshot,
        a skill stat replaced, the pending custom role checked and a new custom role and skill"""
        snap = self.current()
        changed = publish_row({**JOB_BY_NAME["rank1"], "title": "Zz Fixture Senior Data Engineer (updated)"})
        new = publish_row(_job("pub_new", role_title="Zz Fixture Data Engineer", skills=["Zz Fixture New Skill"],
                               skill_groups=["Zz Fixture Cloud", None]))
        for row in (changed, new):
            snap["keys"][row["job_key"]] = row["h"]
        for name in ("halfup", "hidden", "inactive_applied"):
            del snap["keys"][KEY[name]]
        snap["skill_stats"] = [r for r in snap["skill_stats"] if r["skill"] != "zz fixture python"] + [
            {"skill": "zz fixture new skill", "jobs": 1, "idf": 1.75}]
        for role in snap["custom_roles"]:
            if role["role_title"] == CR_PENDING:
                role.update({"status": "active", "category": "Zz Fixture Data", "checked_by": "llm",
                             "checked_at": ts(NOW), "attempts": 2})
        snap["custom_roles"] = [r for r in snap["custom_roles"] if r["role_title"] != CR_MAPPED] + [
            {"role_title": "Zz Fixture Brand New", "status": "pending", "category": None, "description": None,
             "duplicate_of": None, "first_user": U_MAIN, "checked_by": None, "created_at": ts(NOW), "checked_at": None,
             "attempts": 0}]
        snap["custom_skills"] = snap["custom_skills"] + [{"skill": "Zz Fixture New Skill", "first_user": U_MAIN, "created_at": ts(NOW)}]
        return snap, [changed, new]

    # --- export / state -------------------------------------------------------------------------------------------

    def test_export_user_data(self):
        doc = self.service("pipeline_export_user_data")
        self.assertEqual(doc["format"], "jobseeker.user_data.v1")
        self.assertRegex(doc["exported_at"], TS_RE)
        for kind in ("profiles", "job_state", "custom_roles", "custom_skills"):
            self.assertEqual(doc["counts"][kind], len(doc[kind]), kind)
        main = next(p for p in doc["profiles"] if p["profile_id"] == U_MAIN)
        self.assertEqual(set(main), {"profile_id", "email", "target_roles", "skills", "min_years", "max_years",
                                     "preferred_cities", "updated_at"})
        self.assertRegex(main["updated_at"], TS_RE)
        mine = {(s["user_id"], s["job_key"]) for s in doc["job_state"] if s["user_id"] in (U_MAIN, U_OTHER)}
        # tracked rows only: hidden-only flags stay out
        self.assertEqual(mine, {(U_MAIN, KEY["inactive_applied"]), (U_MAIN, KEY["rank2"]), (U_OTHER, KEY["rank1"])})
        state = next(s for s in doc["job_state"] if s["job_key"] == KEY["rank2"] and s["user_id"] == U_MAIN)
        self.assertEqual(set(state), {"user_id", "job_key", "is_applied", "applied_at", "is_hidden", "hidden_at",
                                      "application_status", "status_updated_at"})
        self.assertRegex(state["applied_at"], TS_RE)
        role = next(r for r in doc["custom_roles"] if r["role_title"] == CR_MAPPED)
        self.assertEqual(role["duplicate_of"], "Zz Fixture Data Engineer")
        self.assertEqual(set(role), {"role_title", "status", "category", "description", "duplicate_of", "first_user",
                                     "checked_by", "created_at", "checked_at", "attempts"})
        self.assertIn("Zz Fixture Unseen", [s["skill"] for s in doc["custom_skills"]])

    def test_export_skills_and_nothing_private(self):
        self.sql("""UPDATE app.user_profile SET also_skills = %s, muted_companies = '{Acme}', muted_title_words = '{intern}',
                    muted_levels = '{Senior}' WHERE profile_id = %s""", [["Zz Fixture Extra", "zz fixture spark"], U_MAIN])
        self.write("setNote", {"jobKey": KEY["rank2"], "note": "private", "nextActionAt": dt.date.today().isoformat()})
        self.write("setHidden", {"jobKey": KEY["level"], "hidden": True, "reason": "too_senior"})
        self.write("setStatus", {"jobKey": KEY["below"], "status": "saved"})
        doc = self.service("pipeline_export_user_data")
        main = next(p for p in doc["profiles"] if p["profile_id"] == U_MAIN)
        # core skills, then the also-know skills that are not core skills already
        self.assertEqual(main["skills"], ["Zz Fixture Spark", "Zz Fixture SQL", "Zz Fixture Cloud", "Zz Fixture Unseen",
                                          "Zz Fixture Extra"])
        self.assertEqual(set(main), {"profile_id", "email", "target_roles", "skills", "min_years", "max_years",
                                     "preferred_cities", "updated_at"})
        text = json.dumps(doc)
        for private in ("private", "Acme", "too_senior", "next_action_at", "note", "hide_reason", "muted"):
            self.assertNotIn(private, text)
        statuses = {s["job_key"]: s["application_status"] for s in doc["job_state"] if s["user_id"] == U_MAIN}
        self.assertEqual(statuses[KEY["below"]], "saved")  # saved jobs are tracked: exported
        self.assertNotIn(KEY["level"], statuses)  # hidden only

    def test_export_leaves_out_rows_the_pipeline_would_reject(self):
        # 02_ingest_silver refuses the whole user_data.json for one custom role without a known status or a blank name
        self.sql("""INSERT INTO app.custom_roles (role_title, status) VALUES ('Zz Fixture No Status', NULL), ('  ', 'pending')""")
        self.sql("INSERT INTO app.custom_skills (skill) VALUES ('   ')")
        doc = self.service("pipeline_export_user_data")
        titles = [r["role_title"] for r in doc["custom_roles"]]
        self.assertNotIn("Zz Fixture No Status", titles)
        self.assertFalse([t for t in titles if not t.strip()])
        self.assertFalse([k for k in doc["custom_skills"] if not k["skill"].strip()])
        self.assertTrue(all(r["status"] in ("pending", "active", "mapped", "rejected") for r in doc["custom_roles"]))
        self.assertEqual(doc["counts"]["custom_roles"], len(doc["custom_roles"]))

    def test_publish_state(self):
        state = self.service("pipeline_publish_state", False)
        self.assertEqual(set(state), {"run_id", "snapshot_at", "published_at", "counts", "jobs"})
        self.assertEqual(state["jobs"], self.value("SELECT count(*) FROM app.jobs"))
        hashes = self.service("pipeline_publish_state", True)["hashes"]
        self.assertEqual(len(hashes), state["jobs"])
        self.assertIn(KEY["rank1"], hashes)

    # --- publish --------------------------------------------------------------------------------------------------

    def test_publish_happy_path_and_rerun(self):
        snap, job_rows = self.fixture_snapshot()
        hidden_state = self.value("SELECT count(*) FROM app.user_job_state WHERE job_key = %s", [KEY["hidden"]])
        self.assertEqual(hidden_state, 1)
        manifest = self.stage("fixture-run-1", snap, job_rows)
        before = self.value("SELECT count(*) FROM app.jobs")
        result = self.finish("fixture-run-1", manifest)
        self.assertEqual(result["run_id"], "fixture-run-1")
        self.assertEqual(result["upserted_before_finish"], 2)
        self.assertEqual(result["deleted_jobs"], 2)  # halfup + hidden (untracked)
        self.assertEqual(result["kept_tracked_not_in_snapshot"], 1)  # inactive_applied
        self.assertGreaterEqual(result["pruned_state"], 1)  # the hidden-only state row
        self.assertEqual(self.value("SELECT count(*) FROM app.jobs"), before - 2)  # the new job arrived with the batches
        self.assertEqual(self.value("SELECT title FROM app.jobs WHERE job_key = %s", [KEY["rank1"]]),
                         "Zz Fixture Senior Data Engineer (updated)")
        self.assertEqual(self.value("SELECT skill_keys FROM app.jobs WHERE job_key = %s", [fixture_key("pub_new")]),
                         ["zz fixture new skill", "zz fixture cloud"])
        self.assertEqual(self.value("SELECT published_run_id FROM app.jobs WHERE job_key = %s", [fixture_key("pub_new")]), "fixture-run-1")
        self.assertEqual(self.value("SELECT count(*) FROM app.jobs WHERE job_key = ANY(%s)", [[KEY["halfup"], KEY["hidden"]]]), 0)
        self.assertEqual(self.value("SELECT count(*) FROM app.jobs WHERE job_key = %s", [KEY["inactive_applied"]]), 1)
        self.assertEqual(self.value("SELECT count(*) FROM app.user_job_state WHERE job_key = %s", [KEY["hidden"]]), 0)
        self.assertEqual(self.value("SELECT count(*) FROM app.user_job_state us WHERE NOT EXISTS (SELECT 1 FROM app.jobs j WHERE j.job_key = us.job_key)"), 0)
        # small tables replaced
        self.assertEqual(self.value("SELECT count(*) FROM app.skill_stats WHERE skill = 'zz fixture python'"), 0)
        self.assertEqual(self.value("SELECT idf FROM app.skill_stats WHERE skill = 'zz fixture new skill'"), 1.75)
        self.assertEqual(self.value("SELECT count(*) FROM app.ref_roles"), manifest["counts"]["ref_roles"])
        # custom roles: the pipeline's check result wins, nothing is deleted, new ones are added
        self.assertEqual(self.rows("SELECT status, category, attempts FROM app.custom_roles WHERE role_title = %s", [CR_PENDING]),
                         [("active", "Zz Fixture Data", 2)])
        self.assertEqual(self.value("SELECT status FROM app.custom_roles WHERE role_title = %s", [CR_MAPPED]), "mapped")
        self.assertEqual(self.value("SELECT status FROM app.custom_roles WHERE role_title = 'Zz Fixture Brand New'"), "pending")
        self.assertEqual(self.value("SELECT count(*) FROM app.custom_skills WHERE skill = 'Zz Fixture New Skill'"), 1)
        # status, staging
        status = self.read("status")[0]
        self.assertEqual((status["run_id"], status["jobs"]), ("fixture-run-1", manifest["counts"]["jobs"]))
        self.assertEqual(self.value("SELECT count(*) FROM app.publish_keys WHERE run_id = 'fixture-run-1'"), 0)
        self.assertEqual(self.value("SELECT count(*) FROM app.publish_stage WHERE run_id = 'fixture-run-1'"), 0)
        self.assertEqual(self.service("pipeline_publish_state", False)["run_id"], "fixture-run-1")
        # the published state scores like before
        self.assertIn(KEY["inactive_applied"], [r["job_key"] for r in self.read("jobs", {"tab": "applied"})])

        # derived columns and the run history
        self.assertEqual(result["derivations_refreshed"], 0)  # the city list did not change
        self.assertEqual(self.value("SELECT title_key FROM app.jobs WHERE job_key = %s", [KEY["rank1"]]),
                         "zz fixture senior data engineer updated")
        history = self.rows("""SELECT counts ->> 'jobs', upserted, deleted_jobs, kept_tracked, pruned_state
                               FROM app.publish_history WHERE run_id = 'fixture-run-1'""")
        self.assertEqual(history, [(str(manifest["counts"]["jobs"]), 2, 2, 1, result["pruned_state"])])

        # finishing again is a no-op
        again = self.finish("fixture-run-1", manifest)
        self.assertTrue(again["already_published"])
        # so is a complete re-run of the same publish (nothing changed, nothing deleted)
        jobs_before = self.value("SELECT count(*) FROM app.jobs")
        changed = self.service("pipeline_publish", {"run_id": "fixture-run-1", "kind": "jobs", "seq": 0, "rows": job_rows})
        self.assertEqual((changed["accepted"], changed["changed"]), (2, 0))  # same hashes: not rewritten
        snap2 = self.current()
        snap2["keys"] = {k: h for k, h in snap2["keys"].items() if k != KEY["inactive_applied"]}
        rerun = self.finish("fixture-run-1", self.stage("fixture-run-1", snap2))
        self.assertEqual((rerun["deleted_jobs"], rerun["kept_tracked_not_in_snapshot"]), (0, 1))
        self.assertEqual(self.value("SELECT count(*) FROM app.jobs"), jobs_before)

    def test_jobs_batches_rewrite_only_changed_rows(self):
        row = publish_row(JOB_BY_NAME["level"])
        self.assertEqual(self.service("pipeline_publish", {"run_id": "fixture-run-2", "kind": "jobs", "seq": 0, "rows": [row]})["changed"], 1)
        self.assertEqual(self.service("pipeline_publish", {"run_id": "fixture-run-2", "kind": "jobs", "seq": 0, "rows": [row]})["changed"], 0)
        self.assertEqual(self.value("SELECT row_hash FROM app.jobs WHERE job_key = %s", [KEY["level"]]), row["h"])
        # duplicate keys in one batch: the last one wins
        newer = publish_row({**JOB_BY_NAME["level"], "title": "Zz Fixture Level DE v2"})
        self.service("pipeline_publish", {"run_id": "fixture-run-2", "kind": "jobs", "seq": 1, "rows": [row, newer]})
        self.assertEqual(self.value("SELECT title FROM app.jobs WHERE job_key = %s", [KEY["level"]]), "Zz Fixture Level DE v2")

    def test_finish_refuses_incomplete_staging(self):
        snap = self.current()
        manifest = self.stage("fixture-run-3", snap)
        bad = json.loads(json.dumps(manifest))
        bad["counts"]["jobs"] += 1
        with self.assertSqlError(f"{len(snap['keys'])} keys staged but the manifest has {len(snap['keys']) + 1} jobs; re-run the publish"):
            self.finish("fixture-run-3", bad)
        bad = json.loads(json.dumps(manifest))
        bad["counts"]["skill_stats"] += 1
        with self.assertSqlError(f"skill_stats: {len(snap['skill_stats'])} rows staged but the manifest has {len(snap['skill_stats']) + 1}; re-run the publish"):
            self.finish("fixture-run-3", bad)
        with self.assertSqlError("Manifest run_id does not match"):
            self.finish("fixture-run-3", {**manifest, "run_id": "fixture-run-x"})
        with self.assertSqlError("Manifest snapshot_at missing or invalid"):
            self.finish("fixture-run-3", {**manifest, "snapshot_at": "not a date"})
        # a key whose job is missing or has another hash
        self.service("pipeline_publish", {"run_id": "fixture-run-3", "kind": "keys", "seq": 1,
                                          "keys": [[fixture_key("never-sent"), "abc"]]})
        manifest["counts"]["jobs"] += 1
        with self.assertSqlError("1 jobs missing or outdated in app.jobs; re-run the publish"):
            self.finish("fixture-run-3", manifest)
        # nothing was applied
        self.assertNotEqual(self.read("status")[0]["run_id"], "fixture-run-3")

    def test_shrink_older_and_empty_guards(self):
        snap = self.current()
        small = dict(snap, keys={KEY["rank1"]: snap["keys"][KEY["rank1"]]})
        manifest = self.stage("fixture-run-4", small)
        total = self.value("SELECT count(*) FROM app.jobs")
        with self.assertSqlError(f"Snapshot shrinks app.jobs from {total} to 1 jobs; pass force"):
            self.finish("fixture-run-4", manifest)
        empty = self.stage("fixture-run-5", dict(snap, keys={}))
        with self.assertSqlError(f"Snapshot shrinks app.jobs from {total} to 0 jobs; pass force"):
            self.finish("fixture-run-5", empty)
        no_roles = self.stage("fixture-run-6", dict(snap, ref_roles=[]))
        with self.assertSqlError("Snapshot has no reference roles"):
            self.finish("fixture-run-6", no_roles, force=True)
        # force: the shrinking snapshot is applied, tracked jobs survive
        result = self.finish("fixture-run-4", manifest, force=True)
        self.assertEqual(result["kept_tracked_not_in_snapshot"],
                         self.value("SELECT count(*) FROM app.jobs WHERE job_key <> %s", [KEY["rank1"]]))
        self.assertEqual(self.value("""SELECT count(*) FROM app.jobs j WHERE NOT EXISTS (
                                         SELECT 1 FROM app.user_job_state s WHERE s.job_key = j.job_key
                                         AND (s.is_applied OR s.application_status <> 'not_applied'))
                                       AND j.job_key <> %s""", [KEY["rank1"]]), 0)
        self.assertGreaterEqual(self.value("SELECT count(*) FROM app.jobs WHERE job_key = ANY(%s)",
                                           [[KEY["rank2"], KEY["inactive_applied"]]]), 2)
        # an older snapshot than the published one is refused unless forced
        snap = self.current()
        older = self.stage("fixture-run-7", dict(snap, snapshot_at="2001-01-01T00:00:00.000000Z"))
        with self.assertRaises(Exception) as caught:
            self.finish("fixture-run-7", older)
        self.assertRegex(str(caught.exception), r"^Snapshot 2001-01-01T00:00:00\.000000Z is older than the published snapshot .+; pass force$")
        self.assertEqual(self.finish("fixture-run-7", older, force=True)["run_id"], "fixture-run-7")

    def test_shrink_guard_uses_the_published_snapshot_size(self):
        # app.jobs already holds this run's new rows when finish runs, so the guard compares with the previously
        # published snapshot (pipeline_status.counts.jobs), not with app.jobs
        snap = self.current()
        small = dict(snap, keys={KEY["rank1"]: snap["keys"][KEY["rank1"]]})
        self.sql("""INSERT INTO app.pipeline_status (id, counts) VALUES (1, '{"jobs": 3}')
                    ON CONFLICT (id) DO UPDATE SET counts = EXCLUDED.counts""")
        manifest = self.stage("fixture-run-9", small)
        total = self.value("SELECT count(*) FROM app.jobs")
        with self.assertSqlError(f"Snapshot shrinks app.jobs from {total} to 1 jobs; pass force"):
            self.finish("fixture-run-9", manifest)
        self.sql("""UPDATE app.pipeline_status SET counts = '{"jobs": 2}' WHERE id = 1""")
        self.assertEqual(self.finish("fixture-run-9", manifest)["run_id"], "fixture-run-9")

    def test_kept_tracked_job_is_shown_as_closed(self):
        snap = self.current()
        self.assertTrue(self.value("SELECT is_active FROM app.jobs WHERE job_key = %s", [KEY["rank2"]]))
        old_hash = snap["keys"].pop(KEY["rank2"])
        result = self.finish("fixture-run-10", self.stage("fixture-run-10", snap))
        self.assertGreaterEqual(result["kept_tracked_not_in_snapshot"], 1)
        self.assertEqual(self.rows("SELECT is_active, row_hash FROM app.jobs WHERE job_key = %s", [KEY["rank2"]]),
                         [(False, old_hash + ":expired")])
        # back in a later snapshot with the old content: the hash differs, so the row is sent and rewritten
        row = publish_row(JOB_BY_NAME["rank2"])
        self.sql("UPDATE app.jobs SET row_hash = %s || ':expired' WHERE job_key = %s", [row["h"], KEY["rank2"]])
        changed = self.service("pipeline_publish", {"run_id": "fixture-run-11", "kind": "jobs", "seq": 0, "rows": [row]})
        self.assertEqual(changed["changed"], 1)
        self.assertTrue(self.value("SELECT is_active FROM app.jobs WHERE job_key = %s", [KEY["rank2"]]))

    def test_batch_validation(self):
        cases = [
            ([1, 2], "Batch must be a JSON object"),
            ({"kind": "jobs", "seq": 0, "rows": []}, "Invalid run_id"),
            ({"run_id": "bad id!", "kind": "jobs", "seq": 0, "rows": []}, "Invalid run_id"),
            ({"run_id": "r1", "kind": "nope", "seq": 0, "rows": []}, "Unknown kind: nope"),
            ({"run_id": "r1", "kind": "jobs", "seq": -1, "rows": []}, "Invalid seq"),
            ({"run_id": "r1", "kind": "jobs", "seq": "0", "rows": []}, "Invalid seq"),
            ({"run_id": "r1", "kind": "keys", "keys": []}, "Invalid seq"),
            ({"run_id": "r1", "kind": "skill_stats", "seq": None, "rows": []}, "Invalid seq"),
            ({"run_id": "r1", "kind": "jobs", "seq": 0, "rows": {}}, "rows must be a list"),
            ({"run_id": "r1", "kind": "keys", "seq": 0, "rows": []}, "keys must be a list"),
            ({"run_id": "r1", "kind": "jobs", "seq": 0, "rows": [{"job_key": "x", "h": "a"}]}, "1 job rows without a valid job_key or h"),
            ({"run_id": "r1", "kind": "jobs", "seq": 0, "rows": [{"job_key": "a" * 64}]}, "1 job rows without a valid job_key or h"),
            ({"run_id": "r1", "kind": "keys", "seq": 0, "keys": [["a" * 64]]}, "1 keys are not [job_key, h] pairs"),
            ({"run_id": "r1", "kind": "ref_roles", "seq": 0, "rows": [1]}, "1 ref_roles rows are not JSON objects"),
        ]
        for batch, message in cases:
            with self.subTest(message=message):
                with self.assertSqlError(message):
                    self.service("pipeline_publish", batch)
        with self.assertSqlError("Invalid run_id"):
            self.finish("bad id!", {"run_id": "bad id!", "counts": {}})

    def test_seq_zero_restarts_a_staged_kind(self):
        rows = [{"skill": f"zz fixture s{i}", "jobs": 1, "idf": 1.0} for i in range(3)]
        self.service("pipeline_publish", {"run_id": "fixture-run-8", "kind": "skill_stats", "seq": 0, "rows": rows[:1]})
        self.service("pipeline_publish", {"run_id": "fixture-run-8", "kind": "skill_stats", "seq": 1, "rows": rows[1:]})
        self.service("pipeline_publish", {"run_id": "fixture-run-8", "kind": "skill_stats", "seq": 0, "rows": rows})
        self.assertEqual(self.value("""SELECT sum(jsonb_array_length(rows)) FROM app.publish_stage
                                       WHERE run_id = 'fixture-run-8' AND kind = 'skill_stats'"""), 3)

    def test_finish_refreshes_derivations_and_prunes(self):
        snap = self.current()
        snap["ref_cities"] = snap["ref_cities"] + [{"alias": "zz fixture office assistant", "city": "Zz Fixture Assist",
                                                    "state": None}]
        self.sql("UPDATE app.jobs SET location = 'Zz Fixture Office Assistant' WHERE job_key = %s", [KEY["halfup"]])
        snap["keys"][KEY["halfup"]] = self.value("SELECT row_hash FROM app.jobs WHERE job_key = %s", [KEY["halfup"]])
        self.sql("""INSERT INTO app.job_feedback (user_id, job_key, reason, created_at) VALUES
                    (%s, %s, 'other', now() - interval '181 days'), (%s, %s, 'other', now() - interval '10 days')""",
                 [U_MAIN, KEY["rank1"], U_MAIN, KEY["below"]])
        self.many("""INSERT INTO app.publish_history (run_id, published_at) VALUES (%s, now() - make_interval(hours => %s))""",
                  [[f"fixture-old-{i}", i + 1] for i in range(55)])
        result = self.finish("fixture-run-12", self.stage("fixture-run-12", snap))
        self.assertGreaterEqual(result["derivations_refreshed"], 1)
        self.assertEqual(self.rows("SELECT cities, title_key FROM app.jobs WHERE job_key = %s", [KEY["halfup"]]),
                         [(["Zz Fixture Assist"], "")])  # the title is the new city's name now
        self.assertEqual(self.rows("SELECT job_key FROM app.job_feedback WHERE user_id = %s", [U_MAIN]), [(KEY["below"],)])
        self.assertEqual(self.value("SELECT count(*) FROM app.publish_history"), 50)
        self.assertEqual(self.value("SELECT count(*) FROM app.publish_history WHERE run_id = 'fixture-run-12'"), 1)


def at(minutes):
    """An ISO time relative to now (retention keeps only the newest rows, real ones included)"""
    return (NOW + dt.timedelta(minutes=minutes)).isoformat()


def report(**changes):
    doc = {"format": "jobseeker.scrape_report.v1", "source": "workday",
           "run": {"github_run_id": "fixture-77", "github_run_attempt": 1, "workflow": "Databricks Scrapers",
                   "started_at": at(-10), "finished_at": at(0), "status": "partial",
                   "message": None},
           "totals": {"companies": 2, "failed": 1, "jobs_scraped": 30, "jobs_written": 12, "missing_descriptions": 1,
                      "already_seen": None},
           "companies": [{"name": "Zz Fixture Acme", "ok": True, "jobs_found": 12, "error": None},
                         {"name": "Zz Fixture Broken", "ok": False, "jobs_found": None, "error": "HTTP 404"}]}
    for key, value in changes.items():
        if key in ("run", "totals"):
            doc[key] = {**doc[key], **value}
        else:
            doc[key] = value
    return doc


class ScrapeReportTest(DbTestCase):
    load_fixtures = False

    def companies(self, source="workday"):
        return {r[0]: r[1:] for r in self.rows("""SELECT company_lc, company, failures, last_error, jobs_found,
                                                         last_ok_at IS NOT NULL, last_scraped_at
                                                  FROM app.scrape_companies WHERE source = %s AND company_lc LIKE 'zz fixture%%'""",
                                               [source])}

    def test_record_and_idempotency(self):
        self.assertEqual(self.service("pipeline_record_scrape", report()), {"recorded": True, "companies": 2})
        runs = self.rows("""SELECT status, companies, failed, jobs_scraped, jobs_written, missing_descriptions, already_seen,
                                   workflow, github_run_attempt FROM app.scrape_runs WHERE github_run_id = 'fixture-77'""")
        self.assertEqual(runs, [("partial", 2, 1, 30, 12, 1, None, "Databricks Scrapers", 1)])
        companies = self.companies()
        self.assertEqual(companies["zz fixture acme"][:5], ("Zz Fixture Acme", 0, None, 12, True))
        self.assertEqual(companies["zz fixture broken"][:5], ("Zz Fixture Broken", 1, "HTTP 404", None, False))
        # the same report again: the run row is replaced, failures are not counted twice
        self.service("pipeline_record_scrape", report(run={"status": "failed"}))
        self.assertEqual(self.value("SELECT count(*) FROM app.scrape_runs WHERE github_run_id = 'fixture-77'"), 1)
        self.assertEqual(self.value("SELECT status FROM app.scrape_runs WHERE github_run_id = 'fixture-77'"), "failed")
        self.assertEqual(self.companies()["zz fixture broken"][1], 1)
        # a later run: consecutive failures count up, a good scrape resets them
        later = {"github_run_id": "fixture-78", "finished_at": at(60)}
        self.service("pipeline_record_scrape", report(run=later))
        self.assertEqual(self.companies()["zz fixture broken"][1:3], (2, "HTTP 404"))
        self.service("pipeline_record_scrape", report(run={"github_run_id": "fixture-79", "finished_at": at(120)},
                                                      companies=[{"name": "zz fixture BROKEN ", "ok": True, "jobs_found": 0}]))
        broken = self.companies()["zz fixture broken"]
        self.assertEqual(broken[:5], ("zz fixture BROKEN", 0, None, 0, True))
        # an older report never moves a company back
        self.service("pipeline_record_scrape", report(run={"github_run_id": "fixture-70", "finished_at": at(-60 * 24)}))
        self.assertEqual(self.companies()["zz fixture broken"][1], 0)

    def test_linkedin_and_crashed(self):
        dropped = [f"Zz Fixture Role | Search {i}" for i in range(600)]
        self.service("pipeline_record_scrape", report(source="linkedin", linkedin={"searches_total": 104, "searches_cap": 90,
                                                                                  "dropped": dropped + ["", 5]},
                                                      run={"message": "m" * 1200}))
        row = self.rows("""SELECT searches_total, searches_cap, cardinality(dropped_searches), dropped_searches[1],
                                  char_length(message) FROM app.scrape_runs WHERE source = 'linkedin' AND github_run_id = 'fixture-77'""")
        self.assertEqual(row, [(104, 90, 500, dropped[0], 1000)])
        # a crashed report without companies
        doc = report(run={"github_run_id": "fixture-80", "status": "crashed", "message": "scraper wrote no report"})
        del doc["companies"]
        del doc["totals"]
        self.assertEqual(self.service("pipeline_record_scrape", doc), {"recorded": True, "companies": 0})
        self.assertEqual(self.rows("SELECT status, companies, message FROM app.scrape_runs WHERE github_run_id = 'fixture-80'"),
                         [("crashed", None, "scraper wrote no report")])

    def test_validation(self):
        cases = [
            ({"format": "nope"}, "Unknown report format"),
            ([1], "Unknown report format"),
            (report(source="phenom"), "Invalid source"),
            (report(run={"status": "great"}), "Invalid status"),
            (report(run={"finished_at": "yesterday"}), "Invalid finished_at"),
            (report(run={"finished_at": None}), "Invalid finished_at"),
            (report(companies={"a": 1}), "Invalid companies"),
            (report(companies=[{"name": " "}]), "Invalid companies"),
            (report(companies=["Acme"]), "Invalid companies"),
            (report(companies=[{"name": f"c{i}", "ok": True} for i in range(501)]), "Invalid companies"),
        ]
        for doc, message in cases:
            with self.subTest(message=message):
                with self.assertSqlError(message):
                    self.service("pipeline_record_scrape", doc)

    def test_retention(self):
        for i in range(32):
            self.service("pipeline_record_scrape", report(run={"github_run_id": f"fixture-r{i}",
                                                               "finished_at": at(i)}, companies=[]))
        kept = [r[0] for r in self.rows("""SELECT github_run_id FROM app.scrape_runs WHERE source = 'workday'
                                           AND github_run_id LIKE 'fixture-r%' ORDER BY finished_at""")]
        self.assertLessEqual(self.value("SELECT count(*) FROM app.scrape_runs WHERE source = 'workday'"), 30)
        self.assertNotIn("fixture-r0", kept)
        self.assertIn("fixture-r31", kept)
        self.sql("""INSERT INTO app.scrape_companies (source, company_lc, company, last_scraped_at)
                    VALUES ('workday', 'zz fixture stale', 'Zz Fixture Stale', now() - interval '31 days')""")
        self.service("pipeline_record_scrape", report(run={"github_run_id": "fixture-r99"}, companies=[]))
        self.assertNotIn("zz fixture stale", self.companies())


class RunHistoryTest(DbTestCase):
    load_fixtures = False

    def test_record_runs(self):
        runs = [{"run_id": 111222333, "started_at": at(0), "ended_at": at(25),
                 "duration_s": 1520, "state": "TERMINATED", "result": "SUCCESS", "message": "x" * 400, "trigger": "PERIODIC",
                 "tasks": [{"task_key": "Step_01_Ingest_Silver", "state": "TERMINATED", "result": "SUCCESS",
                            "started_at": "2026-10-01T00:00:05Z", "duration_s": 300, "extra": "dropped"}]},
                {"run_id": "111222334", "started_at": None, "state": "RUNNING", "tasks": None}]
        self.assertEqual(self.service("pipeline_record_runs", {"runs": runs}), {"recorded": 2})
        row = self.rows("""SELECT duration_s, state, result, char_length(message), trigger, tasks
                           FROM app.pipeline_runs WHERE run_id = '111222333'""")[0]
        self.assertEqual(row[:5], (1520, "TERMINATED", "SUCCESS", 300, "PERIODIC"))
        self.assertEqual(row[5], [{"task_key": "Step_01_Ingest_Silver", "state": "TERMINATED", "result": "SUCCESS",
                                   "started_at": "2026-10-01T00:00:05+00:00", "duration_s": 300}])
        self.assertEqual(self.rows("SELECT state, result, tasks FROM app.pipeline_runs WHERE run_id = '111222334'"),
                         [("RUNNING", None, [])])
        # upsert: the finished state replaces the running one
        self.service("pipeline_record_runs", {"runs": [{"run_id": "111222334", "state": "TERMINATED", "result": "FAILED"}]})
        self.assertEqual(self.value("SELECT result FROM app.pipeline_runs WHERE run_id = '111222334'"), "FAILED")
        # newest 50 by started_at
        self.service("pipeline_record_runs", {"runs": [{"run_id": 900000 + i, "started_at": at(10 + i)}
                                                       for i in range(50)]})
        self.assertEqual(self.value("SELECT count(*) FROM app.pipeline_runs"), 50)
        self.assertEqual(self.value("SELECT count(*) FROM app.pipeline_runs WHERE run_id = '111222333'"), 0)

    def test_validation(self):
        for batch in ({"runs": "x"}, {}, [1], {"runs": [{"run_id": "abc"}]}, {"runs": [{}]}, {"runs": [1]},
                      {"runs": [{"run_id": 1, "tasks": "x"}]}, {"runs": [{"run_id": 1, "tasks": [1]}]},
                      {"runs": [{"run_id": 1, "tasks": [{}] * 21}]}, {"runs": [{"run_id": i} for i in range(51)]}):
            with self.subTest(batch=str(batch)[:40]):
                with self.assertSqlError("Invalid runs"):
                    self.service("pipeline_record_runs", batch)
