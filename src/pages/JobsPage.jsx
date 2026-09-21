import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Header } from '../components/layout/Header'
import { JobCard } from '../components/common/JobCard'
import { SearchFilter } from '../components/common/SearchFilter'
import { supabase } from '../lib/supabase'
import { useUserSkills } from '../hooks/useUserSkills'
import { getMatchedSkills } from '../utils/job'
import { collectJobUpdateIds } from '../utils/jobIdentity'

const PAGE_SIZE = 48
const DEFAULT_FILTERS = { keyword: '', companyId: '', location: '', department: '' }
const TREND_WINDOW_DAYS = 14

const toLocalDateKey = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000)
  return localDate.toISOString().slice(0, 10)
}

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
  const [dailyMetrics, setDailyMetrics] = useState([])
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

  const fetchMetrics = useCallback(async (currentFilters, currentTrendDays = TREND_WINDOW_DAYS) => {
    const requestId = ++metricsRequestRef.current
    const daysWindow = Number(currentTrendDays) || TREND_WINDOW_DAYS
    const hasActiveFilters = Boolean(
      currentFilters.keyword ||
      currentFilters.companyId ||
      currentFilters.location ||
      currentFilters.department
    )

    try {
      if (!hasActiveFilters) {
        const [summaryResult, trendResult] = await Promise.all([
          supabase.from('job_dashboard_summary').select('*').maybeSingle(),
          supabase
            .from('job_daily_metrics')
            .select('day_key, added_jobs, applied_jobs')
            .order('day_key', { ascending: true })
            .limit(daysWindow),
        ])

        if (summaryResult.error) throw summaryResult.error
        if (trendResult.error) throw trendResult.error

        if (requestId !== metricsRequestRef.current) {
          return
        }

        const summaryRow = summaryResult.data || {}
        const matchRows = (await supabase
          .from('jobs')
          .select('id, title, department, skills, description, location, posted_at, applied_at, first_seen_at')
          .eq('is_active', true)
          .eq('hidden', false))?.data || []

        const matchedCount = userSkills.length
          ? matchRows.filter(job => getMatchedSkills(job, userSkills).length > 0).length
          : 0

        const dailyRows = trendResult.data || []
        const mappedTrend = dailyRows
          .map(item => {
            const date = new Date(item.day_key)
            if (Number.isNaN(date.getTime())) return null
            return {
              key: item.day_key,
              label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
              added: Number(item.added_jobs ?? 0),
              applied: Number(item.applied_jobs ?? 0),
            }
          })
          .filter(Boolean)
          .slice(-daysWindow)

        setSummaryStats({
          total: Number(summaryRow.total_jobs ?? matchRows.length ?? 0),
          new: Number(summaryRow.new_last_48h ?? 0),
          matched: matchedCount,
          applied: Number(summaryRow.applied_jobs ?? 0),
          pending: Number(summaryRow.pending_jobs ?? 0),
        })
        setDailyMetrics(mappedTrend)
        return
      }

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
        throw error
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

      const dayMap = new Map()

      for (let i = daysWindow - 1; i >= 0; i -= 1) {
        const d = new Date()
        d.setHours(0, 0, 0, 0)
        d.setDate(d.getDate() - i)
        const key = toLocalDateKey(d)
        if (key) {
          dayMap.set(key, { label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), added: 0, applied: 0 })
        }
      }

      rows.forEach(job => {
        const dateSource = job.posted_at || job.first_seen_at
        if (dateSource) {
          const key = toLocalDateKey(dateSource)
          if (key && dayMap.has(key)) {
            dayMap.get(key).added += 1
          }
        }

        if (job.applied_at) {
          const key = toLocalDateKey(job.applied_at)
          if (key && dayMap.has(key)) {
            dayMap.get(key).applied += 1
          }
        }
      })

      setSummaryStats({
        total: rows.length,
        new: newCount,
        matched: matchedCount,
        applied: appliedCount,
        pending: Math.max(rows.length - appliedCount, 0),
      })
      setDailyMetrics(
        Array.from(dayMap.entries())
          .map(([key, value]) => ({ key, ...value }))
          .reverse()
      )
    } catch (error) {
      console.error('Failed to fetch metrics:', error)
      setSummaryStats({ total: 0, new: 0, matched: 0, applied: 0, pending: 0 })
      setDailyMetrics([])
    }
  }, [userSkills])

  useEffect(() => {
    setPage(0)
    fetchJobs(filters, 0)
    fetchMetrics(filters, TREND_WINDOW_DAYS)
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

  const sameJobIdentity = (left, right) => {
    if (!left || !right) return false
    if (left.id === right.id) return true

    const sameCompanyAndJob =
      left.company_id != null &&
      right.company_id != null &&
      left.company_id === right.company_id &&
      left.job_id &&
      right.job_id &&
      left.job_id === right.job_id

    const sameUrl = !!(left.url && right.url && left.url === right.url)

    return sameCompanyAndJob || sameUrl
  }

  const syncMatchingJobRows = useCallback(async (job, patch) => {
    if (!job) return { error: new Error('Missing job') }

    let query = supabase.from('jobs').select('id, company_id, job_id, url')

    if (job.company_id != null && job.job_id) {
      query = query.eq('company_id', job.company_id).eq('job_id', job.job_id)
    } else if (job.url) {
      query = query.eq('url', job.url)
    } else {
      return supabase.from('jobs').update(patch).eq('id', job.id)
    }

    const { data, error: selectError } = await query
    if (selectError) {
      return { error: selectError }
    }

    const uniqueIds = collectJobUpdateIds(job, data || [])

    if (!uniqueIds.length) {
      return { error: null }
    }

    return supabase.from('jobs').update(patch).in('id', uniqueIds)
  }, [])

  const handleHide = async (jobId) => {
    const target = jobs.find(j => j.id === jobId)
    if (!target) return

    setJobs(prev => prev.filter(j => !sameJobIdentity(j, target)))

    const { error } = await syncMatchingJobRows(target, { hidden: true })
    if (error) {
      console.error('Failed to hide job:', error)
      return
    }
    await fetchMetrics(filters)
  }

  const handleApplied = async (jobId, markAsApplied) => {
    const target = jobs.find(j => j.id === jobId)
    if (!target) return

    const applied_at = markAsApplied ? new Date().toISOString() : null
    setJobs(prev => prev.map(j => sameJobIdentity(j, target) ? { ...j, applied_at } : j))

    const { error } = await syncMatchingJobRows(target, { applied_at })
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

  const stats = useMemo(() => {
    const matchedFromJobs = jobsWithMatches.filter(({ matched }) => matched.length > 0).length

    return {
      total: summaryStats.total || totalCount || jobs.length,
      new: summaryStats.new,
      matched: matchedFromJobs || summaryStats.matched,
      applied: summaryStats.applied,
      pending: summaryStats.pending,
    }
  }, [summaryStats, totalCount, jobs.length, jobsWithMatches])

  const tabCounts = useMemo(() => ({
    all: stats.total,
    pending: stats.pending,
    applied: stats.applied,
  }), [stats])


  const metricCards = [
    { label: 'Total', value: stats.total, tone: 'primary', detail: 'Open roles' },
    { label: 'New', value: stats.new, tone: 'success', detail: 'Last 48h' },
    { label: 'Matches', value: stats.matched, tone: 'violet', detail: 'Skill fit' },
    { label: 'Applied', value: stats.applied, tone: 'sky', detail: 'Tracked' },
  ]

  return (
    <div
      className="page-shell"
      style={{ '--trend-columns': TREND_WINDOW_DAYS }}
    >
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
