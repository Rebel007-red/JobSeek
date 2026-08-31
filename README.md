# Job Seeker

A private React app that scrapes Greenhouse and Workday career pages every 30 minutes via GitHub Actions, stores jobs in Supabase, and serves them through a Netlify-hosted frontend with login.

---

## ?? Steps That Require YOUR Action

These steps cannot be automated — you must complete them manually.

---

### Step 1 — Create a Supabase Project

1. Go to [https://supabase.com](https://supabase.com) and sign up / log in.
2. Click **New Project**, fill in the name (e.g. `jobseeker`) and set a database password.
3. Once the project is ready, go to **Settings ? API** and copy:
   - **Project URL** ? `VITE_SUPABASE_URL`
   - **anon public** key ? `VITE_SUPABASE_ANON_KEY`
   - **service_role** key ? `SUPABASE_SERVICE_ROLE_KEY` *(keep this secret — used only by GitHub Actions)*

---

### Step 2 — Run the Database Migration

1. In your Supabase dashboard, go to **SQL Editor**.
2. Click **New Query**, paste the contents of `supabase/migrations/001_init.sql`, and click **Run**.
3. You should see `companies` and `jobs` tables appear under **Table Editor**.

---

### Step 3 — Create Your Login Account

1. In your Supabase dashboard, go to **Authentication ? Users**.
2. Click **Invite user** (or **Add user** ? **Create new user**).
3. Enter your email and a password. This is the account you will use to log in to the app.

> No sign-up page exists in the app — accounts are only created here.

---

### Step 4 — Add Companies to Scrape

Edit `scraper/companies.json`. Each entry has:

| Field      | Required for     | Description |
|------------|-----------------|-------------|
| `name`     | both            | Display name shown in the UI |
| `ats_type` | both            | `"greenhouse"` or `"workday"` |
| `slug`     | Greenhouse only | Board slug from the Greenhouse URL (e.g. `"acme"` from `boards.greenhouse.io/acme`) |
| `api_url`  | Workday only    | Full Workday JSON API endpoint (see below) |

**Finding a Workday API URL:**
1. Open the company's careers page in Chrome.
2. Open DevTools ? **Network** tab ? filter by **Fetch/XHR**.
3. Type something in the search box on the careers page.
4. Look for a POST request to a `*.myworkdayjobs.com/wday/cxs/*/jobs` URL.
5. Copy that full URL as `api_url`.

Example `companies.json`:
```json
[
  { "name": "Stripe", "ats_type": "greenhouse", "slug": "stripe" },
  { "name": "Shopify", "ats_type": "workday", "api_url": "https://shopify.wd1.myworkdayjobs.com/wday/cxs/shopify/shopify/jobs" }
]
```

---

### Step 5 — Push to GitHub

1. Create a **new repository** on [https://github.com](https://github.com) (can be private).
2. Push this folder:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

---

### Step 6 — Add GitHub Actions Secrets

1. In your GitHub repo, go to **Settings ? Secrets and variables ? Actions**.
2. Click **New repository secret** and add:
   - `SUPABASE_URL` ? your Project URL from Step 1
   - `SUPABASE_SERVICE_ROLE_KEY` ? your service_role key from Step 1
3. To test the scraper immediately: go to **Actions ? Scrape Jobs ? Run workflow**.

---

### Step 7 — Deploy to Netlify

1. Go to [https://app.netlify.com](https://app.netlify.com) and sign up / log in.
2. Click **Add new site ? Import an existing project** ? choose GitHub.
3. Select your repository.
4. Netlify will auto-detect Vite settings (`npm run build`, `dist`). Confirm and click **Deploy site**.
5. Once deployed, go to **Site configuration ? Environment variables** and add:
   - `VITE_SUPABASE_URL` ? your Project URL
   - `VITE_SUPABASE_ANON_KEY` ? your anon public key
6. Go to **Deploys ? Trigger deploy ? Deploy site** to rebuild with the env vars.

---

## Local Development

```bash
# Copy env file and fill in your values
cp .env.example .env

# Install dependencies
npm install

# Start dev server
npm run dev
```

To run the scraper locally:
```bash
cd scraper
npm install
# Create scraper/.env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
node index.js
```

---

## Project Structure

```
.
+-- src/                        # React frontend
¦   +-- components/
¦   ¦   +-- JobCard.jsx         # Individual job card
¦   ¦   +-- SearchFilter.jsx    # Search + filter bar
¦   ¦   +-- ProtectedRoute.jsx  # Auth guard
¦   +-- pages/
¦   ¦   +-- LoginPage.jsx       # Login form
¦   ¦   +-- JobsPage.jsx        # Main jobs listing
¦   +-- lib/supabase.js         # Supabase client
¦   +-- App.jsx                 # Router
+-- scraper/
¦   +-- companies.json          # ? Edit this to add/remove companies
¦   +-- index.js                # Scraper entry point
¦   +-- greenhouse.js           # Greenhouse API handler
¦   +-- workday.js              # Workday API handler
¦   +-- package.json
+-- supabase/
¦   +-- migrations/001_init.sql # DB schema — run once in Supabase SQL Editor
+-- .github/
¦   +-- workflows/scrape.yml   # GitHub Actions cron (every 30 min)
+-- netlify.toml                # Netlify build config
+-- .env.example                # Copy to .env for local dev
```

---

## Adding Companies Later

1. Edit `scraper/companies.json`
2. Commit and push to `main`
3. GitHub Actions will pick up the new companies on the next run (or trigger manually)
