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
type Catcher = (($: never, e: never, next: never) => unknown) | null
type Registered = { pattern: string; matcher: string; hook: Hook; catcher: Catcher }

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
    const entry: Registered = { pattern, matcher: matcher === undefined ? '' : JSON.stringify(matcher), hook, catcher: null }
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
    ['tool.check'],
    ['agent.offer'],
    ['agent.spawn'],
    ['config.set'],
    ['command.run', 'cockpit'],
    ['classic.PostToolUse'],
  ]

  test('every hook that can answer or refuse has one', () => {
    const { of } = capture()
    for (const [pattern, command] of GATING) expect(of(pattern, command)?.catcher).toBeDefined()
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

    expect(await of('agent.offer')!.catcher!($ as never, { agent: 'cobalt-cockpit:worker' } as never, caught(false).next as never)).toMatchObject({ isOffered: false })
  })

  test('the Fable offer guard lets a type through while Fable is allowed', async ($) => {
    const { of } = capture()
    const forwarded = caught(false, { isOffered: true })

    expect(await of('agent.offer')!.catcher!($ as never, { agent: 'cobalt-cockpit:worker' } as never, forwarded.next as never)).toBe(forwarded.value)
  })

  test('the configuration guard refuses a Fable model row', async ($) => {
    const { of } = capture({ blockFable: true })

    expect(denyOf(await of('config.set')!.catcher!($ as never, { key: 'model', value: 'fable' } as never, caught(false).next as never))).toContain('COBALT')
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

  test('the model-command guard leaves the command to the engine while Fable is allowed', async ($) => {
    const { of } = capture()
    const forwarded = caught(false, { text: 'the engine ran /model' })

    expect(await of('command.run', 'model')!.catcher!($ as never, { command: 'model', args: 'fable' } as never, forwarded.next as never)).toBe(forwarded.value)
  })

  test('the advisor guard refuses under the strict preset', async ($) => {
    const { of } = capture({ cobaltStrict: true })

    expect(textOf(await of('command.run', 'advisor')!.catcher!($ as never, { command: 'advisor', args: 'opus' } as never, caught(false).next as never))).toContain('STRICT')
  })

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
      ['tool.check', undefined, { tool: 'Bash', command: 'ls', tool_use_id: 'tu-3' }],
    ]
    for (const [pattern, command, event] of events) {
      const { next, value } = caught(false, { text: 'the engine answered' })
      expect(await of(pattern, command)!.catcher!($ as never, event as never, next as never)).toBe(value)
    }
  })
})



describe('a pass-through hands the engine its own event unless it changed it', () => {
  test('an untouched call reaches the engine as the engine raised it', async ($, on) => {
    const w = world(on); hostState(on, {}); await start($)
    await bash($, 'ls -la')

    expect(w.ran.length).toBe(1)
    expect(w.ran[0]!['command']).toBe('ls -la')
    expect(Object.isFrozen(w.ran[0])).toBe(true)
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
