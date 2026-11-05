// Integration and acceptance tests: real supervisor, real bubblewrap sandbox, real git,
// the REAL Cockpit hook, and a fake Cline with deterministic streams.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Mission } from '../src/supervisor.ts'
import { listClaims, writeAtomic } from '../src/store.ts'
import { census } from '../src/proc.ts'
import { allTasks, byId, config, deps, env, git, HERE, mission, resolutions, task, tmp } from './helpers.ts'

const T = { timeout: 120_000 }
const attempts = (m: Mission, id: string) => byId(m, id).attempts
const runDirOf = (m: Mission, id: string, n = 1) => join(m.dir, 'runs', id, String(n), 'rw')

describe('happy path and evidence', () => {
  test('one coder task: routed to DeepSeek 1017, XHIGH confirmed as MAX on the wire, gated, integrated on the mission branch only', T, async () => {
    const e = env(); const before = git(e.repo, 'rev-parse', 'main')
    const m = await mission(e, { tasks: [task('a')], gates: [{ name: 'exists', command: 'test -f src/a/out.txt', required: true }] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    const a = attempts(m, 'a')[0]
    assert.equal(a.role, 'coder'); assert.equal(a.model, 'deepseek/deepseek-v4.1-flash-1017')
    assert.deepEqual([a.wire?.state, a.wire?.effective], ['confirmed', 'max'])
    assert.equal(a.census?.state, 'gone'); assert.ok((a.charge.usd ?? 0) > 0)
    assert.equal(git(e.repo, 'rev-parse', 'main'), before, 'main is untouched')
    assert.equal(git(e.repo, 'show', `${m.live.integration.branch}:src/a/out.txt`), 'a')
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 0, 'claims retired after verified end')
    const argv = JSON.parse(readFileSync(join(runDirOf(m, 'a'), 'argv.json'), 'utf8')).argv as string[]
    assert.deepEqual(argv.slice(argv.indexOf('-P'), argv.indexOf('-P') + 6), ['-P', 'cline', '-m', 'deepseek/deepseek-v4.1-flash-1017', '--thinking', 'xhigh'], 'reasoning is passed explicitly on every spawn')
    assert.equal(m.ledger.verify().ok, true)
    const report = JSON.parse(readFileSync(join(m.dir, 'report.json'), 'utf8'))
    assert.equal(report.tasks[0].attempts[0].reasoning.effective, 'max')
    assert.equal(report.tasks[0].attempts[0].charge.basis, 'reported')
  })
  test('restart persistence: a reopened mission keeps its routes, pins and reasoning', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a')] }); await m.run()
    const c = config(); const again = Mission.open(e.root, m.header.id, c, await resolutions(c), deps(e))
    const a = attempts(again, 'a')[0]
    assert.deepEqual([a.model, a.requestedReasoning, a.cliThinking, a.expectedWire], ['deepseek/deepseek-v4.1-flash-1017', 'xhigh', 'xhigh', 'max'])
    assert.equal(again.header.configDigest, m.header.configDigest)
  })
})

describe('real-world regressions', () => {
  test('a worker that edits an existing tracked file passes the GIT gate (found by the live swarm run)', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { owned: ['/src'], prompt: '[[write:src/base.txt=edited]]' })] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    assert.equal(git(e.repo, 'show', `${m.live.integration.branch}:src/base.txt`), 'edited')
  })
})

