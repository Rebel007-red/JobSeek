-- On-time scheduler: GitHub runs scheduled workflows on public repos best-effort (3-8 h late in practice), so Supabase's
-- pg_cron starts them through GitHub's workflow_dispatch API instead (pg_net makes the HTTP call).
-- Run once (idempotent): python supabase/apply.py --file scheduler.sql, or paste it into the Supabase SQL editor.
--
-- One manual step, done by the owner (the token never goes into this repo):
--   1. GitHub -> Settings -> Developer settings -> Fine-grained tokens -> Generate: repository Rebel007-red/JobSeek only,
--      permission "Actions: Read and write", an expiry you are happy to renew.
--   2. Supabase SQL editor:
--        SELECT vault.create_secret('<the token>', 'github_actions_token', 'JobSeeker: start GitHub workflows on time');
--      (to replace it later: SELECT vault.update_secret(id, '<new token>') FROM vault.secrets WHERE name = 'github_actions_token';)
-- Until the secret exists every call is a no-op with a NOTICE, and GitHub's own schedule stays the fallback.
--
-- Check that it works (status 204 = accepted):
--   SELECT id, status_code, created FROM net._http_response ORDER BY created DESC LIMIT 5;
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'jobseeker-%';

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Starts one of the allowed workflows on main. Returns the pg_net request id, or NULL when no token is stored.
CREATE OR REPLACE FUNCTION app.dispatch_github_workflow(p_workflow text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token text;
  v_request bigint;
BEGIN
  IF p_workflow NOT IN ('databricks-scrapers.yml', 'publish-supabase.yml') THEN
    RAISE EXCEPTION 'Unknown workflow: %', p_workflow USING ERRCODE = '22023';
  END IF;
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'github_actions_token' LIMIT 1;
  IF coalesce(v_token, '') = '' THEN
    RAISE NOTICE 'No github_actions_token in Vault: % not started (GitHub''s own schedule still runs it)', p_workflow;
    RETURN NULL;
  END IF;
  SELECT net.http_post(
    url := 'https://api.github.com/repos/Rebel007-red/JobSeek/actions/workflows/' || p_workflow || '/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'Content-Type', 'application/json',
      'User-Agent', 'jobseeker-scheduler'),
    timeout_milliseconds := 10000)
  INTO v_request;
  RETURN v_request;
END
$$;

REVOKE ALL ON FUNCTION app.dispatch_github_workflow(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION app.dispatch_github_workflow(text) FROM anon, authenticated';
  END IF;
END
$$;

-- Same times as the workflow's own cron (which stays as the fallback); scheduling an existing name updates it
SELECT cron.schedule('jobseeker-ats-scrapers', '7 0,6,12,18 * * *',
  $$SELECT app.dispatch_github_workflow('databricks-scrapers.yml')$$);
-- Catch-up publish for pipeline runs that outlast the ATS workflow's wait
SELECT cron.schedule('jobseeker-publish', '50 */2 * * *',
  $$SELECT app.dispatch_github_workflow('publish-supabase.yml')$$);
