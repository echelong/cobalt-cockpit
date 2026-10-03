// The authentication diagnostic on its own: what is claimed for which facts,
// and that a value can never ride along with a name.

import { describe, expect, test } from 'claude-code/testing'

import { API_ENV, API_REFUSAL, authLines, authOf, authRows, settingsSources } from '../hooks/auth'
import { EMPTY_POLICY } from '../hooks/policy'
import type { Row } from '../hooks/view'

const COLORS = { ok: 'success', bad: 'error', warn: 'warning' }
const textOf = (rows: Row[]): string => rows.map(row => row.map(one => one.text).join('')).join('\n')

describe('the reading', () => {
  test('a sign-in credential and nothing API-shaped is the subscription', () => {
    const auth = authOf('bearer', [], 1000)
    expect(auth).toEqual({ mode: 'subscription', credential: 'bearer', sources: [], at: 1000 })
    expect(authLines(auth)).toEqual(['AUTH / SUBSCRIPTION', 'API BILLING / OFF', 'FABLE / BLOCKED'])
  })

  test('an API key held by the engine is API authentication', () => {
    const auth = authOf('api-key', [], 0)
    expect(auth.mode).toBe('api')
    expect(authLines(auth)).toEqual(['AUTH / API DETECTED', 'FABLE / BLOCKED'])
  })

  for (const name of API_ENV) {
    test(`${name} present is API authentication, even beside a sign-in`, () => {
      const auth = authOf('bearer', [`env ${name}`], 0)
      expect(auth.mode).toBe('api')
      expect(auth.sources).toEqual([`env ${name}`])
      // billing is never called off while an API route is configured
      expect(authLines(auth).join(' ')).not.toContain('API BILLING / OFF')
      expect(authLines(auth)[0]).toBe('AUTH / API DETECTED')
    })
  }

  test('an engine that says nothing is unverified, and nothing is claimed', () => {
    for (const credential of ['unknown', 'none'] as const) {
      const auth = authOf(credential, [], 0)
      expect(auth.mode).toBe('unverified')
      expect(authLines(auth)).toEqual(['AUTH / UNVERIFIED', 'FABLE / BLOCKED'])
      expect(authLines(auth).join(' ')).not.toContain('SUBSCRIPTION')
      expect(authLines(auth).join(' ')).not.toContain('OFF')
    }
  })

  test('before the first reading there is nothing to say', () => {
    expect(authLines(null)).toEqual([])
  })

  test('usage is never priced: no dollar figure and no token claim', () => {
    for (const auth of [authOf('bearer', [], 0), authOf('api-key', ['env ANTHROPIC_API_KEY'], 0), authOf('unknown', [], 0)]) {
      const said = [...authLines(auth), textOf(authRows(auth, EMPTY_POLICY, COLORS))].join('\n')
      expect(said).not.toMatch(/\$|tokens?|free|cost/i)
    }
  })
})

describe('secrets', () => {
  const SECRET = 'sk-ant-synthetic'

  test('a source is a name from a fixed table; anything else is dropped', () => {
    const auth = authOf('bearer', ['env ANTHROPIC_API_KEY', `env ANTHROPIC_API_KEY=${SECRET}`, SECRET, 'env SOMETHING_ELSE', 'settings apiKeyHelper'], 0)
    expect(auth.sources).toEqual(['env ANTHROPIC_API_KEY', 'settings apiKeyHelper'])
    expect(JSON.stringify(auth)).not.toContain(SECRET)
  })

  test('settings are read for presence: the helper command and the key never come back', () => {
    const found = settingsSources({
      apiKeyHelper: `/usr/local/bin/print-key --token ${SECRET}`,
      env: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: `https://gateway.example/${SECRET}`, UNRELATED: 'x' },
    })
    expect(found).toEqual(['settings apiKeyHelper', 'settings env ANTHROPIC_API_KEY', 'settings env ANTHROPIC_BASE_URL'])
    expect(found.join(' ')).not.toContain(SECRET)
    expect(found.join(' ')).not.toContain('print-key')
    expect(found.join(' ')).not.toContain('gateway.example')
  })

  test('settings with nothing API-shaped name nothing', () => {
    expect(settingsSources({})).toEqual([])
    expect(settingsSources({ model: 'opus', env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }, apiKeyHelper: '' })).toEqual([])
    expect(settingsSources({ env: null })).toEqual([])
    expect(settingsSources({ env: ['ANTHROPIC_API_KEY'] })).toEqual([])
  })

  test('the detailed rows name where it was found and show no value', () => {
    const auth = authOf('api-key', ['env ANTHROPIC_API_KEY', 'settings apiKeyHelper'], 0)
    const said = textOf(authRows(auth, EMPTY_POLICY, COLORS))
    expect(said).toContain('API DETECTED')
    expect(said).toContain('env ANTHROPIC_API_KEY is set')
    expect(said).toContain('settings apiKeyHelper is set')
    expect(said).toContain('not established as off')
    expect(said).not.toContain('sk-')
    expect(said).not.toMatch(/API billing\s+OFF/)
  })

  test('the refusal names no value either', () => {
    expect(API_REFUSAL.startsWith('AUTH / API DETECTED')).toBe(true)
    expect(API_REFUSAL).not.toContain('sk-')
  })
})

describe('the Fable diagnostics', () => {
  test('policy and counted calls, under the subscription reading', () => {
    const said = textOf(authRows(authOf('bearer', [], 0), EMPTY_POLICY, COLORS))
    expect(said).toMatch(/Auth\s+SUBSCRIPTION/)
    expect(said).toMatch(/API billing\s+OFF/)
    expect(said).toContain('FABLE')
    expect(said).toMatch(/Policy\s+BLOCKED/)
    expect(said).toMatch(/Calls\s+0/)
    expect(said).not.toContain('Refused')
  })

  test('refusals and calls are the numbers held, not constants', () => {
    const rows = authRows(authOf('bearer', [], 0), { blocks: 3, calls: 2, lastBlockAt: 5 }, COLORS)
    expect(textOf(rows)).toMatch(/Calls\s+2/)
    expect(textOf(rows)).toMatch(/Refused\s+3/)
    // a call that got through is drawn as a failure, not as reassurance
    const calls = rows.find(row => row.some(one => one.text.includes('Calls')))
    expect(calls?.some(one => one.color === 'error')).toBe(true)
  })
})
