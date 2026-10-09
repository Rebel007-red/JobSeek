-- JobSeeker RPC API on schema app (see app_schema.sql). Applied by supabase/apply.py after app_schema.sql, in one
-- transaction. Idempotent: safe to re-run.
--
--   public.app_read(action, params)    signed-in users: jobs, summary, trend, facets, job, jobRow, jobGroup, jobNote,
--                                      trackedJobs, hiddenJobs, profile, refs, status; admins also allowedEmails,
--                                      companyHealth, systemStatus, metrics
--   public.app_write(action, params)   signed-in users: setApplied, setStatus, setHidden, setNote, restoreHidden,
--                                      saveProfile, saveMuteRules, ping; admins also setAllowedEmail
--   public.pipeline_*                  service role only (GitHub Actions)
-- Trust release additions (every older action, parameter and returned key keeps its meaning):
--   jobs     tab 'inbox' (untracked jobs only; 'pending' and 'all' still work), expiring: true (the Expiring tonight
--            list: untracked For-you jobs on their last day, at most c_expiring_max() rows), sort 'expiring'
--   summary  since (ISO timestamp) and the keys inbox, inbox_strong, new_since, expiring, expiring_strong, triaged_today
--   setNote  a key left out of params (note, nextActionAt) keeps the stored value; an explicit null still clears it
--   ping     {opened?, promptYes?, promptNo?, promptSaved?}: last_list_seen_at and today's activity counters
--   metrics  admin: aggregates of app.user_activity_day and app.user_job_state (8 ISO weeks and guardrails)
-- The triage writes (setApplied, setStatus, setHidden, setNote, restoreHidden) also keep app.user_activity_day and
-- user_job_state.fit_at_action current (app.record_triage).
-- Every call returns {"rows": [...]}. Errors are raised with a readable message (PostgREST error.message):
-- 28000 sign in required, 42501 not allowed / admins only / service role only, 22023 invalid input.
--
-- Fit scoring (app.user_jobs) is a port of USER_JOBS_CTE from the former Netlify Function
-- (netlify/functions/api/sql.mjs, frozen in supabase/tests/spark_reference/). Spark type rules are reproduced:
-- float8 = Spark DOUBLE, numeric = Spark DECIMAL literals, so scores match the Databricks results exactly
-- (supabase/tests/parity.py checks this against Databricks).

-- =====================================================================================================================
-- Constants. Each value lives only here. src/utils/sql_constants.test.js reads this file and compares the values with
-- src/utils/gold.js and src/utils/entries.js.
-- =====================================================================================================================

-- keep in sync: src/utils/gold.js FIT_WEIGHTS.role
CREATE OR REPLACE FUNCTION app.c_fit_weight_role() RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 0.4::float8 $$;
-- keep in sync: src/utils/gold.js FIT_WEIGHTS.skills
CREATE OR REPLACE FUNCTION app.c_fit_weight_skills() RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 0.45::float8 $$;
-- keep in sync: src/utils/gold.js FIT_WEIGHTS.experience (numeric: Spark multiplies two DECIMALs here)
CREATE OR REPLACE FUNCTION app.c_fit_weight_experience() RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 0.15::numeric $$;
-- keep in sync: src/utils/gold.js MATCH_MIN_FIT ("For you" needs at least this fit)
CREATE OR REPLACE FUNCTION app.c_match_min_fit() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 60 $$;
-- keep in sync: src/utils/gold.js STRONG_FIT (summary strong_fit count)
CREATE OR REPLACE FUNCTION app.c_strong_fit() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 70 $$;
-- Related roles: the role part rises from 0 at ROLE_SIM_FLOOR to ROLE_SIM_SCORE at ROLE_SIM_MATCH (= FLOOR + SPAN);
-- ROLE_SIM_MATCH and up counts as a role match. Calibrated against judged jobs (see the git history of sql.mjs).
-- keep in sync: ROLE_SIM_FLOOR (pinned in src/utils/sql_constants.test.js)
CREATE OR REPLACE FUNCTION app.c_role_sim_floor() RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 0.75::float8 $$;
-- keep in sync: ROLE_SIM_MATCH (pinned in src/utils/sql_constants.test.js)
CREATE OR REPLACE FUNCTION app.c_role_sim_match() RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 0.86::float8 $$;
-- keep in sync: ROLE_SIM_SPAN = ROLE_SIM_MATCH - ROLE_SIM_FLOOR (pinned in src/utils/sql_constants.test.js)
CREATE OR REPLACE FUNCTION app.c_role_sim_span() RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 0.11::float8 $$;
-- keep in sync: ROLE_SIM_SCORE (numeric: a DECIMAL factor in Spark)
CREATE OR REPLACE FUNCTION app.c_role_sim_score() RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 0.85::numeric $$;
-- keep in sync: NEUTRAL_SKILLS (skill part of a job with no skills found)
CREATE OR REPLACE FUNCTION app.c_neutral_skills() RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 0.3::float8 $$;
-- keep in sync: UNSEEN_SKILL_IDF (rarity of a skill no job lists)
CREATE OR REPLACE FUNCTION app.c_unseen_skill_idf() RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 3::float8 $$;
-- keep in sync: EXPERIENCE_HIDE_GAP (jobs asking this many years above your maximum stay out of "For you")
CREATE OR REPLACE FUNCTION app.c_experience_hide_gap() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 2 $$;
-- keep in sync: src/utils/entries.js PROFILE_LIMITS.roles
CREATE OR REPLACE FUNCTION app.c_max_roles() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 2 $$;
-- keep in sync: src/utils/entries.js PROFILE_LIMITS.skills
CREATE OR REPLACE FUNCTION app.c_max_skills() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 5 $$;
-- keep in sync: src/utils/entries.js PROFILE_LIMITS.cities
CREATE OR REPLACE FUNCTION app.c_max_cities() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 3 $$;
-- keep in sync: src/utils/entries.js ENTRY_MAX_LENGTH
CREATE OR REPLACE FUNCTION app.c_entry_max_length() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 60 $$;
-- keep in sync: src/utils/entries.js ENTRY_RE
CREATE OR REPLACE FUNCTION app.c_entry_re() RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT '^[A-Za-z0-9.][A-Za-z0-9 .+#&/()-]*$'::text $$;
-- keep in sync: CITY_RE (sql.mjs; pinned in src/utils/sql_constants.test.js)
CREATE OR REPLACE FUNCTION app.c_city_re() RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT '^[A-Za-z][A-Za-z .-]*$'::text $$;
-- keep in sync: src/utils/entries.js VAGUE
CREATE OR REPLACE FUNCTION app.c_vague_words() RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ARRAY[
  'communication', 'communication skills', 'teamwork', 'team player', 'leadership', 'problem solving', 'management',
  'analytics', 'hard working', 'english', 'ms office', 'microsoft office', 'computer', 'computers', 'it', 'software',
  'engineering', 'engineer', 'developer', 'job', 'jobs', 'fresher', 'any', 'none', 'na', 'n/a'
]::text[] $$;
-- keep in sync: MAX_PAGE_SIZE (pinned in src/utils/sql_constants.test.js)
CREATE OR REPLACE FUNCTION app.c_max_page_size() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 100 $$;
-- keep in sync: default page size of the jobs action (pinned in src/utils/sql_constants.test.js)
CREATE OR REPLACE FUNCTION app.c_default_page_size() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 48 $$;
-- keep in sync: src/utils/gold.js APPLICATION_STATUSES (and the CHECK on app.user_job_state.application_status)
CREATE OR REPLACE FUNCTION app.c_application_statuses() RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ARRAY[
  'not_applied', 'saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'
]::text[] $$;
-- keep in sync: src/utils/gold.js APPLIED_STATUSES (statuses that count as applied: is_applied)
CREATE OR REPLACE FUNCTION app.c_applied_statuses() RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ARRAY[
  'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'
]::text[] $$;
-- keep in sync: src/utils/gold.js HIDE_REASONS (and the CHECKs in app_schema.sql)
CREATE OR REPLACE FUNCTION app.c_hide_reasons() RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ARRAY[
  'too_senior', 'wrong_role', 'company', 'location', 'duplicate', 'other'
]::text[] $$;
-- keep in sync: src/utils/gold.js LEVEL_YEARS (keys, same order; the years are the CASE in app.user_jobs)
CREATE OR REPLACE FUNCTION app.c_experience_levels() RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ARRAY[
  'Intern', 'Entry', 'Junior', 'Mid', 'Mid-Senior', 'Senior', 'Lead/Manager', 'Principal/Staff', 'Director+'
]::text[] $$;
-- keep in sync: src/utils/gold.js WORK_MODE_LABELS (without 'unknown' = NULL)
CREATE OR REPLACE FUNCTION app.c_work_modes() RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ARRAY[
  'remote', 'hybrid', 'onsite'
]::text[] $$;
-- keep in sync: src/utils/gold.js EMPLOYMENT_LABELS (without 'unknown' = NULL)
CREATE OR REPLACE FUNCTION app.c_employment_kinds() RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ARRAY[
  'full_time', 'contract', 'internship', 'part_time', 'other'
]::text[] $$;
-- keep in sync: src/utils/entries.js PROFILE_LIMITS.alsoSkills
CREATE OR REPLACE FUNCTION app.c_max_also_skills() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 10 $$;
-- keep in sync: src/utils/gold.js ALSO_SKILL_WEIGHT (an also-know skill counts this much of a core skill)
CREATE OR REPLACE FUNCTION app.c_also_skill_weight() RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 0.5::float8 $$;
-- keep in sync: src/utils/gold.js FOLLOW_UP_DAYS (applied with no status change for this long: "Follow up")
CREATE OR REPLACE FUNCTION app.c_follow_up_days() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 14 $$;
-- keep in sync: src/utils/entries.js NOTE_MAX_LENGTH (and the CHECK on app.user_job_state.note)
CREATE OR REPLACE FUNCTION app.c_note_max_length() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 2000 $$;
-- keep in sync: src/utils/entries.js MUTE_LIMITS.companies
CREATE OR REPLACE FUNCTION app.c_max_muted_companies() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 50 $$;
-- keep in sync: src/utils/entries.js MUTE_LIMITS.titleWords
CREATE OR REPLACE FUNCTION app.c_max_muted_title_words() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 30 $$;
-- keep in sync: muted title words (pinned in src/utils/sql_constants.test.js)
CREATE OR REPLACE FUNCTION app.c_mute_word_re() RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT '^[A-Za-z0-9][A-Za-z0-9 .+#&/-]*$'::text $$;
-- keep in sync: most jobs per bulk write (src/lib/api.js sends larger selections in chunks of this size)
CREATE OR REPLACE FUNCTION app.c_max_bulk_keys() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 100 $$;
-- keep in sync: src/utils/job.js JOB_DELETE_AFTER_DAYS (an untracked job is deleted at the first publish on or after UTC
-- midnight of its job date + this + 1 days, so from job date + this days on it is "expiring")
CREATE OR REPLACE FUNCTION app.c_job_delete_after_days() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 2 $$;
-- keep in sync: most rows of the expiring list (the Expiring tonight strip; pinned in src/utils/sql_constants.test.js)
CREATE OR REPLACE FUNCTION app.c_expiring_max() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 10 $$;
-- keep in sync: src/hooks/useVisit.js VISIT_GAP_MS (a ping after this many minutes without activity is a new visit)
CREATE OR REPLACE FUNCTION app.c_visit_gap_minutes() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 30 $$;
-- keep in sync: days of app.user_activity_day kept (pinned in src/utils/sql_constants.test.js)
CREATE OR REPLACE FUNCTION app.c_activity_keep_days() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 180 $$;
-- keep in sync: largest counter one ping may add (pinned in src/utils/sql_constants.test.js)
CREATE OR REPLACE FUNCTION app.c_max_ping_count() RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 500 $$;

-- =====================================================================================================================
-- Small helpers
-- =====================================================================================================================

CREATE OR REPLACE FUNCTION app.fail(p_message text, p_code text DEFAULT '22023') RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  RAISE EXCEPTION USING MESSAGE = p_message, ERRCODE = p_code;
END
$$;

