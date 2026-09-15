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
