import { describe, expect, test } from 'claude-code/testing'
import { addAgent, checkpointOf, emptyLedger, jsonBytes, startRun, storageLedger, STORE_LEDGER_BYTES } from '../hooks/ledger'
import { admitTask, bindAgent, emptySwarm, finishTask, reportResult, submitTask } from '../hooks/swarm'
import { replayTimeline } from '../hooks/replay'
import type { Ledger } from '../types'
import { bash, command, fieldRowsOf, hostState, mountHud, mountPane, passAllGates, planAndComplete, progress, prompt, rowsOf, start, world } from './world'

type Engine = Parameters<typeof start>[0]
const SWARM = 'mcp__cobalt-cockpit__swarm'
const options = { options: { orchestration: true, maxSubagents: 32, maxSonnetAgents: 16, maxHaikuAgents: 24 } }
const report = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: SWARM, ...input } as never)
const assign = ($: Engine, id: string, paths = ['/work/shared.ts'], mode: 'read' | 'write' = 'read', extra: Record<string, unknown> = {}) => report($, { action: 'assign', task_id: id, tier: 'SONNET', role: 'Engineer', objective: `Bounded ${id}`, scope: `Scope ${id}`, owned_resources: paths, mode, spawn_reason: 'Independent bounded host test', ...extra })
const spawn = ($: Engine, id: string) => $.agent.spawn({ prompt: `Perform task ${id}; stay within declared resources`, description: `[task:${id}] bounded work`, subagentType: 'cobalt-cockpit:worker', tool_use_id: `spawn-${id}`, parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false } as never)
const finish = ($: Engine, agentId: string, reason = 'answer') => $.turn.complete({ agentId, turnId: `turn-${agentId}`, reason, answer: 'Observed bounded result', durationMs: 20, isAborted: reason === 'aborted' } as never)
const edit = ($: Engine, agentId: string | undefined, file_path: string) => $.tool.call({ tool: 'Edit', agentId, file_path, old_string: 'a', new_string: 'b', tool_use_id: `edit-${agentId}-${file_path}` } as never)
const current = (held: ReturnType<typeof hostState>): Ledger => held.get('run-ledger')!.value as Ledger
const task = (held: ReturnType<typeof hostState>, id: string) => current(held).swarm!.tasks.find(t => t.id === id)!
const slash = ($: Engine, command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

describe('swarm ownership through real host hooks', () => {
  test('simultaneous same-file writers reserve only one and retain collision evidence', options, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    await Promise.all([assign($, 'one', ['/work/shared.ts'], 'write'), assign($, 'two', ['/work/shared.ts'], 'write')])
    const results = await Promise.all([spawn($, 'one'), spawn($, 'two')])
    expect(results.filter(r => r.agentId)).toHaveLength(1)
    expect(results.filter(r => r.deny)).toHaveLength(1)
    expect(w.spawns).toHaveLength(1)
    expect(current(held).swarm!.tasks.filter(t => t.state === 'blocked')).toHaveLength(1)
    expect(current(held).swarm!.events.some(e => e.kind === 'conflict')).toBe(true)
  })
  test('overlapping readers and disjoint writers run in parallel', options, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    await assign($, 'read-one'); await assign($, 'read-two')
    await assign($, 'write-one', ['/work/one.ts'], 'write'); await assign($, 'write-two', ['/work/two.ts'], 'write')
    const results = await Promise.all(['read-one', 'read-two', 'write-one', 'write-two'].map(id => spawn($, id)))
    expect(results.every(r => r.agentId)).toBe(true)
    expect(w.spawns).toHaveLength(4)
    expect(current(held).swarm!.highWater).toBe(4)
    expect((await edit($, results[2]!.agentId, '/work/one.ts')).deny).toBeUndefined()
    expect((await edit($, results[3]!.agentId, '/work/two.ts')).deny).toBeUndefined()
    expect(w.ran.filter(r => r['tool'] === 'Edit')).toHaveLength(2)
  })
  test('write escapes, shell effects and recursive delegation never reach the host', options, async ($, on) => {
    const w = world(on); await start($); await assign($, 'writer', ['/work/owned.ts'], 'write')
    const a = (await spawn($, 'writer')).agentId!
    expect((await edit($, a, '/work/other.ts')).deny).toContain('outside owned')
    expect((await $.tool.call({ tool: 'Bash', agentId: a, command: 'npm install unsafe-package' } as never)).deny).toContain('wildcard')
    expect((await $.tool.call({ tool: 'Agent', agentId: a, prompt: 'Delegate recursively' } as never)).deny).toContain('only commander')
    const commander = await $.tool.call({ tool: 'Agent', prompt: 'Independent assignment', description: '[task:next]' } as never)
    expect(commander.deny).toBeUndefined()
    expect(w.ran.filter(r => r['agentId'] === a)).toEqual([])
    expect(w.ran.filter(r => r['tool'] === 'Agent')).toHaveLength(1)
  })
  test('cancellation retains ownership until the engine actually ends the agent', options, async ($, on) => {
    world(on); const held = hostState(on, {}); await start($)
    await assign($, 'writer', ['/work/shared.ts'], 'write'); const a = (await spawn($, 'writer')).agentId!
    await assign($, 'next', ['/work/shared.ts'], 'write'); await report($, { action: 'cancel', task_id: 'writer' })
    expect(task(held, 'writer').cancellationRequested).toBe(true)
    expect(task(held, 'writer').state).toBe('running')
    expect((await spawn($, 'next')).deny).toContain('ownership conflict')
    expect((await edit($, a, '/work/shared.ts')).deny).toContain('cancellation requested')
    await finish($, a, 'aborted')
    expect(task(held, 'writer').state).toBe('cancelled')
    expect((await spawn($, 'next')).agentId).toBeDefined()
  })
})

