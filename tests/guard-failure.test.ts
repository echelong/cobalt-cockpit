// A guard that fails refuses the call it guards. The refusal is built by `failClosed` (hooks/guard-rules.ts) and is tested
// directly for each guard; the host fault a guard can meet and the engine's test kit can inject (a filesystem that cannot
// answer) is injected through the engine, in both configurations, and the protected call must not reach the host. The kit
// cannot make a pure rule or the clock throw, and tool input is plain data, so the other guards' wiring is held by
// scripts/audit-public.py. A call the guards pass still passes, a refusal never carries the command, and the
// operator's own switches still decide which guards run.

import { describe, expect, test } from 'claude-code/testing'

import { failClosed, guardFailure } from '../hooks/guard-rules'
import type { GuardName } from '../hooks/guard-rules'
import { bash, commandsRun, start, spawnWorld as world } from './world'

// built at run time from parts, as the other fixtures are, so no scanner-shaped value sits in the source
const SECRET = ['sk', 'test', 'SECRET', '0123456789'].join('-')
const NAMES: GuardName[] = ['attribution', 'instruction-file', 'destructive-command', 'tool']
const CONFIGS = [
  ['orchestration on', { orchestration: true }],
  ['observation only', { orchestration: false }],
] as const

const denial = (answer: unknown): string => String((answer as { deny?: string }).deny ?? '')
const edits = (w: ReturnType<typeof world>) => w.ran.filter(call => ['Edit', 'Write', 'NotebookEdit'].includes(String(call['tool'])))

describe('failClosed: a guard that throws refuses, whichever guard it is', () => {
  for (const name of NAMES) {
    test(`${name}: a throw, a rejection and a non-error value are each a refusal that repeats nothing`, async () => {
      for (const fail of [
        () => { throw new Error(`boom ${SECRET}`) },
        () => Promise.reject(new TypeError(`bad ${SECRET}`)),
        () => { throw `string ${SECRET}` },
        () => { throw undefined },
      ]) {
        const answer = await failClosed(name, 'Bash', async () => fail() as never)
        expect(answer).not.toBeNull()
        expect(answer!.deny).toContain(`the ${name} guard failed`)
        expect(answer!.deny).toContain('A failed check is not a pass')
        expect(answer!.deny).not.toContain(SECRET)
        expect(answer!.deny).not.toContain('boom')
      }
    })

    test(`${name}: a guard that completes is returned as it answered`, async () => {
      expect(await failClosed(name, 'Bash', async () => null)).toBeNull()
      expect(await failClosed(name, 'Bash', async () => ({ deny: 'its own refusal' }))).toEqual({ deny: 'its own refusal' })
    })
  }

  test('the refusal names the operator\'s control and cannot be made to carry a hostile tool or error name', () => {
    expect(guardFailure('destructive-command', 'Bash', new Error('x')).deny).toContain('"blastRadiusGuard"')
    expect(guardFailure('attribution', 'Edit', new Error('x')).deny).toContain('"attributionGuard"')
    const hostile = new Error('x')
    hostile.name = `rm -rf / ${SECRET}\n`
    const text = guardFailure('tool', `Bash ${SECRET}`, hostile).deny
    expect(text).not.toContain('\n')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('rm')
    expect(text).toContain('(Error)')
    expect(text).toContain('this tool call')
  })
})

