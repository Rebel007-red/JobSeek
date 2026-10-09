import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FIT_POINTS_MAX, PROFILE_LINKS, alsoAsksFor, fitBars, fitPoints, fitPointsLine, fitReasons, isOwnRole, notForYouReasons,
  notForYouText, rankSkills, skillCounts, skillsSplit, skillsTag, standardRoleLabel,
} from './fit.js'
import { FIT_WEIGHTS } from './gold.js'

const profile = { target_roles: ['Data Engineer', 'Analytics Engineer'], skills: ['Python', 'Spark', 'SQL', 'AWS', 'Airflow'], also_skills: ['Kafka'], min_years: 2, max_years: 4 }

// fit_score as app.user_jobs computes it (double arithmetic, round half up)
function serverScore({ fit_role: role, fit_skills: skills, fit_experience: experience }) {
  const raw = 100 * ((FIT_WEIGHTS.role * role + FIT_WEIGHTS.skills * skills) + FIT_WEIGHTS.experience * experience)
  return Math.floor(raw) + (raw - Math.floor(raw) >= 0.5 ? 1 : 0)
}

test('fitPoints: three parts that add up to the fit score (largest remainder)', () => {
  assert.deepEqual(FIT_POINTS_MAX, { fit_role: 40, fit_skills: 45, fit_experience: 15 })
  const job = { fit_role: 1, fit_skills: 0.16, fit_experience: 0.133 } // 40 + 7.2 + 1.995 = 49.195
  job.fit_score = serverScore(job)
  assert.equal(job.fit_score, 49)
  assert.deepEqual(fitPoints(job), { role: 40, skills: 7, experience: 2, total: 49 })
  assert.equal(fitPointsLine(job), '49 = 40 role + 7 skills + 2 experience')
  // equal remainders go to role first, then skills: 19.5 + 13.5 + 10.5 = 43.5 -> 44
  assert.deepEqual(fitPoints({ fit_score: 44, fit_role: 0.4875, fit_skills: 0.3, fit_experience: 0.7 }),
    { role: 20, skills: 14, experience: 10, total: 44 })
  assert.deepEqual(fitPoints({ fit_score: 100, fit_role: 1, fit_skills: 1, fit_experience: 1 }), { role: 40, skills: 45, experience: 15, total: 100 })
  assert.deepEqual(fitPoints({ fit_score: 0, fit_role: 0, fit_skills: 0, fit_experience: 0 }), { role: 0, skills: 0, experience: 0, total: 0 })
  // not scored
  assert.equal(fitPoints({ fit_score: null, fit_role: 1 }), null)
  assert.equal(fitPoints(null), null)
  assert.equal(fitPointsLine({}), 'Not scored yet')
  // a score that does not fit its parts still adds up, within each part's maximum
  assert.deepEqual(fitPoints({ fit_score: 100, fit_role: 0, fit_skills: 0, fit_experience: 0 }), { role: 40, skills: 45, experience: 15, total: 100 })
  assert.deepEqual(fitPoints({ fit_score: 0, fit_role: 1, fit_skills: 1, fit_experience: 1 }), { role: 0, skills: 0, experience: 0, total: 0 })
})

test('fitPoints always adds up for scores the server computes', () => {
  const roles = [0, 0.3, 0.5, 0.85, 0.9, 0.95, 1, 0.4521, 0.8133]
  const skills = [0, 0.3, 0.1234, 0.5, 0.6667, 0.999, 1, 0.0412]
  const experiences = [0, 0.1, 0.4, 0.5, 0.55, 0.7, 0.85, 1]
  for (const fitRole of roles) {
    for (const fitSkills of skills) {
      for (const fitExperience of experiences) {
        const job = { fit_role: fitRole, fit_skills: fitSkills, fit_experience: fitExperience }
        job.fit_score = serverScore(job)
        const points = fitPoints(job)
        assert.equal(points.role + points.skills + points.experience, job.fit_score, JSON.stringify(job))
        assert.ok(Math.abs(points.role - fitRole * 40) < 1 && Math.abs(points.skills - fitSkills * 45) < 1
          && Math.abs(points.experience - fitExperience * 15) < 1, JSON.stringify(job))
      }
    }
  }
})