describe('swarm handoffs, end events and durable evidence', () => {
  test('read-only helper discovers tools and delivers its report through native handback', options, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); on('session.id', () => ({ value: 'reader-session' })); await start($)
    await assign($, 'reader'); const a = (await spawn($, 'reader')).agentId!
    expect((await $.tool.call({ tool: 'ToolSearch', agentId: a, query: 'select:mcp__cobalt-cockpit__swarm' } as never)).deny).toBeUndefined()
    await report($, { action: 'result', task_id: 'reader', agentId: a, conclusion: 'Finding with uncertainty', evidence: ['shared.ts:1'], unresolved: ['Needs commander review'] })
    expect(task(held, 'reader').resultDelivery).toBe('reported')
    expect((await $.tool.call({ tool: 'SubagentHandback', agentId: a, message: 'Finding with uncertainty' } as never)).deny).toBeUndefined()
    expect(w.ran.filter(r => r['tool'] === 'SubagentHandback')).toHaveLength(1)
    expect(task(held, 'reader').state).toBe('running')
    await finish($, a)
    expect(task(held, 'reader').state).toBe('completed')
    expect(task(held, 'reader').resultDelivery).toBe('host_accepted')
    expect(task(held, 'reader').verification).toBe('pending')
    const status = await report($, { action: 'status', task_id: 'reader' })
    expect(String(status.result)).toContain('Finding with uncertainty')
    expect(String(status.result)).toContain('host_accepted')
    // Persistence: the last value the plugin handed to `$.store.set` is a
    // ledger that names the acknowledged report, and the timeline carries it.
    const persisted = w.storeWrites.filter(x => x.key === `ledger:${current(held).sessionId}`).at(-1)?.value as Ledger
    expect(persisted.swarm!.tasks.find(t => t.id === 'reader')?.resultDelivery).toBe('host_accepted')
    expect(replayTimeline(persisted).some(s => s.title.startsWith('REPORT_ACKNOWLEDGED'))).toBe(true)
  })
  test('parallel read-only reports survive sibling failure and HUD counts observed endings', options, async ($, on) => {
    world(on); const held = hostState(on, {}); await start($)
    for (const id of ['one', 'two', 'failed']) await assign($, id)
    const agents = await Promise.all(['one', 'two', 'failed'].map(id => spawn($, id)))
    await Promise.all(agents.slice(0, 2).map((a, n) => $.tool.call({ tool: 'SubagentHandback', agentId: a.agentId!, message: `Report ${n}` } as never)))
    await Promise.all(agents.map((a, n) => finish($, a.agentId!, n === 2 ? 'error' : 'answer')))
    expect(task(held, 'one').result?.conclusion).toBe('Report 0')
    expect(task(held, 'two').result?.conclusion).toBe('Report 1')
    expect(task(held, 'failed').state).toBe('failed')
    const status = JSON.parse(String((await report($, { action: 'status' })).result))
    expect(status.completed).toBe(2)
    const hud = await mountHud($, 'terminal', 120, true)
    expect((await fieldRowsOf(hud)).join('\n')).toContain('2 done')
    await hud.unmount()
  })
  test('handback and discovery do not authorize writes, shell, other tasks or unknown agents', options, async ($, on) => {
    const w = world(on); await start($); await assign($, 'reader'); await assign($, 'sibling')
    const a = (await spawn($, 'reader')).agentId!
    expect((await edit($, a, '/work/shared.ts')).deny).toContain('read-only')
    expect((await $.tool.call({ tool: 'Read', agentId: a, file_path: '/work/private.ts' } as never)).deny).toContain('outside owned')
    expect((await $.tool.call({ tool: 'Bash', agentId: a, command: 'touch /work/shared.ts' } as never)).deny).toContain('read-only')
    expect((await $.tool.call({ tool: 'SubagentHandback', agentId: 'unknown', message: 'claim' } as never)).deny).toContain('no bound ownership')
    expect((await report($, { action: 'result', agentId: a, task_id: 'sibling', conclusion: 'spoof' })).isError).toBe(true)
    expect(w.ran).toHaveLength(0)
  })
  test('native handback rejection is preserved and never recorded as delivered', options, async ($, on) => {
    world(on, { failingTools: ['SubagentHandback'] }); const held = hostState(on, {}); await start($)
    await assign($, 'reader'); const a = (await spawn($, 'reader')).agentId!
    const r = await $.tool.call({ tool: 'SubagentHandback', agentId: a, message: 'Rejected report' } as never)
    expect(r.isError).toBe(true)
    expect(task(held, 'reader').resultDelivery).toBeUndefined()
    expect(task(held, 'reader').result).toBeNull()
  })
  test('handback acknowledgement survives completion racing inside the native tool', options, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    await assign($, 'fast'); const a = (await spawn($, 'fast')).agentId!
    // The host completes the turn while the native handback tool is still running.
    w.duringToolCall = async call => { if (call['tool'] === 'SubagentHandback') await finish($, a) }
    await $.tool.call({ tool: 'SubagentHandback', agentId: a, message: 'Late acknowledgement' } as never)
    expect(task(held, 'fast').state).toBe('completed')
    expect(task(held, 'fast').resultDelivery).toBe('host_accepted')
  })
  test('interrupted helper preserves its submitted report and releases resources on observed stop', options, async ($, on) => {
    world(on); const held = hostState(on, {}); await start($)
    await assign($, 'interrupted'); const a = (await spawn($, 'interrupted')).agentId!
    await report($, { action: 'result', task_id: 'interrupted', agentId: a, conclusion: 'Partial finding', evidence: ['shared.ts:2'] })
    await finish($, a, 'aborted')
    expect(task(held, 'interrupted').state).toBe('cancelled')
    expect(task(held, 'interrupted').resultDelivery).toBe('reported')
    expect(task(held, 'interrupted').result?.conclusion).toBe('Partial finding')
    await assign($, 'recovery', ['/work/shared.ts'], 'write')
    expect((await spawn($, 'recovery')).agentId).toBeDefined()
  })
  test('host completion without answer evidence is explicitly unavailable', options, async ($, on) => {
    world(on); const held = hostState(on, {}); await start($)
    await assign($, 'silent'); const a = (await spawn($, 'silent')).agentId!
    // A completed turn whose answer carries no text: the host has no report to accept.
    await $.turn.complete({ agentId: a, turnId: 'silent-turn', reason: 'answer', answer: '', durationMs: 20, isAborted: false } as never)
    expect(task(held, 'silent').state).toBe('completed')
    expect(task(held, 'silent').resultDelivery).toBe('unavailable')
    expect(task(held, 'silent').verification).toBe('pending')
  })
  test('ordinary final response is observed separately from native handback', options, async ($, on) => {
    world(on); const held = hostState(on, {}); await start($)
    await assign($, 'final'); const a = (await spawn($, 'final')).agentId!
    await finish($, a)
    expect(task(held, 'final').resultDelivery).toBe('answer_observed')
    expect(task(held, 'final').result?.conclusion).toBe('Observed bounded result')
  })
  test('agents can hand off only their own work and commander alone verifies', options, async ($, on) => {
    world(on); const held = hostState(on, {}); await start($)
    await assign($, 'scout', ['/work/source.ts'], 'read', { tier: 'HAIKU', role: 'Scout' }); await assign($, 'sibling')
    const scout = (await spawn($, 'scout')).agentId!; const sibling = (await spawn($, 'sibling')).agentId!
    const handoff = { action: 'escalate', task_id: 'scout', to: 'SONNET', discoveries: ['Shared schema'], evidence: ['source.ts:2'], question: 'How should schema evolve?', risk: 'Cross-file behavior', next_action: 'Bound engineering assignment', locations: ['source.ts:2'] }
    expect((await report($, { ...handoff, agentId: sibling })).isError).toBe(true)
    expect(task(held, 'scout').escalation).toBeNull()
    expect((await report($, { ...handoff, agentId: scout })).isError).toBeUndefined()
    expect(task(held, 'scout').escalation?.to).toBe('SONNET')
    expect((await report($, { action: 'verify', task_id: 'scout', state: 'pass', evidence: ['I approve'], agentId: scout })).isError).toBe(true)
    expect(task(held, 'scout').verification).toBe('pending')
    await finish($, scout)
    expect(task(held, 'scout').state).toBe('escalated')
    expect((await report($, { action: 'verify', task_id: 'scout', state: 'pass', evidence: ['Still unresolved'] })).isError).toBe(true)
    await report($, { action: 'resolve', task_id: 'scout', conclusion: 'Commander selected compatible schema evolution', evidence: ['Cross-file review complete'] })
    await report($, { action: 'verify', task_id: 'scout', state: 'pass', evidence: ['Commander independently checked'] })
    expect(task(held, 'scout').verification).toBe('pass')
    expect(current(held).swarm!.events.some(e => e.kind === 'escalation')).toBe(true)
  })
  test('observed parent completion rejects blocked children and releases the stopped writer', options, async ($, on) => {
    world(on); const held = hostState(on, {}); await start($)
    await assign($, 'parent', ['/work/shared.ts'], 'write'); const a = (await spawn($, 'parent')).agentId!
    await assign($, 'child', ['/work/child.ts'], 'read', { parent_task: 'parent', dependencies: ['missing'] })
    expect((await spawn($, 'child')).deny).toContain('dependency missing')
    await finish($, a)
    expect(task(held, 'parent').state).toBe('failed')
    expect(task(held, 'parent').result?.unresolved.join(' ')).toContain('completion rejected')
    await assign($, 'replacement', ['/work/shared.ts'], 'write')
    expect((await spawn($, 'replacement')).agentId).toBeDefined()
  })
  test('completion arriving before spawn returns is reconciled after binding', options, async ($, on) => {
    const registering = ((event: string, handler: (...args: any[]) => any) => {
      if (event === 'agent.spawn') return on('agent.spawn', async (host, event) => {
        const result = await handler(host, event)
        if (result.agentId) await finish($, result.agentId)
        return result
      })
      return (on as any)(event, handler)
    }) as typeof on
    const w = world(registering); const held = hostState(on, {})
    await start($); await assign($, 'fast', ['/work/fast.ts'], 'write'); const result = await spawn($, 'fast')
    expect(result.agentId).toBeDefined(); expect(w.spawns).toHaveLength(1)
    expect(task(held, 'fast').state).toBe('completed')
    expect(task(held, 'fast').endedAt).not.toBeNull()
    expect(current(held).agents.find(a => a.id === result.agentId)?.status).toBe('success')
    await assign($, 'after', ['/work/fast.ts'], 'write'); expect((await spawn($, 'after')).agentId).toBeDefined()
  })
  // The 20-agent host/hud/replay integration case can exceed the default 5s on CI runners.
  test('twenty Haiku tasks aggregate in HUD and lifecycle replay explains their work', { ...options, timeoutMs: 15000 }, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    await report($, { action: 'wave', wave: 'ENGINEERING' })
    for (let n = 0; n < 20; n++) await assign($, `h${n}`, [`/work/scan${n}.ts`], 'read', { tier: 'HAIKU', role: 'Scout' })
    const agents = await Promise.all(Array.from({ length: 20 }, (_, n) => spawn($, `h${n}`)))
    expect(w.spawns).toHaveLength(20); expect(agents.every(r => r.agentId)).toBe(true)
    const hud = await mountHud($, 'terminal', 120, true)
    const field = (await fieldRowsOf(hud)).join('\n'); expect(field).toContain('HAIKU ×20')
    expect(field).not.toContain('h19'); await hud.unmount()
    const pane = await mountPane($, 'terminal', 120)
    const displayed = (await rowsOf(pane)).join('\n'); expect(displayed).toContain('HAIKU / POOL'); expect(displayed).toContain('20 observed'); await pane.unmount()
    await report($, { action: 'result', task_id: 'h0', conclusion: 'Inventory complete', evidence: ['20 routes'], agentId: agents[0]!.agentId })
    await finish($, agents[0]!.agentId!); await report($, { action: 'verify', task_id: 'h0', state: 'pass', evidence: ['Independently counted'] })
    const timeline = replayTimeline(current(held)); const kinds = current(held).swarm!.events.map(s => s.kind)
    expect(timeline.length).toBeGreaterThan(20)
    for (const kind of ['wave', 'assignment', 'spawn', 'result', 'completed', 'verification']) {
      expect(kinds).toContain(kind)
      expect(timeline.some(step => step.title.startsWith(kind.toUpperCase() + ' ·'))).toBe(true)
    }
    const history = timeline.map(step => step.lines.join(' ')).join('\n')
    expect(history).toContain('why Independent bounded host test')
    expect(history).toContain('ownership read: /work/scan0.ts')
    expect(history).toContain('Inventory complete')
    expect((await slash($, 'replay')).text).toContain('COBALT / REPLAY')
    expect(w.outbound).toEqual([])
  })
})


