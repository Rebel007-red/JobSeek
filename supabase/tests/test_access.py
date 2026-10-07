"""Grants, sign-in, allow-list and admin checks."""
from base import EMAILS, U_ADMIN, U_MAIN, DbTestCase

PUBLIC_USER_FUNCTIONS = ["public.app_read(text, jsonb)", "public.app_write(text, jsonb)"]
SERVICE_FUNCTIONS = ["public.pipeline_export_user_data()", "public.pipeline_publish_state(boolean)",
                     "public.pipeline_publish(jsonb)", "public.pipeline_publish_finish(text, jsonb, boolean)",
                     "public.pipeline_record_scrape(jsonb)", "public.pipeline_record_runs(jsonb)"]
CLIENT_ROLES = ["anon", "authenticated", "service_role"]


class GrantsTest(DbTestCase):
    load_fixtures = False

    def can_execute(self, role, function):
        return self.value("SELECT has_function_privilege(%s, %s, 'EXECUTE')", [role, function])

    def test_user_functions_only_for_authenticated(self):
        for function in PUBLIC_USER_FUNCTIONS:
            self.assertTrue(self.can_execute("authenticated", function), function)
            self.assertFalse(self.can_execute("anon", function), function)
            self.assertFalse(self.can_execute("service_role", function), function)
            self.assertFalse(self.value("""SELECT coalesce(bool_or(a.grantee = 0), false)
                                           FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = %s::regprocedure""",
                                        [function]), f"{function} executable by PUBLIC")

    def test_service_functions_only_for_service_role(self):
        for function in SERVICE_FUNCTIONS:
            self.assertTrue(self.can_execute("service_role", function), function)
            self.assertFalse(self.can_execute("anon", function), function)
            self.assertFalse(self.can_execute("authenticated", function), function)

    def test_anon_cannot_call(self):
        with self.assertSqlError("permission denied for function app_read", "42501"):
            self.call("app_read", "status", {}, claims={"role": "anon"}, role="anon")
        with self.assertSqlError("permission denied for function pipeline_export_user_data", "42501"):
            self.call("pipeline_export_user_data", claims=self.claims(U_MAIN))

    def test_schema_app_is_private(self):
        for role in CLIENT_ROLES:
            self.assertFalse(self.value("SELECT has_schema_privilege(%s, 'app', 'USAGE')", [role]), role)
        tables = [r[0] for r in self.rows("SELECT c.oid::regclass::text FROM pg_class c WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'r'")]
        self.assertGreaterEqual(len(tables), 14)
        for table in tables:
            self.assertTrue(self.value("SELECT relrowsecurity FROM pg_class WHERE oid = %s::regclass", [table]), table)
            for role in CLIENT_ROLES:
                for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                    self.assertFalse(self.value("SELECT has_table_privilege(%s, %s, %s)", [role, table, privilege]),
                                     f"{role} {privilege} {table}")
        internal = self.rows("""SELECT p.oid::regprocedure::text FROM pg_proc p
                                WHERE p.pronamespace = 'app'::regnamespace""")
        self.assertGreater(len(internal), 20)
        for (function,) in internal:
            for role in CLIENT_ROLES:
                self.assertFalse(self.can_execute(role, function), f"{role} {function}")

    def test_authenticated_cannot_read_tables_directly(self):
        with self.assertSqlError("permission denied for schema app", "42501"):
            with self.conn.transaction():
                self.sql("SET LOCAL ROLE authenticated")
                try:
                    self.sql("SELECT count(*) FROM app.jobs")
                except Exception as error:
                    from base import SqlError
                    failure = SqlError(error.diag.message_primary)
                    failure.sqlstate = error.sqlstate
                    raise failure from None

    def test_definer_functions_pin_search_path(self):
        rows = self.rows("""SELECT p.oid::regprocedure::text, p.prosecdef, p.proconfig FROM pg_proc p
                            WHERE p.oid = ANY(%s::regprocedure[])""", [PUBLIC_USER_FUNCTIONS + SERVICE_FUNCTIONS])
        self.assertEqual(len(rows), len(PUBLIC_USER_FUNCTIONS + SERVICE_FUNCTIONS))
        for function, definer, config in rows:
            self.assertTrue(definer, function)
            self.assertIn('search_path=""', config, function)
            self.assertIn("TimeZone=UTC", config, function)


class CallerTest(DbTestCase):
    def test_sign_in_required(self):
        with self.assertSqlError("Sign in required", "28000"):
            self.call("app_read", "status", {}, claims=None)
        with self.assertSqlError("Sign in required", "28000"):
            self.call("app_write", "restoreHidden", {}, claims={"role": "authenticated"})

    def test_empty_allow_list_allows_everyone(self):
        # Rolled back with the test like everything else
        self.sql("DELETE FROM app.allowed_emails WHERE true")
        self.assertEqual(len(self.read("status")), 1)

    def test_allow_list(self):
        self.sql("INSERT INTO app.allowed_emails (email) VALUES (%s) ON CONFLICT DO NOTHING", [EMAILS[U_MAIN]])
        self.assertEqual(len(self.read("status")), 1)
        self.assertEqual(len(self.read("status", email=EMAILS[U_MAIN].upper())), 1)  # case does not matter
        with self.assertSqlError("This account is not allowed to use the job data", "42501"):
            self.read("status", email="fixture.stranger@jobseeker.test")
        with self.assertSqlError("This account is not allowed to use the job data", "42501"):
            self.write("restoreHidden", email="")
        # admins always may
        self.assertEqual(len(self.read("status", uid=U_ADMIN, email="fixture.stranger@jobseeker.test", admin=True)), 1)

    def test_admin_only_actions(self):
        for action in ("allowedEmails", "companyHealth", "systemStatus"):
            with self.assertSqlError("Admins only", "42501"):
                self.read(action)
            self.assertIsInstance(self.read(action, uid=U_ADMIN, admin=True), list)
        with self.assertSqlError("Admins only", "42501"):
            self.write("setAllowedEmail", {"email": "a@b.co", "allowed": True})

    def test_unknown_actions(self):
        with self.assertSqlError("Unknown action: nope"):
            self.read("nope")
        with self.assertSqlError("Unknown action: " + "x" * 40):
            self.read("x" * 50)
        with self.assertSqlError("Unknown action: undefined"):
            self.read(None)
        with self.assertSqlError("Unknown action: setApplied"):
            self.read("setApplied")  # writes go through app_write
        with self.assertSqlError("Unknown action: jobs"):
            self.write("jobs")

    def test_service_role_only(self):
        with self.assertSqlError("Service role only", "42501"):
            self.call("pipeline_publish_state", False, claims=self.claims(U_MAIN), role="service_role")
        for function, arg in (("pipeline_record_scrape", {}), ("pipeline_record_runs", {"runs": []})):
            with self.assertSqlError("Service role only", "42501"):
                self.call(function, arg, claims=self.claims(U_MAIN), role="service_role")
