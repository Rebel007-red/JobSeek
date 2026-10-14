# JobSeeker - AI Assisted

A personal job inbox. Scrapers read the job boards of the companies you add (Workday, Greenhouse, Lever, Ashby,
SmartRecruiters, Workable, Oracle Recruiting, SAP SuccessFactors, Darwinbox, Keka) every 6 hours, a Databricks pipeline
cleans and enriches the postings, and a compact, mobile-first React app scores them against your profile and lets you
triage them (apply / hide) fast. Everything runs on free tiers (GitHub Actions, Databricks Free Edition, Netlify,
Supabase).

```mermaid
flowchart LR
  A[GitHub Actions<br/>scrapers + publish] -->|CSV| B[(Databricks volume<br/>ops/pipeline)]
  A -->|sync_user_data.py<br/>config/user_data.json| B
  A -->|trigger_job.py --wait| C[Databricks job<br/>ingest + silver → enrich → gold + cleanup → publish files]
  B --> C
  C -->|publish/run_id/| B
  B -->|publish_to_supabase.py| G[(Supabase Postgres<br/>private schema app)]
  G -->|pipeline_export_user_data| A
  E[React app on Netlify] -->|supabase.rpc app_read / app_write<br/>user session| G
  E -->|login, companies| G
```

The browser never waits for the Databricks SQL warehouse. It calls two Postgres functions (`public.app_read`,
`public.app_write`) with the signed-in user's session, and they score the jobs for that user inside Postgres.
Databricks is only the batch pipeline and never holds a Supabase credential: data moves between the two as files in
the Databricks volume, carried by GitHub Actions (which holds both sets of secrets).

- **Jobs out**: `04_gold_cleanup` writes the gold snapshot to `publish/<run_id>/` (manifest last), and
  `publish_to_supabase.py` sends only the changed rows to Supabase. It never deletes a job someone applied to.
- **User data in**: `sync_user_data.py` exports profiles, applied jobs and custom roles/skills from Supabase to
  `config/user_data.json`, and `02_ingest_silver` loads it at the start of the run (LinkedIn searches, custom-role
  checks and job retention use it).
- **Companies in**: the scrapers read the company list (`public.companies`: name, ATS type, board link) from Supabase.
- **Derived job columns** (city, work mode, employment kind, duplicate group) are computed in Postgres: a trigger on
  `app.jobs` fills them on every publish upsert, and `pipeline_publish_finish` refreshes them after it replaces the
  city reference list. The publish files and the notebooks do not carry them.
- **Run status in**: each scraper writes a small report, which the workflow sends to Supabase; every publish also
  copies the newest Databricks job runs (Jobs API, no compute). Admins see both in Settings → System.

## Features

- **Inbox · Saved · Applied**: the list opens on the Inbox, the jobs you haven't saved, applied to or hidden (For
  you, every live job by default, i.e. the last 7 days; the window menu narrows it to the last 24 hours or 3 days, and
  one scope menu switches to Everything). The three tabs never count a job twice. Jobs you haven't saved or applied to
  disappear 7 days after posting, at the first update after midnight UTC; the "Expiring tonight" strip above the Inbox
  lists the ones for you that go tonight, and rows say "Disappears in ~9h". Applications to postings over 7 days old
  stay on the Applied tab (they may still be open; the CSV marks them "Older posting").
- **New since your last visit**: jobs found since you last opened the app (at least 30 minutes ago) get a dot, and
  the header says "N new since 9:51 AM". An empty Inbox says you're caught up and when the next jobs should arrive.
- **Decide first, track later**: the detail drawer of a new job shows the actions, the fit and the description
  first, and "Also posted in N places" (the other postings of a repost, ✓ on the one you applied to). A saved or
  applied job gets one stage stepper at the top (Saved — Applied — Interviewing — Offer, then No reply · Rejected ·
  Withdrawn; `t` focuses it) with the note and follow-up date below it.
- **Applied tab as a tracker**: one dense row per application (company · title, a stage pill that opens a "Move to"
  menu, "Applied 8d ago", "Next Oct 12" or a Needs action flag), sorted "Needs action first" (your follow-up date
  came, an interview with no update for 7 days, then an application with no update for 14 days). Stage chips (Needs action, Waiting,
  Interviewing, Offer, No reply, Rejected, Withdrawn) with counts; finished applications (Rejected, Withdrawn, No
  reply) fold into "Finished · N" at the bottom. Bulk "Move to…", note and CSV export as before.
