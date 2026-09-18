-- Canonical job tracking redesign for deduplication, status history, and summary metrics.
-- Apply this in Supabase SQL editor after reviewing the current schema.
-- It keeps the existing jobs table shape compatible while strengthening identity tracking.
-- This version is intentionally conservative: it does not hard-fail if some fields already exist.

BEGIN;

-- 1) Add helper functions and normalized columns if they are missing.
CREATE OR REPLACE FUNCTION public.normalize_job_url(raw_url text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(trim(both ' ' from regexp_replace(lower(raw_url), '[#?].*$', '', 'g')), '');
$$;

CREATE OR REPLACE FUNCTION public.job_identity_hash(company_id uuid, job_id text, raw_url text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT md5(
    COALESCE(company_id::text, '') || '|' ||
    COALESCE(trim(job_id), '') || '|' ||
    COALESCE(public.normalize_job_url(raw_url), '')
  );
$$;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS canonical_url text,
  ADD COLUMN IF NOT EXISTS dedupe_hash text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS normalized_title text,
  ADD COLUMN IF NOT EXISTS summary_score integer,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- 2) Backfill canonical metadata for existing rows.
UPDATE public.jobs
SET
  canonical_url = public.normalize_job_url(url),
  dedupe_hash = public.job_identity_hash(company_id, job_id, url),
  last_seen_at = COALESCE(last_seen_at, first_seen_at, posted_at, NOW()),
  last_checked_at = COALESCE(last_checked_at, NOW()),
  status = CASE
    WHEN hidden THEN 'hidden'
    WHEN applied_at IS NOT NULL THEN 'applied'
    WHEN is_active = false THEN 'archived'
    ELSE 'pending'
  END,
  normalized_title = lower(trim(title)),
  updated_at = COALESCE(updated_at, NOW())
WHERE dedupe_hash IS NULL OR canonical_url IS NULL OR updated_at IS NULL;

-- 3) Create a canonical tracking table for changes over time.
CREATE TABLE IF NOT EXISTS public.job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('created', 'refreshed', 'hidden', 'restored', 'applied', 'unapplied', 'archived', 'reopened', 'duplicate_merge')),
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_created
  ON public.job_events(job_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_events_type
  ON public.job_events(event_type, created_at DESC);

-- 4) Add dedupe-safe indexes without assuming the master row set is already clean.
-- These index constraints should remain non-blocking for a migration and are suitable for
-- a cleanup pass after row dedupe has been normalized.
CREATE INDEX IF NOT EXISTS idx_jobs_company_job_identity
  ON public.jobs(company_id, job_id)
  WHERE company_id IS NOT NULL AND job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_canonical_url
  ON public.jobs(canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_hash
  ON public.jobs(dedupe_hash)
  WHERE dedupe_hash IS NOT NULL;

-- 5) Add query-friendly indexes for summary and filtering.
CREATE INDEX IF NOT EXISTS idx_jobs_visibility
  ON public.jobs(is_active, hidden, applied_at, posted_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_jobs_company_dates
  ON public.jobs(company_id, posted_at DESC NULLS LAST, first_seen_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_jobs_status
  ON public.jobs(status, hidden, is_active);

-- 6) Trigger to maintain canonical values before each insert/update.
CREATE OR REPLACE FUNCTION public.set_job_tracking_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.canonical_url := public.normalize_job_url(COALESCE(NEW.url, NEW.canonical_url));
  NEW.dedupe_hash := public.job_identity_hash(NEW.company_id, NEW.job_id, NEW.canonical_url);
  NEW.normalized_title := lower(trim(COALESCE(NEW.title, '')));
  NEW.last_seen_at := COALESCE(NEW.last_seen_at, NEW.posted_at, NEW.first_seen_at, NOW());
  NEW.last_checked_at := COALESCE(NEW.last_checked_at, NOW());
  NEW.updated_at := NOW();

  IF NEW.hidden THEN
    NEW.status := 'hidden';
  ELSIF NEW.applied_at IS NOT NULL THEN
    NEW.status := 'applied';
  ELSIF NEW.is_active = false THEN
    NEW.status := 'archived';
  ELSE
    NEW.status := 'pending';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.first_seen_at IS NULL THEN
    NEW.first_seen_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_job_tracking_fields ON public.jobs;
CREATE TRIGGER trg_set_job_tracking_fields
BEFORE INSERT OR UPDATE OF title, url, company_id, job_id, hidden, applied_at, is_active, first_seen_at, posted_at, last_seen_at, last_checked_at
ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.set_job_tracking_fields();

-- 7) Event logging for critical job state transitions.
CREATE OR REPLACE FUNCTION public.log_job_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.job_events(job_id, event_type, event_data)
    VALUES (NEW.id, 'created', jsonb_build_object('title', NEW.title, 'company_id', NEW.company_id, 'job_id', NEW.job_id, 'url', NEW.canonical_url));
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.hidden IS DISTINCT FROM NEW.hidden AND NEW.hidden THEN
      INSERT INTO public.job_events(job_id, event_type, event_data)
      VALUES (NEW.id, 'hidden', jsonb_build_object('from', OLD.hidden, 'to', NEW.hidden));
    ELSIF OLD.hidden IS DISTINCT FROM NEW.hidden AND NOT NEW.hidden THEN
      INSERT INTO public.job_events(job_id, event_type, event_data)
      VALUES (NEW.id, 'restored', jsonb_build_object('from', OLD.hidden, 'to', NEW.hidden));
    END IF;

    IF OLD.applied_at IS DISTINCT FROM NEW.applied_at THEN
      IF NEW.applied_at IS NOT NULL THEN
        INSERT INTO public.job_events(job_id, event_type, event_data)
        VALUES (NEW.id, 'applied', jsonb_build_object('applied_at', NEW.applied_at));
      ELSE
        INSERT INTO public.job_events(job_id, event_type, event_data)
        VALUES (NEW.id, 'unapplied', jsonb_build_object('previous_applied_at', OLD.applied_at));
      END IF;
    END IF;

    IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN
      INSERT INTO public.job_events(job_id, event_type, event_data)
      VALUES (
        NEW.id,
        CASE WHEN NEW.is_active THEN 'reopened' ELSE 'archived' END,
        jsonb_build_object('from', OLD.is_active, 'to', NEW.is_active)
      );
    END IF;

    IF OLD.url IS DISTINCT FROM NEW.url OR OLD.company_id IS DISTINCT FROM NEW.company_id OR OLD.job_id IS DISTINCT FROM NEW.job_id THEN
      INSERT INTO public.job_events(job_id, event_type, event_data)
      VALUES (
        NEW.id,
        'refreshed',
        jsonb_build_object(
          'url', NEW.canonical_url,
          'company_id', NEW.company_id,
          'job_id', NEW.job_id,
          'posted_at', NEW.posted_at
        )
      );
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_job_event ON public.jobs;
CREATE TRIGGER trg_log_job_event
AFTER INSERT OR UPDATE OF url, company_id, job_id, hidden, applied_at, is_active, posted_at
ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.log_job_event();

