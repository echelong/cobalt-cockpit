// Dynamic reasoning effort through the real host hooks. Every assertion is on
// what actually reached the engine (`w.efforts`, the requests it really sent),
// what the ledger recorded, and what the diagnostics print — never on a claim
// a drawing makes about itself. `tests/effort.test.ts` covers the arithmetic in
// isolation; this file covers the wiring around it.

import { describe, expect, test as engineTest } from 'claude-code/testing'

import type { Ledger } from '../types'
import { command, hostState, mountHud, mountPane, rowsOf, start, world } from './world'
import type { World } from './world'

const test: typeof engineTest = ((name: string, optionsOrRun: any, run?: any) => {
  const options = typeof optionsOrRun === 'function' ? {} : optionsOrRun
  return engineTest(name, { ...options, options: { orchestration: true, maxSubagents: 6, ...options.options } }, run ?? optionsOrRun)
}) as unknown as typeof engineTest

type Engine = Parameters<typeof start>[0]

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'
const SWARM = 'mcp__cobalt-cockpit__swarm'

/** One model request of a turn, run through the hooks; what it resolved to. */
const step = async ($: Engine, model: string, over: Record<string, unknown> = {}) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 3, ...over } as never)
  let at = await stream.next()
  while (at.done !== true) at = await stream.next()

  return at.value as { answer: string }
}

const assign = ($: Engine, id: string, over: Record<string, unknown> = {}) =>
  $.tool.call({
    tool: SWARM, action: 'assign', task_id: id, tier: 'SONNET', role: 'worker',
    objective: `Bounded ${id}`, scope: `Scope ${id}`, owned_resources: [`/work/example/${id}.ts`],
    mode: 'write', dependencies: [], spawn_reason: 'Host effort fixture', ...over,
  } as never)

let seq = 0
const spawn = ($: Engine, id: string) =>
  $.agent.spawn({
    prompt: `Perform ${id}`, description: `[task:${id}] bounded work`, subagentType: 'cobalt-cockpit:worker',
    tool_use_id: `spawn-${++seq}`, parentModel: OPUS, provider: { plugin: 'cobalt-cockpit', tier: 'user' },
    background: true, fork: false,
  } as never)

// An engine that takes `effort` on the Agent call; the world's default is older.
const NATIVE = { version: '2.1.294' }

/**
 * A subagent launched the way the engine does it: the Agent call first, then
 * its spawn under the same tool-use id. `sent` is the call as it reached the
 * engine, so its `effort` is the level the subagent really starts with.
 */
const launch = async ($: Engine, w: World, id: string | null, over: Record<string, unknown> = {}) => {
  const tool_use_id = `agent-use-${++seq}`
  const description = id === null ? 'unassigned bounded work' : `[task:${id}] bounded work`
  const subagentType = String(over['subagent_type'] ?? 'cobalt-cockpit:worker')
  await $.tool.call({ tool: 'Agent', tool_use_id, description, prompt: `Perform ${id ?? 'work'}`, subagent_type: subagentType, ...over } as never)
  const sent = w.ran.find(call => call['tool_use_id'] === tool_use_id)!
  const spawned = await $.agent.spawn({
    prompt: `Perform ${id ?? 'work'}`, description, subagentType, tool_use_id, parentModel: OPUS,
    provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false,
  } as never)

  return { agentId: spawned.agentId!, sent }
}

const ledgerOf = (held: ReturnType<typeof hostState>): Ledger => held.get('run-ledger')!.value as Ledger
const taskOf = (held: ReturnType<typeof hostState>, id: string) => ledgerOf(held).swarm!.tasks.find(t => t.id === id)!
const agentOf = (held: ReturnType<typeof hostState>, id: string) => ledgerOf(held).agents.find(a => a.id === id)!
const knownOf = (held: ReturnType<typeof hostState>) => (held.get('effort-known')?.value ?? {}) as Record<string, readonly string[]>
const fallbacks = (held: ReturnType<typeof hostState>) => ledgerOf(held).warnings.filter(warning => warning.includes('EFFORT FALLBACK'))
const paneText = async ($: Engine, columns = 100): Promise<string> => {
  const pane = await mountPane($, 'terminal', columns)
  const text = (await rowsOf(pane)).join('\n')
  await pane.unmount()

  return text
}
const hudText = async ($: Engine, columns = 120): Promise<string> => {
  const hud = await mountHud($, 'terminal', columns, true)
  const text = (await rowsOf(hud)).join('\n')
  await hud.unmount()

  return text
}

