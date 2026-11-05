// HUD 2.0 unit tests: the terminal foundation, the view model's honesty rules, the timeline's
// sources, and the renderer at every width and colour mode. Pure functions, no terminal needed.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Paint, Screen, colorMode, fit, midcut, reducedMotion, sanitize, shortName, stripAnsi, vlen, wrap, xterm256 } from '../src/ui/term.ts'
import { buildView, gateFamily, reasoningOf } from '../src/ui/model.ts'
import type { View, ViewInput } from '../src/ui/model.ts'
import { LedgerTail, Timeline, fromLedger, fromWorker } from '../src/ui/timeline.ts'
import { TABS, hudLines, missionControlLines } from '../src/ui/render.ts'
import type { Frame } from '../src/ui/render.ts'
import type { AttemptRecord, Header, Live, TaskRecord } from '../src/supervisor.ts'
import { ZERO_USAGE } from '../src/cost.ts'
import { config, resolutions, task, tmp } from './helpers.ts'

// ----- fixtures: records shaped like the supervisor's -------------------------------------------
const NOW = Date.parse('2026-11-05T12:00:00Z')
const attempt = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  n: 1, id: 'm.t1.1', role: 'coder', provider: 'cline', model: 'deepseek/deepseek-v4.1-flash-1017', requestedReasoning: 'xhigh', cliThinking: 'xhigh', expectedWire: 'max', mapping: 'direct',
  route: { rules: ['D default implementation work -> coder'], signals: [], effectiveRisk: 'medium' } as unknown as AttemptRecord['route'], engineId: 'e1', phase: 'ended',
  startedAt: new Date(NOW - 60_000).toISOString(), endedAt: new Date(NOW - 20_000).toISOString(), identity: null, worktree: null, base: null,
  usage: { ...ZERO_USAGE, inputTokens: 12_000, outputTokens: 800, cacheReadTokens: 9000 }, usageEvents: 3, toolCalls: { editor: 1 }, iterations: 2,
  finishReason: 'completed', reportedModel: null, reportedProvider: null, wire: { state: 'confirmed', requests: 2, effective: 'max', models: [], detail: '2 request(s) at max' },
  census: { state: 'gone', pids: [], detail: 'gone' } as AttemptRecord['census'], stoppedBy: 'exit', exitCode: 0, charge: { usd: 0.0123, basis: 'reported' }, estimateUsd: 0.05,
  failure: null, failureDetail: null, gates: [], changes: ['src/a.ts'], commit: 'abc12345', resultExcerpt: 'Done.', hookRefusals: [], alerts: [], ...over,
})
const record = (id: string, state: TaskRecord['state'], attempts: AttemptRecord[], over: Partial<TaskRecord> = {}): TaskRecord => ({
  spec: task(id), state, attempts, transientRetries: 0, escalations: 0, escalateTo: null, evidence: [], createdAt: NOW - 90_000, updatedAt: NOW, reason: null,
  verification: state === 'completed' ? 'PROVISIONAL_CHECKED' : null, integratedHead: state === 'completed' ? 'head1234' : null, children: [], requestsRefused: [], ...over,
})
const header = (): Header => ({ id: 'm-test', repoRoot: '/repo', commonDir: '/repo/.git', base: 'base0000', createdAt: new Date(NOW - 120_000).toISOString(), profile: 'cline', strict: true, goal: 'g', epoch: 'e', configDigest: 'd', gates: [{ name: 'test', command: 'npm test', required: true }], clineVersion: '3.0.74', mode: 'conversation', modeReason: '', review: false, requireGates: true })
const liveOf = (tasks: TaskRecord[], over: Partial<Live> = {}): Live => ({
  version: 1, missionId: 'm-test', epoch: 'e', state: 'running', supervisor: null, tasks: Object.fromEntries(tasks.map(t => [t.spec.id, t])),
  swarm: {} as Live['swarm'], session: { spentUsd: 0.0123, tokens: 12_800, archivedUsd: 0, archivedTokens: 0, unmetered: false, alertsFired: [], capReached: false, unmeteredTasks: [], estimatedTasks: [] },
  health: {}, aimd: {}, spawnTimes: [], counters: { created: tasks.length, completed: tasks.filter(t => t.state === 'completed').length, failed: 0, cancelled: 0, refused: 0, archived: 0, attempts: tasks.reduce((s, t) => s + t.attempts.length, 0) },
  recent: [], integration: { dir: '/wt', branch: 'cockpit/m-test', base: 'base0000', head: 'head1234' }, finalGates: [], review: null, verdict: null, alerts: [], stopRequested: null, updatedAt: new Date(NOW).toISOString(), ...over,
})
const viewOf = async (tasks: TaskRecord[], over: Partial<Live> = {}, extra: Partial<ViewInput> = {}): Promise<View> => {
  const c = config(); const lv = liveOf(tasks, over)
  return buildView({ header: header(), live: lv, records: tasks, claims: [], config: c, resolutions: await resolutions(c), committedUsd: lv.session.spentUsd, activity: new Map(), turn: null, now: NOW, ...extra })
}
const frame = (cols: number, rows: number, mode: 'none' | '16' | '256' | 'truecolor' = 'none', motion = false): Frame => ({ cols, rows, paint: new Paint(mode), motion, tick: 3 })

