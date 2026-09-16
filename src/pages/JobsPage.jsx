import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Header } from '../components/layout/Header'
import { JobCard } from '../components/common/JobCard'
import { SearchFilter } from '../components/common/SearchFilter'
import { supabase } from '../lib/supabase'
import { useUserSkills } from '../hooks/useUserSkills'
import { getMatchedSkills } from '../utils/job'

const PAGE_SIZE = 48
const DEFAULT_FILTERS = { keyword: '', companyId: '', location: '', department: '' }

export function JobsPage() {
  const { skills: userSkills } = useUserSkills()
  const [jobs, setJobs] = useState([])
  const [companies, setCompanies] = useState([])
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [summaryStats, setSummaryStats] = useState({ total: 0, new: 0, matched: 0, applied: 0, pending: 0 })
  const [showMatchedOnly, setShowMatchedOnly] = useState(false)
  const [activeTab, setActiveTab] = useState('all')
  const metricsRequestRef = useRef(0)

  useEffect(() => {
    supabase
      .from('companies')
      .select('id, name')
      .order('name')
      .then(({ data }) => setCompanies(data || []))
  }, [])

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
      setJobs([])
      setTotalCount(0)
      setHasMore(false)
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

    setTotalCount(count || deduped.length || 0)
    setHasMore((currentPage + 1) * PAGE_SIZE < (count || 0))
    setLoading(false)
  }, [])

  const fetchMetrics = useCallback(async (currentFilters) => {
    const requestId = ++metricsRequestRef.current

    let query = supabase
      .from('jobs')
      .select('id, title, department, skills, posted_at, applied_at, first_seen_at', { count: 'exact' })
      .eq('is_active', true)
      .eq('hidden', false)

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

    const { data, error } = await query

    if (error) {
      console.error('Failed to fetch metrics:', error)
      setSummaryStats({ total: 0, new: 0, matched: 0, applied: 0, pending: 0 })
      return
    }

    if (requestId !== metricsRequestRef.current) {
      return
    }

    const rows = data || []
    const newCount = rows.filter(job => {
      const ref = job.posted_at || job.first_seen_at
      if (!ref) return false

      const time = new Date(ref).getTime()
      if (Number.isNaN(time)) return false

      return Date.now() - time < 2 * 24 * 60 * 60 * 1000
    }).length

    const appliedCount = rows.filter(job => {
      if (!job.applied_at) return false
      const time = new Date(job.applied_at).getTime()
      return !Number.isNaN(time)
    }).length

    const matchedCount = userSkills.length
      ? rows.filter(job => getMatchedSkills(job, userSkills).length > 0).length
      : 0

    setSummaryStats({
      total: rows.length,
      new: newCount,
      matched: matchedCount,
      applied: appliedCount,
      pending: Math.max(rows.length - appliedCount, 0),
    })
  }, [userSkills])

  useEffect(() => {
    setPage(0)
    fetchJobs(filters, 0)
    fetchMetrics(filters)
  }, [filters, fetchJobs, fetchMetrics])

  useEffect(() => {
    if (page > 0) fetchJobs(filters, page)
  }, [page])

  useEffect(() => {
    const handleScroll = () => {
      if (loading || !hasMore) return

      const distanceFromBottom = document.documentElement.scrollHeight - (window.innerHeight + window.scrollY)
      if (distanceFromBottom <= 240) {
        setPage(prev => prev + 1)
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [loading, hasMore])

  const handleHide = async (jobId) => {
    setJobs(prev => prev.filter(j => j.id !== jobId))
    const { error } = await supabase.from('jobs').update({ hidden: true }).eq('id', jobId)
    if (error) {
      console.error('Failed to hide job:', error)
      return
    }
    await fetchMetrics(filters)
  }

  const handleApplied = async (jobId, markAsApplied) => {
    const applied_at = markAsApplied ? new Date().toISOString() : null
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, applied_at } : j))
    const { error } = await supabase.from('jobs').update({ applied_at }).eq('id', jobId)
    if (error) {
      console.error('Failed to update applied state:', error)
      return
    }
    await fetchMetrics(filters)
  }

  const jobsWithMatches = useMemo(() => {
    return jobs.map(job => ({
      job,
      matched: getMatchedSkills(job, userSkills),
    }))
  }, [jobs, userSkills])

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

    return [...filtered].sort((a, b) => {
      const aDate = new Date(a.job.posted_at || a.job.first_seen_at || 0).getTime()
      const bDate = new Date(b.job.posted_at || b.job.first_seen_at || 0).getTime()
      const aIsNew = aDate > 0 && Date.now() - aDate < 2 * 24 * 60 * 60 * 1000
      const bIsNew = bDate > 0 && Date.now() - bDate < 2 * 24 * 60 * 60 * 1000

      if (aIsNew !== bIsNew) return aIsNew ? -1 : 1
      return bDate - aDate
    })
  }, [jobsWithMatches, showMatchedOnly, userSkills, activeTab])

  const stats = useMemo(() => ({
    total: summaryStats.total || totalCount || jobs.length,
    new: summaryStats.new,
    matched: summaryStats.matched,
    applied: summaryStats.applied,
    pending: summaryStats.pending,
  }), [summaryStats, totalCount, jobs.length])

  const tabCounts = useMemo(() => ({
    all: stats.total,
    pending: stats.pending,
    applied: stats.applied,
  }), [stats])

  const dailyMetrics = useMemo(() => {
    const dayMap = new Map()

    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      dayMap.set(key, { label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), added: 0, applied: 0 })
    }

    jobs.forEach(job => {
      const dateSource = job.posted_at || job.first_seen_at
      if (dateSource) {
        const date = new Date(dateSource)
        if (!Number.isNaN(date.getTime())) {
          const key = date.toISOString().slice(0, 10)
          if (dayMap.has(key)) {
            dayMap.get(key).added += 1
          }
        }
      }

      if (job.applied_at) {
        const date = new Date(job.applied_at)
        if (!Number.isNaN(date.getTime())) {
          const key = date.toISOString().slice(0, 10)
          if (dayMap.has(key)) {
            dayMap.get(key).applied += 1
          }
        }
      }
    })

    return Array.from(dayMap.entries()).map(([key, value]) => ({
      key,
      ...value,
    }))
  }, [jobs])

  const metricCards = [
    { label: 'Total', value: stats.total, tone: 'primary', detail: 'Open roles' },
    { label: 'New', value: stats.new, tone: 'success', detail: 'Last 48h' },
    { label: 'Matches', value: stats.matched, tone: 'violet', detail: 'Skill fit' },
    { label: 'Applied', value: stats.applied, tone: 'sky', detail: 'Tracked' },
  ]

  return (
    <div className="page-shell">
      <Header
        stats={stats}
        onSkillsToggle={() => setShowMatchedOnly(v => !v)}
        skillsActive={showMatchedOnly}
        userSkills={userSkills}
      />

      <main className="page-content">
        <section className="panel hero-panel">
          <div className="hero-copy">
            <h1>Job dashboard</h1>
          </div>

          <div className="metric-grid">
            {metricCards.map(({ label, value, tone, detail }) => (
              <div key={label} className={`stat-card ${tone}`}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{detail}</small>
              </div>
            ))}
          </div>

          <div className="daily-metrics-panel">
            {dailyMetrics.map(day => (
              <div key={day.key} className="daily-metric-item">
                <span>{day.label}</span>
                <div className="daily-metric-values">
                  <strong>{day.added}</strong>
                  <em>{day.applied}</em>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="toolbar-panel">
          <div className="toolbar-main">
            <SearchFilter filters={filters} companies={companies} onChange={setFilters} />
          </div>

          <div className="toolbar-right">
            <div className="tab-group" role="tablist" aria-label="Job state tabs">
              {['all', 'pending', 'applied'].map(tab => (
                <button
                  key={tab}
                  type="button"
                  className={`tab-button ${activeTab === tab ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab(tab)
                    setPage(0)
                  }}
                >
                  {tab}
                  <span className="count-badge">
                    {tabCounts[tab] ?? 0}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        {loading && jobs.length === 0 && (
          <div className="state-block loading-state">
            <div className="spinner" />
            <h3>Loading new opportunities</h3>
            <p>We’re pulling the latest roles and sorting them for you.</p>
          </div>
        )}

        {visibleJobs.length > 0 && (
          <section className="jobs-grid">
            {visibleJobs.map(({ job, matched }) => (
              <JobCard
                key={job.id}
                job={job}
                matchedSkills={matched}
                onHide={handleHide}
                onApplied={handleApplied}
              />
            ))}
          </section>
        )}

        {!loading && visibleJobs.length === 0 && jobs.length > 0 && (
          <div className="state-block empty-state">
            <div className="empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M12 2.75l1.8 5.45L19.25 10l-5.45 1.8-1.8 5.45-1.8-5.45L4.75 10l5.45-1.8L12 2.75zm7 13.5l.72 2.18L22 18.97l-2.28.54L19 21.7l-.72-2.19L16 18.97l2.28-.54L19 16.25zm-14 0l.72 2.18L8 18.97l-2.28.54L5 21.7l-.72-2.19L2 18.97l2.28-.54L5 16.25z" fill="currentColor" />
              </svg>
            </div>
            <h3>No matching jobs</h3>
            <p>Try broadening your filters or switching back to all roles.</p>
          </div>
        )}

        {!loading && jobs.length === 0 && (
          <div className="state-block empty-state">
            <div className="empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M7 4.5A2.5 2.5 0 004.5 7v10A2.5 2.5 0 007 19.5h10A2.5 2.5 0 0019.5 17V7A2.5 2.5 0 0017 4.5H7zm0 2h10a.5.5 0 01.5.5v1h-11V7a.5.5 0 01.5-.5zm-1 4h12v7.5a.5.5 0 01-.5.5H7a.5.5 0 01-.5-.5V10.5z" fill="currentColor" />
              </svg>
            </div>
            <h3>No jobs yet</h3>
            <p>Fresh roles will show up here as soon as the pipeline finds them.</p>
            <button type="button" onClick={() => window.location.reload()} className="refresh-button">
              Refresh
            </button>
          </div>
        )}

        {visibleJobs.length > 0 && !hasMore && jobs.length >= 10 && (
          <div className="footer-note">Showing all {jobs.length} roles</div>
        )}
      </main>
    </div>
  )
}
