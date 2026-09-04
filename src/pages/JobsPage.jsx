import { useCallback, useEffect, useMemo, useState } from 'react'
import { Header } from '../components/layout/Header'
import { JobCard } from '../components/common/JobCard'
import { SearchFilter } from '../components/common/SearchFilter'
import { supabase } from '../lib/supabase'
import { useUserSkills } from '../hooks/useUserSkills'
import { getMatchedSkills } from '../utils/job'

const PAGE_SIZE = 48  // Show 48 jobs per page (12 rows on desktop, 6 cols per row when scrolling)
const DEFAULT_FILTERS = { keyword: '', companyId: '', location: '', department: '' }

export function JobsPage() {
  const { skills: userSkills } = useUserSkills()
  const [jobs, setJobs] = useState([])
  const [companies, setCompanies] = useState([])
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [showMatchedOnly, setShowMatchedOnly] = useState(false)
  const [activeTab, setActiveTab] = useState('all')

  // Load companies once
  useEffect(() => {
    supabase
      .from('companies')
      .select('id, name')
      .order('name')
      .then(({ data }) => setCompanies(data || []))
  }, [])

  // Fetch jobs
  const fetchJobs = useCallback(async (currentFilters, currentPage) => {
    setLoading(true)

    let query = supabase
      .from('jobs')
      .select('*, companies(name)', { count: 'exact' })
      .eq('is_active', true)
      .eq('hidden', false)
      .order('posted_at', { ascending: false, nullsFirst: false })
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

    const { data, error, count } = await query

    if (error) {
      console.error('Failed to fetch jobs:', error)
      setLoading(false)
      return
    }

    const deduped = (data || []).filter(
      (job, idx, arr) => arr.findIndex(j => j.id === job.id) === idx
    )

    if (currentPage === 0) {
      setJobs(deduped)
    } else {
      setJobs(prev => {
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

  // Handle hide
  const handleHide = async (jobId) => {
    setJobs(prev => prev.filter(j => j.id !== jobId))
    await supabase.from('jobs').update({ hidden: true }).eq('id', jobId)
  }

  // Handle applied
  const handleApplied = async (jobId, markAsApplied) => {
    const applied_at = markAsApplied ? new Date().toISOString() : null
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, applied_at } : j))
    await supabase.from('jobs').update({ applied_at }).eq('id', jobId)
  }

  // Compute skill matches
  const jobsWithMatches = useMemo(() => {
    return jobs.map(job => ({
      job,
      matched: getMatchedSkills(job, userSkills),
    }))
  }, [jobs, userSkills])

  // Apply filters
  const visibleJobs = useMemo(() => {
    let filtered = jobsWithMatches

    if (showMatchedOnly && userSkills.length > 0) {
      filtered = filtered.filter(({ matched }) => matched.length > 0)
    }

    switch (activeTab) {
      case 'applied':
        filtered = filtered.filter(({ job }) => job.applied_at)
        break
      case 'pending':
        filtered = filtered.filter(({ job }) => !job.applied_at)
        break
      default:
        break
    }

    return filtered
  }, [jobsWithMatches, showMatchedOnly, userSkills, activeTab])

  // Calculate stats
  const stats = useMemo(() => {
    const newCount = jobs.filter(j => {
      const ref = j.posted_at || j.first_seen_at
      return ref && Date.now() - new Date(ref).getTime() < 2 * 24 * 60 * 60 * 1000
    }).length

    const matchCount = jobsWithMatches.filter(({ matched }) => matched.length > 0).length

    return {
      total: jobs.length,
      new: newCount,
      matched: matchCount,
    }
  }, [jobs, jobsWithMatches])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <Header
        stats={stats}
        onSkillsToggle={() => setShowMatchedOnly(v => !v)}
        skillsActive={showMatchedOnly}
        userSkills={userSkills}
      />

      <main className="max-w-7xl mx-auto px-3 py-4">
        
        {/* Filter & Tabs Bar */}
        <div className="flex items-center justify-between gap-2 mb-4">
          <div className="flex-shrink-0">
            <SearchFilter filters={filters} companies={companies} onChange={setFilters} />
          </div>
          
          {/* Tabs */}
          <div className="flex items-center gap-1 bg-slate-800/50 rounded p-0.5 border border-slate-700 shadow-sm">
            {['all', 'pending', 'applied'].map(tab => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); setPage(0) }}
                className={`px-3 py-1.5 text-xs font-semibold rounded transition-all duration-200 ${
                  activeTab === tab
                    ? 'bg-gradient-to-r from-indigo-600 to-indigo-700 text-white shadow-sm'
                    : 'text-slate-400 hover:bg-slate-700/50'
                }`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
                {tab === 'all' && jobs.length > 0 && (
                  <span className="ml-1 text-xs font-medium opacity-75">({visibleJobs.length})</span>
                )}
                {tab === 'pending' && jobs.length > 0 && (
                  <span className="ml-1 text-xs font-medium opacity-75">({visibleJobs.filter(j => !j.job.applied_at).length})</span>
                )}
                {tab === 'applied' && jobs.length > 0 && (
                  <span className="ml-1 text-xs font-medium opacity-75">({visibleJobs.filter(j => j.job.applied_at).length})</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Loading State */}
        {loading && jobs.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <div className="text-center">
              <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-3"></div>
              <p className="text-slate-400 font-medium text-sm">Loading jobs...</p>
              <p className="text-slate-600 text-xs mt-1">This may take a moment</p>
            </div>
          </div>
        )}

        {/* Job Grid */}
        {visibleJobs.length > 0 && (
          <div className="animate-fadeIn">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleJobs.map(({ job, matched }) => (
                <JobCard
                  key={job.id}
                  job={job}
                  matchedSkills={matched}
                  onHide={handleHide}
                  onApplied={handleApplied}
                />
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {!loading && visibleJobs.length === 0 && jobs.length > 0 && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center max-w-md">
              <div className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m0 0h6m-6-6h-6m0 0H3" />
                </svg>
              </div>
              <p className="text-slate-300 font-semibold text-base">No matching jobs</p>
              <p className="text-slate-400 text-xs mt-1">Try adjusting your filters or check back later</p>
            </div>
          </div>
        )}

        {/* Complete Empty State */}
        {!loading && jobs.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center max-w-md">
              <div className="w-14 h-14 bg-indigo-900/30 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-7 h-7 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                </svg>
              </div>
              <p className="text-slate-200 font-bold text-lg">No jobs yet</p>
              <p className="text-slate-400 text-xs mt-1">Jobs will appear here as they are posted. Check back soon!</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-4 px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded hover:bg-indigo-700 transition-colors"
              >
                Refresh
              </button>
            </div>
          </div>
        )}

        {/* Load More Button */}
        {hasMore && !loading && (
          <div className="flex items-center justify-center mt-6">
            <button
              onClick={() => setPage(p => p + 1)}
              className="px-6 py-2 text-sm font-semibold text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded shadow-md hover:shadow-lg transition-all duration-200"
            >
              Load More
            </button>
          </div>
        )}

        {/* Footer */}
        {visibleJobs.length > 0 && !hasMore && jobs.length >= 10 && (
          <div className="flex items-center justify-center mt-6">
            <p className="text-slate-500 text-xs">
              Showing all {jobs.length} jobs
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
