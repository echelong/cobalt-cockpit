// The workflow through the engine: the Fable block at every route, the
// authentication diagnostic, the subagent rules and what the HUD says about
// them. Each test runs the plugin's hooks over a world (world.ts) that records
// what actually reached the engine: the model requests sent, the subagents
// started, the tool calls run and every way out the plugin took by itself.

import { describe, expect, test as engineTest } from 'claude-code/testing'

import { roleOf } from '../hooks/orchestra'
import { BLOCK_LINE } from '../hooks/policy'
import { FIVE, bash, command, hostState, mountHud, mountPane, passAllGates, planAndComplete, progress, prompt, rowsOf, start, TOOL, world } from './world'
import type { World } from './world'

const test: typeof engineTest = ((name: string, optionsOrRun: any, run?: any) => {
  const options = typeof optionsOrRun === 'function' ? {} : optionsOrRun
  return engineTest(name, { ...options, options: { orchestration: true, blockFable: true, subscriptionOnly: true, maxSubagents: 3, ...options.options } }, run ?? optionsOrRun)
}) as unknown as typeof engineTest

type Engine = Parameters<typeof start>[0]

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const FABLE_NAMES = ['claude-fable-5-1', 'fable', 'advisor-fable', 'claude-fable', 'Claude-Fable-5-1', 'FABLE', 'Advisor-Fable', 'claude-fable-5-1[1m]']

/** One model request of a turn, run through the hooks; what streamed and what it resolved to. */
const step = async ($: Engine, model: string, over: Record<string, unknown> = {}) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 3, ...over } as never)
  const chunks: Record<string, unknown>[] = []
  // read by hand: the generator's own return value is the step's result
  let at = await stream.next()
  while (at.done !== true) {
    chunks.push(at.value as unknown as Record<string, unknown>)
    at = await stream.next()
  }

  return { chunks, result: at.value }
}

let uses = 0
/** The Agent tool starting a subagent, as the engine raises it. */
const spawn = async ($: Engine, over: Record<string, unknown> = {}) => {
  const taskId = `engine-task-${++uses}`
  const legacyReviewer = String(over['subagentType'] ?? '').includes('reviewer')
  const tier = String(over['model'] ?? '').includes('haiku') ? 'HAIKU' : 'SONNET'
  if (!legacyReviewer && !Object.values(over).some(value => typeof value === 'string' && /fable/i.test(value))) await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', action: 'assign', task_id: taskId, tier, role: roleOf(String(over['subagentType'] ?? 'worker')), objective: `Isolated work ${taskId}`, scope: 'Synthetic independent scope', owned_resources: [String(over['description'] ?? '').startsWith('Implement the limiter') ? '/work/example/src/limiter.ts' : String(over['subagentType'] ?? '').includes('explorer') && String(over['description'] ?? '').includes('bid') ? '/work/example/src/bids.ts' : `/work/example/synthetic/${taskId}`], mode: String(over['description'] ?? '').startsWith('Implement the limiter') ? 'write' : 'read', dependencies: [], spawn_reason: 'Independent engine fixture' } as never)
  return $.agent.spawn({
    prompt: 'Do the isolated piece',
    tool_use_id: `use-${++uses}`,
    subagentType: 'cobalt-cockpit:worker',
    provider: { plugin: 'cobalt-cockpit', tier: 'user' },
    parentModel: OPUS,
    background: true,
    fork: false,
    ...over,
    description: legacyReviewer ? String(over['description'] ?? 'Isolated review') : `[task:${taskId}] ${String(over['description'] ?? 'Isolated piece')}`,
  } as never)
}

const finish = ($: Engine, agentId: string, reason: 'answer' | 'error' = 'answer') =>
  $.turn.complete({ agentId, turnId: `turn-${agentId}`, reason, answer: 'Results only.', durationMs: 1000, isAborted: false } as never)

const call = ($: Engine, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, ...input } as never)

const slash = ($: Engine, name: string, args: string) =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

const hudText = async ($: Engine, columns = 120, isWorking = true): Promise<string> => {
  const hud = await mountHud($, 'terminal', columns, isWorking)
  const rows = (await rowsOf(hud)).join('\n')
  await hud.unmount()

  return rows
}

const paneText = async ($: Engine, columns = 100): Promise<string> => {
  const pane = await mountPane($, 'terminal', columns)
  const rows = (await rowsOf(pane)).join('\n')
  await pane.unmount()

  return rows
}

/** Everything the plugin did that could have reached a model or the network. */
const reached = (w: World) => ({ requests: w.requests, spawns: w.spawns.length, outbound: w.outbound, ran: w.ran.length })
const NOTHING = { requests: [], spawns: 0, outbound: [], ran: 0 }

describe('Fable is refused before anything is sent', () => {
  for (const name of FABLE_NAMES) {
    test(`a model request naming ${name} never reaches the engine`, async ($, on) => {
      const w = world(on)
      await start($)
      const { chunks, result } = await step($, name)
      // no request was made: the engine beneath the plugin saw nothing
      expect(reached(w)).toEqual(NOTHING)
      // the refusal is the response, and it is the one fixed line
      expect(result.answer).toBe(BLOCK_LINE)
      expect(result.toolUses).toEqual([])
      expect(result.usage).toBeNull()
      expect(chunks.map(chunk => chunk['kind'])).toEqual(['text', 'stop'])
      expect(chunks[0]?.['text']).toBe('MODEL BLOCK / FABLE / POLICY')
    })
  }

  test('the same holds inside a subagent\'s loop', async ($, on) => {
    const w = world(on)
    await start($)
    const { result } = await step($, 'claude-fable-5-1', { agentId: 'agent-7' })
    expect(w.requests).toEqual([])
    expect(result.answer).toBe(BLOCK_LINE)
  })

  test('what is recorded is the one line and a count: nothing of the request', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {})
    await start($)
    await prompt($, 'The secret plan is to ship on Friday')
    await step($, 'claude-fable-5-1')
    await step($, 'Advisor-Fable')
    expect(w.transcript).toEqual([BLOCK_LINE, BLOCK_LINE])
    const policy = held.get('policy')?.value as Record<string, unknown>
    expect(Object.keys(policy).sort()).toEqual(['blocks', 'calls', 'lastBlockAt'])
    expect(policy).toMatchObject({ blocks: 2, calls: 0 })
    expect(JSON.stringify(policy)).not.toMatch(/fable|secret|Friday/i)
  })

  test('the refusal does not depend on the engine version', { options: {} }, async ($, on) => {
    const w = world(on, { version: '2.1.100' })
    await start($)
    expect((await step($, 'fable')).result.answer).toBe(BLOCK_LINE)
    const answer = await call($, 'Agent', { prompt: 'x', description: 'y', model: 'fable' })
    expect((answer as { deny?: string }).deny).toContain(BLOCK_LINE)
    expect((await spawn($, { model: 'claude-fable-5-1' })).deny).toContain(BLOCK_LINE)
    expect(w.requests).toEqual([])
    expect(w.spawns).toEqual([])
    expect(w.ran).toEqual([])
  })
})

