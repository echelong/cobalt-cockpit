// Ownership under ambiguous dispatch, exercised through the real host hook chain.
// This does not establish host fencing or drain already admitted effects.
import { expect, test } from 'claude-code/testing'
import type { Ledger } from '../types'
import { agentsText, swarmHint, taskText } from '../hooks/inspector'
import { emptySwarm, spawnRefusal, submitTask } from '../hooks/swarm'
import { command, hostState, mountHud, rowsOf, start, world } from './world'

type Engine = Parameters<typeof start>[0]
const options = { options: { orchestration: true, maxSubagents: 16, animation: false } }
const SWARM = 'mcp__cobalt-cockpit__swarm'
const control = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: SWARM, ...input } as never)
const assign = ($: Engine, id: string, mode = 'write', owned = ['/work/shared.ts']) => control($, { action: 'assign', task_id: id, tier: 'SONNET', role: 'Engineer', objective: `Bounded ${id}`, owned_resources: owned, mode })
const spawn = ($: Engine, id: string) => $.agent.spawn({ prompt: `Bounded ${id}`, description: `[task:${id}] bounded work`, subagentType: 'cobalt-cockpit:worker', tool_use_id: `spawn-${id}`, parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false } as never)
const ledger = (h: ReturnType<typeof hostState>) => h.get('run-ledger')!.value as Ledger
const task = (h: ReturnType<typeof hostState>, id: string) => ledger(h).swarm!.tasks.find(t => t.id === id)!

for (const outcome of ['missing', 'exception', 'invalid-id', 'duplicate-id']) {
  test(`${outcome} after dispatch retains ownership and blocks replacements through resume`, options, async ($, on) => {
    let first = true
    const registering = ((event: string, handler: (...args: any[]) => any) => {
      if (event === 'agent.spawn') return on('agent.spawn', async (host, e) => {
        const result = await handler(host, e)
        if (!first) return result
        first = false
        if (outcome === 'exception') throw new Error('transport lost after starting')
        if (outcome === 'duplicate-id') return { ...result, agentId: 'already-bound' }
        return { model: result.model, ...(outcome === 'invalid-id' ? { agentId: '   ' } : {}) }
      })
      return (on as any)(event, handler)
    }) as typeof on
    const w = world(registering); const h = hostState(on, {})
    on('session.id', () => ({ value: 'ambiguous-session' }))
    await start($)
    if (outcome === 'duplicate-id') {
      await assign($, 'reader', 'read', ['/work/reader.ts'])
      first = false; const a = await spawn($, 'reader'); first = true
      const l = ledger(h); h.set('run-ledger', { value: { ...l, swarm: { ...l.swarm!, tasks: l.swarm!.tasks.map(t => t.id === 'reader' ? { ...t, agentId: 'already-bound' } : t) } }, version: h.get('run-ledger')!.version + 1 })
      expect(a.agentId).toBeDefined()
    }
    await assign($, 'uncertain')
    await spawn($, 'uncertain').catch(() => undefined)
    expect(task(h, 'uncertain').startedAt).not.toBeNull()
    expect(task(h, 'uncertain').endedAt).toBeNull()
    await assign($, 'replacement')
    expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
    expect(String((await control($, { action: 'status' })).result)).toContain('uncertain')
    expect((await command($, 'agents uncertain')).text).toContain('uncertain')
    const hud = await mountHud($, 'terminal', 120, true)
    expect((await rowsOf(hud)).join('\n')).toContain('UNCERTAIN')
    await hud.unmount()
    await w.clock.advance(600001); w.agents = []
    await control($, { action: 'cancel', task_id: 'uncertain' })
    // Drop session state as a process restart would; restore must rely on durable records.
    h.delete('run-ledger'); await start($)
    expect(task(h, 'uncertain').startedAt).not.toBeNull()
    expect(task(h, 'uncertain').endedAt).toBeNull()
    await assign($, 'replacement-after-resume')
    expect((await spawn($, 'replacement-after-resume')).deny).toContain('ownership conflict')
    expect(w.spawns).toHaveLength(outcome === 'duplicate-id' ? 2 : 1)
  })
}