describe('AUTO effort reaches the engine', () => {
  test('the main loop runs the Opus baseline the policy names', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await $.turn.start({ text: 'Ship the limiter', turnId: 't1' })
    await step($, OPUS)
    expect(w.requests).toEqual([{ model: OPUS }])
    expect(w.efforts).toEqual([{ model: OPUS, effort: 'high' }])
    const run = ledgerOf(held).runs[0]!
    expect(run).toMatchObject({ model: OPUS, effort: 'high', effortSource: 'request', requestedEffort: 'high' })
    expect(run.routingReason).toContain('OPUS baseline')
  })

  test('a Sonnet engineering task is selected at medium; a Haiku inventory task at low', async ($, on) => {
    const w = world(on)
    await start($)
    await assign($, 'feat', { tier: 'SONNET', role: 'worker', mode: 'write' })
    await assign($, 'scan', { tier: 'HAIKU', role: 'scout', mode: 'read' })
    const feat = (await spawn($, 'feat')).agentId!
    const scan = (await spawn($, 'scan')).agentId!
    await step($, SONNET, { agentId: feat })
    await step($, HAIKU, { agentId: scan })
    expect(w.efforts).toEqual([
      { model: SONNET, effort: 'medium', agentId: feat },
      { model: HAIKU, effort: 'low', agentId: scan },
    ])
  })

  test('a level named on the task wins AUTO and is folded back as applied', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await assign($, 'named', { effort: 'xhigh', effort_reason: 'tight coupling' })
    const a = (await spawn($, 'named')).agentId!
    await step($, SONNET, { agentId: a })
    expect(w.efforts).toEqual([{ model: SONNET, effort: 'xhigh', agentId: a }])
    expect(taskOf(held, 'named').requestedEffort).toBe('xhigh')
    expect(taskOf(held, 'named').effortReason).toBe('tight coupling')
    expect(taskOf(held, 'named').appliedEffort).toBe('xhigh')
    expect(agentOf(held, a)).toMatchObject({ requestedEffort: 'xhigh', effort: 'xhigh' })
    expect(agentOf(held, a).routingReason).toContain('named by the commander')
  })
})

describe('the operator ceiling and MANUAL mode', () => {
  test('the configured ceiling caps a named request and the reason says so', { options: { maxEffort: 'medium' } }, async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await assign($, 'capped', { effort: 'xhigh' })
    const a = (await spawn($, 'capped')).agentId!
    await step($, SONNET, { agentId: a })
    expect(w.efforts[0]).toMatchObject({ model: SONNET, effort: 'medium', agentId: a })
    // the task still records what the commander asked for; only the applied level moved
    expect(taskOf(held, 'capped').requestedEffort).toBe('xhigh')
    expect(agentOf(held, a).routingReason).toContain('capped at the configured ceiling')
    expect(agentOf(held, a).effort).toBe('medium')
  })

  test('MANUAL honours the fixed tier level and leaves Haiku unspecified', { options: { reasoningMode: 'MANUAL' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await step($, OPUS)
    await assign($, 'man', { tier: 'SONNET', role: 'worker', mode: 'write' })
    const a = (await spawn($, 'man')).agentId!
    await step($, SONNET, { agentId: a })
    await assign($, 'man-scan', { tier: 'HAIKU', role: 'scout', mode: 'read' })
    const h = (await spawn($, 'man-scan')).agentId!
    await step($, HAIKU, { agentId: h })
    expect(w.efforts[0]).toEqual({ model: OPUS, effort: 'high' })
    expect(w.efforts[1]).toEqual({ model: SONNET, effort: 'medium', agentId: a })
    // no fixed level is named for Haiku, so the engine's own is left in place
    expect(w.efforts[2]).toEqual({ model: HAIKU, agentId: h })
  })
})

