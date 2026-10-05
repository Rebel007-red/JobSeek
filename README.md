# JobSeeker - AI Assisted

A personal job inbox. Scrapers collect fresh postings a few times a day, a Databricks pipeline cleans, enriches and
scores them against your profile, and a compact, mobile-first React app lets you triage them (apply / hide) fast.
Everything runs on free tiers (GitHub Actions, Databricks Free Edition, Netlify, Supabase).

```mermaid
flowchart LR
  A[GitHub Actions<br/>scrapers] -->|CSV| B[(Databricks volume)]
  A -->|trigger_job.py| C[Databricks job<br/>bronze → silver → enrich → gold → cleanup]
  B --> C
  C --> D[(gold.jobs<br/>ops.user_profile)]
  E[React app on Netlify] -->|/.netlify/functions/api| F[Netlify Function<br/>SQL proxy]
  F -->|SQL Statement API| D
  E -->|login, companies| G[(Supabase)]
  A -->|company list| G
```

## Features

- **Fresh jobs only**: the list shows the last 24 hours by default; the pipeline deletes jobs posted more than
  2 days ago that you did not apply to.
- **Fit score (0-100)** per job from your target roles, skills, experience and preferred cities, with a breakdown.
- **Fast triage**: list or card view, swipe right = applied, swipe left = hide (with Undo), keyboard shortcuts
  (`j`/`k`, `o`, `a`, `x`, `u`, `/`, `?`), detail drawer with next/previous.
- **Mobile first**: bottom tab bar, bottom-sheet filters, full-screen details, pull to refresh, installable (PWA).
- **Light / dark** theme follows the device.
- **Free-tier friendly**: reads are cached for up to an hour (auto sync), Netlify only deploys on frontend changes.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | React 19 app (Vite, react-router). `pages/` (Jobs, Settings, Login), `components/common/` (list row, card, drawer, filters, metrics), `hooks/`, `lib/api.js` (cached API client), `utils/` |
| `netlify/functions/api/` | Netlify Function: verifies the Supabase login and runs fixed, parameterised SQL on Databricks (`sql.mjs`); tests in `*.test.mjs` |
| `databricks/*.py` | Scrapers (Workday, Greenhouse, LinkedIn) + `upload_to_volume.py`; shared helpers in `scraper_common.py` |
| `databricks/jobs/` | `jobseeker_pipeline.json` (job definition), `deploy_job.py`, `trigger_job.py` |
| `databricks/notebooks/` | Pipeline notebooks `01_setup` … `06_cleanup` (+ `_common`, `00_capability_check`) |
| `.github/workflows/` | `databricks-scrapers.yml` (Workday + Greenhouse, every 12 h), `linkedin-databricks.yml` (every 4 h) |
| `supabase/` | SQL scripts for the Supabase project, run once in its SQL editor |

## Setup

### 1. Web app (local)

Requires Node.js 20+.

```bash
npm install
cp .env.example .env   # fill in the values
npm run dev            # http://localhost:5173 (also serves the API function)
```

`npm run build` builds to `dist/`. Tests: `node --test netlify/functions/api/*.test.mjs src/utils/*.test.js`.
Lint: `npm run lint`.

### 2. Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | `.env`, Netlify (build) | Login in the browser |
| `DATABRICKS_HOST`, `DATABRICKS_TOKEN` | `.env`, Netlify (functions), GitHub secrets | Databricks access (never sent to the browser) |
| `DATABRICKS_WAREHOUSE_ID` | `.env`, Netlify | SQL warehouse (optional, first warehouse otherwise) |
| `ALLOWED_EMAILS` | Netlify | Comma-separated emails allowed to use the job data (strongly recommended) |
| `DATABRICKS_CATALOG`, `DATABRICKS_JOB_NAME` | optional | Defaults `jobseeker`, `JobSeeeker` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | GitHub secrets | Scrapers read the company list |

### 3. Databricks

1. Import `databricks/notebooks/` into your workspace (default folder `/Workspace/Users/<you>/JobSeeker`).
2. Run `01_setup` once.
3. Create or update the job: `python databricks/jobs/deploy_job.py --notify-email you@example.com`
   (`--dry-run` prints the settings; `--notebook-dir` or `DATABRICKS_NOTEBOOK_DIR` overrides the folder).
4. Set your fit profile in the app (Settings → Profile), then "Re-score now".

The GitHub workflows upload CSVs and start the job; scheduled runs skip the notebooks' "Inspect" cells to save the
Free Edition compute quota.

### 4. Netlify

Build command `npm run build`, publish `dist`, functions `netlify/functions` (see `netlify.toml`). Builds are skipped
when a commit only touches scrapers, notebooks or workflows (each production deploy costs 15 of the 300 free credits).
