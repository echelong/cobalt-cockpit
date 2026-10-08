// Dynamic reasoning effort through the real host hooks. Every assertion is on
// what actually reached the engine (`w.efforts`, the requests it really sent),
// what the ledger recorded, and what the diagnostics print — never on a claim
// a drawing makes about itself. `tests/effort.test.ts` covers the arithmetic in
// isolation; this file covers the wiring around it.

import { describe, expect, test as engineTest } from 'claude-code/testing'

import type { Ledger } from '../types'
import { command, hostState, mountHud, mountPane, rowsOf, start, world } from './world'

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

const ledgerOf = (held: ReturnType<typeof hostState>): Ledger => held.get('run-ledger')!.value as Ledger
const taskOf = (held: ReturnType<typeof hostState>, id: string) => ledgerOf(held).swarm!.tasks.find(t => t.id === id)!
const agentOf = (held: ReturnType<typeof hostState>, id: string) => ledgerOf(held).agents.find(a => a.id === id)!
const knownOf = (held: ReturnType<typeof hostState>) => held.get('effort-known')!.value as Record<string, readonly string[]>
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

describe('capability fallback is named, never hidden', () => {
  test('a level the model cannot honour is warned, observed and clamped next time', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await assign($, 'deep', { effort: 'xhigh' })
    const a = (await spawn($, 'deep')).agentId!
    await step($, SONNET, { agentId: a })
    expect(w.efforts[0]).toMatchObject({ effort: 'xhigh', agentId: a })
    // The engine really applied high. The fact is folded in and said aloud.
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tu1', agent_id: a, effort: { level: 'high' } } as never)
    expect(ledgerOf(held).warnings.some(warning => warning.includes('EFFORT FALLBACK'))).toBe(true)
    expect(knownOf(held)[SONNET]).not.toContain('xhigh')
    // The next request to the same task is clamped, and the fallback is named.
    await step($, SONNET, { agentId: a, index: 1 })
    expect(w.efforts[1]).toMatchObject({ effort: 'high', agentId: a })
    expect(agentOf(held, a).fallbackReason).toContain('not supported')
  })

  test('an honoured level is recorded as observed without a warning', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await assign($, 'ok', { effort: 'high' })
    const a = (await spawn($, 'ok')).agentId!
    await step($, SONNET, { agentId: a })
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tu1', agent_id: a, effort: { level: 'high' } } as never)
    expect(ledgerOf(held).warnings.some(warning => warning.includes('EFFORT FALLBACK'))).toBe(false)
    expect(knownOf(held)[SONNET]).toContain('high')
    expect(agentOf(held, a).effectiveEffort).toBe('high')
    expect(w.outbound).toEqual([])
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
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await assign($, 'deep', { effort: 'xhigh' })
    const a = (await spawn($, 'deep')).agentId!
    await step($, SONNET, { agentId: a })
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tu1', agent_id: a, effort: { level: 'high' } } as never)
    const text = (await command($, 'version')).text ?? ''
    expect(text).toContain('REASONING / AUTO · ceiling MAX')
    expect(text).toContain('SOURCE /')
    expect(text).toContain('SESSION MODEL / claude-opus-5-5')
    expect(text).toContain(`OBSERVED EFFORT / ${SONNET} low/medium/high`)
    expect(text).not.toContain('xhigh')
    expect(knownOf(held)[SONNET]).toEqual(['low', 'medium', 'high'])
    expect(w.outbound).toEqual([])
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