test('reservation is durable before dispatch; lost ledger writes cannot erase it on resume', options, async ($, on) => {
  let dispatches = 0
  let w!: ReturnType<typeof world>
  const registering = ((event: string, handler: (...args: any[]) => any) => {
    if (event === 'agent.spawn') return on('agent.spawn', async (host, e) => {
      dispatches++
      expect([...w.store.keys()].some(k => k.startsWith('spawn-claim:'))).toBe(true)
      const result = await handler(host, e)
      w.failStoreWrites = ['ledger:durable-session']
      return { model: result.model }
    })
    return (on as any)(event, handler)
  }) as typeof on
  w = world(registering); const h = hostState(on, {})
  on('session.id', () => ({ value: 'durable-session' }))
  await start($); await assign($, 'uncertain')
  await spawn($, 'uncertain').catch(() => undefined)
  expect(dispatches).toBe(1)
  h.delete('run-ledger'); w.agents = []; w.failStoreWrites = []; await start($)
  expect(task(h, 'uncertain').startedAt).not.toBeNull()
  await assign($, 'replacement'); expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
})

test('failed durable claim persistence prevents dispatch and permits safe retry', options, async ($, on) => {
  let fail = false
  const registering = ((event: string, handler: (...args: any[]) => any) => {
    if (event === 'store.set') return on('store.set', (host, e) => {
      if (fail && e.key.startsWith('spawn-claim:')) throw new Error('claim write failed')
      return handler(host, e)
    })
    return (on as any)(event, handler)
  }) as typeof on
  const w = world(registering, { sessionId: 'mock-session' }); const h = hostState(on, {}); await start($); await assign($, 'retry')
  fail = true; expect((await spawn($, 'retry')).deny).toBeDefined()
  expect(w.spawns).toHaveLength(0)
  expect(task(h, 'retry').startedAt).toBeNull()
  fail = false; expect((await spawn($, 'retry')).agentId).toBeDefined()
})

// Past the dispatch boundary `next` may have reached the host: a chain answer does not show nothing started.
const downstream = (on: Parameters<typeof world>[0], answer: (host: any, e: any, handler: (...args: any[]) => any) => any) => ((event: string, handler: (...args: any[]) => any) => {
  if (event === 'agent.spawn') return on('agent.spawn', (host, e) => answer(host, e, handler))
  return (on as any)(event, handler)
}) as typeof on
const noStartKeys = (w: ReturnType<typeof world>) => [...w.store.keys()].filter(k => k.startsWith('spawn-no-start:'))

test('a true downstream refusal keeps ownership and cannot be retried into a second dispatch', options, async ($, on) => {
  let deny = true
  const w = world(downstream(on, (host, e, handler) => deny ? { deny: 'Refused without next' } : handler(host, e)), { sessionId: 'mock-session' }); const h = hostState(on, {})
  await start($); await assign($, 'held')
  expect((await spawn($, 'held')).deny).toContain('Refused without next')
  expect(w.spawns).toHaveLength(0)
  expect(task(h, 'held').state).toBe('reserved')
  expect(task(h, 'held').spawnUncertain).toBe(true)
  expect(task(h, 'held').startedAt).not.toBeNull()
  expect(task(h, 'held').reason).toContain('Refused without next')
  expect(ledger(h).swarm!.events.some(ev => ev.kind === 'spawn_refused_after_dispatch' && ev.taskId === 'held')).toBe(true)
  expect(noStartKeys(w)).toHaveLength(0)
  deny = false
  const again = (await spawn($, 'held')).deny!
  expect(again).toContain('held is held: an agent may have started')
  expect(again).toContain('this call did not dispatch it again')
  expect(again).not.toContain('Nothing was started')
  expect(again).not.toContain('retry after')
  await assign($, 'replacement'); expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
  expect(w.spawns).toHaveLength(0)
})