- **Closing the loop**: once a week (your first visit to the Applied tab that week) "How did last week go?" lists applications with no
  update for 7+ days, with one-tap answers (Heard back, Rejected, No reply yet, Withdrawn; "No reply" is suggested
  from 21 days after applying). The Applied tab's funnel line says "138 applied → 4 replies (3%) → 2 interviews · median
  reply 6 d" (with a by-source and by-role breakdown once 10 outcomes are recorded) and reopens the check-in by hand.
- **First session**: after the welcome save the Inbox opens with "Your first 5", the five best For-you fits to save,
  apply to or hide, and a nudge to add cities for the My cities chip.
- **Less noise**: reposts of the same job are shown once ("+2 more · Pune, Chennai"), mute rules hide companies,
  title words or levels, and hiding a job asks why.
- **Fit score (0-100)** per job from your target roles (related roles score partly), skills (rare skills count more)
  and experience, shown as points that add up to it ("49 = 40 role + 7 skills + 2 experience"), with the skills a
  job asks for that are not in your profile ("+ I know this" adds one). "For you" hides jobs that ask for more than ~2 years above your maximum.
- **Preferred cities (optional, up to 3)**: the My cities chip then shows jobs there (and remote ones). They also add
  LinkedIn searches for your roles in that city (without any, the LinkedIn search covers all of India), but LinkedIn
  is searched only when its workflow is started by hand.