test('parked ownership reconciles actual completed agents on resume', options, async ($, on) => {
  let swarm = submitTask(emptySwarm(), { id: 'parked-writer', tier: 'SONNET', role: 'Engineer', objective: 'Parked scoped change', owned: ['/work/shared.ts'], mode: 'write' }, 10).swarm
  swarm = admitTask(swarm, 'parked-writer', 11).swarm
  swarm = bindAgent(swarm, 'parked-writer', 'prior-agent', 12)
  const seed = { ...startRun(emptyLedger('parked-session'), 'prior-turn', 10), swarm }
  const parked = { ...seed, checkpoint: checkpointOf(seed, null, null, 15) }
  const w = world(on, { agents: [{ id: 'prior-agent', description: 'Scoped change', type: 'worker', status: 'completed' }] }, { 'ledger:parked-session': parked })
  const held = hostState(on, {}); on('session.id', () => ({ value: 'parked-session' }))
  await start($)
  expect(task(held, 'parked-writer').state).toBe('completed')
  expect(task(held, 'parked-writer').result?.conclusion).toContain('unavailable')
  expect(task(held, 'parked-writer').verification).toBe('pending')
  expect(w.toasts.some(t => t.includes('COBALT / RESUME'))).toBe(true)
  await assign($, 'replacement', ['/work/shared.ts'], 'write')
  expect((await spawn($, 'replacement')).agentId).toBeDefined()
})

