// A resume of an existing agent, exercised through the test runner's hook chain, which carries `resume` on both pinned hosts.
// On a real host only Claude Code 2.1.316 raised `agent.spawn` for a resume; 2.1.296 raised nothing, so this refusal is not
// reached there and a resume meets only the guards. None of this establishes that a stopped agent's effects ended, and
// nothing here releases ownership.
import { expect, test } from 'claude-code/testing'
import type { Ledger } from '../types'
import { hostState, start, world } from './world'

type Engine = Parameters<typeof start>[0]
const options = { options: { orchestration: true, maxSubagents: 16, animation: false } }
const SWARM = 'mcp__cobalt-cockpit__swarm'
const control = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: SWARM, ...input } as never)
const assign = ($: Engine, id: string, owned = ['/work/shared.ts']) => control($, { action: 'assign', task_id: id, tier: 'SONNET', role: 'Engineer', objective: `Bounded ${id}`, owned_resources: owned, mode: 'write' })
const input = (id: string, extra: Record<string, unknown> = {}) => ({ prompt: `Bounded ${id}`, description: `[task:${id}] bounded work`, subagentType: 'cobalt-cockpit:worker', tool_use_id: `spawn-${id}`, parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false, ...extra })
const spawn = ($: Engine, id: string, extra: Record<string, unknown> = {}) => $.agent.spawn(input(id, extra) as never)
const ledger = (h: ReturnType<typeof hostState>) => h.get('run-ledger')!.value as Ledger
const tasks = (h: ReturnType<typeof hostState>) => ledger(h).swarm!.tasks
const claims = (w: ReturnType<typeof world>) => [...w.store.keys()].filter(k => k.startsWith('spawn-claim:'))
const end = ($: Engine, agentId: string, reason: 'answer' | 'aborted') => $.turn.complete({ turnId: `t-${agentId}`, agentId, reason, answer: 'stopped', stopReason: 'end_turn', usage: null, durationMs: 1 } as never)


for (const reason of ['aborted', 'answer'] as const) {
  test(`resume of an agent whose task ended on ${reason} opens no claim, starts nothing and changes no task`, options, async ($, on) => {
    const w = world(on, { sessionId: 'resume-session' }); const h = hostState(on, {})
    await start($); await assign($, 'first')
    const a = await spawn($, 'first')
    await end($, a.agentId!, reason)
    const before = JSON.stringify(tasks(h)); const keys = claims(w).length; const dispatched = w.spawns.length
    const answer = await spawn($, 'first', { resume: { agentId: a.agentId } })
    expect(answer.deny).toContain('resuming an agent is refused')
    expect(answer.agentId).toBeUndefined()
    expect(JSON.stringify(tasks(h))).toBe(before)
    expect(claims(w)).toHaveLength(keys)
    expect(w.spawns).toHaveLength(dispatched)
    await assign($, 'next')
    expect((await spawn($, 'next')).agentId).toBeDefined()
  })
}

test('resume of an agent Cockpit never bound is refused and creates no wildcard reservation', options, async ($, on) => {
  const w = world(on, { sessionId: 'resume-session' }); const h = hostState(on, {})
  await start($)
  const answer = await spawn($, 'unbound', { resume: { agentId: 'never-bound' } })
  expect(answer.deny).toContain('resuming an agent is refused')
  expect(tasks(h).filter(t => t.owned.includes('*'))).toHaveLength(0)
  expect(claims(w)).toHaveLength(0)
  expect(w.spawns).toHaveLength(0)
  expect((await $.tool.call({ tool: 'Bash', command: 'printf x > /work/a' } as never)).deny).toBeUndefined()
})

test('resume of a bound agent with active ownership is refused and its ownership is unchanged', options, async ($, on) => {
  const w = world(on, { sessionId: 'resume-session' }); const h = hostState(on, {})
  await start($); await assign($, 'live')
  const a = await spawn($, 'live')
  const before = JSON.stringify(tasks(h)); const keys = claims(w).length; const dispatched = w.spawns.length
  const answer = await spawn($, 'live', { resume: { agentId: a.agentId } })
  expect(answer.deny).toContain('resuming an agent is refused')
  expect(w.spawns).toHaveLength(dispatched)
  expect(claims(w)).toHaveLength(keys)
  expect(JSON.stringify(tasks(h))).toBe(before)
  await assign($, 'replacement')
  expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
})

