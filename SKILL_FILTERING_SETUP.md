# Dynamic Skill Filtering - Setup & Testing Guide

## ✅ COMPLETED
- All 10 scrapers updated for dynamic skill loading
- Skill loader utility created and tested
- Frontend (Settings & Jobs pages) updated for Supabase sync
- Database schema ready for migration

## 🚀 Next Steps

### 1. Execute Supabase Migration

**Go to:** [Supabase Dashboard](https://app.supabase.com/) → Your Project → SQL Editor

**Copy & paste this SQL:**

```sql
-- Create a public user_skills table for storing user preferred skills
-- Each user has one record with their preferred skills for job filtering
-- Automatically created when user signs up via trigger

CREATE TABLE IF NOT EXISTS public.user_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skills text[] DEFAULT ARRAY['databricks', 'pyspark', 'sql'],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index for faster lookups by user_id
CREATE INDEX IF NOT EXISTS idx_user_skills_user_id ON public.user_skills(user_id);

-- Enable Row Level Security
ALTER TABLE public.user_skills ENABLE ROW LEVEL SECURITY;

-- Allow users to read their own skills record
CREATE POLICY "Users can read own skills"
  ON public.user_skills FOR SELECT
  USING (auth.uid() = user_id);

-- Allow users to update their own skills record
CREATE POLICY "Users can update own skills"
  ON public.user_skills FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Allow users to insert their own skills record (for manual creates)
CREATE POLICY "Users can insert own skills"
  ON public.user_skills FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Function to automatically create user_skills record when user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_skills (user_id, skills)
  VALUES (new.id, ARRAY['databricks', 'pyspark', 'sql'])
  ON CONFLICT (user_id) DO NOTHING;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create user_skills record automatically on signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

**Click "Run"**

Expected result: No errors, query completes silently.

---

### 2. Test Skills in UI

1. **Open app:** http://localhost:5173
2. **Go to Settings tab → Skills section**
3. **Add a skill:** Type "python" and press Enter
4. **Verify:** 
   - Skill appears in list with ✕ button
   - Automatically saves to Supabase

---

### 3. Run Scraper with User Skills

**Terminal:**
```bash
cd c:\Users\Administrator\Desktop\JobSeeker
$env:SUPABASE_URL='https://deczscnmmxpgpayyxglk.supabase.co'
$env:SUPABASE_SERVICE_ROLE_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlY3pzY25tbXhwZ3BheXl4Z2xrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODEzMzQ3NywiZXhwIjoyMTAzNzA5NDc3fQ.zp1V1NJuT-6f_cKFty5BXNLSwVqiCqEYGeEPMAxUIW8'
node scraper/index.js --boards
```

**Watch for:**
- `✓ Filter Skills: databricks, pyspark, sql, python` (your added skill should appear!)
- Jobs scraped and inserted with matching skills

---

### 4. Verify in UI

1. **Refresh jobs page** (or wait for auto-refresh)
2. **Check job cards:**
   - Skill match % should display
   - Matched skills should be highlighted in indigo
   - Unmatched skills should be in gray

---

## 📊 Skill Flow

```
User Settings (UI)
  ↓ (add skill)
  ↓
Supabase user_skills table
  ↓
On scraper run: loadFilterSkills() reads from Supabase
  ↓
Scrapers filter jobs using combined skills (user + core)
  ↓
Jobs with matching skills inserted to DB
  ↓
UI loads skills from Supabase on page load
  ↓
Job cards show skill match scores
```

---

## 🔍 Verification Checklist

- [ ] Migration runs in Supabase SQL Editor without errors
- [ ] `user_skills` table appears in Supabase Tables list
- [ ] Add skill in Settings → skill saves and persists on refresh
- [ ] Supabase SQL Editor: `SELECT * FROM user_skills;` shows your record
- [ ] Run scraper → console shows "✓ Filter Skills: ..." with your skills
- [ ] Jobs in database have correct skills matching
- [ ] Refresh UI → job cards show skill match scores
- [ ] Remove skill → verify in DB and UI updates

---

## ⚠️ Troubleshooting

**Skills not saving in Settings?**
- Check browser console for errors
- Verify Supabase RLS policies on `user_skills` table
- Check user is authenticated

**Scraper not loading user skills?**
- Check Supabase connection env vars are set
- Verify `user_skills` table exists in Supabase
- Check if user has a record in `user_skills` table

**Jobs not matching skills?**
- Verify skills in scraper console output
- Check job descriptions contain skill keywords
- Verify MIN_SKILL_KEYWORDS threshold (currently = 2)

---

## 📝 Migration File Location
- Path: `supabase/migrations/001_add_user_skills_table.sql`
- Can be re-run anytime (safe with `IF NOT EXISTS` and `DROP TRIGGER IF`)
