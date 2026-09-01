-- ============================================================
-- Job Aggregator — Initial Schema
-- Run this in your Supabase SQL Editor once.
-- ============================================================

-- Companies table: one row per career page you want to scrape
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  ats_type    text not null check (ats_type in ('greenhouse', 'workday', 'phenom', 'icims', 'oracle', 'successfactors', 'jsearch', 'linkedin', 'naukri')),
  slug        text,          -- Greenhouse board slug or board type (e.g. "acme" or "jsearch")
  api_url     text,          -- Workday full API URL or board query (e.g. "data engineer")
  disabled    boolean default false,  -- Allow disabling companies without deletion
  created_at  timestamptz default now()
);

-- Jobs table
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references public.companies(id) on delete cascade,
  job_id        text not null,        -- ID from the ATS (Greenhouse/Workday)
  title         text not null,
  location      text,
  department    text,
  url           text not null,
  first_seen_at timestamptz default now(),
  last_seen_at  timestamptz default now(),
  is_active     boolean default true,
  unique (company_id, job_id)
);

-- Indexes for common query patterns
create index if not exists jobs_company_id_idx   on public.jobs(company_id);
create index if not exists jobs_first_seen_idx   on public.jobs(first_seen_at desc);
create index if not exists jobs_is_active_idx    on public.jobs(is_active);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.companies enable row level security;
alter table public.jobs      enable row level security;

-- Authenticated users (you, logged into the React app) can read everything
create policy "Authenticated users can read companies"
  on public.companies for select
  to authenticated
  using (true);

create policy "Authenticated users can read jobs"
  on public.jobs for select
  to authenticated
  using (true);

-- The service role key (used by the GitHub Actions scraper) bypasses RLS
-- automatically, so no extra policy is needed for INSERT/UPDATE.
