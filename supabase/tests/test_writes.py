"""app_write: applied / hidden flags, profile validation (every message) and the allow-list admin action.

setStatus, setNote, saveMuteRules and the bulk forms are in test_features.py.
"""
from base import (CITY, CR_REJECTED, EMAILS, KEY, OTHER_COMPANY, R_AE, R_DE, R_OUT, U_ADMIN, U_FALLBACK, U_MAIN, U_NOPROFILE, U_OTHER,
                  DbTestCase)

GOOD = {"target_roles": [R_DE], "skills": ["Python"], "min_years": 1, "max_years": 4}


def affected(rows):
    return rows[0]["num_affected_rows"]


class FlagsTest(DbTestCase):
    def state(self, uid, job_key):
        row = self.conn.execute("""SELECT is_applied, applied_at, is_hidden, hidden_at, application_status,
                                          status_updated_at, updated_at
                                   FROM app.user_job_state WHERE user_id = %s AND job_key = %s""", [uid, job_key]).fetchone()
        if row is None:
            return None
        return dict(zip(["is_applied", "applied_at", "is_hidden", "hidden_at", "application_status", "status_updated_at",
                         "updated_at"], row))

    def test_set_applied_insert_update_and_unapply(self):
        key = KEY["level"]
        self.assertIsNone(self.state(U_MAIN, key))
        self.assertEqual(affected(self.write("setApplied", {"jobKey": key, "applied": True})), 1)
        first = self.state(U_MAIN, key)
        self.assertTrue(first["is_applied"])
        self.assertEqual(first["application_status"], "applied")
        self.assertIsNotNone(first["applied_at"])
        self.sql("UPDATE app.user_job_state SET applied_at = applied_at - interval '1 day', is_hidden = true WHERE user_id = %s AND job_key = %s",
                 [U_MAIN, key])
        kept = self.state(U_MAIN, key)["applied_at"]
        self.assertEqual(affected(self.write("setApplied", {"jobKey": key, "applied": True})), 1)
        again = self.state(U_MAIN, key)
        self.assertEqual(again["applied_at"], kept)  # the first applied_at stays
        self.assertTrue(again["is_hidden"])  # untouched by setApplied
        self.write("setApplied", {"jobKey": key, "applied": False})
        self.write("setHidden", {"jobKey": key, "hidden": False})
        off = self.state(U_MAIN, key)
        self.assertFalse(off["is_applied"])
        self.assertIsNone(off["applied_at"])
        self.assertEqual(off["application_status"], "not_applied")
        # visible in the app right away
        row = next(r for r in self.read("jobs", {"scope": "all", "q": "zz fixture level de"}) if r["job_key"] == key)
        self.assertFalse(row["is_applied"])

    def test_missing_job_writes_nothing(self):
        self.assertEqual(affected(self.write("setApplied", {"jobKey": "f" * 64, "applied": True})), 0)
        self.assertEqual(affected(self.write("setHidden", {"jobKey": "f" * 64, "hidden": True})), 0)
        self.assertIsNone(self.state(U_MAIN, "f" * 64))

    def test_set_hidden(self):
        key = KEY["rank1"]
        self.assertEqual(affected(self.write("setHidden", {"jobKey": key, "hidden": True})), 1)
        st = self.state(U_MAIN, key)
        self.assertTrue(st["is_hidden"])
        self.assertIsNotNone(st["hidden_at"])
        self.assertFalse(st["is_applied"])
        self.assertNotIn(key, [r["job_key"] for r in self.read("jobs")])
        self.assertIn(key, [r["job_key"] for r in self.read("hiddenJobs")])
        status_time = st["status_updated_at"]
        self.write("setHidden", {"jobKey": key, "hidden": False})
        st = self.state(U_MAIN, key)
        self.assertFalse(st["is_hidden"])
        self.assertIsNone(st["hidden_at"])
        self.assertEqual(st["status_updated_at"], status_time)
        # applying keeps a job hidden state as it is, hiding keeps the applied state
        self.write("setApplied", {"jobKey": key, "applied": True})
        self.write("setHidden", {"jobKey": key, "hidden": True})
        st = self.state(U_MAIN, key)
        self.assertTrue(st["is_applied"] and st["is_hidden"])

    def test_restore_hidden_only_own_rows(self):
        self.write("setHidden", {"jobKey": KEY["rank1"], "hidden": True})
        self.assertEqual(affected(self.write("restoreHidden")), 2)  # fixture "hidden" + rank1
        self.assertEqual(self.read("hiddenJobs"), [])
        self.assertTrue(self.state(U_OTHER, KEY["below"])["is_hidden"])
        self.assertEqual(affected(self.write("restoreHidden")), 0)

    def test_flag_validation(self):
        for action, flag in (("setApplied", "applied"), ("setHidden", "hidden")):
            with self.assertSqlError("Invalid job key"):
                self.write(action, {"jobKey": "abc", flag: True})
            with self.assertSqlError("Invalid job key"):
                self.write(action, {"jobKey": 123, flag: True})
            with self.assertSqlError("Invalid job key"):  # the key is checked first
                self.write(action, {flag: "yes"})
            for bad in ("true", 1, None):
                with self.assertSqlError("Expected true or false"):
                    self.write(action, {"jobKey": KEY["rank1"], flag: bad})
            with self.assertSqlError("Expected true or false"):
                self.write(action, {"jobKey": KEY["rank1"]})

    def test_updated_at_moves(self):
        self.sql("UPDATE app.user_job_state SET updated_at = '2020-01-01Z' WHERE user_id = %s", [U_MAIN])
        self.write("setHidden", {"jobKey": KEY["hidden"], "hidden": False})
        self.assertGreater(self.state(U_MAIN, KEY["hidden"])["updated_at"].year, 2020)
        self.write("restoreHidden")