describe('failure handling', () => {
  test('provider error: one retry on the same model, then FAILED; no model substitution', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[error]]' })] })
    const v = await m.run()
    assert.equal(v.state, 'FAILED')
    const as = attempts(m, 'a'); assert.equal(as.length, 2)
    assert.ok(as.every(a => a.model === 'deepseek/deepseek-v4.1-flash-1017' && a.failure === 'provider_error'))
  })
  test('misreported completion (says done, changes nothing) escalates once to Kimi with evidence, which fixes it', T, async () => {
    const e = env()
    const m = await mission(e, { tasks: [task('a', { prompt: '[[write-if:moonshotai/kimi-k3.1-pro|src/a/out.txt=fixed]] [[say:Done, all tests pass.]]' })], gates: [{ name: 'exists', command: 'test -f src/a/out.txt', required: true }] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    const as = attempts(m, 'a')
    assert.deepEqual(as.map(a => [a.role, a.model, a.failure]), [['coder', 'deepseek/deepseek-v4.1-flash-1017', 'misreported_completion'], ['commander', 'moonshotai/kimi-k3.1-pro', null]])
  })
  test('a gate that keeps failing: DeepSeek, one Kimi escalation, then FAILED (no third attempt)', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[write:src/a/out.txt=x]] [[say:Changed the file as asked.]]' })], gates: [{ name: 'test', command: 'echo "expected 2 got 3" >&2; exit 1', required: true }] })
    const v = await m.run()
    assert.equal(v.state, 'FAILED')
    assert.deepEqual(attempts(m, 'a').map(a => [a.role, a.failure]), [['coder', 'gate_failed'], ['commander', 'gate_failed']])
  })
  test('wrong model version reported: model_mismatch, not retried, not escalated', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[model:deepseek/deepseek-v4.1-flash-0909]] [[write:src/a/out.txt=x]]' })] })
    assert.equal((await m.run()).state, 'FAILED')
    const as = attempts(m, 'a'); assert.equal(as.length, 1); assert.equal(as[0].failure, 'model_mismatch')
  })
  test('reasoning downgrade on the wire (max requested, high sent): wire_mismatch, strict FAILED', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[downgrade]] [[write:src/a/out.txt=x]]' })] })
    assert.equal((await m.run()).state, 'FAILED')
    const a = attempts(m, 'a')[0]; assert.equal(a.failure, 'wire_mismatch'); assert.equal(a.wire?.state, 'mismatch')
  })
  test('no wire capture in strict mode: reasoning unconfirmed, fails closed', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[nocapture]] [[write:src/a/out.txt=x]]' })] })
    assert.equal((await m.run()).state, 'FAILED'); assert.equal(attempts(m, 'a')[0].failure, 'wire_mismatch')
  })
  test('token overrun: the worker is stopped at the task token budget, classed budget_exceeded, not retried', T, async () => {
    const e = env(); const c = config({ budgets: { taskTokens: { coder: 50_000 } } })
    const m = await mission(e, { config: c, tasks: [task('a', { prompt: '[[usage:30000,100,0.001]] [[repeat:10]] [[delay:100]]' })] })
    assert.equal((await m.run()).state, 'FAILED')
    const as = attempts(m, 'a'); assert.equal(as.length, 1); assert.equal(as[0].failure, 'budget_exceeded'); assert.equal(as[0].census?.state, 'gone')
  })
  test('session spending cap: admissions stop and running work is cancelled; the cap is not claimed exact', T, async () => {
    const e = env(); const c = config({ budgets: { sessionUsd: 0.05 }, estimates: { coder: { input: 1, output: 1, cacheRatio: 0 } }, limits: { concurrency: { total: 1 } } })
    const m = await mission(e, { config: c, tasks: [task('a', { prompt: '[[usage:1000,10,0.04]] [[repeat:3]] [[delay:50]] [[write:src/a/out.txt=x]]' }), task('b')] })
    const v = await m.run()
    assert.ok(['FAILED', 'PARTIAL'].includes(v.state)); assert.ok(m.live.session.capReached)
    assert.ok(v.reasons.some(r => /session budget/.test(r)))
    assert.equal(allTasks(m).find(t => t.id === 'b')?.attempts.length ?? 0, 0, 'no new admission after the cap')
  })
  test('unknown usage: the session becomes unmetered, later admissions stop, DONE is withheld', T, async () => {
    const e = env(); const c = config({ limits: { concurrency: { total: 1 } } })
    const m = await mission(e, { config: c, tasks: [task('a', { prompt: '[[nousage]] [[write:src/a/out.txt=x]]' }), task('b', { dependencies: ['a'] })] })
    const v = await m.run()
    assert.notEqual(v.state, 'DONE'); assert.equal(m.live.session.unmetered, true)
    assert.equal(byId(m, 'b').attempts.length, 0)
  })
})