// The shape a real host sends: `SendMessage` carries no [task:ID], so the old path made a wildcard task of it.
for (const [name, ended] of [['a finished agent', 'answer'], ['a stopped agent', 'aborted']] as const) {
  test(`a host-shaped resume of ${name} opens no wildcard and leaves the commander free`, options, async ($, on) => {
    const w = world(on, { sessionId: 'resume-session' }); const h = hostState(on, {})
    await start($); await assign($, 'first')
    const a = await spawn($, 'first')
    await end($, a.agentId!, ended)
    const before = JSON.stringify(tasks(h)); const keys = claims(w).length; const dispatched = w.spawns.length
    const answer = await $.agent.spawn({ prompt: 'continue', description: 'resumed agent', subagentType: 'general-purpose', tool_use_id: 'resume-call', parentModel: 'claude-opus-5-5', resume: { agentId: a.agentId } } as never)
    expect(answer.deny).toContain('resuming an agent is refused')
    expect(JSON.stringify(tasks(h))).toBe(before)
    expect(tasks(h).filter(t => t.owned.includes('*'))).toHaveLength(0)
    expect(claims(w)).toHaveLength(keys)
    expect(w.spawns).toHaveLength(dispatched)
    expect((await $.tool.call({ tool: 'Bash', command: 'printf x > /work/a' } as never)).deny).toBeUndefined()
  })
}

for (const [name, extra] of [['a helper', { parentAgentId: 'helper' }], ['a fork', { fork: true }]] as const) {
  test(`resume from ${name} is refused and changes nothing`, options, async ($, on) => {
    const w = world(on, { sessionId: 'resume-session' }); const h = hostState(on, {})
    await start($); await assign($, 'live')
    const a = await spawn($, 'live'); const dispatched = w.spawns.length
    const answer = await spawn($, 'live', { resume: { agentId: a.agentId }, ...extra })
    expect(answer.deny).toContain('resuming an agent is refused')
    expect(w.spawns).toHaveLength(dispatched)
    expect(tasks(h)[0]!.state).toBe('running')
  })
}

for (const [name, resume] of [['no agent', {}], ['a null resume', null], ['a non-string agent', { agentId: 7 }]] as const) {
  test(`resume naming ${name} is refused`, options, async ($, on) => {
    const w = world(on, { sessionId: 'resume-session' }); hostState(on, {})
    await start($)
    expect((await spawn($, 'nobody', { resume })).deny).toContain('resuming an agent is refused')
    expect(w.spawns).toHaveLength(0)
  })
}

test('resume after cancellation was requested is refused and ownership stays held', options, async ($, on) => {
  world(on, { sessionId: 'resume-session' }); const h = hostState(on, {})
  await start($); await assign($, 'cancelling')
  const a = await spawn($, 'cancelling')
  await control($, { action: 'cancel', task_id: 'cancelling' })
  const answer = await spawn($, 'cancelling', { resume: { agentId: a.agentId } })
  expect(answer.deny).toContain('resuming an agent is refused')
  expect(tasks(h)[0]!.endedAt).toBeNull()
  await assign($, 'replacement')
  expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
})

test('resume is refused, not started, when durable ownership cannot be read', options, async ($, on) => {
  let broken = false
  const registering = ((event: string, handler: (...args: any[]) => any) => {
    if (event === 'store.keys') return on('store.keys', (host, e) => broken ? { value: null } as never : handler(host, e))
    return (on as any)(event, handler)
  }) as typeof on
  const w = world(registering, { sessionId: 'resume-session' }); hostState(on, {})
  await start($); await assign($, 'live')
  const a = await spawn($, 'live'); const dispatched = w.spawns.length
  broken = true
  const answer = await spawn($, 'live', { resume: { agentId: a.agentId } })
  expect(answer.deny).toContain('resuming an agent is refused')
  expect(w.spawns).toHaveLength(dispatched)
})

test('with orchestration off a resume is not refused by this rule', { options: { orchestration: false, animation: false } }, async ($, on) => {
  const w = world(on, { sessionId: 'resume-session' }); hostState(on, {})
  await start($)
  const answer = await spawn($, 'observed', { resume: { agentId: 'some-agent' } })
  expect(answer.deny ?? '').not.toContain('resuming an agent is refused')
  expect(w.spawns).toHaveLength(1)
})

test('a spawn with no resume is untouched', options, async ($, on) => {
  const w = world(on, { sessionId: 'resume-session' }); const h = hostState(on, {})
  await start($); await assign($, 'plain')
  expect((await spawn($, 'plain')).agentId).toBeDefined()
  expect(tasks(h)[0]!.state).toBe('running')
  expect(claims(w)).toHaveLength(1)
})
