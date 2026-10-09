// Plain-English reasons behind a job's fit score and its "For you" membership, from the explanation columns that
// app.user_jobs returns (fit_role, fit_skills, fit_experience, fit_role_reason, fit_core_matched, fit_exp_years,
// job_skills_known, in_for_you). The score is shown as points that add up to it: "49 = 40 role + 7 skills + 2 experience".
import {
  EXPERIENCE_HIDE_GAP, FIT_WEIGHTS, MATCH_MIN_FIT, NEUTRAL_SKILLS, UNKNOWN_EXPERIENCE, isTracked, profileSkillList, skillBuckets,
} from './gold.js'

// Most points each part can give (FIT_WEIGHTS x 100: 40 role, 45 skills, 15 experience), keyed like FIT_PARTS
export const FIT_POINTS_MAX = {
  fit_role: Math.round(FIT_WEIGHTS.role * 100),
  fit_skills: Math.round(FIT_WEIGHTS.skills * 100),
  fit_experience: Math.round(FIT_WEIGHTS.experience * 100),
}
const POINT_PARTS = [
  { key: 'fit_role', name: 'role', label: 'Role' },
  { key: 'fit_skills', name: 'skills', label: 'Skills' },
  { key: 'fit_experience', name: 'experience', label: 'Experience' },
]

// Where the fix-it buttons send you (Settings → Profile, scrolled to the field)
export const PROFILE_LINKS = {
  roles: '/settings?tab=profile#roles',
  skills: '/settings?tab=profile#skills',
  alsoSkills: '/settings?tab=profile#also-skills',
  experience: '/settings?tab=profile#experience',
  cities: '/settings?tab=profile#cities',
}

const present = (value) => value !== null && value !== undefined && value !== ''
const percent = (value) => `${Math.round(Number(value) * 100)}%`
const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`

function coreSkills(profile) {
  return Array.isArray(profile?.skills) ? profile.skills : []
}

function alsoSkills(profile) {
  return Array.isArray(profile?.also_skills) ? profile.also_skills : []
}

// The job's fit score as points per part: { role, skills, experience, total }, adding up to fit_score. Each raw part
// (fit_role x 40, fit_skills x 45, fit_experience x 15) is floored, then the points still missing go one each to the parts
// with the largest remainders (ties: role, skills, experience). null when the job is not scored.
export function fitPoints(job) {
  if (!job || !present(job.fit_score)) return null
  const total = Number(job.fit_score)
  if (!Number.isFinite(total)) return null
  const parts = POINT_PARTS.map(({ key }, order) => {
    const max = FIT_POINTS_MAX[key]
    const raw = Math.min(Math.max(Number(job[key]) || 0, 0), 1) * max
    const floor = Math.floor(raw + 1e-9) // 0.4 x 100 is 40.00000000000001: no remainder from float noise
    return { max, points: floor, rest: raw - floor, order }
  })
  let left = total - parts.reduce((sum, part) => sum + part.points, 0)
  // Normally 0-3 points to hand out. A score that does not fit its parts (a row cached under older scoring) is spread
  // the same way, round by round, within 0..max per part.
  const byRest = [...parts].sort((a, b) => b.rest - a.rest || a.order - b.order)
  for (let step = 0; left > 0 && byRest.some(part => part.points < part.max); step += 1) {
    const part = byRest[step % byRest.length]
    if (part.points < part.max) {
      part.points += 1
      left -= 1
    }
  }
  for (let step = 0; left < 0 && byRest.some(part => part.points > 0); step += 1) {
    const part = byRest[byRest.length - 1 - (step % byRest.length)]
    if (part.points > 0) {
      part.points -= 1
      left += 1
    }
  }
  const [role, skills, experience] = parts.map(part => part.points)
  return { role, skills, experience, total: role + skills + experience }
}

// "49 = 40 role + 7 skills + 2 experience", or "Not scored yet"
export function fitPointsLine(job) {
  const points = fitPoints(job)
  if (!points) return 'Not scored yet'
  return `${points.total} = ${points.role} role + ${points.skills} skills + ${points.experience} experience`
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

// "Asks 3–5 yrs", "Asks 5+ yrs (Senior level)"
function askedText(job) {
  const years = askedYears(job)
  const level = !present(job?.experience_min_years) && job?.experience_level ? ` (${job.experience_level} level)` : ''
  const max = present(job?.experience_max_years) ? Number(job.experience_max_years) : null
  return max !== null && max > years ? `Asks ${years}–${max} yrs${level}` : `Asks ${years}+ yrs${level}`
}

// Matched skills: core ones are counted by the server; the rest of fit_matched_skills are also-know skills
function matchedSkills(job, profile) {
  const matched = Array.isArray(job?.fit_matched_skills) ? job.fit_matched_skills.map(String) : []
  const core = new Set(coreSkills(profile).map(skill => String(skill).toLowerCase()))
  const coreNames = matched.filter(label => core.has(label.toLowerCase()))
  const alsoNames = matched.filter(label => !core.has(label.toLowerCase()))
  const coreCount = present(job?.fit_core_matched) ? Number(job.fit_core_matched) : coreNames.length
  return { matched, coreNames, alsoNames, core: coreCount, also: Math.max(0, matched.length - coreCount) }
}

// The points a part gave this job, for "(counted as 14/45)"; the neutral value when the job has no points
function partPoints(job, key, neutral) {
  const points = fitPoints(job)
  if (points) return points[POINT_PARTS.find(part => part.key === key).name]
  return Math.round(neutral * FIT_POINTS_MAX[key])
}

export function roleReason(job, profile) {
  const roles = Array.isArray(profile?.target_roles) ? profile.target_roles : []
  switch (job?.fit_role_reason) {
    case 'first_role': return roles[0] ? `Matches your #1 role, ${roles[0]}` : 'Matches your #1 role'
    case 'second_role': return roles[1] ? `Matches your #2 role, ${roles[1]}` : 'Matches your #2 role'
    case 'title': return 'The title names your role'
    case 'related': return 'Close to your roles'
    case 'alternative': return 'Related role'
    case 'category': return 'Same field as your roles'
    case 'none': return 'Not one of your roles'
    default: return null
  }
}

