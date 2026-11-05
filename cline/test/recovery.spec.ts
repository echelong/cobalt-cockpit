// Phase 4-6: automatic, bounded failure recovery and the lifecycle/outcome status split.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { backoffMs, classifyFailureText, nextStep } from '../src/router.ts'
import { statusOf } from '../src/status.ts'
import type { Live } from '../src/supervisor.ts'
import { byId, config, env, git, mission, task } from './helpers.ts'

const T = { timeout: 120_000 }
const fast = (over: unknown = {}) => config({ limits: { retryBaseMs: 50, retryMaxMs: 200 }, ...(over as object) })

describe('failure classification and policy', () => {
  test('error text is classified, not guessed', () => {
    assert.equal(classifyFailureText('Provider error: 503 upstream overloaded'), 'provider_error')
    assert.equal(classifyFailureText('429 Too Many Requests'), 'rate_limited')
    assert.equal(classifyFailureText('401 Unauthorized: invalid API key'), 'auth_error')
    assert.equal(classifyFailureText('insufficient credits'), 'auth_error')
    assert.equal(classifyFailureText('ENOSPC: no space left on device'), 'resource_error')
    assert.equal(classifyFailureText('the model wrote bad code'), null)
  })
  test('backoff is exponential, jittered and capped', () => {
    assert.equal(backoffMs(0, 1000, 30000, () => 0), 500); assert.equal(backoffMs(0, 1000, 30000, () => 1), 1000)
    assert.equal(backoffMs(3, 1000, 30000, () => 1), 8000); assert.equal(backoffMs(10, 1000, 30000, () => 1), 30000)
  })
  test('implementation failure ladder: correction on the same model, then escalation, then stop', () => {
    const c = config(); const h = { attempts: 1, gateFailures: 1, escalated: false, lastFailure: null, transientRetries: 0, escalations: 0, corrections: 0, kind: 'implement' as const }
    assert.equal(nextStep('gate_failed', 'coder', h, c, ['x']).action, 'correct')
    const esc = nextStep('gate_failed', 'coder', { ...h, attempts: 2, corrections: 1 }, c, ['x'])
    assert.deepEqual([esc.action, esc.to], ['escalate', 'commander'])
    const dbg = nextStep('gate_failed', 'coder', { ...h, attempts: 2, corrections: 1, kind: 'debug' }, c, ['x'])
    assert.deepEqual([dbg.action, dbg.to], ['escalate', 'specialist'], 'difficult debugging goes to MiMo')
    assert.equal(nextStep('gate_failed', 'commander', { ...h, attempts: 3, corrections: 1, escalations: 1 }, c, ['x']).action, 'stop')
  })
  test('authentication, budget and safety failures are never retried', () => {
    const h = { attempts: 1, gateFailures: 0, escalated: false, lastFailure: null, transientRetries: 0, escalations: 0 }
    for (const cls of ['auth_error', 'budget_exceeded', 'policy_abort', 'wire_mismatch', 'model_mismatch', 'sandbox_error'] as const) assert.equal(nextStep(cls, 'coder', h, config(), ['x']).action, 'stop', cls)
    assert.match(nextStep('auth_error', 'coder', h, config(), []).reason, /cline auth/)
  })
})