describe('no network or provider call is made for a refused request', () => {
  test('the plugin itself reaches no model, no URL and no MCP server, blocked or not', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    for (const name of FABLE_NAMES) await step($, name)
    for (const name of FABLE_NAMES) await spawn($, { model: name })
    await call($, 'Agent', { prompt: 'x', description: 'y', model: 'fable' })
    await call($, 'mcp__advisor-fable__ask', { question: 'x' })
    await bash($, 'cfable -p "hi"')
    await slash($, 'model', 'fable')
    expect(w.outbound).toEqual([])
    expect(w.requests).toEqual([])
    expect(w.spawns).toEqual([])
    expect(w.ran).toEqual([])
    // and no process was started to do it some other way: only git and the auth-free startup ran
    expect(w.runs.every(argv => argv[0] === 'git')).toBe(true)
  })

  test('ordinary work makes no extra call either: one request in, one request out', async ($, on) => {
    const w = world(on)
    await start($)
    await step($, OPUS)
    await call($, 'Read', { file_path: '/work/example/a.ts' })
    await step($, OPUS, { index: 1 })
    expect(w.requests).toEqual([{ model: OPUS }, { model: OPUS }])
    expect(w.outbound).toEqual([])
  })
})

describe('nothing falls back to Fable, and nothing is substituted for it', () => {
  test('a refused request is not re-sent on another model', async ($, on) => {
    const w = world(on)
    await start($)
    await step($, 'claude-fable-5-1')
    // the plugin did not quietly swap the model and send it anyway
    expect(w.requests).toEqual([])
  })

  test('a fallback the engine resolved to Fable is refused like any other request', async ($, on) => {
    // The session is on Opus; the engine's own fallback chain names Fable for
    // this one step. `turn.step` carries the model as resolved, so it is seen.
    const w = world(on, { model: OPUS })
    await start($)
    expect((await step($, OPUS)).result.answer).toBe('ok')
    expect((await step($, 'claude-fable-5-1', { index: 1 })).result.answer).toBe(BLOCK_LINE)
    expect(w.requests).toEqual([{ model: OPUS }])
  })

  test('a spawn naming Fable is refused, not started on Sonnet instead', async ($, on) => {
    const w = world(on)
    await start($)
    for (const name of FABLE_NAMES) {
      const answer = await spawn($, { model: name })
      expect(answer.deny, name).toContain(BLOCK_LINE)
      expect(answer.agentId, name).toBeUndefined()
    }
    expect(w.spawns).toEqual([])
    expect(await hudText($)).not.toContain('WORKER')
  })

  test('an agent type named for Fable is refused and is not offered to the model', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await spawn($, { subagentType: 'advisor-fable' })).deny).toContain(BLOCK_LINE)
    expect((await spawn($, { subagentType: 'plugin:Fable' })).deny).toContain(BLOCK_LINE)
    expect(w.spawns).toEqual([])
    const offer = { description: 'Ask the advisor', source: 'plugin', provider: { plugin: 'other', tier: 'user' } }
    expect(await $.agent.offer({ agent: 'advisor-fable', ...offer } as never)).toEqual({ isOffered: false })
    expect(await $.agent.offer({ agent: 'cobalt-cockpit:worker', ...offer } as never)).toEqual({ isOffered: true })
  })

  test('a fork of a parent that is on Fable does not inherit it', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await spawn($, { fork: true, subagentType: 'fork', parentModel: 'claude-fable-5-1' })).deny).toContain(BLOCK_LINE)
    expect(w.spawns).toEqual([])
  })

  test('a subagent with no model does not inherit: it runs on Sonnet', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($)
    expect(w.spawns[0]?.['model']).toBe(SONNET)
  })

  test('if anything beneath the plugin ever answered as Fable, the count would say so', async ($, on) => {
    // Not a path the plugin allows: this is what makes `Calls 0` a measurement.
    const w = world(on, { answersAs: 'claude-fable-5-1' })
    await start($)
    expect(await paneText($)).toMatch(/Calls\s+0/)
    await step($, OPUS)
    expect(await paneText($)).toMatch(/Calls\s+1/)
    expect(w.requests).toEqual([{ model: OPUS }])
  })
})

