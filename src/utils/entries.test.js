import test from 'node:test'
import assert from 'node:assert/strict'

import { MUTE_LIMITS, NOTE_MAX_LENGTH, PROFILE_LIMITS, alsoSkillProblem, muteRuleProblem } from './entries.js'

test('limits', () => {
  assert.equal(PROFILE_LIMITS.alsoSkills, 10)
  assert.equal(PROFILE_LIMITS.roles, 2)
  assert.equal(NOTE_MAX_LENGTH, 2000)
  assert.deepEqual(MUTE_LIMITS, { companies: 50, titleWords: 30 })
})

test('alsoSkillProblem refuses entries that are already core skills', () => {
  assert.equal(alsoSkillProblem('Kafka', ['Python']), '')
  assert.equal(alsoSkillProblem(' python ', ['Python']), 'Already a core skill')
  assert.equal(alsoSkillProblem('x', []), 'Too short')
  assert.match(alsoSkillProblem('teamwork', []), /too general/)
})

test('muteRuleProblem follows saveMuteRules', () => {
  assert.equal(muteRuleProblem('companies', 'Acme Corp'), '')
  assert.equal(muteRuleProblem('companies', 'A'), 'Too short')
  assert.equal(muteRuleProblem('companies', 'India Pvt Ltd'), 'Not a company name')
  assert.equal(muteRuleProblem('companies', 'x'.repeat(101)), 'At most 100 characters')
  assert.equal(muteRuleProblem('titleWords', 'Sales'), '')
  assert.equal(muteRuleProblem('titleWords', 'C++'), '')
  assert.equal(muteRuleProblem('titleWords', 'a'), 'Too short')
  assert.equal(muteRuleProblem('titleWords', '(intern)'), 'Use letters, numbers, spaces and . + # & / - only')
  assert.equal(muteRuleProblem('titleWords', 'x'.repeat(41)), 'At most 40 characters')
})
