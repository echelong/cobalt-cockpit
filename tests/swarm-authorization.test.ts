// Future-call authorization only: these tests do not establish native fencing or drain admitted effects.
import { expect, test } from 'claude-code/testing'
import type { Ledger } from '../types'
import { hostState, start, world } from './world'

type Engine = Parameters<typeof start>[0]
const SWARM = 'mcp__cobalt-cockpit__swarm'
const PROGRESS = 'mcp__cobalt-cockpit__progress'
const FILE = '/work/example/shared.ts'
const options = { options: { orchestration: true, maxSubagents: 16 } }
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)
const control = ($: Engine, input: Record<string, unknown>) => call($, { tool: SWARM, ...input })
const assign = ($: Engine, id: string, owned = ['*'], mode = 'write') => control($, { action: 'assign', task_id: id, tier: 'SONNET', role: 'Engineer', objective: `Bounded ${id}`, owned_resources: owned, mode, spawn_reason: 'Independent bounded authorization test' })
const spawn = ($: Engine, id: string) => $.agent.spawn({ prompt: `Bounded ${id}`, description: `[task:${id}] bounded work`, subagentType: 'cobalt-cockpit:worker', tool_use_id: `spawn-${id}`, parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false } as never)
const finish = ($: Engine, agentId: string, reason: string) => $.turn.complete({ agentId, turnId: `turn-${agentId}`, reason, answer: 'Observed result', durationMs: 1, isAborted: reason === 'aborted' } as never)
const ledger = (h: ReturnType<typeof hostState>) => h.get('run-ledger')!.value as Ledger
const task = (h: ReturnType<typeof hostState>, id: string) => ledger(h).swarm!.tasks.find(t => t.id === id)!
const step = async ($: Engine, agentId: string) => {
  const stream = $.turn.step({ turnId: 'resumed', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId } as never)
  let at = await stream.next()
  while (at.done !== true) at = await stream.next()
  return at.value
}
const effects = [
  { tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' },
  { tool: 'Write', file_path: FILE, content: 'b' },
  { tool: 'MultiEdit', file_path: FILE, edits: [{ old_string: 'a', new_string: 'b' }] },
  { tool: 'NotebookEdit', notebook_path: FILE, new_source: 'b', cell_type: 'code', edit_mode: 'replace' },
  { tool: 'Bash', command: `printf stale > ${FILE}` },
  { tool: 'mcp__fixture__effect' },
]

for (const reason of ['answer', 'error', 'aborted', 'refusal']) {
  test(`${reason}: retired wildcard agent cannot act after overlapping replacement admission`, options, async ($, on) => {
    const w = world(on); const h = hostState(on, {}); await start($)
    await assign($, 'old'); const a = (await spawn($, 'old')).agentId!
    expect((await call($, { tool: 'ToolSearch', agentId: a, query: 'select:mcp__fixture__effect' })).deny).toBeUndefined()
    await finish($, a, reason); await assign($, 'replacement'); const b = (await spawn($, 'replacement')).agentId!
    const reached = w.ran.length
    for (const effect of effects) expect([effect.tool, Boolean((await call($, { ...effect, agentId: a })).deny)]).toEqual([effect.tool, true])
    expect((await call($, { tool: 'ToolSearch', agentId: a, query: 'select:mcp__fixture__effect' })).deny).toBeDefined()
    expect((await call($, { tool: 'SubagentHandback', agentId: a, message: 'Late handback' })).deny).toBeDefined()
    expect(w.ran).toHaveLength(reached)
    expect(task(h, 'old').endedAt).not.toBeNull(); expect(task(h, 'replacement').agentId).toBe(b)
    expect((await call($, { ...effects[4], agentId: b })).deny).toBeUndefined()
  })
  test(`${reason}: same-ID resumed model step sends no request`, options, async ($, on) => {
    const w = world(on); await start($); await assign($, 'old'); const a = (await spawn($, 'old')).agentId!
    await finish($, a, reason); await assign($, 'replacement'); expect((await spawn($, 'replacement')).agentId).toBeDefined()
    await step($, a); expect(w.requests).toEqual([]); expect(w.efforts).toEqual([])
  })
}

test('cancellation blocks late effects, reports, escalation and new model steps without releasing ownership', options, async ($, on) => {
  const w = world(on); const h = hostState(on, {}); await start($)
  await assign($, 'old'); const a = (await spawn($, 'old')).agentId!
  await control($, { action: 'cancel', task_id: 'old' })
  for (const effect of effects) expect((await call($, { ...effect, agentId: a })).deny).toBeDefined()
  const before = JSON.stringify(task(h, 'old'))
  const result = await control($, { agentId: a, task_id: 'old', action: 'result', conclusion: 'Unapproved new result' })
  expect(Boolean(result.deny) || result.isError === true).toBe(true)
  expect(JSON.stringify(task(h, 'old'))).toBe(before)
  await step($, a); expect(w.requests).toEqual([])
  await assign($, 'replacement'); expect((await spawn($, 'replacement')).deny).toContain('ownership conflict')
  await finish($, a, 'aborted'); expect((await call($, { ...effects[4], agentId: a })).deny).toBeDefined()
  expect(w.ran).toEqual([]); expect(w.ran.some(c => c.tool === 'TaskStop')).toBe(false)
})

test('retired own status is read-only; progress and mutation controls cannot bypass authorization', options, async ($, on) => {
  const w = world(on); const h = hostState(on, {}); await start($)
  await assign($, 'old'); const a = (await spawn($, 'old')).agentId!; await finish($, a, 'answer')
  await assign($, 'replacement'); await spawn($, 'replacement'); await w.clock.advance(300001)
  const before = JSON.stringify(ledger(h).swarm!.tasks)
  const status = await control($, { agentId: a, task_id: 'old', action: 'status' })
  expect(status.deny).toBeUndefined(); expect(status.isError).not.toBe(true)
  expect(JSON.stringify(ledger(h).swarm!.tasks)).toBe(before)
  const attempts = [
    { tool: PROGRESS, action: 'gate', gate: 'SECURITY', state: 'pass', evidence: 'stale claim' },
    ...['assign', 'verify', 'adopt', 'cancel', 'resolve', 'wave', 'result', 'escalate'].map(action => ({ tool: SWARM, action, task_id: 'old', tier: 'SONNET', role: 'Engineer', objective: 'No authority', state: 'pass', evidence: ['claim'], wave: 'INTEGRATION', to: 'OPUS', question: 'change', conclusion: 'claim' })),
  ]
  for (const input of attempts) {
    const r = await call($, { ...input, agentId: a })
    expect([input.tool, input.action, Boolean(r.deny) || r.isError === true]).toEqual([input.tool, input.action, true])
  }
  expect(JSON.stringify(ledger(h).swarm!.tasks)).toBe(before)
})

test('ended escalation cannot be revised by its retired agent', options, async ($, on) => {
  world(on); const h = hostState(on, {}); await start($); await assign($, 'old'); const a = (await spawn($, 'old')).agentId!
  const handoff = { tool: SWARM, agentId: a, action: 'escalate', task_id: 'old', to: 'OPUS', question: 'Original question', evidence: ['shared.ts:1'] }
  expect((await call($, handoff)).isError).not.toBe(true); await finish($, a, 'answer')
  expect(task(h, 'old').state).toBe('escalated'); const before = JSON.stringify(task(h, 'old'))
  const r = await call($, { ...handoff, question: 'Retired rewrite' }); expect(Boolean(r.deny) || r.isError === true).toBe(true)
  expect(JSON.stringify(task(h, 'old'))).toBe(before)
})

for (const agentId of ['', 'unknown-agent']) test(`unknown identity ${JSON.stringify(agentId)} cannot use effects, progress, swarm authority or models`, options, async ($, on) => {
  const w = world(on); const h = hostState(on, {}); await start($)
  for (const effect of effects) expect((await call($, { ...effect, agentId })).deny).toBeDefined()
  const r = await control($, { agentId, action: 'assign', task_id: 'injected', tier: 'SONNET', role: 'Engineer', objective: 'Unauthorized', owned_resources: ['*'], mode: 'write' })
  expect(Boolean(r.deny) || r.isError === true).toBe(true); expect(ledger(h).swarm!.tasks).toEqual([])
  expect((await call($, { tool: PROGRESS, agentId, action: 'gate', gate: 'SECURITY', state: 'pass' })).deny).toBeDefined()
  await step($, agentId); expect(w.requests).toEqual([]); expect(w.ran).toEqual([])
})

test('a description naming a queued task does not authorize an unbound agent', options, async ($, on) => {
  const w = world(on); const h = hostState(on, {}); await start($); await assign($, 'queued')
  w.agents.push({ id: 'unbound', description: '[task:queued] bounded work', type: 'worker', status: 'running' })
  await step($, 'unbound'); expect(w.requests).toEqual([]); expect(task(h, 'queued').agentId).toBeNull()
})

test('ambiguous duplicate binding grants neither tools nor model execution', options, async ($, on) => {
  const w = world(on); const h = hostState(on, {}); await start($); await assign($, 'old'); const a = (await spawn($, 'old')).agentId!
  const prior = h.get('run-ledger')!
  h.set('run-ledger', { value: { ...ledger(h), swarm: { ...ledger(h).swarm!, tasks: [...ledger(h).swarm!.tasks, { ...task(h, 'old'), id: 'ambiguous' }] } }, version: prior.version + 1 })
  expect((await call($, { ...effects[4], agentId: a })).deny).toBeDefined()
  await step($, a); expect(w.requests).toEqual([]); expect(w.ran).toEqual([])
})

test('ownership lookup failure refuses new tools and model steps', options, async ($, on) => {
  let fail = false
  const w = world(on); hostState(on, {}, { get: key => fail && key === 'run-ledger' }); await start($)
  await assign($, 'old'); const a = (await spawn($, 'old')).agentId!; fail = true
  expect((await call($, { ...effects[4], agentId: a })).deny).toBeDefined()
  await step($, a); expect(w.requests).toEqual([]); expect(w.ran).toEqual([])
})

test('active wildcard writer retains effects, discovery, native handback and own reporting', options, async ($, on) => {
  const w = world(on); const h = hostState(on, {}); await start($); await assign($, 'active'); const a = (await spawn($, 'active')).agentId!
  for (const effect of effects) expect([effect.tool, (await call($, { ...effect, agentId: a })).deny]).toEqual([effect.tool, undefined])
  expect((await call($, { tool: 'ToolSearch', agentId: a, query: 'select:mcp__fixture__effect' })).deny).toBeUndefined()
  expect((await control($, { agentId: a, action: 'result', task_id: 'active', conclusion: 'Bounded report', evidence: ['shared.ts:1'] })).isError).not.toBe(true)
  expect((await call($, { tool: 'SubagentHandback', agentId: a, message: 'Bounded report' })).deny).toBeUndefined()
  await step($, a); expect(w.requests).toHaveLength(1); expect(task(h, 'active').state).toBe('running')
})

for (const mode of ['write', 'read']) test(`active scoped ${mode} agent retains bounded Git inspection and its intended permissions`, options, async ($, on) => {
  const w = world(on); await start($); await assign($, 'scoped', [FILE], mode); const a = (await spawn($, 'scoped')).agentId!
  expect((await call($, { tool: 'Read', agentId: a, file_path: FILE })).deny).toBeUndefined()
  expect((await call($, { tool: 'Bash', agentId: a, command: 'git diff -- shared.ts' })).deny).toBeUndefined()
  expect((await call($, { tool: 'Edit', agentId: a, file_path: FILE, old_string: 'a', new_string: 'b' })).deny === undefined).toBe(mode === 'write')
  expect((await call($, { tool: 'Bash', agentId: a, command: `printf x > ${FILE}` })).deny).toBeDefined()
  expect((await call($, { tool: 'mcp__fixture__effect', agentId: a })).deny).toBeDefined()
  await step($, a); expect(w.requests).toHaveLength(1)
})

test('retirement during a scoped tool lookup is rechecked before native execution', options, async ($, on) => {
  const w = world(on); await start($); await assign($, 'old', [FILE]); const a = (await spawn($, 'old')).agentId!
  let armed = true
  w.duringRun = async argv => {
    if (armed && argv[0] === 'realpath') {
      armed = false; await finish($, a, 'answer'); await assign($, 'replacement', [FILE]); expect((await spawn($, 'replacement')).agentId).toBeDefined()
    }
  }
  const r = await call($, { ...effects[0], agentId: a })
  expect(armed).toBe(false); expect(r.deny).toBeDefined()
  expect(w.ran.filter(c => c.agentId === a)).toEqual([])
})

test('retirement during model policy lookup is rechecked before sending a request', options, async ($, on) => {
  let retire: (() => Promise<unknown>) | undefined
  const register = ((event: string, handler: (...args: any[]) => any) => event === 'state.get' ? on('state.get', async (host, e) => {
    if (retire && e.key === 'effort-known') { const run = retire; retire = undefined; await run() }
    return handler(host, e)
  }) : (on as any)(event, handler)) as typeof on
  const w = world(on); hostState(register, {}); await start($); await assign($, 'old'); const a = (await spawn($, 'old')).agentId!
  retire = () => finish($, a, 'answer')
  await step($, a); expect(retire).toBeUndefined(); expect(w.requests).toEqual([])
})
