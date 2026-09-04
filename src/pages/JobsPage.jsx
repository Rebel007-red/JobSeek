import { useCallback, useEffect, useMemo, useState } from 'react'
import { Header } from '../components/layout/Header'
import { JobCard } from '../components/common/JobCard'
import { SearchFilter } from '../components/common/SearchFilter'
import { supabase } from '../lib/supabase'
import { useUserSkills } from '../hooks/useUserSkills'
import { getMatchedSkills } from '../utils/job'

const PAGE_SIZE = 24
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
    <div className="min-h-screen bg-gray-50">
      <Header
        stats={stats}
        onSkillsToggle={() => setShowMatchedOnly(v => !v)}
        skillsActive={showMatchedOnly}
        userSkills={userSkills}
      />

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-4 mb-6">
          <SearchFilter filters={filters} companies={companies} onChange={setFilters} />
          
          {/* Tabs */}
          <div className="flex items-center gap-2">
            {['all', 'pending', 'applied'].map(tab => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); setPage(0) }}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeTab === tab
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
                }`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Loading */}
        {loading && jobs.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-3"></div>
              <p className="text-gray-600">Loading jobs...</p>
            </div>
          </div>
        )}

        {/* Job Grid */}
        {visibleJobs.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
        )}

        {/* Empty State */}
        {!loading && visibleJobs.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <svg className="w-16 h-16 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
              <p className="text-gray-600 font-medium">No jobs found</p>
              <p className="text-gray-500 text-sm">Try adjusting your filters</p>
            </div>
          </div>
        )}

        {/* Load More */}
        {hasMore && !loading && (
          <div className="flex items-center justify-center mt-8">
            <button
              onClick={() => setPage(p => p + 1)}
              className="px-6 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
            >
              Load More
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