describe('every other route to Fable', () => {
  test('the Agent tool, a tool named for it, and a tool handed it as a model', async ($, on) => {
    const w = world(on)
    await start($)
    const denied = [
      await call($, 'Agent', { prompt: 'x', description: 'y', model: 'fable' }),
      await call($, 'Agent', { prompt: 'x', description: 'y', model: 'Claude-FABLE-5-1' }),
      await call($, 'Agent', { prompt: 'x', description: 'y', subagent_type: 'advisor-fable' }),
      await call($, 'mcp__advisor-fable__ask', { question: 'x' }),
      await call($, 'mcp__llm__complete', { model: 'claude-fable-5-1', prompt: 'x' }),
      await call($, 'Agent', { prompt: 'x', description: 'y', model: 'fable', agentId: 'agent-7' }),
    ]
    for (const answer of denied) expect((answer as { deny?: string }).deny).toContain(BLOCK_LINE)
    // not one of them reached the engine
    expect(w.ran).toEqual([])
  })

  test('a shell command that would start Claude Code on it', async ($, on) => {
    const w = world(on)
    await start($)
    for (const line of ['cfable', 'claude --model fable -p hi', 'claude -p hi --advisor Fable', 'ANTHROPIC_MODEL=claude-fable-5-1 claude -p hi', 'bash -c "claude --model fable"']) {
      expect(((await bash($, line)) as { deny?: string }).deny, line).toContain(BLOCK_LINE)
    }
    expect(w.ran).toEqual([])
  })

  test('an edit that would configure it', async ($, on) => {
    const w = world(on, { files: { '/home/tester/.claude/settings.json': '{ "model": "opus" }' } })
    await start($)
    const edit = await call($, 'Edit', { file_path: '/home/tester/.claude/settings.json', old_string: '"model": "opus"', new_string: '"model": "claude-fable-5-1"' })
    const write = await call($, 'Write', { file_path: '/work/example/.claude/settings.local.json', content: '{"advisorModel":"fable"}' })
    expect((edit as { deny?: string }).deny).toContain(BLOCK_LINE)
    expect((write as { deny?: string }).deny).toContain(BLOCK_LINE)
    expect(w.ran).toEqual([])
  })

  test('/model and /advisor given Fable change nothing', async ($, on) => {
    const w = world(on)
    await start($)
    for (const [name, args] of [['model', 'fable'], ['model', 'claude-fable-5-1'], ['model', 'FABLE'], ['advisor', 'fable'], ['advisor', 'Claude-Fable-5-1']] as const) {
      expect((await slash($, name, args)).text, `/${name} ${args}`).toContain(BLOCK_LINE)
    }
    expect(w.transcript).toEqual(Array.from({ length: 5 }, () => BLOCK_LINE))
    // any other model is the engine's to switch to
    expect((await slash($, 'model', 'sonnet')).text).toBe('')
    expect((await slash($, 'model', 'opus')).text).toBe('')
  })

  test('a config row that chooses a model is not set to Fable; denying it is allowed', async ($, on) => {
    world(on)
    await start($)
    const row = { previous: 'opus', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } }
    expect(await $.config.set({ key: 'model', value: 'fable', ...row } as never)).toEqual({ deny: BLOCK_LINE })
    expect(await $.config.set({ key: 'advisorModel', value: 'Claude-Fable-5-1', ...row } as never)).toEqual({ deny: BLOCK_LINE })
    expect(await $.config.set({ key: 'model', value: 'sonnet', ...row } as never)).toEqual({ value: 'sonnet' })
    expect(await $.config.set({ key: 'deniedModels', value: ['fable', 'claude-fable-5-1'], ...row } as never)).toEqual({ value: ['fable', 'claude-fable-5-1'] })
    expect(await $.config.set({ key: 'theme', value: 'fable', ...row } as never)).toEqual({ value: 'fable' })
  })

  test('a session already on Fable has its prompt dropped before a turn starts', async ($, on) => {
    const w = world(on, { model: 'claude-fable-5-1' })
    await start($)
    const answer = await prompt($, 'Add rate limiting')
    expect(answer.drop).toContain(BLOCK_LINE)
    expect(answer.drop).toContain('/model opus')
    expect(w.submitted).toEqual([])
    expect(w.requests).toEqual([])
  })

  test('Fable configured as the advisor refuses every request until it is unset', async ($, on) => {
    // The advisor rides inside another model's request, so the request's own
    // model says nothing about it: the setting is what is checked.
    const w = world(on, { settings: { advisorModel: 'claude-fable-5-1' } })
    await start($)
    expect((await prompt($, 'Add rate limiting')).drop).toContain('as its advisor')
    expect((await step($, OPUS)).result.answer).toBe(BLOCK_LINE)
    expect((await step($, SONNET, { agentId: 'agent-7' })).result.answer).toBe(BLOCK_LINE)
    expect(w.requests).toEqual([])
    // unset, and read again when /advisor returns: work goes on
    w.settings = {}
    await slash($, 'advisor', 'off')
    expect((await step($, OPUS)).result.answer).toBe('ok')
    expect(w.requests).toEqual([{ model: OPUS }])
  })

  test('work that only mentions the word is untouched', async ($, on) => {
    const w = world(on)
    await start($)
    await bash($, 'grep -rn fable hooks/')
    await bash($, 'git commit -m "block fable in the cockpit"')
    await call($, 'Read', { file_path: '/work/example/docs/fable.md' })
    await call($, 'Grep', { pattern: 'claude-fable', path: '.' })
    await call($, 'Edit', { file_path: '/work/example/tests/policy.test.ts', old_string: 'a', new_string: "isFable('claude-fable-5-1')" })
    await call($, 'Agent', { prompt: 'Explain why fable is blocked', description: 'Explain the policy', subagent_type: 'cobalt-cockpit:explorer' })
    expect(w.ran.map(one => one['tool'])).toEqual(['Bash', 'Bash', 'Read', 'Grep', 'Edit', 'Agent'])
    expect(w.transcript).toEqual([])
  })
})

