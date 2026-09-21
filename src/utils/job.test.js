import test from 'node:test'
import assert from 'node:assert/strict'

import { getMatchedSkills } from './job.js'

test('getMatchedSkills matches whole-skill phrases without broad substring false positives', () => {
  const job = {
    title: 'Senior Java Developer',
    department: 'Platform',
    skills: ['Java', 'Spring Boot', 'AWS'],
  }

  const userSkills = ['java', 'javascript', 'spring boot']

  assert.deepEqual(getMatchedSkills(job, userSkills), ['java', 'spring boot'])
})

test('getMatchedSkills matches title keywords as whole words', () => {
  const job = {
    title: 'Full Stack Engineer',
    department: 'Product',
    skills: ['TypeScript'],
  }

  assert.deepEqual(getMatchedSkills(job, ['full stack', 'typescript']), ['full stack', 'typescript'])
})
