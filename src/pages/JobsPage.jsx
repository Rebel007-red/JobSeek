import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { JobCard } from '../components/JobCard'
import { SearchFilter } from '../components/SearchFilter'
import { supabase } from '../lib/supabase'

const PAGE_SIZE = 24

const DEFAULT_FILTERS = { keyword: '', companyId: '', location: '', department: '' }

// Parse comma-separated skills string into lowercase array
function parseSkills(str) {
  return str.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

// Return which of the user's skills appear in the job
function getMatchedSkills(job, userSkills) {
  if (!userSkills.length) return []
  const haystack = `${job.title} ${job.department || ''} ${job.location || ''}`.toLowerCase()
  return userSkills.filter(skill => haystack.includes(skill))
}

export function JobsPage() {
  const navigate = useNavigate()
  const [jobs, setJobs] = useState([])
  const [companies, setCompanies] = useState([])
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  // Read skills directly from localStorage (managed in Settings page)
  const [userSkills, setUserSkills] = useState(() =>
    parseSkills(localStorage.getItem('jobseeker_skills') || '')
  )

  // Re-read skills from localStorage when window gains focus (in case user updated in Settings)
  useEffect(() => {
    const onFocus = () => setUserSkills(parseSkills(localStorage.getItem('jobseeker_skills') || ''))
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Load companies once for the filter dropdown
  useEffect(() => {
    supabase
      .from('companies')
      .select('id, name')
      .order('name')
      .then(({ data }) => setCompanies(data || []))
  }, [])

  const fetchJobs = useCallback(async (currentFilters, currentPage) => {
    setLoading(true)
    setError('')

    let query = supabase
      .from('jobs')
      .select('*, companies(name)', { count: 'exact' })
      .eq('is_active', true)
      .eq('hidden', false)
      .order('posted_at', { ascending: false, nullsFirst: false })
      .order('first_seen_at', { ascending: false })
      .range(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE - 1)

    if (currentFilters.keyword) {
      query = query.ilike('title', `%${currentFilters.keyword}%`)
    }
    if (currentFilters.companyId) {
      query = query.eq('company_id', currentFilters.companyId)
    }
    if (currentFilters.location) {
      query = query.ilike('location', `%${currentFilters.location}%`)
    }
    if (currentFilters.department) {
      query = query.ilike('department', `%${currentFilters.department}%`)
    }

    const { data, error: fetchError, count } = await query

    if (fetchError) {
      setError(fetchError.message)
      setLoading(false)
      return
    }

    // Deduplicate by id (safety net)
    const deduped = (data || []).filter(
      (job, idx, arr) => arr.findIndex(j => j.id === job.id) === idx
    )

    if (currentPage === 0) {
      setJobs(deduped)
    } else {
      setJobs((prev) => {
        const existingIds = new Set(prev.map(j => j.id))
        return [...prev, ...deduped.filter(j => !existingIds.has(j.id))]
      })
    }

    setHasMore((currentPage + 1) * PAGE_SIZE < (count || 0))
    setLoading(false)
  }, [])

  // Reset and refetch when filters change
  useEffect(() => {
    setPage(0)
    fetchJobs(filters, 0)
  }, [filters, fetchJobs])

  // Fetch next page
  useEffect(() => {
    if (page > 0) fetchJobs(filters, page)
  }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  async function handleHide(jobId) {
    // Optimistic: remove from local state immediately
    setJobs(prev => prev.filter(j => j.id !== jobId))
    await supabase.from('jobs').update({ hidden: true }).eq('id', jobId)
  }

  async function handleApplied(jobId, markAsApplied) {
    const applied_at = markAsApplied ? new Date().toISOString() : null
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, applied_at } : j))
    const { error } = await supabase.from('jobs').update({ applied_at }).eq('id', jobId)
    if (error) console.error('Failed to save applied status:', error.message)
  }

  const newCount = useMemo(
    () => jobs.filter((j) => {
      const ref = j.posted_at || j.first_seen_at
      return ref && Date.now() - new Date(ref).getTime() < 2 * 24 * 60 * 60 * 1000
    }).length,
    [jobs]
  )

  // Compute skill matches and sort: matched jobs first
  const jobsWithMatches = useMemo(() => {
    const withScores = jobs.map(job => ({
      job,
      matched: getMatchedSkills(job, userSkills),
    }))
    if (!userSkills.length) return withScores
    // Sort: most matches first, then by first_seen_at
    return [...withScores].sort((a, b) => b.matched.length - a.matched.length)
  }, [jobs, userSkills])

  const matchCount = useMemo(
    () => jobsWithMatches.filter(({ matched }) => matched.length > 0).length,
    [jobsWithMatches]
  )

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Top nav */}
      <header className="bg-gray-900/95 backdrop-blur border-b border-gray-800/60 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 h-11 flex items-center justify-between gap-3">

          {/* Left: Brand + stats */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[13px] font-bold text-gray-100 tracking-tight">Job Seeker</span>
            {newCount > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 whitespace-nowrap">
                {newCount} new
              </span>
            )}
            {!loading && jobs.length > 0 && (
              <span className="hidden sm:block text-[10px] text-gray-600 whitespace-nowrap">
                {jobs.length} jobs{matchCount > 0 && <span className="text-indigo-500/70"> · {matchCount} match</span>}
              </span>
            )}
          </div>

          {/* Right: Search + filters + nav */}
          <div className="flex items-center gap-1.5">
            <SearchFilter filters={filters} companies={companies} onChange={setFilters} />

            <div className="w-px h-4 bg-gray-700/60 mx-0.5" />

            {/* Settings */}
            <button onClick={() => navigate('/settings')} title="Settings"
              className="p-1.5 text-gray-500 hover:text-gray-200 hover:bg-gray-800 rounded-md transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>

            {/* Sign out */}
            <button onClick={handleSignOut} title="Sign out"
              className="p-1.5 text-gray-500 hover:text-gray-200 hover:bg-gray-800 rounded-md transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>

        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-2.5">
        {/* Error */}
        {error && (
          <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {/* Grid — 1 col mobile, 2 sm, 3 lg, 4 xl */}
        {jobsWithMatches.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
            {jobsWithMatches.map(({ job, matched }) => (
              <JobCard key={job.id} job={job} matchedSkills={matched} onHide={handleHide} onApplied={handleApplied} />
            ))}
          </div>
        ) : !loading ? (
          <div className="text-center py-16 text-gray-600">
            <p className="text-base font-medium">No jobs found</p>
            <p className="text-sm mt-1">Try adjusting your filters</p>
          </div>
        ) : null}

        {/* Skeleton loader */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="bg-gray-800 border border-gray-700 rounded-lg p-3 h-32 animate-pulse">
                <div className="h-3 bg-gray-700 rounded w-3/4 mb-2" />
                <div className="h-2.5 bg-gray-700/60 rounded w-1/3 mb-3" />
                <div className="h-2.5 bg-gray-700/40 rounded w-1/2" />
              </div>
            ))}
          </div>
        )}

        {/* Load more */}
        {hasMore && !loading && (
          <div className="text-center pt-2">
            <button onClick={() => setPage(p => p + 1)}
              className="px-5 py-1.5 text-xs font-medium text-indigo-400 border border-indigo-800 rounded-md hover:bg-indigo-900/30 transition-colors">
              Load more
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
