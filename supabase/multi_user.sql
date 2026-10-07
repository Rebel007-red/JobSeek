-- Multi-user setup: login, admin role, account cap, scraper company list.
-- The app's data (jobs, profiles, applied/hidden state) lives in schema app, created by app_schema.sql / app_api.sql
-- (python supabase/apply.py); it uses public.is_admin() from this file for admin-only actions and the allow-list bypass.
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- What it does:
--   1. public.is_admin(): true when the caller's JWT has app_metadata.role = 'admin'.
--   2. Row level security: companies and the legacy jobs table are admin-only for signed-in users;
--      user_skills / job_events (legacy) are closed to the browser. Scrapers use the service role key,
--      which bypasses RLS, so they keep working.
--   3. Caps the number of accounts at 50.
--   4. Marks the owner account as admin (edit the email below if it differs).
--
-- After step 4 the owner must sign out and sign in again so the new JWT carries the admin role.

BEGIN;

-- 1) Admin check used by the policies
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

-- 2) companies: admins manage sources from Settings; everyone else sees nothing
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companies_admin_all ON public.companies;
CREATE POLICY companies_admin_all ON public.companies
  FOR ALL TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

-- Legacy jobs table: only read by the admin company-health check in Settings
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jobs_admin_read ON public.jobs;
CREATE POLICY jobs_admin_read ON public.jobs
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- Other legacy tables: RLS on with no policies = no browser access (service role still works)
DO $$
BEGIN
  IF to_regclass('public.user_skills') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.user_skills ENABLE ROW LEVEL SECURITY';
  END IF;
  IF to_regclass('public.job_events') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.job_events ENABLE ROW LEVEL SECURITY';
  END IF;
END
$$;

-- 3) At most 50 accounts (invites beyond that fail)
CREATE OR REPLACE FUNCTION public.enforce_user_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (SELECT count(*) FROM auth.users) >= 50 THEN
    RAISE EXCEPTION 'JobSeeker supports at most 50 users';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_user_limit ON auth.users;
CREATE TRIGGER enforce_user_limit
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_user_limit();

-- 4) Owner = admin
UPDATE auth.users
SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role": "admin"}'::jsonb
WHERE lower(email) = lower('udaykirans.jobs@gmail.com');

COMMIT;

-- Check: should list the owner with role admin
-- SELECT email, raw_app_meta_data ->> 'role' AS role FROM auth.users ORDER BY created_at;