describe('a subagent is launched at its level natively', () => {
  test('each Agent call carries its own level: Haiku low and high, Sonnet medium and high', async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    await assign($, 'h-low', { tier: 'HAIKU', role: 'scout', mode: 'read' })
    await assign($, 'h-high', { tier: 'HAIKU', role: 'scout', mode: 'read', effort: 'high' })
    await assign($, 's-medium', { tier: 'SONNET', role: 'worker', mode: 'write' })
    await assign($, 's-high', { tier: 'SONNET', role: 'worker', mode: 'write', effort: 'high' })
    const cases = [['h-low', HAIKU, 'low'], ['h-high', HAIKU, 'high'], ['s-medium', SONNET, 'medium'], ['s-high', SONNET, 'high']] as const
    for (const [id, model, level] of cases) {
      const { agentId, sent } = await launch($, w, id)
      // the level is on the call itself: nothing global is set for a sibling to race on
      expect(sent['effort']).toBe(level)
      // the engine resolved the loop's requests from it; the hook reads that, and rewrites nothing
      await step($, model, { agentId, effort: level })
      expect(w.efforts.at(-1)).toEqual({ model, effort: level, agentId })
      expect(taskOf(held, id)).toMatchObject({ launchEffort: level, appliedEffort: level })
      expect(agentOf(held, agentId)).toMatchObject({ effort: level, effortSource: 'engine', effortVia: 'host', effectiveEffort: level, fallbackReason: 'unknown' })
    }
    expect(fallbacks(held)).toEqual([])
    expect(w.outbound).toEqual([])
  })

  test('a level the engine caps is recorded as the engine resolved it, with the reason, and learned', async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    await assign($, 'capped', { effort: 'high' })
    const { agentId, sent } = await launch($, w, 'capped')
    expect(sent['effort']).toBe('high')
    // the engine's own cap resolved medium for the request: it wins, and is not rewritten back
    await step($, SONNET, { agentId, effort: 'medium' })
    expect(w.efforts[0]).toEqual({ model: SONNET, effort: 'medium', agentId })
    expect(taskOf(held, 'capped')).toMatchObject({ requestedEffort: 'high', launchEffort: 'high', appliedEffort: 'medium' })
    expect(agentOf(held, agentId)).toMatchObject({ requestedEffort: 'high', effort: 'medium', effortSource: 'engine', effectiveEffort: 'medium' })
    expect(agentOf(held, agentId).fallbackReason).toContain('engine resolved medium')
    expect(fallbacks(held)).toEqual(['EFFORT FALLBACK / engine applied medium; requested high'])
    expect(knownOf(held)[SONNET]).not.toContain('high')
    // the next launch asks for what the engine will give, and says why
    await $.turn.complete({ turnId: 't1', agentId, answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    await assign($, 'capped-next', { effort: 'high' })
    const next = await launch($, w, 'capped-next')
    expect(next.sent['effort']).toBe('medium')
    await step($, SONNET, { agentId: next.agentId, effort: 'medium' })
    expect(agentOf(held, next.agentId).fallbackReason).toContain('not supported')
  })

  test('a level the model cannot honour is warned, observed and clamped next time', async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    await assign($, 'deep', { effort: 'xhigh' })
    const { agentId, sent } = await launch($, w, 'deep')
    expect(sent['effort']).toBe('xhigh')
    // The engine really resolved high. The fact is folded in and said aloud.
    await step($, SONNET, { agentId, effort: 'high' })
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tu1', agent_id: agentId, effort: { level: 'high' } } as never)
    expect(fallbacks(held).length).toBeGreaterThan(0)
    expect(knownOf(held)[SONNET]).not.toContain('xhigh')
    expect(agentOf(held, agentId)).toMatchObject({ effort: 'high', effectiveEffort: 'high' })
    await $.turn.complete({ turnId: 't1', agentId, answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    await assign($, 'deep-next', { effort: 'xhigh' })
    const next = await launch($, w, 'deep-next')
    expect(next.sent['effort']).toBe('high')
    await step($, SONNET, { agentId: next.agentId, effort: 'high' })
    expect(agentOf(held, next.agentId).fallbackReason).toContain('not supported')
  })

  test('an honoured level is recorded as observed without a warning', async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    await assign($, 'ok', { effort: 'high' })
    const { agentId } = await launch($, w, 'ok')
    await step($, SONNET, { agentId, effort: 'high' })
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tu1', agent_id: agentId, effort: { level: 'high' } } as never)
    expect(fallbacks(held)).toEqual([])
    expect(knownOf(held)[SONNET]).toContain('high')
    expect(agentOf(held, agentId).effectiveEffort).toBe('high')
    expect(w.outbound).toEqual([])
  })

  test('a model the engine sends no effort is recorded as none, not as the level asked for', async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    await assign($, 'bare', { tier: 'HAIKU', role: 'scout', mode: 'read', effort: 'high' })
    const { agentId } = await launch($, w, 'bare')
    await step($, HAIKU, { agentId })
    expect(w.efforts[0]).toEqual({ model: HAIKU, agentId })
    expect(taskOf(held, 'bare')).toMatchObject({ launchEffort: 'high', appliedEffort: null })
    expect(agentOf(held, agentId)).toMatchObject({ effort: 'unknown', effortSource: 'unknown' })
    expect(agentOf(held, agentId).fallbackReason).toContain('no effort')
    expect(fallbacks(held)).toEqual(['EFFORT FALLBACK / engine applied no effort; requested high'])
  })

  test('a level put on the Agent call by hand becomes the requested level, under the ceiling', { options: { maxEffort: 'high' } }, async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    await assign($, 'hand')
    const { agentId, sent } = await launch($, w, 'hand', { effort: 'xhigh' })
    expect(sent['effort']).toBe('high')
    expect(taskOf(held, 'hand')).toMatchObject({ requestedEffort: 'xhigh', launchEffort: 'high' })
    expect(taskOf(held, 'hand').effortReason).toContain('named on the Agent call')
    await step($, SONNET, { agentId, effort: 'high' })
    expect(agentOf(held, agentId).routingReason).toContain('capped at the configured ceiling')
  })

  test('the level the assignment names wins one put on the call', async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    await assign($, 'named', { effort: 'low', effort_reason: 'mechanical' })
    const { sent } = await launch($, w, 'named', { effort: 'high' })
    expect(sent['effort']).toBe('low')
    expect(taskOf(held, 'named')).toMatchObject({ requestedEffort: 'low', effortReason: 'mechanical', launchEffort: 'low' })
  })

  test('an unassigned Agent call still gets the level its role deserves', async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    const { agentId, sent } = await launch($, w, null, { subagent_type: 'cobalt-cockpit:scout' })
    expect(sent['effort']).toBe('low')
    expect(ledgerOf(held).swarm!.tasks.find(t => t.agentId === agentId)).toMatchObject({ tier: 'HAIKU', launchEffort: 'low' })
  })

  test('MANUAL sets the fixed Sonnet level on the call and leaves a Haiku call alone', { options: { reasoningMode: 'MANUAL' } }, async ($, on) => {
    const w = world(on, NATIVE)
    await start($)
    await assign($, 'man', { tier: 'SONNET', role: 'worker', mode: 'write' })
    await assign($, 'man-scan', { tier: 'HAIKU', role: 'scout', mode: 'read' })
    expect((await launch($, w, 'man')).sent['effort']).toBe('medium')
    expect('effort' in (await launch($, w, 'man-scan')).sent).toBe(false)
  })

  test('with orchestration off the Agent call is left exactly as it was made', { options: { orchestration: false } }, async ($, on) => {
    const w = world(on, NATIVE)
    await start($)
    expect('effort' in (await launch($, w, null)).sent).toBe(false)
    expect((await launch($, w, null, { effort: 'high' })).sent['effort']).toBe('high')
  })
})

