import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function useUserSkills() {
  const [skills, setSkills] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSkills()
  }, [])

  const loadSkills = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data } = await supabase
        .from('user_skills')
        .select('skills')
        .eq('user_id', user.id)
        .single()

      if (data?.skills) {
        setSkills(data.skills)
      }
    } catch (err) {
      console.debug('Could not load skills:', err.message)
    } finally {
      setLoading(false)
    }
  }

  const updateSkills = async (newSkills) => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      await supabase
        .from('user_skills')
        .upsert({ user_id: user.id, skills: newSkills })
        .eq('user_id', user.id)

      setSkills(newSkills)
    } catch (err) {
      console.error('Failed to update skills:', err.message)
      throw err
    }
  }

  return { skills, loading, updateSkills, reload: loadSkills }
}