describe('what is allowed', () => {
  test('Opus runs: the main loop\'s request goes through unchanged', async ($, on) => {
    const w = world(on)
    await start($)
    const { result, chunks } = await step($, OPUS, { effort: 'high' })
    expect(result.answer).toBe('ok')
    expect(chunks.map(chunk => chunk['kind'])).toEqual(['text', 'stop'])
    expect(w.requests).toEqual([{ model: OPUS }])
    expect(w.transcript).toEqual([])
    expect(await paneText($)).toMatch(/Calls\s+0/)
  })

  test('Sonnet runs: a subagent\'s request, and a spawn that names it', async ($, on) => {
    const w = world(on)
    await start($)
    const started = await spawn($, { model: 'sonnet' })
    expect(started).toMatchObject({ agentId: 'spawned-1', model: SONNET })
    expect((await step($, SONNET, { agentId: 'spawned-1', effort: 'medium' })).result.answer).toBe('ok')
    expect(w.requests).toEqual([{ model: SONNET, agentId: 'spawned-1' }])
    expect(w.transcript).toEqual([])
  })

  test('commander policy maps engineering to Sonnet and utility to Haiku', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await spawn($, { model: 'opus' })).model).toBe(SONNET)
    expect((await spawn($, { model: 'haiku' })).model).toBe('claude-haiku-5-5')
    expect(w.spawns.map(one => one['model'])).toEqual([SONNET, 'claude-haiku-5-5'])
  })

  test('NobodyWho runs locally: its commands pass and its receipts are drawn', { options: { ledgerPath: '/home/tester/.local/state/decision-router/ledger.jsonl' } }, async ($, on) => {
    const LEDGER = '/home/tester/.local/state/decision-router/ledger.jsonl'
    const receipt = `${JSON.stringify({
      ts: '2026-10-03T07:39:10.565+00:00',
      operation: 'prune',
      request_id: 'fresh1',
      caller: 'claude',
      provider: 'nobodywho',
      model: 'Qwen_Qwen3-4B-Q4_K_M',
      tier: 1,
      latency_ms: 37,
      attempts: [{ tier: 1, provider: 'nobodywho', outcome: 'accepted', judged_blocks: 4, dropped_blocks: 2 }],
    })}\n`
    const files: Record<string, string> = { [LEDGER]: '' }
    const w = world(on, { files })
    await start($)
    await w.clock.settle()
    await w.clock.settle()
    await prompt($, 'Add rate limiting')
    // the router's own commands are ordinary shell commands and run untouched
    await bash($, 'decision ask --caller claude --json \'{"state":"x","question":"Which route?","choices":{"first_route":"a","second_route":"b"}}\'')
    await bash($, 'decision prune --caller claude -- bash -c "npm test"')
    expect(w.ran.map(one => one['tool'])).toEqual(['Bash', 'Bash'])
    // a real local receipt arrives and is shown as local control
    files[LEDGER] = receipt
    await w.clock.settle()
    await w.clock.advance(2_000)
    expect(await hudText($)).toContain('NWHO · PRUNE · Q4B · 4→2 · 37ms')
    expect(await paneText($)).toMatch(/NWHO \/ LOCAL\s+PRUNE · Q4B · 4→2 · 37ms/)
    // and none of it was a model request, a block or a call out
    expect(w.requests).toEqual([])
    expect(w.outbound).toEqual([])
    expect(w.transcript).toEqual([])
  })
})

describe('the authentication diagnostic', () => {
  test('on the subscription: said once at startup, then out of the way', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.toasts).toEqual(['AUTH / SUBSCRIPTION · API BILLING / OFF · FABLE / BLOCKED'])
    expect(w.transcript).toEqual([])
    // the HUD reserves nothing for it, and never names Fable
    const hud = await hudText($)
    expect(hud).not.toContain('AUTH')
    expect(hud.toLowerCase()).not.toContain('fable')
    // a reload that finds the same reading does not announce it again
    await start($)
    expect(w.toasts).toHaveLength(1)
  })

  test('/cockpit auth and the pane carry the detail, with the calls counted', async ($, on) => {
    world(on)
    await start($)
    expect((await command($, 'auth')).text).toBe('AUTH / SUBSCRIPTION\nAPI BILLING / OFF\nFABLE / BLOCKED\nFABLE CALLS / 0')
    const pane = await paneText($)
    expect(pane).toContain('11 AUTH')
    expect(pane).toMatch(/Auth\s+SUBSCRIPTION/)
    expect(pane).toMatch(/API billing\s+OFF/)
    expect(pane).toMatch(/Policy\s+BLOCKED/)
    expect(pane).toMatch(/Calls\s+0/)
    await step($, 'fable')
    expect((await command($, 'auth')).text).toContain('FABLE REFUSED / 1')
    expect(await paneText($)).toMatch(/Refused\s+1/)
  })

  test('subscription usage is not dressed up as a cost figure', async ($, on) => {
    world(on)
    await start($)
    const said = [(await command($, 'auth')).text ?? '', await paneText($)].join('\n')
    expect(said).not.toContain('$0')
    expect(said).not.toMatch(/API tokens/i)
  })

  const SECRET = 'sk-ant-synthetic'

  test('an API key in the environment is reported by name, and its value appears nowhere', async ($, on) => {
    const w = world(on, { env: { ANTHROPIC_API_KEY: SECRET }, credential: { handle: 'held-by-the-engine', kind: 'api-key' } })
    const held = hostState(on, {})
    await start($)
    // the startup diagnostic does not say billing is off
    expect(w.toasts).toEqual(['AUTH / API DETECTED · FABLE / BLOCKED'])
    expect(w.toasts.join(' ')).not.toContain('API BILLING / OFF')
    expect(w.toasts.join(' ')).not.toContain('SUBSCRIPTION')
    expect(w.transcript).toHaveLength(1)
    expect(w.transcript[0]).toContain('AUTH / API DETECTED')
    expect(w.transcript[0]).toContain('env ANTHROPIC_API_KEY')
    // the warning stays on the HUD, and the detail names the source
    expect(await hudText($)).toContain('AUTH / API DETECTED')
    const auth = (await command($, 'auth')).text ?? ''
    expect(auth).toContain('AUTH / API DETECTED')
    expect(auth).toContain('SOURCE / env ANTHROPIC_API_KEY')
    expect(auth).not.toContain('API BILLING / OFF')
    const pane = await paneText($)
    expect(pane).toMatch(/Auth\s+API DETECTED/)
    expect(pane).toContain('env ANTHROPIC_API_KEY is set')
    // the secret is in none of it: not drawn, not logged, not held in state
    const everything = [w.toasts.join('\n'), w.transcript.join('\n'), await hudText($), auth, pane, JSON.stringify([...held.entries()])].join('\n')
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain('sk-ant')
    expect(everything).not.toContain('held-by-the-engine')
  })

  test('on API authentication this workflow sends nothing', async ($, on) => {
    const w = world(on, { env: { ANTHROPIC_API_KEY: SECRET }, credential: { handle: 'h', kind: 'api-key' } })
    await start($)
    const answer = await prompt($, 'Add rate limiting')
    expect(answer.drop).toContain('AUTH / API DETECTED')
    expect(answer.drop).not.toContain(SECRET)
    expect(w.submitted).toEqual([])
    expect((await step($, OPUS)).result.answer).toBe('AUTH / API DETECTED')
    expect(w.requests).toEqual([])
  })

  for (const [name, value] of [['ANTHROPIC_AUTH_TOKEN', SECRET], ['ANTHROPIC_BASE_URL', 'https://gateway.example/v1'], ['CLAUDE_CODE_USE_BEDROCK', '1']] as const) {
    test(`a sign-in credential beside ${name} is still reported as API`, async ($, on) => {
      const w = world(on, { env: { [name]: value } })
      await start($)
      expect(w.toasts).toEqual(['AUTH / API DETECTED · FABLE / BLOCKED'])
      const auth = (await command($, 'auth')).text ?? ''
      expect(auth).toContain(`SOURCE / env ${name}`)
      expect(auth).not.toContain('API BILLING / OFF')
      expect(`${auth}\n${w.transcript.join('\n')}`).not.toContain(SECRET)
      expect(`${auth}\n${w.transcript.join('\n')}`).not.toContain('gateway.example')
    })
  }

  test('a key helper or a key in the settings is found too', async ($, on) => {
    const w = world(on, { settings: { apiKeyHelper: `/usr/local/bin/print-key ${SECRET}`, env: { ANTHROPIC_API_KEY: SECRET } } })
    await start($)
    expect(w.toasts).toEqual(['AUTH / API DETECTED · FABLE / BLOCKED'])
    const auth = (await command($, 'auth')).text ?? ''
    expect(auth).toContain('SOURCE / settings apiKeyHelper')
    expect(auth).toContain('SOURCE / settings env ANTHROPIC_API_KEY')
    expect(`${auth}\n${w.transcript.join('\n')}\n${await paneText($)}`).not.toContain(SECRET)
  })

  test('subscriptionOnly off: API sessions run, and are still reported as API', { options: { subscriptionOnly: false } }, async ($, on) => {
    const w = world(on, { env: { ANTHROPIC_API_KEY: SECRET }, credential: { handle: 'h', kind: 'api-key' } })
    await start($)
    expect(w.toasts).toEqual(['AUTH / API DETECTED · FABLE / BLOCKED'])
    expect((await prompt($, 'Add rate limiting')).drop).toBeUndefined()
    expect((await step($, OPUS)).result.answer).toBe('ok')
    // Fable is not part of that switch
    expect((await step($, 'fable', { index: 1 })).result.answer).toBe(BLOCK_LINE)
    expect(w.requests).toEqual([{ model: OPUS }])
  })

  test('an engine that reports no credential is unverified, and nothing is claimed', async ($, on) => {
    const w = world(on, { credential: null })
    await start($)
    expect(w.toasts).toEqual(['AUTH / UNVERIFIED · FABLE / BLOCKED'])
    expect((await command($, 'auth')).text).not.toContain('API BILLING / OFF')
    // unverified is not refused: only a detected API route is
    expect((await prompt($, 'Add rate limiting')).drop).toBeUndefined()
  })

  test('signing in again is read again', async ($, on) => {
    const w = world(on, { credential: { handle: 'h', kind: 'api-key' } })
    await start($)
    expect(w.toasts).toEqual(['AUTH / API DETECTED · FABLE / BLOCKED'])
    w.credential = { handle: 'h2', kind: 'bearer' }
    await slash($, 'login', '')
    expect(w.toasts[1]).toBe('AUTH / SUBSCRIPTION · API BILLING / OFF · FABLE / BLOCKED')
    expect((await prompt($, 'Add rate limiting')).drop).toBeUndefined()
  })
})