describe('terminal foundation', () => {
  test('colour mode follows NO_COLOR, COCKPIT_COLOR, TERM and COLORTERM', () => {
    assert.equal(colorMode({ NO_COLOR: '1', COLORTERM: 'truecolor' }), 'none')
    assert.equal(colorMode({ COCKPIT_COLOR: '256', COLORTERM: 'truecolor' }), '256')
    assert.equal(colorMode({ COLORTERM: 'truecolor' }), 'truecolor')
    assert.equal(colorMode({ TERM: 'xterm-256color' }), '256')
    assert.equal(colorMode({ TERM: 'dumb' }), 'none')
    assert.equal(colorMode({ TERM: 'xterm' }, false), 'none', 'not a terminal')
    assert.equal(colorMode({ TERM: 'xterm' }), '16')
    assert.equal(reducedMotion({ COCKPIT_REDUCED_MOTION: '1' }), true); assert.equal(reducedMotion({}), false)
  })
  test('the Cobalt palette in every mode; no escape codes at all without colour', () => {
    assert.equal(new Paint('none').fg('accent', 'x'), 'x'); assert.equal(new Paint('none').pill('ok', 'DONE'), '[DONE]')
    assert.equal(new Paint('truecolor').fg('accent', 'x'), '\x1b[38;2;224;30;65mx\x1b[0m')
    assert.match(new Paint('256').fg('accent', 'x'), /^\x1b\[38;5;\d+mx/)
    assert.equal(new Paint('16').fg('ok', 'x'), '\x1b[92mx\x1b[0m')
    assert.equal(xterm256('#E01E41'), 161)
  })
  test('width-safe text: wide characters, cuts with ellipsis, middle cuts, model short names, wrapping', () => {
    assert.equal(vlen('漢字ab'), 6); assert.equal(vlen('\x1b[1mab\x1b[0m'), 2); assert.equal(vlen('✓●◆★'), 4)
    for (const n of [1, 5, 9, 30]) for (const s of ['plain text that is long enough', '\x1b[31mred text that is long\x1b[0m', '漢字漢字漢字漢字漢字', 'a\nb\tc']) assert.equal(vlen(fit(s, n)), n, `${JSON.stringify(s)} at ${n}`)
    assert.doesNotMatch(fit('two\nlines', 20), /\n/)
    assert.equal(midcut('cline/src/very/long/path/shell.ts', 16).length, 16)
    assert.equal(shortName('DeepSeek V4.1 Flash 1017', 17), 'DeepSeek 1017'); assert.equal(shortName('Qwen3.8 Max 0902', 14), 'Qwen3.8 0902'); assert.equal(shortName('GLM 5.3 Flash', 20), 'GLM 5.3 Flash')
    for (const line of wrap('a long sentence with averyveryverylongwordthatmustbreak and more', 12)) assert.ok(vlen(line) <= 12)
  })
  test('model text cannot drive the terminal: escapes, OSC and control characters are removed', () => {
    assert.equal(sanitize('ok\x1b[2J\x1b]0;title\x07\x1b[31mred\x07\rdone'), 'okreddone')
    assert.equal(sanitize('tab\there\nnext'), 'tab  here\nnext')
  })
  test('the screen writer rewrites only rows that changed, inside synchronized output, and repaints on a resize', () => {
    let out = ''; const s = new Screen({ write: (x: string) => { out += x } })
    s.draw(['a', 'b', 'c'], 10, 3, { row: 3, col: 1 }); assert.match(out, /\x1b\[2J/); assert.match(out, /^\x1b\[\?2026h/); assert.match(out, /\x1b\[\?2026l$/)
    out = ''; s.draw(['a', 'B', 'c'], 10, 3, { row: 3, col: 1 })
    assert.doesNotMatch(out, /\x1b\[1;1Ha/); assert.match(out, /\x1b\[2;1HB/); assert.doesNotMatch(out, /\x1b\[3;1Hc/); assert.doesNotMatch(out, /2J/)
    out = ''; s.draw(['a', 'B', 'c'], 10, 3, { row: 3, col: 4 }); assert.doesNotMatch(out, /\x1b\[\d;1H/, 'an unchanged frame writes no rows')
    out = ''; s.draw(['a', 'B', 'c'], 12, 3, { row: 3, col: 1 }); assert.match(out, /2J/); assert.match(out, /\x1b\[1;1Ha/)
  })
})

describe('view model: only what the records say', () => {
  test('reasoning is verified only by the wire; unknown is never shown as confirmed', () => {
    assert.equal(reasoningOf(null, 'xhigh').status, 'unobserved')
    assert.equal(reasoningOf({ requestedReasoning: 'xhigh', expectedWire: 'max', wire: null, mapping: 'direct', phase: 'running' }, 'xhigh').status, 'pending')
    assert.deepEqual(reasoningOf({ requestedReasoning: 'xhigh', expectedWire: 'max', wire: { state: 'confirmed', requests: 1, effective: 'max', models: [], detail: '' }, mapping: 'direct', phase: 'ended' }, 'xhigh'), { requested: 'xhigh', effective: 'max', status: 'confirmed', detail: '' })
    assert.equal(reasoningOf({ requestedReasoning: 'xhigh', expectedWire: 'max', wire: { state: 'mismatch', requests: 1, effective: 'high', models: [], detail: 'sent high' }, mapping: 'direct', phase: 'ended' }, 'xhigh').effective, 'high')
    assert.equal(reasoningOf({ requestedReasoning: 'xhigh', expectedWire: 'max', wire: { state: 'unconfirmed', requests: 1, effective: null, models: [], detail: '' }, mapping: 'direct', phase: 'ended' }, 'xhigh').status, 'unconfirmed')
    assert.equal(reasoningOf({ requestedReasoning: 'high', expectedWire: 'on', wire: { state: 'confirmed', requests: 1, effective: 'high', models: [], detail: '' }, mapping: 'toggle', phase: 'ended' }, 'high').status, 'inferred')
  })
  test('a running worker without usage has unknown tokens and cost, never zero; an estimate is marked', async () => {
    const v = await viewOf([record('t1', 'running', [attempt({ phase: 'running', endedAt: null, usageEvents: 0, iterations: 0, usage: ZERO_USAGE, charge: { usd: null, basis: 'unmetered' }, wire: null })])])
    const coder = v.roles.find(r => r.role === 'coder')!
    assert.equal(coder.state, 'running'); assert.equal(coder.tokensIn, null); assert.equal(coder.usd, null); assert.equal(coder.reasoning.status, 'pending')
    const hud = stripAnsi(hudLines(v, [], frame(160, 46)).join('\n'))
    assert.match(hud, /CODER\s+DeepSeek V4\.1 Flash 1017 ★\s+cline\s+xhigh→max ◌\s+RUNNING\s+t1 · thinking\s+—\s+—/)
    // a model turn that ended without any usage event is unmetered, and says so
    const um = await viewOf([record('t1', 'running', [attempt({ phase: 'running', endedAt: null, usageEvents: 0, iterations: 1, usage: ZERO_USAGE, charge: { usd: null, basis: 'unmetered' }, wire: null })])])
    assert.match(stripAnsi(hudLines(um, [], frame(160, 46)).join('\n')), /RUNNING\s+t1 · thinking\s+—\s+unmetered/)
    const est = await viewOf([record('t1', 'completed', [attempt({ charge: { usd: 0.02, basis: 'estimate' } })])], { session: { ...liveOf([]).session, spentUsd: 0.02, estimatedTasks: ['m.t1.1'] } })
    assert.match(stripAnsi(hudLines(est, [], frame(160, 46)).join('\n')), /~\$0\.020/)
    assert.equal(est.cost.estimated, 0.02); assert.equal(est.cost.reported, 0)
  })
  test('swarm states: retrying with its delay, waiting with its admission reason, held as BLOCKED, an unresolved model as UNAVAILABLE', async () => {
    const retry = record('t1', 'queued', [attempt({ failure: 'provider_error' })], { retryAt: NOW + 7000 })
    const waiting = { ...record('t2', 'queued', [], { reason: 'waiting: concurrency: 1 of 1 slots in use' }), spec: task('t2', { kind: 'docs' }) }
    const v = await viewOf([retry, waiting])
    const coder = v.roles.find(r => r.role === 'coder')!; assert.equal(coder.state, 'retrying'); assert.equal(coder.stateText, 'RETRY 7s'); assert.match(coder.activity, /backing off · provider_error/)
    const held = await viewOf([record('t3', 'held', [attempt({ phase: 'held', endedAt: null })])])
    assert.equal(held.roles.find(r => r.role === 'coder')!.state, 'blocked')
    const c = config(); const res = await resolutions(c); res.frontend = { ok: false, role: 'frontend', provider: 'cline', model: 'qwen/qwen3.8-max-0902', reason: 'not in the catalog' }
    const un = buildView({ header: header(), live: liveOf([]), records: [], claims: [], config: c, resolutions: res, committedUsd: 0, activity: new Map(), turn: null, now: NOW })
    assert.equal(un.roles.find(r => r.role === 'frontend')!.stateText, 'UNAVAILABLE')
    void waiting
  })
  test('the five gates: skipped when not configured, pending while verifying, fail with its run, unverifiable on gate taint, stale branch runs pending', async () => {
    const pass = { name: 'test', kind: 'command' as const, state: 'pass' as const, command: 'npm test', exitCode: 0, durationMs: 10, evidence: 'ok' }
    const git = { name: 'GIT', kind: 'git' as const, state: 'pass' as const, durationMs: 1, evidence: 'scope ok' }
    const ok = await viewOf([record('t1', 'completed', [attempt({ gates: [git, pass] })])], { finalGates: [pass], finalGatesHead: 'head1234' })
    const by = (v: View, n: string): string => v.gates.find(g => g.name === n)!.state
    assert.equal(by(ok, 'TEST'), 'pass'); assert.equal(by(ok, 'TYPE'), 'skipped'); assert.equal(by(ok, 'BUILD'), 'skipped'); assert.equal(by(ok, 'GIT'), 'pass'); assert.equal(by(ok, 'SECURITY'), 'unset')
    assert.match(ok.gates[0].summary, /on branch @head1234/); assert.ok(ok.gates[0].evidence.some(x => /branch @head1234: test pass \(exit 0\) · npm test/.test(x)))
    const verifying = await viewOf([record('t1', 'verifying', [attempt()])])
    assert.equal(by(verifying, 'TEST'), 'pending')
    const failed = await viewOf([record('t1', 'failed', [attempt({ gates: [git, { ...pass, state: 'fail', exitCode: 1 }] })])])
    assert.equal(by(failed, 'TEST'), 'fail'); assert.match(failed.gates[0].summary, /t1#1: test fail exit 1/)
    const tainted = await viewOf([record('t1', 'completed', [attempt({ gates: [git, pass], gateTaint: ['package.json'] })])])
    assert.equal(by(tainted, 'TEST'), 'unverifiable')
    const stale = await viewOf([], { finalGates: [pass], finalGatesHead: 'older000' })
    assert.equal(by(stale, 'TEST'), 'pending'); assert.match(stale.gates[0].summary, /branch moved/)
    assert.equal(gateFamily('typecheck', 'tsc --noEmit'), 'TYPE'); assert.equal(gateFamily('build', 'npm run build'), 'BUILD'); assert.equal(gateFamily('exists', 'test -f x'), 'TEST'); assert.equal(gateFamily('lint', 'eslint .'), null)
  })
  test('an ended run is not a verified task: the outcome stays "no verdict yet" until the supervisor gives one', async () => {
    const v = await viewOf([record('t1', 'completed', [attempt()])])
    const hud = stripAnsi(hudLines(v, [], frame(160, 46)).join('\n'))
    assert.doesNotMatch(hud, /VERIFIED/); assert.match(hud, /no verdict yet · an ended run is not a verified task|an ended run is not a verified task/)
    const done = await viewOf([record('t1', 'completed', [attempt()])], { state: 'done', verdict: { state: 'DONE', reasons: ['1 task(s) verified'], at: '' } })
    assert.match(stripAnsi(hudLines(done, [], frame(160, 46)).join('\n')), /FINISHED · VERIFIED/)
    const partial = await viewOf([record('t1', 'completed', [attempt()])], { state: 'done', verdict: { state: 'PARTIAL', reasons: ['1 task(s) failed'], at: '' } })
    const p = stripAnsi(hudLines(partial, [], frame(160, 46)).join('\n')); assert.match(p, /FINISHED · PARTIAL/); assert.doesNotMatch(p, /VERIFIED/)
  })
  test('costs: per model and per task, remaining after in-flight reservations, cap and alerts', async () => {
    const v = await viewOf([record('t1', 'completed', [attempt()]), record('t2', 'completed', [attempt({ id: 'm.t2.1', role: 'utility', model: 'zai/glm-5.3-flash', charge: { usd: 0.002, basis: 'reported' } })])], { session: { ...liveOf([]).session, spentUsd: 0.0143, alertsFired: [0.5] } }, { committedUsd: 1.6 })
    assert.equal(v.cost.byModel[0].model, 'deepseek/deepseek-v4.1-flash-1017'); assert.equal(v.cost.byTask.length, 2)
    assert.ok(Math.abs(v.cost.remaining - 1.4) < 1e-9, 'budget minus spent and reserved')
    const hud = stripAnsi(hudLines(v, [], frame(160, 46)).join('\n'))
    assert.match(hud, /BY MODEL deepseek \$0\.012 · glm \$0\.0020/); assert.match(hud, /50% crossed/); assert.match(hud, /reserved for running workers/)
  })
  test('Kimi orchestrating is shown only while a plan task runs; DeepSeek is marked the default coder', async () => {
    const plan = { ...record('t1.plan', 'running', [attempt({ id: 'm.t1.plan.1', role: 'commander', model: 'moonshotai/kimi-k3.1-pro', phase: 'running', endedAt: null })]), spec: task('t1.plan', { kind: 'architecture', mode: 'read' }) }
    const v = await viewOf([plan])
    assert.deepEqual(v.mission.orchestrating, { task: 't1.plan', attempt: 1 })
    assert.match(stripAnsi(hudLines(v, [], frame(160, 46))[0]), /◈ KIMI ORCHESTRATING t1\.plan/)
    assert.equal(v.roles.find(r => r.role === 'coder')!.isDefault, true)
    const after = await viewOf([{ ...plan, state: 'completed', attempts: [attempt({ id: 'm.t1.plan.1', role: 'commander', model: 'moonshotai/kimi-k3.1-pro' })], children: ['t1.a', 't1.b'] }])
    assert.equal(after.mission.orchestrating, null); assert.match(after.roles[0].activity, /planned 2 task\(s\)/)
  })
})

describe('timeline: real sources only', () => {
  test('ledger entries become events with their real fields; bookkeeping is skipped', () => {
    const e = (kind: string, data: unknown, taskId: string | null = 't1') => fromLedger({ seq: 1, at: '2026-11-05T12:00:00Z', kind, task: taskId, data: data as Record<string, unknown> })
    assert.match(e('attempt_admitted', { attempt: 'm.t1.2', route: { role: 'coder', model: 'deepseek/deepseek-v4.1-flash-1017', requestedReasoning: 'xhigh', expectedWireEffort: 'max', rules: ['D'], signals: [] } })!.text, /#2 routed → coder deepseek\/deepseek-v4\.1-flash-1017 · xhigh→max/)
    assert.equal(e('next_step', { action: 'escalate', to: 'commander', reason: 'gate_failed after correction' })!.kind, 'escalate')
    assert.match(e('next_step', { action: 'retry_same', delayMs: 2100, reason: 'transient' })!.text, /retry on the same model in 3s/)
    assert.equal(e('gates', { attempt: 'm.t1.1', gates: [{ name: 'GIT', state: 'pass' }, { name: 'test', state: 'fail', exit: 1, evidence: 'x' }] })!.tone, 'fail')
    assert.match(e('final_gates', { head: 'abcdef1234', gates: [{ name: 'test', state: 'pass' }] }, null)!.text, /branch gates @abcdef12 test ✓/)
    assert.match(e('final_gates', [{ name: 'test', state: 'pass' }], null)!.text, /test ✓/, 'the older array shape still reads')
    assert.equal(e('ownership_released', {}), null); assert.equal(e('mission_created', {}), null)
  })
  test('worker stream events: edits, commands, test runs and scans; text only updates the activity', () => {
    const tool = (toolName: string, input: unknown) => ({ type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName, input } })
    assert.equal(fromWorker('t1', 'a', tool('editor', { path: '/x/worktrees/m/t1-1/src/a.ts' }), NOW)!.text, 'editor src/a.ts')
    assert.equal(fromWorker('t1', 'a', tool('run_commands', { commands: ['npm test'] }), NOW)!.kind, 'test')
    assert.equal(fromWorker('t1', 'a', tool('run_commands', { commands: ['ls -la'] }), NOW)!.kind, 'command')
    assert.equal(fromWorker('t1', 'a', tool('search_codebase', { query: 'divide' }), NOW)!.kind, 'scan')
    const tl = new Timeline()
    tl.worker('t1', 'a', { type: 'agent_event', event: { type: 'content_start', contentType: 'text', text: 'hello' } })
    assert.equal(tl.events.length, 0); assert.equal(tl.activity.get('a')?.last, 'writing its answer')
    tl.worker('t1', 'a', tool('editor', { path: 'src/a.ts' })); tl.worker('t1', 'a', tool('run_commands', { commands: ['npm test'] }))
    const a = tl.activity.get('a')!; assert.equal(a.tools, 2); assert.equal(a.edits.size, 1); assert.equal(a.tests, 1)
  })
  test('the ledger tail reads only new bytes, keeps a torn last line and a split multi-byte character for the next poll', () => {
    const dir = join(tmp('ledger'), 'ledger'); mkdirSync(dir, { recursive: true })
    const f = join(dir, 'seg-000001.jsonl')
    const line = (seq: number, text: string) => `${JSON.stringify({ seq, at: '2026-11-05T12:00:00Z', kind: 'stop_requested', task: null, data: { why: text } })}\n`
    writeFileSync(f, line(1, 'one'))
    const t = new LedgerTail(dir)
    assert.equal(t.poll().length, 1); assert.equal(t.poll().length, 0)
    const two = Buffer.from(line(2, 'naïve ✓'))
    const cut = two.indexOf(0xe2, two.indexOf(0x20, 60)) + 1
    appendFileSync(f, Uint8Array.from(two.subarray(0, cut)))
    assert.equal(t.poll().length, 0, 'a torn line waits')
    appendFileSync(f, Uint8Array.from(two.subarray(cut)))
    const got = t.poll(); assert.equal(got.length, 1); assert.equal((got[0].data as { why: string }).why, 'naïve ✓')
    writeFileSync(join(dir, 'seg-000002.jsonl'), line(3, 'next segment'))
    assert.equal(t.poll()[0].seq, 3)
  })
})

describe('rendering at every size', () => {
  const busy = async (): Promise<{ v: View; events: ReturnType<Timeline['events']['slice']> }> => {
    const tasks = [
      record('t1', 'completed', [attempt({ gates: [{ name: 'GIT', kind: 'git', state: 'pass', durationMs: 1, evidence: 'ok' }] })]),
      record('t2.plan', 'running', [attempt({ id: 'm.t2.plan.1', role: 'commander', model: 'moonshotai/kimi-k3.1-pro', phase: 'running', endedAt: null, usageEvents: 0, usage: ZERO_USAGE, charge: { usd: null, basis: 'unmetered' } })]),
      record('t3', 'queued', [attempt({ id: 'm.t3.1', role: 'specialist', model: 'xiaomi/mimo-v2.6-pro', failure: 'provider_error', mapping: 'toggle' })], { retryAt: NOW + 5000 }),
      record('t4-with-a-very-long-task-identifier-that-goes-on', 'failed', [attempt({ id: 'm.t4.1', role: 'frontend', model: 'qwen/qwen3.8-max-0902', failure: 'gate_failed', failureDetail: 'test fail\nwith a second line', changes: ['a/very/long/path/that/keeps/going/and/going/component.tsx'] })]),
    ]
    const tl = new Timeline()
    for (let i = 0; i < 300; i++) tl.push(fromWorker('t1', 'm.t1.1', { type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName: 'run_commands', input: { commands: [`echo step ${i} 漢字 ${'x'.repeat(i % 50)}`] } } }, NOW))
    return { v: await viewOf(tasks, { alerts: ['provider cline/xiaomi/mimo-v2.6-pro breaker OPEN after 2 error(s)'] }), events: tl.events }
  }
  test('the HUD fits every width from 40 to 240 columns and every colour mode, never reaching the last column', async () => {
    const { v, events } = await busy()
    for (const mode of ['none', '16', '256', 'truecolor'] as const) for (const cols of [40, 50, 60, 72, 79, 80, 99, 100, 119, 120, 149, 150, 200, 240]) for (const rows of [12, 24, 30, 40, 60]) {
      for (const l of hudLines(v, events, frame(cols, rows, mode, true))) assert.ok(vlen(l) <= cols - 1, `${mode} ${cols}×${rows}: ${vlen(l)} wide: ${stripAnsi(l)}`)
    }
  })
  test('Mission Control: every tab, selected and expanded, fills exactly rows-1 lines that fit', async () => {
    const { v, events } = await busy()
    for (const { tab } of TABS) for (const cols of [40, 80, 160]) for (const rows of [12, 30, 50]) for (const expanded of [false, true]) {
      const out = missionControlLines({ tab, sel: 2, expanded, filter: null }, v, events, frame(cols, rows, 'truecolor'))
      assert.equal(out.lines.length, rows - 1, `${tab} ${cols}×${rows}`)
      for (const l of out.lines) assert.ok(vlen(l) <= cols - 1, `${tab} ${cols}×${rows}: ${stripAnsi(l)}`)
    }
  })
  test('the timeline view windows a long history around the selection and filters by agent', async () => {
    const { v, events } = await busy()
    const last = missionControlLines({ tab: 'timeline', sel: Number.MAX_SAFE_INTEGER, expanded: false, filter: null }, v, events, frame(120, 30))
    const text = stripAnsi(last.lines.join('\n'))
    assert.equal(last.count, 300); assert.match(text, /echo step 299/); assert.match(text, /300 of 300/)
    const first = stripAnsi(missionControlLines({ tab: 'timeline', sel: 0, expanded: true, filter: null }, v, events, frame(120, 30)).lines.join('\n'))
    assert.match(first, /echo step 0 /); assert.match(first, /│ echo step 0/); assert.match(first, /1 of 300/)
    assert.equal(missionControlLines({ tab: 'timeline', sel: 0, expanded: false, filter: 'UTILITY' }, v, events, frame(120, 30)).count, 0)
  })
  test('rendering is fast enough never to hold up the supervisor: 2000 records and 5000 events in well under a frame budget', async () => {
    const c = config(); const res = await resolutions(c)
    const tasks = Array.from({ length: 2000 }, (_, i) => record(`t${i}`, i % 7 ? 'completed' : 'failed', [attempt({ id: `m.t${i}.1`, role: (['coder', 'utility', 'commander', 'specialist', 'frontend'] as const)[i % 5] })]))
    const tl = new Timeline(); for (let i = 0; i < 5000; i++) tl.push(fromWorker(`t${i % 2000}`, `m.t${i % 2000}.1`, { type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName: 'editor', input: { path: `src/f${i}.ts` } } }, NOW))
    const lv = liveOf(tasks.slice(-20))
    const t0 = performance.now()
    for (let i = 0; i < 10; i++) {
      const v = buildView({ header: header(), live: lv, records: tasks, claims: [], config: c, resolutions: res, committedUsd: 0, activity: tl.activity, turn: 't1999', now: NOW })
      hudLines(v, tl.events, frame(200, 60, 'truecolor', true))
    }
    const per = (performance.now() - t0) / 10
    assert.ok(per < 60, `one frame took ${per.toFixed(1)} ms`)
  })
})