- **Filters that show what they do**: the filter panel (Fit · Where · What) applies every change at once, and its
  button says how many jobs you will see ("Show 42 jobs"). An empty filtered list names what hides the jobs ("No jobs
  match “snowflke” in For you · last 24h") and offers up to three one-tap relaxations with their counts ("Clear search ·
  95").
- **Fast triage**: list or card view, swipe right = save, swipe left = hide (Settings → Account "Swipe right marks
  applied" restores the old swipe; touches that start at the screen edge are ignored), with Undo up to 5 steps, bulk
  selection, keyboard shortcuts (`j`/`k`, `o`, `a`, `s`, `t`, `x`, `u`, `/`, `f`, `1`-`3`, `?` for the full list),
  detail drawer with next/previous. The list state is in the URL, so Back and shared links work.
- **Admin**: Settings → System shows a Metrics card (strong-fit applications per active user per week, coverage,
  return and outcome capture; counters only, no job links or searches stored), the pipeline runs, each scraper's last
  result, dropped LinkedIn searches and the database size; Settings → Access manages who may use the app (with each
  user's last activity and applications in the last 7 days).
- **Fast loads**: the last results show instantly from the browser cache and refresh in the background. The page
  says when the job data was last published ("Updated 2 h ago"), or, when the newest scrape found nothing new,
  "Checked 1 h ago · no new jobs"; after 6 hours without either it turns amber and a banner says the job updates are
  delayed. It reloads by itself when a new update is published.
- **Mobile first**: fixed bottom bar (Inbox / Saved / Applied / Search / Filters), also in phone landscape and on
  tablets up to 960px, bottom-sheet filters, full-screen details, pull to refresh, installable (PWA).
- **Light / dark** theme follows the device.
- **Free-tier friendly**: no serverless function or warehouse in the request path; Netlify only deploys on frontend
  changes. The pipeline runs only for new jobs: when the scrapers found only jobs it already has, the Databricks run
  is skipped (at least one run a day still happens), Settings → System says "Skipped: no new files", and the app
  says "Checked 1 h ago · no new jobs".

## Repository layout

| Path | What it is |
|---|---|
| `src/` | React 19 app (Vite, react-router). `pages/` (Jobs, Settings, Login), `components/common/` (list row, card, drawer, filters, metrics), `hooks/`, `lib/api.js` (cached client for the Supabase RPCs), `utils/` |
| `supabase/` | `app_schema.sql` + `app_api.sql` (private schema `app`, the app RPCs and the service-only pipeline RPCs; applied by `apply.py`), `tests/` (Postgres tests, `parity.py` against the Spark scoring), `multi_user.sql` (login, admin role, companies) |
| `databricks/*.py` | Scrapers (`workday.py`, `greenhouse.py`, `linkedin.py`, and `ats_scrape.py` for the API / HTML boards) + `upload_to_volume.py`; shared helpers in `scraper_common.py` |
| `databricks/ats/` | One adapter per API / HTML board (`lever.py`, `ashby.py`, `smartrecruiters.py`, `workable.py`, `oracle.py`, `successfactors.py`, `darwinbox.py`, `keka.py`), the shared framework (`base.py`: polite HTTP, robots.txt, dates, India filter, rows) and `registry.py` (names and labels); offline tests in `databricks/tests/ats/` |
| `databricks/jobs/` | `jobseeker_pipeline.json` (pipeline job), `jobseeker_setup.json` (setup job), `deploy_job.py`, `trigger_job.py`, `sync_user_data.py`, `publish_to_supabase.py` (also records the run history), `record_scrape_report.py`, `record_trigger.py` (all four use `supabase_api.py`; dependencies in `requirements.txt`), `migrate_user_data.py` (one-off), `test_scrape_report.py`, `test_trigger.py` |
| `databricks/notebooks/` | `01_setup` (setup job), pipeline notebooks `02_ingest_silver`, `03_enrich`, `04_gold_cleanup` (+ `_common`, `00_capability_check`) |
| `.github/workflows/` | `databricks-scrapers.yml` ("ATS Scrapers", every 6 h at :07 UTC: Workday + Greenhouse + the API boards, sync user data, run the pipeline when there are new jobs (or `force`, or daily), record the decision, publish), `linkedin-databricks.yml` (manual runs only: LinkedIn search, then the same pipeline and publish), `publish-supabase.yml` (hourly catch-up publish); `.github/actions/scrape-to-volume` (scrape, upload, record the report) |

## Setup

### 1. Web app (local)

Requires Node.js 20+.

```bash
npm install
cp .env.example .env   # fill in the values
npm run dev            # http://localhost:5173 (talks to your Supabase project directly)
```

`npm run build` builds to `dist/`. Lint: `npm run lint`. Tests:

```bash
npm test                                           # node --test src/utils/*.test.js (incl. the SQL constants check)
python -m unittest discover -s supabase/tests -v   # Postgres tests (TEST_DATABASE_URL or SUPABASE_DB_URL; rolled back)
python supabase/tests/parity.py                    # Supabase scoring vs the frozen Spark statements, right after a publish
python databricks/jobs/test_scrape_report.py       # scrape reports, run history, pipeline constants (offline)
python databricks/jobs/test_trigger.py             # new-job counts, pipeline decisions, their record (offline)
python -m unittest discover -s databricks/tests/ats -t databricks/tests/ats   # ATS adapters on saved samples (offline)
```

### 2. Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | `.env`, Netlify (build) | Login and all app data in the browser (the only Netlify variables) |
| `DATABRICKS_HOST`, `DATABRICKS_TOKEN` | `.env`, GitHub secrets | Databricks jobs and volume files (scripts and workflows only) |
| `DATABRICKS_WAREHOUSE_ID` | `.env` | SQL warehouse for `migrate_user_data.py` and `parity.py` (optional, first warehouse otherwise) |
| `DATABRICKS_CATALOG`, `DATABRICKS_JOB_NAME` | optional | Defaults `jobseeker`, `JobSeeeker` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `.env`, GitHub secrets | Company list for the scrapers, user-data export and job publish (service-only RPCs). Never on Netlify, never in Databricks |
| `SUPABASE_DB_URL` | `.env` only | Postgres connection string for `supabase/apply.py`, `migrate_user_data.py` and the Supabase tests |

Who may use the job data: the `app.allowed_emails` table (empty = any signed-in user; sign-ups are invite-only).
Admins (`app_metadata.role = 'admin'`) always pass and can add or remove emails through the `setAllowedEmail` action.

### 3. Databricks

One command imports the notebooks, creates or updates both jobs and runs the setup job (re-run it after every
notebook change; the setup job is idempotent and only rewrites reference tables whose content changed):

```bash
python databricks/jobs/deploy_job.py --import-notebooks --run-setup --notify-email you@example.com
```

- `--import-notebooks` imports every `databricks/notebooks/*.ipynb` into the notebook folder (default
  `/Workspace/Users/<you>/JobSeeker`; `--notebook-dir` or `DATABRICKS_NOTEBOOK_DIR` overrides it) and warns about
  workspace notebooks that are no longer in the repo.
- `--run-setup` runs the **JobSeeker setup** job (`01_setup`) and waits for it. `--run-now` also starts a pipeline run.
- `--dry-run` prints both job definitions and changes nothing.

Then set your profile in the app (Settings → Profile).

#### Jobs

| Job | Schedule | Tasks |
|---|---|---|
| `JobSeeeker` | Started by `databricks-scrapers.yml` every 6 h (and by manual `linkedin-databricks.yml` runs; queue on, one run at a time) | `Step_01_Ingest_Silver` (`02_ingest_silver`: app user data from `config/user_data.json`, Auto Loader → bronze, clean + MERGE India jobs → silver) → `Step_02_Enrich` (`03_enrich`: pending rows only; experience, skills, role via cached embeddings + capped LLM calls, `ops.role_similarity`) → `Step_03_Gold_Cleanup` (`04_gold_cleanup`: scraper config files, MERGE → `gold.jobs`, `ops.skill_stats`, expiry, publish files for Supabase; retention daily, OPTIMIZE/VACUUM weekly) |
| `JobSeeker setup` | None (run by `--run-setup` or by hand) | `01_setup`: all DDL, reference data, the setup marker |

All DDL lives in `01_setup`. It ends by setting `jobseeker.setup_version` on `ops.pipeline_runs`; every pipeline
notebook checks it through `_common` and stops with "Run the 'JobSeeker setup' job (01_setup) first" when the catalog
is older than the notebooks. Scheduled runs skip the notebooks' "Inspect" cells to save the Free Edition compute quota.

#### Scrapers and triggers

- **The 7-day rule**: a job is live while it was posted within the last 7 days. Every scraper keeps jobs posted at most
  7 days ago (`scraper_common.MAX_POSTED_DAYS`, env `MAX_POSTED_DAYS`), `03_enrich` spends model calls on the same
  window (`job_max_age_days`), and `04_gold_cleanup` expires and deletes untracked jobs posted more than 7 days ago
  (`job_expire_after_days`, `job_delete_after_days`; the app's `app.c_job_delete_after_days()` matches). Jobs a user
  saved or applied to are kept.
- **ATS Scrapers** (`databricks-scrapers.yml`, 00:07 / 06:07 / 12:07 / 18:07 UTC = 05:37 / 11:37 / 17:37 / 23:37 IST,
  and by hand) runs three scrape jobs side by side, then the pipeline and the publish:
  - `workday`: `workday.py` (Playwright, 90 min limit);
  - `greenhouse`: `greenhouse.py` (boards API, 30 min);
  - `ats`: `ats_scrape.py --all-api` (HTTP only, 90 min): Lever, Ashby, SmartRecruiters, Workable, Oracle Recruiting,
    SAP SuccessFactors, Darwinbox and Keka. Each ATS that has companies writes `databricks/output/ats/<ats>_<timestamp>.csv`
    (all of them are uploaded), its report, and the run manifest `databricks/output/ats_scrape_manifest.json`. An ATS
    without companies is skipped.
  - `pipeline` runs once all three ended, also when one failed (`if: !cancelled()`): it adds up the scrape jobs'
    upload counters, runs `sync_user_data.py`, then `trigger_job.py --wait` (with new jobs: scheduled runs always
    start one, manual runs not within 3 h of the last run), and records the decision.
  - `publish` as below (after a skipped pipeline it finds nothing newer and ends in seconds).
- **The pipeline runs only for new jobs** (it is the Databricks compute; the scrapes are free):
  - `upload_to_volume.py` uploads every CSV that has data rows (a header-only CSV is skipped) and counts the rows whose
    `job_key` is not in `config/ats_seen_keys.json` (the jobs silver already has with a description). It writes
    `uploaded`, `new_files` (uploaded files with at least one new job), `new_jobs`, `empty_files` and
    `seen_keys=loaded|unavailable` to `$GITHUB_OUTPUT`, also when an upload fails, and the composite action passes the
    first three on as outputs. When the seen keys can't be read every row counts as new, so an unknown answer only
    ever starts a run. Files without new jobs are still uploaded: the next run ingests the sightings.
  - The `pipeline` job's `Count new files` step adds them up (a failed scrape job counts 0) and prints a notice and a
    run summary line. With `new_files` 0 it calls `trigger_job.py --no-new-files --idle-hours 20`: no run while one
    is active (nothing is waited for), nor when the latest run started less than 20 h ago (decision `no_new`).
    Otherwise it starts the **daily run** (`started_daily`), so expiry, the deletion of week-old jobs and the daily
    retention still happen on a quiet day (`app.c_daily_floor_hours()` matches the 20 h). A latest run that failed
    is run again at once (also `started_daily`): it may have written the seen keys before failing to publish.
  - **Run it anyway**: Actions → ATS Scrapers → Run workflow with **force** ticked (`workflow_dispatch` input
    `force`, default off) starts the pipeline whatever the counters say, with no 3-hour gap either.
  - Databricks pausing new runs (`FEATURE_DISABLED`, Free Edition over its allowance) stays a warning (decision
    `paused`): the uploaded files are kept and the next allowed run ingests them.
  - `record_trigger.py` (`if: always()`, `continue-on-error`, always exits 0) sends the decision (`started`,
    `started_daily`, `waiting`, `recent`, `paused`, `no_new`, or `failed` when `trigger_job.py` ended without one),
    the counters, the run id and its result to `pipeline_record_trigger` (`app.pipeline_triggers`, newest 50).
    Settings → System lists them as "Pipeline decisions", and the app says "Checked 1 h ago · no new jobs" instead of
    "Updated 9 h ago" after a skip.
  - The seen-key sources are Workday, Greenhouse and the eight API / HTML boards (`04_gold_cleanup`
    `SEEN_KEY_SOURCES`). LinkedIn has no seen keys here: its manual workflow always triggers.
- **Being polite to the boards**: the API scrapers send an honest User-Agent (`JobSeekerBot/1.0`, with the repository
  link), make one request at a time per host with a delay (or the host's robots.txt `Crawl-delay`), retry 429 / 5xx
  with backoff, respect robots.txt and cap requests and detail fetches per company. Workday and the ATS scrapers skip
  the description request for jobs the pipeline already has (`config/ats_seen_keys.json`, written by
  `04_gold_cleanup`). Knobs (workflow or repository variables): `ATS_ROBOTS_OVERRIDE` (repository variable;
  comma-separated ATS scraped although their robots.txt disallows the API path, e.g. `smartrecruiters`, whose robots.txt
  allows only LinkedIn's crawler; empty by default, so those companies show "Failing: robots.txt ..."),
  `ATS_MAX_DETAILS_PER_COMPANY` (150), `ATS_MAX_REQUESTS_PER_COMPANY` (600), `ATS_TIME_BUDGET_S` (3600 per ATS; the
  workflow sets 3000) and `ATS_PARALLEL` (3 ATS at once; the workflow runs all 8 at once, each on its own hosts, so the
  job ends before its 90 min limit: the CSVs are uploaded only after the whole scrape).
- **Companies**: Settings → Companies takes the company's careers / board link for each ATS and stores what the
  scraper needs (`slug`, `api_url`; `databricks/ats/<ats>.py` `source_columns`, mirrored by `src/utils/atsSources.js`).
  Links that need a request to resolve (Oracle vanity domains, Workable `/j/` links) are resolved by the scraper at run
  time; a company the scraper cannot read shows its reason in the health badge.
- Greenhouse rows may hold the board token, the board URL or the API URL in `slug` or `api_url` (slug wins);
  `greenhouse.py` derives the token (`board_token`) and always builds the API URL from it.
- **LinkedIn** (`linkedin-databricks.yml`) runs only when started by hand: it uploads, then calls
  `trigger_job.py --min-interval-hours 3 --wait` (no new run while one is waiting to start, or when the latest run
  started less than 3 hours ago; the next ATS run then ingests the CSV). `PIPELINE_MIN_INTERVAL_HOURS` sets the same
  for other callers (default 0 = off). It searches every user role × preferred city (India-wide for users without
  cities), newest first, posted in the last 12 hours; jobs already in silver with a description
  (`config/linkedin_seen_ids.json`) skip the detail page. Knobs (workflow `env`): `LINKEDIN_ROLE_TARGET_JOBS` (250 per
  search), `MAX_LINKEDIN_SEARCHES` (90), `LINKEDIN_SEARCH_DELAY_SECONDS` (5). Companies rows of type `linkedin` are
  extra India-wide searches: their `api_url` holds the search keywords.
- **Scrape reports**: every scraper writes `databricks/output/<source>_report.json` on every exit path
  (`jobseeker.scrape_report.v1`: status ok / partial / failed / crashed, totals, one `{name, ok, jobs_found, error}` per
  company or search, and for LinkedIn the search count, the cap and the dropped searches). The composite action's last
  step (`if: always()`, `continue-on-error`) runs `record_scrape_report.py`, which sends it to
  `pipeline_record_scrape`; without a report it records the run as crashed. For `ats_scrape.py` it reads the run
  manifest and sends the report of every ATS the run started (a missing one as crashed). It always exits 0, so it never
  fails a scrape. Supabase keeps 30 runs per source (`app.scrape_runs`) and the latest result per company
  (`app.scrape_companies`, consecutive failures and the last error), which drive the company health badges.

#### Publishing to Supabase

- `databricks-scrapers.yml` (and the manual `linkedin-databricks.yml`) end with two jobs: `pipeline`
  (`sync_user_data.py`, allowed to fail so a Supabase outage never stops ingestion, then `trigger_job.py --wait`, in
  the ATS workflow only when there are new jobs, on `force` or for the daily run) and `publish`
  (`publish_to_supabase.py`, also after a failed or timed-out wait). New jobs reach the app about 2 hours after the
  scheduled start.
- `publish-supabase.yml` runs the same publish hourly at :50 (and by hand, with optional `run_id` / `force`). It exits
  in seconds when the newest complete `publish/<run_id>/` is already in Supabase, so the app is at most about an hour
  behind a finished run.
- The publish refuses a snapshot that is older than the published one or that would shrink the job table by more
  than half (`--force` overrides), and never deletes a job any user tracks (applied, any stage, or saved).
- Every publish that applies a run writes `app.publish_history` (newest 50) and prunes hide feedback older than 180
  days. Every publish run that is not a dry run, skipped ones included, then sends the newest 20 runs of the
  `JobSeeeker` job (Jobs API `runs/list`, no compute) to `pipeline_record_runs` (`app.pipeline_runs`, newest 50); a
  failure there only prints a warning. Per-task row counts are not recorded yet (they would need a notebook change).

### 4. Supabase

1. Run `supabase/multi_user.sql` once in the SQL editor (login, admin role, companies).
2. `python supabase/apply.py` applies `app_schema.sql` + `app_api.sql` (idempotent; needs `SUPABASE_DB_URL`;
   `--check` only reports whether it is set). Schema `app` is private: do not add it to the API's exposed schemas.
   Applying also backfills the derived job columns.

Service-only RPCs (service role key, used by the GitHub workflows): `pipeline_export_user_data`, `pipeline_publish_state`,
`pipeline_publish`, `pipeline_publish_finish`, `pipeline_record_scrape` (scrape reports), `pipeline_record_runs`
(Databricks run history) and `pipeline_record_trigger` (the ATS workflow's pipeline decisions). The admin-only
`systemStatus` read combines them with the database size for Settings → System. Notes, follow-up dates, hide reasons, mute rules and feedback stay in Supabase: the user-data export never
includes them.

### 5. Netlify

Build command `npm run build`, publish `dist` (see `netlify.toml`); there are no functions. Builds are skipped when a
commit only touches scrapers, notebooks, Supabase SQL or workflows (each production deploy costs 15 of the 300 free
credits).

### 6. Moving from the Databricks-served app (one time)

1. `python supabase/apply.py`
2. `python databricks/jobs/deploy_job.py --import-notebooks` (02 keeps the user tables while there is no
   `user_data.json`; 04 writes publish files).
3. Run the pipeline once (or wait for the ATS Scrapers workflow), then `python databricks/jobs/publish_to_supabase.py`.
4. `python databricks/jobs/migrate_user_data.py --dry-run`, then without `--dry-run` (newest change wins, safe to
   re-run). Run the Supabase tests and `parity.py` (expect 0 mismatches).
5. Push (one Netlify deploy). Re-run `migrate_user_data.py` right away, before the next ATS Scrapers workflow run, to
   catch changes made on the old app in between (the first sync-in overwrites the Databricks user tables).
6. Remove `DATABRICKS_*` and `ALLOWED_EMAILS` from the Netlify site settings.
