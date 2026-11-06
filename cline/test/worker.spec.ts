// Worker regressions from the independent review: late identity callbacks, observer
// failures, and budget enforcement when cost telemetry is missing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { budgetVerdict, runWorker } from '../src/worker.ts'
import type { WorkerSpec } from '../src/worker.ts'
import type { Identity, Launched } from '../src/sandbox.ts'
import { ZERO_USAGE } from '../src/cost.ts'
import { allTasks, clineData, config, env, FAKE, mission, task, tmp } from './helpers.ts'

const PRICE = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }
const spec = (over: Partial<WorkerSpec> = {}): WorkerSpec => {
  const wt = tmp('wk'); mkdirSync(join(wt, 'src'), { recursive: true })
  const data = clineData()
  return { attemptId: `wk-${Math.random().toString(16).slice(2)}`, runDir: tmp('wkrun'), workdir: wt, writable: true, gitCommonDir: null, gitAdminDir: null, provider: 'cline', model: 'deepseek/deepseek-v4.1-flash-1017', cliThinking: 'xhigh', expectedWire: 'max', prompt: '[[write:src/a.txt=x]]', policy: { workdir: wt, owned: ['/src'], mode: 'write', allowedTools: ['editor', 'run_commands', 'read_files', 'search_codebase'] }, timeoutSeconds: 30, clineRetries: 1, hide: [], clineBin: FAKE, clineDataDir: data, budgetUsd: 1, budgetTokens: 1e7, pricing: PRICE, allowUnmetered: false, ...over }
}
const usage = (o: Partial<typeof ZERO_USAGE>) => ({ ...ZERO_USAGE, ...o })

describe('budget decision never lets missing cost telemetry pass silently', () => {
  const w = { budgetUsd: 0.01, budgetTokens: 1e9, pricing: PRICE, allowUnmetered: false }
  test('reported cost over the budget stops', () => assert.equal(budgetVerdict({ usage: usage({ inputTokens: 10, reportedUsd: 0.02 }), usageEvents: 1, iterations: 1 }, w)?.stop, 'budget'))
  test('reported cost under the budget continues', () => assert.equal(budgetVerdict({ usage: usage({ inputTokens: 10, reportedUsd: 0.001 }), usageEvents: 1, iterations: 1 }, w), null))
  test('no reported cost: the estimate from configured pricing enforces the budget', () => {
    const v = budgetVerdict({ usage: usage({ inputTokens: 200_000, outputTokens: 1000, cacheReadTokens: 100_000 }), usageEvents: 1, iterations: 1 }, w)
    assert.equal(v?.stop, 'budget'); assert.match(v?.detail ?? '', /estimated cost/)
  })
  test('no reported cost and no pricing: unmeasurable, stopped', () => assert.equal(budgetVerdict({ usage: usage({ inputTokens: 10 }), usageEvents: 1, iterations: 1 }, { ...w, pricing: null })?.stop, 'unmetered'))
  test('no reported cost and no pricing is allowed only by explicit opt-in', () => assert.equal(budgetVerdict({ usage: usage({ inputTokens: 10 }), usageEvents: 1, iterations: 1 }, { ...w, pricing: null, allowUnmetered: true }), null))
  test('a model turn that ended without any usage event is unmeasurable, stopped', () => assert.equal(budgetVerdict({ usage: usage({}), usageEvents: 0, iterations: 1 }, w)?.stop, 'unmetered'))
  test('before the first turn ends nothing is judged', () => assert.equal(budgetVerdict({ usage: usage({}), usageEvents: 0, iterations: 0 }, w), null))
  test('the token budget applies whatever the cost telemetry', () => assert.equal(budgetVerdict({ usage: usage({ inputTokens: 5000 }), usageEvents: 0, iterations: 0 }, { ...w, budgetTokens: 1000 })?.stop, 'budget'))
})

