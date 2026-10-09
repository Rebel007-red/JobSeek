import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { PROFILE_LIMITS } from '../../utils/entries'
import { formatDate, formatRelativeAge, parseDay, postedAgo } from '../../utils/job'
import { recordOpened } from '../../utils/viewPref'
import {
  APPLIED_STATUSES, EMPLOYMENT_LABELS, FIT_PARTS, WORK_MODE_LABELS, experienceLabel, fitLabel, formatDescription, isApplied, jobDate,
  jobUrl, statusLabel,
} from '../../utils/gold'
import { fitPointsLine, notForYouReasons, skillsSplit, standardRoleLabel } from '../../utils/fit'
import { FitBreakdown, FitRing } from './Fit'
import { ApplicationPanel } from '../job/ApplicationPanel'
import { FitFeedback } from '../job/FitFeedback'
import { AgeNotice, DuplicateNotice, JobBadges } from '../job/JobNotices'
import { shareJob } from '../job/share'
import {
  BookmarkIcon, CheckCircleIcon, ChevronDownIcon, ChevronUpIcon, CloseIcon, ExternalLinkIcon, EyeOffIcon, ShareIcon,
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

let shortDayFormat = null
// 'YYYY-MM-DD' as "Oct 16" (the local day, in every time zone)
function dayLabel(value) {
  const day = parseDay(value)
  if (!day) return value
  shortDayFormat ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return shortDayFormat.format(day)
}

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
// onStatus(job, status) for the status picker, the Save button, the AgeNotice and "Save anyway";
// onJobChange(jobKey, patch) after a note save ({ has_note, next_action_at, application_status });
// onSnooze(job, nextActionAt) => Promise for the AgeNotice's "No reply yet" (sets the follow-up date, keeps the note;
// the page patches next_action_at and shows the toast with Undo);
// onKnowSkill(skill) => Promise<boolean> adds a "Not in your profile" skill to Also know (the "+ I know this" buttons show
// only with it); onMuteCompany(job); onOpenJob(jobKey) for "View it" on the duplicate notice; onToast(message) for short
// messages ("Link copied"). statusFocus: change it (a counter) to focus the status picker (the t key).
// isAdmin shows the "Technical details"; since (useVisit) marks a job found since your last visit as New.
// skillCounts (fit.js skillCounts of the listed jobs): "Not in your profile" lists the skills more of them ask for first,
// MISSING_SHOWN of them until "+N more".
const MISSING_SHOWN = 5

export function JobDrawer({
  job: jobProp, profile, position, onMove, onClose, onApplied, onHide, onStatus, onJobChange, onSnooze, onKnowSkill,
  onMuteCompany, onOpenJob, onToast, statusFocus, isAdmin = false, since, skillCounts = null,
}) {
  const [detail, setDetail] = useState({ key: null, row: null, error: '' })
  const [local, setLocal] = useState({ key: null, patch: {} }) // edits made without a page handler
  const [message, setMessage] = useState({ key: null, text: '' }) // inline message when there is no onToast
  const [mutedKey, setMutedKey] = useState(null) // company muted from this drawer (no onMuteCompany)
  const [snoozing, setSnoozing] = useState(false)
  const [knowing, setKnowing] = useState(null) // the skill "+ I know this" is adding
  const [allMissingKey, setAllMissingKey] = useState(null) // the job whose whole "Not in your profile" list is open
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

  // "No reply yet": the follow-up date a week out hides the AgeNotice until then (setNote without a note keeps the note)
  const snooze = async (nextActionAt) => {
    setSnoozing(true)
    try {
      if (onSnooze) {
        await onSnooze(job, nextActionAt)
        return
      }
      const before = { next_action_at: job.next_action_at ?? null, follow_up: Boolean(job.follow_up) }
      // a follow-up date ahead means no "Follow up" badge until then (as the server's follow_up)
      patchLocal(jobKey, { next_action_at: nextActionAt, follow_up: false })
      try {
        await api.snoozeFollowUp(jobKey, nextActionAt)
        notify(`OK. We'll ask again on ${dayLabel(nextActionAt)}`)
      } catch (err) {
        patchLocal(jobKey, before)
        throw err
      }
    } catch (err) {
      notify(`Could not save: ${err.message}`)
    } finally {
      setSnoozing(false)
    }
  }

  // "+ I know this": the page adds the skill to Also know (with Undo) and re-reads the job, so it re-scores in place
  // (the buttons are aria-disabled while one runs, not disabled: a disabled button drops the keyboard focus)
  const knowSkill = async (skill) => {
    if (knowing !== null) return
    setKnowing(skill)
    try {
      await onKnowSkill(skill)
    } catch (err) {
      notify(`Could not add ${skill}: ${err.message}`)
    } finally {
      setKnowing(null)
    }
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
  const skillsKnown = job.job_skills_known !== false
  const { have, missing, missingLine } = skillsKnown ? skillsSplit(job, profile, 3, skillCounts) : { have: [], missing: [], missingLine: null }
  const allMissing = allMissingKey === jobKey
  const missingShown = allMissing ? missing : missing.slice(0, MISSING_SHOWN)
  const notForYou = notForYouReasons(job, profile)
  const scored = job.fit_score !== null && job.fit_score !== undefined
  const hasParts = FIT_PARTS.some(part => job[part.key] !== null && job[part.key] !== undefined)
  const canKnow = Boolean(onKnowSkill) && Boolean(profile)
  const alsoFull = (Array.isArray(profile?.also_skills) ? profile.also_skills.length : 0) >= PROFILE_LIMITS.alsoSkills
  const modeLabel = SUBTITLE_MODES.includes(job.work_mode) ? WORK_MODE_LABELS[job.work_mode] : null
  // left out when the location already says it ("Remote · Remote")
  const mode = modeLabel && !String(job.location || '').toLowerCase().includes(modeLabel.toLowerCase()) ? modeLabel : null
  // An older posting (over 2 days, is_active false) gets a neutral "Posted 5 days ago": it may still be open
  const age = job.is_active === false ? postedAgo(job) : date ? `${formatRelativeAge(date)} · ${formatDate(date)}` : null
  const inlineMessage = message.key === jobKey ? message.text : ''
  // An applied job shows its stage ("Interviewing"); plain applied (or an older row without a status) shows "Applied".
  // The aria-label names what a press does (Mark applied / Undo applied).
  const appliedText = !applied ? 'Mark applied' : APPLIED_STATUSES.includes(status) ? statusLabel(status) : 'Applied'
  const appliedAction = applied ? 'Undo applied' : 'Mark applied'
  // The accessible name starts with the visible text (voice control: "click Interviewing"), then names the action
  const appliedName = applied ? `${appliedText}. ${appliedAction}` : appliedAction

  // Directly under the skills bar: the skills the posting asks for that are not scored
  const alsoAsks = missingLine && <p className="fit-also-asks">{missingLine}</p>
  // Under the bars: the posting's skills split by your profile, each missing one with "+ I know this"
  const skillsDetail = have.length + missing.length > 0 && (
    <div className="fit-skills">
      <div className="skill-groups">
        {have.length > 0 && (
          <div className="skill-group">
            <h4>In your profile</h4>
            <div className="skill-tags">
              {have.map(skill => <span key={skill} className="skill-tag active">{skill}</span>)}
            </div>
          </div>
        )}
        {missing.length > 0 && (
          <div className="skill-group">
            <h4>Not in your profile</h4>
            {canKnow && alsoFull && <p className="drawer-note">Also know is full ({PROFILE_LIMITS.alsoSkills}). Remove one in Settings → Profile</p>}
            <ul className={`skill-tags ${canKnow && !alsoFull ? 'with-actions' : ''}`}>
              {missingShown.map(skill => (
                <li key={skill} className="skill-tag missing">
                  <span>{skill}</span>
                  {canKnow && !alsoFull && (
                    <button
                      type="button"
                      className="skill-know"
                      onClick={() => knowSkill(skill)}
                      aria-disabled={knowing !== null || undefined}
                      aria-label={`Add ${skill} to Also know`}
                      title={`Add ${skill} to Also know (Settings → Profile)`}
                    >
                      {knowing === skill ? 'Adding…' : '+ I know this'}
                    </button>
                  )}
                </li>
              ))}
              {missing.length > MISSING_SHOWN && (
                <li className="skill-more">
                  <button type="button" className="text-button" onClick={() => setAllMissingKey(allMissing ? null : jobKey)} aria-expanded={allMissing}>
                    {allMissing ? 'Show fewer' : `+${missing.length - MISSING_SHOWN} more`}
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="drawer-root" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer-panel" ref={panelRef}>
        <header className="drawer-header">
          <div className="drawer-title">
            <p className="job-company">{job.company_name}</p>
            <h2 id="drawer-title">{job.title}</h2>
            <p className="drawer-sub">
              {[job.location, mode, experienceLabel(job) || 'Exp not stated', age].filter(Boolean).join(' · ')}
            </p>
            <JobBadges job={job} since={since} />
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
            <a href={url} target="_blank" rel="noopener noreferrer" className="btn primary" onClick={() => recordOpened(job)} title="Open the posting (o)">
              <ExternalLinkIcon /> <span>Open<span className="hide-mobile"> posting</span></span> <kbd>o</kbd>
            </a>
          ) : (
            <button type="button" className="btn primary" disabled title="No link for this job">
              <ExternalLinkIcon /> <span>No link</span>
            </button>
          )}
          <button
            type="button"
            className={`btn ${applied ? 'success' : ''}`}
            onClick={() => { dropLocalStatus(); onApplied(job, !applied) }}
            aria-label={appliedName}
            title={`${appliedAction} (a)`}
          >
            <CheckCircleIcon filled={applied} />
            <span>
              {appliedText}
              {applied && job.applied_at && <span className="hide-mobile"> {formatDate(job.applied_at)}</span>}
            </span>
            <kbd>a</kbd>
          </button>
          {/* An applied job is kept anyway, so it has no Save (as its row has no bookmark) */}
          {!applied && (
            <button
              type="button"
              className={`btn drawer-save ${saved ? 'is-saved' : ''}`}
              onClick={() => changeStatus(saved ? 'not_applied' : 'saved')}
              aria-label={saved ? 'Saved. Unsave' : 'Save'}
              title={saved ? 'Unsave (s)' : 'Save (s)'}
            >
              <BookmarkIcon filled={saved} /> <span>{saved ? 'Saved' : 'Save'}</span> <kbd>s</kbd>
            </button>
          )}
          <button type="button" className="btn danger" onClick={() => onHide(job)} title="Hide (x)">
            <EyeOffIcon /> <span>Hide</span> <kbd>x</kbd>
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
              <AgeNotice job={job} onStatus={changeStatus} onSnooze={snooze} busy={snoozing} />

              <section className="drawer-section" aria-labelledby="drawer-fit-title">
                <div className="drawer-fit-head">
                  <FitRing score={job.fit_score} size="lg" />
                  <div>
                    <h3 id="drawer-fit-title">{scored ? fitLabel(job.fit_score) : 'Not scored yet'}</h3>
                    {/* without the parts the points would be made up, so the line needs them */}
                    {scored && hasParts && <p className="fit-points-line">{fitPointsLine(job)}</p>}
                  </div>
                </div>
                {hasParts ? <FitBreakdown job={job} profile={profile} slots={{ fit_skills: alsoAsks }} /> : alsoAsks}
                {skillsDetail}
                {notForYou.length > 0 && (
                  <div className="fit-not-for-you">
                    <p>Not in For you: {notForYou.map(reason => reason.text).join(' · ')}</p>
                    <div className="fit-fix-actions">
                      {notForYou.filter(reason => reason.action).map(reason => (
                        <Link key={reason.key} className="btn sm" to={reason.action.href}>{reason.action.label}</Link>
                      ))}
                      <button type="button" className="btn sm" onClick={() => changeStatus('saved')}>
                        Save anyway · saved jobs always show
                      </button>
                    </div>
                  </div>
                )}
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
                <h3>Description</h3>
                {current.error && <p className="form-error">{current.error}</p>}
                {!extra && !current.error && <div className="skeleton-lines description-placeholder"><i /><i /><i /><i /></div>}
                {extra && <div className="drawer-description">{formatDescription(extra.description) || 'No description available.'}</div>}
              </section>

              <section className="drawer-section">
                <h3>Details</h3>
                <dl className="detail-list">
                  <DetailRow label="Standard role" value={job.role_title} />
                  <DetailRow label="Also close to" value={extra?.role_alternative ?? job.role_alternative} />
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
                  <DetailRow label="Applied on" value={applied ? formatDate(job.applied_at) : null} />
                </dl>
                {isAdmin && (
                  <details className="drawer-tech">
                    <summary>Technical details</summary>
                    <dl className="detail-list">
                      <DetailRow label="Standard role" value={standardRoleLabel(job.role_title, roleScore)} />
                      <DetailRow label="Matched by" value={ROLE_METHODS[extra?.role_method] || extra?.role_method} />
                      <DetailRow label="Last seen" value={job.last_seen_at ? `${formatDate(job.last_seen_at)} (${formatRelativeAge(job.last_seen_at)})` : null} />
                      <DetailRow label="Seen in scrapes" value={job.times_seen ? `${job.times_seen}×` : null} />
                      <DetailRow label="Job key" value={jobKey} />
                    </dl>
                  </details>
                )}
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