-- JavaScript String.prototype.trim(): the ECMAScript white space and line terminators (locale independent)
CREATE OR REPLACE FUNCTION app.js_trim(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(p,
    '^[\t\n\v\f\r    -     　﻿]+|[\t\n\v\f\r    -     　﻿]+$',
    '', 'g')
$$;

-- sql.mjs text(value, max): a JSON string trimmed and cut to max characters; anything else ''
CREATE OR REPLACE FUNCTION app.js_text(v jsonb, max_len int) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'string' THEN left(app.js_trim(v #>> '{}'), max_len) ELSE '' END
$$;

-- sql.mjs int(value, min, max): null / missing / "" -> NULL; Number(value) truncated and clamped; not a finite number -> NULL
CREATE OR REPLACE FUNCTION app.js_int(v jsonb, lo int, hi int) RETURNS int
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  t text;
  n numeric;
BEGIN
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  CASE jsonb_typeof(v)
    WHEN 'number' THEN
      n := (v #>> '{}')::numeric;
    WHEN 'boolean' THEN
      n := CASE WHEN v = 'true'::jsonb THEN 1 ELSE 0 END;
    WHEN 'string' THEN
      t := v #>> '{}';
      IF t = '' THEN
        RETURN NULL;
      END IF;
      t := app.js_trim(t);
      IF t = '' THEN
        n := 0; -- Number('  ') is 0
      ELSIF t ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$' THEN
        BEGIN
          n := t::numeric;
        EXCEPTION WHEN others THEN
          RETURN NULL; -- out of range: Infinity in JavaScript
        END;
      ELSE
        RETURN NULL;
      END IF;
    ELSE
      RETURN NULL;
  END CASE;
  RETURN greatest(lo::numeric, least(hi::numeric, trunc(n)))::int;
END
$$;

-- sql.mjs jobKey(): a 64-character lower-case hex string
CREATE OR REPLACE FUNCTION app.req_job_key(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING MESSAGE = 'Invalid job key', ERRCODE = '22023';
  END IF;
  RETURN v #>> '{}';
END
$$;

-- sql.mjs bool(): JSON true or false only
CREATE OR REPLACE FUNCTION app.req_bool(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'boolean' THEN
    RAISE EXCEPTION USING MESSAGE = 'Expected true or false', ERRCODE = '22023';
  END IF;
  RETURN v = 'true'::jsonb;
END
$$;

-- The jobs a write acts on: params.jobKeys (a list of 1-100 keys; duplicates ignored) or else params.jobKey
CREATE OR REPLACE FUNCTION app.req_job_keys(p jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v jsonb := nullif(p -> 'jobKeys', 'null'::jsonb);
BEGIN
  IF v IS NULL THEN
    RETURN ARRAY[app.req_job_key(p -> 'jobKey')];
  END IF;
  IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) NOT BETWEEN 1 AND app.c_max_bulk_keys() THEN
    RAISE EXCEPTION USING MESSAGE = format('Pick between 1 and %s jobs', app.c_max_bulk_keys()), ERRCODE = '22023';
  END IF;
  RETURN ARRAY(SELECT DISTINCT app.req_job_key(e.k) FROM jsonb_array_elements(v) AS e(k));
END
$$;

-- A regular expression matching the text literally (every character other than a-z, 0-9 and space escaped)
CREATE OR REPLACE FUNCTION app.regex_literal(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(p, '([^a-z0-9 ])', '\\\1', 'gi')
$$;

-- Round half up of a non-negative double, as Spark round() does (HALF_UP on the decimal form of the double). A double
-- whose decimal form ends in .5 is exactly k.5, and any other double rounds on the same side as its decimal form, so
-- this is exact and does not depend on extra_float_digits (unlike a float8::text cast; float8::numeric keeps only 15
-- digits and must not be used).
CREATE OR REPLACE FUNCTION app.round_half_up(x float8) RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (floor(x) + CASE WHEN x - floor(x) >= 0.5::float8 THEN 1 ELSE 0 END)::int
$$;

CREATE OR REPLACE FUNCTION app.ts_text(ts timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- A timestamp from a JSON string, NULL when missing or not a timestamp. STABLE: a string without an offset is read in
-- the session time zone (UTC in the pipeline_* functions).
CREATE OR REPLACE FUNCTION app.js_timestamp(v jsonb) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR (v #>> '{}') !~ '^\d{4}-\d\d-\d\d' THEN
    RETURN NULL;
  END IF;
  RETURN (v #>> '{}')::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION app.json_text_array(v jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(v)) END
$$;

-- =====================================================================================================================
-- Caller checks
-- =====================================================================================================================

-- The signed-in caller (JWT), after the allow-list check. Admins (app_metadata.role = 'admin') bypass the allow-list.
CREATE OR REPLACE FUNCTION app.require_caller(OUT caller_uid uuid, OUT caller_email text, OUT caller_is_admin boolean)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  caller_uid := auth.uid();
  IF caller_uid IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'Sign in required', ERRCODE = '28000';
  END IF;
  caller_email := nullif(lower(auth.jwt() ->> 'email'), '');
  caller_is_admin := coalesce(public.is_admin(), false);
  IF NOT caller_is_admin
     AND EXISTS (SELECT 1 FROM app.allowed_emails)
     AND (caller_email IS NULL OR NOT EXISTS (SELECT 1 FROM app.allowed_emails a WHERE a.email = caller_email)) THEN
    RAISE EXCEPTION USING MESSAGE = 'This account is not allowed to use the job data', ERRCODE = '42501';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION app.require_service() RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF coalesce(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION USING MESSAGE = 'Service role only', ERRCODE = '42501';
  END IF;
END
$$;

-- =====================================================================================================================
-- Input validation (port of sql.mjs stringList / validateProfile and src/utils/entries.js entryProblem)
-- =====================================================================================================================

CREATE OR REPLACE FUNCTION app.string_list(v jsonb, max_items int, max_len int, label text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  el jsonb;
  item text;
  seen text[] := '{}';
  items text[] := '{}';
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'array' THEN
    RAISE EXCEPTION USING MESSAGE = label || ' must be a list', ERRCODE = '22023';
  END IF;
  FOR el IN SELECT e.value FROM jsonb_array_elements(v) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord LOOP
    item := app.js_text(el, max_len + 1);
    CONTINUE WHEN item = '';
    IF char_length(item) > max_len THEN
      RAISE EXCEPTION USING MESSAGE = format('%s: "%s…" is longer than %s characters', label, left(item, 20), max_len),
        ERRCODE = '22023';
    END IF;
    -- Already over the limit: the only outcome left is "longer than" (checked above) or "at most", so stop collecting
    -- (a huge list would otherwise cost O(n^2) here)
    CONTINUE WHEN cardinality(items) > max_items;
    CONTINUE WHEN lower(item) = ANY (seen);
    seen := seen || lower(item);
    items := items || item;
  END LOOP;
  IF cardinality(items) > max_items THEN
    RAISE EXCEPTION USING MESSAGE = format('%s: at most %s items', label, max_items), ERRCODE = '22023';
  END IF;
  RETURN items;
END
$$;

-- '' when the entry is fine, otherwise a short reason (src/utils/entries.js entryProblem)
CREATE OR REPLACE FUNCTION app.entry_problem(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN char_length(t) < 2 THEN 'Too short'
    WHEN char_length(t) > app.c_entry_max_length() THEN format('At most %s characters', app.c_entry_max_length())
    WHEN t !~ app.c_entry_re() OR t !~ '[A-Za-z]' THEN 'Use letters, numbers, spaces and . + # & / ( ) - only'
    WHEN lower(t) = ANY (app.c_vague_words()) THEN format('"%s" is too general to match jobs on', t)
    ELSE ''
  END
  FROM (SELECT app.js_trim(coalesce(p, '')) AS t) s
$$;

-- =====================================================================================================================
-- Derived job columns (app.jobs company_key, title_key, dup_group, cities, city, work_mode, employment_kind). Computed
-- here instead of in the gold step: trigger app.jobs_derive on every published row, app.refresh_job_derivations after
-- pipeline_publish_finish replaces app.ref_cities, and a backfill at the end of this file. The word rules are plpgsql
-- loops over a handful of words with simple expressions only (no query per job), which is much faster than large
-- regular expression alternations.
-- =====================================================================================================================

-- Employer name for duplicate detection: lower case, legal-form and filler words dropped, a plural ending of the last
-- word (5+ characters, not "ss") dropped ("Barclays" = "Barclay"), a few well-known long names shortened.
-- '' when nothing is left ("India").
CREATE OR REPLACE FUNCTION app.company_key(p_name text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  w text;
  words text[] := '{}';
  k text;
  n int;
BEGIN
  FOREACH w IN ARRAY string_to_array(btrim(regexp_replace(replace(lower(coalesce(p_name, '')), '&', ' and '), '[^a-z0-9]+', ' ', 'g')), ' ') LOOP
    CONTINUE WHEN w = '' OR w = ANY ('{pvt,private,ltd,limited,inc,incorporated,llp,llc,plc,corp,corporation,co,company,the,india,in,gmbh,ag,sa,bv,pte}'::text[]);
    words := words || w;
  END LOOP;
  n := cardinality(words);
  IF n > 0 AND char_length(words[n]) >= 5 AND words[n] LIKE '%s' AND words[n] NOT LIKE '%ss' THEN
    words[n] := left(words[n], -1);
  END IF;
  k := array_to_string(words, ' ');
  RETURN CASE k
    WHEN 'hewlett packard enterprise' THEN 'hpe'
    WHEN 'pricewaterhousecoopers' THEN 'pwc'
    WHEN 'pricewaterhousecooper' THEN 'pwc' -- the plural ending is dropped before the names are compared
    WHEN 'ernst and young' THEN 'ey'
    WHEN 'tata consultancy service' THEN 'tcs'
    WHEN 'international business machine' THEN 'ibm'
    ELSE k
  END;
END
$$;

-- Rebuilds app.city_match from app.ref_cities (statement trigger on app.ref_cities): aliases normalised like the text
-- they are matched in (a-z, 0-9, single spaces); city phrases (several words, longest first) and city words with their
-- city, state-only rows and India left out; every alias (states included) as title noise
CREATE OR REPLACE FUNCTION app.rebuild_city_match() RETURNS void
LANGUAGE sql VOLATILE AS $$
  WITH n AS (
    SELECT DISTINCT ON (x.alias) x.alias, x.city
    FROM (SELECT btrim(regexp_replace(lower(l.alias), '[^a-z0-9]+', ' ', 'g')) AS alias, l.city
          FROM app.ref_cities l WHERE l.city IS NOT NULL AND l.city <> 'India') x
    WHERE x.alias <> ''
    ORDER BY x.alias, x.city COLLATE "C"
  ),
  noise AS (
    SELECT DISTINCT btrim(regexp_replace(lower(l.alias), '[^a-z0-9]+', ' ', 'g')) AS alias FROM app.ref_cities l
  )
  INSERT INTO app.city_match AS m (id, city_phrases, city_phrase_names, city_words, city_word_names, noise_phrases,
                                   noise_words, built_at)
  SELECT 1,
    coalesce((SELECT array_agg(n.alias ORDER BY char_length(n.alias) DESC, n.alias COLLATE "C") FROM n WHERE n.alias LIKE '% %'), '{}'),
    coalesce((SELECT array_agg(n.city ORDER BY char_length(n.alias) DESC, n.alias COLLATE "C") FROM n WHERE n.alias LIKE '% %'), '{}'),
    coalesce((SELECT array_agg(n.alias ORDER BY n.alias COLLATE "C") FROM n WHERE n.alias NOT LIKE '% %'), '{}'),
    coalesce((SELECT array_agg(n.city ORDER BY n.alias COLLATE "C") FROM n WHERE n.alias NOT LIKE '% %'), '{}'),
    coalesce((SELECT array_agg(x.alias ORDER BY char_length(x.alias) DESC, x.alias COLLATE "C") FROM noise x WHERE x.alias LIKE '% %'), '{}'),
    coalesce((SELECT array_agg(x.alias ORDER BY x.alias COLLATE "C") FROM noise x WHERE x.alias <> '' AND x.alias NOT LIKE '% %'), '{}'),
    now()
  ON CONFLICT (id) DO UPDATE SET
    city_phrases = EXCLUDED.city_phrases, city_phrase_names = EXCLUDED.city_phrase_names, city_words = EXCLUDED.city_words,
    city_word_names = EXCLUDED.city_word_names, noise_phrases = EXCLUDED.noise_phrases, noise_words = EXCLUDED.noise_words,
    built_at = EXCLUDED.built_at
$$;

CREATE OR REPLACE FUNCTION app.ref_cities_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.rebuild_city_match();
  RETURN NULL;
END
$$;

-- Cities a location names, in order of appearance ("Greater Bengaluru Area" -> {Bengaluru}). City phrases are found
-- first, longest first, and replaced by a marker word, so a shorter alias inside a longer one ("mumbai" in
-- "navi mumbai") does not match again; then every word is looked up.
CREATE OR REPLACE FUNCTION app.location_cities_with(p_location text, p_phrases text[], p_phrase_cities text[],
                                                    p_words text[], p_word_cities text[]) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  l text;
  w text;
  i int;
  city text;
  found text[] := '{}';
BEGIN
  IF p_location IS NULL THEN
    RETURN found;
  END IF;
  l := ' ' || regexp_replace(lower(p_location), '[^a-z0-9]+', ' ', 'g') || ' ';
  FOR i IN 1 .. coalesce(cardinality(p_phrases), 0) LOOP
    WHILE strpos(l, ' ' || p_phrases[i] || ' ') > 0 LOOP
      l := replace(l, ' ' || p_phrases[i] || ' ', ' #' || i || ' ');
    END LOOP;
  END LOOP;
  FOREACH w IN ARRAY string_to_array(btrim(l), ' ') LOOP
    CONTINUE WHEN w = '';
    city := CASE WHEN w LIKE '#%' THEN p_phrase_cities[substr(w, 2)::int] ELSE p_word_cities[array_position(p_words, w)] END;
    IF city IS NOT NULL AND NOT city = ANY (found) THEN
      found := found || city;
    END IF;
  END LOOP;
  RETURN found;
END
$$;

CREATE OR REPLACE FUNCTION app.location_cities(p_location text) RETURNS text[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce((SELECT app.location_cities_with(p_location, m.city_phrases, m.city_phrase_names, m.city_words, m.city_word_names)
                   FROM app.city_match m WHERE m.id = 1), '{}'::text[])
$$;

-- Job title for duplicate detection: lower case, city names (phrases and words), work-mode and hiring filler words,
-- numbers and requisition codes (a word with 3+ digits) dropped. "Data Engineer - Pune" and "Data Engineer, Bangalore"
-- -> "data engineer".
CREATE OR REPLACE FUNCTION app.title_key_with(p_title text, p_phrases text[], p_words text[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  t text := ' ' || regexp_replace(replace(lower(coalesce(p_title, '')), '&', ' and '), '[^a-z0-9+#]+', ' ', 'g') || ' ';
  a text;
  w text;
  words text[] := '{}';
BEGIN
  FOREACH a IN ARRAY coalesce(p_phrases, '{}'::text[]) LOOP
    WHILE strpos(t, ' ' || a || ' ') > 0 LOOP
      t := replace(t, ' ' || a || ' ', ' ');
    END LOOP;
  END LOOP;
  FOREACH w IN ARRAY string_to_array(btrim(t), ' ') LOOP
    CONTINUE WHEN w = '' OR w ~ '^[0-9]+$' OR w ~ '[0-9].*[0-9].*[0-9]'
      OR w = ANY ('{remote,hybrid,onsite,wfh,india,urgent,urgently,hiring,immediate,immediately,joiner,joiners,opening,openings,vacancy,job,jobs,opportunity}'::text[])
      OR w = ANY (p_words);
    words := words || w;
  END LOOP;
  RETURN array_to_string(words, ' ');
END
$$;

CREATE OR REPLACE FUNCTION app.title_key(p_title text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app.title_key_with(p_title, (SELECT m.noise_phrases FROM app.city_match m WHERE m.id = 1),
                            (SELECT m.noise_words FROM app.city_match m WHERE m.id = 1))
$$;

CREATE OR REPLACE FUNCTION app.dup_group(p_company_key text, p_title_key text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_company_key <> '' AND p_title_key <> '' THEN md5(p_company_key || '|' || p_title_key) END
$$;

-- remote / hybrid / onsite, first rule that matches: the title or location says it, then a labelled field or a part-week
-- office rule, then the description says it in so many words. Benefit boilerplate ("opportunities to work from home",
-- "remote work options", "onsite and offshore delivery", "an on-site eatery") says nothing, and neither does a bare
-- "remote" ("remote teams"): checked by hand against the 1,474 published postings (2026-10-07), where the earlier,
-- looser rules mislabelled about a third of the remote and onsite rows. NULL = not stated.
CREATE OR REPLACE FUNCTION app.work_mode(p_title text, p_location text, p_description text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    -- the title or location says so
    WHEN s.t ~* '\mhybrid\M' THEN 'hybrid'
    WHEN s.t ~* '\m(remote|work from home|wfh)\M' THEN 'remote'
    -- a labelled field ("Work mode: Hybrid", "Fully Remote, Hybrid or Fully On-site: Hybrid") or "(Hybrid)"
    WHEN s.d ~* '(work ?mode|work ?model|working model|workplace|type|work arrangement|mode of work|location|fully on.?site)\s*:*\s*[:–-]\s*([1-5]\s*days?\s*)?hybrid'
      OR s.d ~* '\(\s*hybrid\M' THEN 'hybrid'
    -- part of the week in the office or at home: "3 days a week in the office", "onsite approximately 3 days per
    -- week", "remote working arrangements up to 2 days per week", "(4 days WFO)", "Hybrid - 2 days"
    WHEN s.d ~* '(on.?site|in.?office|in the office|from (the )?office|wfo|remote(ly)?|work from home|wfh)\W+(\w+\W+){0,6}?([1-4]|one|two|three|four)(\s*(-|to)\s*[1-4])?\s*(\(\d\)\s*)?days?\s+(a|per|each|in a)\s+week'
      OR s.d ~* '\m([1-4]|one|two|three|four)(\s*(-|to)\s*[1-4])?\s*(\(\d\)\s*)?days?\s+((a|per|each|in a)\s+week\s+)?(in|at|from|working from)\s+(the\s+|our\s+)?(office|site)\M'
      OR s.d ~* '\m[1-4]\s*days?\s*(wfo|work from office|in.?office|on.?site)\M'
      OR s.d ~* '\mhybrid\W{0,4}[1-4]\s*(-\s*[1-4]\s*)?days' THEN 'hybrid'
    WHEN s.d ~* '(work ?mode|work ?model|working model|workplace|type|work arrangement|mode of work|location)\s*:*\s*[:–-]\s*\(?\s*(100% remote|fully remote|remote|work from home|wfh|work from anywhere)'
      OR s.d ~* '\(\s*(100%\s+|fully\s+)?remote\s*\)' THEN 'remote'
    WHEN s.d ~* '(work ?mode|work ?model|working model|workplace|type|work arrangement|mode of work|location)\s*:*\s*[:–-]\s*([1-5]\s*days?\s*)?(on.?site|in.?office|work from office|wfo)\M'
      OR s.d ~* '\(\s*(on.?site|in.?office|wfo)\M' OR s.d ~* '\mon.?site essential\M' THEN 'onsite'
    -- described: "a hybrid work model", "this hybrid role"
    WHEN s.d ~* '\mhybrid\s+(work|working|model|mode|role|position|setup|set up|arrangement|schedule|policy|environment|opportunity|capacity|basis|culture|job)\M' THEN 'hybrid'
    -- "No work from home", "remote work is not an option"
    WHEN s.d ~* '\mno\s+(work from home|wfh|remote)\M' OR s.d ~* '\m(remote|work from home|wfh)( work(ing)?)? is not (an option|available|possible)' THEN 'onsite'
    -- clearly remote: "fully remote", "100% remote", "remote-first", "a remote role", "primarily work from home"
    WHEN s.d ~* '(fully|100%|completely|permanently|full[- ]time)\s+remote\M'
      OR s.d ~* '\mremote\s*(-|\s)\s*(first|only)\M'
      OR s.d ~* 'remote\s+(role|position|job|opportunity|setting|contract)\M'
      OR s.d ~* '\mremote\s*/\s*teleworker\M|\m(primarily|fully|permanently)\s+work from home\M' THEN 'remote'
    -- clearly on site: "work from office", "an on-site role", "based on-site in Noida", "primarily an in-office environment"
    WHEN s.d ~* '\m(work|working) from (the )?office\M|\mwfo\M'
      OR s.d ~* '\m(on.?site|in.?office)\s+(role|position|job|opportunity|working|work model|model|basis|only|environment|collaboration|presence)\M'
      OR s.d ~* '\m(based|located|operating|work|working|be|is|designed as)\W+(on.?site|in.?office|in the office)\M'
      OR s.d ~* '\mon.?site\s+(in|at)\M|(full[- ]time|fully|100%),?\s+on.?site\M'
      OR s.t ~* '\monsite\M' THEN 'onsite'
  END
  -- d is '' unless the description names a work place at all (about a third do): every rule below needs one of these
  -- words, and skipping the rest keeps the publish trigger cheap
  FROM (SELECT coalesce(p_title, '') || ' ' || coalesce(p_location, '') AS t,
          CASE WHEN p_description ~* 'remote|hybrid|on.?site|\mwfo\M|\mwfh\M|work from|teleworker|in.?office|(in|at|from) (the |our )?(office|site)\M'
               THEN left(p_description, 20000) ELSE '' END AS d
        OFFSET 0) s -- OFFSET 0: computed once, not once per rule
$$;

-- full_time / contract / internship / part_time / other from the posting's employment type, else from the title
CREATE OR REPLACE FUNCTION app.employment_kind(p_employment_type text, p_title text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN e IN ('full-time', 'full time') THEN 'full_time'
    WHEN e IN ('contract', 'temporary') THEN 'contract'
    WHEN e = 'internship' THEN 'internship'
    WHEN e IN ('part-time', 'part time') THEN 'part_time'
    WHEN e IN ('other', 'volunteer') THEN 'other'
    WHEN p_title ~* '\m(intern|internship|trainee)\M' THEN 'internship'
    WHEN p_title ~* '\m(contract|contractual|freelance|c2h|contract to hire|temporary)\M' THEN 'contract'
    WHEN p_title ~* '\mpart[- ]time\M' THEN 'part_time'
  END
  FROM (SELECT lower(btrim(p_employment_type)) AS e) s
$$;

CREATE OR REPLACE FUNCTION app.jobs_derive() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m app.city_match;
BEGIN
  SELECT * INTO m FROM app.city_match WHERE id = 1;
  NEW.company_key := app.company_key(NEW.company_name);
  NEW.title_key := app.title_key_with(NEW.title, m.noise_phrases, m.noise_words);
  NEW.dup_group := app.dup_group(NEW.company_key, NEW.title_key);
  NEW.cities := app.location_cities_with(NEW.location, m.city_phrases, m.city_phrase_names, m.city_words, m.city_word_names);
  NEW.city := NEW.cities[1];
  NEW.work_mode := app.work_mode(NEW.title, NEW.location, NEW.description);
  NEW.employment_kind := app.employment_kind(NEW.employment_type, NEW.title);
  RETURN NEW;
END
$$;

-- Recomputes the derived columns that depend on app.ref_cities (title_key, dup_group, cities, city), or with p_full every
-- derived column; only rows whose values change are written. Returns the number of rows updated.
CREATE OR REPLACE FUNCTION app.refresh_job_derivations(p_full boolean DEFAULT false) RETURNS bigint
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  m app.city_match;
  v_n bigint;
BEGIN
  SELECT * INTO m FROM app.city_match WHERE id = 1;
  -- MATERIALIZED: every value is computed once per job (not again for the SET list and the comparison)
  WITH d AS MATERIALIZED (
    SELECT k.job_key, k.company_key, k.title_key, app.dup_group(k.company_key, k.title_key) AS dup_group, k.cities,
      k.work_mode, k.employment_kind
    FROM (
      SELECT x.job_key,
        CASE WHEN p_full THEN app.company_key(x.company_name) ELSE x.company_key END AS company_key,
        app.title_key_with(x.title, m.noise_phrases, m.noise_words) AS title_key,
        app.location_cities_with(x.location, m.city_phrases, m.city_phrase_names, m.city_words, m.city_word_names) AS cities,
        CASE WHEN p_full THEN app.work_mode(x.title, x.location, x.description) ELSE x.work_mode END AS work_mode,
        CASE WHEN p_full THEN app.employment_kind(x.employment_type, x.title) ELSE x.employment_kind END AS employment_kind
      FROM app.jobs x
      OFFSET 0
    ) k
  )
  UPDATE app.jobs j
  SET company_key = d.company_key, title_key = d.title_key, dup_group = d.dup_group, cities = d.cities, city = d.cities[1],
      work_mode = d.work_mode, employment_kind = d.employment_kind
  FROM d
  WHERE j.job_key = d.job_key
    AND (j.company_key, j.title_key, j.dup_group, j.cities, j.city, j.work_mode, j.employment_kind)
        IS DISTINCT FROM (d.company_key, d.title_key, d.dup_group, d.cities, d.cities[1], d.work_mode, d.employment_kind);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- =====================================================================================================================
-- Fit scoring: every app.jobs row as seen by one user (port of USER_JOBS_CTE)
-- =====================================================================================================================

-- Re-created on every apply so a column change cannot leave a stale row type (CASCADE drops the functions using it;
-- they are created again below). app.filtered_job = app.user_job plus fresh (made from it, so the two cannot drift).
DROP TYPE IF EXISTS app.filtered_job CASCADE;
DROP TYPE IF EXISTS app.user_job CASCADE;
CREATE TYPE app.user_job AS (
  job_key text,
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
  category text,
  role_title text,
  role_score float8,
  role_alternative text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  times_seen int,
  is_active boolean,
  is_applied boolean,
  applied_at timestamptz,
  is_hidden boolean,
  hidden_at timestamptz,
  role_match boolean,
  fit_score int,
  fit_role float8,
  fit_skills float8,
  fit_experience numeric,
  fit_matched_skills text[],
  above_experience boolean,
  -- added with the feature wave (appended; the columns above keep their order and meaning)
  application_status text,
  status_updated_at timestamptz,
  next_action_at date,
  has_note boolean,
  is_tracked boolean,
  follow_up boolean,
  city text,
  cities text[],
  work_mode text,
  employment_kind text,
  company_key text,
  dup_group text,
  dup_applied_at timestamptz,
  dup_applied_key text,
  muted_by text,
  muted_value text,
  fit_role_reason text,
  fit_role_sim float8,
  fit_core_matched int,
  fit_exp_years int,
  job_skills_known boolean,
  in_for_you boolean
);
DO $$
BEGIN
  EXECUTE (
    SELECT 'CREATE TYPE app.filtered_job AS (' || string_agg(format('%I %s', a.attname, format_type(a.atttypid, a.atttypmod)), ', ' ORDER BY a.attnum)
      || ', fresh boolean)'
    FROM pg_attribute a
    WHERE a.attrelid = 'app.user_job'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  );
END
$$;

-- Roles users typed themselves (app.custom_roles, checked by the pipeline): 'mapped' ones count as the existing role they
-- duplicate; 'active' ones are matched like reference roles. Until then a job whose title contains the role text counts.
-- Role: your first role 1.0, your second 0.95, title contains a role 0.9, otherwise the job role's best similarity to one
-- of yours. Until app.role_similarity has rows for your roles, the job's alternative role (0.5) or category (0.3) counts.
-- Skills: matched idf / skill_idf_total (the core skills' idf, scaled up to 3 skills when there are fewer), so rare
-- skills count more and one or two skills cannot reach 100%; a job with no skills found scores NEUTRAL_SKILLS.
-- Also-know skills (profile also_skills) add ALSO_SKILL_WEIGHT x their idf when matched but are not part of the total,
-- so a profile without them scores exactly as before.
-- Experience: 0.3 off per year you are short; a job below your minimum loses 0.15 per year, down to 0.5; unknown 0.7.
-- above_experience (out of "For you"): the stated minimum years, else the level's typical years, more than
-- EXPERIENCE_HIDE_GAP above your maximum. Calibration gate (6 judged profiles, 3 judges, current constants): counting
-- every level raised pooled F0.5 (majority labels) from 0.750 to 0.771 and precision from 0.833 to 0.867 with the
-- same recall, P0 precision unchanged (0.894); levels from Lead/Manager only gave 0.760, so every level counts.
-- Tracked jobs (applied, saved or any stage) are never muted and always "For you". Mute rules, first match wins:
-- company (company_key), a title word, the experience level.
-- No SET clause and LANGUAGE sql so the planner can inline it into the calling query.
CREATE OR REPLACE FUNCTION app.user_jobs(p_uid uuid) RETURNS SETOF app.user_job
LANGUAGE sql STABLE PARALLEL SAFE AS $$
WITH role_map AS (
  SELECT lower(cr.role_title) AS role_key, cr.duplicate_of
  FROM app.custom_roles cr
  WHERE cr.status = 'mapped' AND cr.duplicate_of IS NOT NULL
),
skill_idf AS (
  SELECT lower(ss.skill) AS skill_key, max(ss.idf) AS idf
  FROM app.skill_stats ss
  WHERE ss.skill IS NOT NULL
  GROUP BY lower(ss.skill)
),
prof AS (
  SELECT up.min_years, up.max_years, up.skills, up.also_skills, up.muted_companies, up.muted_title_words, up.muted_levels,
    coalesce((
      SELECT array_agg(coalesce(rm.duplicate_of, r.role) ORDER BY r.ord)
      FROM unnest(up.target_roles) WITH ORDINALITY AS r(role, ord)
      LEFT JOIN role_map rm ON rm.role_key = lower(r.role)
    ), '{}'::text[]) AS roles
  FROM app.user_profile up
  WHERE up.profile_id = p_uid
),
-- Core skills in profile order (tier weight 1), then the also-know skills (ord 1001..) that are not core skills too
weights AS (
  SELECT s.ord, s.skill, lower(s.skill) AS skill_key, coalesce(si.idf, app.c_unseen_skill_idf()) AS idf,
    1::float8 AS tier_weight, true AS is_core
  FROM prof p
  CROSS JOIN LATERAL unnest(p.skills) WITH ORDINALITY AS s(skill, ord)
  LEFT JOIN skill_idf si ON si.skill_key = lower(s.skill)
  UNION ALL
  SELECT 1000 + a.ord, a.skill, lower(a.skill), coalesce(si.idf, app.c_unseen_skill_idf()), app.c_also_skill_weight(), false
  FROM prof p
  CROSS JOIN LATERAL unnest(p.also_skills) WITH ORDINALITY AS a(skill, ord)
  LEFT JOIN skill_idf si ON si.skill_key = lower(a.skill)
  WHERE NOT EXISTS (SELECT 1 FROM unnest(p.skills) AS k(skill) WHERE lower(k.skill) = lower(a.skill))
),
totals AS (
  SELECT count(*) FILTER (WHERE w.is_core)::int AS n,
    coalesce(sum(w.idf ORDER BY w.ord) FILTER (WHERE w.is_core), 0::float8) AS idf_sum
  FROM weights w
),
related AS (
  SELECT s.role_b,
    max((CASE WHEN array_position(p.roles, s.role_a) = 1 THEN 1.0 ELSE 0.95 END * app.c_role_sim_score())::float8
      * least(1::float8, greatest(0::float8, (s.sim - app.c_role_sim_floor()) / app.c_role_sim_span()))) AS score,
    max(s.sim) AS sim
  FROM app.role_similarity s
  JOIN prof p ON s.role_a = ANY (p.roles)
  WHERE s.role_b IS NOT NULL
  GROUP BY s.role_b
),
-- MATERIALIZED: one row, computed once (not once per job)
ctx AS MATERIALIZED (
  SELECT coalesce(p.roles, '{}'::text[]) AS roles, p.min_years, p.max_years, t.n,
    -- "title contains the role" as LIKE patterns (% _ \ escaped), so no per-job subquery is needed
    coalesce((
      SELECT array_agg('%' || replace(replace(replace(lower(r), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      FROM unnest(p.roles) AS r
      WHERE r IS NOT NULL
    ), '{}'::text[]) AS title_patterns,
    coalesce((SELECT array_agg(w.skill_key) FROM weights w), '{}'::text[]) AS skill_keys,
    (t.idf_sum * greatest(3, t.n)::float8) / greatest(1, t.n)::float8 AS skill_idf_total,
    EXISTS (SELECT 1 FROM related) AS related_ready,
    coalesce((
      SELECT array_agg(DISTINCT r.category)
      FROM (
        SELECT rr.role_title, rr.category FROM app.ref_roles rr
        UNION ALL SELECT cr.role_title, cr.category FROM app.custom_roles cr WHERE cr.status = 'active'
      ) r
      WHERE r.category IS NOT NULL AND r.role_title = ANY (p.roles)
    ), '{}'::text[]) AS categories,
    -- mute rules: company keys aligned with the names as typed, one title regex, the levels
    coalesce(p.muted_companies, '{}'::text[]) AS muted_companies,
    coalesce((SELECT array_agg(app.company_key(m.name) ORDER BY m.ord)
              FROM unnest(p.muted_companies) WITH ORDINALITY AS m(name, ord)), '{}'::text[]) AS muted_company_keys,
    (SELECT '(^|[^a-z0-9])(' || string_agg(app.regex_literal(lower(w.word)), '|' ORDER BY w.ord) || ')($|[^a-z0-9])'
     FROM unnest(p.muted_title_words) WITH ORDINALITY AS w(word, ord)
     WHERE w.word <> '') AS muted_title_re,
    coalesce(p.muted_levels, '{}'::text[]) AS muted_levels
  FROM totals t
  LEFT JOIN prof p ON true
),
-- Near-duplicates you applied to: per dup_group the two latest applied postings (one may be the job itself)
applied_groups AS MATERIALIZED (
  SELECT j.dup_group,
    (array_agg(j.job_key ORDER BY st.applied_at DESC NULLS LAST, j.job_key COLLATE "C"))[1:2] AS keys,
    (array_agg(st.applied_at ORDER BY st.applied_at DESC NULLS LAST, j.job_key COLLATE "C"))[1:2] AS applied
  FROM app.user_job_state st
  JOIN app.jobs j ON j.job_key = st.job_key
  WHERE st.user_id = p_uid AND st.is_applied AND j.dup_group IS NOT NULL
  GROUP BY j.dup_group
),
-- Not materialized (so the callers' filters apply while scanning); the only subquery per job is the skill match
-- below, a LATERAL with an aggregate, which the planner keeps as one evaluation per job
scored AS (
  SELECT
    j.job_key, j.source, j.company_name, j.title, j.location, j.posted_date, j.job_url,
    j.seniority_level, j.employment_type, j.experience_min_years, j.experience_max_years, j.experience_level,
    j.skills, j.category, j.role_title, j.role_score, j.role_alternative,
    j.first_seen_at, j.last_seen_at, j.times_seen, j.is_active,
    coalesce(st.is_applied, false) AS is_applied, st.applied_at,
    coalesce(st.is_hidden, false) AS is_hidden, st.hidden_at,
    coalesce(st.application_status, 'not_applied') AS application_status, st.status_updated_at, st.next_action_at,
    coalesce(st.note <> '', false) AS has_note,
    coalesce(st.is_applied OR st.application_status <> 'not_applied', false) AS is_tracked,
    j.city, j.cities, j.work_mode, j.employment_kind, j.company_key, j.dup_group,
    CASE WHEN ag.keys[1] IS DISTINCT FROM j.job_key THEN ag.keys[1] ELSE ag.keys[2] END AS dup_applied_key,
    CASE WHEN ag.keys[1] IS DISTINCT FROM j.job_key THEN ag.applied[1] ELSE ag.applied[2] END AS dup_applied_at,
    CASE WHEN j.company_key <> '' THEN array_position(c.muted_company_keys, j.company_key) END AS muted_company_at,
    -- the boolean test first: much cheaper than extracting the word, and most titles do not match
    CASE WHEN lower(j.title) ~ c.muted_title_re THEN (regexp_match(lower(j.title), c.muted_title_re))[2] END AS muted_word,
    coalesce(j.experience_level = ANY (c.muted_levels), false) AS muted_level,
    c.muted_companies,
    CASE WHEN j.role_title IS NULL THEN 0 ELSE coalesce(array_position(c.roles, j.role_title), 0) END AS role_rank,
    coalesce(lower(j.title) LIKE ANY (c.title_patterns), false) AS title_has_role,
    c.related_ready,
    rel.score AS related_score,
    rel.sim AS related_sim,
    coalesce(j.role_alternative = ANY (c.roles), false) AS alternative_is_role,
    coalesce(j.category = ANY (c.categories), false) AS category_is_role,
    m.matched_skills,
    m.matched_sum,
    m.core_matched,
    c.n > 0 AS has_profile_skills,
    c.skill_idf_total,
    coalesce(cardinality(j.skills), 0) + coalesce(cardinality(j.skill_groups), 0) = 0 AS no_job_skills,
    coalesce(j.experience_min_years, ly.level_years) AS exp_min,
    coalesce(j.experience_max_years, j.experience_min_years + 3, ly.level_years + 3) AS exp_top,
    c.min_years AS profile_min_years,
    c.max_years AS profile_max_years,
    coalesce(coalesce(j.experience_min_years, ly.level_years) > c.max_years + app.c_experience_hide_gap(), false) AS above_experience
  FROM app.jobs j
  CROSS JOIN ctx c
  LEFT JOIN app.user_job_state st ON st.user_id = p_uid AND st.job_key = j.job_key
  LEFT JOIN related rel ON rel.role_b = j.role_title
  LEFT JOIN applied_groups ag ON ag.dup_group = j.dup_group
  CROSS JOIN LATERAL (
    -- Typical years for a job that states only a level (experience_level from 03_enrich)
    SELECT CASE j.experience_level
      WHEN 'Intern' THEN 0 WHEN 'Entry' THEN 0 WHEN 'Junior' THEN 1 WHEN 'Mid' THEN 3 WHEN 'Mid-Senior' THEN 3
      WHEN 'Senior' THEN 5 WHEN 'Lead/Manager' THEN 7 WHEN 'Principal/Staff' THEN 8 WHEN 'Director+' THEN 10
    END AS level_years
  ) ly
  CROSS JOIN LATERAL (
    -- profile skills (core in profile order, then also-know) the job lists as a skill or a skill group; most jobs share
    -- none, so the cheap overlap test skips the subquery for them
    SELECT coalesce(array_agg(w.skill ORDER BY w.ord), '{}'::text[]) AS matched_skills,
           coalesce(sum(w.idf * w.tier_weight ORDER BY w.ord), 0::float8) AS matched_sum,
           count(*) FILTER (WHERE w.is_core)::int AS core_matched
    FROM weights w
    WHERE c.skill_keys && j.skill_keys AND w.skill_key = ANY (j.skill_keys)
  ) m
),
parts AS (
  SELECT s.*,
    CASE
      WHEN s.role_rank = 1 THEN 1.0::float8
      WHEN s.role_rank > 1 THEN 0.95::float8
      WHEN s.title_has_role THEN 0.9::float8
      WHEN s.related_ready THEN coalesce(s.related_score, 0.0::float8)
      WHEN s.alternative_is_role THEN 0.5::float8
      WHEN s.category_is_role THEN 0.3::float8
      ELSE 0.0::float8
    END AS fit_role,
    -- why the role part has its value (same precedence as fit_role)
    CASE
      WHEN s.role_rank = 1 THEN 'first_role'
      WHEN s.role_rank > 1 THEN 'second_role'
      WHEN s.title_has_role THEN 'title'
      WHEN s.related_ready THEN CASE WHEN coalesce(s.related_score, 0.0::float8) > 0 THEN 'related' ELSE 'none' END
      WHEN s.alternative_is_role THEN 'alternative'
      WHEN s.category_is_role THEN 'category'
      ELSE 'none'
    END AS fit_role_reason,
    s.role_rank > 0 OR s.title_has_role OR CASE
      WHEN s.related_ready THEN coalesce(s.related_sim >= app.c_role_sim_match(), false)
      ELSE s.alternative_is_role OR s.category_is_role
    END AS role_match,
    CASE
      WHEN NOT s.has_profile_skills THEN 0.0::float8
      WHEN s.no_job_skills THEN app.c_neutral_skills()
      ELSE least(1::float8, s.matched_sum / s.skill_idf_total)
    END AS fit_skills,
    CASE
      WHEN s.exp_min IS NULL THEN 0.7
      WHEN s.exp_min > s.profile_max_years THEN greatest(0.0, 1.0 - 0.3 * (s.exp_min - s.profile_max_years))
      WHEN s.exp_top < s.profile_min_years THEN greatest(0.5, 1.0 - 0.15 * (s.profile_min_years - s.exp_top))
      ELSE 1.0
    END AS fit_experience
  FROM scored s
)
SELECT
  p.job_key, p.source, p.company_name, p.title, p.location, p.posted_date, p.job_url,
  p.seniority_level, p.employment_type, p.experience_min_years, p.experience_max_years, p.experience_level,
  p.skills, p.category, p.role_title, p.role_score, p.role_alternative,
  p.first_seen_at, p.last_seen_at, p.times_seen, p.is_active,
  p.is_applied, p.applied_at, p.is_hidden, p.hidden_at,
  p.role_match,
  fs.fit_score,
  p.fit_role, p.fit_skills, p.fit_experience,
  p.matched_skills AS fit_matched_skills,
  p.above_experience,
  p.application_status, p.status_updated_at, p.next_action_at, p.has_note, p.is_tracked,
  coalesce(p.application_status = 'applied' AND CASE
    WHEN p.next_action_at IS NOT NULL THEN p.next_action_at <= current_date
    ELSE p.status_updated_at < now() - make_interval(days => app.c_follow_up_days())
  END, false) AS follow_up,
  p.city, p.cities, p.work_mode, p.employment_kind, p.company_key, p.dup_group, p.dup_applied_at, p.dup_applied_key,
  mu.muted_by,
  CASE mu.muted_by
    WHEN 'company' THEN p.muted_companies[p.muted_company_at]
    WHEN 'title' THEN p.muted_word
    WHEN 'level' THEN p.experience_level
  END AS muted_value,
  p.fit_role_reason,
  p.related_sim AS fit_role_sim,
  p.core_matched AS fit_core_matched,
  p.exp_min AS fit_exp_years,
  NOT p.no_job_skills AS job_skills_known,
  p.is_tracked OR (p.role_match AND fs.fit_score >= app.c_match_min_fit() AND NOT p.above_experience) AS in_for_you
FROM parts p
CROSS JOIN LATERAL (
  -- Spark: DOUBLE arithmetic in this order (0.15 * experience is DECIMAL x DECIMAL, then DOUBLE), round = HALF_UP.
  -- OFFSET 0 keeps this a per-job subquery, so the sum is computed once.
  SELECT 100::float8 * ((app.c_fit_weight_role() * p.fit_role + app.c_fit_weight_skills() * p.fit_skills)
    + (app.c_fit_weight_experience() * p.fit_experience)::float8) AS raw
  OFFSET 0
) r
CROSS JOIN LATERAL (
  -- app.round_half_up(raw), written out: a call per job would not be inlined and costs more than the rest of the scoring
  SELECT (floor(r.raw) + CASE WHEN r.raw - floor(r.raw) >= 0.5::float8 THEN 1 ELSE 0 END)::int AS fit_score
) fs
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN p.is_tracked THEN NULL
    WHEN p.muted_company_at IS NOT NULL THEN 'company'
    WHEN p.muted_word IS NOT NULL THEN 'title'
    WHEN p.muted_level THEN 'level'
  END AS muted_by
) mu
$$;

-- Group key of the list: tracked jobs and jobs without a dup_group are their own group; near-duplicates fold together
CREATE OR REPLACE FUNCTION app.group_key(p_job_key text, p_dup_group text, p_tracked boolean, p_collapse boolean) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_collapse AND NOT p_tracked AND p_dup_group IS NOT NULL THEN 'g' || p_dup_group ELSE p_job_key END
$$;

-- Jobs the list, the summary and the facets show (port of buildFilterWhere, extended). Visible = not hidden, and either
-- still active or tracked. Unless params.scope = 'all', only "For you" (in_for_you). fresh = the postedWithin window.
-- p_mode 'list' (the jobs list) also applies, in this order:
--   time    fresh, or a tracked job on the Saved / Applied tab (those tabs list their jobs whatever their date)
--   mute    muteView 'only' lists the muted jobs, anything else leaves them out
--   tab     inbox = untracked (not saved, applied or staged), applied = applied (any stage), pending = not applied
--           (saved included), saved = status saved
--   closed / followUp / stage
-- or, with expiring: true, instead of all of these: untracked, For you, not muted and on its last day before the
-- publish deletes it (job date <= today - c_job_delete_after_days(), UTC; the rule of src/utils/job.js expiryHint).
-- The text and panel filters still apply; scope does not matter (For you only).
-- p_mode 'summary' (summary, facets) applies none of these; they count with fresh and muted_by themselves.
-- q: words starting with '-' (2+ characters) must not occur; the other words, joined by single spaces, must.
CREATE OR REPLACE FUNCTION app.filtered_jobs(p_uid uuid, p jsonb, p_mode text) RETURNS SETOF app.filtered_job
LANGUAGE sql STABLE PARALLEL SAFE AS $$
-- MATERIALIZED: the parameters are parsed once, not once per job
WITH f AS MATERIALIZED (
  SELECT
    coalesce(p_mode = 'list', false) AS list_mode,
    coalesce(jsonb_typeof(p -> 'scope') = 'string' AND (p ->> 'scope') = 'all', false) AS scope_all,
    q.positive AS q,
    q.excluded AS q_excluded,
    app.js_text(p -> 'role', 100) AS role,
    app.js_text(p -> 'category', 100) AS category,
    app.js_text(p -> 'source', 100) AS source,
    app.js_text(p -> 'company', 200) AS company,
    lower(app.js_text(p -> 'location', 100)) AS location,
    app.js_text(p -> 'city', 100) AS city,
    CASE WHEN coalesce(p -> 'myCities' = 'true'::jsonb, false) THEN (
      SELECT nullif(up.preferred_cities, '{}'::text[]) FROM app.user_profile up WHERE up.profile_id = p_uid
    ) END AS my_cities,
    CASE WHEN app.js_text(p -> 'workMode', 20) = ANY (app.c_work_modes() || 'unknown'::text)
      THEN app.js_text(p -> 'workMode', 20) ELSE '' END AS work_mode,
    CASE WHEN app.js_text(p -> 'employment', 20) = ANY (app.c_employment_kinds() || 'unknown'::text)
      THEN app.js_text(p -> 'employment', 20) ELSE '' END AS employment,
    app.js_int(p -> 'maxYears', 0, 40) AS max_years,
    now() - make_interval(hours => app.js_int(p -> 'postedWithin', 1, 8760)) AS cutoff,
    app.js_int(p -> 'minFit', 1, 100) AS min_fit,
    coalesce(p -> 'matchedOnly' = 'true'::jsonb, false) AS matched_only,
    CASE WHEN jsonb_typeof(p -> 'tab') = 'string' THEN p ->> 'tab' END AS tab,
    coalesce(jsonb_typeof(p -> 'muteView') = 'string' AND (p ->> 'muteView') = 'only', false) AS mute_only,
    CASE WHEN app.js_text(p -> 'closed', 10) IN ('only', 'hide') THEN app.js_text(p -> 'closed', 10) ELSE '' END AS closed,
    coalesce(p -> 'followUp' = 'true'::jsonb, false) AS follow_up,
    CASE WHEN app.js_text(p -> 'stage', 20) = ANY (app.c_applied_statuses()) THEN app.js_text(p -> 'stage', 20) ELSE '' END AS stage,
    coalesce(p_mode = 'list' AND p -> 'expiring' = 'true'::jsonb, false) AS expiring,
    current_date - app.c_job_delete_after_days() AS expiring_on
  FROM (SELECT lower(app.js_text(p -> 'q', 100)) AS q) raw
  CROSS JOIN LATERAL (
    SELECT coalesce(string_agg(w.word, ' ' ORDER BY w.ord) FILTER (WHERE w.word NOT LIKE '-_%'), '') AS positive,
      coalesce(array_agg('%' || replace(replace(replace(substr(w.word, 2), '\', '\\'), '%', '\%'), '_', '\_') || '%' ORDER BY w.ord)
        FILTER (WHERE w.word LIKE '-_%'), '{}'::text[]) AS excluded
    FROM regexp_split_to_table(raw.q, '\s+') WITH ORDINALITY AS w(word, ord)
    WHERE w.word <> ''
  ) q
)
SELECT u.*, t.fresh
FROM app.user_jobs(p_uid) u
CROSS JOIN f
CROSS JOIN LATERAL (
  -- posted_date is only a DATE: a job posted today passes, one posted on the cutoff day passes only if it was first
  -- found inside the window; jobs without posted_date use first_seen_at
  SELECT coalesce(f.cutoff IS NULL OR CASE
    WHEN u.posted_date IS NOT NULL THEN u.posted_date >= (f.cutoff AT TIME ZONE 'UTC')::date
      AND (u.posted_date >= current_date OR u.first_seen_at >= f.cutoff)
    ELSE u.first_seen_at >= f.cutoff
  END, false) AS fresh
) t
WHERE NOT u.is_hidden AND (coalesce(u.is_active, true) OR u.is_tracked)
  AND (f.scope_all OR u.in_for_you)
  AND (f.q = '' OR strpos(lower(concat_ws(' ', u.title, u.company_name, u.role_title, array_to_string(u.skills, ' '))), f.q) > 0)
  AND (cardinality(f.q_excluded) = 0
       OR NOT lower(concat_ws(' ', u.title, u.company_name, u.role_title, array_to_string(u.skills, ' '))) LIKE ANY (f.q_excluded))
  AND (f.role = '' OR u.role_title = f.role)
  AND (f.category = '' OR u.category = f.category)
  AND (f.source = '' OR u.source = f.source)
  AND (f.company = '' OR u.company_name = f.company)
  AND (f.location = '' OR strpos(lower(u.location), f.location) > 0)
  AND (f.city = '' OR f.city = ANY (u.cities))
  AND (f.my_cities IS NULL OR u.cities && f.my_cities OR u.work_mode = 'remote')
  AND (f.work_mode = '' OR u.work_mode IS NOT DISTINCT FROM nullif(f.work_mode, 'unknown'))
  AND (f.employment = '' OR u.employment_kind IS NOT DISTINCT FROM nullif(f.employment, 'unknown'))
  AND (f.max_years IS NULL OR coalesce(u.experience_min_years, 0) <= f.max_years)
  AND (f.min_fit IS NULL OR coalesce(u.fit_score, 0) >= f.min_fit)
  AND (NOT f.matched_only OR coalesce(cardinality(u.fit_matched_skills), 0) > 0)
  AND (NOT f.list_mode OR CASE WHEN f.expiring THEN
    NOT u.is_tracked AND u.in_for_you AND u.muted_by IS NULL
    AND coalesce(coalesce(u.posted_date, (u.first_seen_at AT TIME ZONE 'UTC')::date) <= f.expiring_on, false)
  ELSE (
    (t.fresh OR (u.is_tracked AND coalesce(f.tab IN ('applied', 'saved'), false)))
    AND CASE WHEN f.mute_only THEN u.muted_by IS NOT NULL ELSE u.muted_by IS NULL END
    AND (f.tab IS NULL OR f.tab NOT IN ('applied', 'pending', 'saved', 'inbox')
         OR (f.tab = 'applied' AND u.is_applied) OR (f.tab = 'pending' AND NOT u.is_applied)
         OR (f.tab = 'saved' AND u.application_status = 'saved') OR (f.tab = 'inbox' AND NOT u.is_tracked))
    AND (f.closed = '' OR (f.closed = 'only') = NOT coalesce(u.is_active, true))
    AND (NOT f.follow_up OR u.follow_up)
    AND (f.stage = '' OR u.application_status = f.stage)
  ) END)
$$;

-- =====================================================================================================================
-- Read actions
-- =====================================================================================================================

-- A user_job / filtered_job row as the list returns it: the internal and per-call columns removed
CREATE OR REPLACE FUNCTION app.list_row(p_row jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_row - ARRAY['is_hidden', 'hidden_at', 'is_tracked', 'fresh', 'gk', 'rn', 'job_date',
                       'k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6']
$$;

CREATE OR REPLACE FUNCTION app.read_jobs(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_sort text := CASE WHEN jsonb_typeof(p -> 'sort') = 'string' AND (p ->> 'sort') IN ('recent', 'found', 'applied', 'expiring')
                      THEN p ->> 'sort' ELSE 'fit' END;
  v_collapse boolean := p -> 'collapse' IS DISTINCT FROM 'false'::jsonb;
  v_limit int := CASE WHEN p -> 'expiring' = 'true'::jsonb
                      THEN least(coalesce(app.js_int(p -> 'limit', 1, app.c_max_page_size()), app.c_expiring_max()), app.c_expiring_max())
                      ELSE coalesce(app.js_int(p -> 'limit', 1, app.c_max_page_size()), app.c_default_page_size()) END;
  v_offset int := coalesce(app.js_int(p -> 'offset', 0, 100000), 0);
  v_page jsonb;
  v_rows jsonb;
BEGIN
  -- 1) The page, from the few columns the grouping and the sorts need (every filtered job is scored, but only these
  --    columns are kept). Collapse (default on): near-duplicates (same group key) show as one row, the group's best fit
  --    (then newest); dup_count / dup_keys / dup_locations describe the others. Only these representatives are sorted
  --    and paged, and total_count counts them.
  --    Sorts (then job_key): fit = fit_score, job date, first_seen_at, role_score; recent = job date, fit_score;
  --    found = first_seen_at, fit_score; applied = applied_at, status_updated_at; expiring = job date ascending (soonest
  --    gone first), fit_score, first_seen_at. k0..k6 hold the sort keys of the chosen sort (NULL where unused; k0 is
  --    the job date turned around, so every key sorts DESC) so ORDER BY ... LIMIT can use a top-N sort.
  --    expiring: true (the Expiring tonight list) returns at most c_expiring_max() rows; total_count counts them all.
  WITH x AS MATERIALIZED (
    SELECT f.job_key, app.group_key(f.job_key, f.dup_group, f.is_tracked, v_collapse) AS gk, f.fit_score,
      coalesce(f.posted_date, (f.first_seen_at AT TIME ZONE 'UTC')::date) AS job_date, f.first_seen_at, f.role_score,
      f.applied_at, f.status_updated_at, coalesce(f.city, f.location) AS place
    FROM app.filtered_jobs(p_uid, p, 'list') f
  ),
  -- (the representative's sort keys travel along: x is estimated at one row, so a join back to x became a nested loop
  --  that re-ran this window once per job, 8 s for 1,400 jobs)
  by_group AS (
    SELECT n.job_key, n.dup_count, n.keys[2:21] AS dup_keys, n.places[2:21] AS dup_locations,
      n.fit_score, n.job_date, n.first_seen_at, n.role_score, n.applied_at, n.status_updated_at
    FROM (
      SELECT x.job_key, x.fit_score, x.job_date, x.first_seen_at, x.role_score, x.applied_at, x.status_updated_at,
        row_number() OVER w AS rn,
        count(*) OVER w_all - 1 AS dup_count,
        array_agg(x.job_key) OVER w_all AS keys,
        array_agg(x.place) OVER w_all AS places
      FROM x
      WINDOW w AS (PARTITION BY x.gk ORDER BY x.fit_score DESC NULLS LAST, x.job_date DESC NULLS LAST,
                                              x.first_seen_at DESC NULLS LAST, x.job_key COLLATE "C"),
             w_all AS (w ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
    ) n
    WHERE n.rn = 1
  ),
  page AS (
    SELECT g.job_key, g.dup_count, g.dup_keys, g.dup_locations,
      count(*) OVER () AS total_count,
      CASE WHEN v_sort = 'expiring' THEN DATE '2000-01-01' - g.job_date END AS k0,
      CASE WHEN v_sort IN ('fit', 'expiring') THEN g.fit_score END AS k1,
      CASE WHEN v_sort IN ('fit', 'recent') THEN g.job_date END AS k2,
      CASE WHEN v_sort IN ('fit', 'found', 'expiring') THEN g.first_seen_at WHEN v_sort = 'applied' THEN g.applied_at END AS k3,
      CASE WHEN v_sort = 'fit' THEN g.role_score END AS k4,
      CASE WHEN v_sort IN ('recent', 'found') THEN g.fit_score END AS k5,
      CASE WHEN v_sort = 'applied' THEN g.status_updated_at END AS k6
    FROM by_group g
    ORDER BY k0 DESC NULLS LAST, k1 DESC NULLS LAST, k2 DESC NULLS LAST, k3 DESC NULLS LAST, k4 DESC NULLS LAST,
             k5 DESC NULLS LAST, k6 DESC NULLS LAST, g.job_key COLLATE "C"
    LIMIT v_limit OFFSET v_offset
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('job_key', pg.job_key, 'dup_count', pg.dup_count,
             'dup_keys', coalesce(pg.dup_keys, '{}'::text[]), 'dup_locations', coalesce(pg.dup_locations, '{}'::text[]),
             'total_count', pg.total_count)
           ORDER BY pg.k0 DESC NULLS LAST, pg.k1 DESC NULLS LAST, pg.k2 DESC NULLS LAST, pg.k3 DESC NULLS LAST,
                    pg.k4 DESC NULLS LAST, pg.k5 DESC NULLS LAST, pg.k6 DESC NULLS LAST, pg.job_key COLLATE "C"), '[]'::jsonb)
  INTO v_page
  FROM page pg;

  -- 2) The full rows of the page only (the job_key list reaches the app.jobs primary key)
  SELECT coalesce(jsonb_agg(app.list_row(to_jsonb(u)) || e.extra ORDER BY e.ord), '[]'::jsonb)
  INTO v_rows
  FROM jsonb_array_elements(v_page) WITH ORDINALITY AS e(extra, ord)
  JOIN app.user_jobs(p_uid) u ON u.job_key = e.extra ->> 'job_key'
  WHERE u.job_key = ANY (ARRAY(SELECT k.extra ->> 'job_key' FROM jsonb_array_elements(v_page) AS k(extra)));
  RETURN jsonb_build_object('rows', v_rows);
END
$$;

-- Counts for the tabs and metrics (tab, stage, followUp, closed and muteView are ignored; the other filters, scope,
-- postedWithin and collapse apply). total / pending / new_48h / strong_fit count list rows (groups when collapsed)
-- inside the time window and not muted; applied / saved / stages / follow_up / closed count tracked jobs whatever their
-- date; muted = the muted jobs inside the time window.
-- One definition per number for the tabs (Inbox, Saved and Applied are disjoint; listed = fresh and not muted):
--   inbox            listed and untracked (= the Inbox tab's total_count)
--   inbox_strong     inbox with fit >= c_strong_fit() (= the Inbox tab filtered to minFit 70)
--   new_since        inbox found after params.since (an ISO timestamp); null without since
--   expiring         untracked, For you, not muted, on its last day (as the expiring: true list); the time window and
--                    the scope do not apply. expiring_strong: of these, fit >= c_strong_fit()
--   triaged_today    saved + applied + hidden of today's app.user_activity_day row (net of same-day undos)
-- strong_fit keeps its old meaning (tracked jobs included): parity.py and older clients compare it.
CREATE OR REPLACE FUNCTION app.read_summary(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH x AS MATERIALIZED (
    SELECT f.job_key, f.is_applied, f.application_status, f.is_tracked, f.is_active, f.follow_up, f.first_seen_at,
      f.fit_score, f.muted_by, f.fresh, f.posted_date, f.in_for_you,
      app.group_key(f.job_key, f.dup_group, f.is_tracked, p -> 'collapse' IS DISTINCT FROM 'false'::jsonb) AS gk
    FROM app.filtered_jobs(p_uid, p, 'summary') f
  ),
  since AS (SELECT app.js_timestamp(p -> 'since') AS at),
  stages AS (
    SELECT jsonb_object_agg(s.status, coalesce(c.n, 0)) AS counts
    FROM unnest(app.c_applied_statuses()) AS s(status)
    LEFT JOIN (SELECT x.application_status, count(*) AS n FROM x WHERE x.is_applied GROUP BY x.application_status) c
      ON c.application_status = s.status
  ),
  -- a group counts when any of its postings does
  by_group AS (
    SELECT bool_or(x.listed) AS listed, bool_or(x.listed AND NOT x.is_applied) AS pending,
      bool_or(x.listed AND x.first_seen_at >= now() - interval '48 hours') AS new_48h,
      bool_or(x.listed AND coalesce(x.fit_score, 0) >= app.c_strong_fit()) AS strong_fit,
      bool_or(x.inbox) AS inbox,
      bool_or(x.inbox AND coalesce(x.fit_score, 0) >= app.c_strong_fit()) AS inbox_strong,
      bool_or(x.inbox AND x.first_seen_at > s.at) AS new_since,
      bool_or(x.expiring) AS expiring,
      bool_or(x.expiring AND coalesce(x.fit_score, 0) >= app.c_strong_fit()) AS expiring_strong
    FROM (
      SELECT x.*, x.fresh AND x.muted_by IS NULL AS listed,
        x.fresh AND x.muted_by IS NULL AND NOT x.is_tracked AS inbox,
        NOT x.is_tracked AND x.in_for_you AND x.muted_by IS NULL
          AND coalesce(coalesce(x.posted_date, (x.first_seen_at AT TIME ZONE 'UTC')::date)
                       <= current_date - app.c_job_delete_after_days(), false) AS expiring
      FROM x
    ) x
    CROSS JOIN since s
    GROUP BY x.gk
  )
  SELECT jsonb_build_object('rows', jsonb_build_array((
    SELECT jsonb_build_object('total', count(*) FILTER (WHERE gr.listed), 'pending', count(*) FILTER (WHERE gr.pending),
      'new_48h', count(*) FILTER (WHERE gr.new_48h), 'strong_fit', count(*) FILTER (WHERE gr.strong_fit),
      'inbox', count(*) FILTER (WHERE gr.inbox), 'inbox_strong', count(*) FILTER (WHERE gr.inbox_strong),
      'new_since', CASE WHEN (SELECT s.at FROM since s) IS NOT NULL THEN count(*) FILTER (WHERE gr.new_since) END,
      'expiring', count(*) FILTER (WHERE gr.expiring), 'expiring_strong', count(*) FILTER (WHERE gr.expiring_strong),
      'triaged_today', (SELECT coalesce(sum(d.saved + d.applied + d.hidden), 0) FROM app.user_activity_day d
                        WHERE d.user_id = p_uid AND d.day = current_date))
    FROM by_group gr
  ) || jsonb_build_object(
    'applied', count(*) FILTER (WHERE x.is_applied),
    'saved', count(*) FILTER (WHERE x.application_status = 'saved'),
    'stages', (SELECT s.counts FROM stages s),
    'follow_up', count(*) FILTER (WHERE x.follow_up),
    'closed', count(*) FILTER (WHERE x.is_tracked AND NOT coalesce(x.is_active, true)),
    'muted', count(*) FILTER (WHERE x.fresh AND x.muted_by IS NOT NULL)
  )))
  FROM x
$$;

-- Jobs added per UTC day (in your scope, hidden ones included) and jobs you applied to per day, last 14 days
CREATE OR REPLACE FUNCTION app.read_trend(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH uj AS (SELECT * FROM app.user_jobs(p_uid)),
  scope AS (SELECT coalesce(jsonb_typeof(p -> 'scope') = 'string' AND (p ->> 'scope') = 'all', false) AS scope_all),
  days AS (
    SELECT (uj.first_seen_at AT TIME ZONE 'UTC')::date AS day, 1 AS added, 0 AS applied
    FROM uj CROSS JOIN scope
    WHERE uj.first_seen_at >= current_date - 13
      AND (scope.scope_all OR uj.in_for_you)
    UNION ALL
    SELECT (uj.applied_at AT TIME ZONE 'UTC')::date, 0, 1
    FROM uj
    WHERE uj.applied_at >= current_date - 13
  )
  SELECT jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'added', d.added, 'applied', d.applied) ORDER BY d.day), '[]'::jsonb))
  FROM (SELECT days.day, sum(days.added) AS added, sum(days.applied) AS applied FROM days GROUP BY days.day) d
$$;

-- Filter options with counts over the visible, unmuted jobs in scope (no other filter, no time window). work_mode and
-- employment count jobs that state none as 'unknown'.
CREATE OR REPLACE FUNCTION app.read_facets(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH visible AS (
    SELECT x.role_title, x.category, x.source, x.company_name, x.cities, x.work_mode, x.employment_kind
    FROM app.filtered_jobs(p_uid, jsonb_build_object('scope', p -> 'scope'), 'summary') x
    WHERE x.muted_by IS NULL
  ),
  facets AS (
    SELECT 'role' AS kind, v.role_title AS value, count(*) AS n FROM visible v WHERE v.role_title IS NOT NULL GROUP BY v.role_title
    UNION ALL SELECT 'category', v.category, count(*) FROM visible v WHERE v.category IS NOT NULL GROUP BY v.category
    UNION ALL SELECT 'source', v.source, count(*) FROM visible v WHERE v.source IS NOT NULL GROUP BY v.source
    UNION ALL SELECT 'company', v.company_name, count(*) FROM visible v WHERE v.company_name IS NOT NULL GROUP BY v.company_name
    UNION ALL SELECT 'city', c.city, count(*) FROM visible v CROSS JOIN LATERAL unnest(v.cities) AS c(city) GROUP BY c.city
    UNION ALL SELECT 'work_mode', coalesce(v.work_mode, 'unknown'), count(*) FROM visible v GROUP BY coalesce(v.work_mode, 'unknown')
    UNION ALL SELECT 'employment', coalesce(v.employment_kind, 'unknown'), count(*) FROM visible v
      GROUP BY coalesce(v.employment_kind, 'unknown')
  )
  SELECT jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.kind COLLATE "C", f.n DESC, f.value COLLATE "C"), '[]'::jsonb))
  FROM facets f
$$;

-- Only what the detail drawer adds on top of the list row
CREATE OR REPLACE FUNCTION app.read_job(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_key text := app.req_job_key(p -> 'jobKey'); -- validated even when app.jobs is empty
  v_rows jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT j.job_key, j.description, j.job_function, j.industries, j.role_method, j.role_score
    FROM app.jobs j
    WHERE j.job_key = v_key
  ) d;
  RETURN jsonb_build_object('rows', v_rows);
END
$$;

-- One job in the list row shape, whatever the filters (deep links, a job opened from elsewhere), plus is_hidden
CREATE OR REPLACE FUNCTION app.read_job_row(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_key text := app.req_job_key(p -> 'jobKey');
  v_rows jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(app.list_row(to_jsonb(u)) || jsonb_build_object(
           'is_hidden', u.is_hidden, 'dup_count', 0, 'dup_keys', '[]'::jsonb, 'dup_locations', '[]'::jsonb, 'total_count', 1)),
         '[]'::jsonb)
  INTO v_rows
  FROM app.user_jobs(p_uid) u
  WHERE u.job_key = v_key;
  RETURN jsonb_build_object('rows', v_rows);
END
$$;

-- Every visible posting of one duplicate group (any scope, muted ones included), in representative order
CREATE OR REPLACE FUNCTION app.read_job_group(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_group text := CASE WHEN jsonb_typeof(p -> 'dupGroup') = 'string' THEN p ->> 'dupGroup' END;
  v_rows jsonb;
BEGIN
  IF v_group IS NULL OR v_group !~ '^[0-9a-f]{32}$' THEN
    PERFORM app.fail('Invalid group');
  END IF;
  SELECT coalesce(jsonb_agg(app.list_row(to_jsonb(g)) - 'ord' || jsonb_build_object(
           'dup_count', 0, 'dup_keys', '[]'::jsonb, 'dup_locations', '[]'::jsonb, 'total_count', g.total_count)
           ORDER BY g.ord), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT u.*, count(*) OVER () AS total_count,
      row_number() OVER (ORDER BY u.fit_score DESC NULLS LAST,
                                  coalesce(u.posted_date, (u.first_seen_at AT TIME ZONE 'UTC')::date) DESC NULLS LAST,
                                  u.first_seen_at DESC NULLS LAST, u.job_key COLLATE "C") AS ord
    FROM app.user_jobs(p_uid) u
    WHERE u.dup_group = v_group AND NOT u.is_hidden AND (coalesce(u.is_active, true) OR u.is_tracked)
    ORDER BY ord
    LIMIT 50
  ) g;
  RETURN jsonb_build_object('rows', v_rows);
END
$$;

CREATE OR REPLACE FUNCTION app.read_job_note(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_key text := app.req_job_key(p -> 'jobKey');
  v_rows jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(n)), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT st.job_key, st.note, st.next_action_at, st.application_status, st.status_updated_at
    FROM app.user_job_state st
    WHERE st.user_id = p_uid AND st.job_key = v_key
  ) n;
  RETURN jsonb_build_object('rows', v_rows);
END
$$;

-- Your applied, saved and staged jobs with their notes (the CSV export), newest first
CREATE OR REPLACE FUNCTION app.read_tracked_jobs(p_uid uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(t) - 'ord' ORDER BY t.ord), '[]'::jsonb))
  FROM (
    SELECT u.job_key, u.title, u.company_name, u.location, u.city, u.source, u.job_url, u.posted_date, u.fit_score,
      u.application_status, u.applied_at, u.status_updated_at, u.next_action_at, st.note, u.is_active,
      row_number() OVER (ORDER BY coalesce(u.applied_at, u.status_updated_at) DESC NULLS LAST, u.job_key COLLATE "C") AS ord
    FROM app.user_job_state st
    JOIN app.user_jobs(p_uid) u ON u.job_key = st.job_key
    WHERE st.user_id = p_uid AND (st.is_applied OR st.application_status <> 'not_applied')
    ORDER BY ord
    LIMIT 2000
  ) t
$$;

CREATE OR REPLACE FUNCTION app.read_hidden_jobs(p_uid uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(h) - 'rn' ORDER BY h.rn), '[]'::jsonb))
  FROM (
    SELECT j.job_key, j.title, j.company_name, j.location, st.hidden_at, st.hide_reason,
      row_number() OVER (ORDER BY st.hidden_at DESC NULLS LAST, j.job_key COLLATE "C") AS rn
    FROM app.user_job_state st
    JOIN app.jobs j ON j.job_key = st.job_key
    WHERE st.user_id = p_uid AND st.is_hidden
    ORDER BY rn
    LIMIT 500
  ) h
$$;

CREATE OR REPLACE FUNCTION app.read_profile(p_uid uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb))
  FROM (
    SELECT up.profile_id, up.target_roles, up.skills, up.min_years, up.max_years, up.preferred_cities, up.updated_at,
      up.also_skills, up.muted_companies, up.muted_title_words, up.muted_levels
    FROM app.user_profile up
    WHERE up.profile_id = p_uid
  ) x
$$;

-- Pickers: roles in the supported scope (the other roles only help classify jobs and are refused by saveProfile),
-- skills with their aliases and the skill groups, what users added themselves with its status, and the cities a user
-- can prefer with their other spellings.
CREATE OR REPLACE FUNCTION app.read_refs() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH refs AS (
    SELECT 'role' AS kind, r.role_title AS value, r.category AS detail, NULL::text[] AS aliases FROM app.ref_roles r WHERE r.in_scope
    UNION ALL SELECT 'role_out', r.role_title, r.category, NULL::text[] FROM app.ref_roles r WHERE NOT r.in_scope
    UNION ALL SELECT 'skill', s.skill, s.skill_group, s.aliases FROM app.ref_skills s
    UNION ALL SELECT DISTINCT 'skill', s.skill_group, 'group', NULL::text[] FROM app.ref_skills s WHERE s.skill_group IS NOT NULL
    UNION ALL SELECT 'custom_role', c.role_title, c.status, CASE WHEN c.duplicate_of IS NOT NULL THEN ARRAY[c.duplicate_of] END
      FROM app.custom_roles c
    UNION ALL SELECT 'custom_skill', c.skill, 'custom', NULL::text[] FROM app.custom_skills c
    -- coalesce: Spark's collect_set gives [] (not null) for a city without aliases
    UNION ALL SELECT 'city', l.city, max(l.state),
        coalesce(array_agg(DISTINCT lower(l.alias)) FILTER (WHERE l.alias IS NOT NULL), '{}'::text[])
      FROM app.ref_cities l WHERE l.city IS NOT NULL AND l.city <> 'India' GROUP BY l.city
  )
  SELECT jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.kind COLLATE "C", x.value COLLATE "C"), '[]'::jsonb))
  FROM refs x
$$;

-- When the job data was last published (the UI shows "Updated X ago" and refreshes when run_id changes)
CREATE OR REPLACE FUNCTION app.read_status() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('rows', jsonb_build_array(jsonb_build_object(
    'run_id', ps.run_id,
    'snapshot_at', ps.snapshot_at,
    'published_at', ps.published_at,
    'jobs', (ps.counts ->> 'jobs')::bigint
  )))
  FROM (SELECT 1) one
  LEFT JOIN app.pipeline_status ps ON ps.id = 1
$$;

-- The allow-list with, per email (its auth.users account, matched case-insensitively): last_active_at = the latest
-- ping or write (app.user_activity_day.last_at; null if none) and applied_7d = jobs applied to in the last 7 days.
-- If the function owner may not read auth.users, the list still comes back (the two extras null), so the Access tab
-- of a client that predates them keeps working.
CREATE OR REPLACE FUNCTION app.read_allowed_emails() RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN (
    SELECT jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object('email', a.email, 'added_at', a.added_at,
             'last_active_at', x.last_active_at, 'applied_7d', x.applied_7d) ORDER BY a.email COLLATE "C"), '[]'::jsonb))
    FROM app.allowed_emails a
    CROSS JOIN LATERAL (
      SELECT
        (SELECT max(d.last_at) FROM app.user_activity_day d
         WHERE d.user_id IN (SELECT u.id FROM auth.users u WHERE lower(u.email) = a.email)) AS last_active_at,
        (SELECT count(*) FROM app.user_job_state s
         WHERE s.user_id IN (SELECT u.id FROM auth.users u WHERE lower(u.email) = a.email)
           AND s.is_applied AND s.applied_at >= now() - interval '7 days') AS applied_7d
    ) x
  );
EXCEPTION WHEN insufficient_privilege THEN
  RETURN (
    SELECT jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object('email', a.email, 'added_at', a.added_at,
             'last_active_at', NULL, 'applied_7d', NULL) ORDER BY a.email COLLATE "C"), '[]'::jsonb))
    FROM app.allowed_emails a
  );
END
$$;

-- Admin Metrics card: aggregates only (no job keys, URLs or search text). Days and ISO weeks (Monday) are UTC; active =
-- a day with visits > 0.
--   weeks            the last 8 ISO weeks, newest first: active_users, strong_applications (applied_at in the week and
--                    fit_at_action >= STRONG_FIT), north_star = strong_applications / active_users, the acted_strong /
--                    missed_strong sums and coverage = acted / (acted + missed)
--   weekly_return    users active on 1+ / 3+ of the last 7 days
--   retention        accounts created in the last 60 days, back the next day (d1) and on day 7 (d7), each with the
--                    accounts old enough to tell
--   outcome_capture  applications 14+ days old and how many moved past 'applied'
--   guardrails       last 28 days of applications: duplicates (an earlier application of yours in the same dup_group)
--                    and the median hours from first seen to applied
CREATE OR REPLACE FUNCTION app.read_metrics() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH weeks AS (
    SELECT (date_trunc('week', current_date::timestamp) - make_interval(weeks => i))::date AS week
    FROM generate_series(0, 7) AS i
  ),
  active_days AS (
    SELECT d.user_id, d.day FROM app.user_activity_day d WHERE d.visits > 0
  ),
  per_week AS (
    SELECT w.week,
      (SELECT count(DISTINCT ad.user_id) FROM active_days ad WHERE ad.day >= w.week AND ad.day < w.week + 7) AS active_users,
      (SELECT count(*) FROM app.user_job_state s
       WHERE s.is_applied AND s.fit_at_action >= app.c_strong_fit()
         AND (s.applied_at AT TIME ZONE 'UTC')::date >= w.week AND (s.applied_at AT TIME ZONE 'UTC')::date < w.week + 7)
        AS strong_applications,
      (SELECT coalesce(sum(d.acted_strong), 0) FROM app.user_activity_day d WHERE d.day >= w.week AND d.day < w.week + 7)
        AS acted_strong,
      (SELECT coalesce(sum(d.missed_strong), 0) FROM app.user_activity_day d WHERE d.day >= w.week AND d.day < w.week + 7)
        AS missed_strong
    FROM weeks w
  ),
  last7 AS (
    SELECT ad.user_id, count(DISTINCT ad.day) AS days
    FROM active_days ad
    WHERE ad.day > current_date - 7
    GROUP BY ad.user_id
  ),
  signups AS (
    SELECT u.id, (u.created_at AT TIME ZONE 'UTC')::date AS day
    FROM auth.users u
    WHERE u.created_at >= now() - interval '60 days'
  ),
  applications AS (
    SELECT s.user_id, s.job_key, s.applied_at, s.application_status, j.dup_group, j.first_seen_at
    FROM app.user_job_state s
    LEFT JOIN app.jobs j ON j.job_key = s.job_key
    WHERE s.is_applied AND s.applied_at IS NOT NULL
  ),
  recent AS (
    SELECT a.*, EXISTS (
        SELECT 1 FROM applications e
        WHERE e.user_id = a.user_id AND e.dup_group = a.dup_group AND e.job_key <> a.job_key AND e.applied_at < a.applied_at
      ) AS duplicate
    FROM applications a
    WHERE a.applied_at >= now() - interval '28 days'
  ),
  r AS (
    SELECT count(*) AS n, count(*) FILTER (WHERE x.duplicate) AS dup,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM x.applied_at - x.first_seen_at) / 3600)
        FILTER (WHERE x.first_seen_at <= x.applied_at) AS median_hours
    FROM recent x
  ),
  outcome AS (
    SELECT count(*) AS eligible, count(*) FILTER (WHERE a.application_status <> 'applied') AS moved
    FROM applications a
    WHERE a.applied_at <= now() - interval '14 days'
  ),
  wr AS (
    SELECT count(*) AS active_7d, count(*) FILTER (WHERE l.days >= 3) AS habitual_7d FROM last7 l
  ),
  ret AS (
    SELECT count(*) AS new_users,
      count(*) FILTER (WHERE s.day + 1 <= current_date) AS d1_eligible,
      count(*) FILTER (WHERE s.day + 1 <= current_date
                         AND EXISTS (SELECT 1 FROM active_days ad WHERE ad.user_id = s.id AND ad.day = s.day + 1)) AS d1,
      count(*) FILTER (WHERE s.day + 7 <= current_date) AS d7_eligible,
      count(*) FILTER (WHERE s.day + 7 <= current_date
                         AND EXISTS (SELECT 1 FROM active_days ad WHERE ad.user_id = s.id AND ad.day = s.day + 7)) AS d7
    FROM signups s
  )
  SELECT jsonb_build_object('rows', jsonb_build_array(jsonb_build_object(
    'generated_at', now(),
    'collecting_since', (SELECT min(d.day) FROM app.user_activity_day d),
    'weeks', (SELECT jsonb_agg(jsonb_build_object(
                'week', pw.week, 'active_users', pw.active_users, 'strong_applications', pw.strong_applications,
                'north_star', CASE WHEN pw.active_users > 0 THEN round(pw.strong_applications::numeric / pw.active_users, 2) END,
                'acted_strong', pw.acted_strong, 'missed_strong', pw.missed_strong,
                'coverage', CASE WHEN pw.acted_strong + pw.missed_strong > 0
                                 THEN round(pw.acted_strong::numeric / (pw.acted_strong + pw.missed_strong), 2) END)
              ORDER BY pw.week DESC) FROM per_week pw),
    'weekly_return', (SELECT jsonb_build_object('active_7d', wr.active_7d, 'habitual_7d', wr.habitual_7d,
                        'share', CASE WHEN wr.active_7d > 0 THEN round(wr.habitual_7d::numeric / wr.active_7d, 2) END)
                      FROM wr),
    'retention', (SELECT to_jsonb(ret) FROM ret),
    'outcome_capture', (SELECT jsonb_build_object('eligible', o.eligible, 'moved', o.moved,
                          'share', CASE WHEN o.eligible > 0 THEN round(o.moved::numeric / o.eligible, 2) END)
                        FROM outcome o),
    'guardrails', (SELECT jsonb_build_object('applications_28d', r.n, 'duplicate_applications_28d', r.dup,
                     'duplicate_rate', CASE WHEN r.n > 0 THEN round(r.dup::numeric / r.n, 2) END,
                     'median_hours_to_apply', round(r.median_hours::numeric, 1))
                   FROM r)
  )))
$$;

-- Admin company health: newest job per company for the company scrapers (gold source = the company's ATS type:
-- workday, greenhouse, phenom, ...; LinkedIn results are left out, their company is the employer, not the search),
-- joined with the latest scrape result per company or LinkedIn search (app.scrape_companies, from the scrape reports).
CREATE OR REPLACE FUNCTION app.read_company_health() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.company COLLATE "C", h.source COLLATE "C"), '[]'::jsonb))
  FROM (
    SELECT coalesce(j.company, sc.company_lc) AS company, coalesce(j.source, sc.source) AS source, j.latest_first_seen,
      sc.last_scraped_at, sc.last_ok_at, sc.jobs_found, sc.last_error, sc.failures
    FROM (
      SELECT lower(j.company_name) AS company, j.source, max(j.first_seen_at) AS latest_first_seen
      FROM app.jobs j
      WHERE j.source IS NOT NULL AND j.source <> 'linkedin' AND j.company_name IS NOT NULL
      GROUP BY lower(j.company_name), j.source
    ) j
    FULL JOIN app.scrape_companies sc ON sc.source = j.source AND sc.company_lc = btrim(j.company)
  ) h
$$;

-- Admin System tab: database size, counts, the published snapshot, the last pipeline runs (with what their publish
-- did), the last scrapes per source and the LinkedIn search cap
CREATE OR REPLACE FUNCTION app.read_system_status() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH runs AS (
    SELECT r.run_id, r.started_at, r.ended_at, r.duration_s, r.state, r.result, r.message, r.trigger, r.tasks,
      h.published_at, (h.counts ->> 'jobs')::bigint AS published_jobs, h.upserted, h.deleted_jobs
    FROM app.pipeline_runs r
    LEFT JOIN app.publish_history h ON h.run_id = r.run_id
    ORDER BY r.started_at DESC NULLS LAST, r.run_id DESC
    LIMIT 20
  ),
  -- before the first recorded run: what the publishes did
  published AS (
    SELECT h.run_id, NULL::timestamptz AS started_at, NULL::timestamptz AS ended_at, NULL::int AS duration_s,
      NULL::text AS state, NULL::text AS result, NULL::text AS message, NULL::text AS trigger, '[]'::jsonb AS tasks,
      h.published_at, (h.counts ->> 'jobs')::bigint AS published_jobs, h.upserted, h.deleted_jobs
    FROM app.publish_history h
    WHERE NOT EXISTS (SELECT 1 FROM app.pipeline_runs)
    ORDER BY h.published_at DESC, h.run_id DESC
    LIMIT 20
  ),
  scrapes AS (
    SELECT s.*, row_number() OVER (PARTITION BY s.source ORDER BY s.finished_at DESC, s.id DESC) AS rn
    FROM app.scrape_runs s
  )
  SELECT jsonb_build_object('rows', jsonb_build_array(jsonb_build_object(
    'database', jsonb_build_object('bytes', pg_database_size(current_database()), 'limit_bytes', 524288000),
    'counts', jsonb_build_object(
      'jobs', (SELECT count(*) FROM app.jobs),
      'active_jobs', (SELECT count(*) FROM app.jobs j WHERE coalesce(j.is_active, true)),
      'tracked_jobs', (SELECT count(DISTINCT s.job_key) FROM app.user_job_state s
                       WHERE (s.is_applied OR s.application_status <> 'not_applied')
                         AND EXISTS (SELECT 1 FROM app.jobs j WHERE j.job_key = s.job_key)),
      'profiles', (SELECT count(*) FROM app.user_profile),
      'allowed_emails', (SELECT count(*) FROM app.allowed_emails)),
    'publish', (SELECT jsonb_build_object('run_id', ps.run_id, 'snapshot_at', ps.snapshot_at, 'published_at', ps.published_at,
                                          'jobs', (ps.counts ->> 'jobs')::bigint)
                FROM app.pipeline_status ps WHERE ps.id = 1),
    'runs', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.started_at DESC NULLS LAST, r.published_at DESC NULLS LAST, r.run_id DESC)
                      FROM (SELECT * FROM runs UNION ALL SELECT * FROM published) r), '[]'::jsonb),
    'scrapes', coalesce((SELECT jsonb_agg(jsonb_build_object(
                           'source', s.source, 'started_at', s.started_at, 'finished_at', s.finished_at, 'status', s.status,
                           'companies', s.companies, 'failed', s.failed, 'jobs_scraped', s.jobs_scraped,
                           'jobs_written', s.jobs_written, 'missing_descriptions', s.missing_descriptions,
                           'message', s.message, 'workflow', s.workflow, 'github_run_id', s.github_run_id,
                           'github_run_attempt', s.github_run_attempt)
                         ORDER BY s.source COLLATE "C", s.finished_at DESC, s.id DESC)
                         FROM scrapes s WHERE s.rn <= 5), '[]'::jsonb),
    'linkedin', (SELECT jsonb_build_object('finished_at', s.finished_at, 'searches_total', s.searches_total,
                                           'searches_cap', s.searches_cap, 'dropped', to_jsonb(s.dropped_searches))
                 FROM scrapes s WHERE s.source = 'linkedin' AND s.rn = 1),
    'generated_at', now()
  )))
$$;

-- =====================================================================================================================
-- Write actions
-- =====================================================================================================================

-- Today's activity row (UTC day): first_at / last_at and the triage counters, each kept at 0 or more. visits is not
-- touched (only app.write_ping counts visits).
CREATE OR REPLACE FUNCTION app.bump_activity(p_uid uuid, p_saved int, p_applied int, p_hidden int, p_acted_strong int)
RETURNS void
LANGUAGE sql VOLATILE AS $$
  INSERT INTO app.user_activity_day AS a (user_id, day, first_at, last_at, saved, applied, hidden, acted_strong)
  VALUES (p_uid, current_date, now(), now(), greatest(0, coalesce(p_saved, 0)), greatest(0, coalesce(p_applied, 0)),
          greatest(0, coalesce(p_hidden, 0)), greatest(0, coalesce(p_acted_strong, 0)))
  ON CONFLICT (user_id, day) DO UPDATE SET
    first_at = coalesce(a.first_at, now()),
    last_at = now(),
    saved = greatest(0, a.saved + coalesce(p_saved, 0)),
    applied = greatest(0, a.applied + coalesce(p_applied, 0)),
    hidden = greatest(0, a.hidden + coalesce(p_hidden, 0)),
    acted_strong = greatest(0, a.acted_strong + coalesce(p_acted_strong, 0))
$$;

-- The jobs a triage write acts on as they are before it (app.user_jobs rows, a primary-key lookup per key; keys not
-- in app.jobs are left out). Passed to app.record_triage after the write. plpgsql, so the session keeps the plan (a
-- SQL function around app.user_jobs is planned again on every call, which costs more than running it).
CREATE OR REPLACE FUNCTION app.triage_before(p_uid uuid, p_keys text[]) RETURNS app.user_job[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_rows app.user_job[];
BEGIN
  SELECT coalesce(array_agg(u), '{}'::app.user_job[]) INTO v_rows FROM app.user_jobs(p_uid) u WHERE u.job_key = ANY (p_keys);
  RETURN v_rows;
END
$$;

-- After a triage write (setApplied, setStatus, setHidden, setNote, restoreHidden): compares each job's state before
-- (app.triage_before) and now, then
--   * fit_at_action := the job's fit_score when it went from untracked (no row, or not_applied and not applied) to a
--     tracked status, or from not applied to applied; left alone otherwise (also when it goes back to not_applied)
--   * today's activity counters (app.bump_activity), net of same-day undos:
--       saved     +1 the status became saved with a status_updated_at of today, except the Undo of today's saved ->
--                 applied (applied_at today, statusUpdatedAt put back to the save: that save was never taken back);
--                 an Undo that puts back an older day's save is not a new one either; -1 saved ->
--                 not_applied when the save was today (saved -> applied is progress, not an undo)
--       applied   +1 is_applied false -> true with applied_at today (an Undo that puts back an older application is
--                 not a new one); -1 true -> false when applied_at is today
--       hidden    +1 is_hidden false -> true; -1 true -> false when hidden_at is today (unhide, restore, or a save
--                 that unhides)
--       acted_strong  +1 an untouched job (not tracked, not hidden) that is For you, not muted and fit >= STRONG_FIT
--                 became tracked or hidden and one of the counters above went up; -1 the reverse, back to untouched, when one of the counters above was taken
--                 back (the state was entered today)
--     A same-day undo across days (hidden yesterday, restored today) is not taken back, so acted_strong is approximate.
CREATE OR REPLACE FUNCTION app.record_triage(p_uid uuid, p_before app.user_job[]) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_saved int;
  v_applied int;
  v_hidden int;
  v_acted int;
BEGIN
  IF coalesce(cardinality(p_before), 0) = 0 THEN
    RETURN; -- nothing written (no such job)
  END IF;
  WITH b AS (
    SELECT * FROM unnest(p_before)
  ),
  a AS (
    SELECT u.* FROM app.user_jobs(p_uid) u WHERE u.job_key = ANY (ARRAY(SELECT b.job_key FROM b))
  ),
  c AS (
    SELECT b.job_key, a.fit_score,
      (NOT b.is_tracked AND a.is_tracked) OR (NOT b.is_applied AND a.is_applied) AS set_fit,
      CASE WHEN a.application_status = 'saved' AND b.application_status <> 'saved'
                AND coalesce((a.status_updated_at AT TIME ZONE 'UTC')::date >= current_date, true)
                AND NOT (b.is_applied AND coalesce((b.applied_at AT TIME ZONE 'UTC')::date = current_date, false)
                         AND coalesce(a.status_updated_at < b.status_updated_at, false)) THEN 1
           WHEN b.application_status = 'saved' AND a.application_status = 'not_applied'
                AND coalesce((b.status_updated_at AT TIME ZONE 'UTC')::date = current_date, false) THEN -1
           ELSE 0 END AS saved,
      CASE WHEN a.is_applied AND NOT b.is_applied AND coalesce((a.applied_at AT TIME ZONE 'UTC')::date >= current_date, true) THEN 1
           WHEN b.is_applied AND NOT a.is_applied AND coalesce((b.applied_at AT TIME ZONE 'UTC')::date = current_date, false) THEN -1
           ELSE 0 END AS applied,
      CASE WHEN a.is_hidden AND NOT b.is_hidden THEN 1
           WHEN b.is_hidden AND NOT a.is_hidden AND coalesce((b.hidden_at AT TIME ZONE 'UTC')::date = current_date, false) THEN -1
           ELSE 0 END AS hidden,
      NOT b.is_tracked AND NOT b.is_hidden AS untouched_before,
      NOT a.is_tracked AND NOT a.is_hidden AS untouched_after,
      b.in_for_you AND b.muted_by IS NULL AND coalesce(b.fit_score, 0) >= app.c_strong_fit() AS strong_before,
      a.in_for_you AND a.muted_by IS NULL AND coalesce(a.fit_score, 0) >= app.c_strong_fit() AS strong_after
    FROM b
    JOIN a ON a.job_key = b.job_key
  ),
  d AS (
    SELECT c.*,
      CASE WHEN c.untouched_before AND NOT c.untouched_after AND c.strong_before
                AND (c.saved > 0 OR c.applied > 0 OR c.hidden > 0) THEN 1
           WHEN NOT c.untouched_before AND c.untouched_after AND c.strong_after
                AND (c.saved < 0 OR c.applied < 0 OR c.hidden < 0) THEN -1
           ELSE 0 END AS acted
    FROM c
  ),
  fit AS (
    UPDATE app.user_job_state s SET fit_at_action = greatest(0, least(100, d.fit_score))
    FROM d
    WHERE d.set_fit AND d.fit_score IS NOT NULL AND s.user_id = p_uid AND s.job_key = d.job_key
    RETURNING s.job_key
  )
  SELECT coalesce(sum(d.saved), 0), coalesce(sum(d.applied), 0), coalesce(sum(d.hidden), 0), coalesce(sum(d.acted), 0)
  INTO v_saved, v_applied, v_hidden, v_acted
  FROM d;
  PERFORM app.bump_activity(p_uid, v_saved, v_applied, v_hidden, v_acted);
END
$$;

-- Per-user flags; a row is only written for a job that exists in app.jobs (else 0 affected rows).
-- setApplied (kept for older clients): true keeps a stage you already reached (interviewing, offer, ...), else
-- 'applied'; false = 'not_applied'. status_updated_at moves only when the status changes.
CREATE OR REPLACE FUNCTION app.write_set_applied(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_key text := app.req_job_key(p -> 'jobKey');
  v_applied boolean := app.req_bool(p -> 'applied');
  v_before app.user_job[] := app.triage_before(p_uid, ARRAY[v_key]);
  v_n bigint;
BEGIN
  INSERT INTO app.user_job_state AS t
    (user_id, job_key, is_applied, applied_at, is_hidden, hidden_at, application_status, status_updated_at, updated_at)
  SELECT p_uid, j.job_key, v_applied, CASE WHEN v_applied THEN now() END, false, NULL,
    CASE WHEN v_applied THEN 'applied' ELSE 'not_applied' END, now(), now()
  FROM app.jobs j
  WHERE j.job_key = v_key
  ON CONFLICT (user_id, job_key) DO UPDATE SET
    is_applied = v_applied,
    applied_at = CASE WHEN v_applied THEN coalesce(t.applied_at, now()) END,
    application_status = CASE
      WHEN NOT v_applied THEN 'not_applied'
      WHEN t.application_status = ANY (app.c_applied_statuses()) THEN t.application_status
      ELSE 'applied'
    END,
    status_updated_at = CASE
      WHEN (CASE WHEN NOT v_applied THEN 'not_applied'
                 WHEN t.application_status = ANY (app.c_applied_statuses()) THEN t.application_status
                 ELSE 'applied' END) IS DISTINCT FROM t.application_status THEN now()
      ELSE t.status_updated_at
    END,
    updated_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM app.record_triage(p_uid, v_before);
  RETURN jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('num_affected_rows', v_n)));
END
$$;

-- {jobKey | jobKeys, status, appliedAt?, statusUpdatedAt?}: any of the application statuses. The applied ones set
-- is_applied (applied_at = the first time); a tracked status (anything but not_applied) also unhides the job. Note and
-- follow-up date are kept. appliedAt / statusUpdatedAt (an undo putting a job back): the times to restore instead of
-- now() (applied_at only when the job has none; never later than now), so an undo does not restart the follow-up clock.
CREATE OR REPLACE FUNCTION app.write_set_status(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_keys text[] := app.req_job_keys(p);
  v_status text := CASE WHEN jsonb_typeof(p -> 'status') = 'string' THEN p ->> 'status' END;
  v_applied_at timestamptz := app.js_timestamp(p -> 'appliedAt');
  v_stamp timestamptz := app.js_timestamp(p -> 'statusUpdatedAt');
  v_applied boolean;
  v_tracked boolean;
  v_before app.user_job[];
  v_n bigint;
BEGIN
  IF v_status IS NULL OR NOT v_status = ANY (app.c_application_statuses()) THEN
    PERFORM app.fail('Invalid status');
  END IF;
  IF (nullif(p -> 'appliedAt', 'null'::jsonb) IS NOT NULL AND v_applied_at IS NULL)
     OR (nullif(p -> 'statusUpdatedAt', 'null'::jsonb) IS NOT NULL AND v_stamp IS NULL) THEN
    PERFORM app.fail('Invalid date');
  END IF;
  -- never later than now (NULL, not given, stays NULL)
  v_applied_at := CASE WHEN v_applied_at > now() THEN now() ELSE v_applied_at END;
  v_stamp := CASE WHEN v_stamp > now() THEN now() ELSE v_stamp END;
  v_applied := v_status = ANY (app.c_applied_statuses());
  v_tracked := v_status <> 'not_applied';
  v_before := app.triage_before(p_uid, v_keys);
  INSERT INTO app.user_job_state AS t
    (user_id, job_key, is_applied, applied_at, is_hidden, hidden_at, application_status, status_updated_at, updated_at)
  SELECT p_uid, j.job_key, v_applied, CASE WHEN v_applied THEN coalesce(v_applied_at, now()) END, false, NULL, v_status,
    coalesce(v_stamp, now()), now()
  FROM app.jobs j
  WHERE j.job_key = ANY (v_keys)
  ON CONFLICT (user_id, job_key) DO UPDATE SET
    is_applied = v_applied,
    applied_at = CASE WHEN v_applied THEN coalesce(t.applied_at, v_applied_at, now()) END,
    application_status = v_status,
    status_updated_at = CASE WHEN t.application_status IS DISTINCT FROM v_status THEN coalesce(v_stamp, now())
                             ELSE t.status_updated_at END,
    is_hidden = t.is_hidden AND NOT v_tracked,
    hidden_at = CASE WHEN v_tracked THEN NULL ELSE t.hidden_at END,
    hide_reason = CASE WHEN v_tracked THEN NULL ELSE t.hide_reason END,
    updated_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM app.record_triage(p_uid, v_before);
  RETURN jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('num_affected_rows', v_n, 'status', v_status)));
END
$$;

-- {jobKey | jobKeys, hidden, reason?}: a reason (one of the hide reasons) is kept with the hidden job and recorded in
-- app.job_feedback; unhiding clears both (an undo or a restore takes the judgement back)
CREATE OR REPLACE FUNCTION app.write_set_hidden(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_keys text[] := app.req_job_keys(p);
  v_hidden boolean := app.req_bool(p -> 'hidden');
  v_reason_value jsonb := nullif(p -> 'reason', 'null'::jsonb);
  v_reason text;
  v_before app.user_job[];
  v_n bigint;
BEGIN
  IF v_reason_value IS NOT NULL THEN
    v_reason := CASE WHEN jsonb_typeof(v_reason_value) = 'string' THEN v_reason_value #>> '{}' END;
    IF v_reason IS NULL OR NOT v_reason = ANY (app.c_hide_reasons()) THEN
      PERFORM app.fail('Invalid hide reason');
    END IF;
  END IF;
  v_before := app.triage_before(p_uid, v_keys);
  INSERT INTO app.user_job_state AS t
    (user_id, job_key, is_applied, applied_at, is_hidden, hidden_at, hide_reason, application_status, status_updated_at, updated_at)
  SELECT p_uid, j.job_key, false, NULL, v_hidden, CASE WHEN v_hidden THEN now() END, CASE WHEN v_hidden THEN v_reason END,
    'not_applied', now(), now()
  FROM app.jobs j
  WHERE j.job_key = ANY (v_keys)
  ON CONFLICT (user_id, job_key) DO UPDATE SET
    is_hidden = v_hidden,
    hidden_at = CASE WHEN v_hidden THEN now() END,
    hide_reason = CASE WHEN v_hidden THEN coalesce(v_reason, t.hide_reason) END,
    updated_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF NOT v_hidden THEN
    DELETE FROM app.job_feedback f WHERE f.user_id = p_uid AND f.job_key = ANY (v_keys);
  END IF;
  IF v_hidden AND v_reason IS NOT NULL THEN
    INSERT INTO app.job_feedback AS f (user_id, job_key, reason, title, company_name, role_title, experience_level, created_at)
    SELECT p_uid, j.job_key, v_reason, j.title, j.company_name, j.role_title, j.experience_level, now()
    FROM app.jobs j
    WHERE j.job_key = ANY (v_keys)
    ON CONFLICT (user_id, job_key) DO UPDATE SET
      reason = EXCLUDED.reason, title = EXCLUDED.title, company_name = EXCLUDED.company_name,
      role_title = EXCLUDED.role_title, experience_level = EXCLUDED.experience_level, created_at = EXCLUDED.created_at;
  END IF;
  -- last: the activity row is the last lock a write takes (pipeline_publish_finish also takes it last)
  PERFORM app.record_triage(p_uid, v_before);
  RETURN jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('num_affected_rows', v_n)));
END
$$;

-- {jobKey, note?, nextActionAt?}: a private note (trimmed, at most NOTE_MAX_LENGTH characters, '' or null = none) and a
-- follow-up date within a year of today ('' or null = none). A key left out keeps the stored value (a snooze sends only
-- nextActionAt). A note or a date on a job you have not saved or applied to (after the merge) saves (and unhides) it,
-- so it outlives the posting's expiry.
CREATE OR REPLACE FUNCTION app.write_set_note(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_key text := app.req_job_key(p -> 'jobKey');
  v_note_value jsonb := p -> 'note';
  v_date_value jsonb := p -> 'nextActionAt';
  v_note text;
  v_date date;
  v_keep boolean;
  v_status text;
  v_old_note text;
  v_old_date date;
  v_before app.user_job[];
  v_n bigint;
BEGIN
  IF v_note_value IS NOT NULL AND jsonb_typeof(v_note_value) NOT IN ('string', 'null') THEN
    PERFORM app.fail('Note must be text');
  END IF;
  IF jsonb_typeof(v_note_value) = 'string' THEN
    v_note := nullif(app.js_trim(v_note_value #>> '{}'), '');
  END IF;
  IF char_length(v_note) > app.c_note_max_length() THEN
    PERFORM app.fail(format('Note: at most %s characters', app.c_note_max_length()));
  END IF;
  IF v_date_value IS NOT NULL AND v_date_value NOT IN ('null'::jsonb, '""'::jsonb) THEN
    IF jsonb_typeof(v_date_value) = 'string' AND (v_date_value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      BEGIN
        v_date := (v_date_value #>> '{}')::date;
      EXCEPTION WHEN others THEN
        v_date := NULL; -- not a real date (2026-02-30)
      END;
    END IF;
    IF v_date IS NULL OR abs(v_date - current_date) > 366 THEN
      PERFORM app.fail('Invalid follow-up date');
    END IF;
  END IF;
  -- left out: the stored value (none without a row; FOR UPDATE: the merge and the write see the same row)
  IF v_note_value IS NULL OR v_date_value IS NULL THEN
    SELECT st.note, st.next_action_at INTO v_old_note, v_old_date
    FROM app.user_job_state st
    WHERE st.user_id = p_uid AND st.job_key = v_key
    FOR UPDATE;
    IF v_note_value IS NULL THEN
      v_note := v_old_note;
    END IF;
    IF v_date_value IS NULL THEN
      v_date := v_old_date;
    END IF;
  END IF;
  v_keep := v_note IS NOT NULL OR v_date IS NOT NULL;
  v_before := app.triage_before(p_uid, ARRAY[v_key]);

  INSERT INTO app.user_job_state AS t
    (user_id, job_key, note, next_action_at, application_status, status_updated_at, updated_at)
  SELECT p_uid, j.job_key, v_note, v_date, CASE WHEN v_keep THEN 'saved' ELSE 'not_applied' END, now(), now()
  FROM app.jobs j
  WHERE j.job_key = v_key
  ON CONFLICT (user_id, job_key) DO UPDATE SET
    note = v_note,
    next_action_at = v_date,
    application_status = CASE WHEN v_keep AND t.application_status = 'not_applied' AND NOT t.is_applied THEN 'saved'
                              ELSE t.application_status END,
    status_updated_at = CASE WHEN v_keep AND t.application_status = 'not_applied' AND NOT t.is_applied THEN now()
                             ELSE t.status_updated_at END,
    -- saving unhides, as setStatus 'saved' does (a hidden saved job would be missing from the Saved tab)
    is_hidden = t.is_hidden AND NOT (v_keep AND t.application_status = 'not_applied' AND NOT t.is_applied),
    hidden_at = CASE WHEN v_keep AND t.application_status = 'not_applied' AND NOT t.is_applied THEN NULL ELSE t.hidden_at END,
    hide_reason = CASE WHEN v_keep AND t.application_status = 'not_applied' AND NOT t.is_applied THEN NULL ELSE t.hide_reason END,
    updated_at = now()
  RETURNING t.application_status INTO v_status;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM app.record_triage(p_uid, v_before);
  RETURN jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('num_affected_rows', v_n, 'application_status', v_status)));
END
$$;

CREATE OR REPLACE FUNCTION app.write_restore_hidden(p_uid uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_before app.user_job[] := app.triage_before(p_uid, ARRAY(
    SELECT st.job_key FROM app.user_job_state st WHERE st.user_id = p_uid AND st.is_hidden));
  v_n bigint;
BEGIN
  -- As setHidden false, the restored jobs' feedback goes too
  WITH restored AS (
    UPDATE app.user_job_state SET is_hidden = false, hidden_at = NULL, hide_reason = NULL, updated_at = now()
    WHERE user_id = p_uid AND is_hidden
    RETURNING job_key
  ), dropped AS (
    DELETE FROM app.job_feedback f WHERE f.user_id = p_uid AND f.job_key IN (SELECT r.job_key FROM restored r)
  )
  SELECT count(*) INTO v_n FROM restored;
  PERFORM app.record_triage(p_uid, v_before);
  RETURN jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('num_affected_rows', v_n)));
END
$$;

-- {companies?, titleWords?, levels?}: mute rules (see app.user_jobs); a list left out or null keeps the saved one
CREATE OR REPLACE FUNCTION app.write_save_mute_rules(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_companies text[];
  v_words text[];
  v_levels text[];
  v_item text;
  v_saved record;
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.user_profile up WHERE up.profile_id = p_uid) THEN
    PERFORM app.fail('Save your profile first');
  END IF;
  IF nullif(p -> 'companies', 'null'::jsonb) IS NOT NULL THEN
    v_companies := app.string_list(p -> 'companies', app.c_max_muted_companies(), 100, 'Muted companies');
  END IF;
  IF nullif(p -> 'titleWords', 'null'::jsonb) IS NOT NULL THEN
    v_words := app.string_list(p -> 'titleWords', app.c_max_muted_title_words(), 40, 'Muted title words');
  END IF;
  IF nullif(p -> 'levels', 'null'::jsonb) IS NOT NULL THEN
    v_levels := app.string_list(p -> 'levels', cardinality(app.c_experience_levels()), 40, 'Muted levels');
  END IF;
  FOREACH v_item IN ARRAY coalesce(v_companies, '{}'::text[]) LOOP
    IF char_length(v_item) < 2 THEN
      PERFORM app.fail(format('Muted companies: "%s" - Too short', left(v_item, 30)));
    END IF;
    IF app.company_key(v_item) = '' THEN
      PERFORM app.fail(format('Muted companies: "%s" - Not a company name', left(v_item, 30)));
    END IF;
  END LOOP;
  FOREACH v_item IN ARRAY coalesce(v_words, '{}'::text[]) LOOP
    IF char_length(v_item) < 2 THEN
      PERFORM app.fail(format('Muted title words: "%s" - Too short', left(v_item, 30)));
    END IF;
    IF v_item !~ app.c_mute_word_re() THEN
      PERFORM app.fail(format('Muted title words: "%s" - Use letters, numbers, spaces and . + # & / - only', left(v_item, 30)));
    END IF;
  END LOOP;
  FOREACH v_item IN ARRAY coalesce(v_levels, '{}'::text[]) LOOP
    IF NOT v_item = ANY (app.c_experience_levels()) THEN
      PERFORM app.fail(format('Muted levels: "%s" is not a level', left(v_item, 30)));
    END IF;
  END LOOP;
  UPDATE app.user_profile up SET
    muted_companies = coalesce(v_companies, up.muted_companies),
    muted_title_words = coalesce(v_words, up.muted_title_words),
    muted_levels = coalesce(v_levels, up.muted_levels),
    updated_at = now()
  WHERE up.profile_id = p_uid
  RETURNING up.muted_companies, up.muted_title_words, up.muted_levels INTO v_saved;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('num_affected_rows', v_n,
    'muted_companies', v_saved.muted_companies, 'muted_title_words', v_saved.muted_title_words,
    'muted_levels', v_saved.muted_levels)));
END
$$;

-- 1-2 roles, 1-5 skills, 0-10 also-know skills and 0-3 preferred cities (port of sql.mjs validateProfile, same order
-- and messages). Roles and skills not in the lists are allowed (the pipeline checks new roles); roles known to be outside
-- the supported scope and cities not in app.ref_cities are refused. preferred_cities or also_skills left out (or null)
-- keep the saved ones (kept also-know skills that became core skills are dropped). Cities are saved in the list's
-- spelling (Bangalore -> Bengaluru).
CREATE OR REPLACE FUNCTION app.write_save_profile(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_roles text[];
  v_skills text[];
  v_also text[];
  v_min int;
  v_max int;
  v_cities text[];
  v_canonical text[];
  v_item text;
  v_problem text;
  v_label text;
  v_n bigint;
BEGIN
  v_roles := app.string_list(coalesce(nullif(p -> 'target_roles', 'null'::jsonb), '[]'::jsonb),
    app.c_max_roles(), app.c_entry_max_length(), 'Roles');
  v_skills := app.string_list(coalesce(nullif(p -> 'skills', 'null'::jsonb), '[]'::jsonb),
    app.c_max_skills(), app.c_entry_max_length(), 'Skills');
  IF p -> 'also_skills' IS NOT NULL AND p -> 'also_skills' <> 'null'::jsonb THEN
    v_also := app.string_list(p -> 'also_skills', app.c_max_also_skills(), app.c_entry_max_length(), 'Also know');
  END IF;
  v_min := app.js_int(p -> 'min_years', 0, 40);
  v_max := app.js_int(p -> 'max_years', 0, 40);
  IF p -> 'preferred_cities' IS NOT NULL AND p -> 'preferred_cities' <> 'null'::jsonb THEN
    v_cities := app.string_list(p -> 'preferred_cities', app.c_max_cities(), app.c_entry_max_length(), 'Preferred cities');
  END IF;

  FOREACH v_item IN ARRAY coalesce(v_cities, '{}'::text[]) LOOP
    IF v_item !~ app.c_city_re() THEN
      PERFORM app.fail(format('Preferred cities: "%s" is not a city name', left(v_item, 30)));
    END IF;
  END LOOP;
  IF cardinality(v_roles) = 0 THEN
    PERFORM app.fail('Pick at least one role');
  END IF;
  IF cardinality(v_skills) = 0 THEN
    PERFORM app.fail('Pick at least one skill');
  END IF;
  FOREACH v_label IN ARRAY ARRAY['Roles', 'Skills'] LOOP
    FOREACH v_item IN ARRAY CASE WHEN v_label = 'Roles' THEN v_roles ELSE v_skills END LOOP
      v_problem := app.entry_problem(v_item);
      IF v_problem <> '' THEN
        PERFORM app.fail(format('%s: "%s" - %s', v_label, left(v_item, 30), v_problem));
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_item IN ARRAY coalesce(v_also, '{}'::text[]) LOOP
    v_problem := app.entry_problem(v_item);
    IF v_problem <> '' THEN
      PERFORM app.fail(format('Also know: "%s" - %s', left(v_item, 30), v_problem));
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_skills) AS k(skill) WHERE lower(k.skill) = lower(v_item)) THEN
      PERFORM app.fail(format('Also know: "%s" is already a core skill', left(v_item, 30)));
    END IF;
  END LOOP;
  IF v_min IS NOT NULL AND v_max IS NOT NULL AND v_min > v_max THEN
    PERFORM app.fail('Minimum years cannot be more than maximum years');
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_roles) AS r(role)
    WHERE lower(r.role) IN (
      SELECT lower(rr.role_title) FROM app.ref_roles rr WHERE NOT rr.in_scope
      UNION ALL SELECT lower(cr.role_title) FROM app.custom_roles cr WHERE cr.status = 'rejected'
    )
  ) THEN
    PERFORM app.fail('We only support data, full stack, backend, DevOps and cloud roles');
  END IF;

  IF v_cities IS NOT NULL THEN
    WITH names AS (
      SELECT n.name, max(n.city) AS city
      FROM (
        SELECT lower(trim(l.alias)) AS name, l.city FROM app.ref_cities l WHERE l.city IS NOT NULL AND l.city <> 'India'
        UNION ALL SELECT lower(l.city), l.city FROM app.ref_cities l WHERE l.city IS NOT NULL AND l.city <> 'India'
      ) n
      WHERE n.name IS NOT NULL
      GROUP BY n.name
    ),
    picked AS (
      SELECT c.ord, nm.city
      FROM unnest(v_cities) WITH ORDINALITY AS c(city, ord)
      LEFT JOIN names nm ON nm.name = lower(trim(c.city))
    )
    SELECT CASE WHEN bool_and(pk.city IS NOT NULL) OR count(*) = 0 THEN
             coalesce((SELECT array_agg(d.city ORDER BY d.first_ord)
                       FROM (SELECT x.city, min(x.ord) AS first_ord FROM picked x GROUP BY x.city) d), '{}'::text[])
           END
    INTO v_canonical
    FROM picked pk;
    IF v_canonical IS NULL THEN
      PERFORM app.fail('Preferred cities: pick Indian cities from the list');
    END IF;
  END IF;

  INSERT INTO app.user_profile AS t (profile_id, email, target_roles, skills, also_skills, min_years, max_years,
                                     preferred_cities, updated_at)
  VALUES (p_uid, nullif(app.js_text(auth.jwt() -> 'email', 320), ''), v_roles, v_skills, coalesce(v_also, '{}'::text[]),
          v_min, v_max, coalesce(v_canonical, '{}'::text[]), now())
  ON CONFLICT (profile_id) DO UPDATE SET
    email = EXCLUDED.email,
    target_roles = EXCLUDED.target_roles,
    skills = EXCLUDED.skills,
    also_skills = coalesce(v_also, ARRAY(
      SELECT a.skill FROM unnest(t.also_skills) WITH ORDINALITY AS a(skill, ord)
      WHERE NOT EXISTS (SELECT 1 FROM unnest(EXCLUDED.skills) AS k(skill) WHERE lower(k.skill) = lower(a.skill))
      ORDER BY a.ord)),
    min_years = EXCLUDED.min_years,
    max_years = EXCLUDED.max_years,
    preferred_cities = coalesce(v_canonical, t.preferred_cities),
    updated_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('num_affected_rows', v_n)));
