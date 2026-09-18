-- Trigger-based cleanup for stale jobs older than 7 days.
-- This includes both active and hidden jobs.
-- Add this to the Supabase SQL editor.

CREATE OR REPLACE FUNCTION public.cleanup_old_jobs()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.jobs
  WHERE posted_at IS NOT NULL
    AND posted_at < NOW() - INTERVAL '7 days';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_old_jobs ON public.jobs;

CREATE TRIGGER trg_cleanup_old_jobs
AFTER INSERT OR UPDATE OF posted_at, is_active, hidden
ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.cleanup_old_jobs();

-- Keep all duplicate rows for the same job in sync when a user hides or marks a job applied.
CREATE OR REPLACE FUNCTION public.sync_duplicate_job_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Only propagate status to rows that are the same canonical job identity.
  -- This avoids marking unrelated jobs from the same company as applied.
  UPDATE public.jobs
  SET
    hidden = COALESCE(NEW.hidden, hidden),
    applied_at = CASE
      WHEN NEW.applied_at IS NOT NULL THEN NEW.applied_at
      WHEN TG_OP = 'UPDATE' AND OLD.applied_at IS NOT NULL AND NEW.applied_at IS NULL THEN NULL
      ELSE applied_at
    END
  WHERE id <> NEW.id
    AND (
      (
        NEW.company_id IS NOT NULL
        AND NEW.job_id IS NOT NULL
        AND company_id IS NOT DISTINCT FROM NEW.company_id
        AND job_id IS NOT DISTINCT FROM NEW.job_id
      )
      OR (
        NEW.company_id IS NULL
        AND NEW.job_id IS NULL
        AND NEW.url IS NOT NULL
        AND url IS NOT DISTINCT FROM NEW.url
      )
    );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_duplicate_job_status ON public.jobs;

CREATE TRIGGER trg_sync_duplicate_job_status
AFTER INSERT OR UPDATE OF hidden, applied_at, company_id, job_id, url
ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.sync_duplicate_job_status();

-- One-time dedupe cleanup for rows that already exist with the same identity.
WITH duplicate_rows AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY
             COALESCE(company_id::text, ''),
             COALESCE(job_id::text, ''),
             COALESCE(url, '')
           ORDER BY
             CASE WHEN hidden THEN 0 ELSE 1 END,
             CASE WHEN applied_at IS NOT NULL THEN 0 ELSE 1 END,
             posted_at DESC NULLS LAST,
             first_seen_at DESC NULLS LAST,
             id DESC
         ) AS row_num
  FROM public.jobs
)
DELETE FROM public.jobs j
USING duplicate_rows d
WHERE j.id = d.id
  AND d.row_num > 1;

-- Optional: if you want a one-time cleanup immediately, run:
-- DELETE FROM public.jobs
-- WHERE posted_at IS NOT NULL
--   AND posted_at < NOW() - INTERVAL '7 days';

-- Optional alternative instead of hard delete:
-- CREATE OR REPLACE FUNCTION public.cleanup_old_jobs_soft()
-- RETURNS TRIGGER
-- LANGUAGE plpgsql
-- AS $$
-- BEGIN
--   UPDATE public.jobs
--   SET hidden = true,
--       is_active = false
--   WHERE posted_at IS NOT NULL
--     AND posted_at < NOW() - INTERVAL '7 days';
--   RETURN NEW;
-- END;
-- $$;