-- 8) A summary view for dashboard metrics using canonical DB state instead of the current visible list.
CREATE OR REPLACE VIEW public.job_dashboard_summary AS
SELECT
  COUNT(*) AS total_jobs,
  COUNT(*) FILTER (WHERE is_active AND NOT hidden) AS active_visible_jobs,
  COUNT(*) FILTER (WHERE is_active AND NOT hidden AND posted_at >= now() - interval '48 hours') AS new_last_48h,
  COUNT(*) FILTER (WHERE is_active AND NOT hidden AND applied_at IS NOT NULL) AS applied_jobs,
  COUNT(*) FILTER (WHERE is_active AND NOT hidden AND applied_at IS NULL) AS pending_jobs,
  COUNT(*) FILTER (WHERE is_active AND NOT hidden AND hidden = false AND posted_at >= now() - interval '14 days') AS last_14_days,
  COUNT(*) FILTER (WHERE hidden = true) AS hidden_jobs,
  COUNT(*) FILTER (WHERE is_active = false) AS archived_jobs
FROM public.jobs;

CREATE OR REPLACE VIEW public.job_daily_metrics AS
SELECT
  day_key,
  COUNT(*) AS added_jobs,
  COUNT(*) FILTER (WHERE applied_at IS NOT NULL) AS applied_jobs
FROM (
  SELECT
    date_trunc('day', COALESCE(posted_at, first_seen_at, updated_at, now()))::date AS day_key,
    applied_at
  FROM public.jobs
  WHERE is_active AND NOT hidden
) s
GROUP BY day_key
ORDER BY day_key DESC;

-- 9) Soft cleanup for stale jobs older than 7 days without hard deleting canonical data.
CREATE OR REPLACE FUNCTION public.archive_old_jobs()
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.jobs
  SET
    is_active = false,
    hidden = true,
    status = 'archived',
    updated_at = NOW()
  WHERE posted_at IS NOT NULL
    AND posted_at < NOW() - INTERVAL '7 days';
$$;

-- 10) Merge duplicates using deterministic identity.
CREATE OR REPLACE FUNCTION public.merge_duplicate_jobs()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY dedupe_hash
          ORDER BY
            CASE WHEN applied_at IS NOT NULL THEN 0 ELSE 1 END,
            CASE WHEN hidden THEN 0 ELSE 1 END,
            posted_at DESC NULLS LAST,
            first_seen_at DESC NULLS LAST,
            id DESC
        ) AS row_num
      FROM public.jobs
      WHERE dedupe_hash IS NOT NULL
    )
    SELECT id
    FROM ranked
    WHERE row_num > 1
  LOOP
    UPDATE public.jobs
    SET
      hidden = hidden OR EXISTS (
        SELECT 1 FROM public.jobs j2
        WHERE j2.dedupe_hash = public.jobs.dedupe_hash
          AND j2.id <> public.jobs.id
          AND j2.hidden = true
      ),
      applied_at = COALESCE(public.jobs.applied_at, (
        SELECT j2.applied_at
        FROM public.jobs j2
        WHERE j2.dedupe_hash = public.jobs.dedupe_hash
          AND j2.id <> public.jobs.id
          AND j2.applied_at IS NOT NULL
        ORDER BY j2.applied_at DESC
        LIMIT 1
      )),
      updated_at = NOW()
    WHERE public.jobs.id = rec.id;

    INSERT INTO public.job_events(job_id, event_type, event_data)
    VALUES (rec.id, 'duplicate_merge', jsonb_build_object('merged_into', 'dedupe_hash'));
  END LOOP;
END;
$$;

COMMIT;

-- Suggested follow-up after applying the migration:
-- 1) Run: SELECT public.archive_old_jobs();
-- 2) Run: SELECT public.merge_duplicate_jobs();
-- 3) Review the summary with: SELECT * FROM public.job_dashboard_summary;
-- 4) Review daily metrics with: SELECT * FROM public.job_daily_metrics ORDER BY day_key DESC LIMIT 14;