END
$$;

-- {opened?, promptYes?, promptNo?, promptSaved?}: the client's throttled "I am looking at the list" (src/hooks/useVisit.js).
-- Each count is an integer from 0 to c_max_ping_count() (left out or null = 0). Moves last_list_seen_at to now (an
-- existing profile only: no profile row is ever created here, onboarding relies on profile returning none) and adds to
-- today's activity row: a visit when the row is new or has none yet, or after c_visit_gap_minutes() without a ping or
-- write; the counts. Returns the previous last_list_seen_at ("new since your last visit").
CREATE OR REPLACE FUNCTION app.write_ping(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_name text;
  v_value jsonb;
  v_counts int[] := '{}';
  v_prev timestamptz;
  v_has_profile boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['opened', 'promptYes', 'promptNo', 'promptSaved'] LOOP
    v_value := nullif(p -> v_name, 'null'::jsonb);
    IF v_value IS NULL THEN
      v_counts := v_counts || 0;
      CONTINUE;
    END IF;
    -- two steps: the cast runs only on a checked string (OR does not promise an evaluation order)
    IF jsonb_typeof(v_value) <> 'number' OR (v_value #>> '{}') !~ '^[0-9]{1,9}$' THEN
      PERFORM app.fail('Invalid count');
    END IF;
    IF (v_value #>> '{}')::int > app.c_max_ping_count() THEN
      PERFORM app.fail('Invalid count');
    END IF;
    v_counts := v_counts || (v_value #>> '{}')::int;
  END LOOP;

  SELECT up.last_list_seen_at INTO v_prev FROM app.user_profile up WHERE up.profile_id = p_uid FOR UPDATE;
  v_has_profile := FOUND;
  IF v_has_profile THEN
    UPDATE app.user_profile up SET last_list_seen_at = now() WHERE up.profile_id = p_uid;
  END IF;

  INSERT INTO app.user_activity_day AS a (user_id, day, first_at, last_at, visits, opened, prompt_yes, prompt_no, prompt_saved)
  VALUES (p_uid, current_date, now(), now(), 1, v_counts[1], v_counts[2], v_counts[3], v_counts[4])
  ON CONFLICT (user_id, day) DO UPDATE SET
    first_at = coalesce(a.first_at, now()),
    visits = a.visits + CASE WHEN a.visits = 0 OR a.last_at IS NULL
                               OR now() - a.last_at >= make_interval(mins => app.c_visit_gap_minutes()) THEN 1 ELSE 0 END,
    last_at = now(),
    opened = a.opened + EXCLUDED.opened,
    prompt_yes = a.prompt_yes + EXCLUDED.prompt_yes,
    prompt_no = a.prompt_no + EXCLUDED.prompt_no,
    prompt_saved = a.prompt_saved + EXCLUDED.prompt_saved;

  RETURN jsonb_build_object('rows', jsonb_build_array(jsonb_build_object(
    'previous_seen_at', v_prev, 'seen_at', now(), 'has_profile', v_has_profile)));
END
$$;

CREATE OR REPLACE FUNCTION app.write_set_allowed_email(p_uid uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_email text := lower(app.js_text(p -> 'email', 320));
  v_allowed boolean;
  v_n bigint;
BEGIN
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    PERFORM app.fail('Invalid email');
  END IF;
  v_allowed := app.req_bool(p -> 'allowed');
  IF v_allowed THEN
    INSERT INTO app.allowed_emails (email, added_by) VALUES (v_email, p_uid) ON CONFLICT (email) DO NOTHING;
  ELSE
    DELETE FROM app.allowed_emails WHERE email = v_email;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('num_affected_rows', v_n)));
END
$$;

-- =====================================================================================================================
-- Public dispatchers (supabase.rpc('app_read' | 'app_write', {action, params}))
-- =====================================================================================================================

CREATE OR REPLACE FUNCTION public.app_read(action text, params jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET "TimeZone" = 'UTC' SET extra_float_digits = 1
AS $$
#variable_conflict use_column
DECLARE
  v_action text := $1;
  v_params jsonb := CASE WHEN jsonb_typeof($2) = 'object' THEN $2 ELSE '{}'::jsonb END;
  c record;
BEGIN
  SELECT * INTO c FROM app.require_caller();
  IF v_action IN ('allowedEmails', 'companyHealth', 'systemStatus', 'metrics') AND NOT c.caller_is_admin THEN
    RAISE EXCEPTION USING MESSAGE = 'Admins only', ERRCODE = '42501';
  END IF;
  CASE v_action
    WHEN 'jobs' THEN RETURN app.read_jobs(c.caller_uid, v_params);
    WHEN 'summary' THEN RETURN app.read_summary(c.caller_uid, v_params);
    WHEN 'trend' THEN RETURN app.read_trend(c.caller_uid, v_params);
    WHEN 'facets' THEN RETURN app.read_facets(c.caller_uid, v_params);
    WHEN 'job' THEN RETURN app.read_job(v_params);
    WHEN 'jobRow' THEN RETURN app.read_job_row(c.caller_uid, v_params);
    WHEN 'jobGroup' THEN RETURN app.read_job_group(c.caller_uid, v_params);
    WHEN 'jobNote' THEN RETURN app.read_job_note(c.caller_uid, v_params);
    WHEN 'trackedJobs' THEN RETURN app.read_tracked_jobs(c.caller_uid);
    WHEN 'hiddenJobs' THEN RETURN app.read_hidden_jobs(c.caller_uid);
    WHEN 'profile' THEN RETURN app.read_profile(c.caller_uid);
    WHEN 'refs' THEN RETURN app.read_refs();
    WHEN 'status' THEN RETURN app.read_status();
    WHEN 'allowedEmails' THEN RETURN app.read_allowed_emails();
    WHEN 'companyHealth' THEN RETURN app.read_company_health();
    WHEN 'systemStatus' THEN RETURN app.read_system_status();
    WHEN 'metrics' THEN RETURN app.read_metrics();
    ELSE
      RAISE EXCEPTION USING MESSAGE = 'Unknown action: ' || left(coalesce(v_action, 'undefined'), 40), ERRCODE = '22023';
  END CASE;
END
$$;

CREATE OR REPLACE FUNCTION public.app_write(action text, params jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = '' SET "TimeZone" = 'UTC' SET extra_float_digits = 1
AS $$
#variable_conflict use_column
DECLARE
  v_action text := $1;
  v_params jsonb := CASE WHEN jsonb_typeof($2) = 'object' THEN $2 ELSE '{}'::jsonb END;
  c record;
BEGIN
  SELECT * INTO c FROM app.require_caller();
  IF v_action = 'setAllowedEmail' AND NOT c.caller_is_admin THEN
    RAISE EXCEPTION USING MESSAGE = 'Admins only', ERRCODE = '42501';
  END IF;
  CASE v_action
    WHEN 'setApplied' THEN RETURN app.write_set_applied(c.caller_uid, v_params);
    WHEN 'setStatus' THEN RETURN app.write_set_status(c.caller_uid, v_params);
    WHEN 'setHidden' THEN RETURN app.write_set_hidden(c.caller_uid, v_params);
    WHEN 'setNote' THEN RETURN app.write_set_note(c.caller_uid, v_params);
    WHEN 'restoreHidden' THEN RETURN app.write_restore_hidden(c.caller_uid);
    WHEN 'saveProfile' THEN RETURN app.write_save_profile(c.caller_uid, v_params);
    WHEN 'saveMuteRules' THEN RETURN app.write_save_mute_rules(c.caller_uid, v_params);
    WHEN 'setAllowedEmail' THEN RETURN app.write_set_allowed_email(c.caller_uid, v_params);
    WHEN 'ping' THEN RETURN app.write_ping(c.caller_uid, v_params);
    ELSE
      RAISE EXCEPTION USING MESSAGE = 'Unknown action: ' || left(coalesce(v_action, 'undefined'), 40), ERRCODE = '22023';
  END CASE;
END
$$;

-- =====================================================================================================================
-- Service-only RPCs (GitHub Actions with the service role key; see databricks/jobs/sync_user_data.py and
-- publish_to_supabase.py). File formats: contract section 3 / README.
-- =====================================================================================================================

-- config/user_data.json for the pipeline: profiles, tracked job state only (applied or with a status; hidden-only flags
-- are not used by the pipeline), custom roles and skills. Profile skills = the core skills, then the also-know skills
-- (03_enrich discovers custom skills from both). Notes, follow-up dates, hide reasons, mute rules and feedback stay here.
CREATE OR REPLACE FUNCTION public.pipeline_export_user_data() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET "TimeZone" = 'UTC' SET extra_float_digits = 1
AS $$
DECLARE
  v_profiles jsonb;
  v_state jsonb;
  v_roles jsonb;
  v_skills jsonb;
BEGIN
  PERFORM app.require_service();
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'profile_id', up.profile_id, 'email', up.email, 'target_roles', to_jsonb(up.target_roles),
      'skills', to_jsonb(up.skills || ARRAY(
        SELECT a.skill FROM unnest(up.also_skills) WITH ORDINALITY AS a(skill, ord)
        WHERE NOT EXISTS (SELECT 1 FROM unnest(up.skills) AS k(skill) WHERE lower(k.skill) = lower(a.skill))
        ORDER BY a.ord)),
      'min_years', up.min_years, 'max_years', up.max_years,
      'preferred_cities', to_jsonb(up.preferred_cities), 'updated_at', app.ts_text(up.updated_at)
    ) ORDER BY up.profile_id), '[]'::jsonb)
  INTO v_profiles FROM app.user_profile up;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'job_key', s.job_key, 'is_applied', s.is_applied, 'applied_at', app.ts_text(s.applied_at),
      'is_hidden', s.is_hidden, 'hidden_at', app.ts_text(s.hidden_at), 'application_status', s.application_status,
      'status_updated_at', app.ts_text(s.status_updated_at)
    ) ORDER BY s.user_id, s.job_key), '[]'::jsonb)
  INTO v_state FROM app.user_job_state s
  WHERE s.is_applied OR s.application_status <> 'not_applied';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'role_title', r.role_title, 'status', r.status, 'category', r.category, 'description', r.description,
      'duplicate_of', r.duplicate_of, 'first_user', r.first_user, 'checked_by', r.checked_by,
      'created_at', app.ts_text(r.created_at), 'checked_at', app.ts_text(r.checked_at), 'attempts', r.attempts
    ) ORDER BY lower(r.role_title)), '[]'::jsonb)
  INTO v_roles FROM app.custom_roles r
  -- 02_ingest_silver rejects the whole file for one row without a known status or with a blank title, so such rows
  -- (possible after an invalid published status, stored as NULL) stay out; Databricks keeps its own copy (never deleted)
  WHERE r.status IN ('pending', 'active', 'mapped', 'rejected') AND btrim(r.role_title) <> '';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'skill', k.skill, 'first_user', k.first_user, 'created_at', app.ts_text(k.created_at)
    ) ORDER BY lower(k.skill)), '[]'::jsonb)
  INTO v_skills FROM app.custom_skills k
  WHERE btrim(k.skill) <> '';
  RETURN jsonb_build_object(
    'format', 'jobseeker.user_data.v1',
    'exported_at', app.ts_text(now()),
    'counts', jsonb_build_object('profiles', jsonb_array_length(v_profiles), 'job_state', jsonb_array_length(v_state),
                                 'custom_roles', jsonb_array_length(v_roles), 'custom_skills', jsonb_array_length(v_skills)),
    'profiles', v_profiles,
    'job_state', v_state,
    'custom_roles', v_roles,
    'custom_skills', v_skills
  );
