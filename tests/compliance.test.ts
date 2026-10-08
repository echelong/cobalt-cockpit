// The hooks module as a directory scanner reads it, and the promises it makes
// to a person who installs it.
//
// Two things are held here. First, every hook that can refuse an action carries
// a `.catch` error handler that refuses in its place: the engine skips a hook
// that fails, and a skipped guard lets the action run. Second, a pass-through
// hands the engine its own event unless the hook really changed it. Neither is
// about the drawing: they are the difference between a guard and a decoration.

import { describe, expect, test } from 'claude-code/testing'

import { register } from '../hooks/register'
import { hostState, start, world } from './world'
import { bash, prompt } from './world'

type Hook = (...args: never[]) => unknown
type Catcher = ($: never, e: never, next: never) => unknown
type Registered = { pattern: string; matcher: string; hook: Hook; catcher?: Catcher }

/**
 * Registers the module against a stub `on` and keeps every hook with the error
 * handler attached to it, so a test can call one directly. Nothing here reaches
 * the engine's own chain: `$` is the test's, and `next` is the test's stub.
 */
const capture = (options: Record<string, unknown> = {}) => {
  const seen = new Map<string, Registered>()
  const on = ((pattern: string, arg2?: unknown, arg3?: unknown) => {
    const matcher = typeof arg2 === 'function' ? undefined : arg2
    const hook = (typeof arg2 === 'function' ? arg2 : arg3) as Hook
    const entry: Registered = { pattern, matcher: matcher === undefined ? '' : JSON.stringify(matcher), hook }
    seen.set(`${pattern} ${entry.matcher}`, entry)

    return { catch: (catcher: Catcher) => { entry.catcher = catcher } }
  }) as never
  register(on, options as never)

  return {
    seen,
    /** The registration for an event, and its matcher's `command` when given. */
    of: (pattern: string, command?: string): Registered | undefined =>
      [...seen.values()].find(one => one.pattern === pattern && (command === undefined || one.matcher.includes(`"${command}"`))),
  }
}

/**
 * The `next` a `.catch` handler is given: what it was told about the hook that
 * failed, and a record of what the handler did with it. `value` is what the
 * chain beneath settles to, so a handler that forwards is told apart from one
 * that answers in its place.
 */
const caught = (called: boolean, value: unknown = { text: 'the engine answered' }) => {
  const calls: unknown[] = []
  const next = ((received: unknown) => {
    calls.push(received)

    return Promise.resolve(value)
  }) as unknown as Hook & { called: boolean; error: unknown }
  next.called = called
  next.error = { kind: 'throw', message: 'synthetic failure' }

  return { next, calls, value }
}

const denyOf = (verdict: unknown): string => String((verdict as { deny?: unknown }).deny ?? '')
const textOf = (verdict: unknown): string => String((verdict as { text?: unknown }).text ?? '')


describe('every hook that can refuse carries a handler that refuses for it', () => {
  const GATING: readonly (readonly [string, string?])[] = [
    ['classic.SessionStart'],
    ['command.run', 'park'],
    ['command.run', 'ledger'],
    ['command.run', 'replay'],
    ['command.run', 'init'],
    ['command.run', 'model'],
    ['command.run', 'effort'],
    ['command.run', 'advisor'],
    ['command.run', 'login'],
    ['command.run', 'logout'],
    ['prompt.submit'],
    ['tool.call'],
    ['agent.offer'],
    ['agent.spawn'],
    ['config.set'],
    ['command.run', 'cockpit'],
    ['classic.PostToolUse'],
  ]

  test('every hook that can answer or refuse has one', () => {
    const { of } = capture()
    // `typeof ... === 'function'`: an absent handler is `undefined` and cannot
    // pass this the way a null or a missing registration could.
    for (const [pattern, command] of GATING) expect(typeof of(pattern, command)?.catcher).toBe('function')
  })

  test('the tool guard refuses the call when it fails before deciding', async ($, on) => {
    const { of } = capture(); hostState(on, {}); world(on)
    const { next } = caught(false)
    const verdict = await of('tool.call')!.catcher!($ as never, { tool: 'Bash', command: 'git reset --hard', tool_use_id: 'tu-1' } as never, next as never)

    expect(denyOf(verdict)).toContain('COCKPIT')
    expect(denyOf(verdict)).toContain('throw')
  })

  test('a guard that had already passed the call on leaves that result alone', async ($, on) => {
    const { of } = capture(); hostState(on, {}); world(on)
    const { next, value } = caught(true)
    const verdict = await of('tool.call')!.catcher!($ as never, { tool: 'Bash', command: 'ls', tool_use_id: 'tu-2' } as never, next as never)

    expect(verdict).toBe(value)
  })

  test('the agent-admission guard refuses the spawn when it fails', async ($, on) => {
    const { of } = capture(); hostState(on, {}); world(on)
    const { next } = caught(false)
    const verdict = await of('agent.spawn')!.catcher!($ as never, { subagentType: 'cobalt-cockpit:worker', description: '[task:t1] Synthetic' } as never, next as never)

    expect(denyOf(verdict)).toContain('COCKPIT')
  })
})