class ProfileTest(DbTestCase):
    def profile(self, uid):
        rows = self.read("profile", uid=uid)
        return rows[0] if rows else None

    def save(self, params, uid=U_NOPROFILE, **claims):
        return self.write("saveProfile", params, uid=uid, **claims)

    def test_insert_and_update(self):
        self.assertEqual(affected(self.save({**GOOD, "preferred_cities": ["zz fixture town", CITY.upper(), " Zz Fixture Village "]})), 1)
        saved = self.profile(U_NOPROFILE)
        self.assertEqual(saved["target_roles"], [R_DE])
        self.assertEqual(saved["skills"], ["Python"])
        self.assertEqual((saved["min_years"], saved["max_years"]), (1, 4))
        self.assertEqual(saved["preferred_cities"], [CITY, "Zz Fixture Village"])  # canonical, distinct, order kept
        self.assertEqual(self.value("SELECT email FROM app.user_profile WHERE profile_id = %s", [U_NOPROFILE]), EMAILS[U_NOPROFILE])
        # left out or null: cities stay
        self.save({"target_roles": [R_AE, " zz fixture analytics engineer ", "  "], "skills": ["SQL", "sql", "Spark"]})
        saved = self.profile(U_NOPROFILE)
        self.assertEqual(saved["target_roles"], [R_AE])  # deduped by lower case, blanks skipped
        self.assertEqual(saved["skills"], ["SQL", "Spark"])
        self.assertEqual(saved["preferred_cities"], [CITY, "Zz Fixture Village"])
        self.assertIsNone(saved["min_years"])
        self.save({**GOOD, "preferred_cities": None, "min_years": "3", "max_years": 99})
        saved = self.profile(U_NOPROFILE)
        self.assertEqual(saved["preferred_cities"], [CITY, "Zz Fixture Village"])
        self.assertEqual((saved["min_years"], saved["max_years"]), (3, 40))  # clamped
        # an empty list clears them
        self.save({**GOOD, "preferred_cities": []})
        self.assertEqual(self.profile(U_NOPROFILE)["preferred_cities"], [])
        # the new profile scores jobs
        row = self.read("jobs", {"scope": "all", "q": "zz fixture senior data engineer"}, uid=U_NOPROFILE)[0]
        self.assertEqual((row["job_key"], row["fit_role"], row["role_match"]), (KEY["rank1"], 1.0, True))

    def test_new_profile_without_cities(self):
        self.save(GOOD, uid=U_FALLBACK)
        self.assertEqual(self.profile(U_FALLBACK)["preferred_cities"], [])  # U_FALLBACK had [] before
        self.save(GOOD)
        self.assertEqual(self.profile(U_NOPROFILE)["preferred_cities"], [])

    def test_list_messages(self):
        cases = [
            ({**GOOD, "target_roles": "Data Engineer"}, "Roles must be a list"),
            ({**GOOD, "skills": {"a": 1}}, "Skills must be a list"),
            ({**GOOD, "preferred_cities": "Pune"}, "Preferred cities must be a list"),
            ({**GOOD, "target_roles": ["A" * 61]}, 'Roles: "' + "A" * 20 + '…" is longer than 60 characters'),
            ({**GOOD, "skills": ["Python", "b" * 70]}, 'Skills: "' + "b" * 20 + '…" is longer than 60 characters'),
            ({**GOOD, "target_roles": ["Data Engineer", "ML Engineer", "Data Analyst"]}, "Roles: at most 2 items"),
            ({**GOOD, "skills": ["a1", "b1", "c1", "d1", "e1", "f1"]}, "Skills: at most 5 items"),
            ({**GOOD, "preferred_cities": ["Pune", "Delhi", "Agra", "Goa"]}, "Preferred cities: at most 3 items"),
            # a huge list: still the JS answer (and fast), a long entry anywhere still wins over "at most"
            ({**GOOD, "skills": [f"s{i}" for i in range(20000)]}, "Skills: at most 5 items"),
            ({**GOOD, "skills": [f"s{i}" for i in range(20000)] + ["c" * 61]}, 'Skills: "' + "c" * 20 + '…" is longer than 60 characters'),
            ({**GOOD, "preferred_cities": ["Pune1"]}, 'Preferred cities: "Pune1" is not a city name'),
            ({**GOOD, "preferred_cities": ["X" * 35 + "1"]}, 'Preferred cities: "' + "X" * 30 + '" is not a city name'),
            ({**GOOD, "target_roles": []}, "Pick at least one role"),
            ({"skills": ["Python"]}, "Pick at least one role"),
            ({**GOOD, "target_roles": None}, "Pick at least one role"),
            ({**GOOD, "skills": ["  ", 5, None]}, "Pick at least one skill"),
            ({**GOOD, "target_roles": ["A"]}, 'Roles: "A" - Too short'),
            ({**GOOD, "skills": ["C'est"]}, "Skills: \"C'est\" - Use letters, numbers, spaces and . + # & / ( ) - only"),
            ({**GOOD, "skills": ["123"]}, 'Skills: "123" - Use letters, numbers, spaces and . + # & / ( ) - only'),
            ({**GOOD, "skills": ["-NET"]}, 'Skills: "-NET" - Use letters, numbers, spaces and . + # & / ( ) - only'),
            ({**GOOD, "skills": ["Communication Skills"]}, 'Skills: "Communication Skills" - "Communication Skills" is too general to match jobs on'),
            ({**GOOD, "target_roles": ["Engineer"]}, 'Roles: "Engineer" - "Engineer" is too general to match jobs on'),
            ({**GOOD, "min_years": 5, "max_years": 2}, "Minimum years cannot be more than maximum years"),
            ({**GOOD, "target_roles": [R_OUT.lower()]}, "We only support data, full stack, backend, DevOps and cloud roles"),
            ({**GOOD, "target_roles": [R_DE, CR_REJECTED]}, "We only support data, full stack, backend, DevOps and cloud roles"),
            ({**GOOD, "preferred_cities": ["Atlantis"]}, "Preferred cities: pick Indian cities from the list"),
            ({**GOOD, "preferred_cities": ["India"]}, "Preferred cities: pick Indian cities from the list"),
        ]
        for params, message in cases:
            with self.subTest(message=message):
                with self.assertSqlError(message):
                    self.save(params)
        self.assertIsNone(self.profile(U_NOPROFILE))

    def test_message_order(self):
        # list problems come before city names, which come before missing roles, entry problems and years
        with self.assertSqlError("Skills: at most 5 items"):
            self.save({"target_roles": [], "skills": list("abcdef"), "preferred_cities": ["Pune1"]})
        with self.assertSqlError('Preferred cities: "Pune1" is not a city name'):
            self.save({"target_roles": [], "skills": ["Python"], "preferred_cities": ["Pune1"]})
        with self.assertSqlError("Pick at least one role"):
            self.save({"target_roles": [], "skills": ["x"], "min_years": 9, "max_years": 1})
        with self.assertSqlError('Roles: "A" - Too short'):
            self.save({"target_roles": ["A"], "skills": ["x"], "min_years": 9, "max_years": 1})
        with self.assertSqlError("Minimum years cannot be more than maximum years"):
            self.save({"target_roles": [R_OUT], "skills": ["Python"], "min_years": 9, "max_years": 1,
                       "preferred_cities": ["Atlantis"]})
        with self.assertSqlError("We only support data, full stack, backend, DevOps and cloud roles"):
            self.save({"target_roles": [R_OUT], "skills": ["Python"], "preferred_cities": ["Atlantis"]})

    def test_allowed_characters(self):
        self.save({"target_roles": ["Node.js Developer"], "skills": ["C++", "C#", ".NET", "CI/CD", "A/B Testing (Web) & More"]})
        self.assertEqual(self.profile(U_NOPROFILE)["skills"], ["C++", "C#", ".NET", "CI/CD", "A/B Testing (Web) & More"])
        # JavaScript trim() white space, including no-break and ideographic spaces
        self.save({"target_roles": [" Data Engineer　"], "skills": ["\tPython\n"]})
        saved = self.profile(U_NOPROFILE)
        self.assertEqual((saved["target_roles"], saved["skills"]), (["Data Engineer"], ["Python"]))
        # 60 characters is fine
        self.save({"target_roles": ["R" * 60], "skills": ["Python"]})
        self.assertEqual(self.profile(U_NOPROFILE)["target_roles"], ["R" * 60])

    def test_also_know_skills(self):
        self.save({**GOOD, "skills": ["Python", "SQL"], "also_skills": ["Spark", " spark ", "Airflow"]})
        self.assertEqual(self.profile(U_NOPROFILE)["also_skills"], ["Spark", "Airflow"])
        # left out or null: kept, minus those that became core skills
        self.save({**GOOD, "skills": ["Python", "Airflow"], "also_skills": None})
        self.assertEqual(self.profile(U_NOPROFILE)["also_skills"], ["Spark"])
        self.save({**GOOD, "also_skills": []})
        self.assertEqual(self.profile(U_NOPROFILE)["also_skills"], [])
        self.save({**GOOD, "also_skills": [f"Skill {c}" for c in "abcdefghij"]})  # 10 is the limit
        self.assertEqual(len(self.profile(U_NOPROFILE)["also_skills"]), 10)
        cases = [
            ({**GOOD, "also_skills": "Spark"}, "Also know must be a list"),
            ({**GOOD, "also_skills": [f"Skill {c}" for c in "abcdefghijk"]}, "Also know: at most 10 items"),
            ({**GOOD, "also_skills": ["S"]}, 'Also know: "S" - Too short'),
            ({**GOOD, "also_skills": ["Teamwork"]}, 'Also know: "Teamwork" - "Teamwork" is too general to match jobs on'),
            ({**GOOD, "also_skills": ["python"]}, 'Also know: "python" is already a core skill'),
            ({**GOOD, "also_skills": ["x" * 61]}, 'Also know: "' + "x" * 20 + '…" is longer than 60 characters'),
            # order: after the role and skill entries, before the years
            ({**GOOD, "skills": ["P"], "also_skills": ["S"]}, 'Skills: "P" - Too short'),
            ({**GOOD, "min_years": 5, "max_years": 1, "also_skills": ["S"]}, 'Also know: "S" - Too short'),
            ({**GOOD, "also_skills": [f"s{i}" for i in range(11)], "preferred_cities": "Pune"}, "Also know: at most 10 items"),
        ]
        for params, message in cases:
            with self.subTest(message=message):
                with self.assertSqlError(message):
                    self.save(params)

    def test_email_from_the_token(self):
        self.sql("DELETE FROM app.allowed_emails WHERE true")  # any email may sign in (rolled back with the test)
        self.save(GOOD, email="")
        self.assertIsNone(self.value("SELECT email FROM app.user_profile WHERE profile_id = %s", [U_NOPROFILE]))
        self.save(GOOD, email="  Mixed.Case@Example.test ")
        self.assertEqual(self.value("SELECT email FROM app.user_profile WHERE profile_id = %s", [U_NOPROFILE]), "Mixed.Case@Example.test")


