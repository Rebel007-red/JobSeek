-- JobSeeker app data in Supabase Postgres (schema app). Applied by supabase/apply.py together with app_api.sql, in one
-- transaction. Idempotent: safe to re-run.
--
-- The browser never reads these tables directly: schema app is not exposed through PostgREST (do not add it to
-- "Exposed schemas"), no client role has USAGE on it, and every table has row level security on with no policies.
-- The only way in is the SECURITY DEFINER functions in app_api.sql:
--   public.app_read / public.app_write    signed-in users (supabase.rpc with the user's JWT)
--   public.pipeline_*                       service role only (GitHub Actions: sync_user_data.py, publish_to_supabase.py)
--
-- Jobs, skill stats, role similarity and the reference lists are copies of the Databricks gold/ops tables, published
-- from files in the Databricks volume (databricks/jobs/publish_to_supabase.py). User data (profiles, applied/hidden
-- state) lives only here and is exported to Databricks before every pipeline run (sync_user_data.py).

CREATE SCHEMA IF NOT EXISTS app;
COMMENT ON SCHEMA app IS 'JobSeeker app data; private (not exposed through PostgREST), reached only through public.app_* / public.pipeline_* functions';

-- Admin check (same definition as supabase/multi_user.sql; created here only when that script has not run yet)
DO $$
BEGIN
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    EXECUTE $f$
      CREATE FUNCTION public.is_admin()
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SET search_path = ''
      AS $b$ SELECT coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false); $b$
    $f$;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Jobs and pipeline outputs (written only by pipeline_publish / pipeline_publish_finish)
