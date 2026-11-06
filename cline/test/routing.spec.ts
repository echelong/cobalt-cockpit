import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { routeTask, nextStep } from '../src/router.ts'
import type { RouteInput, TaskSpec } from '../src/router.ts'
import { DEFAULT_CONFIG_FILE } from '../src/config.ts'
import { planReasoning } from '../src/reasoning.ts'
import { config, resolutions, shippedConfig, task } from './helpers.ts'

const NO_HISTORY = { attempts: 0, gateFailures: 0, escalated: false, lastFailure: null }
const route = async (t: Partial<TaskSpec>, over: Partial<RouteInput> = {}, c = config()) => routeTask({ task: task('t', t), history: NO_HISTORY, config: c, resolutions: await resolutions(c), health: {}, spentSessionUsd: 0, ...over })

describe('shipped defaults cannot drift silently', () => {
  test('the shipped profile, coder model, reasoning and strictness are exactly the mandated ones', () => {
    const raw = JSON.parse(readFileSync(DEFAULT_CONFIG_FILE, 'utf8'))
    assert.equal(raw.profile, 'cline', 'Cline billing is the default profile')
    assert.equal(raw.strict, true)
    assert.deepEqual(raw.profiles.cline.roles.coder, { provider: 'cline', model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: 'xhigh', requireName: '1017' })
    assert.deepEqual(raw.profiles['cline-pass'].roles.coder, { provider: 'cline-pass', model: 'cline-pass/deepseek-v4.1-flash-1017', reasoning: 'xhigh', requireName: '1017' })
    assert.equal(raw.profiles.cline.roles.commander.model, 'moonshotai/kimi-k3.1-pro')
    assert.equal(raw.profiles.cline.roles.specialist.model, 'xiaomi/mimo-v2.6-pro')
    assert.equal(raw.profiles.cline.roles.frontend.model, 'qwen/qwen3.8-max-0902')
    assert.equal(raw.profiles.cline.roles.utility.model, 'zai/glm-5.3-flash')
    assert.equal(raw.escalation.coder, 'commander', 'DeepSeek escalates to Kimi')
    assert.equal(raw.limits.maxEscalationsPerTask, 1)
    assert.equal(raw.limits.concurrency.total, 6)
    assert.equal(raw.limits.maxTasksPerMission, null, 'no arbitrary project-wide agent cap')
  })
  test('default implementation work goes to DeepSeek 1017 with XHIGH requested and MAX expected on the wire', async () => {
    const r = await route({}, {}, shippedConfig())
    assert.equal(r.ok, true)
    assert.equal(r.role, 'coder'); assert.equal(r.provider, 'cline'); assert.equal(r.model, 'deepseek/deepseek-v4.1-flash-1017')
    assert.equal(r.requestedReasoning, 'xhigh'); assert.equal(r.cliThinking, 'xhigh'); assert.equal(r.expectedWireEffort, 'max'); assert.equal(r.reasoningMapping, 'xhigh->max')
  })
  test('switching to ClinePass changes provider and ids only, never the coder checkpoint or reasoning', async () => {
    const c = config({ profile: 'cline-pass' })
    const r = await route({}, {}, c)
    assert.equal(r.provider, 'cline-pass'); assert.equal(r.model, 'cline-pass/deepseek-v4.1-flash-1017'); assert.equal(r.expectedWireEffort, 'max')
  })
  test('routing is deterministic: same input, same decision and digest', async () => {
    const a = await route({ kind: 'debug', complexity: 3 }); const b = await route({ kind: 'debug', complexity: 3 })
    assert.deepEqual(a, b)
  })
})