describe('isolation and adversarial workers', () => {
  test('recursive spawn attempts (native sub-agent tool, launching cline) abort the worker', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[tool:spawn_agent]]' }), task('b', { prompt: '[[cmd:cline "spawn more"]]' })] })
    assert.equal((await m.run()).state, 'FAILED')
    for (const id of ['a', 'b']) { const as = attempts(m, id); assert.equal(as.length, 1); assert.equal(as[0].failure, 'policy_abort') }
  })
  test('a write outside ownership through the editor is refused by the hook', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[write:README.md=pwned]]' })] })
    assert.equal((await m.run()).state, 'FAILED')
    assert.equal(attempts(m, 'a')[0].failure, 'policy_abort')
    assert.equal(readFileSync(join(e.repo, 'README.md'), 'utf8'), '# fixture\n')
  })
  test('an out-of-scope change made through a shell command is caught by the GIT gate and never integrated', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[cmd:echo pwned > README.md]] [[write:src/a/out.txt=x]]' })] })
    assert.equal((await m.run()).state, 'FAILED')
    const a = attempts(m, 'a')[0]; assert.equal(a.failure, 'policy_abort')
    assert.equal(git(e.repo, 'show', `${m.live.integration.branch}:README.md`), '# fixture')
  })
  test('the sandbox refuses writes to the real checkout and outside the worktree', T, async () => {
    const e = env(); const outside = join(tmp('outside'), 'x.txt')
    const m = await mission(e, { tasks: [task('a', { prompt: `[[cmd:echo x > ${e.repo}/escaped.txt; echo x > ${outside}]] [[write:src/a/out.txt=x]]` })] })
    await m.run()
    assert.equal(existsSync(join(e.repo, 'escaped.txt')), false); assert.equal(existsSync(outside), false)
  })
  test('a credential in the change fails the SECURITY gate', T, async () => {
    // built at run time from parts, so no complete credential-shaped literal sits in this file
    const secret = ['sk', 'ant', 'api03', 'Q'.repeat(30) + '-' + 'z'.repeat(20)].join('-')
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: `[[write:src/a/key.txt=ANTHROPIC_API_KEY=${secret}]]` })] })
    assert.equal((await m.run()).state, 'FAILED')
    const a = attempts(m, 'a')[0] as unknown as { failure: string; gates: { name: string; state: string }[] }
    assert.equal(a.failure, 'policy_abort'); assert.ok(a.gates.some(g => g.name === 'SECURITY' && g.state === 'fail'))
  })
  test('detached children (setsid) are killed with the sandbox and the census proves it', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[detach:600]] [[write:src/a/out.txt=x]]' })] })
    assert.equal((await m.run()).state, 'DONE')
    const a = attempts(m, 'a')[0]
    assert.equal(a.census?.state, 'gone')
    const pid = Number(readFileSync(join(runDirOf(m, 'a'), 'detached-pid'), 'utf8'))
    assert.ok(pid > 0)
    const c = census({ initPid: null, initStart: null, pidNs: null, marker: `COCKPIT_CLINE_ATTEMPT=${m.header.id}.a.1`, since: Date.now() - 60_000 })
    assert.equal(c.state === 'alive', false, 'no process carries the attempt marker')
    assert.equal(a.identity !== null, true)
  })
})