test('a refusal is kept on one line and bounded', options, async ($, on) => {
  world(downstream(on, () => ({ deny: `Refused\nsecond line\t${'x'.repeat(600)}` })), { sessionId: 'mock-session' }); const h = hostState(on, {})
  await start($); await assign($, 'held'); await spawn($, 'held')
  expect(task(h, 'held').reason).not.toContain('\n')
  expect(task(h, 'held').reason!.length).toBeLessThan(400)
})

test('a refusal cannot put control characters on the HUD or rejoin a secret', options, async ($, on) => {
  const secret = `sk-${'a'.repeat(4)}\u0000${'b'.repeat(20)}`
  world(downstream(on, () => ({ deny: `Refused\u001b[31m\u0007 \u009b1m \u202emoved ${secret}` })), { sessionId: 'mock-session' }); const h = hostState(on, {})
  await start($); await assign($, 'held'); await spawn($, 'held')
  const reason = task(h, 'held').reason!
  expect(/[\p{Cc}\p{Cf}]/u.test(reason)).toBe(false)
  expect(reason).not.toContain('aaaa')
  expect(reason).not.toContain('bbbb')
  const event = ledger(h).swarm!.events.find(ev => ev.kind === 'spawn_refused_after_dispatch')!
  expect(/[\p{Cc}\p{Cf}]/u.test(event.detail)).toBe(false)
})

test('a refusal with nothing left after sanitising still reads as a refusal', options, async ($, on) => {
  world(downstream(on, () => ({ deny: '\u0007\u0008' })), { sessionId: 'mock-session' }); const h = hostState(on, {})
  await start($); await assign($, 'held'); await spawn($, 'held')
  expect(task(h, 'held').reason).toContain('no reason given')
  expect(task(h, 'held').state).toBe('reserved')
})

const legacy = ($: Engine, id: string) => $.agent.spawn({ prompt: 'Legacy work', description: `legacy work ${id}`, subagentType: 'cobalt-cockpit:worker', tool_use_id: id, parentModel: 'claude-opus-5-5' } as never)

test('a legacy retry of a held spawn is told a retry cannot succeed', options, async ($, on) => {
  let deny = true
  const w = world(downstream(on, (host, e, handler) => deny ? { deny: 'Refused' } : handler(host, e)), { sessionId: 'mock-session' }); const h = hostState(on, {})
  await start($)
  expect((await legacy($, 'first')).deny).toBe('Refused')
  deny = false
  const retry = (await legacy($, 'second')).deny!
  expect(retry).toContain('ownership conflict')
  expect(retry).toContain('held after an uncertain spawn')
  expect(retry).toContain('a retry cannot succeed')
  expect(retry).not.toContain('retry after')
  expect(w.spawns).toHaveLength(0)
  expect(ledger(h).swarm!.tasks.filter(t => t.spawnUncertain)).toHaveLength(1)
})

test('a conflict with a task that can finish still invites a retry', options, async ($, on) => {
  world(on, { sessionId: 'mock-session' }); hostState(on, {})
  await start($); await assign($, 'running'); await assign($, 'second')
  expect((await spawn($, 'running')).agentId).toBeDefined()
  const refused = (await spawn($, 'second')).deny!
  expect(refused).toContain('ownership conflict: running')
  expect(refused).toContain('retry after dependency/ownership/resource clears')
  expect(refused).not.toContain('uncertain')
  expect((await $.tool.call({ tool: 'Bash', command: 'printf x > /elsewhere' } as never)).deny).not.toContain('uncertain')
})

test('work depending on a held task is told waiting does not clear it', options, async ($, on) => {
  world(downstream(on, () => ({ deny: 'Refused' })), { sessionId: 'mock-session' }); hostState(on, {})
  await start($); await assign($, 'held', 'write', ['/work/one.ts'])
  await spawn($, 'held')
  await control($, { action: 'assign', task_id: 'after', tier: 'SONNET', role: 'Engineer', objective: 'Bounded after', owned_resources: ['/work/two.ts'], mode: 'write', scope: 'after', dependencies: ['held'], spawn_reason: 'test' })
  const refused = (await spawn($, 'after')).deny!
  expect(refused).toContain('dependency held')
  expect(refused).toContain('a retry cannot succeed')
  expect(refused).not.toContain('retry after')
})