END
$$;

-- What is published now; with include_hashes also {job_key: row_hash} so the publisher sends only changed rows
CREATE OR REPLACE FUNCTION public.pipeline_publish_state(include_hashes boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET "TimeZone" = 'UTC' SET extra_float_digits = 1
AS $$
#variable_conflict use_column
DECLARE
  v_include boolean := coalesce($1, false);
  v_result jsonb;
BEGIN
  PERFORM app.require_service();
  SELECT jsonb_build_object(
      'run_id', ps.run_id, 'snapshot_at', app.ts_text(ps.snapshot_at), 'published_at', app.ts_text(ps.published_at),
      'counts', ps.counts, 'jobs', (SELECT count(*) FROM app.jobs))
  INTO v_result
  FROM (SELECT 1) one LEFT JOIN app.pipeline_status ps ON ps.id = 1;
  IF v_include THEN
    v_result := v_result || jsonb_build_object('hashes',
      (SELECT coalesce(jsonb_object_agg(j.job_key, j.row_hash), '{}'::jsonb) FROM app.jobs j));
  END IF;
  RETURN v_result;
END
$$;

-- One batch of a publish: {"run_id", "kind", "seq", "rows" | "keys"} (contract section 3.3).
--   jobs   upserted straight into app.jobs, rewriting only rows whose hash changed
--   keys   [[job_key, h], ...] staged: every job that should exist after the finish
--   other  skill_stats / role_similarity / ref_roles / ref_skills / ref_cities / custom_roles / custom_skills staged
-- seq 0 of a staged kind restarts that kind for the run (drops what an earlier attempt staged).
CREATE OR REPLACE FUNCTION public.pipeline_publish(batch jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = '' SET "TimeZone" = 'UTC' SET extra_float_digits = 1
AS $$
#variable_conflict use_column
DECLARE
  v_batch jsonb := $1;
  v_run_id text;
  v_kind text;
  v_seq int;
  v_items jsonb;
  v_count int;
  v_bad bigint;
  v_changed bigint := 0;
BEGIN
  PERFORM app.require_service();
  IF jsonb_typeof(v_batch) <> 'object' THEN
    PERFORM app.fail('Batch must be a JSON object');
  END IF;
  v_run_id := CASE WHEN jsonb_typeof(v_batch -> 'run_id') = 'string' THEN v_batch ->> 'run_id' END;
  IF v_run_id IS NULL OR v_run_id !~ '^[A-Za-z0-9_.-]{1,100}$' THEN
    PERFORM app.fail('Invalid run_id');
  END IF;
  v_kind := CASE WHEN jsonb_typeof(v_batch -> 'kind') = 'string' THEN v_batch ->> 'kind' END;
  IF v_kind IS NULL OR v_kind NOT IN ('jobs', 'keys', 'skill_stats', 'role_similarity', 'ref_roles', 'ref_skills',
                                      'ref_cities', 'custom_roles', 'custom_skills') THEN
    PERFORM app.fail('Unknown kind: ' || left(coalesce(v_kind, 'undefined'), 40));
  END IF;
  -- IS DISTINCT FROM: a missing seq (NULL) must fail too, not slip through as NULL
  IF jsonb_typeof(v_batch -> 'seq') IS DISTINCT FROM 'number' OR coalesce(v_batch ->> 'seq', '') !~ '^[0-9]{1,9}$' THEN
    PERFORM app.fail('Invalid seq');
  END IF;
  v_seq := (v_batch ->> 'seq')::int;
  v_items := v_batch -> CASE WHEN v_kind = 'keys' THEN 'keys' ELSE 'rows' END;
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' THEN
    PERFORM app.fail(CASE WHEN v_kind = 'keys' THEN 'keys must be a list' ELSE 'rows must be a list' END);
  END IF;
  v_count := jsonb_array_length(v_items);

  IF v_kind = 'jobs' THEN
    SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(v_items) AS e(r)
    WHERE jsonb_typeof(e.r) <> 'object'
       OR coalesce(e.r ->> 'job_key', '') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(e.r -> 'h') IS DISTINCT FROM 'string' OR (e.r ->> 'h') = '';
    IF v_bad > 0 THEN
      PERFORM app.fail(format('%s job rows without a valid job_key or h', v_bad));
    END IF;
    INSERT INTO app.jobs AS t (
      job_key, source, company_name, title, location, posted_date, job_url, seniority_level, employment_type,
      experience_min_years, experience_max_years, experience_level, skills, skill_groups, category, role_title,
      role_score, role_alternative, role_method, first_seen_at, last_seen_at, times_seen, is_active, description,
      job_function, industries, skill_keys, row_hash, published_run_id, published_at)
    SELECT DISTINCT ON (x.job_key)
      x.job_key, x.source, x.company_name, x.title, x.location, x.posted_date, x.job_url, x.seniority_level,
      x.employment_type, x.experience_min_years, x.experience_max_years, x.experience_level, x.skills, x.skill_groups,
      x.category, x.role_title, x.role_score, x.role_alternative, x.role_method, x.first_seen_at, x.last_seen_at,
      x.times_seen, x.is_active, x.description, x.job_function, x.industries,
      ARRAY(SELECT lower(k) FROM unnest(coalesce(x.skills, '{}'::text[]) || coalesce(x.skill_groups, '{}'::text[])) AS k
            WHERE k IS NOT NULL),
      e.r ->> 'h', v_run_id, now()
    FROM jsonb_array_elements(v_items) WITH ORDINALITY AS e(r, ord)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::app.jobs, e.r - 'skill_keys' - 'row_hash' - 'published_run_id' - 'published_at') AS x
    ORDER BY x.job_key, e.ord DESC
    ON CONFLICT (job_key) DO UPDATE SET
      source = EXCLUDED.source, company_name = EXCLUDED.company_name, title = EXCLUDED.title,
      location = EXCLUDED.location, posted_date = EXCLUDED.posted_date, job_url = EXCLUDED.job_url,
      seniority_level = EXCLUDED.seniority_level, employment_type = EXCLUDED.employment_type,
      experience_min_years = EXCLUDED.experience_min_years, experience_max_years = EXCLUDED.experience_max_years,
      experience_level = EXCLUDED.experience_level, skills = EXCLUDED.skills, skill_groups = EXCLUDED.skill_groups,
      category = EXCLUDED.category, role_title = EXCLUDED.role_title, role_score = EXCLUDED.role_score,
      role_alternative = EXCLUDED.role_alternative, role_method = EXCLUDED.role_method,
      first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at, times_seen = EXCLUDED.times_seen,
      is_active = EXCLUDED.is_active, description = EXCLUDED.description, job_function = EXCLUDED.job_function,
      industries = EXCLUDED.industries, skill_keys = EXCLUDED.skill_keys, row_hash = EXCLUDED.row_hash,
      published_run_id = EXCLUDED.published_run_id, published_at = EXCLUDED.published_at
    WHERE t.row_hash IS DISTINCT FROM EXCLUDED.row_hash;
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_kind = 'keys' THEN
    SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(v_items) AS e(k)
    WHERE jsonb_typeof(e.k) <> 'array' OR jsonb_array_length(e.k) <> 2
       OR jsonb_typeof(e.k -> 0) <> 'string' OR (e.k ->> 0) !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(e.k -> 1) <> 'string' OR (e.k ->> 1) = '';
    IF v_bad > 0 THEN
      PERFORM app.fail(format('%s keys are not [job_key, h] pairs', v_bad));
    END IF;
    IF v_seq = 0 THEN
      DELETE FROM app.publish_keys WHERE run_id = v_run_id;
    END IF;
    INSERT INTO app.publish_keys AS t (run_id, job_key, row_hash, received_at)
    SELECT DISTINCT ON (e.k ->> 0) v_run_id, e.k ->> 0, e.k ->> 1, now()
    FROM jsonb_array_elements(v_items) WITH ORDINALITY AS e(k, ord)
    ORDER BY e.k ->> 0, e.ord DESC
    ON CONFLICT (run_id, job_key) DO UPDATE SET row_hash = EXCLUDED.row_hash, received_at = EXCLUDED.received_at;
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSE
    SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_items) AS e(r) WHERE jsonb_typeof(e.r) <> 'object';
    IF v_bad > 0 THEN
      PERFORM app.fail(format('%s %s rows are not JSON objects', v_bad, v_kind));
    END IF;
    IF v_seq = 0 THEN
      DELETE FROM app.publish_stage WHERE run_id = v_run_id AND kind = v_kind;
    END IF;
    INSERT INTO app.publish_stage AS t (run_id, kind, seq, rows, received_at)
    VALUES (v_run_id, v_kind, v_seq, v_items, now())
    ON CONFLICT (run_id, kind, seq) DO UPDATE SET rows = EXCLUDED.rows, received_at = EXCLUDED.received_at;
    v_changed := v_count;
  END IF;

  -- Staging left behind by other runs that never finished
  DELETE FROM app.publish_stage WHERE run_id <> v_run_id AND received_at < now() - interval '1 day';
  DELETE FROM app.publish_keys WHERE run_id <> v_run_id AND received_at < now() - interval '1 day';

  RETURN jsonb_build_object('kind', v_kind, 'seq', v_seq, 'accepted', v_count, 'changed', v_changed);