describe('ownership, concurrency and scheduling', () => {
  test('overlapping writers are serialized; disjoint writers run in parallel', T, async () => {
    const e = env()
    const m = await mission(e, { tasks: [
      task('a', { owned: ['/src/shared'], prompt: '[[delay:400]] [[write:src/shared/a.txt=a]]' }),
      task('b', { owned: ['/src/shared/sub'], prompt: '[[delay:400]] [[write:src/shared/sub/b.txt=b]]' }),
      task('c', { owned: ['/src/c'], prompt: '[[delay:400]] [[write:src/c/c.txt=c]]' }),
    ] })
    assert.equal((await m.run()).state, 'DONE')
    const span = (id: string) => { const a = attempts(m, id)[0]; return [Date.parse(a.startedAt), Date.parse(a.endedAt as string)] }
    const [a0, a1] = span('a'), [b0, b1] = span('b'), [c0] = span('c')
    assert.ok(b0 >= a1 || a0 >= b1, 'a and b never overlap')
    assert.ok(c0 < Math.max(a1, b1), 'c ran alongside the serialized pair')
  })
  test('concurrency never exceeds the configured limit (delayed calls, 10 tasks, limit 3)', T, async () => {
    const e = env(); const c = config({ limits: { concurrency: { total: 3 } } })
    const m = await mission(e, { config: c, tasks: Array.from({ length: 10 }, (_, i) => task(`t${i}`, { prompt: `[[delay:150]] [[write:src/t${i}/x=1]]` })) })
    assert.equal((await m.run()).state, 'DONE')
    const ev = allTasks(m).flatMap(t => t.attempts.map(a => [[Date.parse(a.startedAt), 1], [Date.parse(a.endedAt as string), -1]])).flat() as [number, number][]
    ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]); let cur = 0, max = 0; for (const [, d] of ev) { cur += d; max = Math.max(max, cur) }
    assert.ok(max <= 3, `max concurrency ${max}`); assert.ok(max >= 2, 'work actually ran in parallel')
  })
  test('priority: a higher-priority ready task starts first', T, async () => {
    const e = env(); const c = config({ limits: { concurrency: { total: 1 } } })
    const m = await mission(e, { config: c, tasks: [task('low', { priority: 1 }), task('high', { priority: 9 })] })
    await m.run()
    assert.ok(Date.parse(attempts(m, 'high')[0].startedAt) < Date.parse(attempts(m, 'low')[0].startedAt))
  })
  test('another mission on the same repository cannot take an overlapping claim (cross-mission, cross-session)', T, async () => {
    const e = env()
    const a = await mission(e, { tasks: [task('a', { owned: ['/src'], prompt: '[[delay:2500]] [[write:src/a.txt=a]]' })] })
    const runA = a.run()
    await new Promise(r => setTimeout(r, 600))
    const b = await mission(e, { tasks: [task('b', { owned: ['/src/x'], prompt: '[[write:src/x/b.txt=b]]' })] })
    const runB = b.run()
    await new Promise(r => setTimeout(r, 500))
    assert.match(b.live.tasks.b?.reason ?? '', /repository claim held by/)
    await Promise.all([runA, runB])
    const aEnd = Date.parse(attempts(a, 'a')[0].endedAt as string), bStart = Date.parse(attempts(b, 'b')[0].startedAt)
    assert.ok(bStart >= aEnd - 50, 'b started only after a released its claim')
  })
  test('a second supervisor for the same mission is refused while the first runs', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[delay:1500]] [[write:src/a/x=1]]' })] })
    const r = m.run(); await new Promise(res => setTimeout(res, 300))
    const c = config(); const other = Mission.open(e.root, m.header.id, c, await resolutions(c), deps(e))
    assert.throws(() => other.acquire(), /second supervisor is refused/)
    await r
  })
  test('cancel through the control file stops the worker, proves the census and ends STOPPED', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[hang]]' })] })
    const r = m.run(); await new Promise(res => setTimeout(res, 700))
    writeAtomic(join(m.dir, 'control.json'), JSON.stringify({ cancel: 'all' }))
    const v = await r
    assert.equal(v.state, 'STOPPED'); assert.equal(attempts(m, 'a')[0].census?.state, 'gone')
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 0)
  })
})

describe('delegation and the commander', () => {
  test('worker requests pass central admission: depth +1, prefixed ids, routed by Cockpit not the worker', T, async () => {
    const e = env()
    const req = JSON.stringify({ tasks: [{ id: 'docs', title: 'inventory docs', kind: 'scout', risk: 'low', complexity: 1, mode: 'read', owned: ['src'], dependencies: [], prompt: 'list files' }] })
    const m = await mission(e, { tasks: [task('a', { prompt: `[[write:src/a/x=1]] [[request:${req}]]` })] })
    assert.equal((await m.run()).state, 'DONE')
    const child = byId(m, 'a.docs') as unknown as { spec: { depth: number; parent: string }; attempts: { role: string; model: string }[] }
    assert.equal(child.spec.depth, 2); assert.equal(child.spec.parent, 'a')
    assert.deepEqual([child.attempts[0].role, child.attempts[0].model], ['utility', 'zai/glm-5.3-flash'])
  })
  test('requests beyond the delegation depth are refused (no fan-out loops)', T, async () => {
    const e = env(); const c = config({ limits: { maxDelegationDepth: 1 } })
    const req = JSON.stringify({ tasks: [{ id: 'more', title: 'more', kind: 'implement', risk: 'low', complexity: 1, mode: 'write', owned: ['src/m'], dependencies: [], prompt: 'again' }] })
    const m = await mission(e, { config: c, tasks: [task('a', { prompt: `[[write:src/a/x=1]] [[request:${req}]]` })] })
    await m.run()
    assert.equal(allTasks(m).some(t => t.id === 'a.more'), false)
    assert.ok(m.ledger.verify().ok)
    assert.ok([...m.ledger.entries()].some(x => x.kind === 'task_refused' && /depth/.test(JSON.stringify(x.data))))
  })
  test('commander plan: Kimi decomposes, Cockpit routes each task by rule', T, async () => {
    const e = env()
    const plan = JSON.stringify({ tasks: [
      { id: 'scan', title: 'inventory', kind: 'scout', risk: 'low', complexity: 1, mode: 'read', owned: ['src'], dependencies: [], prompt: 'list' },
      { id: 'ui', title: 'settings page', kind: 'frontend', risk: 'medium', complexity: 3, mode: 'write', owned: ['src/ui'], dependencies: ['scan'], prompt: '[[write:src/ui/page.tsx=x]]' },
      { id: 'core', title: 'core change', kind: 'implement', risk: 'medium', complexity: 3, mode: 'write', owned: ['src/core'], dependencies: ['scan'], prompt: '[[write:src/core/a.ts=x]]' },
    ] })
    const m = await mission(e, { goal: `[[plan-b64:${Buffer.from(plan).toString('base64')}]] Redesign the architecture`, swarm: true })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    const roleOf = (id: string) => attempts(m, id)[0].role
    assert.deepEqual([roleOf('plan'), roleOf('scan'), roleOf('ui'), roleOf('core')], ['commander', 'utility', 'frontend', 'coder'])
    assert.equal(attempts(m, 'ui')[0].model, 'qwen/qwen3.8-max-0902')
  })
  test('an invalid commander plan is rejected whole and the mission is not DONE', T, async () => {
    const e = env(); const m = await mission(e, { goal: `[[plan:${JSON.stringify({ tasks: [{ id: 'x', owned: ['/etc'] }] })}]] architecture`, swarm: true })
    const v = await m.run()
    assert.notEqual(v.state, 'DONE'); assert.ok(v.reasons.some(r => /plan rejected/.test(r)))
  })
})