test('a full budget names the slots a hold keeps', { options: { orchestration: true, maxSubagents: 1, animation: false } }, async ($, on) => {
  world(downstream(on, () => ({ deny: 'Refused' })), { sessionId: 'mock-session' }); hostState(on, {})
  await start($); await assign($, 'held', 'write', ['/work/one.ts']); await assign($, 'other', 'write', ['/work/two.ts'])
  await spawn($, 'held')
  const refused = (await spawn($, 'other')).deny!
  expect(refused).toContain('resource budget')
  expect(refused).toContain('1 held after an uncertain spawn: waiting does not clear those')
})

test('a commander effect is told a hold is only part of what stops it', options, async ($, on) => {
  world(downstream(on, (host, e, handler) => e.description.includes('[task:held]') ? { deny: 'Refused' } : handler(host, e)), { sessionId: 'mock-session' }); hostState(on, {})
  await start($); await assign($, 'healthy', 'write', ['/work/healthy.ts']); await assign($, 'held', 'write', ['/work/held.ts'])
  expect((await spawn($, 'healthy')).agentId).toBeDefined()
  await spawn($, 'held')
  const write = (await $.tool.call({ tool: 'Write', file_path: '/work/healthy.ts', content: 'x' } as never)).deny!
  expect(write).toContain('conflicts with active ownership')
  expect(write).not.toContain('uncertain')
  const shell = (await $.tool.call({ tool: 'Bash', command: 'printf x > /elsewhere' } as never)).deny!
  expect(shell).toContain('1 of 2 holders is an uncertain spawn')
})

test('a sibling refused while the claim is being written is not told waiting cannot help', options, async ($, on) => {
  let entered!: () => void; let release!: () => void
  const reached = new Promise<void>(r => { entered = r }); const gate = new Promise<void>(r => { release = r })
  const registering = ((event: string, handler: (...args: any[]) => any) => {
    if (event === 'store.set') return on('store.set', async (host, e) => { if (String((e as { key?: unknown }).key).startsWith('spawn-claim:')) { entered(); await gate } return handler(host, e) })
    return (on as any)(event, handler)
  }) as typeof on
  world(registering, { sessionId: 'mock-session' }); hostState(on, {})
  await start($); await assign($, 'first'); await assign($, 'second')
  const pending = spawn($, 'first'); await reached
  const refused = (await spawn($, 'second')).deny!
  expect(refused).toContain('ownership conflict')
  expect(refused).toContain('retry after dependency/ownership/resource clears')
  expect(refused).not.toContain('a retry cannot succeed')
  release(); expect((await pending).agentId).toBeDefined()
})

test('an uncertain claim keeps its reason through a stall', options, async ($, on) => {
  let first = true
  const w = world(downstream(on, async (host, e, handler) => { const r = await handler(host, e); if (first) { first = false; return { model: r.model } } return r }), { sessionId: 'mock-session' }); const h = hostState(on, {})
  await start($); await assign($, 'held'); await spawn($, 'held')
  await w.clock.advance(600001); await control($, { action: 'status' })
  expect(task(h, 'held').state).toBe('stalled')
  expect(task(h, 'held').reason).toContain('Spawn outcome uncertain')
})

test('a held claim keeps its refusal through a stall', options, async ($, on) => {
  const w = world(downstream(on, () => ({ deny: 'Plugin refused this' })), { sessionId: 'mock-session' }); const h = hostState(on, {})
  await start($); await assign($, 'held'); await spawn($, 'held')
  await w.clock.advance(600001); await control($, { action: 'status' })
  expect(task(h, 'held').state).toBe('stalled')
  expect((await command($, 'agents held')).text).toContain('Refusal: Plugin refused this')
})

const uncertainTask = (tier: 'OPUS' | 'SONNET', owned = ['/a']) => {
  const s = submitTask(emptySwarm(), { id: 'held', tier, role: tier === 'OPUS' ? 'ARCHITECT' : 'WORKER', objective: 'Bounded', mode: 'write', owned, spawnReason: 'test' } as never, 1).swarm
  return { ...s, config: { ...s.config, opus: 1 }, tasks: s.tasks.map(t => ({ ...t, state: 'reserved' as const, startedAt: 1, spawnUncertain: true })) }
}