export function skillsReason(job, profile) {
  const total = coreSkills(profile).length
  if (!total && !alsoSkills(profile).length) return 'Add skills to your profile'
  if (job?.job_skills_known === false) {
    return `No skills listed (counted as ${partPoints(job, 'fit_skills', NEUTRAL_SKILLS)}/${FIT_POINTS_MAX.fit_skills})`
  }
  const { coreNames, alsoNames, core, also } = matchedSkills(job, profile)
  const names = (list) => (list.length ? ` (${list.join(', ')})` : '')
  const alsoText = `${also} you also know${names(alsoNames)}`
  if (!total) return also ? alsoText : 'None of your skills'
  const base = `${core} of your ${total} core ${plural(total, 'skill')}${core ? names(coreNames) : ''}`
  return also ? `${base}, and ${alsoText}` : base
}

export function experienceReason(job, profile) {
  const years = askedYears(job)
  if (years === null) {
    return `Experience not stated (counted as ${partPoints(job, 'fit_experience', UNKNOWN_EXPERIENCE)}/${FIT_POINTS_MAX.fit_experience})`
  }
  const range = yearsRange(profile)
  if (!range) return askedText(job)
  const min = present(profile?.min_years) ? Number(profile.min_years) : null
  const max = present(profile?.max_years) ? Number(profile.max_years) : null
  if (max !== null && years > max) return `${askedText(job)}, you have ${range} yrs`
  // Lower only when even the top of the asked range is under your minimum (a "1-5 years" job fits a 3-year minimum)
  if (min !== null && askedTop(job, years) < min) return `${askedText(job)}, below your ${range} yrs`
  return `${askedText(job)}, within your ${range} yrs`
}

// One line per fit bar, keyed like FIT_PARTS: { fit_role, fit_skills, fit_experience } (null = nothing to say)
export function fitReasons(job, profile) {
  return {
    fit_role: roleReason(job, profile),
    fit_skills: skillsReason(job, profile),
    fit_experience: experienceReason(job, profile),
  }
}

// The drawer's fit bars: [{ key, label, points, max, share (0-1, the bar width), reason, text }], text like
// "Role 40/40 · Matches your #1 role, Data Engineer". points is null for a job that is not scored.
export function fitBars(job, profile) {
  const points = fitPoints(job)
  const reasons = fitReasons(job, profile)
  return POINT_PARTS.map(({ key, name, label }) => {
    const max = FIT_POINTS_MAX[key]
    const value = points ? points[name] : null
    const reason = reasons[key]
    const score = value === null ? `${label}` : `${label} ${value}/${max}`
    return { key, label, points: value, max, share: value === null ? 0 : value / max, reason, text: reason ? `${score} · ${reason}` : score }
  })
}

// "Also asks for (not scored): Go, Rust, Scala +1": the job's skills that are not in your profile, under the skills bar;
// null when none are missing (or the posting lists no skills)
export function alsoAsksFor(job, profile, limit = 3, counts = null) {
  const missing = rankSkills(skillBuckets(job, profileSkillList(profile)).missing, counts)
  if (!missing.length) return null
  const more = missing.length > limit ? ` +${missing.length - limit}` : ''
  return `Also asks for (not scored): ${missing.slice(0, limit).join(', ')}${more}`
}