describe('a guard that only sometimes guards refuses only then', () => {
  test('the Fable offer guard withholds a type while Fable is blocked', async ($) => {
    const { of } = capture({ blockFable: true })

    expect(await of('agent.offer')!.catcher!($ as never, { agent: 'advisor-fable' } as never, caught(false).next as never)).toMatchObject({ isOffered: false })
  })

  test('the Fable offer guard lets an ordinary type through while Fable is blocked', async ($) => {
    const { of } = capture({ blockFable: true })
    const forwarded = caught(false, { isOffered: true })

    expect(await of('agent.offer')!.catcher!($ as never, { agent: 'cobalt-cockpit:worker' } as never, forwarded.next as never)).toBe(forwarded.value)
  })

  test('the Fable offer guard lets a type through while Fable is allowed', async ($) => {
    const { of } = capture()
    const forwarded = caught(false, { isOffered: true })

    expect(await of('agent.offer')!.catcher!($ as never, { agent: 'advisor-fable' } as never, forwarded.next as never)).toBe(forwarded.value)
  })

  test('the configuration guard refuses a Fable model row', async ($) => {
    const { of } = capture({ blockFable: true })

    expect(denyOf(await of('config.set')!.catcher!($ as never, { key: 'model', value: 'fable' } as never, caught(false).next as never))).toContain('COBALT')
  })

  test('the configuration guard leaves a row that names no model to the engine', async ($) => {
    const { of } = capture({ blockFable: true })
    const forwarded = caught(false, { value: 'dark' })

    expect(await of('config.set')!.catcher!($ as never, { key: 'theme', value: 'dark' } as never, forwarded.next as never)).toBe(forwarded.value)
  })

  test('the configuration guard leaves an ordinary row to the engine', async ($) => {
    const { of } = capture()
    const forwarded = caught(false, { value: 'opus' })

    expect(await of('config.set')!.catcher!($ as never, { key: 'model', value: 'opus' } as never, forwarded.next as never)).toBe(forwarded.value)
  })

  test('the model-command guard refuses a Fable model while Fable is blocked', async ($) => {
    const { of } = capture({ blockFable: true })

    expect(textOf(await of('command.run', 'model')!.catcher!($ as never, { command: 'model', args: 'fable' } as never, caught(false).next as never))).toContain('MODEL BLOCK')
  })

  test('the model-command guard leaves a command that names no Fable to the engine', async ($) => {
    const { of } = capture({ blockFable: true })
    const forwarded = caught(false, { text: 'the engine ran /model' })

    expect(await of('command.run', 'model')!.catcher!($ as never, { command: 'model', args: 'opus' } as never, forwarded.next as never)).toBe(forwarded.value)
  })

  test('the model-command guard leaves the command to the engine while Fable is allowed', async ($) => {
    const { of } = capture()
    const forwarded = caught(false, { text: 'the engine ran /model' })

    expect(await of('command.run', 'model')!.catcher!($ as never, { command: 'model', args: 'fable' } as never, forwarded.next as never)).toBe(forwarded.value)
  })

  test('the advisor guard refuses under the strict preset', async ($) => {
    const { of } = capture({ cobaltStrict: true })

    expect(textOf(await of('command.run', 'advisor')!.catcher!($ as never, { command: 'advisor', args: 'opus' } as never, caught(false).next as never))).toContain('STRICT')
  })

  test('the advisor guard leaves a command that turns the advisor off to the engine', async ($) => {
    const { of } = capture({ cobaltStrict: true })
    const forwarded = caught(false, { text: 'the engine ran /advisor off' })

    expect(await of('command.run', 'advisor')!.catcher!($ as never, { command: 'advisor', args: 'off' } as never, forwarded.next as never)).toBe(forwarded.value)
  })

  // The prompt guard handler reproduces this hook’s one refusal — the
  // subscription policy’s `drop`. It is verified by inspection rather than
  // here: a `.catch` handler is only reached inside a dispatch, where the
  // engine owns `$`, so the harness cannot call this one directly the way it
  // calls the others. The refusal itself is held end to end by the
  // public-release tests ("strict preset refuses API authentication").

  test('the advisor guard leaves the command to the engine outside the preset', async ($) => {
    const { of } = capture()
    const forwarded = caught(false, { text: 'the engine ran /advisor' })

    expect(await of('command.run', 'advisor')!.catcher!($ as never, { command: 'advisor', args: 'opus' } as never, forwarded.next as never)).toBe(forwarded.value)
  })
})