describe('subagent limits', () => {
  test('three run at once; the fourth is refused and nothing starts', async ($, on) => {
    const w = world(on)
    await start($)
    for (const type of ['cobalt-cockpit:worker', 'cobalt-cockpit:explorer', 'cobalt-cockpit:researcher']) expect((await spawn($, { subagentType: type })).agentId).toBeDefined()
    const fourth = await spawn($)
    expect(fourth.deny).toContain('SUBAGENT LIMIT / 3')
    expect(fourth.deny).toContain('nothing was started')
    expect(w.spawns).toHaveLength(3)
  })

  test('one finishing makes room for one more', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($)
    await spawn($)
    await spawn($)
    expect((await spawn($)).deny).toBeDefined()
    await finish($, 'spawned-2')
    expect((await spawn($)).agentId).toBe('spawned-4')
    expect((await spawn($)).deny).toContain('SUBAGENT LIMIT / 3')
    expect(w.spawns).toHaveLength(4)
  })

  test('five asked for in one message: exactly three start', async ($, on) => {
    const w = world(on)
    await start($)
    const answers = await Promise.all(Array.from({ length: 5 }, () => spawn($)))
    expect(answers.filter(one => one.agentId !== undefined)).toHaveLength(3)
    expect(answers.filter(one => one.deny !== undefined)).toHaveLength(2)
    expect(w.spawns).toHaveLength(3)
  })

  test('a failed subagent frees its place as a finished one does', async ($, on) => {
    world(on)
    await start($)
    await spawn($)
    await spawn($)
    await spawn($)
    await finish($, 'spawned-1', 'error')
    expect((await spawn($)).agentId).toBeDefined()
  })

  test('the limit is configurable, and a Fable spawn is refused whatever it is', { options: { maxSubagents: 1 } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect((await spawn($)).agentId).toBeDefined()
    expect((await spawn($)).deny).toContain('SUBAGENT LIMIT / 1')
    expect((await spawn($, { model: 'fable' })).deny).toContain(BLOCK_LINE)
    expect(w.spawns).toHaveLength(1)
  })

  test('orchestration off: no limit and no default model, and Fable is still blocked', { options: { orchestration: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    for (let n = 0; n < 5; n++) expect((await spawn($)).agentId).toBeDefined()
    expect(w.spawns[0]?.['model']).toBeUndefined()
    expect((await spawn($, { model: 'fable' })).deny).toContain(BLOCK_LINE)
    expect((await step($, 'fable')).result.answer).toBe(BLOCK_LINE)
    expect(w.spawns).toHaveLength(5)
  })
})