describe('role rules', () => {
  const cases: [string, Partial<TaskSpec>, string][] = [
    ['architecture -> commander', { kind: 'architecture', risk: 'low', complexity: 2 }, 'commander'],
    ['critical review -> commander', { kind: 'review', risk: 'high', mode: 'read' }, 'commander'],
    ['security review -> commander', { kind: 'review', risk: 'low', mode: 'read', prompt: 'review the auth token handling for injection' }, 'commander'],
    ['critical debugging -> commander', { kind: 'debug', risk: 'critical' }, 'commander'],
    ['independent review -> specialist', { kind: 'review', risk: 'medium', mode: 'read' }, 'specialist'],
    ['non-trivial debugging -> specialist', { kind: 'debug', complexity: 3 }, 'specialist'],
    ['flaky debugging wording -> specialist', { kind: 'debug', complexity: 2, prompt: 'the test is flaky and fails intermittently' }, 'specialist'],
    ['advanced engineering -> specialist', { kind: 'implement', complexity: 4 }, 'specialist'],
    ['frontend kind -> frontend', { kind: 'frontend' }, 'frontend'],
    ['UI wording on implementation -> frontend', { kind: 'implement', prompt: 'build the responsive React component for the settings page' }, 'frontend'],
    ['long context -> frontend', { kind: 'implement', contextTokens: 600_000 }, 'frontend'],
    ['low-risk read-only scouting -> utility', { kind: 'scout', risk: 'low', complexity: 1, mode: 'read' }, 'utility'],
    ['narrow docs edit -> utility', { kind: 'docs', risk: 'low', complexity: 1, mode: 'write', owned: ['/docs/a.md'] }, 'utility'],
    ['simple debug -> coder', { kind: 'debug', complexity: 2 }, 'coder'],
    ['tests -> coder', { kind: 'test' }, 'coder'],
  ]
  for (const [name, t, want] of cases) test(name, async () => { const r = await route(t); assert.equal(r.ok, true, r.refusal ?? ''); assert.equal(r.role, want, r.rules.join(' | ')) })

  test('DeepSeek is never replaced for cost: cheap-looking implementation stays on the coder', async () => {
    for (const complexity of [1, 2, 3]) for (const risk of ['low', 'medium', 'high'] as const) {
      const r = await route({ kind: 'implement', complexity, risk, mode: 'write' })
      assert.equal(r.role, 'coder', `${risk}/${complexity}`)
    }
  })
  test('utility never takes medium+ risk; the guard moves it up to the coder', async () => {
    const r = await route({ kind: 'scout', risk: 'medium', complexity: 1, mode: 'read' })
    assert.equal(r.role, 'coder')
  })
  test('security wording raises risk; a security docs edit cannot go to utility', async () => {
    const r = await route({ kind: 'docs', risk: 'low', complexity: 1, mode: 'write', owned: ['/docs/a.md'], prompt: 'document the credential and secret rotation' })
    assert.equal(r.effectiveRisk, 'high'); assert.equal(r.role, 'coder')
  })
  test('every decision records fired rules and rejected alternatives with reasons', async () => {
    const r = await route({ kind: 'review', risk: 'medium', mode: 'read' })
    assert.ok(r.rules.length >= 1)
    assert.equal(r.rejected.length, 4)
    for (const x of r.rejected) assert.ok(x.why.length > 10)
  })
})

describe('fail-closed refusals', () => {
  test('an unhealthy provider refuses the route; no other model is substituted', async () => {
    const r = await route({}, { health: { 'cline/deepseek/deepseek-v4.1-flash-1017': { consecutiveErrors: 2, unhealthy: true, until: Date.now() + 60_000 } } })
    assert.equal(r.ok, false); assert.match(r.refusal ?? '', /no substitute model/)
    assert.equal(r.model, 'deepseek/deepseek-v4.1-flash-1017')
    // an unhealthy entry without a cool-down end (older state) is half-open: one try, not a permanent block
    const legacy = await route({}, { health: { 'cline/deepseek/deepseek-v4.1-flash-1017': { consecutiveErrors: 2, unhealthy: true } } })
    assert.equal(legacy.ok, true); assert.equal(legacy.model, 'deepseek/deepseek-v4.1-flash-1017')
  })
  test('an estimate over the remaining session budget refuses', async () => {
    const r = await route({}, { spentSessionUsd: 2.99 })
    assert.equal(r.ok, false); assert.match(r.refusal ?? '', /budget/)
  })
  test('unmetered session usage refuses new routes', async () => {
    const r = await route({}, { spentSessionUsd: null })
    assert.equal(r.ok, false); assert.match(r.refusal ?? '', /unmetered/)
  })
  test('an unresolved role refuses rather than substituting another role', async () => {
    const c = config({ profiles: { cline: { roles: { frontend: { provider: 'cline', model: 'qwen/qwen-nonexistent-9999', reasoning: 'xhigh' } } } } })
    const r = await route({ kind: 'frontend' }, {}, c)
    assert.equal(r.ok, false); assert.equal(r.role, 'frontend'); assert.match(r.refusal ?? '', /not in provider/)
  })
  test('an unsupported reasoning level is refused, never downgraded', async () => {
    const c = config({ profiles: { cline: { roles: { coder: { provider: 'cline', model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: 'medium', requireName: '1017' } } } } })
    const r = await route({}, {}, c)
    assert.equal(r.ok, false); assert.match(r.refusal ?? '', /not supported.*refusing rather than downgrading/)
  })
  test('attempt limit refuses further attempts (4 by default: try, correction, escalation, one spare)', async () => {
    assert.equal((await route({}, { history: { attempts: 3, gateFailures: 0, escalated: false, lastFailure: null } })).ok, true)
    const r = await route({}, { history: { attempts: 4, gateFailures: 0, escalated: false, lastFailure: null } })
    assert.equal(r.ok, false); assert.match(r.refusal ?? '', /attempt limit/)
  })
})

