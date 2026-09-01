-- Add support for board job scrapers (jsearch, linkedin, naukri)
-- This alters the existing check constraint on ats_type

alter table public.companies
drop constraint companies_ats_type_check;

alter table public.companies
add constraint companies_ats_type_check 
  check (ats_type in ('greenhouse', 'workday', 'phenom', 'icims', 'oracle', 'successfactors', 'jsearch', 'linkedin', 'naukri'));