describe('orchestration telemetry', () => {
  test('with nothing delegated the HUD says nothing about subagents', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 2)
    const hud = await hudText($)
    for (const word of ['SUBAGENTS', 'WORKER', 'EXPLORER', 'RESEARCHER', 'REVIEWER', 'BACK TO MAIN', 'SONNET']) expect(hud, word).not.toContain(word)
    // the pane names main alone
    const pane = await paneText($)
    expect(pane).toContain('10 ORCHESTRATION')
    expect(pane).toMatch(/OPUS \/ MAIN/)
    expect(pane).not.toContain('SUBAGENTS')
    expect(pane).not.toContain('NWHO')
  })

  test('worker, explorer and researcher: role, model and activity from real events', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: FIVE })
    await progress($, { action: 'complete', milestone: 'm1' })
    await $.turn.start({ text: 'Add rate limiting', turnId: 't1' })
    await spawn($, { subagentType: 'cobalt-cockpit:worker', description: 'Implement the limiter' })
    await spawn($, { subagentType: 'cobalt-cockpit:explorer', description: 'Trace the bid path' })
    await spawn($, { subagentType: 'cobalt-cockpit:researcher', description: 'Read the limiter docs' })
    // each agent's own request and tool call are what its row is drawn from
    await step($, SONNET, { agentId: 'spawned-1', effort: 'medium' })
    await step($, SONNET, { agentId: 'spawned-2', effort: 'medium' })
    await step($, SONNET, { agentId: 'spawned-3', effort: 'medium' })
    await call($, 'Edit', { file_path: '/work/example/src/limiter.ts', old_string: 'a', new_string: 'b', agentId: 'spawned-1' })
    await call($, 'Read', { file_path: '/work/example/src/bids.ts', agentId: 'spawned-2' })
    await call($, 'WebFetch', { url: 'https://example.com/docs', prompt: 'limits', agentId: 'spawned-3' })
    await w.clock.advance(18_000)
    const hud = await hudText($)
    expect(hud).toMatch(/OPUS \/ MAIN · IMPLEMENT/)
    expect(hud).toContain('SONNET / SUBAGENTS 3/3')
    expect(hud).toMatch(/01 WORKER\s+SONNET · MEDIUM\s+EDIT\s+18s/)
    expect(hud).toMatch(/02 EXPLORER\s+SONNET · MEDIUM\s+READ\s+18s/)
    expect(hud).toMatch(/03 RESEARCHER\s+SONNET · MEDIUM\s+WEB\s+18s/)
    expect(hud).not.toContain('BACK TO MAIN')
    const pane = await paneText($)
    expect(pane).toMatch(/SONNET \/ SUBAGENTS\s+3\/3 running/)
    expect(pane).toMatch(/01 WORKER/)
    expect(pane).toMatch(/02 EXPLORER/)
    expect(pane).toMatch(/03 RESEARCHER/)
    // the three spawns are all that started, each on Sonnet
    expect(w.spawns.map(one => one['model'])).toEqual([SONNET, SONNET, SONNET])
  })

  test('when they return, the work is back with main', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: FIVE })
    await $.turn.start({ text: 'Add rate limiting', turnId: 't1' })
    await spawn($, { subagentType: 'cobalt-cockpit:worker' })
    await spawn($, { subagentType: 'cobalt-cockpit:researcher' })
    await w.clock.advance(4_000)
    await finish($, 'spawned-2')
    let hud = await hudText($)
    expect(hud).toContain('SONNET / SUBAGENTS 1/3')
    expect(hud).toMatch(/02 RESEARCHER\s+SONNET\s+Done\s+✓ 4s/)
    await finish($, 'spawned-1')
    hud = await hudText($)
    expect(hud).toContain('BACK TO MAIN')
    expect(hud).not.toContain('SUBAGENTS')
    // and the rows fold away, leaving no trace on the HUD
    await w.clock.advance(6_000)
    hud = await hudText($)
    expect(hud).not.toContain('BACK TO MAIN')
    expect(hud).not.toContain('WORKER')
  })

  test('a reviewer, once admitted, is drawn as one', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'Please review the limiter change')
    await $.turn.start({ text: 'review', turnId: 't1' })
    expect((await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })).agentId).toBe('spawned-1')
    expect((await call($, 'Bash', { command: 'git diff', agentId: 'spawned-1' }) as { deny?: string }).deny).toBeUndefined()
    expect(await hudText($)).toMatch(/01 REVIEWER\s+SONNET\s+(GIT|BASH)/)
  })

  test('another agent type is shown as an agent, on the model the engine resolved', async ($, on) => {
    world(on)
    await start($)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await spawn($, { subagentType: 'general-purpose', model: 'haiku' })
    const hud = await hudText($)
    expect(hud).toContain('HAIKU / SUBAGENTS 1/3')
    expect(hud).toMatch(/01 AGENT\s+HAIKU/)
  })

  test('a refused spawn draws no row', async ($, on) => {
    world(on)
    await start($)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await spawn($, { model: 'fable' })
    await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })
    const hud = await hudText($)
    expect(hud).not.toContain('SUBAGENTS')
    expect(hud).not.toContain('REVIEWER')
    expect(hud.toLowerCase()).not.toContain('fable')
  })

  test('the band stays inside its columns at every width with a full crew', async ($, on) => {
    world(on)
    await start($)
    await planAndComplete($, 2)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await spawn($, { subagentType: 'cobalt-cockpit:worker' })
    await spawn($, { subagentType: 'cobalt-cockpit:explorer' })
    await spawn($, { subagentType: 'cobalt-cockpit:researcher' })
    for (const columns of [20, 32, 48, 64, 80, 120, 200]) {
      const hud = await mountHud($, 'desktop', columns, true)
      expect((await rowsOf(hud)).length, String(columns)).toBeGreaterThan(0)
      await hud.unmount()
      const terminal = await mountHud($, 'terminal', columns, true)
      expect(await terminal.drawn()).toBeDefined()
      await terminal.unmount()
    }
  })

  test('the system prompt states the division of labour', async ($, on) => {
    world(on)
    await start($)
    const { sections } = await $.prompt.compose({ model: OPUS, promptModel: OPUS, surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const mine = sections.find(section => section.id === 'cobalt-cockpit:discipline')
    expect(mine?.text).toContain('Opus 5.5 commander, at the reasoning effort the user set')
    expect(mine?.text).toContain("The main loop's effort is the user's. Cockpit never sets or rewrites it")
    expect(mine?.text).toContain('cobalt-cockpit:worker')
    expect(mine?.text).toContain('At most 3 subagents run at once')
    expect(mine?.text).toContain('Haiku → Sonnet → Opus')
    expect(mine?.text).toContain('Fable is never used')
    // what was there before is all still there
    expect(mine?.text).toContain('Inspect before editing')
    expect(mine?.text).toContain('Never add AI attribution')
  })
})