describe('a watcher never refuses the action it watched', () => {
  test('the reading hooks forward, told or not', async ($, on) => {
    const { of } = capture(); hostState(on, {}); world(on)
    const events: readonly (readonly [string, string | undefined, unknown])[] = [
      ['classic.SessionStart', undefined, { source: 'startup' }],
      ['prompt.submit', undefined, { text: 'Synthetic prompt', origin: { kind: 'composer' } }],
      ['command.run', 'init', { command: 'init', args: '' }],
      ['command.run', 'effort', { command: 'effort', args: 'high' }],
      ['command.run', 'login', { command: 'login', args: '' }],
      ['command.run', 'logout', { command: 'logout', args: '' }],
      ['classic.PostToolUse', undefined, { tool_name: 'Bash', tool_input: { command: 'ls' } }],
    ]
    for (const [pattern, command, event] of events) {
      const { next, value } = caught(false, { text: 'the engine answered' })
      expect(await of(pattern, command)!.catcher!($ as never, event as never, next as never)).toBe(value)
    }
  })
})



describe('a pass-through hands the engine its own event unless it changed it', () => {
  test('an untouched call reaches the engine with its fields intact', async ($, on) => {
    const w = world(on); hostState(on, {}); await start($)
    await bash($, 'ls -la')

    expect(w.ran.length).toBe(1)
    expect(w.ran[0]!['command']).toBe('ls -la')
    expect(w.ran[0]!['tool']).toBe('Bash')
  })

  test('a call the effort policy changed reaches the engine as the copy that carries it', { options: { orchestration: true } }, async ($, on) => {
    const w = world(on, { version: '2.1.294' }); hostState(on, {}); await start($)
    const useId = 'agent-use-1'
    await $.tool.call({ tool: 'Agent', tool_use_id: useId, description: 'unassigned bounded work', prompt: 'Synthetic work', subagent_type: 'cobalt-cockpit:worker' } as never)
    const sent = w.ran.find(call => call['tool_use_id'] === useId)!

    // The level the policy resolved rides on the copy this hook owns; the run
    // above is the other half, where nothing changed and the original went on.
    expect(sent['effort']).toBeDefined()
  })

  test('a prompt with no task in progress carries no Cockpit context', async ($, on) => {
    const w = world(on); hostState(on, {}); await start($)
    await prompt($, 'Synthetic prompt')

    expect(w.submitted[0]?.context).toEqual([])
  })
})