for (const [label, options] of CONFIGS) {
  describe(`host faults inside the guards refuse the call (${label})`, () => {
    test('a filesystem that cannot say whether an instruction file exists is not an answer', { options }, async ($, on) => {
      const w = world(on, { answer: 'Create', failExists: true })
      await start($)
      const viaShell = await bash($, `echo ${SECRET} > CLAUDE.md`)
      expect(denial(viaShell)).toContain('the instruction-file guard failed')
      expect(denial(viaShell)).not.toContain(SECRET)
      const viaWrite = await $.tool.call({ tool: 'Write', file_path: '/work/example/AGENTS.md', content: 'hi' } as never)
      expect(denial(viaWrite)).toContain('the instruction-file guard failed')
      expect(commandsRun(w)).toEqual([])
      expect(edits(w)).toEqual([])
      expect(w.asked).toEqual([])
    })

    test('a Bash call without command text, and a MultiEdit without edits, are refused, not read as empty', { options }, async ($, on) => {
      const w = world(on)
      await start($)
      expect(denial(await $.tool.call({ tool: 'Bash' } as never))).toContain('no command text')
      expect(denial(await $.tool.call({ tool: 'Bash', command: ['git', 'push', '--force'] } as never))).toContain('no command text')
      expect(denial(await $.tool.call({ tool: 'MultiEdit', file_path: '/work/example/a.ts' } as never))).toContain('the attribution guard failed')
      expect(commandsRun(w)).toEqual([])
      expect(edits(w)).toEqual([])
    })

    test('MultiEdit is held to the attribution guard like Edit', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      const trailer = ['Co-authored-by: Claude', '<noreply@anthropic.com>'].join(' ')
      const refused = await $.tool.call({ tool: 'MultiEdit', file_path: '/work/example/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: trailer }] } as never)
      expect(denial(refused)).toContain('AI attribution')
      expect(edits(w)).toEqual([])
      // an edit's own file_path (empty, another file) does not change which file the guard judges
      for (const own of ['', '/work/example/other.ts']) {
        const sneaky = await $.tool.call({ tool: 'MultiEdit', file_path: '/work/example/a.ts', edits: [{ file_path: own, old_string: 'c', new_string: trailer }] } as never)
        expect([own, denial(sneaky).includes('AI attribution')]).toEqual([own, true])
      }
      expect(denial(await $.tool.call({ tool: 'MultiEdit', file_path: '/work/example/a.ts', edits: [null] } as never))).toContain('failed')
      expect(edits(w)).toEqual([])
      const fine = await $.tool.call({ tool: 'MultiEdit', file_path: '/work/example/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] } as never)
      expect(denial(fine)).toBe('')
    })

    test('a failed guard does not take the session down: other tools run, and the next call is checked afresh', { options }, async ($, on) => {
      const w = world(on, { answer: 'Create', failExists: true })
      await start($)
      expect(denial(await bash($, 'echo hi > CLAUDE.md'))).toContain('failed')
      expect(denial(await $.tool.call({ tool: 'Read', file_path: '/work/example/a.ts' } as never))).toBe('')
      expect(denial(await bash($, 'ls'))).toBe('')
      w.failExists = false
      expect(denial(await bash($, 'echo hi > CLAUDE.md'))).not.toContain('failed')
    })

    test('guards that complete keep passing what they pass and asking what they ask', { options }, async ($, on) => {
      const w = world(on, { answer: 'Proceed' })
      await start($)
      expect(denial(await bash($, 'npm test'))).toBe('')
      expect(denial(await bash($, 'git reset --hard'))).toBe('')
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/src/a.ts', old_string: 'a', new_string: 'b' } as never))).toBe('')
      expect(w.asked).toHaveLength(1)
      expect(commandsRun(w)).toEqual(['npm test', 'git reset --hard'])
    })
  })
}

describe('the operator\'s switches still decide which guards run', () => {
  test('blastRadiusGuard off: a destructive command is not asked about', { options: { blastRadiusGuard: false } }, async ($, on) => {
    const w = world(on, { answer: 'Cancel' })
    await start($)
    expect(denial(await bash($, 'git reset --hard'))).toBe('')
    expect(w.asked).toEqual([])
  })

  test('attributionGuard off: an unreadable filesystem does not stop a command or an edit', { options: { attributionGuard: false } }, async ($, on) => {
    const w = world(on, { failExists: true })
    await start($)
    expect(denial(await bash($, 'echo hi > CLAUDE.md'))).toBe('')
    expect(denial(await $.tool.call({ tool: 'Write', file_path: '/work/example/AGENTS.md', content: 'hi' } as never))).toBe('')
    expect(commandsRun(w)).toEqual(['echo hi > CLAUDE.md'])
  })
})