describe('crash recovery and lost state', () => {
  const spawnSupervisor = (args: unknown) => spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', join(HERE, '..', 'loader', 'register.mjs'), join(HERE, 'fixtures', 'run-mission.ts'), JSON.stringify(args)], { stdio: 'ignore' })
  test('supervisor killed -9 mid-run: workers die with it, restart reconciles by identity, retries and finishes', T, async () => {
    const e = env(); const out = tmp('crash')
    const child = spawnSupervisor({ ...e, out, mode: 'create', tasks: [task('a', { prompt: '[[sleep:3000]] [[write:src/a/x=1]]' })] })
    let id = ''; for (let i = 0; i < 100 && !id; i++) { await new Promise(r => setTimeout(r, 100)); if (existsSync(join(out, 'mission-id'))) id = readFileSync(join(out, 'mission-id'), 'utf8') }
    assert.ok(id)
    const live = () => JSON.parse(readFileSync(join(e.root, 'missions', id, 'live.json'), 'utf8'))
    for (let i = 0; i < 100 && live().tasks.a?.attempts?.[0]?.phase !== 'running'; i++) await new Promise(r => setTimeout(r, 100))
    const ident = live().tasks.a.attempts[0].identity
    child.kill('SIGKILL'); await new Promise(r => child.on('exit', r))
    await new Promise(r => setTimeout(r, 300))
    assert.equal(census({ initPid: ident.initPid, initStart: ident.initStart, pidNs: ident.pidNs, marker: ident.marker, since: ident.since }).state, 'gone', 'die-with-parent ended the sandbox')
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 1, 'the claim survives the crash')
    const c = config(); const m = Mission.open(e.root, id, c, await resolutions(c), deps(e))
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    assert.deepEqual(attempts(m, 'a').map(a => a.failure), ['unknown_outcome', null])
    assert.ok([...m.ledger.entries()].some(x => x.kind === 'supervisor_takeover'))
  })
  test('deleted mission state: new missions on the repository are refused until recover --lost', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a')] }); await m.run()
    rmSync(m.dir, { recursive: true })
    await assert.rejects(() => mission(e, { tasks: [task('b')] }), /mission state is missing/)
  })
  test('thousands of sequential tasks through the bounded queue: live state stays small, history pages, reload is fast', { timeout: 600_000 }, async () => {
    const e = env(); const N = Number(process.env.COCKPIT_SCALE_N ?? 2000); const WAVE = 50
    const fast = async (spec: { model: string }) => ({ identity: null, exitCode: 0, signal: null, stoppedBy: 'exit' as const, stopDetail: null, hookRefusals: [], census: { state: 'gone' as const, pids: [], detail: 'in-process fake' }, wire: { state: 'confirmed' as const, requests: 1, effective: 'low', models: [spec.model], detail: 'fake' }, facts: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: 0.000001 }, usageEvents: 1, toolCalls: {}, iterations: 1, finishReason: 'completed', aborted: null, resultText: 'ok', reportedModel: spec.model, reportedProvider: 'cline', agentErrors: 0, lines: 3, badLines: 0, sessionIds: [], firstEventAt: null, lastEventAt: null } })
    const c = config({ limits: { pageSize: 200, concurrency: { total: 6, utility: 6 } }, budgets: { sessionUsd: 100 } })
    const mk = (i: number) => task(`s${i}`, { kind: 'scout', risk: 'low', complexity: 1, mode: 'read', owned: [`/src/s${i}`], prompt: 'x' })
    const m = await mission(e, { config: c, tasks: [mk(0)], deps: { runWorker: fast as never } })
    let maxLive = 0; let refused = 0
    const t0 = performance.now()
    await m.run()
    for (let i = 1; i < N; i += WAVE) {
      for (let j = i; j < Math.min(N, i + WAVE + 20); j++) if (j < i + WAVE) m.addTask(mk(j), 'wave'); else if (!m.addTask(mk(N + j), 'overflow').ok) refused++
      maxLive = Math.max(maxLive, readFileSync(join(m.dir, 'live.json')).length)
      const v = await m.run()
      assert.notEqual(v.state, 'BLOCKED')
    }
    const elapsed = performance.now() - t0
    assert.ok(refused > 0, 'backpressure refused work beyond the queue limit')
    const finished = m.archive.index().total
    assert.ok(finished >= N, `${finished} archived`)
    const final = readFileSync(join(m.dir, 'live.json')).length
    assert.ok(maxLive < 300_000, `max live.json ${maxLive} bytes`)
    const t1 = performance.now(); Mission.open(e.root, m.header.id, c, await resolutions(c), deps(e)); const reload = performance.now() - t1
    assert.ok(reload < 500, `reload ${reload.toFixed(0)} ms`)
    assert.equal(m.ledger.verify().ok, true)
    assert.ok(m.archive.stateOf('s0') === 'completed' && m.archive.stateOf(`s${N - 1}`) === 'completed')
    console.log(`scale: ${finished} tasks in ${(elapsed / 1000).toFixed(1)} s, max live.json ${maxLive} B, final ${final} B, archive pages ${m.archive.index().pages.length}, reload ${reload.toFixed(1)} ms, backpressure refusals ${refused}`)
  })
  test('high concurrency: 300 tasks hold exactly the 6-worker limit; provider errors scale the provider down (AIMD)', { timeout: 300_000 }, async () => {
    const e = env(); let cur = 0, max = 0, calls = 0
    const ok = (model: string) => ({ identity: null, exitCode: 0, signal: null, stoppedBy: 'exit' as const, stopDetail: null, hookRefusals: [], census: { state: 'gone' as const, pids: [], detail: 'fake' }, wire: { state: 'confirmed' as const, requests: 1, effective: 'low', models: [model], detail: 'fake' }, facts: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: 0.000001 }, usageEvents: 1, toolCalls: {}, iterations: 1, finishReason: 'completed', aborted: null, resultText: 'ok', reportedModel: model, reportedProvider: 'cline', agentErrors: 0, lines: 3, badLines: 0, sessionIds: [], firstEventAt: null, lastEventAt: null } })
    const runner = async (spec: { model: string }) => { calls++; cur++; max = Math.max(max, cur); await new Promise(r => setTimeout(r, 15)); cur--; const o = ok(spec.model); if (calls === 40) { o.facts.finishReason = 'error'; o.facts.resultText = '429 rate limited' } return o }
    const c = config({ limits: { concurrency: { total: 6, utility: 6 }, maxQueue: 400 }, budgets: { sessionUsd: 100 } })
    const tasks = Array.from({ length: 300 }, (_, i) => task(`h${i}`, { kind: 'scout', risk: 'low', complexity: 1, mode: 'read', owned: [`/src/h${i}`], prompt: 'x' }))
    const m = await mission(e, { config: c, tasks: tasks.slice(0, 1), deps: { runWorker: runner as never } })
    for (const t of tasks.slice(1)) m.addTask(t, 'test')
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    assert.equal(max, 6, `max concurrency ${max}`)
    const health = [...m.ledger.entries()].filter(x => x.kind === 'provider_health')
    assert.equal(health.length, 1); assert.equal((health[0].data as { concurrency: number }).concurrency, 3, 'one provider error halves provider concurrency')
  })
})

void readdirSync; void writeFileSync