END
$$;

-- Completes a publish in one transaction: checks the staged batches against the manifest, replaces the small tables,
-- refreshes the derived job columns that depend on app.ref_cities, deletes jobs that left the snapshot unless someone
-- tracks them, prunes their state and records the run (app.pipeline_status, app.publish_history).
-- Refuses (nothing applied) on count/hash mismatches, an older snapshot or a snapshot that shrinks app.jobs by more
-- than half, unless force. Running it again for the run already published is a no-op.
CREATE OR REPLACE FUNCTION public.pipeline_publish_finish(run_id text, manifest jsonb, force boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = '' SET "TimeZone" = 'UTC' SET extra_float_digits = 1
AS $$
#variable_conflict use_column
DECLARE
  v_run_id text := $1;
  v_manifest jsonb := $2;
  v_force boolean := coalesce($3, false);
  v_counts jsonb;
  v_jobs bigint;
  v_snapshot timestamptz;
  v_status app.pipeline_status;
  v_staged bigint;
  v_matched bigint;
  v_current bigint;
  v_untracked bigint;
  v_kind text;
  v_expected bigint;
  v_deleted bigint;
  v_pruned bigint;
  v_kept bigint;
  v_upserted bigint;
  v_refreshed bigint;
  v_missed bigint;
  v_missed_by_user jsonb;
BEGIN
  PERFORM app.require_service();
  IF v_run_id IS NULL OR v_run_id !~ '^[A-Za-z0-9_.-]{1,100}$' THEN
    PERFORM app.fail('Invalid run_id');
  END IF;
  IF jsonb_typeof(v_manifest) IS DISTINCT FROM 'object' OR jsonb_typeof(v_manifest -> 'counts') IS DISTINCT FROM 'object' THEN
    PERFORM app.fail('Manifest must be a JSON object with counts');
  END IF;
  IF v_manifest ->> 'run_id' IS DISTINCT FROM v_run_id THEN
    PERFORM app.fail('Manifest run_id does not match');
  END IF;
  v_counts := v_manifest -> 'counts';
  IF coalesce(v_counts ->> 'jobs', '') !~ '^[0-9]{1,9}$' THEN
    PERFORM app.fail('Manifest counts.jobs missing');
  END IF;
  v_jobs := (v_counts ->> 'jobs')::bigint;
  BEGIN
    v_snapshot := (v_manifest ->> 'snapshot_at')::timestamptz;
  EXCEPTION WHEN others THEN
    v_snapshot := NULL;
  END;
  IF v_snapshot IS NULL THEN
    PERFORM app.fail('Manifest snapshot_at missing or invalid');
  END IF;

  -- One publish at a time; user writes to user_job_state wait (well under a second) so nobody applies to a job while
  -- it is being deleted
  PERFORM pg_advisory_xact_lock(hashtext('jobseeker.publish'));
  LOCK TABLE app.user_job_state IN SHARE MODE;

  SELECT * INTO v_status FROM app.pipeline_status ps WHERE ps.id = 1;
  SELECT count(*) INTO v_staged FROM app.publish_keys k WHERE k.run_id = v_run_id;

  IF v_staged = 0 AND v_status.run_id = v_run_id THEN
    RETURN jsonb_build_object('run_id', v_run_id, 'already_published', true, 'counts', v_status.counts);
  END IF;

  -- 1) the staged batches are complete
  IF v_staged <> v_jobs THEN
    PERFORM app.fail(format('%s keys staged but the manifest has %s jobs; re-run the publish', v_staged, v_jobs));
  END IF;
  FOREACH v_kind IN ARRAY ARRAY['skill_stats', 'role_similarity', 'ref_roles', 'ref_skills', 'ref_cities',
                                'custom_roles', 'custom_skills'] LOOP
    SELECT coalesce(sum(jsonb_array_length(s.rows)), 0) INTO v_staged
    FROM app.publish_stage s WHERE s.run_id = v_run_id AND s.kind = v_kind;
    v_expected := CASE WHEN coalesce(v_counts ->> v_kind, '') ~ '^[0-9]{1,9}$' THEN (v_counts ->> v_kind)::bigint ELSE 0 END;
    IF v_staged <> v_expected THEN
      PERFORM app.fail(format('%s: %s rows staged but the manifest has %s; re-run the publish', v_kind, v_staged, v_expected));
    END IF;
  END LOOP;
  SELECT count(*) INTO v_matched
  FROM app.publish_keys k JOIN app.jobs j ON j.job_key = k.job_key AND j.row_hash = k.row_hash
  WHERE k.run_id = v_run_id;
  IF v_matched <> v_jobs THEN
    PERFORM app.fail(format('%s jobs missing or outdated in app.jobs; re-run the publish', v_jobs - v_matched));
  END IF;

  -- 2) safety guards
  IF NOT v_force AND v_status.snapshot_at IS NOT NULL AND v_snapshot < v_status.snapshot_at THEN
    PERFORM app.fail(format('Snapshot %s is older than the published snapshot %s; pass force',
      app.ts_text(v_snapshot), app.ts_text(v_status.snapshot_at)));
  END IF;
  -- Compared with the size of the previously published snapshot: app.jobs already holds this run's new rows (kind jobs
  -- is applied as it arrives), so counting app.jobs would make normal turnover look like a shrink. Before the first
  -- recorded publish: the untracked rows that this run did not write.
  SELECT count(*), count(*) FILTER (WHERE j.published_run_id IS DISTINCT FROM v_run_id AND NOT EXISTS (
           SELECT 1 FROM app.user_job_state s
           WHERE s.job_key = j.job_key AND (s.is_applied OR s.application_status <> 'not_applied')))
  INTO v_current, v_untracked
  FROM app.jobs j;
  IF coalesce(v_status.counts ->> 'jobs', '') ~ '^[0-9]{1,9}$' THEN
    v_untracked := (v_status.counts ->> 'jobs')::bigint;
  END IF;
  IF NOT v_force AND ((v_jobs = 0 AND v_current > 0) OR v_jobs < 0.5 * v_untracked) THEN
    PERFORM app.fail(format('Snapshot shrinks app.jobs from %s to %s jobs; pass force', v_current, v_jobs));
  END IF;
  IF (CASE WHEN coalesce(v_counts ->> 'ref_roles', '') ~ '^[0-9]{1,9}$' THEN (v_counts ->> 'ref_roles')::bigint ELSE 0 END) = 0 THEN
    PERFORM app.fail('Snapshot has no reference roles');
  END IF;

  -- 3) small tables, replaced from staging
  DELETE FROM app.skill_stats WHERE true;
  INSERT INTO app.skill_stats (skill, jobs, idf)
  SELECT x.skill, max(x.jobs), max(x.idf)
  FROM app.publish_stage s CROSS JOIN LATERAL jsonb_to_recordset(s.rows) AS x(skill text, jobs bigint, idf float8)
  WHERE s.run_id = v_run_id AND s.kind = 'skill_stats' AND x.skill IS NOT NULL
  GROUP BY x.skill;

  DELETE FROM app.role_similarity WHERE true;
  INSERT INTO app.role_similarity (role_a, role_b, sim)
  SELECT x.role_a, x.role_b, max(x.sim)
  FROM app.publish_stage s CROSS JOIN LATERAL jsonb_to_recordset(s.rows) AS x(role_a text, role_b text, sim float8)
  WHERE s.run_id = v_run_id AND s.kind = 'role_similarity' AND x.role_a IS NOT NULL AND x.role_b IS NOT NULL
  GROUP BY x.role_a, x.role_b;

  DELETE FROM app.ref_roles WHERE true;
  INSERT INTO app.ref_roles (role_title, category, in_scope)
  SELECT DISTINCT ON (x.role_title) x.role_title, x.category, coalesce(x.in_scope, false)
  FROM app.publish_stage s CROSS JOIN LATERAL jsonb_to_recordset(s.rows) AS x(role_title text, category text, in_scope boolean)
  WHERE s.run_id = v_run_id AND s.kind = 'ref_roles' AND x.role_title IS NOT NULL
  ORDER BY x.role_title, s.seq;

  DELETE FROM app.ref_skills WHERE true;
  INSERT INTO app.ref_skills (skill, skill_group, aliases)
  SELECT DISTINCT ON (x.skill) x.skill, x.skill_group, x.aliases
  FROM app.publish_stage s CROSS JOIN LATERAL jsonb_to_recordset(s.rows) AS x(skill text, skill_group text, aliases text[])
  WHERE s.run_id = v_run_id AND s.kind = 'ref_skills' AND x.skill IS NOT NULL
  ORDER BY x.skill, s.seq;

  DELETE FROM app.ref_cities WHERE true;
  INSERT INTO app.ref_cities (alias, city, state)
  SELECT x.alias, max(x.city), max(x.state)
  FROM app.publish_stage s CROSS JOIN LATERAL jsonb_to_recordset(s.rows) AS x(alias text, city text, state text)
  WHERE s.run_id = v_run_id AND s.kind = 'ref_cities' AND x.alias IS NOT NULL
  GROUP BY x.alias;
  -- the trigger derived this run's rows with the old city list
  v_refreshed := app.refresh_job_derivations();

  -- 4) custom roles / skills: the pipeline is authoritative for the check results; never deleted
  INSERT INTO app.custom_roles AS t (role_title, status, category, description, duplicate_of, first_user, checked_by,
                                     created_at, checked_at, attempts)
  SELECT DISTINCT ON (lower(x.role_title)) x.role_title,
    CASE WHEN x.status IN ('pending', 'active', 'mapped', 'rejected') THEN x.status END,
    x.category, x.description, x.duplicate_of, x.first_user, x.checked_by, x.created_at, x.checked_at, x.attempts
  FROM app.publish_stage s
  CROSS JOIN LATERAL jsonb_to_recordset(s.rows) AS x(role_title text, status text, category text, description text,
    duplicate_of text, first_user text, checked_by text, created_at timestamptz, checked_at timestamptz, attempts int)
  WHERE s.run_id = v_run_id AND s.kind = 'custom_roles' AND x.role_title IS NOT NULL
  ORDER BY lower(x.role_title), x.checked_at DESC NULLS LAST
  ON CONFLICT ((lower(role_title))) DO UPDATE SET
    status = EXCLUDED.status, category = EXCLUDED.category, description = EXCLUDED.description,
    duplicate_of = EXCLUDED.duplicate_of, checked_by = EXCLUDED.checked_by, checked_at = EXCLUDED.checked_at,
    attempts = EXCLUDED.attempts, first_user = coalesce(t.first_user, EXCLUDED.first_user),
    created_at = coalesce(t.created_at, EXCLUDED.created_at);

  INSERT INTO app.custom_skills (skill, first_user, created_at)
  SELECT DISTINCT ON (lower(x.skill)) x.skill, x.first_user, x.created_at
  FROM app.publish_stage s
  CROSS JOIN LATERAL jsonb_to_recordset(s.rows) AS x(skill text, first_user text, created_at timestamptz)
  WHERE s.run_id = v_run_id AND s.kind = 'custom_skills' AND x.skill IS NOT NULL
  ORDER BY lower(x.skill), x.created_at NULLS LAST
  ON CONFLICT ((lower(skill))) DO NOTHING;

  -- 5) jobs that left the snapshot, unless a user applied to them or gave them a status. First, per user, the strong
  --    For-you jobs among them that the user never touched (no state row): today's missed_strong (Metrics coverage),
  --    written in step 8 (activity rows are locked last, as the user writes do, so the two never wait on each other in
  --    a circle)
  SELECT count(*) INTO v_upserted FROM app.jobs j WHERE j.published_run_id = v_run_id;
  SELECT coalesce(jsonb_object_agg(x.profile_id, x.n), '{}'::jsonb), coalesce(sum(x.n), 0)
  INTO v_missed_by_user, v_missed
  FROM (
    SELECT up.profile_id, m.n
    FROM app.user_profile up
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n
      FROM app.user_jobs(up.profile_id) u
      WHERE NOT EXISTS (SELECT 1 FROM app.publish_keys k WHERE k.run_id = v_run_id AND k.job_key = u.job_key)
        AND NOT EXISTS (SELECT 1 FROM app.user_job_state s
                        WHERE s.job_key = u.job_key AND (s.is_applied OR s.application_status <> 'not_applied'))
        AND NOT EXISTS (SELECT 1 FROM app.user_job_state s WHERE s.user_id = up.profile_id AND s.job_key = u.job_key)
        AND coalesce(u.is_active, true) AND u.in_for_you AND u.muted_by IS NULL AND u.fit_score >= app.c_strong_fit()
    ) m
    WHERE m.n > 0
  ) x;
  DELETE FROM app.jobs j
  WHERE NOT EXISTS (SELECT 1 FROM app.publish_keys k WHERE k.run_id = v_run_id AND k.job_key = j.job_key)
    AND NOT EXISTS (SELECT 1 FROM app.user_job_state s
                    WHERE s.job_key = j.job_key AND (s.is_applied OR s.application_status <> 'not_applied'));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT count(*) INTO v_kept
  FROM app.jobs j
  WHERE NOT EXISTS (SELECT 1 FROM app.publish_keys k WHERE k.run_id = v_run_id AND k.job_key = j.job_key);
  -- A kept job left the snapshot (gold no longer lists it) and stays only because someone tracks it: is_active = false
  -- (the app shows how long ago it was posted; it may still be open). The hash changes too, so if the job comes back in
  -- a later snapshot its row is sent and rewritten instead of being taken for unchanged.
  UPDATE app.jobs j SET is_active = false, row_hash = j.row_hash || ':expired'
  WHERE j.is_active IS DISTINCT FROM false
    AND NOT EXISTS (SELECT 1 FROM app.publish_keys k WHERE k.run_id = v_run_id AND k.job_key = j.job_key);

  -- 6) state of jobs that no longer exist (only untracked rows can be left after step 5)
  DELETE FROM app.user_job_state s WHERE NOT EXISTS (SELECT 1 FROM app.jobs j WHERE j.job_key = s.job_key);
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  -- 7) record the run, clear its staging
  -- Upsert: a missing status row must not leave every later publish looking unpublished
  INSERT INTO app.pipeline_status AS ps (id, run_id, snapshot_at, published_at, counts, manifest)
  VALUES (1, v_run_id, v_snapshot, now(), v_counts, v_manifest)
  ON CONFLICT (id) DO UPDATE SET
    run_id = EXCLUDED.run_id, snapshot_at = EXCLUDED.snapshot_at, published_at = EXCLUDED.published_at,
    counts = EXCLUDED.counts, manifest = EXCLUDED.manifest;
  DELETE FROM app.publish_keys WHERE run_id = v_run_id;
  DELETE FROM app.publish_stage WHERE run_id = v_run_id;
  INSERT INTO app.publish_history AS h (run_id, snapshot_at, published_at, counts, upserted, deleted_jobs, kept_tracked, pruned_state)
  VALUES (v_run_id, v_snapshot, now(), v_counts, v_upserted, v_deleted, v_kept, v_pruned)
  ON CONFLICT (run_id) DO UPDATE SET
    snapshot_at = EXCLUDED.snapshot_at, published_at = EXCLUDED.published_at, counts = EXCLUDED.counts,
    upserted = EXCLUDED.upserted, deleted_jobs = EXCLUDED.deleted_jobs, kept_tracked = EXCLUDED.kept_tracked,
    pruned_state = EXCLUDED.pruned_state;
  DELETE FROM app.publish_history h
  WHERE h.run_id NOT IN (SELECT k.run_id FROM app.publish_history k ORDER BY k.published_at DESC, k.run_id DESC LIMIT 50);
  -- 8) hide feedback is kept for later calibration, but not forever; so are the activity counters. Then today's
  --    missed_strong from step 5
  DELETE FROM app.job_feedback f WHERE f.created_at < now() - interval '180 days';
  DELETE FROM app.user_activity_day d WHERE d.day < current_date - app.c_activity_keep_days();
  INSERT INTO app.user_activity_day AS a (user_id, day, missed_strong)
  SELECT e.key::uuid, current_date, e.value::int FROM jsonb_each_text(v_missed_by_user) e
  ON CONFLICT (user_id, day) DO UPDATE SET missed_strong = a.missed_strong + EXCLUDED.missed_strong;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'upserted_before_finish', v_upserted,
    'deleted_jobs', v_deleted,
    'kept_tracked_not_in_snapshot', v_kept,
    'pruned_state', v_pruned,
    'derivations_refreshed', v_refreshed,
    'missed_strong', v_missed,
    'counts', v_counts
  );