describe('a subagent whose first request arrives before its spawn has bound it', () => {
  test('the task is found by the id its description carries, so the first request runs at the named level', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await assign($, 'early', { effort: 'high' })
    // the engine lists the subagent as running; the spawn has not returned, so nothing is bound yet
    w.agents.push({ id: 'early-agent', description: '[task:early] bounded work', type: 'cobalt-cockpit:worker', status: 'running' })
    await step($, SONNET, { agentId: 'early-agent', effort: 'medium' })
    // not the Sonnet baseline: the level the assignment names
    expect(w.efforts[0]).toEqual({ model: SONNET, effort: 'high', agentId: 'early-agent' })
    expect(taskOf(held, 'early').appliedEffort).toBe('high')
  })

  test('a natively launched one keeps the level it was launched with, and no policy mismatch is invented', async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    // an unassigned subagent the engine started at high: no task is known for it yet
    w.agents.push({ id: 'unknown-agent', description: 'unassigned bounded work', type: 'cobalt-cockpit:worker', status: 'running' })
    await step($, SONNET, { agentId: 'unknown-agent', effort: 'high' })
    expect(w.efforts[0]).toEqual({ model: SONNET, effort: 'high', agentId: 'unknown-agent' })
    expect(ledgerOf(held).warnings.filter(warning => warning.includes('MODEL POLICY'))).toEqual([])
  })

  test('a launch that did not start leaves no level on the task', async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    await assign($, 'held-a', { owned_resources: ['/work/example/shared.ts'], effort: 'high' })
    await assign($, 'held-b', { owned_resources: ['/work/example/shared.ts'], effort: 'high' })
    const first = await launch($, w, 'held-a')
    expect(taskOf(held, 'held-a').launchEffort).toBe('high')
    // the second writer of the same file is queued, not started: it was launched with nothing
    const second = await launch($, w, 'held-b')
    expect(second.agentId).toBeUndefined()
    expect(taskOf(held, 'held-b')).toMatchObject({ agentId: null, launchEffort: null })
    expect(first.agentId).toBeDefined()
  })
})