-- ---------------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.jobs (
  job_key text PRIMARY KEY CHECK (job_key ~ '^[0-9a-f]{64}$'),
  source text,
  company_name text,
  title text,
  location text,
  posted_date date,
  job_url text,
  seniority_level text,
  employment_type text,
  experience_min_years int,
  experience_max_years int,
  experience_level text,
  skills text[],
  skill_groups text[],
  category text,
  role_title text,
  role_score float8,
  role_alternative text,
  role_method text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  times_seen int,
  is_active boolean,
  description text,
  job_function text,
  industries text,
  skill_keys text[] NOT NULL DEFAULT '{}',
  row_hash text NOT NULL,
  published_run_id text,
  published_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.jobs IS 'Copy of Databricks gold.jobs (app columns), published by pipeline_publish; jobs a user tracks are kept after they leave gold';
COMMENT ON COLUMN app.jobs.skill_keys IS 'lower() of every skills and skill_groups element (skill matching in app.user_jobs)';
COMMENT ON COLUMN app.jobs.row_hash IS 'sha256 of the published row (publish file "h"); unchanged rows are not rewritten';
CREATE INDEX IF NOT EXISTS jobs_first_seen_at_idx ON app.jobs (first_seen_at);

-- Derived columns, computed in Postgres (trigger app.jobs_derive and app.refresh_job_derivations in app_api.sql); never
-- sent by the publisher and not part of row_hash. dup_group = md5(company_key || '|' || title_key): near-identical
-- postings (same employer, same title apart from city / req code noise) fold into one list row.
-- keep in sync: the work modes and employment kinds below with src/utils/gold.js WORK_MODE_LABELS / EMPLOYMENT_LABELS
ALTER TABLE app.jobs ADD COLUMN IF NOT EXISTS company_key text;
ALTER TABLE app.jobs ADD COLUMN IF NOT EXISTS title_key text;
ALTER TABLE app.jobs ADD COLUMN IF NOT EXISTS dup_group text CHECK (dup_group ~ '^[0-9a-f]{32}$');
ALTER TABLE app.jobs ADD COLUMN IF NOT EXISTS cities text[] NOT NULL DEFAULT '{}';
ALTER TABLE app.jobs ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE app.jobs ADD COLUMN IF NOT EXISTS work_mode text CHECK (work_mode IN ('remote', 'hybrid', 'onsite'));
ALTER TABLE app.jobs ADD COLUMN IF NOT EXISTS employment_kind text
  CHECK (employment_kind IN ('full_time', 'contract', 'internship', 'part_time', 'other'));
COMMENT ON COLUMN app.jobs.cities IS 'Cities (app.ref_cities names) the location names, in order of appearance; city = cities[1]';
COMMENT ON COLUMN app.jobs.work_mode IS 'remote / hybrid / onsite from the title, location and description; NULL = not stated';
CREATE INDEX IF NOT EXISTS jobs_dup_group_idx ON app.jobs (dup_group) WHERE dup_group IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.skill_stats (
  skill text PRIMARY KEY,
  jobs bigint,
  idf float8
);
COMMENT ON TABLE app.skill_stats IS 'Copy of ops.skill_stats: lower(skill or group) -> idf = ln(1 + active jobs / jobs listing it)';

CREATE TABLE IF NOT EXISTS app.role_similarity (
  role_a text,
  role_b text,
  sim float8,
  PRIMARY KEY (role_a, role_b)
);
COMMENT ON TABLE app.role_similarity IS 'Copy of ops.role_similarity (cosine similarity of role embeddings, both directions)';

CREATE TABLE IF NOT EXISTS app.ref_roles (
  role_title text PRIMARY KEY,
  category text,
  in_scope boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS app.ref_skills (
  skill text PRIMARY KEY,
  skill_group text,
  aliases text[]
);

CREATE TABLE IF NOT EXISTS app.ref_cities (
  alias text PRIMARY KEY,
  city text,
  state text
);
COMMENT ON TABLE app.ref_cities IS 'Copy of ops.ref_india_locations (every row, including state-only rows and India)';

-- app.ref_cities prepared for the derived job columns (one row, rebuilt by a statement trigger on app.ref_cities; see
-- app.rebuild_city_match in app_api.sql), so deriving a job does not re-read the list
CREATE TABLE IF NOT EXISTS app.city_match (
  id int PRIMARY KEY CHECK (id = 1),
  city_phrases text[] NOT NULL,
  city_phrase_names text[] NOT NULL,
  city_words text[] NOT NULL,
  city_word_names text[] NOT NULL,
  noise_phrases text[] NOT NULL,
  noise_words text[] NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.city_match IS 'app.ref_cities aliases, normalised: city phrases / words with their city (location_cities) and every alias as title noise (title_key)';

-- Roles / skills users typed that are not in the reference lists. Checked by the pipeline (03_enrich); the published
-- status is authoritative.
CREATE TABLE IF NOT EXISTS app.custom_roles (
  role_title text NOT NULL,
  status text CHECK (status IN ('pending', 'active', 'mapped', 'rejected')),
  category text,
  description text,
  duplicate_of text,
  first_user text,
  checked_by text,
  created_at timestamptz,
  checked_at timestamptz,
  attempts int
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_lower_title_key ON app.custom_roles (lower(role_title));

CREATE TABLE IF NOT EXISTS app.custom_skills (
  skill text NOT NULL,
  first_user text,
  created_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_skills_lower_skill_key ON app.custom_skills (lower(skill));

-- ---------------------------------------------------------------------------------------------------------------------
-- User data (written by app_write; exported to Databricks by pipeline_export_user_data)
-- ---------------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.user_profile (
  profile_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email text,
  target_roles text[] NOT NULL DEFAULT '{}',
  skills text[] NOT NULL DEFAULT '{}',
  min_years int,
  max_years int,
  preferred_cities text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Skills you also know (half weight), and mute rules: untracked jobs of these companies, with these words in the title
-- or at these levels are left out of the lists. Mute rules and notes stay in Supabase (never exported).
ALTER TABLE app.user_profile ADD COLUMN IF NOT EXISTS also_skills text[] NOT NULL DEFAULT '{}';
ALTER TABLE app.user_profile ADD COLUMN IF NOT EXISTS muted_companies text[] NOT NULL DEFAULT '{}';
ALTER TABLE app.user_profile ADD COLUMN IF NOT EXISTS muted_title_words text[] NOT NULL DEFAULT '{}';
ALTER TABLE app.user_profile ADD COLUMN IF NOT EXISTS muted_levels text[] NOT NULL DEFAULT '{}';

-- No foreign key to app.jobs: pipeline_publish_finish prunes state of jobs that left app.jobs itself and never deletes
-- a job someone tracks.
CREATE TABLE IF NOT EXISTS app.user_job_state (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  job_key text NOT NULL,
  is_applied boolean NOT NULL DEFAULT false,
  applied_at timestamptz,
  is_hidden boolean NOT NULL DEFAULT false,
  hidden_at timestamptz,
  application_status text NOT NULL DEFAULT 'not_applied',
  status_updated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, job_key)
);
-- "Tracked" = applied or any application status; such jobs are never deleted by a publish
CREATE INDEX IF NOT EXISTS user_job_state_tracked_job_key_idx ON app.user_job_state (job_key)
  WHERE is_applied OR application_status <> 'not_applied';
-- keep in sync: 2000 = src/utils/entries.js NOTE_MAX_LENGTH; the hide reasons = src/utils/gold.js HIDE_REASONS
ALTER TABLE app.user_job_state ADD COLUMN IF NOT EXISTS note text CHECK (note IS NULL OR char_length(note) <= 2000);
ALTER TABLE app.user_job_state ADD COLUMN IF NOT EXISTS next_action_at date;
ALTER TABLE app.user_job_state ADD COLUMN IF NOT EXISTS hide_reason text
  CHECK (hide_reason IS NULL OR hide_reason IN ('too_senior', 'wrong_role', 'company', 'location', 'duplicate', 'other'));
-- keep in sync: src/utils/gold.js APPLICATION_STATUSES. Added NOT VALID, then validated (no long lock on existing rows).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'app.user_job_state'::regclass AND conname = 'user_job_state_application_status_check') THEN
    ALTER TABLE app.user_job_state ADD CONSTRAINT user_job_state_application_status_check
      CHECK (application_status IN ('not_applied', 'saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn')) NOT VALID;
    ALTER TABLE app.user_job_state VALIDATE CONSTRAINT user_job_state_application_status_check;
  END IF;
END
$$;

-- Why a user hid a job (Too senior, Wrong role, ...), kept for later calibration of the fit rules. Not removed with the
-- job; rows older than 180 days are deleted by pipeline_publish_finish.
CREATE TABLE IF NOT EXISTS app.job_feedback (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  job_key text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('too_senior', 'wrong_role', 'company', 'location', 'duplicate', 'other')),
  title text,
  company_name text,
  role_title text,
  experience_level text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, job_key)
);

CREATE TABLE IF NOT EXISTS app.allowed_emails (
  email text PRIMARY KEY CHECK (email = lower(email)),
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid
);
COMMENT ON TABLE app.allowed_emails IS 'Who may use the job data (lower-case emails). Empty = every signed-in user. Admins always may.';

-- ---------------------------------------------------------------------------------------------------------------------
-- Publish bookkeeping
-- ---------------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.pipeline_status (
  id int PRIMARY KEY CHECK (id = 1),
  run_id text,
  snapshot_at timestamptz,
  published_at timestamptz,
  counts jsonb,
  manifest jsonb
);
INSERT INTO app.pipeline_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Staging for one publish: every key that should exist (with its hash) and the small tables, cleared by the finish
CREATE TABLE IF NOT EXISTS app.publish_keys (
  run_id text NOT NULL,
  job_key text NOT NULL,
  row_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, job_key)
);
ALTER TABLE app.publish_keys ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS app.publish_stage (
  run_id text NOT NULL,
  kind text NOT NULL,
  seq int NOT NULL,
  rows jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, kind, seq)
);