END
$$;

-- One scraper run (databricks/jobs/record_scrape_report.py, format jobseeker.scrape_report.v1, see README): the run row
-- (recording the same GitHub run attempt again replaces it) and the latest result per company or LinkedIn search.
-- A company's row only moves forward in time, so re-recording a report never counts a failure twice.
CREATE OR REPLACE FUNCTION public.pipeline_record_scrape(report jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = '' SET "TimeZone" = 'UTC' SET extra_float_digits = 1
AS $$
#variable_conflict use_column
DECLARE
  v_report jsonb := $1;
  v_source text;
  v_run jsonb;
  v_status text;
  v_finished timestamptz;
  v_companies jsonb;
  v_totals jsonb;
  v_linkedin jsonb;
  v_run_id text;
  v_attempt int;
  v_n bigint;
BEGIN
  PERFORM app.require_service();
  IF jsonb_typeof(v_report) IS DISTINCT FROM 'object' OR v_report ->> 'format' IS DISTINCT FROM 'jobseeker.scrape_report.v1' THEN
    PERFORM app.fail('Unknown report format');
  END IF;
  v_source := CASE WHEN jsonb_typeof(v_report -> 'source') = 'string' THEN v_report ->> 'source' END;
  IF v_source IS NULL OR v_source NOT IN ('workday', 'greenhouse', 'linkedin') THEN
    PERFORM app.fail('Invalid source');
  END IF;
  v_run := CASE WHEN jsonb_typeof(v_report -> 'run') = 'object' THEN v_report -> 'run' ELSE '{}'::jsonb END;
  v_status := CASE WHEN jsonb_typeof(v_run -> 'status') = 'string' THEN v_run ->> 'status' END;
  IF v_status IS NULL OR v_status NOT IN ('ok', 'partial', 'failed', 'crashed') THEN
    PERFORM app.fail('Invalid status');
  END IF;
  v_finished := app.js_timestamp(v_run -> 'finished_at');
  IF v_finished IS NULL THEN
    PERFORM app.fail('Invalid finished_at');
  END IF;
  v_companies := coalesce(nullif(v_report -> 'companies', 'null'::jsonb), '[]'::jsonb);
  IF jsonb_typeof(v_companies) <> 'array' OR jsonb_array_length(v_companies) > 500 OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_companies) AS e(c)
       WHERE jsonb_typeof(e.c) <> 'object' OR app.js_text(e.c -> 'name', 200) = '') THEN
    PERFORM app.fail('Invalid companies');
  END IF;
  v_totals := CASE WHEN jsonb_typeof(v_report -> 'totals') = 'object' THEN v_report -> 'totals' ELSE '{}'::jsonb END;
  v_linkedin := CASE WHEN jsonb_typeof(v_report -> 'linkedin') = 'object' THEN v_report -> 'linkedin' ELSE '{}'::jsonb END;
  v_run_id := nullif(left(CASE jsonb_typeof(v_run -> 'github_run_id') WHEN 'string' THEN v_run ->> 'github_run_id'
                                                                       WHEN 'number' THEN v_run ->> 'github_run_id' END, 50), '');
  v_attempt := app.js_int(v_run -> 'github_run_attempt', 0, 1000000);

  INSERT INTO app.scrape_runs AS r (source, github_run_id, github_run_attempt, workflow, started_at, finished_at, status,
    companies, failed, jobs_scraped, jobs_written, missing_descriptions, already_seen, searches_total, searches_cap,
    dropped_searches, message, recorded_at)
  VALUES (v_source, v_run_id, v_attempt, nullif(app.js_text(v_run -> 'workflow', 100), ''),
    app.js_timestamp(v_run -> 'started_at'), v_finished, v_status,
    app.js_int(v_totals -> 'companies', 0, 2000000000), app.js_int(v_totals -> 'failed', 0, 2000000000),
    app.js_int(v_totals -> 'jobs_scraped', 0, 2000000000), app.js_int(v_totals -> 'jobs_written', 0, 2000000000),
    app.js_int(v_totals -> 'missing_descriptions', 0, 2000000000), app.js_int(v_totals -> 'already_seen', 0, 2000000000),
    app.js_int(v_linkedin -> 'searches_total', 0, 2000000000), app.js_int(v_linkedin -> 'searches_cap', 0, 2000000000),
    coalesce(ARRAY(SELECT app.js_text(d.name, 200)
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_linkedin -> 'dropped') = 'array'
                                                  THEN v_linkedin -> 'dropped' ELSE '[]'::jsonb END)
                        WITH ORDINALITY AS d(name, ord)
                   WHERE app.js_text(d.name, 200) <> ''
                   ORDER BY d.ord LIMIT 500), '{}'::text[]),
    nullif(app.js_text(v_run -> 'message', 1000), ''), now())
  ON CONFLICT (source, github_run_id, github_run_attempt) DO UPDATE SET
    workflow = EXCLUDED.workflow, started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
    status = EXCLUDED.status, companies = EXCLUDED.companies, failed = EXCLUDED.failed,
    jobs_scraped = EXCLUDED.jobs_scraped, jobs_written = EXCLUDED.jobs_written,
    missing_descriptions = EXCLUDED.missing_descriptions, already_seen = EXCLUDED.already_seen,
    searches_total = EXCLUDED.searches_total, searches_cap = EXCLUDED.searches_cap,
    dropped_searches = EXCLUDED.dropped_searches, message = EXCLUDED.message, recorded_at = EXCLUDED.recorded_at;

  INSERT INTO app.scrape_companies AS t (source, company_lc, company, last_scraped_at, last_ok_at, jobs_found, last_error, failures)
  SELECT DISTINCT ON (lower(c.name)) v_source, lower(c.name), c.name, v_finished,
    CASE WHEN c.ok THEN v_finished END, CASE WHEN c.ok THEN c.jobs_found END,
    CASE WHEN NOT c.ok THEN coalesce(nullif(c.error, ''), 'failed') END, CASE WHEN c.ok THEN 0 ELSE 1 END
  FROM jsonb_array_elements(v_companies) WITH ORDINALITY AS e(c, ord)
  CROSS JOIN LATERAL (
    SELECT app.js_text(e.c -> 'name', 200) AS name, coalesce(e.c -> 'ok' = 'true'::jsonb, false) AS ok,
      app.js_int(e.c -> 'jobs_found', 0, 2000000000) AS jobs_found, app.js_text(e.c -> 'error', 500) AS error
  ) c
  ORDER BY lower(c.name), e.ord DESC
  ON CONFLICT (source, company_lc) DO UPDATE SET
    company = EXCLUDED.company,
    last_scraped_at = EXCLUDED.last_scraped_at,
    last_ok_at = coalesce(EXCLUDED.last_ok_at, t.last_ok_at),
    jobs_found = EXCLUDED.jobs_found,
    last_error = EXCLUDED.last_error,
    failures = CASE WHEN EXCLUDED.failures = 0 THEN 0 ELSE t.failures + 1 END
  WHERE t.last_scraped_at IS NULL OR t.last_scraped_at < EXCLUDED.last_scraped_at;
  v_n := jsonb_array_length(v_companies);

  -- retention: 30 runs per source; companies / searches not scraped for 30 days
  DELETE FROM app.scrape_runs r
  WHERE r.source = v_source AND r.id NOT IN (
    SELECT k.id FROM app.scrape_runs k WHERE k.source = v_source ORDER BY k.finished_at DESC, k.id DESC LIMIT 30);
  DELETE FROM app.scrape_companies t WHERE t.last_scraped_at < now() - interval '30 days';

  RETURN jsonb_build_object('recorded', true, 'companies', v_n);
