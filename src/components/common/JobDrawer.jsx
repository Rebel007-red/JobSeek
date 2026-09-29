import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { formatDate, formatRelativeAge } from '../../utils/job'
import { experienceLabel, fitLabel, formatDescription, jobDate, jobUrl, skillBuckets } from '../../utils/gold'
import { FitBreakdown, FitRing } from './Fit'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CircleIcon, CloseIcon, ExternalLinkIcon } from './icons'

function DetailRow({ label, value }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

const ROLE_METHODS = {
  embedding: 'description match',
  embedding_ambiguous: 'description match (close call)',
  llm: 'AI tie-break',
}

// position: { index, total, last } of the job in the current list (last = last loaded index);
// onMove(-1 | 1) steps through it (also j / k).
export function JobDrawer({ job, profile, position, onMove, onClose, onApplied, onHide }) {
  const [detail, setDetail] = useState({ key: null, row: null, error: '' })
  const closeRef = useRef(null)
  const bodyRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    const key = job.job_key
    api.job(key)
      .then(row => { if (!cancelled) setDetail({ key, row, error: '' }) })
      .catch(err => { if (!cancelled) setDetail({ key, row: null, error: err.message }) })
    bodyRef.current?.scrollTo(0, 0)
    return () => { cancelled = true }
  }, [job.job_key])

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const current = detail.key === job.job_key ? detail : { row: null, error: '' }
  const extra = current.row
  const applied = Boolean(job.is_applied)
  const { matchedLabels, have, missing } = skillBuckets(job, profile?.skills || [])
  const url = jobUrl(job)
  const date = jobDate(job)
  const roleScore = extra?.role_score ?? job.role_score
  const hasPosition = position && position.index >= 0

  return (
    <div className="drawer-root" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer-panel">
        <header className="drawer-header">
          <div className="drawer-title">
            <p className="job-company">{job.company_name}</p>
            <h2 id="drawer-title">{job.title}</h2>
            <p className="drawer-sub">
              {[job.location, experienceLabel(job), date ? `${formatRelativeAge(date)} · ${formatDate(date)}` : null].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="drawer-nav">
            {hasPosition && (
              <>
                <button type="button" className="icon-btn" onClick={() => onMove(-1)} disabled={position.index === 0} title="Previous job (k)" aria-label="Previous job">
                  <ChevronUpIcon />
                </button>
                <span className="drawer-position">{position.index + 1}/{position.total}</span>
                <button type="button" className="icon-btn" onClick={() => onMove(1)} disabled={position.index >= position.last} title="Next job (j)" aria-label="Next job">
                  <ChevronDownIcon />
                </button>
              </>
            )}
            <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close details">
              <CloseIcon />
            </button>
          </div>
        </header>

        {/* Top row on desktop; a thumb-reach bottom bar on mobile (see CSS) */}
        <div className="drawer-actions">
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" className="btn primary">
              <ExternalLinkIcon /> <span>Open<span className="hide-mobile"> posting</span></span> <kbd>o</kbd>
            </a>
          ) : (
            <button type="button" className="btn primary" disabled title="No link for this job">
              <ExternalLinkIcon /> <span>No link</span>
            </button>
          )}
          <button type="button" className={`btn ${applied ? 'success' : ''}`} onClick={() => onApplied(job, !applied)} aria-pressed={applied}>
            {applied ? <CheckIcon /> : <CircleIcon />}
            <span>
              {applied ? 'Applied' : 'Mark applied'}
              {applied && job.applied_at && <span className="hide-mobile"> {formatDate(job.applied_at)}</span>}
            </span>
            <kbd>a</kbd>
          </button>
          <button type="button" className="btn danger" onClick={() => onHide(job)}>
            <CloseIcon /> <span>Hide</span> <kbd>x</kbd>
          </button>
          {hasPosition && (
            <button type="button" className="btn hide-desktop" onClick={() => onMove(1)} disabled={position.index >= position.last}>
              <ChevronDownIcon /> <span>Next</span>
            </button>
          )}
        </div>

        <div className="drawer-body" ref={bodyRef}>
          <section className="drawer-section">
            <div className="drawer-fit-head">
              <FitRing score={job.fit_score} size="lg" />
              <div>
                <h3>{fitLabel(job.fit_score)}</h3>
                <p>Match against your target roles, skills, experience and cities.</p>
              </div>
            </div>
            <FitBreakdown job={job} profile={profile} />
          </section>

          <section className="drawer-section">
            <h3>Skills</h3>
            {matchedLabels.length > 0 && (
              <p className="drawer-note">Matched from your profile: <strong>{matchedLabels.join(', ')}</strong></p>
            )}
            {have.length + missing.length > 0 ? (
              <div className="skill-tags">
                {have.map(skill => <span key={skill} className="skill-tag active">{skill}</span>)}
                {missing.map(skill => <span key={skill} className="skill-tag missing" title="Not in your profile">{skill}</span>)}
              </div>
            ) : (
              <p className="drawer-note">No skills extracted for this job.</p>
            )}
          </section>

          <section className="drawer-section">
            <h3>Description</h3>
            {current.error && <p className="form-error">{current.error}</p>}
            {!extra && !current.error && <div className="skeleton-lines"><i /><i /><i /><i /></div>}
            {extra && <div className="drawer-description">{formatDescription(extra.description) || 'No description available.'}</div>}
          </section>

          <section className="drawer-section">
            <h3>Details</h3>
            <dl className="detail-list">
              <DetailRow label="Standard role" value={job.role_title ? `${job.role_title}${roleScore ? ` (${Math.round(roleScore * 100)}% similar)` : ''}` : null} />
              <DetailRow label="Also close to" value={extra?.role_alternative ?? job.role_alternative} />
              <DetailRow label="Matched by" value={ROLE_METHODS[extra?.role_method] || extra?.role_method} />
              <DetailRow label="Category" value={job.category} />
              <DetailRow label="Level" value={job.experience_level || job.seniority_level} />
              <DetailRow label="Employment" value={job.employment_type} />
              <DetailRow label="Function" value={extra?.job_function} />
              <DetailRow label="Industry" value={extra?.industries} />
              <DetailRow label="Source" value={job.source} />
              <DetailRow label="Posted" value={formatDate(job.posted_date)} />
              <DetailRow label="First found" value={formatDate(job.first_seen_at)} />
              <DetailRow label="Last seen" value={job.last_seen_at ? `${formatDate(job.last_seen_at)} (${formatRelativeAge(job.last_seen_at)})` : null} />
              <DetailRow label="Seen in scrapes" value={job.times_seen ? `${job.times_seen}×` : null} />
            </dl>
          </section>
        </div>
      </aside>
    </div>
  )
}