// The directory blocks a mod it cannot confirm leaves a permission decision with
// the person, and the only return it reads in a hook on `tool.check` is the
// pass-through itself. Cockpit's hook there was a watcher that read the verdict
// to light a HUD state, which is not a reason to stand in the permission check.
// So it stands nowhere in it: no hook on the check, and no query of its own.
describe('the permission check belongs to the engine and the person', () => {
  /** Answers every permission check that reaches the engine, and keeps each one. */
  const checking = (on: Parameters<typeof world>[0], decide: () => string = () => 'allow') => {
    const checks: Record<string, unknown>[] = []
    on('tool.check', ($, e) => {
      checks.push(e as unknown as Record<string, unknown>)

      return { decision: decide(), reason: 'the engine decided' } as never
    })

    return checks
  }

  test('no hook is registered on the permission check, under any policy', () => {
    for (const options of [{}, { orchestration: true }, { cobaltStrict: true }, { blockFable: true, subscriptionOnly: true }]) {
      const { seen } = capture(options)

      expect([...seen.values()].some(one => one.pattern === 'tool.check')).toBe(false)
      // The guards are where they were.
      for (const pattern of ['tool.call', 'agent.spawn', 'agent.offer', 'config.set', 'prompt.submit', 'turn.step']) {
        expect([...seen.values()].some(one => one.pattern === pattern)).toBe(true)
      }
    }
  })

  test('ordinary allowed tool calls ask no permission query', async ($, on) => {
    const checks = checking(on); const w = world(on); hostState(on, {}); await start($)
    await bash($, 'ls -la')
    await $.tool.call({ tool: 'Read', file_path: '/work/example/a.ts', tool_use_id: 'tu-read' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/work/example/b.ts', content: 'synthetic', tool_use_id: 'tu-write' } as never)
    await w.clock.advance(2_000)

    expect(w.ran.map(call => call['tool'])).toEqual(['Bash', 'Read', 'Write'])
    expect(checks).toEqual([])
  })

  test('with orchestration on, a subagent\'s and the commander\'s calls ask none either', { options: { orchestration: true } }, async ($, on) => {
    const checks = checking(on); const w = world(on, { version: '2.1.294' }); hostState(on, {}); await start($)
    await bash($, 'git status')
    await $.tool.call({ tool: 'Read', file_path: '/work/example/a.ts', tool_use_id: 'tu-main-read' } as never)
    await w.clock.advance(2_000)

    expect(w.ran.some(call => call['tool'] === 'Read')).toBe(true)
    expect(checks).toEqual([])
  })

  test('the engine\'s own check reaches it once and comes back as it decided', async ($, on) => {
    let decision = 'allow'
    const checks = checking(on, () => decision); world(on); hostState(on, {}); await start($)
    for (const each of ['allow', 'ask', 'deny']) {
      decision = each
      const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: `tu-${each}` } as never)

      expect(verdict.decision).toBe(each as never)
      expect(verdict.reason).toBe('the engine decided')
    }

    expect(checks.map(one => one['tool_use_id'])).toEqual(['tu-allow', 'tu-ask', 'tu-deny'])
  })

  test('a destructive command the person cancels stays refused, and asks no permission query', async ($, on) => {
    const checks = checking(on); const w = world(on, { answer: 'Cancel' }); hostState(on, {}); await start($)
    const answer = await bash($, 'git reset --hard origin/main')

    expect(w.asked.length).toBe(1)
    expect(denyOf(answer)).toContain('did not approve')
    expect(w.ran.some(call => call['command'] === 'git reset --hard origin/main')).toBe(false)
    expect(checks).toEqual([])
  })

  test('a Fable route stays refused, and asks no permission query', { options: { blockFable: true } }, async ($, on) => {
    const checks = checking(on); const w = world(on); hostState(on, {}); await start($)
    const answer = await $.tool.call({ tool: 'Agent', tool_use_id: 'tu-fable', description: 'synthetic', prompt: 'Synthetic work', model: 'fable' } as never)

    expect(denyOf(answer)).not.toBe('')
    expect(w.ran.some(call => call['tool'] === 'Agent')).toBe(false)
    expect(checks).toEqual([])
  })

  test('an unowned write under orchestration stays refused, and asks no permission query', { options: { orchestration: true } }, async ($, on) => {
    const checks = checking(on); const w = world(on, { version: '2.1.294' }); hostState(on, {}); await start($)
    const answer = await $.tool.call({ tool: 'Write', file_path: '/work/example/owned.ts', content: 'synthetic', tool_use_id: 'tu-unowned', agentId: 'unassigned-agent' } as never)

    expect(denyOf(answer)).not.toBe('')
    expect(w.ran.some(call => call['tool'] === 'Write')).toBe(false)
    expect(checks).toEqual([])
  })
})