describe('the reviewer is not invoked on every tool call', () => {
  test('a long run of ordinary calls starts no agent, sends no request and adds no note', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: FIVE })
    const answers: unknown[] = []
    for (let n = 0; n < 12; n++) {
      answers.push(await call($, 'Read', { file_path: `/work/example/src/file${n}.ts` }))
      answers.push(await call($, 'Edit', { file_path: `/work/example/src/file${n}.ts`, old_string: 'a', new_string: 'b' }))
      answers.push(await bash($, 'npm test'))
      answers.push(await call($, 'Grep', { pattern: 'limit', path: '.' }))
    }
    expect(w.ran).toHaveLength(48)
    // no second model, in any form
    expect(w.spawns).toEqual([])
    expect(w.requests).toEqual([])
    expect(w.outbound).toEqual([])
    // and nothing was said to the model beyond each tool's own result
    expect(answers.every(answer => (answer as { context?: unknown }).context === undefined)).toBe(true)
  })

  test('asked for with no ground, a reviewer is refused', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: [{ title: 'Inspect' }, { title: 'Implement' }, { title: 'Verify' }] })
    await bash($, 'npm test')
    const answer = await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })
    expect(answer.deny).toContain('REVIEWER / HELD')
    expect(w.spawns).toEqual([])
    // a worker is not held to the reviewer's grounds
    expect((await spawn($, { subagentType: 'cobalt-cockpit:worker' })).agentId).toBeDefined()
  })

  test('one failure is ordinary recovery: no note and no reviewer', async ($, on) => {
    const w = world(on, { failing: /npm test/ })
    await start($)
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: [{ title: 'Inspect' }, { title: 'Implement' }, { title: 'Verify' }] })
    const first = await bash($, 'npm test')
    expect((first as { context?: unknown }).context).toBeUndefined()
    expect((await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })).deny).toContain('REVIEWER / HELD')
    expect(w.spawns).toEqual([])
  })
})

describe('a repeated error', () => {
  const small = [{ title: 'Inspect' }, { title: 'Implement' }, { title: 'Verify' }]

  test('the second identical failure is said once, and permits one Sonnet reviewer', async ($, on) => {
    const w = world(on, { failing: /npm test/ })
    await start($)
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: small })
    await bash($, 'npm test')
    const second = (await bash($, 'npm test')) as { context?: readonly string[]; isError?: boolean }
    // the failure itself is returned as the engine answered it
    expect(second.isError).toBe(true)
    expect(second.context).toHaveLength(1)
    expect(second.context?.[0]).toContain('repeated 2 times (TEST)')
    expect(second.context?.[0]).toContain('Recover normally first')
    expect(second.context?.[0]).toContain('one cobalt-cockpit:reviewer subagent is permitted')
    // the plugin started nothing by itself: the model decides whether to use it
    expect(w.spawns).toEqual([])
    expect(w.requests).toEqual([])
    expect(w.outbound).toEqual([])
    // a third and fourth failure add no further note
    for (let n = 0; n < 2; n++) expect(((await bash($, 'npm test')) as { context?: unknown }).context).toBeUndefined()
    // one reviewer is admitted, on Sonnet
    const reviewer = await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })
    expect(reviewer).toMatchObject({ agentId: 'spawned-1', model: SONNET })
    expect(w.spawns[0]?.['model']).toBe(SONNET)
    // not a second beside it, and not another for the same failure after it
    expect((await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })).deny).toContain('already running')
    await finish($, 'spawned-1')
    expect((await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })).deny).toContain('REVIEWER / HELD')
    expect(w.spawns).toHaveLength(1)
  })

  test('the check passing ends it: the reviewer is no longer owed', async ($, on) => {
    const w = world(on, { failing: /npm test/ })
    await start($)
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: small })
    await bash($, 'npm test')
    await bash($, 'npm test')
    w.failing = null
    expect(((await bash($, 'npm test')) as { context?: unknown }).context).toBeUndefined()
    expect((await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })).deny).toContain('REVIEWER / HELD')
    // and a later failure starts counting from one again
    w.failing = /npm test/
    expect(((await bash($, 'npm test')) as { context?: unknown }).context).toBeUndefined()
    expect(((await bash($, 'npm test')) as { context?: readonly string[] }).context?.[0]).toContain('repeated 2 times')
  })

  test('two different failures are not a repeated error', async ($, on) => {
    const w = world(on, { failing: /npm test|tsc/ })
    await start($)
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: small })
    expect(((await bash($, 'npm test')) as { context?: unknown }).context).toBeUndefined()
    expect(((await bash($, 'tsc -p .')) as { context?: unknown }).context).toBeUndefined()
    expect(((await bash($, 'npm test')) as { context?: unknown }).context).toBeUndefined()
    expect((await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })).deny).toContain('REVIEWER / HELD')
    expect(w.spawns).toEqual([])
  })

  test('the same tool failing on a different file is a different failure', async ($, on) => {
    // the engine answers each Edit with an error, as it does when the text to replace is not found
    const w = world(on, { failingTools: ['Edit'] })
    await start($)
    await prompt($, 'Add rate limiting')
    const edit = (file: string) => call($, 'Edit', { file_path: `/work/example/src/${file}`, old_string: 'a', new_string: 'b' })
    expect(((await edit('one.ts')) as { context?: unknown }).context).toBeUndefined()
    expect(((await edit('two.ts')) as { context?: unknown }).context).toBeUndefined()
    // the same file again is the repeat
    expect(((await edit('two.ts')) as { context?: readonly string[] }).context?.[0]).toContain('repeated 2 times (Edit two.ts)')
    expect(w.spawns).toEqual([])
  })

  test('a subagent\'s failures are its own: they arm nothing for main', async ($, on) => {
    const w = world(on, { failing: /npm test/ })
    await start($)
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: small })
    for (let n = 0; n < 3; n++) expect(((await call($, 'Bash', { command: 'npm test', agentId: 'agent-7' })) as { context?: unknown }).context).toBeUndefined()
    expect((await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })).deny).toContain('REVIEWER / HELD')
    expect(w.spawns).toEqual([])
  })

  test('the local router\'s decision is passed on when a real receipt arrived since the failure began', { options: { ledgerPath: '/home/tester/.local/state/decision-router/ledger.jsonl' } }, async ($, on) => {
    const LEDGER = '/home/tester/.local/state/decision-router/ledger.jsonl'
    const decision = (ts: string) =>
      `${JSON.stringify({ ts, operation: 'ask', request_id: `d-${ts}`, caller: 'claude', provider: 'nobodywho', tier: 1, latency_ms: 31, choice: 'stop', abstain: false, question: 'never read' })}\n`
    const files: Record<string, string> = { [LEDGER]: '' }
    const w = world(on, { files, failing: /npm test/ })
    await start($)
    await w.clock.settle()
    await w.clock.settle()
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: small })
    await bash($, 'npm test')
    // the router, asked locally, answers STOP: a receipt written after the streak began
    files[LEDGER] = decision('2026-10-03T07:39:10.565+00:00')
    await w.clock.settle()
    await w.clock.advance(2_000)
    const second = (await bash($, 'npm test')) as { context?: readonly string[] }
    expect(second.context?.[0]).toContain('reads STOP')
    expect(second.context?.[0]).not.toContain('never read')
    expect(w.outbound).toEqual([])
  })

  test('with no receipt, nothing is said about the router', async ($, on) => {
    world(on, { failing: /npm test/ })
    await start($)
    await prompt($, 'Add rate limiting')
    await bash($, 'npm test')
    const second = (await bash($, 'npm test')) as { context?: readonly string[] }
    expect(second.context?.[0]).not.toContain('local router')
  })

  test('orchestration off: no note is added', { options: { orchestration: false } }, async ($, on) => {
    world(on, { failing: /npm test/ })
    await start($)
    await prompt($, 'Add rate limiting')
    for (let n = 0; n < 3; n++) expect(((await bash($, 'npm test')) as { context?: unknown }).context).toBeUndefined()
  })
})