-- ---------------------------------------------------------------------------------------------------------------------
-- Run history for the admin System tab (written by pipeline_publish_finish / pipeline_record_runs /
-- pipeline_record_scrape; each keeps only its newest rows)
-- ---------------------------------------------------------------------------------------------------------------------

-- One row per applied publish (newest 50)
CREATE TABLE IF NOT EXISTS app.publish_history (
  run_id text PRIMARY KEY,
  snapshot_at timestamptz,
  published_at timestamptz NOT NULL,
  counts jsonb,
  upserted bigint,
  deleted_jobs bigint,
  kept_tracked bigint,
  pruned_state bigint
);

-- Databricks job runs from the Jobs API (publish_to_supabase.py record_runs; newest 50 by started_at)
CREATE TABLE IF NOT EXISTS app.pipeline_runs (
  run_id text PRIMARY KEY,
  started_at timestamptz,
  ended_at timestamptz,
  duration_s int,
  state text,
  result text,
  message text,
  trigger text,
  tasks jsonb NOT NULL DEFAULT '[]',
  recorded_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN app.pipeline_runs.tasks IS '[{task_key, state, result, started_at, duration_s}]';

-- One row per scraper run (record_scrape_report.py; newest 30 per source)
CREATE TABLE IF NOT EXISTS app.scrape_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('workday', 'greenhouse', 'linkedin')),
  github_run_id text,
  github_run_attempt int,
  workflow text,
  started_at timestamptz,
  finished_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'partial', 'failed', 'crashed')),
  companies int,
  failed int,
  jobs_scraped int,
  jobs_written int,
  missing_descriptions int,
  already_seen int,
  searches_total int,
  searches_cap int,
  dropped_searches text[] NOT NULL DEFAULT '{}',
  message text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT: a local run (no GitHub ids) re-recorded replaces its row instead of adding one
  UNIQUE NULLS NOT DISTINCT (source, github_run_id, github_run_attempt)
);