test('schema-one parked resume preserves old replay without inventing agents', options, async ($, on) => {
  const base = startRun(emptyLedger('legacy-session'), 'old-turn', 10)
  const { swarm: _swarm, ...fields } = base
  const parked = { ...fields, schema: 1, checkpoint: checkpointOf(base, null, null, 20) }
  const w = world(on, {}, { 'ledger:legacy-session': parked }); const held = hostState(on, {})
  on('session.id', () => ({ value: 'legacy-session' }))
  await start($)
  expect(current(held).schema).toBe(2)
  expect(current(held).runs).toEqual(base.runs)
  expect(current(held).swarm!.tasks).toEqual([])
  expect(current(held).requests).toEqual([])
  expect(w.spawns).toEqual([])
  expect(w.outbound).toEqual([])
})


describe('commander effect admission fences', () => {
  test('an awaited commander path lookup fences off concurrent spawning', options, async ($, on) => {
    let armed = false
    let entered!: () => void; let release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const registering = ((event: string, handler: (...args: any[]) => any) => {
      if (event === 'process.run') return on('process.run', async (host, call) => {
        if (armed && call.argv[0] === 'realpath') { entered(); await gate }
        return handler(host, call)
      })
      return (on as any)(event, handler)
    }) as typeof on
    const w = world(registering); await start($); await assign($, 'queued', ['/work/agent.ts'], 'write')
    armed = true
    const effect = edit($, undefined, '/work/commander.ts')
    await reached
    expect((await spawn($, 'queued')).deny).toContain('commander effect in flight')
    expect(w.spawns).toHaveLength(0)
    release(); expect((await effect).deny).toBeUndefined()
    armed = false
    expect((await spawn($, 'queued')).agentId).toBeDefined()
  })
  test('an awaited host spawn fences off commander effects before they reach the host', options, async ($, on) => {
    let entered!: () => void; let release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const registering = ((event: string, handler: (...args: any[]) => any) => {
      if (event === 'agent.spawn') return on('agent.spawn', async (host, call) => { entered(); await gate; return handler(host, call) })
      return (on as any)(event, handler)
    }) as typeof on
    const w = world(registering); await start($); await assign($, 'starting', ['/work/agent.ts'], 'write')
    const starting = spawn($, 'starting'); await reached
    expect((await edit($, undefined, '/work/commander.ts')).deny).toContain('agent admission in flight')
    expect(w.ran.filter(call => call['tool'] === 'Edit')).toHaveLength(0)
    release(); expect((await starting).agentId).toBeDefined()
  })
})

