import { describe, expect, test } from 'claude-code/testing'
import { addAgent, adoptAgent, beginTool, checkpointOf, classicTelemetry, emptyLedger, elapsed, exportJSON, finishTool, finishTurn, ledgerLines, migrateLedger, LIMITS, reading, receipts, recordRequest, startRun, storageLedger, jsonBytes, STORE_LEDGER_BYTES, UNKNOWN, withReplay } from '../hooks/ledger'
import type { Ledger } from '../hooks/ledger'
import { appendReplay, diffLines, REPLAY_BYTES, REPLAY_MAX, replayStep, safeFile } from '../hooks/replay'
import type { ReplayStep } from '../hooks/replay'
import { eventOf } from '../hooks/nwho'
import { desiredRequest, policyMismatch } from '../hooks/model-policy'
import { advance, orchestrationGraph, orchestrationTape, RESTING } from '../hooks/field'
import { newTask, applyAction } from '../hooks/model'
import { hostState, world, start, prompt, rowsOf, fieldRowsOf, mountHud, progress } from './world'
const run = () => startRun(emptyLedger('s1'), 't1', 1000)
const agent = (l = run(), id = 'a1', parentAgentId?: string) => addAgent(l, { agentId: id, subagentType: 'explorer', description: 'Inspect auth', requestedModel: 'sonnet', model: 'claude-sonnet-5-5', parentAgentId, background: true }, 1200)
const usage = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }
const snapshot = (over: Partial<ReplayStep> = {}): ReplayStep => ({ id: 'e1', runId: 's1:t1', turnId: 't1', agentId: UNKNOWN, file: '/work/a.ts', kind: 'Edit', at: 1500, before: 'const a = 1', after: 'const a = 2', scope: 'fragment', omitted: false, ...over })
const receipt = (over: Record<string, unknown> = {}) => JSON.stringify({ operation: 'prune', caller: 'claude', tier: 1, request_id: 'r1', latency_ms: 37, ts: '2026-10-03T11:00:00Z', attempts: [{ judged_blocks: 4, dropped_blocks: 2 }], ...over })
const slash = ($: Parameters<typeof start>[0], command: string, args = '') => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
const step = async ($: Parameters<typeof start>[0], agentId?: string, model = 'claude-opus-5-5', effort?: 'low' | 'high' | 'medium') => {
  const stream = $.turn.step({ turnId: agentId ? 'ta1' : 't1', index: 0, model, messageCount: 2, ...(agentId ? { agentId } : {}), ...(effort ? { effort } : {}) })
  let r = await stream.next()
  while (!r.done) r = await stream.next()
  return r.value
}
let spawnSeq = 0
const spawn = async ($: Parameters<typeof start>[0], model?: string, over: Record<string, unknown> = {}) => {
  const taskId = `ledger-task-${++spawnSeq}`
  await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', action: 'assign', task_id: taskId, tier: 'SONNET', role: 'EXPLORER', objective: `Read auth ${taskId}`, scope: 'Synthetic read-only discovery', owned_resources: [`/work/synthetic/${taskId}`], mode: 'read', dependencies: [], spawn_reason: 'Independent ledger fixture' } as never)
  return $.agent.spawn({ prompt: 'Read auth', subagentType: 'explorer', tool_use_id: 'spawn1', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false, ...(model ? { model } : {}), ...over, description: `[task:${taskId}] Inspect auth` } as never)
}
const complete = ($: Parameters<typeof start>[0], turnId: string, agentId?: string) => $.turn.complete({ turnId, answer: 'ok', reason: 'answer', durationMs: 100, isAborted: false, ...(agentId ? { agentId } : {}) })

