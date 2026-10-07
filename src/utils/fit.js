// Plain-English reasons behind a job's fit score and its "For you" membership, from the explanation columns that
// app.user_jobs returns (fit_role_reason, fit_role_sim, fit_core_matched, fit_exp_years, job_skills_known, in_for_you).
import { EXPERIENCE_HIDE_GAP, MATCH_MIN_FIT, NEUTRAL_SKILLS, UNKNOWN_EXPERIENCE, isTracked, skillBuckets, profileSkillList } from './gold.js'

const ROLE_REASONS = {
  first_role: 'Your first role',
  second_role: 'Your second role',
  title: 'The title names your role',
  alternative: 'Related role',
  category: 'Same category as your roles',
  none: 'Not one of your roles',
}

const present = (value) => value !== null && value !== undefined && value !== ''
const percent = (value) => `${Math.round(Number(value) * 100)}%`

function coreSkills(profile) {
  return Array.isArray(profile?.skills) ? profile.skills : []
}

// "2–4", "3+", "up to 4"; null without a range
export function yearsRange(profile) {
  const min = present(profile?.min_years) ? Number(profile.min_years) : null
  const max = present(profile?.max_years) ? Number(profile.max_years) : null
  if (min !== null && max !== null) return min === max ? `${min}` : `${min}–${max}`
  if (min !== null) return `${min}+`
  if (max !== null) return `up to ${max}`
  return null
}

// Years the job asks for, as the score counts them (stated minimum, else the level's years)
function askedYears(job) {
  if (present(job?.fit_exp_years)) return Number(job.fit_exp_years)
  if (present(job?.experience_min_years)) return Number(job.experience_min_years)
  return null
}

// Top of the asked range as the score counts it (stated maximum, else the minimum + 3; app.user_jobs exp_top)
function askedTop(job, years) {
  return present(job?.experience_max_years) ? Number(job.experience_max_years) : years + 3
}

function askedText(job) {
  const years = askedYears(job)
  const level = !present(job?.experience_min_years) && job?.experience_level ? ` (${job.experience_level} level)` : ''
  const max = present(job?.experience_max_years) ? Number(job.experience_max_years) : null
  return max !== null && max > years ? `Asks ${years}–${max} years${level}` : `Asks ${years}+ years${level}`
}

// Matched skills: core ones are counted by the server; the rest of fit_matched_skills are also-know skills
function matchedCounts(job, profile) {
  const matched = Array.isArray(job?.fit_matched_skills) ? job.fit_matched_skills : []
  const core = present(job?.fit_core_matched)
    ? Number(job.fit_core_matched)
    : matched.filter(label => coreSkills(profile).some(skill => skill.toLowerCase() === String(label).toLowerCase())).length
  return { matched, core, also: Math.max(0, matched.length - core) }
}

export function roleReason(job) {
  const reason = job?.fit_role_reason
  if (!reason) return null
  if (reason === 'related') {
    return present(job.fit_role_sim) ? `Close to your roles (similarity ${Number(job.fit_role_sim).toFixed(2)})` : 'Close to your roles'
  }
  return ROLE_REASONS[reason] || null
}

export function skillsReason(job, profile) {
  const total = coreSkills(profile).length
  if (!total) return 'Add skills to your profile'
  if (job?.job_skills_known === false) return `No skills found in this posting (counted as ${percent(NEUTRAL_SKILLS)})`
  const { core, also } = matchedCounts(job, profile)
  const base = `${core} of your ${total} core skill${total === 1 ? '' : 's'}`
  return also ? `${base}, plus ${also} you also know` : base
}

export function experienceReason(job, profile) {
  const years = askedYears(job)
  if (years === null) return `Experience not stated (counted as ${percent(UNKNOWN_EXPERIENCE)})`
  const range = yearsRange(profile)
  const min = present(profile?.min_years) ? Number(profile.min_years) : null
  const max = present(profile?.max_years) ? Number(profile.max_years) : null
  if (max !== null && years > max) return `${askedText(job)}, your range ${range}`
  // Lower only when even the top of the asked range is under your minimum (a "1-5 years" job fits a 3-year minimum)
  if (min !== null && askedTop(job, years) < min) return `${askedText(job)}, below your range ${range}`
  return range ? 'Within your range' : askedText(job)
}

// One line per fit bar, keyed like FIT_PARTS: { fit_role, fit_skills, fit_experience } (null = nothing to say)
export function fitReasons(job, profile) {
  return {
    fit_role: roleReason(job),
    fit_skills: skillsReason(job, profile),
    fit_experience: experienceReason(job, profile),
  }
}

// Why a job is not in "For you" (Show all); [] when it is. The same three rules as the server's in_for_you.
export function notForYouReasons(job, profile) {
  if (!job || isTracked(job)) return []
  const score = present(job.fit_score) ? Number(job.fit_score) : null
  const above = job.above_experience === true
  const inForYou = job.in_for_you ?? (job.role_match === true && score !== null && score >= MATCH_MIN_FIT && !above)
  if (inForYou) return []
  const reasons = []
  if (job.role_match !== true) reasons.push('the role is not close enough to yours')
  if (score === null) reasons.push('the fit is not scored yet')
  else if (score < MATCH_MIN_FIT) reasons.push(`the fit is ${score}, under ${MATCH_MIN_FIT}`)
  if (above) {
    const max = present(profile?.max_years) ? Number(profile.max_years) : null
    const years = askedYears(job)
    reasons.push(max === null || years === null
      ? `it asks more than ${EXPERIENCE_HIDE_GAP} years above your maximum`
      : `it asks ${years}+ years, more than ${EXPERIENCE_HIDE_GAP} above your maximum of ${max}`)
  }
  return reasons
}

// "Not in For you because the fit is 52, under 60 and …"; null when the job is in For you
export function notForYouText(job, profile) {
  const reasons = notForYouReasons(job, profile)
  if (!reasons.length) return null
  const list = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join(', ')} and ${reasons[reasons.length - 1]}`
  return `Not in For you because ${list}`
}

// "Data Engineer (role confidence 86%)"
export function standardRoleLabel(roleTitle, roleScore) {
  if (!roleTitle) return null
  return present(roleScore) && Number(roleScore) > 0 ? `${roleTitle} (role confidence ${percent(roleScore)})` : roleTitle
}

// The row's skills tag: "3/5 skills +1" (core matched / core count, + matched also-know), or "skills ?" when the posting
// lists none. { label, title }, or null when the profile has no core skills.
export function skillsTag(job, profile) {
  const total = coreSkills(profile).length
  if (!total || !job) return null
  if (job.job_skills_known === false) return { label: 'skills ?', title: 'No skills found in this posting; counted as neutral' }
  const { matched, core, also } = matchedCounts(job, profile)
  return {
    label: `${core}/${total} skills${also ? ` +${also}` : ''}`,
    title: matched.length ? `Matched: ${matched.join(', ')}` : 'None of your skills found in this posting',
  }
}

// The job's skills split for the drawer: { have, missing } against core + also-know, and "Missing: X, Y, Z" (first 3 in
// job order; null when nothing is missing)
export function skillsSplit(job, profile, limit = 3) {
  const { have, missing } = skillBuckets(job, profileSkillList(profile))
  return { have, missing, missingLine: missing.length ? `Missing: ${missing.slice(0, limit).join(', ')}` : null }
}