test('an Opus claim is not said to hold commander effects', () => {
  expect(swarmHint(uncertainTask('OPUS'), 120)).toBe('SWARM: 1 UNCERTAIN · ownership retained · /cockpit agents')
  expect(swarmHint(uncertainTask('SONNET'), 120)).toContain('commander effects held')
  expect(agentsText({ swarm: uncertainTask('OPUS'), agents: [], now: 2, columns: 120 })).not.toContain('commander shell')
  expect(taskText({ swarm: uncertainTask('OPUS'), agents: [], now: 2, columns: 120 }, 'held')).toContain('Commander effects are not held')
  expect(taskText({ swarm: uncertainTask('SONNET'), agents: [], now: 2, columns: 120 }, 'held')).toContain('Held now: commander shell')
})

for (const reason of ['task running', 'task stalled', 'task completed', 'task failed', 'task cancelled', 'task escalated', 'dependency x: failed', 'dependency x: cancelled', 'dependency x: unknown']) {
  test(`${reason} is not told to retry after it clears`, () => {
    const answer = spawnRefusal(emptySwarm(), 'n', reason, new Set())
    expect(answer).toContain('A retry alone cannot succeed')
    expect(answer).not.toContain('retry after')
  })
}

test('a stuck overlap is named even when admission names a healthy task first', () => {
  const held = uncertainTask('SONNET', ['/x'])
  const s = { ...held, tasks: [{ ...held.tasks[0]!, id: 'healthy', spawnUncertain: false, state: 'running' as const, agentId: 'a' }, ...held.tasks, { ...held.tasks[0]!, id: 'new', spawnUncertain: false, state: 'queued' as const }] }
  const answer = spawnRefusal(s, 'new', 'ownership conflict: healthy', new Set())
  expect(answer).toContain('held is held after an uncertain spawn')
  expect(answer).not.toContain('retry after')
  expect(spawnRefusal(s, 'new', 'ownership conflict: healthy', new Set(['held']))).toContain('retry after')
})

test('a held claim is visible to the operator with its cost and its limits', options, async ($, on) => {
  world(downstream(on, () => ({ deny: 'Plugin refused this' })), { sessionId: 'mock-session' }); hostState(on, {})
  await start($); await assign($, 'held', 'write', ['/work/named.ts']); await spawn($, 'held')
  const shell = (await $.tool.call({ tool: 'Bash', command: 'printf x > /elsewhere' } as never)).deny!
  expect(shell).toContain('held until active ownership releases')
  expect(shell).toContain('held by an uncertain spawn: waiting does not clear that and no command releases it')
  expect(shell).toContain('/cockpit agents')
  const write = (await $.tool.call({ tool: 'Write', file_path: '/work/named.ts', content: 'x' } as never)).deny!
  expect(write).toContain('conflicts with active ownership')
  expect(write).toContain('waiting does not clear that')
  const hud = await mountHud($, 'terminal', 120, true)
  expect((await rowsOf(hud)).join('\n')).toContain('1 UNCERTAIN · ownership retained · commander effects held · /cockpit agents')
  await hud.unmount()
  const list = (await command($, 'agents')).text!
  expect(list).toContain('HELD · 1 UNCERTAIN')
  expect(list).toContain('commander shell and custom tools refused')
  const one = (await command($, 'agents held')).text!
  expect(one).toContain('Plugin refused this')
  for (const line of ['No command releases it', '--resume of this session restores it', 'A new session leaves it behind', 'Reads continue']) expect(one).toContain(line)
  for (const line of one.split('\n').filter(l => /^(Not proof|Ends only|Held now|No command|A new session)/.test(l))) expect(line.length).toBeLessThanOrEqual(80)
})

