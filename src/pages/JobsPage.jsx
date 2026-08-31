import { useCallback, useEffect, useMemo, useState } from 'react'
import { JobCard } from '../components/JobCard'
import { SearchFilter } from '../components/SearchFilter'
import { supabase } from '../lib/supabase'

const PAGE_SIZE = 24

const DEFAULT_FILTERS = { keyword: '', companyId: '', location: '', department: '', skills: '' }

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
  const [jobs, setJobs] = useState([])
  const [companies, setCompanies] = useState([])
  const [filters, setFilters] = useState(() => {
    // Persist skills in localStorage so they survive page refresh
    const saved = localStorage.getItem('jobseeker_skills')
    return { ...DEFAULT_FILTERS, skills: saved || '' }
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  // Persist skills to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('jobseeker_skills', filters.skills)
  }, [filters.skills])

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

  const newCount = useMemo(
    () => jobs.filter((j) => {
      const diff = Date.now() - new Date(j.first_seen_at).getTime()
      return diff < 48 * 60 * 60 * 1000
    }).length,
    [jobs]
  )

  // Compute skill matches and sort: matched jobs first
  const userSkills = useMemo(() => parseSkills(filters.skills || ''), [filters.skills])

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
    <div className="min-h-screen bg-gray-50">
      {/* Top nav */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-gray-900">Job Seeker</h1>
            {newCount > 0 && (
              <span className="text-xs bg-green-100 text-green-700 font-semibold px-2 py-0.5 rounded-full">
                {newCount} new
              </span>
            )}
            {matchCount > 0 && (
              <span className="text-xs bg-indigo-100 text-indigo-700 font-semibold px-2 py-0.5 rounded-full">
                {matchCount} skill match{matchCount > 1 ? 'es' : ''}
              </span>
            )}
          </div>
          <button
            onClick={handleSignOut}
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 flex flex-col gap-5">
        {/* Filters */}
        <SearchFilter filters={filters} companies={companies} onChange={setFilters} />

        {/* Error */}
        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            {error}
          </p>
        )}

        {/* Results count */}
        {!loading && jobs.length > 0 && (
          <p className="text-sm text-gray-500">
            Showing {jobs.length} job{jobs.length !== 1 ? 's' : ''}
            {userSkills.length > 0 && matchCount > 0 && (
              <span className="ml-1 text-indigo-600 font-medium">· {matchCount} match your skills</span>
            )}
          </p>
        )}

        {/* Grid */}
        {jobsWithMatches.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {jobsWithMatches.map(({ job, matched }) => (
              <JobCard key={job.id} job={job} matchedSkills={matched} />
            ))}
          </div>
        ) : !loading ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-lg font-medium">No jobs found</p>
            <p className="text-sm mt-1">Try adjusting your filters</p>
          </div>
        ) : null}

        {/* Skeleton loader */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-white border border-gray-200 rounded-xl p-5 h-40 animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
                <div className="h-3 bg-gray-100 rounded w-1/3 mb-4" />
                <div className="h-3 bg-gray-100 rounded w-1/2" />
              </div>
            ))}
          </div>
        )}

        {/* Load more */}
        {hasMore && !loading && (
          <div className="text-center pt-2">
            <button
              onClick={() => setPage((p) => p + 1)}
              className="px-6 py-2 text-sm font-medium text-indigo-600 border border-indigo-300 rounded-lg hover:bg-indigo-50 transition-colors"
            >
              Load more
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