describe('worker runtime', () => {
  test('an identity that arrives after the attempt returned never calls the binding callback', { timeout: 30_000 }, async () => {
    let late!: (id: Identity) => void
    const identity = new Promise<Identity>(r => { late = r })
    const fakeLaunch = (): Launched => ({ child: spawn('true', [], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] }), identity })
    const calls: Identity[] = []
    const out = await runWorker(spec(), { identity: id => { calls.push(id) } }, { launch: fakeLaunch })
    assert.equal(out.identity, null)
    late({ supervisor: { pid: 1, start: null, boot: null }, outer: { pid: 2, start: null, boot: null }, initPid: 3, initStart: null, pidNs: null, marker: 'm', startedAt: 'now', since: Date.now() })
    await new Promise(r => setTimeout(r, 100))
    assert.equal(calls.length, 0, 'a late identity must not rebind ownership or rewrite a retired claim')
  })
  test('a throwing observer does not stop the stream: the run result and usage are still read', { timeout: 60_000 }, async () => {
    const out = await runWorker(spec({ prompt: '[[usage:1000,10,0.0001]] [[repeat:3]] [[write:src/a.txt=x]]' }), { facts: () => { throw new Error('ENOSPC: no space left on device') } })
    assert.equal(out.facts.finishReason, 'completed')
    assert.equal(out.facts.usageEvents, 3); assert.equal(out.facts.usage.inputTokens, 3000)
    assert.match(out.observerError ?? '', /ENOSPC/)
    assert.equal(out.census.state, 'gone')
  })
  test('no cost field and no pricing: the live run is stopped as unmetered', { timeout: 60_000 }, async () => {
    const out = await runWorker(spec({ prompt: '[[nocost]] [[usage:1000,10,0]] [[repeat:5]] [[delay:100]] [[write:src/a.txt=x]]', pricing: null }))
    assert.equal(out.stoppedBy, 'unmetered'); assert.equal(out.census.state, 'gone')
  })
  test('no usage events at all: stopped as unmetered at the end of the first model turn', { timeout: 60_000 }, async () => {
    const out = await runWorker(spec({ prompt: '[[nousage]] [[repeat:5]] [[delay:100]] [[write:src/a.txt=x]]' }))
    assert.equal(out.stoppedBy, 'unmetered', JSON.stringify({ exit: out.exitCode, signal: out.signal, lines: out.facts.lines, iterations: out.facts.iterations, finish: out.facts.finishReason, detail: out.stopDetail, census: out.census.state }))
    assert.equal(out.facts.usageEvents, 0)
  })
})

describe('process identity', () => {
  test('a reused pid-namespace inode never makes live processes look like an ended attempt\'s', async () => {
    const { census, pidNamespaceOf } = await import('../src/proc.ts')
    // The init is gone (impossible start time) but the recorded namespace inode is one that is
    // live right now, as after the kernel reuses a freed namespace's inode for a new sandbox.
    const live = pidNamespaceOf(process.pid)
    assert.ok(live)
    const c = census({ initPid: 1, initStart: '0', pidNs: live, marker: `COCKPIT_CLINE_ATTEMPT=never-${Date.now()}`, since: Date.now() })
    assert.equal(c.state, 'gone', `census matched ${c.pids.length} unrelated process(es)`)
  })
})

describe('budget overruns through the supervisor', () => {
  test('no reported cost: the estimate stops the worker at the task budget, classed budget_exceeded, recorded as estimated', { timeout: 120_000 }, async () => {
    const e = env(); const c = config({ budgets: { taskUsd: { coder: 0.01 } } })
    const m = await mission(e, { config: c, tasks: [task('a', { prompt: '[[nocost]] [[usage:200000,1000,0]] [[repeat:4]] [[delay:100]] [[write:src/a/x=1]]' })] })
    const v = await m.run()
    assert.notEqual(v.state, 'DONE')
    const a = allTasks(m).find(t => t.id === 'a')!.attempts
    assert.equal(a.length, 1); assert.equal(a[0].failure, 'budget_exceeded'); assert.match(a[0].failureDetail ?? '', /estimated cost/)
    assert.equal(a[0].charge.basis, 'estimate')
    assert.deepEqual(m.live.session.estimatedTasks, [`${m.header.id}.a.1`], 'an estimate is recorded as such, never as a measured cost')
  })
  test('a completed run with estimated cost can finish, but the verdict says the cost was estimated', { timeout: 120_000 }, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[nocost]] [[write:src/a/x=1]]' })] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    assert.match(v.reasons.join(' '), /estimated from configured pricing/)
    assert.doesNotMatch(v.reasons.join(' '), /costs metered/)
  })
})
