// Regression tests for the round-3 independent review (recovery engine and interactive shell).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { statusOf } from '../src/status.ts'
import type { Live } from '../src/supervisor.ts'
import { Mission } from '../src/supervisor.ts'
import { routeTask } from '../src/router.ts'
import { allTasks, byId, config, deps, env, git, mission, resolutions, task } from './helpers.ts'

const T = { timeout: 120_000 }
const fast = (over: Record<string, unknown> = {}) => config({ limits: { retryBaseMs: 50, retryMaxMs: 300, ...(over.limits as object ?? {}) }, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'limits')) })

describe('round 3: material', () => {
  test('M1: an open provider breaker is waited out, never turned into a refusal', T, async () => {
    const e = env(); const c = fast({ limits: { providerUnhealthyAfter: 1 } })
    const m = await mission(e, { config: c, tasks: [task('a', { prompt: '[[fail-times:1:503]] [[write:src/a/x=1]]' })] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    assert.equal(byId(m, 'a').attempts.length, 2)
    assert.equal([...m.ledger.entries()].some(x => x.kind === 'task_ended' && /provider health/.test(JSON.stringify(x.data))), false)
    // the retry is the breaker's half-open try: it never starts before the cool-down ends
    const opened = [...m.ledger.entries()].find(x => x.kind === 'provider_health' && (x.data as { unhealthy?: boolean }).unhealthy)?.data as { until: number }
    assert.ok(opened && Date.parse(byId(m, 'a').attempts[1].startedAt) >= opened.until, 'retry waited for the breaker')
    // deterministic: the router's real cool-down refusal, seen with nothing running, still clears by itself
    const r = routeTask({ task: task('x'), history: { attempts: 0, gateFailures: 0, escalated: false, lastFailure: null }, config: c, resolutions: await resolutions(c), health: { 'cline/deepseek/deepseek-v4.1-flash-1017': { consecutiveErrors: 1, unhealthy: true, until: Date.now() + 60_000 } }, spentSessionUsd: 0 })
    assert.equal(r.ok, false)
    assert.equal((m as unknown as { cannotClear(r: string): boolean }).cannotClear(`waiting: ${r.refusal}`), false)
  })
  test('M2: a stop from an earlier session (shell quit mid-turn) does not brick a conversation', T, async () => {
    const e = env(); const c = config()
    const m = await Mission.create({ stateRoot: e.root, repoDir: e.repo, goal: 'conversation', config: c, resolutions: await resolutions(c), deps: deps(e), gates: [], clineVersion: 'fixture', conversation: true })
    m.requestStop('shell exit')
    await m.run()
    const again = Mission.open(e.root, m.header.id, c, await resolutions(c), deps(e))
    again.addTask(task('t2', { allowNoChanges: true }), 'turn')
    await again.run()
    assert.equal(byId(again, 't2').state, 'completed', byId(again, 't2').reason ?? '')
    assert.ok([...again.ledger.entries()].some(x => x.kind === 'stop_cleared'))
  })
  test('M3: a new run never shows the previous run\'s verdict; finalizing reads VERIFYING', T, async () => {
    const e = env(); const seen: string[] = []
    const m = await mission(e, { tasks: [task('a')], deps: { onEvent: () => { seen.push(statusOf(m.live).lifecycle) } } })
    await m.run()
    m.addTask(task('b'), 'next'); seen.length = 0
    await m.run()
    assert.ok(seen.length > 0); assert.equal(seen.includes('FINISHED'), false, `lifecycles seen during run 2: ${[...new Set(seen)].join(',')}`)
    assert.equal(statusOf({ tasks: {}, verdict: null, state: 'finalizing' } as unknown as Live).lifecycle, 'VERIFYING')
    assert.equal(statusOf({ tasks: { x: { spec: task('x'), state: 'verifying', attempts: [] } }, verdict: null, state: 'running' } as unknown as Live).lifecycle, 'VERIFYING')
  })
})

describe('round 3: should-fix', () => {
  const outcome = (over: Record<string, unknown>) => async (spec: { model: string }) => ({ identity: null, exitCode: null, signal: null, stoppedBy: 'timeout' as const, stopDetail: 'no completion', hookRefusals: [], observerError: null, census: { state: 'gone' as const, pids: [], detail: 'x' }, wire: { state: 'confirmed' as const, requests: 1, effective: 'max', models: [spec.model], detail: 'x' }, facts: { usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: 0.0001 }, usageEvents: 1, toolCalls: {}, iterations: 1, finishReason: null, aborted: null, resultText: null, reportedModel: spec.model, reportedProvider: 'cline', agentErrors: 0, lines: 3, badLines: 0, sessionIds: [], firstEventAt: null, lastEventAt: null }, ...over })
  test('S4: a timeout never masks a policy refusal or a wire downgrade (both stay final)', T, async () => {
    for (const [over, want] of [[{ hookRefusals: [{ tool: 'editor', reason: 'outside ownership' }] }, 'policy_abort'], [{ wire: { state: 'mismatch', requests: 1, effective: 'high', models: [], detail: '1 request sent high instead of max' } }, 'wire_mismatch']] as const) {
      const e = env(); const m = await mission(e, { tasks: [task('a')], deps: { runWorker: outcome(over as Record<string, unknown>) as never } })
      await m.run()
      assert.deepEqual(byId(m, 'a').attempts.map(a => a.failure), [want])
    }
  })
  test('S5: a transient failure during a correction keeps the correction evidence for its retry', T, async () => {
    const e = env()
    const m = await mission(e, { config: fast(), tasks: [task('a', { prompt: '[[fail-on-correction:1]] [[write:src/a/x=wrong]] [[write-on-retry:src/a/x=right]] [[say:Changed it.]]' })], gates: [{ name: 'test', command: 'grep -q right src/a/x', required: true }] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    assert.deepEqual(byId(m, 'a').attempts.map(a => a.failure), ['gate_failed', 'provider_error', null])
    assert.match(readFileSync(join(m.dir, 'runs', 'a', '3', 'ro', 'prompt.txt'), 'utf8'), /Diff of the previous attempt[\s\S]*\+wrong/)
  })
  test('S7: a conversation keeps its repository marker between turns', T, async () => {
    const e = env(); const c = config()
    const m = await Mission.create({ stateRoot: e.root, repoDir: e.repo, goal: 'conversation', config: c, resolutions: await resolutions(c), deps: deps(e), gates: [], clineVersion: 'fixture', conversation: true })
    m.addTask(task('t1'), 'turn'); await m.run()
    assert.equal(existsSync(join(e.repo, '.git', 'cobalt-cockpit-cline', 'missions', `${m.header.id}.json`)), true)
  })
  test('S8: routing reads the task\'s own request, not the conversation context or the commander\'s design', async () => {
    const c = config(); const res = await resolutions(c)
    const r = routeTask({ task: task('t', { prompt: 'add a --verbose flag', context: 'earlier: we built the React component layout; security review pending' }), history: { attempts: 0, gateFailures: 0, escalated: false, lastFailure: null }, config: c, resolutions: res, health: {}, spentSessionUsd: 0 })
    assert.equal(r.role, 'coder'); assert.equal(r.effectiveRisk, 'medium')
    const e = env()
    const plan = JSON.stringify({ design: 'A component-based layout; review security of the token store.', tasks: [{ id: 'core', title: 'core', kind: 'implement', risk: 'medium', complexity: 3, mode: 'write', owned: ['src/core'], dependencies: [], prompt: '[[write:src/core/a.ts=x]] add the parser' }] })
    const m = await mission(e, { goal: `[[plan-b64:${Buffer.from(plan).toString('base64')}]] Redesign the architecture`, swarm: true })
    await m.run()
    assert.equal(byId(m, 'core').attempts[0].role, 'coder', 'the design text does not reroute planned work')
    assert.match(readFileSync(join(m.dir, 'runs', 'core', '1', 'ro', 'prompt.txt'), 'utf8'), /component-based layout/, 'the worker still gets the design')
  })
  test('S9: cancelling a task while it is being verified stops it before integration', T, async () => {
    const e = env(); let m!: Mission
    m = await mission(e, { tasks: [task('a')], gates: [{ name: 'slow', command: 'sleep 2', required: true }], deps: { onEvent: (_t, _a, ev) => { if (ev.type === 'run_result') setTimeout(() => m.cancelTask('a'), 400) } } })
    await m.run()
    assert.equal(byId(m, 'a').state, 'cancelled')
    assert.throws(() => git(e.repo, 'show', `${m.live.integration.branch}:src/a/out.txt`))
  })
  test('S10: a write turn that changes nothing but claims success is misreported, not completed', T, async () => {
    const e = env(); const m = await mission(e, { config: fast(), tasks: [task('a', { allowNoChanges: true, prompt: '[[say:Done, all tests pass.]]' })] })
    await m.run()
    assert.equal(byId(m, 'a').attempts[0].failure, 'misreported_completion')
    const quiet = await mission(env(), { tasks: [task('b', { allowNoChanges: true, prompt: '[[say:Nothing needed changing; the parser already handles this.]]' })] })
    await quiet.run()
    assert.equal(byId(quiet, 'b').state, 'completed', 'an honest no-change answer is accepted')
  })
  void allTasks
})

describe('round 3: live acceptance findings', () => {
  test('an empty COCKPIT_REQUEST ([] or {"tasks": []}) is no request: nothing refused, DONE kept', T, async () => {
    for (const body of ['[]', '{"tasks": []}']) {
      const e = env()
      const m = await mission(e, { tasks: [task('a', { prompt: `[[write:src/a/x=1]] [[request-b64:${Buffer.from(body).toString('base64')}]]` })] })
      const v = await m.run()
      assert.equal(v.state, 'DONE', `${body}: ${v.reasons.join('; ')}`)
      assert.deepEqual(m.live.problems ?? [], [])
    }
  })
  test('a malformed non-empty request is still refused and keeps DONE away', T, async () => {
    const e = env()
    const m = await mission(e, { tasks: [task('a', { prompt: `[[write:src/a/x=1]] [[request-b64:${Buffer.from('{"tasks":[{"id":"t6.docs","files":["/README.md"]}]}').toString('base64')}]]` })] })
    const v = await m.run()
    assert.notEqual(v.state, 'DONE'); assert.match(v.reasons.join('; '), /delegation from a refused/)
  })
  test('the worker contract tells workers not to write the marker when nothing more is needed', async () => {
    const { workerPrompt } = await import('../src/planner.ts')
    assert.match(workerPrompt(task('a'), { readOnly: false, allowedTools: ['read_files'] }), /When nothing more is needed, do not write COCKPIT_REQUEST at all/)
  })
  test('a shell turn routes on its own request; the conversation is context only', async () => {
    const { classifyTurn, turnContext, turnRequest } = await import('../src/turn.ts')
    const c = config(); const res = await resolutions(c)
    const context = turnContext([{ role: 'user', text: 'build the React component layout and css', turn: 't1', at: '' }, { role: 'assistant', text: 'Built the responsive page.', turn: 't1', at: '' }], ['public/index.html'])
    const turn = classifyTurn('add an exported power(a, b) to src/math.js', 't2')
    const r = routeTask({ task: { ...turn.spec, prompt: turnRequest('add an exported power(a, b) to src/math.js'), context }, history: { attempts: 0, gateFailures: 0, escalated: false, lastFailure: null }, config: c, resolutions: res, health: {}, spentSessionUsd: 0 })
    assert.equal(r.role, 'coder')
    // a rejected earlier answer is labelled so the next worker does not build on it
    assert.match(turnContext([{ role: 'assistant', text: 'Done.', turn: 't1', at: '', rejected: true }], []), /NOT accepted by Cockpit's verification/)
  })
})