test('wildcard read agents cannot launch an editor through git grep options', options, async ($, on) => {
  const w = world(on); await start($); await assign($, 'grep-reader', ['*'], 'read'); const id = (await spawn($, 'grep-reader')).agentId!
  const legacy = await $.agent.spawn({ prompt: 'Bounded legacy inspection', description: 'Legacy reference search', subagentType: 'explorer', tool_use_id: 'legacy-grep', parentModel: 'claude-opus-5-5', background: true, fork: false, provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(legacy.agentId).toBeDefined()
  for (const agentId of [id, legacy.agentId!]) for (const command of ['git grep -Oeditor pattern', 'git grep --open-files-in-pager=editor pattern', 'git grep -O pattern']) {
    expect((await $.tool.call({ tool: 'Bash', agentId, command } as never)).deny).toBeDefined()
  }
  expect(w.ran.filter(call => call['tool'] === 'Bash')).toHaveLength(0)
})

test('unknown commander model is not presented as Opus in observation mode', async ($, on) => {
  const seed = addAgent(startRun(emptyLedger('unknown-session'), 'unknown-turn', 10), { agentId: 'observed', subagentType: 'explorer', description: 'Known agent, unknown commander', model: 'claude-sonnet-5-5' }, 12)
  world(on); hostState(on, { 'run-ledger': seed }); on('session.id', () => ({ value: 'unknown-session' }))
  await start($)
  const hud = await mountHud($, 'terminal', 120, true)
  const field = (await fieldRowsOf(hud)).join('\n')
  expect(field).toContain('MODEL unknown')
  expect(field).not.toContain('OPUS')
  await hud.unmount()
})

// This 128-task persistence stress test has a wider CI timeout than the default 5s.
test('large stored results prune detail while preserving task dependencies and live ownership', { timeoutMs: 15000 }, () => {
  let swarm = emptySwarm({ sonnet: 128, total: 128, maxEvents: 512 })
  for (let n = 0; n < 128; n++) {
    const id = `stored-${n}`
    swarm = submitTask(swarm, { id, tier: 'SONNET', role: 'Engineer', objective: `Bounded stored objective ${n}`, owned: [`/work/scope${n}/source.ts`], mode: 'write', dependencies: n ? [`stored-${n - 1}`] : [] }, n * 4).swarm
    swarm = admitTask(swarm, id, n * 4 + 1).swarm
    swarm = bindAgent(swarm, id, `stored-agent-${n}`, n * 4 + 2)
    const result = { conclusion: 'Observed result '.repeat(100), evidence: Array.from({ length: 12 }, (_, k) => `Location ${k} ` + 'e'.repeat(1490)), changes: Array.from({ length: 12 }, () => 'c'.repeat(1500)), verification: Array.from({ length: 12 }, () => 'v'.repeat(1500)) }
    swarm = reportResult(swarm, id, result, n * 4 + 3)
    if (n < 127) swarm = finishTask(swarm, id, 'completed', result, n * 4 + 3)
  }
  const ledger = { ...emptyLedger('large-stored'), swarm }
  expect(jsonBytes(ledger)).toBeGreaterThan(STORE_LEDGER_BYTES)
  const stored = storageLedger(ledger)
  expect(jsonBytes(stored)).toBeLessThanOrEqual(STORE_LEDGER_BYTES)
  expect(stored.swarm!.tasks.map(({ id, dependencies, agentId, owned, state }) => ({ id, dependencies, agentId, owned, state }))).toEqual(swarm.tasks.map(({ id, dependencies, agentId, owned, state }) => ({ id, dependencies, agentId, owned, state })))
  expect(stored.swarm!.tasks.at(-1)?.state).toBe('running')
  expect(stored.swarm!.tasks.at(-1)?.owned).toEqual(['/work/scope127/source.ts'])
  expect(stored.swarm!.tasks.at(-1)?.result?.unresolved).toContain('Stored detail pruned; commander verification unchanged')
})

test('an observed pre-v0.2 running agent resumes only after explicit safe ownership adoption', options, async ($, on) => {
  const w = world(on); const held = hostState(on, {})
  w.agents.push({ id:'legacy-live', description:'Existing scout', type:'explorer', status:'running' })
  await start($)
  const before = await $.tool.call({ tool:'Read', file_path:'/work/legacy.ts', agentId:'legacy-live' } as never)
  expect(before.deny).toContain('no bound ownership')
  await assign($,'legacy-scope',['/work/legacy.ts'],'read',{ tier:'HAIKU',role:'Scout' })
  expect((await report($,{ action:'adopt', task_id:'legacy-scope', agent_id:'legacy-live' })).isError).not.toBe(true)
  expect((await $.tool.call({ tool:'Read', file_path:'/work/legacy.ts', agentId:'legacy-live' } as never)).deny).toBeUndefined()
  expect(task(held,'legacy-scope').agentId).toBe('legacy-live')
  expect(current(held).swarm!.events.at(-1)?.kind).toBe('adopt')
  expect(w.spawns).toHaveLength(0)
})

describe('a helper edit after the goal check', () => {
  const editAs = ($: Engine, agentId: string, file_path: string, id: string) => $.tool.call({ tool: 'Edit', agentId, file_path, old_string: 'a', new_string: 'b', tool_use_id: id } as never)
  const aligned = { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "cancel test 'frees the slot' passes in test/api.test.js (4 pass)" }] } }

  test('a worker\'s successful edit takes ALIGNED back; a denied or failed one does not; renewed evidence restores DONE', options, async ($, on) => {
    const w = world(on); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    expect(await progress($, aligned)).toContain('alignment ALIGNED')
    await assign($, 'writer', ['/work/owned.ts'], 'write')
    const a = (await spawn($, 'writer')).agentId!
    // outside what the worker owns: refused, so nothing changed
    expect((await editAs($, a, '/work/other.ts', 'e-denied')).deny).toContain('outside owned')
    expect(await progress($, { action: 'status' })).toContain('alignment ALIGNED')
    // the tool itself failed: not a change either
    w.failingTools.push('Edit')
    await editAs($, a, '/work/owned.ts', 'e-failed')
    w.failingTools.length = 0
    expect(await progress($, { action: 'status' })).toContain('alignment ALIGNED')
    // a real edit of an owned file: the earlier check no longer describes the code
    expect((await editAs($, a, '/work/owned.ts', 'e-ok')).deny).toBeUndefined()
    expect(await progress($, { action: 'status' })).toContain('alignment PENDING')
    const held = await progress($, { action: 'complete', milestone: 'm5' })
    expect(held).toContain('HELD')
    expect(held).not.toContain('DONE')
    // the checks that passed before the edit are pending again; renewed verification, with its own evidence, finishes it
    expect(await progress($, { action: 'status' })).toContain('TEST pending')
    expect(await progress($, aligned)).toStartWith('error:')
    await passAllGates($, { align: false })
    expect(await progress($, aligned)).toContain('alignment ALIGNED')
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
  })
})

