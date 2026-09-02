-- Add missing columns to jobs table for full job aggregator support
-- This migration adds fields needed by the board scrapers and UI

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS skills text[] DEFAULT '{}';
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS posted_at timestamptz;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS hidden boolean DEFAULT false;

-- Create indexes for these new columns
CREATE INDEX IF NOT EXISTS jobs_skills_idx ON public.jobs USING gin(skills);
CREATE INDEX IF NOT EXISTS jobs_posted_at_idx ON public.jobs(posted_at DESC);
CREATE INDEX IF NOT EXISTS jobs_hidden_idx ON public.jobs(hidden);
