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