test('fitReasons explains each bar', () => {
  const job = {
    fit_role_reason: 'related', fit_role_sim: 0.8312, fit_core_matched: 4, fit_matched_skills: ['Python', 'Spark', 'SQL', 'AWS', 'Kafka'],
    job_skills_known: true, fit_exp_years: 5, experience_min_years: null, experience_level: 'Senior',
  }
  assert.deepEqual(fitReasons(job, profile), {
    fit_role: 'Close to your roles',
    fit_skills: '4 of your 5 core skills (Python, Spark, SQL, AWS), and 1 you also know (Kafka)',
    fit_experience: 'Asks 5+ yrs (Senior level), you have 2–4 yrs',
  })
  assert.equal(fitReasons({ fit_role_reason: 'first_role' }, profile).fit_role, 'Matches your #1 role, Data Engineer')
  assert.equal(fitReasons({ fit_role_reason: 'second_role' }, profile).fit_role, 'Matches your #2 role, Analytics Engineer')
  assert.equal(fitReasons({ fit_role_reason: 'second_role' }, { target_roles: ['X'] }).fit_role, 'Matches your #2 role')
  assert.equal(fitReasons({ fit_role_reason: 'title' }, profile).fit_role, 'The title names your role')
  assert.equal(fitReasons({ fit_role_reason: 'alternative' }, profile).fit_role, 'Related role')
  assert.equal(fitReasons({ fit_role_reason: 'category' }, profile).fit_role, 'Same field as your roles')
  assert.equal(fitReasons({ fit_role_reason: 'none' }, profile).fit_role, 'Not one of your roles')
  assert.equal(fitReasons({}, profile).fit_role, null)
  // skills
  assert.equal(fitReasons({ fit_core_matched: 0, fit_matched_skills: [] }, profile).fit_skills, '0 of your 5 core skills')
  assert.equal(fitReasons({ fit_core_matched: 1, fit_matched_skills: ['SQL'] }, { skills: ['SQL'] }).fit_skills, '1 of your 1 core skill (SQL)')
  assert.equal(fitReasons({ fit_matched_skills: ['Kafka'] }, { skills: [], also_skills: ['Kafka'] }).fit_skills, '1 you also know (Kafka)')
  assert.equal(fitReasons({ job_skills_known: false, fit_score: 44, fit_role: 0.4875, fit_skills: 0.3, fit_experience: 0.7 }, profile).fit_skills,
    'No skills listed (counted as 14/45)')
  assert.equal(fitReasons({ job_skills_known: false }, profile).fit_skills, 'No skills listed (counted as 14/45)')
  assert.equal(fitReasons({}, { skills: [] }).fit_skills, 'Add skills to your profile')
  // experience
  assert.equal(fitReasons({ fit_exp_years: null, fit_score: 44, fit_role: 0.4875, fit_skills: 0.3, fit_experience: 0.7 }, profile).fit_experience,
    'Experience not stated (counted as 10/15)')
  assert.equal(fitReasons({ fit_exp_years: 3, experience_min_years: 3 }, profile).fit_experience, 'Asks 3+ yrs, within your 2–4 yrs')
  assert.equal(fitReasons({ fit_exp_years: 3, experience_min_years: 3, experience_max_years: 5 }, profile).fit_experience,
    'Asks 3–5 yrs, within your 2–4 yrs')
  // below the range only when the top of the asked range (stated maximum, else minimum + 3) is under your minimum,
  // as the experience score counts it
  assert.equal(fitReasons({ fit_exp_years: 1, experience_min_years: 1 }, profile).fit_experience, 'Asks 1+ yrs, within your 2–4 yrs')
  assert.equal(fitReasons({ fit_exp_years: 0, experience_min_years: 0, experience_max_years: 1 }, profile).fit_experience,
    'Asks 0–1 yrs, below your 2–4 yrs')
  assert.equal(fitReasons({ fit_exp_years: 6, experience_min_years: 6, experience_max_years: 9 }, profile).fit_experience,
    'Asks 6–9 yrs, you have 2–4 yrs')
  assert.equal(fitReasons({ fit_exp_years: 0, experience_min_years: null, experience_level: 'Entry' }, { min_years: 5, max_years: 8, skills: ['Go'] }).fit_experience,
    'Asks 0+ yrs (Entry level), below your 5–8 yrs')
  assert.equal(fitReasons({ fit_exp_years: 3, experience_min_years: 3 }, { skills: ['Go'] }).fit_experience, 'Asks 3+ yrs')
})

