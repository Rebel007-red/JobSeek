import test from 'node:test'
import assert from 'node:assert/strict'

import { fitReasons, notForYouReasons, notForYouText, skillsSplit, skillsTag, standardRoleLabel } from './fit.js'

const profile = { target_roles: ['Data Engineer'], skills: ['Python', 'Spark', 'SQL', 'AWS', 'Airflow'], also_skills: ['Kafka'], min_years: 2, max_years: 4 }

test('fitReasons explains each bar', () => {
  const job = {
    fit_role_reason: 'related', fit_role_sim: 0.8312, fit_core_matched: 4, fit_matched_skills: ['Python', 'Spark', 'SQL', 'AWS', 'Kafka'],
    job_skills_known: true, fit_exp_years: 5, experience_min_years: null, experience_level: 'Senior',
  }
  assert.deepEqual(fitReasons(job, profile), {
    fit_role: 'Close to your roles (similarity 0.83)',
    fit_skills: '4 of your 5 core skills, plus 1 you also know',
    fit_experience: 'Asks 5+ years (Senior level), your range 2–4',
  })
  assert.equal(fitReasons({ fit_role_reason: 'first_role' }, profile).fit_role, 'Your first role')
  assert.equal(fitReasons({ fit_role_reason: 'second_role' }, profile).fit_role, 'Your second role')
  assert.equal(fitReasons({ fit_role_reason: 'title' }, profile).fit_role, 'The title names your role')
  assert.equal(fitReasons({ fit_role_reason: 'alternative' }, profile).fit_role, 'Related role')
  assert.equal(fitReasons({ fit_role_reason: 'category' }, profile).fit_role, 'Same category as your roles')
  assert.equal(fitReasons({ fit_role_reason: 'none' }, profile).fit_role, 'Not one of your roles')
  assert.equal(fitReasons({}, profile).fit_role, null)
  assert.equal(fitReasons({ job_skills_known: false }, profile).fit_skills, 'No skills found in this posting (counted as 30%)')
  assert.equal(fitReasons({}, { skills: [] }).fit_skills, 'Add skills to your profile')
  assert.equal(fitReasons({ fit_exp_years: null }, profile).fit_experience, 'Experience not stated (counted as 70%)')
  assert.equal(fitReasons({ fit_exp_years: 3, experience_min_years: 3 }, profile).fit_experience, 'Within your range')
  // below the range only when the top of the asked range (stated maximum, else minimum + 3) is under your minimum,
  // as the experience score counts it
  assert.equal(fitReasons({ fit_exp_years: 1, experience_min_years: 1 }, profile).fit_experience, 'Within your range')
  assert.equal(fitReasons({ fit_exp_years: 0, experience_min_years: 0, experience_max_years: 1 }, profile).fit_experience,
    'Asks 0–1 years, below your range 2–4')
  assert.equal(fitReasons({ fit_exp_years: 6, experience_min_years: 6, experience_max_years: 9 }, profile).fit_experience,
    'Asks 6–9 years, your range 2–4')
  assert.equal(fitReasons({ fit_exp_years: 0, experience_min_years: null, experience_level: 'Entry' }, { min_years: 5, max_years: 8, skills: ['Go'] }).fit_experience,
    'Asks 0+ years (Entry level), below your range 5–8')
})

test('notForYouReasons lists every rule that leaves a job out', () => {
  const job = { in_for_you: false, role_match: false, fit_score: 52, above_experience: true, fit_exp_years: 8 }
  assert.deepEqual(notForYouReasons(job, profile), [
    'the role is not close enough to yours',
    'the fit is 52, under 60',
    'it asks 8+ years, more than 2 above your maximum of 4',
  ])
  assert.equal(notForYouText({ in_for_you: false, role_match: true, fit_score: 40 }, profile), 'Not in For you because the fit is 40, under 60')
  assert.deepEqual(notForYouReasons({ in_for_you: true, role_match: false }, profile), [])
  // tracked jobs are always For you
  assert.deepEqual(notForYouReasons({ role_match: false, fit_score: 10, application_status: 'saved' }, profile), [])
  // rows without in_for_you fall back to the same rule
  assert.deepEqual(notForYouReasons({ role_match: true, fit_score: 75, above_experience: false }, profile), [])
  assert.equal(notForYouText({ role_match: true, fit_score: 75 }, profile), null)
})

test('skillsTag and skillsSplit', () => {
  assert.deepEqual(skillsTag({ job_skills_known: false }, profile), { label: 'skills ?', title: 'No skills found in this posting; counted as neutral' })
  assert.deepEqual(skillsTag({ job_skills_known: true, fit_core_matched: 3, fit_matched_skills: ['Python', 'Spark', 'SQL', 'Kafka'] }, profile), {
    label: '3/5 skills +1', title: 'Matched: Python, Spark, SQL, Kafka',
  })
  assert.equal(skillsTag({}, { skills: [] }), null)
  const split = skillsSplit({ skills: ['python', 'Kafka', 'Go', 'Rust', 'Scala', 'Java'], fit_matched_skills: ['Python'] }, profile)
  assert.deepEqual(split.have, ['python', 'Kafka'])
  assert.deepEqual(split.missing, ['Go', 'Rust', 'Scala', 'Java'])
  assert.equal(split.missingLine, 'Missing: Go, Rust, Scala')
  assert.equal(skillsSplit({ skills: ['Python'] }, profile).missingLine, null)
})

test('standardRoleLabel', () => {
  assert.equal(standardRoleLabel('Data Engineer', 0.861), 'Data Engineer (role confidence 86%)')
  assert.equal(standardRoleLabel('Data Engineer', null), 'Data Engineer')
  assert.equal(standardRoleLabel(null, 0.9), null)
})