// How many of these jobs ask for each skill: Map(lower-case skill -> count), for rankSkills
export function skillCounts(jobs = []) {
  const counts = new Map()
  for (const job of jobs) {
    if (!Array.isArray(job?.skills)) continue
    for (const skill of job.skills) {
      const key = String(skill).toLowerCase()
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return counts
}

// Skills ordered by how many of the listed jobs ask for them too (skillCounts; most first, ties keep the posting's
// order), so the ones worth adding to your profile come first. Without counts the order is kept.
export function rankSkills(skills, counts) {
  if (!counts?.size || skills.length < 2) return skills
  return skills
    .map((skill, index) => ({ skill, index, n: counts.get(String(skill).toLowerCase()) || 0 }))
    .sort((a, b) => b.n - a.n || a.index - b.index)
    .map(item => item.skill)
}

// The job's skills split for the drawer: { have, missing } against core + also-know ("In your profile" / "Not in your
// profile"; have in job order, missing ranked by rankSkills when counts are given), and the alsoAsksFor() line (null
// when nothing is missing)
export function skillsSplit(job, profile, limit = 3, counts = null) {
  const { have, missing } = skillBuckets(job, profileSkillList(profile))
  return { have, missing: rankSkills(missing, counts), missingLine: alsoAsksFor(job, profile, limit, counts) }
}

// Why a job is not in "For you" (Everything); [] when it is. The same three rules as the server's in_for_you, each as
// { key: 'role' | 'unscored' | 'fit' | 'experience', text, action: { label, href } | null }. The drawer adds
// "Save anyway · saved jobs always show" itself.
export function notForYouReasons(job, profile) {
  if (!job || isTracked(job)) return []
  const score = present(job.fit_score) ? Number(job.fit_score) : null
  const above = job.above_experience === true
  const inForYou = job.in_for_you ?? (job.role_match === true && score !== null && score >= MATCH_MIN_FIT && !above)
  if (inForYou) return []
  const reasons = []
  if (job.role_match !== true) {
    reasons.push({ key: 'role', text: 'not close to your roles', action: { label: 'Edit roles', href: PROFILE_LINKS.roles } })
  }
  if (score === null) reasons.push({ key: 'unscored', text: 'not scored yet', action: null })
  else if (score < MATCH_MIN_FIT) {
    reasons.push({ key: 'fit', text: `fit ${score} (needs ${MATCH_MIN_FIT})`, action: { label: 'Add a skill', href: PROFILE_LINKS.skills } })
  }
  if (above) {
    const max = present(profile?.max_years) ? Number(profile.max_years) : null
    const years = askedYears(job)
    reasons.push({
      key: 'experience',
      text: max === null || years === null
        ? `asks more than ${EXPERIENCE_HIDE_GAP} yrs above your max`
        : `asks ${years}+ yrs (your max is ${max})`,
      action: { label: 'Edit experience', href: PROFILE_LINKS.experience },
    })
  }
  return reasons
}

// "Not in For you: fit 49 (needs 60) · asks 7+ yrs (your max is 4)"; null when the job is in For you
export function notForYouText(job, profile) {
  const reasons = notForYouReasons(job, profile)
  if (!reasons.length) return null
  return `Not in For you: ${reasons.map(reason => reason.text).join(' · ')}`
}

// "Data Engineer (role confidence 86%)" (admin-only Technical details)
export function standardRoleLabel(roleTitle, roleScore) {
  if (!roleTitle) return null
  return present(roleScore) && Number(roleScore) > 0 ? `${roleTitle} (role confidence ${percent(roleScore)})` : roleTitle
}

// The row's role tag is left out when it just repeats one of your roles (case-insensitive)
export function isOwnRole(job, profile) {
  const role = String(job?.role_title || '').trim().toLowerCase()
  if (!role) return false
  const roles = Array.isArray(profile?.target_roles) ? profile.target_roles : []
  return roles.some(item => String(item).trim().toLowerCase() === role)
}

const SKILLS_TAG_CHARS = 24

// The row's skills tag: the skill gap against your core + also-know skills.
// -> null (no profile skills, no job, or a job scored on skill groups only) | { label, title, tone: 'gap' | 'complete' | 'unknown' }
export function skillsTag(job, profile) {
  if (!job || !profileSkillList(profile).length) return null
  const jobSkills = Array.isArray(job.skills) ? job.skills : []
  if (job.job_skills_known === false || (!jobSkills.length && job.job_skills_known !== true)) {
    return { label: 'No skills listed', tone: 'unknown', title: 'This posting lists no skills, so skills count as neutral' }
  }
  // Only skill groups (no named skills) were scored: there is no gap to name, and "neutral" would not be true
  if (!jobSkills.length) return null
  const { missing } = skillBuckets(job, profileSkillList(profile))
  if (!missing.length) return { label: 'All skills', tone: 'complete', title: 'You have every skill this posting lists' }
  // Short enough for a row: names while they fit in ~24 characters (always the first), then "+N"
  const named = [missing[0]]
  while (named.length < 2 && named.length < missing.length && [...named, missing[named.length]].join(', ').length <= SKILLS_TAG_CHARS) {
    named.push(missing[named.length])
  }
  const more = missing.length > named.length ? ` +${missing.length - named.length}` : ''
  return { label: `lacks ${named.join(', ')}${more}`, tone: 'gap', title: `Not in your profile: ${missing.join(', ')}` }
}