class AllowListAdminTest(DbTestCase):
    def test_set_allowed_email(self):
        admin = {"uid": U_ADMIN, "admin": True}
        self.assertEqual(affected(self.write("setAllowedEmail", {"email": " New.Person@Example.test ", "allowed": True}, **admin)), 1)
        self.assertEqual(affected(self.write("setAllowedEmail", {"email": "new.person@example.test", "allowed": True}, **admin)), 0)
        emails = [r["email"] for r in self.read("allowedEmails", **admin)]
        self.assertIn("new.person@example.test", emails)
        self.assertEqual(self.value("SELECT added_by::text FROM app.allowed_emails WHERE email = 'new.person@example.test'"), U_ADMIN)
        # the list is now non-empty: others are blocked unless listed
        if EMAILS[U_MAIN] not in emails:
            with self.assertSqlError("This account is not allowed to use the job data", "42501"):
                self.read("status")
        self.assertEqual(affected(self.write("setAllowedEmail", {"email": "NEW.PERSON@example.test", "allowed": False}, **admin)), 1)
        for bad in ("nobody", "a@b", "a b@c.de", "", 5):
            with self.assertSqlError("Invalid email"):
                self.write("setAllowedEmail", {"email": bad, "allowed": True}, **admin)
        with self.assertSqlError("Expected true or false"):
            self.write("setAllowedEmail", {"email": "a@b.co", "allowed": "yes"}, **admin)

    def test_company_health(self):
        rows = self.read("companyHealth", uid=U_ADMIN, admin=True)
        mine = [r for r in rows if r["company"] == "zz fixture other co"]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["source"], "greenhouse")
        self.assertTrue(mine[0]["latest_first_seen"].endswith("+00:00"))
        self.assertFalse([r for r in rows if r["company"] == "zz fixture co"])  # linkedin rows are not listed

    def test_company_health_covers_every_ats(self):
        # gold source = the company's ATS type, e.g. phenom / icims / successfactors, not only workday / greenhouse
        self.sql("UPDATE app.jobs SET source = 'phenom' WHERE company_name = %s", [OTHER_COMPANY])
        rows = [r for r in self.read("companyHealth", uid=U_ADMIN, admin=True) if r["company"] == "zz fixture other co"]
        self.assertEqual([r["source"] for r in rows], ["phenom"])
