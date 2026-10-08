import { describe, expect, test } from 'claude-code/testing'
import { addAgent, checkpointOf, emptyLedger, jsonBytes, startRun, storageLedger, STORE_LEDGER_BYTES } from '../hooks/ledger'
import { admitTask, bindAgent, emptySwarm, finishTask, reportResult, submitTask } from '../hooks/swarm'
import { replayTimeline } from '../hooks/replay'
import type { Ledger } from '../types'
import { fieldRowsOf, hostState, mountHud, mountPane, rowsOf, start, world } from './world'

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

test('large stored results prune detail while preserving task dependencies and live ownership', () => {
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
