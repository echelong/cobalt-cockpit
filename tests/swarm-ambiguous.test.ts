// Ownership under ambiguous dispatch, exercised through the real host hook chain.
// This does not establish host fencing or drain already admitted effects.
import { expect, test } from 'claude-code/testing'
import type { Ledger } from '../types'
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

test('authoritative downstream denial releases without claiming a stopped agent', options, async ($, on) => {
  let deny = true
  const registering = ((event: string, handler: (...args: any[]) => any) => {
    if (event === 'agent.spawn') return on('agent.spawn', (host, e) => deny ? { deny: 'Host refused before start' } : handler(host, e))
    return (on as any)(event, handler)
  }) as typeof on
  const w = world(registering, { sessionId: 'mock-session' }); const h = hostState(on, {}); await start($); await assign($, 'retry')
  expect((await spawn($, 'retry')).deny).toContain('before start')
  expect(task(h, 'retry').state).toBe('queued'); expect(task(h, 'retry').startedAt).toBeNull()
  expect(w.spawns).toHaveLength(0)
  deny = false; expect((await spawn($, 'retry')).agentId).toBeDefined()
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

test('denial with failed no-start settlement retains ownership through restart', options, async ($, on) => {
  const registering = ((event: string, handler: (...args: any[]) => any) => {
    if (event === 'agent.spawn') return on('agent.spawn', () => ({ deny: 'Definite no-start' }))
    if (event === 'store.set') return on('store.set', (host, e) => {
      if (e.key.startsWith('spawn-no-start:')) throw new Error('no-start persistence failed')
      return handler(host, e)
    })
    return (on as any)(event, handler)
  }) as typeof on
  const w = world(registering, { sessionId: 'settlement-session' }); const h = hostState(on, {})
  await start($); await assign($, 'held'); await spawn($, 'held')
  expect(task(h, 'held').startedAt).not.toBeNull()
  h.delete('run-ledger'); await start($); await assign($, 'replacement')
  expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
  expect(w.spawns).toHaveLength(0)
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