END
$$;

-- Databricks job runs from the Jobs API (publish_to_supabase.py record_runs): {"runs": [{run_id, started_at, ended_at,
-- duration_s, state, result, message, trigger, tasks: [{task_key, state, result, started_at, duration_s}]}]}, upserted by
-- run_id; the newest 50 are kept
CREATE OR REPLACE FUNCTION public.pipeline_record_runs(batch jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = '' SET "TimeZone" = 'UTC' SET extra_float_digits = 1
AS $$
#variable_conflict use_column
DECLARE
  v_runs jsonb := CASE WHEN jsonb_typeof($1) = 'object' THEN $1 -> 'runs' END;
  v_n bigint;
BEGIN
  PERFORM app.require_service();
  IF jsonb_typeof(v_runs) IS DISTINCT FROM 'array' OR jsonb_array_length(v_runs) > 50 OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_runs) AS e(r)
       WHERE jsonb_typeof(e.r) <> 'object'
          OR NOT coalesce(jsonb_typeof(e.r -> 'run_id') IN ('string', 'number') AND (e.r ->> 'run_id') ~ '^[0-9]{1,30}$', false)
          OR (e.r -> 'tasks' IS NOT NULL AND e.r -> 'tasks' <> 'null'::jsonb
              AND (jsonb_typeof(e.r -> 'tasks') <> 'array' OR jsonb_array_length(e.r -> 'tasks') > 20
                   OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.r -> 'tasks') AS t(task) WHERE jsonb_typeof(t.task) <> 'object')))) THEN
    PERFORM app.fail('Invalid runs');
  END IF;
  INSERT INTO app.pipeline_runs AS t (run_id, started_at, ended_at, duration_s, state, result, message, trigger, tasks, recorded_at)
  SELECT DISTINCT ON (e.r ->> 'run_id') e.r ->> 'run_id', app.js_timestamp(e.r -> 'started_at'), app.js_timestamp(e.r -> 'ended_at'),
    app.js_int(e.r -> 'duration_s', 0, 2000000000), nullif(app.js_text(e.r -> 'state', 40), ''),
    nullif(app.js_text(e.r -> 'result', 40), ''), nullif(app.js_text(e.r -> 'message', 300), ''),
    nullif(app.js_text(e.r -> 'trigger', 40), ''),
    coalesce((SELECT jsonb_agg(jsonb_build_object(
                'task_key', nullif(app.js_text(k.task -> 'task_key', 100), ''),
                'state', nullif(app.js_text(k.task -> 'state', 40), ''),
                'result', nullif(app.js_text(k.task -> 'result', 40), ''),
                'started_at', app.js_timestamp(k.task -> 'started_at'),
                'duration_s', app.js_int(k.task -> 'duration_s', 0, 2000000000)) ORDER BY k.ord)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.r -> 'tasks') = 'array' THEN e.r -> 'tasks' ELSE '[]'::jsonb END)
                   WITH ORDINALITY AS k(task, ord)), '[]'::jsonb),
    now()
  FROM jsonb_array_elements(v_runs) WITH ORDINALITY AS e(r, ord)
  ORDER BY e.r ->> 'run_id', e.ord DESC
  ON CONFLICT (run_id) DO UPDATE SET
    started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, duration_s = EXCLUDED.duration_s,
    state = EXCLUDED.state, result = EXCLUDED.result, message = EXCLUDED.message, trigger = EXCLUDED.trigger,
    tasks = EXCLUDED.tasks, recorded_at = EXCLUDED.recorded_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM app.pipeline_runs r
  WHERE r.run_id NOT IN (SELECT k.run_id FROM app.pipeline_runs k ORDER BY k.started_at DESC NULLS LAST, k.run_id DESC LIMIT 50);
  RETURN jsonb_build_object('recorded', v_n);