test('fitBars: points of each part with its reason', () => {
  const job = { fit_score: 49, fit_role: 1, fit_skills: 0.16, fit_experience: 0.133, fit_role_reason: 'first_role', fit_core_matched: 1,
    fit_matched_skills: ['SQL'], fit_exp_years: null }
  const bars = fitBars(job, profile)
  assert.deepEqual(bars.map(bar => bar.text), [
    'Role 40/40 · Matches your #1 role, Data Engineer',
    'Skills 7/45 · 1 of your 5 core skills (SQL)',
    'Experience 2/15 · Experience not stated (counted as 2/15)',
  ])
  assert.deepEqual(bars.map(bar => [bar.key, bar.points, bar.max]), [['fit_role', 40, 40], ['fit_skills', 7, 45], ['fit_experience', 2, 15]])
  assert.equal(bars[0].share, 1)
  assert.equal(bars[1].share, 7 / 45)
  const unscored = fitBars({}, profile)
  assert.deepEqual(unscored.map(bar => [bar.points, bar.share]), [[null, 0], [null, 0], [null, 0]])
  assert.equal(unscored[0].text, 'Role')
})

test('notForYouReasons lists every rule that leaves a job out, with a fix', () => {
  const job = { in_for_you: false, role_match: false, fit_score: 49, above_experience: true, fit_exp_years: 7 }
  assert.deepEqual(notForYouReasons(job, profile), [
    { key: 'role', text: 'not close to your roles', action: { label: 'Edit roles', href: '/settings?tab=profile#roles' } },
    { key: 'fit', text: 'fit 49 (needs 60)', action: { label: 'Add a skill', href: '/settings?tab=profile#skills' } },
    { key: 'experience', text: 'asks 7+ yrs (your max is 4)', action: { label: 'Edit experience', href: '/settings?tab=profile#experience' } },
  ])
  assert.equal(notForYouText({ in_for_you: false, role_match: true, fit_score: 49, above_experience: true, fit_exp_years: 7 }, profile),
    'Not in For you: fit 49 (needs 60) · asks 7+ yrs (your max is 4)')
  assert.deepEqual(notForYouReasons({ in_for_you: false, role_match: true, fit_score: null }, profile),
    [{ key: 'unscored', text: 'not scored yet', action: null }])
  assert.equal(notForYouReasons({ in_for_you: false, role_match: true, fit_score: 70, above_experience: true }, {})[0].text,
    'asks more than 2 yrs above your max')
  assert.deepEqual(notForYouReasons({ in_for_you: true, role_match: false }, profile), [])
  // tracked jobs are always For you
  assert.deepEqual(notForYouReasons({ role_match: false, fit_score: 10, application_status: 'saved' }, profile), [])
  // rows without in_for_you fall back to the same rule
  assert.deepEqual(notForYouReasons({ role_match: true, fit_score: 75, above_experience: false }, profile), [])
  assert.equal(notForYouText({ role_match: true, fit_score: 75 }, profile), null)
  assert.equal(PROFILE_LINKS.cities, '/settings?tab=profile#cities')
  assert.equal(PROFILE_LINKS.alsoSkills, '/settings?tab=profile#also-skills')
})

