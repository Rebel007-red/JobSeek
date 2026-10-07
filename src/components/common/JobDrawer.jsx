import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { formatDate, formatRelativeAge } from '../../utils/job'
import { recordOpened } from '../../utils/viewPref'
import {
  APPLIED_STATUSES, EMPLOYMENT_LABELS, WORK_MODE_LABELS, experienceLabel, fitLabel, formatDescription, isApplied, jobDate, jobUrl,
  statusLabel,
} from '../../utils/gold'
import { fitReasons, notForYouText, skillsSplit, standardRoleLabel } from '../../utils/fit'
import { FitBreakdown, FitRing } from './Fit'
import { ApplicationPanel } from '../job/ApplicationPanel'
import { FitFeedback } from '../job/FitFeedback'
import { ClosedNotice, DuplicateNotice, JobBadges } from '../job/JobNotices'
import { shareJob } from '../job/share'
import {
  BookmarkIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, CircleIcon, CloseIcon, ExternalLinkIcon, ShareIcon,
} from './icons'

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

// Remote and hybrid are worth a word in the subtitle; on-site is the default reading
const SUBTITLE_MODES = ['remote', 'hybrid']

// The statusFocus value the last drawer acted on: the page's counter outlives the drawer, so a new drawer focuses the
// picker only when the counter moved since (t opened it), not on every open after one t press (a focused picker would
// take the o / a / s keys as type-ahead and change the status). 0 = a page that has not used t yet.
let seenStatusFocus = 0

const statusOf = (job) => job.application_status || (job.is_applied ? 'applied' : 'not_applied')

// What a status write changes on the row (the page's own handler does the same on its list)
function statusPatch(job, status) {
  const applied = APPLIED_STATUSES.includes(status)
  return {
    application_status: status,
    is_applied: applied,
    applied_at: applied ? job.applied_at || new Date().toISOString() : null,
    status_updated_at: new Date().toISOString(),
  }
}