END
$$;

-- =====================================================================================================================
-- Derived job columns: trigger and backfill (rows published before this file existed, or derived with older rules)
-- =====================================================================================================================

DROP TRIGGER IF EXISTS ref_cities_changed ON app.ref_cities;
CREATE TRIGGER ref_cities_changed
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON app.ref_cities
  FOR EACH STATEMENT EXECUTE FUNCTION app.ref_cities_changed();
SELECT app.rebuild_city_match();

DROP TRIGGER IF EXISTS jobs_derive ON app.jobs;
CREATE TRIGGER jobs_derive
  BEFORE INSERT OR UPDATE OF company_name, title, location, description, employment_type ON app.jobs
  FOR EACH ROW EXECUTE FUNCTION app.jobs_derive();
SELECT app.refresh_job_derivations(true);

-- Seed the publish history with the publish that was live before it existed, so the System tab shows it
INSERT INTO app.publish_history (run_id, snapshot_at, published_at, counts)
SELECT ps.run_id, ps.snapshot_at, ps.published_at, ps.counts
FROM app.pipeline_status ps
WHERE ps.id = 1 AND ps.run_id IS NOT NULL AND ps.published_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM app.publish_history)
ON CONFLICT (run_id) DO NOTHING;

-- =====================================================================================================================
-- Privileges. Supabase's default privileges grant EXECUTE on new public functions to anon, authenticated and
-- service_role (and PostgreSQL to PUBLIC), so every grant is set explicitly.
-- =====================================================================================================================

REVOKE ALL ON FUNCTION public.app_read(text, jsonb), public.app_write(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_read(text, jsonb), public.app_write(text, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.pipeline_export_user_data(), public.pipeline_publish_state(boolean),
  public.pipeline_publish(jsonb), public.pipeline_publish_finish(text, jsonb, boolean),
  public.pipeline_record_scrape(jsonb), public.pipeline_record_runs(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pipeline_export_user_data(), public.pipeline_publish_state(boolean),
  public.pipeline_publish(jsonb), public.pipeline_publish_finish(text, jsonb, boolean),
  public.pipeline_record_scrape(jsonb), public.pipeline_record_runs(jsonb) TO service_role;

-- Internal helpers: callable only by the owner (through the SECURITY DEFINER functions above)
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TYPE app.user_job, app.filtered_job FROM PUBLIC;

-- Let PostgREST pick up the new functions (Supabase also does this from its DDL event trigger)
NOTIFY pgrst, 'reload schema';