test('skillsTag shows the skill gap', () => {
  const job = (skills, extra = {}) => ({ skills, job_skills_known: skills.length > 0, ...extra })
  assert.deepEqual(skillsTag(job(['Python', 'Snowflake', 'Airflow', 'dbt', 'Looker']), { skills: ['Python'] }), {
    label: 'lacks Snowflake, Airflow +2', tone: 'gap', title: 'Not in your profile: Snowflake, Airflow, dbt, Looker',
  })
  assert.deepEqual(skillsTag(job(['Python', 'Snowflake']), { skills: ['Python'] }), {
    label: 'lacks Snowflake', tone: 'gap', title: 'Not in your profile: Snowflake',
  })
  assert.equal(skillsTag(job(['Python', 'Snowflake', 'Kafka']), profile).label, 'lacks Snowflake')
  // long names: only the first is named, so the row stays short
  assert.equal(skillsTag(job(['Python', 'Data Warehousing', 'Data Quality', 'Kafka', 'dbt']), { skills: ['Python'] }).label, 'lacks Data Warehousing +3')
  // also-know skills and matched skill groups count as yours
  assert.deepEqual(skillsTag(job(['python', 'Kafka']), profile), { label: 'All skills', tone: 'complete', title: 'You have every skill this posting lists' })
  assert.equal(skillsTag(job(['AWS Glue'], { fit_matched_skills: ['AWS Glue'] }), profile).tone, 'complete')
  assert.deepEqual(skillsTag(job([]), profile), { label: 'No skills listed', tone: 'unknown', title: 'This posting lists no skills, so skills count as neutral' })
  assert.equal(skillsTag({ job_skills_known: false, skills: ['Python'] }, profile).tone, 'unknown')
  assert.equal(skillsTag({ skills: null }, profile).tone, 'unknown')
  // scored on skill groups only (no named skills): no gap to show, and not "neutral"
  assert.equal(skillsTag({ skills: [], job_skills_known: true }, profile), null)
  // no profile skills at all (core or also-know), or no job
  assert.equal(skillsTag(job(['Python']), { skills: [] }), null)
  assert.equal(skillsTag(job(['Kafka']), { skills: [], also_skills: ['Kafka'] }).tone, 'complete')
  assert.equal(skillsTag(null, profile), null)
})

test('skillsSplit and alsoAsksFor', () => {
  const split = skillsSplit({ skills: ['python', 'Kafka', 'Go', 'Rust', 'Scala', 'Java'], fit_matched_skills: ['Python'] }, profile)
  assert.deepEqual(split.have, ['python', 'Kafka'])
  assert.deepEqual(split.missing, ['Go', 'Rust', 'Scala', 'Java'])
  assert.equal(split.missingLine, 'Also asks for (not scored): Go, Rust, Scala +1')
  assert.equal(alsoAsksFor({ skills: ['Go', 'Rust'] }, profile), 'Also asks for (not scored): Go, Rust')
  assert.equal(skillsSplit({ skills: ['Python'] }, profile).missingLine, null)
  assert.equal(alsoAsksFor({}, profile), null)
})

test('isOwnRole hides a role tag that repeats your role', () => {
  assert.equal(isOwnRole({ role_title: 'data engineer' }, profile), true)
  assert.equal(isOwnRole({ role_title: 'Data Analyst' }, profile), false)
  assert.equal(isOwnRole({ role_title: null }, profile), false)
  assert.equal(isOwnRole({ role_title: 'Data Engineer' }, null), false)
})

test('standardRoleLabel', () => {
  assert.equal(standardRoleLabel('Data Engineer', 0.861), 'Data Engineer (role confidence 86%)')
  assert.equal(standardRoleLabel('Data Engineer', null), 'Data Engineer')
  assert.equal(standardRoleLabel(null, 0.9), null)
})

test('rankSkills puts the skills more listed jobs ask for first', () => {
  const counts = skillCounts([{ skills: ['Kafka', 'dbt'] }, { skills: ['kafka', 'Spark'] }, { skills: ['Kafka', 'Spark'] }, { skills: null }])
  assert.equal(counts.get('kafka'), 3)
  assert.deepEqual(rankSkills(['dbt', 'Spark', 'Go', 'Kafka'], counts), ['Kafka', 'Spark', 'dbt', 'Go'])
  assert.deepEqual(rankSkills(['dbt', 'Go'], new Map()), ['dbt', 'Go'])
  const split = skillsSplit({ skills: ['Python', 'dbt', 'Kafka'] }, { skills: ['Python'] }, 3, counts)
  assert.deepEqual(split.missing, ['Kafka', 'dbt'])
  assert.equal(split.missingLine, 'Also asks for (not scored): Kafka, dbt')
})
