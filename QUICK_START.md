# ⚡ Quick Start: Dynamic Skill Filtering

## 🎯 What's Ready
✅ All 10 scrapers with dynamic skill loading  
✅ Frontend synced to Supabase  
✅ Database schema ready  
✅ Scraper tested and working  

## 📋 Execute Migration (1 step)

### Copy This SQL:
```sql
CREATE TABLE IF NOT EXISTS public.user_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skills text[] DEFAULT ARRAY['databricks', 'pyspark', 'sql'],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_skills_user_id ON public.user_skills(user_id);

ALTER TABLE public.user_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own skills"
  ON public.user_skills FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own skills"
  ON public.user_skills FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can insert own skills"
  ON public.user_skills FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_skills (user_id, skills)
  VALUES (new.id, ARRAY['databricks', 'pyspark', 'sql'])
  ON CONFLICT (user_id) DO NOTHING;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

### Execute in Supabase:
1. Go to: https://app.supabase.com/project/deczscnmmxpgpayyxglk/sql/new
2. Paste SQL above
3. Click "Run"
4. ✅ Done!

---

## 🧪 Test It

**In Terminal:**
```bash
cd c:\Users\Administrator\Desktop\JobSeeker
$env:SUPABASE_URL='https://deczscnmmxpgpayyxglk.supabase.co'
$env:SUPABASE_SERVICE_ROLE_KEY='<paste key here>'
node scraper/index.js --boards
```

**In UI (http://localhost:5173):**
1. Go to **Settings** tab
2. Click **Skills** section
3. Type "python" and press Enter
4. Should save automatically ✓
5. Refresh Jobs page
6. Job cards show skill match % with your skills ✓

---

## 📊 Expected Output

**Scraper Console:**
```
✓ Loaded skills from user xyz: databricks, pyspark, sql, python
Filter Skills: databricks, pyspark, sql, python
  → Fetching JSearch: "pyspark databricks..."
    Found 8 jobs
  Upserted 4 jobs
```

**UI:**
- Jobs show: "python 40% ✦" (skill match percentage)
- Matched skills: indigo colored tags
- Unmatched skills: gray colored tags

---

## 📁 Key Files

| File | Purpose |
|------|---------|
| `supabase/migrations/001_add_user_skills_table.sql` | Migration (copy above) |
| `scraper/load-user-skills.js` | Loads user skills at runtime |
| `DYNAMIC_SKILLS_README.md` | Full documentation |
| `SKILL_FILTERING_SETUP.md` | Step-by-step guide |

---

## ✨ Features

- ✅ User skills stored in Supabase (auto-synced)
- ✅ Scraper loads skills at runtime (not hardcoded)
- ✅ Jobs filtered by skill match
- ✅ Skill match % displayed in UI
- ✅ Graceful fallback to defaults
- ✅ RLS policies secure user data
- ✅ Auto-create user record on signup

---

**Status:** Ready to deploy! Just run the SQL migration. 🚀