describe('a request this hook rewrote is not confirmed by the engine', () => {
  test('an engine older than the parameter gets no effort on the call and the turn.step level instead', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await assign($, 'old', { effort: 'high' })
    const { agentId, sent } = await launch($, w, 'old')
    expect('effort' in sent).toBe(false)
    expect(taskOf(held, 'old').launchEffort).toBeNull()
    await step($, SONNET, { agentId, effort: 'medium' })
    expect(w.efforts[0]).toEqual({ model: SONNET, effort: 'high', agentId })
    expect(agentOf(held, agentId)).toMatchObject({ effort: 'high', effortSource: 'request', effortVia: 'hook' })
  })

  test('the engine report of such a loop is not taken for the applied level, and high does not become medium', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await assign($, 'kept', { effort: 'high' })
    const a = (await spawn($, 'kept')).agentId!
    // the engine resolved medium from the agent's own settings; the hook sends high
    await step($, SONNET, { agentId: a, effort: 'medium' })
    expect(w.efforts[0]).toEqual({ model: SONNET, effort: 'high', agentId: a })
    // The engine reports the loop's own level, which the rewrite is not in. It
    // is not a downgrade: nothing is warned, recorded as applied or learned.
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tu1', agent_id: a, effort: { level: 'medium' } } as never)
    expect(fallbacks(held)).toEqual([])
    expect(knownOf(held)[SONNET]).toBeUndefined()
    expect(agentOf(held, a)).toMatchObject({ requestedEffort: 'high', effort: 'high', effortSource: 'request' })
    expect(agentOf(held, a).effectiveEffort).toBeUndefined()
    // so the next request still carries high, with no fallback invented for it
    await step($, SONNET, { agentId: a, effort: 'medium', index: 1 })
    expect(w.efforts[1]).toEqual({ model: SONNET, effort: 'high', agentId: a })
    expect(agentOf(held, a).fallbackReason).toBe('unknown')
    expect(taskOf(held, 'kept').appliedEffort).toBe('high')
  })

  test('a tool that reports back while that request is still answering changes nothing either', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await assign($, 'mid', { effort: 'high' })
    const a = (await spawn($, 'mid')).agentId!
    const stream = $.turn.step({ turnId: 't1', index: 0, model: SONNET, messageCount: 3, agentId: a, effort: 'medium' } as never)
    // the request is out and its answer is streaming: nothing is in the ledger for it yet
    await stream.next()
    expect(w.efforts[0]).toEqual({ model: SONNET, effort: 'high', agentId: a })
    await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'tu-mid', agent_id: a, effort: { level: 'medium' } } as never)
    let at = await stream.next()
    while (at.done !== true) at = await stream.next()
    expect(fallbacks(held)).toEqual([])
    expect(knownOf(held)[SONNET]).toBeUndefined()
    expect(agentOf(held, a)).toMatchObject({ effort: 'high', effortSource: 'request', effortVia: 'hook' })
    expect(agentOf(held, a).effectiveEffort).toBeUndefined()
  })

  test('the main loop is the same: a rewritten request is not overwritten by the engine report', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await $.turn.start({ text: 'Ship the limiter', turnId: 't1' })
    await step($, OPUS, { effort: 'medium' })
    expect(w.efforts[0]).toEqual({ model: OPUS, effort: 'high' })
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tu1', effort: { level: 'medium' } } as never)
    expect(ledgerOf(held).runs[0]).toMatchObject({ effort: 'high', effortSource: 'request', effortVia: 'hook', requestedEffort: 'high' })
    expect(fallbacks(held)).toEqual([])
    expect(knownOf(held)[OPUS]).toBeUndefined()
    expect(await hudText($)).toContain('opus-5-5 · high')
  })

  test('a main loop request the engine already resolved at the policy level is the engine own, and observed', async ($, on) => {
    world(on)
    const held = hostState(on, {})
    await start($)
    await $.turn.start({ text: 'Ship the limiter', turnId: 't1' })
    await step($, OPUS, { effort: 'high' })
    expect(ledgerOf(held).runs[0]).toMatchObject({ effort: 'high', effortSource: 'engine', effortVia: 'host', effectiveEffort: 'high' })
  })
})