test('a denial after the host started an agent is not a no-start', options, async ($, on) => {
  const w = world(downstream(on, async (host, e, handler) => { await handler(host, e); return { deny: 'Started, then refused' } }), { sessionId: 'mock-session' }); const h = hostState(on, {})
  await start($); await assign($, 'started')
  expect((await spawn($, 'started')).deny).toContain('Started, then refused')
  expect(w.spawns).toHaveLength(1)
  expect(task(h, 'started').startedAt).not.toBeNull()
  expect(task(h, 'started').endedAt).toBeNull()
  expect(noStartKeys(w)).toHaveLength(0)
  await assign($, 'replacement'); expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
  expect(w.spawns).toHaveLength(1)
})

test('a downstream refusal survives restart with no settlement', options, async ($, on) => {
  const w = world(downstream(on, () => ({ deny: 'Refused' })), { sessionId: 'settlement-session' }); const h = hostState(on, {})
  await start($); await assign($, 'held'); await spawn($, 'held')
  expect(noStartKeys(w)).toHaveLength(0)
  h.delete('run-ledger'); await start($)
  expect(task(h, 'held').startedAt).not.toBeNull()
  await assign($, 'replacement')
  expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
  expect(w.spawns).toHaveLength(0)
})

test('a downstream refusal keeps ownership when the ledger cannot be written', options, async ($, on) => {
  let fail = false
  const w = world(downstream(on, () => { fail = true; return { deny: 'Refused' } }), { sessionId: 'fault-session' }); const h = hostState(on, {}, { set: key => fail && key === 'run-ledger' })
  await start($); await assign($, 'held')
  expect((await spawn($, 'held')).deny).toContain('Refused')
  fail = false; w.failStoreWrites = ['ledger:fault-session']; h.delete('run-ledger'); await start($)
  await assign($, 'replacement')
  expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
  expect(noStartKeys(w)).toHaveLength(0)
})

test('a late downstream refusal keeps overlapping admissions blocked before and after it arrives', options, async ($, on) => {
  let entered!: () => void; let release!: () => void
  const reached = new Promise<void>(r => { entered = r }); const gate = new Promise<void>(r => { release = r })
  const w = world(downstream(on, async () => { entered(); await gate; return { deny: 'Late refusal' } }), { sessionId: 'mock-session' }); const h = hostState(on, {})
  await start($); await assign($, 'late'); await assign($, 'replacement')
  const pending = spawn($, 'late'); await reached
  // Still in flight, so it may yet bind: nothing says waiting cannot help.
  const again = (await spawn($, 'late')).deny!
  expect(again).toContain('late is being dispatched')
  expect(again).not.toContain('No command releases')
  const early = (await spawn($, 'replacement')).deny!
  expect(early).toContain('ownership conflict')
  expect(early).toContain('retry after dependency/ownership/resource clears')
  expect(early).not.toContain('a retry cannot succeed')
  await w.clock.advance(600001); await control($, { action: 'status' })
  expect(task(h, 'late').state).toBe('stalled')
  release(); expect((await pending).deny).toContain('Late refusal')
  expect(task(h, 'late').startedAt).not.toBeNull()
  expect(task(h, 'late').reason).toContain('Late refusal')
  const late = (await spawn($, 'replacement')).deny!
  expect(late).toContain('ownership conflict')
  expect(late).toContain('a retry cannot succeed')
})

for (const [name, answer] of [['empty deny', { deny: '' }], ['blank deny', { deny: '   ' }]] as const) {
  test(`${name} after dispatch binds nothing and releases nothing`, options, async ($, on) => {
    const w = world(downstream(on, () => answer), { sessionId: 'mock-session' }); const h = hostState(on, {})
    await start($); await assign($, 'held'); await spawn($, 'held').catch(() => undefined)
    expect(task(h, 'held').agentId).toBeNull()
    expect(task(h, 'held').startedAt).not.toBeNull()
    expect(noStartKeys(w)).toHaveLength(0)
    await assign($, 'replacement'); expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
  })
}