describe('automatic recovery through the supervisor', () => {
  test('a transient provider outage recovers after bounded, backed-off retries on the same model', T, async () => {
    const e = env(); const m = await mission(e, { config: fast(), tasks: [task('a', { prompt: '[[fail-times:2:503]] [[write:src/a/x=1]]' })] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    const as = byId(m, 'a').attempts
    assert.deepEqual(as.map(a => [a.model, a.failure]), [['deepseek/deepseek-v4.1-flash-1017', 'provider_error'], ['deepseek/deepseek-v4.1-flash-1017', 'provider_error'], ['deepseek/deepseek-v4.1-flash-1017', null]])
    const steps = [...m.ledger.entries()].filter(x => x.kind === 'next_step').map(x => x.data as { action: string; delayMs: number })
    assert.ok(steps.every(s => s.action === 'retry_same' && s.delayMs > 0), 'each retry waited')
  })
  test('a provider outage that persists ends FAILED with a clear reason after the retry budget', T, async () => {
    const e = env(); const m = await mission(e, { config: fast(), tasks: [task('a', { prompt: '[[fail-times:9:503]] [[write:src/a/x=1]]' })] })
    const v = await m.run()
    assert.equal(v.state, 'FAILED')
    assert.equal(byId(m, 'a').attempts.length, 3, 'one try plus two bounded retries')
    assert.match(byId(m, 'a').reason ?? '', /2 transient retries used; no model substitution/)
  })
  test('rate limiting is recognised and backed off; authentication failure stops at once with a sign-in instruction', T, async () => {
    const e = env(); const m = await mission(e, { config: fast(), tasks: [task('rl', { prompt: '[[fail-times:1:429]] [[write:src/rl/x=1]]' }), task('auth', { prompt: '[[fail-times:9:401]] [[write:src/auth/x=1]]' })] })
    await m.run()
    assert.deepEqual(byId(m, 'rl').attempts.map(a => a.failure), ['rate_limited', null])
    const auth = byId(m, 'auth')
    assert.equal(auth.attempts.length, 1); assert.equal(auth.attempts[0].failure, 'auth_error'); assert.match(auth.reason ?? '', /cline auth/)
  })
  test('dependents wait while a dependency recovers, then run once it is genuinely complete', T, async () => {
    const e = env(); const m = await mission(e, { config: fast(), tasks: [task('a', { prompt: '[[fail-times:1:503]] [[write:src/a/x=1]]' }), task('b', { dependencies: ['a'] })] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    const aEnd = Date.parse(byId(m, 'a').attempts.at(-1)?.endedAt as string); const bStart = Date.parse(byId(m, 'b').attempts[0].startedAt)
    assert.ok(bStart >= aEnd, 'b started only after a completed')
  })
  test('an implementation failure gets one correction on the same model with its diff and the gate output', T, async () => {
    const e = env()
    const m = await mission(e, { config: fast(), tasks: [task('a', { prompt: '[[write:src/a/x=wrong]] [[write-on-retry:src/a/x=right]] [[say:Changed it.]]' })], gates: [{ name: 'test', command: 'grep -q right src/a/x', required: true }] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    const as = byId(m, 'a').attempts
    assert.deepEqual(as.map(a => [a.role, a.failure]), [['coder', 'gate_failed'], ['coder', null]], 'corrected by DeepSeek itself')
    const { readFileSync } = await import('node:fs'); const { join } = await import('node:path')
    const prompt = readFileSync(join(m.dir, 'runs', 'a', '2', 'ro', 'prompt.txt'), 'utf8')
    assert.match(prompt, /did not pass Cockpit's verification/); assert.match(prompt, /Diff of the previous attempt/); assert.match(prompt, /\+wrong/)
    assert.equal(git(e.repo, 'show', `${m.live.integration.branch}:src/a/x`), 'right')
  })
  test('repeated implementation failure escalates once to Kimi, which is told to diagnose first; then it stops', T, async () => {
    const e = env()
    const m = await mission(e, { config: fast(), tasks: [task('a', { prompt: '[[write:src/a/x=wrong]] [[say:Changed it.]]' })], gates: [{ name: 'test', command: 'grep -q right src/a/x', required: true }] })
    const v = await m.run()
    assert.equal(v.state, 'FAILED')
    const as = byId(m, 'a').attempts
    assert.deepEqual(as.map(a => a.role), ['coder', 'coder', 'commander'])
    const { readFileSync } = await import('node:fs'); const { join } = await import('node:path')
    assert.match(readFileSync(join(m.dir, 'runs', 'a', '3', 'ro', 'prompt.txt'), 'utf8'), /First diagnose the root cause/)
  })
  test('difficult debugging escalates to MiMo, not Kimi', T, async () => {
    const e = env()
    const m = await mission(e, { config: fast(), tasks: [task('a', { kind: 'debug', complexity: 2, prompt: '[[write:src/a/x=wrong]] [[say:Changed it.]]' })], gates: [{ name: 'test', command: 'grep -q right src/a/x', required: true }] })
    await m.run()
    assert.deepEqual(byId(m, 'a').attempts.map(a => [a.role, a.model]), [['coder', 'deepseek/deepseek-v4.1-flash-1017'], ['coder', 'deepseek/deepseek-v4.1-flash-1017'], ['specialist', 'xiaomi/mimo-v2.6-pro']])
  })
  test('a safety refusal stays a refusal: no correction, no escalation', T, async () => {
    const e = env(); const m = await mission(e, { config: fast(), tasks: [task('a', { prompt: '[[write:README.md=pwn]]' })] })
    await m.run()
    assert.deepEqual(byId(m, 'a').attempts.map(a => a.failure), ['policy_abort'])
  })
  test('a missing pinned model is refused with the permitted routes, never substituted', T, async () => {
    const e = env(); const c = config({ profiles: { cline: { roles: { frontend: { provider: 'cline', model: 'qwen/qwen3.8-max-9999', reasoning: 'xhigh', requireName: '9999' } } } } })
    const m = await mission(e, { config: c, tasks: [task('ui', { kind: 'frontend' })] })
    await m.run()
    const ui = byId(m, 'ui')
    assert.equal(ui.attempts.length, 0)
    assert.match(ui.reason ?? '', /does not switch checkpoints by itself/); assert.match(ui.reason ?? '', /Permitted routes/); assert.match(ui.reason ?? '', /available: /)
  })
})

describe('lifecycle and outcome are separate', () => {
  const live = (o: Partial<Live>): Live => ({ tasks: {}, verdict: null, ...o } as Live)
  const t = (state: string, extra: Record<string, unknown> = {}) => ({ spec: task('x'), state, attempts: [], ...extra })
  test('finished with a PARTIAL verdict reads FINISHED · PARTIAL, never DONE', () => assert.equal(statusOf(live({ verdict: { state: 'PARTIAL', reasons: [], at: '' } })).label, 'FINISHED · PARTIAL'))
  test('only a DONE verdict reads FINISHED · VERIFIED', () => assert.equal(statusOf(live({ verdict: { state: 'DONE', reasons: [], at: '' } })).label, 'FINISHED · VERIFIED'))
  test('running, retrying, waiting and blocked are lifecycle states', () => {
    assert.match(statusOf(live({ tasks: { a: t('running', { attempts: [{ phase: 'running' }] }) } as never })).label, /^RUNNING 1/)
    assert.match(statusOf(live({ tasks: { a: t('queued', { retryAt: Date.now() + 60_000 }) } as never })).label, /^RETRYING 1/)
    assert.match(statusOf(live({ tasks: { a: t('queued') } as never })).label, /^WAITING 1/)
    assert.match(statusOf(live({ tasks: { a: t('held') } as never })).label, /^BLOCKED/)
  })
})
