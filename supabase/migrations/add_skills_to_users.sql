-- Add skills column to users table
-- This stores the user's preferred skills for job filtering
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS skills text[] DEFAULT ARRAY['databricks', 'pyspark', 'sql'];

-- Create index for faster filtering
CREATE INDEX IF NOT EXISTS idx_users_skills ON auth.users USING gin(skills);

-- Grant RLS permissions for users to update their own skills
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read their own skills
CREATE POLICY "Users can read own skills" ON auth.users
  FOR SELECT
  USING (auth.uid() = id);

-- Allow authenticated users to update their own skills
CREATE POLICY "Users can update own skills" ON auth.users
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