describe('completion integrity after DONE', () => {
  const aligned = { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "cancel test 'frees the slot' passes in test/api.test.js (4 pass)" }] } }
  const done = async ($: Engine) => {
    await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    await progress($, aligned)
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
  }
  const restore = async ($: Engine) => {
    expect(await progress($, { action: 'status' })).not.toStartWith('DONE')
    await passAllGates($, { align: false })
    expect(await progress($, aligned)).toContain('alignment ALIGNED')
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
  }

  test('a main-session edit after DONE revokes alignment and the passed checks; new observations restore it', options, async ($, on) => {
    world(on); await done($)
    await $.tool.call({ tool: 'Edit', file_path: '/work/example/src/api.js', old_string: 'a', new_string: 'b', tool_use_id: 'late-edit' } as never)
    const after = await progress($, { action: 'status' })
    expect(after).toContain('alignment PENDING')
    expect(after).toContain('UNVERIFIED')
    expect(after).toContain('TEST pending')
    expect(after).not.toStartWith('DONE')
    await restore($)
  })

  test('reading after DONE revokes nothing', options, async ($, on) => {
    world(on); await done($)
    for (const tool of ['Read', 'Grep', 'Glob']) await $.tool.call({ tool, file_path: '/work/example/src/api.js', tool_use_id: `r-${tool}` } as never)
    await bash($, 'git log --oneline -3')
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
  })

  test('a tool that is neither Edit nor Write but changed the working tree revokes alignment', options, async ($, on) => {
    const w = world(on); await done($)
    w.tree['notebooks/analysis.ipynb'] = 'print(2)'
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/example/notebooks/analysis.ipynb', new_source: 'x', tool_use_id: 'nb' } as never)
    expect(await progress($, { action: 'status' })).toContain('alignment PENDING')
    await restore($)
  })

  test('an MCP filesystem writer is seen by the tree, not by its name, and a no-op writer is not', options, async ($, on) => {
    const w = world(on); await done($)
    await $.tool.call({ tool: 'mcp__fs__write_file', path: '/work/example/src/api.js', content: 'same', tool_use_id: 'mcp-noop' } as never)
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
    w.tree['src/api.js'] = 'new'
    await $.tool.call({ tool: 'mcp__fs__write_file', path: '/work/example/src/api.js', content: 'new', tool_use_id: 'mcp-real' } as never)
    expect(await progress($, { action: 'status' })).toContain('alignment PENDING')
  })

  test('a shell command that changed a tracked file revokes alignment even with no edit diff', options, async ($, on) => {
    const w = world(on); await done($)
    w.tree['src/store.js'] = 'sed'
    await bash($, "sed -i 's/a/b/' src/store.js")
    expect(await progress($, { action: 'status' })).toContain('alignment PENDING')
  })

  test('staging, committing or stashing after DONE changes no content and revokes nothing', options, async ($, on) => {
    const w = world(on); w.tree['src/api.js'] = 'cancel'; await done($)
    w.gitStatus = `${w.gitStatus}2 A. N... 000000 100644 100644 0000 abc src/api.js\n`
    await bash($, 'git add -A && git commit -m cancel')
    await bash($, 'git stash')
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
    // the commit moved HEAD; checks reported afterwards, and a goal check made after them, still stand
    w.head = 'def5678def5678'
    await bash($, 'git commit -m again')
    await progress($, { action: 'gate', gate: 'GIT', state: 'pass', evidence: 'committed' })
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
    expect(await progress($, { action: 'status' })).toContain('TEST pass')
  })

  test('a commit between the checks and the goal check does not stale the checks', options, async ($, on) => {
    const w = world(on); w.tree['src/api.js'] = 'cancel'; await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    w.head = 'def5678def5678'
    expect(await progress($, aligned)).toContain('alignment ALIGNED')
  })

  test('a write nobody observed between the checks and align refuses ALIGNED until the checks are run again', options, async ($, on) => {
    const w = world(on); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    w.tree['src/api.js'] = 'edited by a tool nothing watches'
    const refused = await progress($, aligned)
    expect(refused).toStartWith('error: ALIGNED refused')
    expect(refused).toContain('working tree changed')
    expect(await progress($, { action: 'status' })).toContain('TEST pending')
    await passAllGates($, { align: false })
    expect(await progress($, aligned)).toContain('alignment ALIGNED')
  })

  test('a revocation made by the tree is settled: the stored task is no longer done and the next prompt continues it', options, async ($, on) => {
    const w = world(on); await done($)
    w.tree['notebooks/a.ipynb'] = 'print(2)'
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/example/notebooks/a.ipynb', new_source: 'x', tool_use_id: 'nb-settle' } as never)
    await prompt($, 'Now double-check the cancellation')
    const after = await progress($, { action: 'status' })
    expect(after).toContain('5/5 milestones')
    expect(after).toContain('UNVERIFIED')
  })

  test('where git cannot answer, only Edit, Write and Bash edit diffs are seen: the documented gap', options, async ($, on) => {
    const w = world(on); w.gitStatus = null; await done($)
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/example/a.ipynb', new_source: 'x', tool_use_id: 'nb-gap' } as never)
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
    await $.tool.call({ tool: 'Edit', file_path: '/work/example/src/api.js', old_string: 'a', new_string: 'b', tool_use_id: 'edit-still-seen' } as never)
    expect(await progress($, { action: 'status' })).toContain('alignment PENDING')
  })

  test('/cockpit discovery auto cannot lower the level or waive the check', options, async ($, on) => {
    world(on); await done($)
    const level = (text: string) => /Discovery (LIGHT|STANDARD|DEEP)/.exec(text)?.[1]
    const before = level(await progress($, { action: 'status' }))
    await command($, 'discovery auto')
    expect(level(await progress($, { action: 'status' }))).toBe(before)
  })
})