describe('bounded execution accounting', () => {
  test('main model and effort come from the real response and request', () => {
    const l = recordRequest(run(), { turnId: 't1', index: 0, model: 'opus', effort: 'low' }, { model: 'claude-opus-5-5', effort: 'high', usage })
    expect(l.runs[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(l.requests[0]).toMatchObject({ requestedModel: 'opus', requestedEffort: 'low', input: 10, output: 5, cacheRead: 4, cacheWrite: 2 })
  })
  test('request identity deduplicates tokens', () => {
    const e = { turnId: 't1', index: 0, model: 'opus' }
    const a = recordRequest(run(), e, { usage })
    expect(recordRequest(a, e, { usage }).requests.length).toBe(1)
  })
  test('subagent role, choice, actual and origin are distinct', () => {
    const l = recordRequest(agent(), { turnId: 'ta1', index: 0, model: 'haiku', effort: 'low', agentId: 'a1' }, { model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(l.agents[0]).toMatchObject({ role: 'EXPLORER', runId: 's1:t1', originTurn: 't1', requestedModel: 'sonnet', requestedEffort: 'low', model: 'claude-sonnet-5-5', effort: 'medium' })
  })
  test('nested child remains on its ancestor run with a real parent', () => {
    const l = recordRequest(agent(), { turnId: 'ta1', index: 0, model: 'sonnet', agentId: 'a1' }, { model: 'claude-sonnet-5-5' })
    expect(agent(l, 'a2', 'a1').agents[1]).toMatchObject({ runId: 's1:t1', originTurn: 'ta1', parentAgent: 'a1' })
  })
  test('background agent survives parent completion and another turn', () => {
    const l = startRun(finishTurn(agent(), { turnId: 't1', reason: 'answer' }, 2000), 't2', 2200)
    const noted = beginTool(l, { tool: 'Read', tool_use_id: 'read1', file_path: '/work/a.ts', agentId: 'a1' }, 2300)
    expect(noted.agents[0]).toMatchObject({ runId: 's1:t1', status: 'running' })
    expect(noted.tools[0]?.runId).toBe('s1:t1')
    expect(noted.runs[0]?.counts.tools).toBe(1)
    expect(noted.runs[1]?.counts.tools).toBe(0)
  })
  test('no duplicate agent id', () => { expect(agent(agent()).agents.length).toBe(1) })
  test('no duplicate tool_use_id or failure', () => {
    const e = { tool: 'Read', tool_use_id: 'r1', file_path: '/work/a' }
    let l = beginTool(run(), e, 1000)
    l = beginTool(l, e, 1001)
    l = finishTool(finishTool(l, 'r1', true, 1200), 'r1', true, 1300)
    expect(l.runs[0]?.counts).toMatchObject({ tools: 1, failures: 1, reads: 1 })
  })
  test('latest action uses safe tool/file fields', () => {
    const l = beginTool(agent(), { tool: 'Bash', tool_use_id: 'b1', command: 'npm test --token secret-value', agentId: 'a1' }, 1500)
    expect(l.agents[0]?.latest).toBe('Bash TEST')
    expect(JSON.stringify(l)).not.toContain('secret-value')
  })
  test('elapsed time uses observed start/end', () => { expect(elapsed(1000, 2000, 5000)).toBe(1000); expect(elapsed(1000, UNKNOWN, 5000)).toBe(4000); expect(elapsed(UNKNOWN, UNKNOWN, 5000)).toBe(UNKNOWN) })
  test('repeated commands are not automatically retries', () => {
    let l = run()
    for (let n = 0; n < 3; n++) l = beginTool(l, { tool: 'Bash', tool_use_id: `b${n}`, command: 'npm test' }, n)
    expect(l.runs[0]?.counts.retries).toBe(UNKNOWN)
  })
  test('tests/builds/git are actual operation families', () => {
    let l = run()
    for (const [id, command] of [['t', 'npm test'], ['b', 'npm run build'], ['g', 'git status']]) l = beginTool(l, { tool: 'Bash', tool_use_id: id, command }, 1000)
    expect(l.runs[0]?.counts).toMatchObject({ tools: 3, tests: 1, builds: 1, git: 1 })
  })
  test('read/edit/write counters are separate', () => {
    let l = run()
    for (const tool of ['Read', 'Edit', 'Write']) l = beginTool(l, { tool, tool_use_id: tool, file_path: '/a' }, 1000)
    expect(l.runs[0]?.counts).toMatchObject({ reads: 1, edits: 1, writes: 1 })
  })
  test('unknown values remain unknown', () => {
    const l = reading(recordRequest(run(), { turnId: 't1', index: 0, model: 'opus' }, {}), {}, 1000)
    expect(l.requests[0]).toMatchObject({ model: UNKNOWN, effort: UNKNOWN, input: UNKNOWN, cacheRead: UNKNOWN })
    expect(l.usage[0]).toMatchObject({ tokens: UNKNOWN, window: UNKNOWN, percent: UNKNOWN })
  })
  test('context history retains reported values and is bounded', () => {
    let l = run()
    for (let n = 0; n < 100; n++) l = reading(l, { tokens: n, window: 1000, percent: n }, n)
    expect(l.usage.length).toBe(LIMITS.usage)
    expect(l.usage.at(-1)).toMatchObject({ tokens: 99, percent: 99 })
  })
  test('identical readings cause no state change', () => { const l = reading(run(), { tokens: 1, window: 100 }, 1); expect(reading(l, { tokens: 1, window: 100 }, 2)).toBe(l) })
  test('bounded tool and run history preserves active origins', () => {
    let l = agent()
    for (let n = 0; n < 600; n++) { l = startRun(l, `turn${n}`, n); l = finishTool(beginTool(l, { tool: 'Read', tool_use_id: `read${n}` }, n), `read${n}`, false, n) }
    expect(l.tools.length).toBe(LIMITS.tools)
    expect(l.runs.some(r => r.id === 's1:t1')).toBe(true)
    expect(l.runs.length).toBeLessThanOrEqual(LIMITS.runs + 1)
  })
})

describe('NobodyWho uses only real receipts', () => {
  for (const caller of ['cline', 'opendots', 'codex']) test(`caller ${caller} is excluded`, () => { expect(eventOf(receipt({ caller }))).toBeNull() })
  for (const [tier, name] of [[0, 'P0'], [1, '0.6B'], [2, '9B']] as const) test(`Decision tier ${name}`, () => { expect(eventOf(receipt({ operation: 'ask', tier }))?.tier).toBe(name) })
  for (const [tier, name] of [[0, 'P0'], [1, 'Q4B'], [2, '9B']] as const) test(`Pruning tier ${name}`, () => { expect(eventOf(receipt({ tier }))?.tier).toBe(name) })
  test('pruning never manufactures a Decision', () => { const l = receipts(run(), [eventOf(receipt())!]); expect(l.receipts.filter(e => e.op === 'decision').length).toBe(0); expect(ledgerLines(l, 1000).join('\n')).toContain('DECISION P0 0 · 0.6B 0 · 9B 0') })
  test('real proposed/accepted/rejected counts', () => { expect(eventOf(receipt())).toMatchObject({ proposed: 4, accepted: 2, rejected: 2 }) })
  test('explicit decision acceptance and abstention', () => { expect(eventOf(receipt({ operation: 'ask', accepted: false, abstain: true, choice: 'inspect' }))).toMatchObject({ proposed: 1, accepted: 0, rejected: 1, route: null, abstention: true }) })
  test('JEV tier is never retained', () => { expect(eventOf(receipt({ tier: 3 }))).toBeNull() })
  test('receipt stable IDs deduplicate', () => { const e = eventOf(receipt())!; expect(receipts(receipts(run(), [e]), [e]).receipts.length).toBe(1) })
  test('raw prompts and reasoning are discarded', () => { const e = eventOf(receipt({ question: 'private-question', details: { reasoning: 'hidden' }, token: 'secret' }))!; expect(JSON.stringify(e)).not.toMatch(/private-question|hidden|secret/) })
})

describe('replay and deterministic checkpoint', () => {
  test('Edit stores fragment before and after', () => { const l = withReplay(run(), snapshot()); expect(l.replay[0]).toMatchObject({ kind: 'Edit', before: 'const a = 1', after: 'const a = 2', scope: 'fragment' }); expect(diffLines(l.replay[0]!).join('\n')).toContain('+ const a = 2') })
  test('Write stores a bounded file delta', () => { const s = replayStep(snapshot({ kind: 'Write', scope: 'file', before: 'a\nb\nc', after: 'a\nd\nc' })); expect(diffLines(s)).toEqual(['@@ file delta · line 2 @@', '- b', '+ d']) })
  test('replay stable ID deduplicates', () => { expect(appendReplay(appendReplay([], snapshot()), snapshot()).length).toBe(1) })
  test('replay bounds exclude huge complete files', () => { expect(replayStep(snapshot({ before: 'a'.repeat(20000) }))).toMatchObject({ before: '', after: '', omitted: true }) })
  test('replay total bytes and step count are bounded', () => { let s: ReplayStep[] = []; for (let n = 0; n < 100; n++) s = appendReplay(s, snapshot({ id: String(n), before: 'a'.repeat(4000), after: 'b'.repeat(4000) })); expect(s.length).toBeLessThanOrEqual(REPLAY_MAX); expect(JSON.stringify(s).length).toBeLessThanOrEqual(REPLAY_BYTES) })
  test('secret files and secret content are excluded', () => { expect(safeFile('/repo/.env.local')).toBe(UNKNOWN); expect(replayStep(snapshot({ after: 'API_KEY=super-secret-token' })).omitted).toBe(true) })
  test('checkpoint is deterministic and excludes the raw prompt', () => {
    const task = applyAction(newTask(1, '', 1000, null), { action: 'plan', goal: 'Fix auth', milestones: [{ title: 'Inspect' }, { title: 'Verify' }] }, 1000, null).task
    const c = checkpointOf(agent(), task, null, 2000)
    expect(c).toEqual(checkpointOf(agent(), task, null, 2000))
    expect(c).toMatchObject({ goal: 'Fix auth', phase: 'RESEARCH', completed: [], remaining: ['Inspect', 'Verify'], backgroundAgents: ['a1'], branch: UNKNOWN })
    expect(JSON.stringify(c)).not.toContain('lastPrompt')
  })
  test('JSON export excludes snapshots and free checkpoint prose', () => { let l = withReplay(agent(), snapshot({ before: 'private repo content' })); l = { ...l, checkpoint: { ...checkpointOf(l, null, null, 1000), goal: 'private goal' } }; const out = exportJSON(l); expect(JSON.parse(out).schema).toBe(2); expect(out).not.toMatch(/private repo content|private goal|Inspect auth/) })
  test('ledger renders all nine dossier sections', () => { const text = ledgerLines(agent(), 2000, 'SUBSCRIPTION').join('\n'); for (const name of ['01 RUN', '02 ORCHESTRATION', '03 SUBAGENTS', '04 NOBODYWHO', '05 USAGE', '06 FILES', '07 FAILURES', '08 VERIFICATION', '09 REPLAY']) expect(text).toContain(name); expect(text).toContain('AUTH / SUBSCRIPTION'); expect(text).toContain('ACTUAL claude-sonnet-5-5') })
})

describe('policy and Activity Field topology', () => {
  test('Opus high coordinator allowed', () => { expect(policyMismatch('claude-opus-5-5', 'high')).toBeNull() })
  test('Sonnet medium worker allowed', () => { expect(policyMismatch('claude-sonnet-5-5', 'medium', 'a1')).toBeNull() })
  test('invalid model and effort produce a mismatch', () => { expect(policyMismatch('haiku', 'low', 'a1')).toContain('MODEL POLICY') })
  test('supported request constraints are exact 5.5 models', () => { expect(desiredRequest()).toEqual({ model: 'claude-opus-5-5', effort: 'high' }); expect(desiredRequest('a1')).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' }); expect(desiredRequest('h1', 'HAIKU')).toEqual({ model: 'claude-haiku-5-5' }) })
  test('no spawn means no orchestration graph', () => { expect(orchestrationGraph(run())).toBeNull(); expect(orchestrationTape(run(), 100)).toBeNull() })
  test('actual parallel agents make separate graph branches', () => { const l = agent(agent(), 'a2'); expect(orchestrationGraph(l)?.branches.length).toBe(2); expect(orchestrationTape(l, 100)?.text).toContain('┬') })
  test('completion converges to integrate', () => { const l = finishTurn(agent(), { turnId: 'ta1', agentId: 'a1', reason: 'answer' }, 3000); expect(orchestrationGraph(l)?.label).toBe('MAIN / INTEGRATE'); expect(orchestrationTape(l, 100)?.text).toContain('┴') })
  test('crawler traverses actual orchestration anchors', () => { const tape = orchestrationTape(agent(), 100)!; const w = advance(RESTING, tape, 'work', { now: 2000, reducedMotion: false }); expect(tape.anchors.some(a => a.at === w.on || a.detailAt === w.on)).toBe(true) })
})

describe('ledger through the installed engine test harness', () => {
  test('main/subagent usage, background origin and policy requests', { options: { orchestration: true } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await $.turn.start({ turnId: 't1', text: 'private prompt' }); await step($, undefined, 'haiku', 'low')
    const spawned = await spawn($, 'opus'); const id = spawned.agentId!
    await step($, id, 'haiku', 'high'); await complete($, 't1'); await $.turn.start({ turnId: 't2', text: 'continue' })
    await $.tool.call({ tool: 'Read', tool_use_id: 'read1', file_path: '/work/a.ts', agentId: id } as never)
    await complete($, 'ta1', id)
    const l = held.get('run-ledger')?.value as Ledger
    expect(l.runs[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', status: 'success' })
    expect(l.agents[0]).toMatchObject({ runId: `${l.sessionId}:t1`, model: 'claude-sonnet-5-5', effort: 'medium', status: 'success' })
    expect(l.agents[0]?.counts.tools).toBe(1)
    expect(w.requests.map(r => r.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(w.outbound).toEqual([])
  })
  test('explicit three-agent resource budget remains supported', { options: { orchestration: true, maxSubagents: 3 } }, async ($, on) => { const w = world(on); await start($); for (let n = 0; n < 3; n++) await spawn($, 'sonnet', { tool_use_id: `spawn${n}` }); expect((await spawn($)).deny).toContain('SUBAGENT LIMIT / 3'); expect(w.spawns.length).toBe(3) })
  test('fork refusing inherited coordinator prevents an invalid agent', { options: { orchestration: true } }, async ($, on) => { const w = world(on); await start($); expect((await spawn($, 'opus', { fork: true })).deny).toContain('fork'); expect(w.spawns.length).toBe(0) })
  test('successful Edit and Write appear in replay; failures do not', async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($); await $.turn.start({ turnId: 't1', text: '' })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/work/new.ts', content: 'new content' } as never)
    w.failingTools.push('Edit'); await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/work/a.ts', old_string: 'b', new_string: 'c' } as never)
    const l = held.get('run-ledger')?.value as Ledger
    expect(l.replay.map(s => s.kind)).toEqual(['Edit', 'Write']); expect(l.replay[1]?.before).toBe('')
    await slash($, 'replay'); expect(w.opened).toContain('cobalt-replay')
  })
  test('/park and /ledger export make zero model calls and keep no raw commands', async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($); await prompt($, 'private raw prompt'); await $.turn.start({ turnId: 't1', text: 'private raw prompt' })
    await progress($, { action: 'plan', goal: 'Fix auth', milestones: [{ title: 'Inspect' }, { title: 'Verify' }] })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test --token private-secret-value' } as never)
    expect((await slash($, 'park')).text).toContain('PARKED')
    const exported = (await slash($, 'ledger', 'export json')).text
    expect(JSON.parse(exported!).schema).toBe(2); expect(exported).not.toMatch(/private raw prompt|private-secret-value/)
    await slash($, 'ledger'); expect(w.opened).toContain('cobalt-run-ledger'); expect(w.outbound).toEqual([]); expect(w.requests).toEqual([])
    expect((held.get('run-ledger')?.value as Ledger).checkpoint?.goal).toBe('Fix auth')
  })
  test('hot reload retains background agents and deduplication state', async ($, on) => {
    world(on); const seed = agent(); const held = hostState(on, { 'run-ledger': { ...seed, sessionId: 'mock-session' } })
    // Seed the host with its own session id, as a reload does.
    on('session.id', () => ({ value: 'mock-session' }))
    await start($); expect((held.get('run-ledger')?.value as Ledger).agents[0]?.id).toBe('a1')
  })
  test('Cockpit field and existing strips carry real agents', async ($, on) => {
    world(on); await start($); await $.turn.start({ turnId: 't1', text: '' }); await spawn($)
    const hud = await mountHud($, 'terminal', 120, true)
    expect((await fieldRowsOf(hud)).join('\n')).toContain('SONNET ×1')
    expect((await rowsOf(hud)).join('\n')).toContain('EXPLORER')
    expect((await rowsOf(hud)).join('\n')).not.toContain('COBALT CONTROL / RUN LEDGER')
    await hud.unmount()
  })
})

describe('durable resume and dossier surfaces', () => {
  test('a persisted checkpoint appears on resume and collapses on a prompt', async ($, on) => {
    const l = { ...agent(), checkpoint: checkpointOf(agent(), null, null, 2000) }
    const w = world(on, {}, { 'ledger:s1': l })
    on('session.id', () => ({ value: 's1' }))
    await start($)
    const hud = await mountHud($, 'terminal', 120)
    expect((await rowsOf(hud)).join('\n')).toContain('COBALT / RESUME')
    expect(w.toasts.some(t => t.includes('COBALT / RESUME'))).toBe(true)
    await prompt($, 'Continue')
    expect((await rowsOf(hud)).join('\n')).not.toContain('COBALT / RESUME')
    expect(w.outbound).toEqual([])
    await hud.unmount()
  })
  test('ledger and replay panes mount on terminal and desktop without model calls', async ($, on) => {
    const w = world(on); await start($); await $.turn.start({ turnId: 't1', text: '' })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/a.ts', old_string: 'old', new_string: 'new' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const requestId of ['cobalt-run-ledger', 'cobalt-replay']) {
        const pane = await $.ui.mount({ plugin: 'cobalt-cockpit', surface, component: 'Pane', requestId, props: { title: 'Cobalt', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }, viewport: { columns: 120, rows: 80, isFullscreen: true } })
        const text = (await rowsOf(pane)).join('\n')
        expect(text).toContain(requestId === 'cobalt-run-ledger' ? 'COBALT CONTROL / RUN LEDGER' : 'COBALT / REPLAY')
        if (requestId === 'cobalt-replay') { expect(text).toContain('- old'); expect(text).toContain('+ new') }
        await pane.unmount()
      }
    }
    expect(w.outbound).toEqual([]); expect(w.requests).toEqual([])
  })
  test('ledger persists through the host store at /park', async ($, on) => {
    world(on); const held = hostState(on, {}); on('session.id', () => ({ value: 'durable-session' }))
    await start($); await $.turn.start({ turnId: 't1', text: '' }); await slash($, 'park')
    held.get('run-ledger')!.value = emptyLedger()
    await start($)
    expect(held.get('run-ledger')?.value).toMatchObject({ schema: 2, sessionId: 'durable-session', currentRun: 'durable-session:t1' })
  })
  test('a background origin captured before delayed spawn is preserved', () => {
    const prior = run(); const current = startRun(prior, 't2', 3000)
    const l = addAgent(current, { agentId: 'late', subagentType: 'worker', originRun: prior.currentRun, originTurn: prior.turns['main'] }, 1000)
    expect(l.agents[0]).toMatchObject({ runId: 's1:t1', originTurn: 't1', start: 1000 })
  })
  test('missing abstention remains unknown rather than false', () => { expect(eventOf(receipt())?.abstention).toBeUndefined() })
})


test('durable ledgers fit below the host store budget without losing live agents', () => {
  let l = agent()
  for (let n = 0; n < 600; n++) l = beginTool(l, { tool: 'Read', tool_use_id: `r${n}`, file_path: '/work/' + 'f'.repeat(200) }, n)
  const stored = storageLedger(l)
  expect(JSON.stringify(stored).length).toBeLessThanOrEqual(STORE_LEDGER_BYTES)
  expect(stored.agents[0]?.id).toBe('a1')
  expect(stored.runs[0]?.counts.tools).toBe(600)
})


test('adopted existing agents have unknown start/model/effort and real status', () => {
  const l = adoptAgent(run(), { id: 'prior', type: 'explorer', description: 'Read source', status: 'running', parentId: 'parent', spawnedBy: 'engine' })
  expect(l.agents[0]).toMatchObject({ start: UNKNOWN, model: UNKNOWN, effort: UNKNOWN, runId: UNKNOWN, originTurn: UNKNOWN, status: 'running', parentAgent: 'parent', source: 'engine' })
})


test('spawn evidence attaches early adopted tools to the actual originating run once', () => {
  let l = adoptAgent(run(), { id: 'late', type: 'worker', description: 'Work', status: 'running' })
  l = beginTool(l, { tool: 'Read', tool_use_id: 'early', file_path: '/work/a', agentId: 'late' }, 1100)
  l = addAgent(l, { agentId: 'late', subagentType: 'worker', originRun: 's1:t1', originTurn: 't1', model: 'claude-sonnet-5-5' }, 1000)
  expect(l.tools[0]?.runId).toBe('s1:t1')
  expect(l.runs[0]?.counts.tools).toBe(1)
  expect(addAgent(l, { agentId: 'late', subagentType: 'worker' }, 1200).runs[0]?.counts.tools).toBe(1)
})

test('an unknown origin never creates a fake orchestration edge', () => {
  const l = adoptAgent(run(), { id: 'prior', type: 'worker', description: 'Work', status: 'running' })
  expect(orchestrationGraph(l)).toBeNull()
})

test('background topology remains rooted in its originating run during the next turn', () => {
  const l = startRun(agent(), 't2', 3000)
  expect(orchestrationGraph(l)?.runId).toBe('s1:t1')
  expect(orchestrationTape(l, 100)?.anchors[0]?.event.id).toBe('s1:t1')
})


test('replay excludes JSON credentials, short passwords and bearer headers', () => {
  for (const after of ['{"password":"abc"}', 'Authorization: Bearer private-token-value', '{"api_key":"private-token"}']) expect(replayStep(snapshot({ after })).omitted).toBe(true)
})


test('effective effort, native tool duration and MCP provenance use exposed classic fields', () => {
  let l = recordRequest(agent(), { turnId: 'ta1', index: 0, agentId: 'a1', model: 'sonnet', effort: 'medium' }, { model: 'claude-sonnet-5-5', effort: 'medium' })
  l = beginTool(l, { tool: 'mcp__local__read', tool_use_id: 'm1', agentId: 'a1' }, 1000)
  l = classicTelemetry(l, { tool_use_id: 'm1', agent_id: 'a1', effort: { level: 'low' }, duration_ms: 31, mcp_server: { name: 'local', source: 'plugin' } })
  expect(l.agents[0]).toMatchObject({ effort: 'low', effortSource: 'engine' })
  expect(l.requests.at(-1)?.effectiveEffort).toBe('low')
  expect(l.tools[0]).toMatchObject({ durationMs: 31, source: 'local (plugin)' })
})

test('a request the engine resolved itself is the engine own level, and already an observation', () => {
  const l = recordRequest(agent(), { turnId: 'ta1', index: 0, agentId: 'a1', model: 'sonnet', effort: 'high' }, { model: 'claude-sonnet-5-5', effort: 'medium', via: 'host', fallbackReason: 'the engine resolved medium' })
  expect(l.agents[0]).toMatchObject({ requestedEffort: 'high', effort: 'medium', effortSource: 'engine', effortVia: 'host', effectiveEffort: 'medium', fallbackReason: 'the engine resolved medium' })
  expect(l.requests.at(-1)).toMatchObject({ requestedEffort: 'high', effort: 'medium', effectiveEffort: 'medium' })
  expect(ledgerLines(l, 2000, 'subscription').join('\n')).toContain('ACTUAL claude-sonnet-5-5 · medium (engine) · observed medium · fallback the engine resolved medium')
})

test('a request whose effort this plugin rewrote is requested, never observed, whatever the engine reports', () => {
  let l = recordRequest(agent(), { turnId: 'ta1', index: 0, agentId: 'a1', model: 'sonnet', effort: 'high' }, { model: 'claude-sonnet-5-5', effort: 'high', via: 'hook' })
  expect(l.agents[0]).toMatchObject({ effort: 'high', effortSource: 'request', effortVia: 'hook' })
  expect(l.agents[0]?.effectiveEffort).toBeUndefined()
  l = beginTool(l, { tool: 'Bash', tool_use_id: 'b1', agentId: 'a1' }, 1000)
  // the engine reports the loop's own level, which the rewrite is not in
  l = classicTelemetry(l, { tool_use_id: 'b1', agent_id: 'a1', effort: { level: 'medium' }, duration_ms: 12 })
  expect(l.agents[0]).toMatchObject({ effort: 'high', effortSource: 'request' })
  expect(l.agents[0]?.effectiveEffort).toBeUndefined()
  expect(l.requests.at(-1)?.effectiveEffort).toBe('unknown')
  // the rest of the telemetry is the tool's own and still lands
  expect(l.tools[0]).toMatchObject({ durationMs: 12 })
  expect(ledgerLines(l, 2000, 'subscription').join('\n')).toContain('ACTUAL claude-sonnet-5-5 · high (request) · observed unknown')
})

test('the main run follows the same rule as an agent', () => {
  let l = recordRequest(run(), { turnId: 't1', index: 0, model: 'opus', effort: 'high' }, { model: 'claude-opus-5-5', effort: 'high', via: 'hook' })
  l = beginTool(l, { tool: 'Bash', tool_use_id: 'b1' }, 1000)
  l = classicTelemetry(l, { tool_use_id: 'b1', effort: { level: 'medium' } })
  expect(l.runs[0]).toMatchObject({ effort: 'high', effortSource: 'request', effortVia: 'hook' })
  expect(l.runs[0]?.effectiveEffort).toBeUndefined()
  l = recordRequest(l, { turnId: 't1', index: 1, model: 'opus', effort: 'high' }, { model: 'claude-opus-5-5', effort: 'high', via: 'host' })
  l = classicTelemetry(l, { tool_use_id: 'b1', effort: { level: 'high' } })
  expect(l.runs[0]).toMatchObject({ effort: 'high', effortSource: 'engine', effortVia: 'host', effectiveEffort: 'high' })
})


test('durable storage bounds count UTF-8 bytes for Unicode repository paths', () => {
  let l = agent()
  for (let n = 0; n < 600; n++) l = finishTool(beginTool(l, { tool: 'Read', tool_use_id: `u${n}`, file_path: '/work/' + '界'.repeat(230) }, n), `u${n}`, false, n)
  expect(jsonBytes(storageLedger(l))).toBeLessThanOrEqual(STORE_LEDGER_BYTES)
})


test('pre-v0.2 ledger migrates without inventing swarm activity or losing replay', () => {
  const current = withReplay(agent(), snapshot())
  const { swarm: _swarm, ...legacyFields } = current
  const legacy = { ...legacyFields, schema: 1 as const }
  const migrated = migrateLedger(legacy)
  expect(migrated.schema).toBe(2)
  expect(migrated.runs).toEqual(current.runs)
  expect(migrated.agents).toEqual(current.agents)
  expect(migrated.replay).toEqual(current.replay)
  expect(migrated.swarm!.tasks).toEqual([])
  expect(migrated.swarm!.events).toEqual([])
})