describe('a substantial task and its final review', () => {
  test('one reviewer for the task, and no second', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Rework the bidding engine')
    await progress($, { action: 'plan', milestones: FIVE })
    expect((await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })).agentId).toBe('spawned-1')
    await finish($, 'spawned-1')
    expect((await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })).deny).toContain('REVIEWER / HELD')
    expect(w.spawns).toHaveLength(1)
  })
})

describe('final verification still gates 100%', () => {
  test('subagents reporting success leave the task unverified until the gates pass', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'Rework the bidding engine')
    await progress($, { action: 'plan', milestones: FIVE })
    await spawn($, { subagentType: 'cobalt-cockpit:worker' })
    await spawn($, { subagentType: 'cobalt-cockpit:reviewer' })
    // the worker's own checks, and both agents saying it is all done
    await call($, 'Bash', { command: 'npm test', agentId: 'spawned-1' })
    await call($, 'Bash', { command: 'tsc -p .', agentId: 'spawned-1' })
    await $.turn.complete({ agentId: 'spawned-1', turnId: 'w', reason: 'answer', answer: 'Implemented, all tests pass, verified. Task complete.', durationMs: 1, isAborted: false } as never)
    await $.turn.complete({ agentId: 'spawned-2', turnId: 'r', reason: 'answer', answer: 'LGTM. Verified. Ship it.', durationMs: 1, isAborted: false } as never)
    // a subagent cannot report a gate or complete a milestone
    const tried = await $.tool.call({ tool: TOOL, action: 'gate', gate: 'TEST', state: 'pass', evidence: 'subagent says so', agentId: 'spawned-1' } as never)
    expect(String((tried as { result?: unknown }).result)).toContain('belongs to the main conversation')
    // main completes every milestone but the gates are still open
    let status = ''
    for (let n = 1; n <= 5; n++) status = await progress($, { action: 'complete', milestone: `m${n}` })
    expect(status).not.toContain('100%')
    expect(status).toContain('HELD')
    const held = await progress($, { action: 'status' })
    expect(held).toContain('UNVERIFIED')
    // the worker's passing `npm test` and `tsc` settled nothing for the task
    expect(held).toContain('TEST unset')
    expect(held).toContain('TYPE unset')
    expect(await hudText($)).not.toContain('100%')
    // only main's own verification moves it
    await passAllGates($)
    const done = await progress($, { action: 'complete', milestone: 'm5' })
    expect(done).toContain('100%')
    expect(done).toContain('DONE')
  })

  test('a blocked Fable request changes no gate and no milestone', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 2)
    const before = await progress($, { action: 'status' })
    await step($, 'fable')
    await spawn($, { model: 'fable' })
    expect(await progress($, { action: 'status' })).toBe(before)
  })
})


test('independent mixed pools exceed the old three-agent ceiling and issue native requests', { options: { maxSubagents: 12, maxSonnet: 6, maxHaiku: 8 } }, async ($, on) => {
  const w = world(on); const held = hostState(on, {})
  await start($)
  const agents = await Promise.all(Array.from({ length: 8 }, (_, n) => spawn($, { model: n < 4 ? 'sonnet' : 'haiku', subagentType: n < 4 ? 'cobalt-cockpit:worker' : 'cobalt-cockpit:scout' })))
  expect(agents.every(a => a.agentId !== undefined)).toBe(true)
  expect(w.spawns).toHaveLength(8)
  for (let n = 0; n < agents.length; n++) await step($, OPUS, { agentId: agents[n]!.agentId, effort: 'high' })
  expect(w.requests.filter(r => r.model === SONNET)).toHaveLength(4)
  expect(w.requests.filter(r => r.model === 'claude-haiku-5-5')).toHaveLength(4)
  const ledger = held.get('run-ledger')?.value as import('../types').Ledger
  expect(ledger.swarm?.highWater).toBe(8)
  expect(ledger.swarm?.tasks.filter(t => t.state === 'running')).toHaveLength(8)
  expect(w.outbound).toEqual([])
})