test('liveness cost: a refused named-path spawn holds commander effects but not inspection', options, async ($, on) => {
  const w = world(downstream(on, () => ({ deny: 'Refused' })), { sessionId: 'mock-session' }); hostState(on, {})
  await start($); await assign($, 'held', 'write', ['/work/named.ts']); await spawn($, 'held')
  const reached = w.ran.length
  expect((await $.tool.call({ tool: 'Bash', command: 'printf x > /elsewhere' } as never)).deny).toContain('held until active ownership releases')
  expect((await $.tool.call({ tool: 'Write', file_path: '/work/named.ts', content: 'x' } as never)).deny).toContain('conflicts with active ownership')
  expect(w.ran).toHaveLength(reached)
  expect((await $.tool.call({ tool: 'Read', file_path: '/work/named.ts' } as never)).deny).toBeUndefined()
})

test('late verified ID binds once while concurrent overlapping admissions stay blocked', options, async ($, on) => {
  let entered!: () => void; let release!: () => void
  const reached = new Promise<void>(r => { entered = r }); const gate = new Promise<void>(r => { release = r })
  let wait = true
  const registering = ((event: string, handler: (...args: any[]) => any) => {
    if (event === 'agent.spawn') return on('agent.spawn', async (host, e) => { const result = await handler(host, e); if (wait) { entered(); await gate }; return result })
    return (on as any)(event, handler)
  }) as typeof on
  const w = world(registering, { sessionId: 'mock-session' }); const h = hostState(on, {}); await start($)
  await assign($, 'late'); await assign($, 'replacement')
  const pending = spawn($, 'late'); await reached
  const blocked = await Promise.all([spawn($, 'late'), spawn($, 'replacement')])
  expect(blocked.every(r => r.deny)).toBe(true)
  await w.clock.advance(600001); await control($, { action: 'status' })
  h.delete('run-ledger'); w.agents = []; await start($)
  expect(task(h, 'late').agentId).toBeNull()
  expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
  release(); const result = await pending; wait = false
  expect(task(h, 'late').agentId).toBe(result.agentId)
  expect(task(h, 'late').state).toBe('running'); expect(ledger(h).swarm!.actual).toBe(1)
  await assign($, 'read-one', 'read', ['/work/read.ts']); await assign($, 'read-two', 'read', ['/work/read.ts'])
  expect((await Promise.all([spawn($, 'read-one'), spawn($, 'read-two')])).every(r => r.agentId)).toBe(true)
  expect(w.spawns).toHaveLength(3)
})

test('binding state-write failure after dispatch retains the durable claim', options, async ($, on) => {
  let fail = false
  const registering = ((event: string, handler: (...args: any[]) => any) => {
    if (event === 'agent.spawn') return on('agent.spawn', async (host, e) => { const result = await handler(host, e); fail = true; return result })
    return (on as any)(event, handler)
  }) as typeof on
  const w = world(registering, { sessionId: 'binding-session' }); const h = hostState(on, {}, { set: key => fail && key === 'run-ledger' })
  await start($); await assign($, 'uncertain'); await spawn($, 'uncertain').catch(() => undefined)
  expect(task(h, 'uncertain').agentId).toBeNull()
  expect(task(h, 'uncertain').startedAt).not.toBeNull()
  fail = false; h.delete('run-ledger'); w.agents = []; await start($)
  await assign($, 'replacement'); expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
  expect(w.spawns).toHaveLength(1)
})

test('failed claim readback before dispatch settles a partial write and survives restart', options, async ($, on) => {
  let fail = true
  const registering = ((event: string, handler: (...args: any[]) => any) => {
    if (event === 'store.get') return on('store.get', (host, e) => fail && e.key.startsWith('spawn-claim:') ? { value: undefined } : handler(host, e))
    return (on as any)(event, handler)
  }) as typeof on
  const w = world(registering, { sessionId: 'readback-session' }); const h = hostState(on, {})
  await start($); await assign($, 'retry'); expect((await spawn($, 'retry')).deny).toBeDefined()
  expect(w.spawns).toHaveLength(0); expect(task(h, 'retry').startedAt).toBeNull()
  fail = false; h.delete('run-ledger'); await start($)
  expect((await spawn($, 'retry')).agentId).toBeDefined()
})