-- Latest scrape result per company (or LinkedIn search); rows not scraped for 30 days are deleted
CREATE TABLE IF NOT EXISTS app.scrape_companies (
  source text NOT NULL,
  company_lc text NOT NULL,
  company text NOT NULL,
  last_scraped_at timestamptz,
  last_ok_at timestamptz,
  jobs_found int,
  last_error text,
  failures int NOT NULL DEFAULT 0,
  PRIMARY KEY (source, company_lc)
);
COMMENT ON COLUMN app.scrape_companies.failures IS 'Consecutive failed scrapes (0 after a good one)';

-- ---------------------------------------------------------------------------------------------------------------------
-- Visits and activity (the "new since your last visit" marker and the admin Metrics card). Never exported.
-- ---------------------------------------------------------------------------------------------------------------------

-- When the user last looked at the job list (the throttled ping; "new since your last visit"). Never exported.
ALTER TABLE app.user_profile ADD COLUMN IF NOT EXISTS last_list_seen_at timestamptz;

-- The fit score at the moment a job became tracked (saved / applied), see app.record_triage "fit_at_action". NULL for
-- rows tracked before this column existed.
ALTER TABLE app.user_job_state ADD COLUMN IF NOT EXISTS fit_at_action smallint
  CHECK (fit_at_action IS NULL OR fit_at_action BETWEEN 0 AND 100);

-- Daily activity counters per user (UTC day, the day of the trend chart). Counters only: no job keys, URLs or search
-- text. Written by app_write (ping and the triage writes) and by pipeline_publish_finish (missed_strong); rows older
-- than 180 days are deleted by pipeline_publish_finish.
CREATE TABLE IF NOT EXISTS app.user_activity_day (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  day date NOT NULL,
  first_at timestamptz,           -- first ping or write of the day (NULL on a row only the publish wrote)
  last_at timestamptz,            -- last ping or write of the day
  visits int NOT NULL DEFAULT 0,  -- pings after 30+ minutes without activity (the first ping of a day counts)
  opened int NOT NULL DEFAULT 0,  -- job details opened (reported by the client with the next ping)
  saved int NOT NULL DEFAULT 0,   -- net saves this day (a same-day unsave takes one back)
  applied int NOT NULL DEFAULT 0, -- net applications this day
  hidden int NOT NULL DEFAULT 0,  -- net hides this day
  prompt_yes int NOT NULL DEFAULT 0,   -- "Did you apply?" answers (reported with the next ping)
  prompt_no int NOT NULL DEFAULT 0,
  prompt_saved int NOT NULL DEFAULT 0,
  acted_strong int NOT NULL DEFAULT 0,  -- untouched For-you jobs with fit 70+ that were saved, applied or hidden this day
  missed_strong int NOT NULL DEFAULT 0, -- untouched For-you jobs with fit 70+ deleted by a publish this day
  PRIMARY KEY (user_id, day),
  CHECK (visits >= 0 AND opened >= 0 AND saved >= 0 AND applied >= 0 AND hidden >= 0 AND prompt_yes >= 0
         AND prompt_no >= 0 AND prompt_saved >= 0 AND acted_strong >= 0 AND missed_strong >= 0)
);
COMMENT ON TABLE app.user_activity_day IS 'Daily activity counters per user and UTC day (counters only); rows older than 180 days are deleted by pipeline_publish_finish';

-- ---------------------------------------------------------------------------------------------------------------------
-- Privileges: nothing for client roles. Row level security on everywhere with no policies (defense in depth; the
-- table owner, which runs the SECURITY DEFINER functions, is not subject to it).
-- ---------------------------------------------------------------------------------------------------------------------

REVOKE ALL ON SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT c.oid::regclass AS name FROM pg_class c
           WHERE c.relnamespace = 'app'::regnamespace AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t.name);
  END LOOP;
END
$$;
