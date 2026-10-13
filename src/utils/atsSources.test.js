// The add-company form's parsers give the same columns as the scrapers' source_columns(): both read
// databricks/tests/ats/fixtures/<type>/url_cases.json (expect null = rejected).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { ATS_FIELDS, ATS_TYPES, describeSource, greenhouseBoardToken, parseAtsSource, sourceKey, sourceValue } from './atsSources.js'
import { SCRAPE_SOURCES } from './sources.js'

const FIXTURES = new URL('../../databricks/tests/ats/fixtures/', import.meta.url)
const BOARD_TYPES = ['lever', 'ashby', 'smartrecruiters', 'workable', 'oracle', 'successfactors', 'darwinbox', 'keka']

function cases(type) {
  const file = new URL(`${type}/url_cases.json`, FIXTURES)
  assert.ok(fs.existsSync(file), `${type}/url_cases.json is missing`)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(doc.cases) && doc.cases.length > 0, `${type}/url_cases.json has no cases`)
  return doc.cases
}

test('the form offers every scrape source, LinkedIn last', () => {
  assert.deepEqual([...ATS_TYPES].sort(), [...SCRAPE_SOURCES].sort())
  assert.equal(ATS_TYPES.at(-1), 'linkedin')
  for (const type of ATS_TYPES) {
    const field = ATS_FIELDS[type]
    for (const key of ['label', 'placeholder', 'help', 'type', 'error']) assert.ok(field[key], `${type}.${key}`)
    // the placeholder is an accepted value
    assert.ok(!parseAtsSource(type, field.placeholder).error || type === 'linkedin', `${type} placeholder`)
  }
  assert.match(ATS_FIELDS.linkedin.help, /Only searched when the LinkedIn workflow is run by hand/)
  assert.equal(ATS_FIELDS.lever.label, 'Lever careers / board link')
  assert.equal(parseAtsSource('phenom', 'x'), null)
})

for (const type of BOARD_TYPES) {
  test(`${type}: url_cases.json`, () => {
    for (const { input, expect } of cases(type)) {
      const got = parseAtsSource(type, input)
      if (expect === null) {
        assert.equal(typeof got?.error, 'string', `${type} ${JSON.stringify(input)} should be rejected, got ${JSON.stringify(got)}`)
        continue
      }
      assert.deepEqual(got, expect, `${type} ${JSON.stringify(input)}`)
      // what the form stores reads back to the same columns (the edit field shows api_url || slug)
      assert.deepEqual(parseAtsSource(type, expect.api_url), expect, `${type} round trip of ${expect.api_url}`)
      assert.deepEqual(parseAtsSource(type, sourceValue({ ats_type: type, ...expect })), expect, `${type} sourceValue`)
      // a pasted link and the stored row are the same board
      assert.equal(sourceKey({ ats_type: type, ...got }), sourceKey({ ats_type: type, ...expect }))
      assert.ok(sourceKey({ ats_type: type, ...expect }), `${type} key of ${input}`)
      assert.ok(describeSource(type, got), `${type} description of ${input}`)
    }
  })
}

test('rejections say what to paste', () => {
  assert.match(parseAtsSource('lever', 'https://paytm.com/careers').error, /Paste the Lever careers \/ board link, e\.g\. https:\/\/jobs\.lever\.co\/paytm/)
  assert.match(parseAtsSource('smartrecruiters', 'https://careers.servicenow.com/jobs/744000154629109').error, /jobs\.smartrecruiters\.com link/)
  assert.match(parseAtsSource('workable', 'https://jobs.workable.com/view/abc123/engineer').error, /apply\.workable\.com link/)
  assert.match(parseAtsSource('successfactors', 'https://career44.sapsf.com/career?company=birlasoftl').error, /company's own careers site/)
  assert.match(parseAtsSource('oracle', 'http://careers.honeywell.com/en/sites/Honeywell').error, /https:\/\//)
  assert.match(parseAtsSource('keka', '').error, /Keka careers \/ board link/)
})

test('dedupe keys: case and link form do not make a second row', () => {
  const key = (type, value) => sourceKey({ ats_type: type, ...parseAtsSource(type, value) })
  assert.equal(key('ashby', 'https://jobs.ashbyhq.com/Sarvam'), key('ashby', 'sarvam'))
  assert.equal(key('smartrecruiters', 'https://careers.smartrecruiters.com/servicenow'), key('smartrecruiters', 'ServiceNow'))
  assert.equal(key('workable', 'https://apply.workable.com/smartstream/j/ABCD1234/'), key('workable', 'smartstream'))
  assert.equal(key('successfactors', 'https://jobs.cargill.com/search/?q='), key('successfactors', 'Jobs.Cargill.com'))
  assert.equal(key('keka', 'https://hr.keka.com/careers/jobdetails/1'), key('keka', 'hr'))
  assert.notEqual(key('keka', 'https://acme.keka.com/careers/campus/'), key('keka', 'acme'))
  assert.notEqual(key('darwinbox', 'https://acme.darwinbox.in/ms/candidatev2/a1/careers'), key('darwinbox', 'acme.darwinbox.in'))
  assert.equal(key('oracle', 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/1'),
    key('oracle', 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/fr/sites/cx_1001/requisitions'))
  // a stored row whose slug holds the board and api_url is empty (an older row)
  assert.equal(sourceKey({ ats_type: 'lever', slug: 'paytm', api_url: null }), 'paytm')
})

test('Greenhouse, Workday and LinkedIn keep their rules', () => {
  assert.deepEqual(parseAtsSource('greenhouse', 'https://job-boards.greenhouse.io/stripe/jobs/123'),
    { slug: 'stripe', api_url: 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs' })
  assert.equal(greenhouseBoardToken('https://boards.greenhouse.io/embed/job_board?for=acme'), 'acme')
  assert.ok(parseAtsSource('greenhouse', 'https://example.com/x').error)
  assert.deepEqual(parseAtsSource('workday', ' https://acme.wd1.myworkdayjobs.com/en-US/Careers '),
    { api_url: 'https://acme.wd1.myworkdayjobs.com/en-US/Careers' })
  assert.ok(parseAtsSource('workday', 'http://acme.wd1.myworkdayjobs.com/x').error)
  assert.deepEqual(parseAtsSource('linkedin', 'Databricks'), { api_url: 'Databricks' })
  assert.equal(parseAtsSource('linkedin', 'x').error, 'Search keywords: 2 to 100 characters')
  assert.equal(sourceValue({ ats_type: 'greenhouse', slug: 'stripe', api_url: 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs' }), 'stripe')
  assert.equal(sourceKey({ ats_type: 'greenhouse', slug: 'Stripe' }), sourceKey({ ats_type: 'greenhouse', api_url: 'https://job-boards.greenhouse.io/stripe' }))
})

test('describeSource names what the scraper reads', () => {
  assert.equal(describeSource('lever', parseAtsSource('lever', 'https://jobs.eu.lever.co/mistral')), 'Lever site “mistral” (EU)')
  assert.equal(describeSource('workable', parseAtsSource('workable', 'https://apply.workable.com/j/58DF5D1CD5')),
    'Workable job link: the scraper looks up its account when it runs')
  assert.equal(describeSource('oracle', parseAtsSource('oracle', 'https://careers.honeywell.com/en/sites/Honeywell')),
    'Career page on careers.honeywell.com: the scraper finds the Oracle site on it when it runs')
  assert.equal(describeSource('keka', parseAtsSource('keka', 'https://acme.keka.com/careers/campus/')), 'Keka company “acme”, portal campus')
  assert.equal(describeSource('lever', { error: 'x' }), '')
})