test('claim enumeration failure cannot permit replacement dispatch', options, async ($, on) => {
  let fail = false
  const registering = ((event: string, handler: (...args: any[]) => any) => {
    if (event === 'store.keys') return on('store.keys', (host, e) => fail ? { value: null } as never : handler(host, e))
    return (on as any)(event, handler)
  }) as typeof on
  const w = world(registering, { sessionId: 'enumeration-session' }); hostState(on, {})
  await start($); await assign($, 'writer'); fail = true
  expect((await spawn($, 'writer')).deny).toBeDefined(); expect(w.spawns).toHaveLength(0)
  fail = false; expect((await spawn($, 'writer')).agentId).toBeDefined()
})

test('unknown session identity refuses dispatch rather than using a shared durable key', options, async ($, on) => {
  const w = world(on); hostState(on, {})
  await start($); await assign($, 'writer')
  expect((await spawn($, 'writer')).deny).toBeDefined(); expect(w.spawns).toHaveLength(0)
})

for (const failure of ['keys', 'claim-read', 'ledger-read']) {
  test(`${failure}: restart cannot lose ownership for commander effects or adoption`, options, async ($, on) => {
    let broken = false; let failMarker = false
    const registering = ((event: string, handler: (...args: any[]) => any) => {
      if (event === 'agent.spawn') return on('agent.spawn', async (host, e) => { const result = await handler(host, e); return { model: result.model } })
      if (event === 'store.keys') return on('store.keys', (host, e) => broken && failure === 'keys' ? { value: null } as never : handler(host, e))
      if (event === 'store.get') return on('store.get', (host, e) => {
        if (broken && ((failure === 'claim-read' && e.key.startsWith('spawn-claim:')) || (failure === 'ledger-read' && e.key.startsWith('ledger:')))) throw new Error('durable read failed')
        return handler(host, e)
      })
      return (on as any)(event, handler)
    }) as typeof on
    const w = world(registering, { sessionId: 'restore-session' }); const h = hostState(on, {}, { set: key => failMarker && key === 'run-ledger' })
    await start($); await assign($, 'uncertain'); await spawn($, 'uncertain')
    w.store.delete('ledger:restore-session') // the ordinary snapshot was lost or stale
    h.delete('run-ledger'); w.agents = []; broken = true; await start($)
    const reached = w.ran.length
    for (const effect of [
      { tool: 'Write', file_path: '/work/shared.ts', content: 'replacement' },
      { tool: 'Edit', file_path: '/work/shared.ts', old_string: 'a', new_string: 'b' },
      { tool: 'MultiEdit', file_path: '/work/shared.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
      { tool: 'NotebookEdit', notebook_path: '/work/shared.ts', new_source: 'b', cell_type: 'code', edit_mode: 'replace' },
      { tool: 'Bash', command: 'printf replacement > /work/shared.ts' },
      { tool: 'mcp__fixture__effect' },
    ]) expect((await $.tool.call(effect as never)).deny).toBeDefined()
    expect(w.ran).toHaveLength(reached)
    await assign($, 'replacement')
    w.agents = [{ id: 'replacement-agent', description: '[task:uncertain]', type: 'worker', status: 'running' }]
    const adopted = await control($, { action: 'adopt', task_id: 'replacement', agent_id: 'replacement-agent' })
    expect(Boolean(adopted.deny) || adopted.isError === true).toBe(true)
    // A failed attempt to record the warning is not permission for the effect.
    failMarker = true
    expect((await $.tool.call({ tool: 'Write', file_path: '/work/shared.ts', content: 'replacement' } as never)).deny).toBeDefined()
    failMarker = false; broken = false; await start($)
    expect(task(h, 'uncertain').startedAt).not.toBeNull()
    await assign($, 'replacement-after-recovery')
    expect((await spawn($, 'replacement-after-recovery')).deny).toContain('ownership conflict')
    expect((await $.tool.call({ tool: 'Read', file_path: '/work/shared.ts' } as never)).deny).toBeUndefined()
    expect(w.spawns).toHaveLength(1)
  })
}
