import { useState } from 'react'
import { formatDate, formatRelativeAge, getMatchScore, isNewJob } from '../../utils/job'

function LocationIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 21s6-5.4 6-11a6 6 0 10-12 0c0 5.6 6 11 6 11zm0-8.5A2.5 2.5 0 1012 7a2.5 2.5 0 000 5.5z" fill="currentColor" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9.55 16.2L5.3 12l-1.4 1.4 5.65 5.65 10.85-10.85L18.9 6.9 9.55 16.2z" fill="currentColor" />
    </svg>
  )
}

function CircleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function JobCard({ job, matchedSkills = [], onHide, onApplied }) {
  const {
    title,
    location,
    department,
    url,
    first_seen_at,
    posted_at,
    applied_at,
    companies,
    description,
    experience_text,
  } = job

  const [touchStart, setTouchStart] = useState(0)
  const [dragOffset, setDragOffset] = useState(0)
  const [swipeDirection, setSwipeDirection] = useState(null)

  const companyName = companies?.name ?? 'Unknown'
  const storedSkills = Array.isArray(job.skills) ? job.skills : []
  const matchScore = getMatchScore(job, matchedSkills.length)
  const isNew = isNewJob(posted_at, first_seen_at)
  const relativeAge = formatRelativeAge(posted_at || first_seen_at)

  const handleTouchStart = (e) => {
    setTouchStart(e.targetTouches[0].clientX)
    setDragOffset(0)
    setSwipeDirection(null)
  }

  const handleTouchMove = (e) => {
    if (swipeDirection) return
    const nextOffset = e.touches[0].clientX - touchStart
    setDragOffset(Math.max(Math.min(nextOffset, 120), -120))
  }

  const handleTouchEnd = (e) => {
    const endX = e.changedTouches[0].clientX
    const distance = touchStart - endX
    const isLeftSwipe = distance > 70
    const isRightSwipe = distance < -70

    if (isLeftSwipe && onHide) {
      setSwipeDirection('left')
      setTimeout(() => {
        setSwipeDirection(null)
        setDragOffset(0)
        setTouchStart(0)
        onHide(job.id)
      }, 180)
    } else if (isRightSwipe && onApplied) {
      setSwipeDirection('right')
      setTimeout(() => {
        setSwipeDirection(null)
        setDragOffset(0)
        setTouchStart(0)
        onApplied(job.id, true)
      }, 180)
    } else {
      setDragOffset(0)
      setTouchStart(0)
    }
  }

  return (
    <article
      className={`job-card ${swipeDirection ? 'card-swipe' : ''} ${dragOffset !== 0 ? 'dragging' : ''}`}
      style={dragOffset !== 0 && !swipeDirection ? { transform: `translateX(${dragOffset}px) rotate(${dragOffset / 18}deg)` } : undefined}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {swipeDirection && (
        <div className="swipe-feedback">
          <span className={swipeDirection === 'right' ? 'approve' : 'decline'}>
            {swipeDirection === 'right' ? 'Applied' : 'Hidden'}
          </span>
        </div>
      )}

      <div className="job-card-header">
        <div>
          <p className="job-company">{companyName}</p>
          <h3>{title}</h3>
        </div>

        <div className="job-meta-badges">
          {isNew && !applied_at && <span className="badge new-badge">New</span>}
          {experience_text && <span className="badge experience-badge">{experience_text}</span>}
          {applied_at && (
            <span className="badge applied-badge">
              Applied {formatDate(applied_at) ? `on ${formatDate(applied_at)}` : ''}
            </span>
          )}
          {matchScore > 0 && <span className="badge match-badge">{matchScore}% match</span>}
        </div>
      </div>

      <div className="job-card-row">
        <span className="job-card-location">
          <LocationIcon />
          <span>{location || 'Remote'}</span>
        </span>
        <span className="job-card-separator" aria-hidden="true" />
        <span>{formatDate(posted_at || first_seen_at) || 'Recently'}</span>
        {relativeAge && <span className={`job-age-pill ${isNew ? 'new' : 'older'}`}>{relativeAge}</span>}
      </div>

      {department && <div className="job-department">{department}</div>}

      {description && (
        <p className="job-description">{description.replace(/\s+/g, ' ').trim().slice(0, 140)}{description.length > 140 ? '…' : ''}</p>
      )}

      {storedSkills.length > 0 && (
        <div className="skill-tags">
          {storedSkills.slice(0, 4).map(skill => (
            <span key={skill} className={matchedSkills.includes(skill) ? 'skill-tag active' : 'skill-tag'}>
              {skill}
            </span>
          ))}
        </div>
      )}

      <div className="job-card-actions">
        <button
          type="button"
          onClick={() => onApplied?.(job.id, !applied_at)}
          className={`action-button ${applied_at ? 'success' : ''}`}
          title={applied_at ? 'Mark as unapplied' : 'Mark as applied'}
        >
          {applied_at ? <CheckIcon /> : <CircleIcon />}
        </button>

        {url && url !== '#' && (
          <a href={url} target="_blank" rel="noreferrer" className="external-link" title="Open job posting">
            <ExternalLinkIcon />
          </a>
        )}

        {onHide && (
          <button type="button" onClick={() => onHide(job.id)} className="action-button danger" title="Hide this job">
            <CloseIcon />
          </button>
        )}
      </div>
    </article>
  )
}