// position: { index, total, last } of the job in the current list (last = last loaded index);
// onMove(-1 | 1) steps through it (also j / k).
// Page handlers (each optional; without one the drawer writes through the API itself and only updates its own view):
// onApplied(job, applied); onHide(job, reason?) where reason is 'wrong_role' | 'too_senior' from the fit feedback;
// onStatus(job, status) for the status picker, the Save button and the closed-posting shortcuts;
// onJobChange(jobKey, patch) after a note save ({ has_note, next_action_at, application_status });
// onMuteCompany(job); onOpenJob(jobKey) for "View it" on the duplicate notice; onToast(message) for short messages
// ("Link copied"). statusFocus: change it (a counter) to focus the status picker (the t key).
export function JobDrawer({
  job: jobProp, profile, position, onMove, onClose, onApplied, onHide, onStatus, onJobChange, onMuteCompany, onOpenJob,
  onToast, statusFocus,
}) {
  const [detail, setDetail] = useState({ key: null, row: null, error: '' })
  const [local, setLocal] = useState({ key: null, patch: {} }) // edits made without a page handler
  const [message, setMessage] = useState({ key: null, text: '' }) // inline message when there is no onToast
  const [mutedKey, setMutedKey] = useState(null) // company muted from this drawer (no onMuteCompany)
  const closeRef = useRef(null)
  const bodyRef = useRef(null)
  const panelRef = useRef(null)
  const statusRef = useRef(null)
  const jobKeyRef = useRef(jobProp.job_key)
  // First paint shows the panel shell (header, actions); the body renders right after, so the tap paints quickly
  const bodyReady = useDeferredValue(true, false)

  const job = local.key === jobProp.job_key ? { ...jobProp, ...local.patch } : jobProp
  const jobKey = job.job_key

  useEffect(() => {
    jobKeyRef.current = jobKey
  }, [jobKey])

  // Tab stays in the drawer; closing returns focus to the current job's row (it may have moved with j / k)
  useDialogFocus(panelRef, closeRef, () => document.querySelector(`[data-job-key="${CSS.escape(jobKeyRef.current)}"]`))

  useEffect(() => {
    let cancelled = false
    api.job(jobKey)
      .then(row => { if (!cancelled) setDetail({ key: jobKey, row, error: '' }) })
      .catch(err => { if (!cancelled) setDetail({ key: jobKey, row: null, error: err.message }) })
    bodyRef.current?.scrollTo(0, 0)
    return () => { cancelled = true }
  }, [jobKey])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // The t key: focus the status picker (it renders with the body)
  useEffect(() => {
    if (!statusFocus) seenStatusFocus = 0
    if (!bodyReady || !statusFocus || statusFocus === seenStatusFocus) return
    seenStatusFocus = statusFocus
    statusRef.current?.focus()
  }, [statusFocus, bodyReady])

  const patchLocal = useCallback((key, patch) => {
    setLocal(prev => ({ key, patch: prev.key === key ? { ...prev.patch, ...patch } : patch }))
  }, [])

  // A page handler took over the status: the drawer's own status edits must not hide what the page sets
  const dropLocalStatus = () => {
    setLocal(prev => {
      if (prev.key !== jobKey) return prev
      const { application_status: _status, is_applied: _applied, applied_at: _at, status_updated_at: _updated, ...rest } = prev.patch
      return { key: prev.key, patch: rest }
    })
  }

  const notify = useCallback((text) => {
    if (onToast) onToast(text)
    else setMessage({ key: jobKeyRef.current, text })
  }, [onToast])

  const status = statusOf(job)
  const applied = isApplied(job)
  const saved = status === 'saved'

  const changeStatus = async (next) => {
    if (next === status) return
    if (onStatus) {
      dropLocalStatus()
      return onStatus(job, next)
    }
    const before = { application_status: job.application_status, is_applied: job.is_applied, applied_at: job.applied_at, status_updated_at: job.status_updated_at }
    patchLocal(jobKey, statusPatch(job, next))
    try {
      await api.setStatus(jobKey, next)
    } catch (err) {
      patchLocal(jobKey, before)
      notify(`Could not update: ${err.message}`)
    }
  }

  const noteSaved = (key, patch) => {
    if (onJobChange) onJobChange(key, patch)
    else patchLocal(key, patch)
  }

  const muteCompany = async () => {
    if (onMuteCompany) return onMuteCompany(job)
    try {
      await api.addMuteRule('companies', job.company_name)
      setMutedKey(jobKey)
      notify(`Muted ${job.company_name}. Undo it in Settings → Mute rules.`)
    } catch (err) {
      notify(`Could not mute: ${err.message}`)
    }
  }

  const current = detail.key === jobKey ? detail : { row: null, error: '' }
  const extra = current.row
  const url = jobUrl(job)
  const date = jobDate(job)
  const roleScore = extra?.role_score ?? job.role_score
  const hasPosition = position && position.index >= 0
  const { have, missing, missingLine } = skillsSplit(job, profile)
  const matchedLabels = Array.isArray(job.fit_matched_skills) ? job.fit_matched_skills : []
  const skillsKnown = job.job_skills_known !== false
  const reasons = fitReasons(job, profile)
  const notForYou = notForYouText(job, profile)
  const mode = SUBTITLE_MODES.includes(job.work_mode) ? WORK_MODE_LABELS[job.work_mode] : null
  const inlineMessage = message.key === jobKey ? message.text : ''
  // An applied job shows its stage ("Interviewing"); plain applied (or an older row without a status) shows "Applied"
  const appliedText = !applied ? 'Mark applied' : APPLIED_STATUSES.includes(status) ? statusLabel(status) : 'Applied'
  const showMissing = skillsKnown && profile?.skills?.length > 0

  return (
    <div className="drawer-root" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer-panel" ref={panelRef}>
        <header className="drawer-header">
          <div className="drawer-title">
            <p className="job-company">{job.company_name}</p>
            <h2 id="drawer-title">{job.title}</h2>
            <p className="drawer-sub">
              {[job.location, mode, experienceLabel(job), date ? `${formatRelativeAge(date)} · ${formatDate(date)}` : null].filter(Boolean).join(' · ')}
            </p>
            <JobBadges job={job} />
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
            <button type="button" className="icon-btn" onClick={() => shareJob(job, notify)} title="Share a link to this job" aria-label="Share job">
              <ShareIcon />
            </button>
            <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close details">
              <CloseIcon />
            </button>
          </div>
        </header>

        {/* Top row on desktop; a thumb-reach bottom bar on mobile (see CSS) */}
        <div className="drawer-actions">
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" className="btn primary" onClick={() => recordOpened(job)}>
              <ExternalLinkIcon /> <span>Open<span className="hide-mobile"> posting</span></span> <kbd>o</kbd>
            </a>
          ) : (
            <button type="button" className="btn primary" disabled title="No link for this job">
              <ExternalLinkIcon /> <span>No link</span>
            </button>
          )}
          <button type="button" className={`btn ${applied ? 'success' : ''}`} onClick={() => { dropLocalStatus(); onApplied(job, !applied) }} aria-pressed={applied}>
            {applied ? <CheckIcon /> : <CircleIcon />}
            <span>
              {appliedText}
              {applied && job.applied_at && <span className="hide-mobile"> {formatDate(job.applied_at)}</span>}
            </span>
            <kbd>a</kbd>
          </button>
          <button
            type="button"
            className={`btn drawer-save ${saved ? 'is-saved' : ''}`}
            onClick={() => changeStatus(saved ? 'not_applied' : 'saved')}
            aria-pressed={saved}
            disabled={applied}
            title={applied ? 'Already applied' : saved ? 'Saved. Click to remove (s)' : 'Save for later (s)'}
          >
            <BookmarkIcon filled={saved} /> <span>{saved ? 'Saved' : 'Save'}</span> <kbd>s</kbd>
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
        {inlineMessage && <p className="drawer-message" role="status">{inlineMessage}</p>}

        <div className="drawer-body" ref={bodyRef}>
          {bodyReady ? (
            <>
              <DuplicateNotice job={job} onOpenJob={onOpenJob} />
              <ClosedNotice job={job} status={status} onStatus={changeStatus} />

              <section className="drawer-section">
                <div className="drawer-fit-head">
                  <FitRing score={job.fit_score} size="lg" />
                  <div>
                    <h3>{fitLabel(job.fit_score)}</h3>
                    <p>Match against your roles, skills and experience.</p>
                  </div>
                </div>
                <FitBreakdown job={job} reasons={{ ...reasons, fit_skills: [reasons.fit_skills, showMissing ? missingLine : null] }} />
                {notForYou && <p className="fit-not-for-you">{notForYou}.</p>}
                <FitFeedback
                  job={job}
                  onHide={(reason) => onHide(job, reason)}
                  onMuteCompany={muteCompany}
                  muted={job.muted_by === 'company' || mutedKey === jobKey}
                />
              </section>

              <ApplicationPanel
                key={jobKey}
                job={job}
                status={status}
                onStatus={changeStatus}
                onNoteSaved={(patch) => noteSaved(jobKey, patch)}
                notify={notify}
                statusRef={statusRef}
              />

              <section className="drawer-section">
                <h3>Skills</h3>
                {skillsKnown && matchedLabels.length > 0 && (
                  <p className="drawer-note">Matched from your profile: <strong>{matchedLabels.join(', ')}</strong></p>
                )}
                {!skillsKnown ? (
                  <p className="drawer-note">No skills found in this posting, so skills count as neutral.</p>
                ) : have.length + missing.length > 0 ? (
                  <div className="skill-groups">
                    {have.length > 0 && (
                      <div className="skill-group">
                        <h4>You have</h4>
                        <div className="skill-tags">
                          {have.map(skill => <span key={skill} className="skill-tag active">{skill}</span>)}
                        </div>
                      </div>
                    )}
                    {missing.length > 0 && (
                      <div className="skill-group">
                        <h4>To learn</h4>
                        <div className="skill-tags">
                          {missing.map(skill => <span key={skill} className="skill-tag missing" title="Not in your profile">{skill}</span>)}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="drawer-note">No skills extracted for this job.</p>
                )}
              </section>

              <section className="drawer-section">
                <h3>Description</h3>
                {current.error && <p className="form-error">{current.error}</p>}
                {!extra && !current.error && <div className="skeleton-lines description-placeholder"><i /><i /><i /><i /></div>}
                {extra && <div className="drawer-description">{formatDescription(extra.description) || 'No description available.'}</div>}
              </section>

              <section className="drawer-section">
                <h3>Details</h3>
                <dl className="detail-list">
                  <DetailRow label="Standard role" value={standardRoleLabel(job.role_title, roleScore)} />
                  <DetailRow label="Also close to" value={extra?.role_alternative ?? job.role_alternative} />
                  <DetailRow label="Matched by" value={ROLE_METHODS[extra?.role_method] || extra?.role_method} />
                  <DetailRow label="Category" value={job.category} />
                  <DetailRow label="Level" value={job.experience_level || job.seniority_level} />
                  <DetailRow label="Location" value={job.location} />
                  <DetailRow label={job.cities?.length > 1 ? 'Cities' : 'City'} value={job.cities?.length ? job.cities.join(', ') : job.city} />
                  <DetailRow label="Work mode" value={job.work_mode ? WORK_MODE_LABELS[job.work_mode] || job.work_mode : null} />
                  <DetailRow label="Employment" value={EMPLOYMENT_LABELS[job.employment_kind] || job.employment_type} />
                  <DetailRow label="Function" value={extra?.job_function} />
                  <DetailRow label="Industry" value={extra?.industries} />
                  <DetailRow label="Source" value={job.source} />
                  <DetailRow label="Posted" value={formatDate(job.posted_date)} />
                  <DetailRow label="First found" value={formatDate(job.first_seen_at)} />
                  <DetailRow label="Last seen" value={job.last_seen_at ? `${formatDate(job.last_seen_at)} (${formatRelativeAge(job.last_seen_at)})` : null} />
                  <DetailRow label="Seen in scrapes" value={job.times_seen ? `${job.times_seen}×` : null} />
                  <DetailRow label="Applied on" value={applied ? formatDate(job.applied_at) : null} />
                </dl>
              </section>
            </>
          ) : (
            <div className="skeleton-lines drawer-section"><i /><i /><i /><i /></div>
          )}
        </div>
      </aside>
    </div>
  )
}