describe('bounded escalation and retry', () => {
  const c = config()
  const h = (o = {}) => ({ attempts: 1, gateFailures: 0, escalated: false, lastFailure: null, transientRetries: 0, escalations: 0, ...o })
  test('gate failure with evidence: one correction on DeepSeek, then DeepSeek -> Kimi once', () => {
    assert.equal(nextStep('gate_failed', 'coder', h(), c, ['test failed: expected 2']).action, 'correct')
    const s = nextStep('gate_failed', 'coder', h({ attempts: 2, corrections: 1 }), c, ['test failed: expected 2'])
    assert.equal(s.action, 'escalate'); assert.equal(s.to, 'commander')
  })
  test('without evidence there is no correction or escalation', () => assert.equal(nextStep('gate_failed', 'coder', h(), c, []).action, 'stop'))
  test('a second escalation is refused', () => assert.equal(nextStep('gate_failed', 'coder', h({ escalations: 1, corrections: 1, attempts: 3 }), c, ['x']).action, 'stop'))
  test('the commander has no escalation target once its correction is used', () => assert.equal(nextStep('gate_failed', 'commander', h({ corrections: 1, attempts: 2 }), c, ['x']).action, 'stop'))
  test('provider error retries the same model twice with backoff, then stops', () => {
    const first = nextStep('provider_error', 'coder', h(), c, [])
    assert.equal(first.action, 'retry_same'); assert.ok((first.delayMs ?? 0) > 0)
    assert.equal(nextStep('provider_error', 'coder', h({ transientRetries: 1, attempts: 2 }), c, []).action, 'retry_same')
    assert.equal(nextStep('provider_error', 'coder', h({ transientRetries: 2, attempts: 3 }), c, []).action, 'stop')
  })
  for (const cls of ['budget_exceeded', 'policy_abort', 'wire_mismatch', 'model_mismatch', 'sandbox_error'] as const) test(`${cls} is never retried or escalated`, () => assert.equal(nextStep(cls, 'coder', h(), c, ['x']).action, 'stop'))
  test('the attempt limit stops everything', () => assert.equal(nextStep('provider_error', 'coder', h({ attempts: 4 }), c, []).action, 'stop'))
})

describe('capability-checked reasoning', () => {
  test('xhigh on none|low|high|max maps to max', () => { const p = planReasoning('xhigh', ['none', 'low', 'high', 'max']); assert.ok(p.ok && p.expectedWire === 'max' && p.mapping === 'xhigh->max') })
  test('xhigh where the model lists xhigh is exact (Qwen3.8 Max 0902)', () => { const p = planReasoning('xhigh', ['minimal', 'low', 'medium', 'high', 'xhigh']); assert.ok(p.ok && p.expectedWire === 'xhigh' && p.mapping === 'exact') })
  test('medium on low|high|max is refused', () => assert.equal(planReasoning('medium', ['low', 'high', 'max']).ok, false))
  test('xhigh without max or xhigh is refused', () => assert.equal(planReasoning('xhigh', ['low', 'medium', 'high']).ok, false))
  test('toggle-only model: any level means thinking on, checked on the wire', () => { const p = planReasoning('high', [], true); assert.ok(p.ok && p.expectedWire === 'on' && p.mapping === 'toggle') })
})