describe('what the HUD and the diagnostics say', () => {
  test('the HUD names the applied effort beside the model', async ($, on) => {
    world(on)
    await start($)
    await step($, OPUS)
    expect(await hudText($)).toContain('opus-5-5 · high')
  })

  test('/cockpit version names the mode, the ceiling and only the effort really observed', async ($, on) => {
    const w = world(on, NATIVE)
    const held = hostState(on, {})
    await start($)
    await assign($, 'deep', { effort: 'xhigh' })
    const { agentId } = await launch($, w, 'deep')
    await step($, SONNET, { agentId, effort: 'high' })
    const text = (await command($, 'version')).text ?? ''
    expect(text).toContain('REASONING / AUTO · ceiling MAX')
    expect(text).toContain('SUBAGENT EFFORT / set on the Agent call')
    expect(text).toContain('SOURCE /')
    expect(text).toContain('SESSION MODEL / claude-opus-5-5')
    expect(text).toContain(`OBSERVED EFFORT / ${SONNET} low/medium/high`)
    expect(text).not.toContain('xhigh')
    expect(knownOf(held)[SONNET]).toEqual(['low', 'medium', 'high'])
    expect(w.outbound).toEqual([])
  })

  test('/cockpit version says when the engine cannot confirm a subagent level', async ($, on) => {
    world(on)
    await start($)
    expect((await command($, 'version')).text ?? '').toContain('SUBAGENT EFFORT / turn.step rewrite · the engine does not report it back')
  })

  test('the pane carries a REASONING row once the policy has set a mode', async ($, on) => {
    world(on)
    await start($)
    await step($, OPUS)
    const pane = await paneText($)
    expect(pane).toContain('REASONING')
    expect(pane).toMatch(/REASONING\s+AUTO/)
  })

  test('the policy text states AUTO and the ceiling in the composed prompt', async ($, on) => {
    world(on)
    await start($)
    const { sections } = await $.prompt.compose({ model: OPUS, promptModel: OPUS, surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const mine = sections.find(section => section.id === 'cobalt-cockpit:discipline')
    expect(mine?.text).toContain('Reasoning mode is AUTO')
    expect(mine?.text).toContain('ceiling for any request is MAX')
    expect(mine?.text).toContain('requested and applied effort are recorded separately')
  })
})