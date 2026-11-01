// The post-hotfix closeout. (1) An instruction file is created only with the person's say-so, whichever tool creates it.
// (2) With subscriptionOnly on, only a confirmed subscription sign-in is let through: an unconfirmed one is refused on a
// prompt and on a model request, in both configurations, with a way to recover and no credential in the text.

import { describe, expect, test } from 'claude-code/testing'

import { isInsideFolder } from '../hooks/guard-rules'
import { instructionFilesWritten } from '../hooks/hygiene'
import { bash, commandsRun, prompt, start, spawnWorld as world } from './world'

type Engine = Parameters<typeof start>[0]

const CONFIGS = [
  ['orchestration on', { orchestration: true }],
  ['observation only', { orchestration: false }],
] as const

const denial = (answer: unknown): string => String((answer as { deny?: string }).deny ?? '')
const written = (w: ReturnType<typeof world>) => w.ran.filter(call => ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(String(call['tool'])))
const slash = ($: Engine, name: string) => $.command.run({ command: name, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
const step = async ($: Engine, model: string) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 3 } as never)
  let at = await stream.next()
  while (at.done !== true) at = await stream.next()

  return at.value as { answer?: string }
}

const CREATORS: [string, Record<string, unknown>][] = [
  ['Edit with an empty old_string', { tool: 'Edit', file_path: '/work/example/CLAUDE.md', old_string: '', new_string: 'hello' }],
  ['MultiEdit with an empty old_string', { tool: 'MultiEdit', file_path: '/work/example/AGENTS.md', edits: [{ old_string: '', new_string: 'hello' }] }],
  ['Write', { tool: 'Write', file_path: '/work/example/CLAUDE.md', content: 'hello' }],
  ['NotebookEdit', { tool: 'NotebookEdit', notebook_path: '/work/example/CLAUDE.md', new_source: 'hello' }],
  ['a lower-case name', { tool: 'Edit', file_path: '/work/example/claude.md', old_string: '', new_string: 'hello' }],
]

for (const [label, options] of CONFIGS) {
  describe(`instruction files are created only with the person's say-so (${label})`, () => {
    for (const [name, input] of CREATORS) {
      test(`${name}: Block refuses it and nothing is written`, { options }, async ($, on) => {
        const w = world(on, { answer: 'Block' })
        await start($)
        expect(denial(await $.tool.call(input as never))).toContain('only created when the user asks')
        expect(w.asked).toHaveLength(1)
        expect(written(w)).toEqual([])
      })

      test(`${name}: Create lets it through`, { options }, async ($, on) => {
        const w = world(on, { answer: 'Create' })
        await start($)
        expect(denial(await $.tool.call(input as never))).toBe('')
        expect(w.asked).toHaveLength(1)
        expect(written(w)).toHaveLength(1)
      })

      test(`${name}: a dismissed question, or nobody to ask, is a refusal`, { options }, async ($, on) => {
        const w = world(on, { answer: null })
        await start($)
        expect(denial(await $.tool.call(input as never))).toContain('only created when the user asks')
        expect(written(w)).toEqual([])
      })
    }

    test('an edit to an instruction file that exists is not asked about', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block', files: { '/work/example/CLAUDE.md': '# notes\n' } })
      await start($)
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/CLAUDE.md', old_string: '# notes', new_string: '# project notes' } as never))).toBe('')
      expect(denial(await $.tool.call({ tool: 'MultiEdit', file_path: '/work/example/CLAUDE.md', edits: [{ old_string: 'notes', new_string: 'rules' }] } as never))).toBe('')
      expect(w.asked).toEqual([])
      expect(written(w)).toHaveLength(2)
    })

    test('ordinary files are not asked about', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/src/a.ts', old_string: '', new_string: 'x' } as never))).toBe('')
      expect(denial(await $.tool.call({ tool: 'Edit', file_path: '/work/example/docs/CLAUDE.md.txt', old_string: '', new_string: 'x' } as never))).toBe('')
      expect(w.asked).toEqual([])
    })

    const CREATE = { tool: 'Edit', file_path: '/work/example/CLAUDE.md', old_string: '', new_string: 'hello' }
    const submit = ($: Engine, kind: string, text: string) => $.prompt.submit({ text, wait: false, origin: { kind } } as never)
    const init = ($: Engine, kind: string) => $.command.run({ command: 'init', args: '', origin: { kind }, presentation: { isFullscreen: true, columns: 120 } } as never)

    test('a prompt that mentions a file never grants it, from any origin, whatever it says', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      // a human prompt starts the task, so that a later origin has a task to mark
      await submit($, 'composer', 'Add rate limiting to the bids API')
      let asked = 0
      for (const text of ['Do NOT create CLAUDE.md', 'Explain what AGENTS.md does', 'Create CLAUDE.md', 'Please write a CLAUDE.md for this project', '/init', 'agents.md claude.md CLAUDE.MD']) {
        for (const kind of ['composer', 'bridge', 'sdk', 'plugin', 'peer', 'task-notification', 'scheduled-trigger', 'channel', 'future']) {
          await submit($, kind, text)
          const answer = denial(await $.tool.call(CREATE as never))
          asked += 1
          expect([text, kind, answer.includes('only created when the user asks'), w.asked.length]).toEqual([text, kind, true, asked])
        }
      }
      expect(written(w)).toEqual([])
    })

    test('after "Create CLAUDE.md" the operator is still asked, and Create is what lets it through', { options }, async ($, on) => {
      const w = world(on, { answer: 'Create' })
      await start($)
      await submit($, 'composer', 'Create CLAUDE.md')
      expect(denial(await $.tool.call(CREATE as never))).toBe('')
      expect(w.asked).toHaveLength(1)
      expect(written(w)).toHaveLength(1)
    })

    test('an unavailable confirmation after a prompt that names the file is a refusal', { options }, async ($, on) => {
      const w = world(on, { answer: null })
      await start($)
      await submit($, 'composer', 'Create CLAUDE.md')
      expect(denial(await $.tool.call(CREATE as never))).toContain('only created when the user asks')
      expect(written(w)).toEqual([])
    })

    for (const kind of ['composer', 'bridge']) {
      test(`a human /init (${kind}) stands in for the question, for every tool`, { options }, async ($, on) => {
        const w = world(on, { answer: 'Block' })
        await start($)
        await submit($, 'composer', 'Add rate limiting to the bids API')
        await init($, kind)
        for (const [name, input] of CREATORS) expect([name, denial(await $.tool.call(input as never))]).toEqual([name, ''])
        expect(denial(await bash($, 'echo x > AGENTS.md'))).toBe('')
        expect(w.asked).toEqual([])
      })
    }

    for (const kind of ['sdk', 'plugin', 'peer', 'task-notification', 'scheduled-trigger', 'channel', 'future']) {
      test(`/init from the ${kind} origin asks for nothing`, { options }, async ($, on) => {
        const w = world(on, { answer: 'Block' })
        await start($)
        await submit($, 'composer', 'Add rate limiting to the bids API')
        await init($, kind)
        expect([denial(await $.tool.call(CREATE as never)).includes('only created when the user asks'), w.asked.length]).toEqual([true, 1])
        expect(written(w)).toEqual([])
      })
    }

    test('with no task yet, /init marks nothing and the question is asked', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      await init($, 'composer')
      expect(denial(await $.tool.call(CREATE as never))).toContain('only created when the user asks')
      expect(w.asked).toHaveLength(1)
    })

    test('every spelling of the path is asked about, and files that are not instruction files are not', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      for (const path of ['CLAUDE.md', './CLAUDE.md', 'sub/../CLAUDE.md', '/work/example/Claude.MD', '/work/example/sub/agents.md', '../elsewhere/AGENTS.md']) {
        for (const input of [{ tool: 'Edit', file_path: path, old_string: '', new_string: 'x' }, { tool: 'Write', file_path: path, content: 'x' }, { tool: 'MultiEdit', file_path: path, edits: [{ old_string: '', new_string: 'x' }] }, { tool: 'NotebookEdit', notebook_path: path, new_source: 'x' }]) {
          expect([path, input.tool, denial(await $.tool.call(input as never)).includes('only created when the user asks')]).toEqual([path, input.tool, true])
        }
      }
      expect(written(w)).toEqual([])
      w.asked.length = 0
      for (const path of ['', 'README.md', '/work/example/CLAUDE.md.txt', '/work/example/MYCLAUDE.md', '/work/example/CLAUDE.mdx']) {
        expect([path, denial(await $.tool.call({ tool: 'Edit', file_path: path, old_string: '', new_string: 'x' } as never))]).toEqual([path, ''])
      }
      for (const path of [5, null, {}]) {
        expect(denial(await $.tool.call({ tool: 'Edit', file_path: path, old_string: '', new_string: 'x' } as never))).not.toContain('only created when the user asks')
      }
      expect(w.asked).toEqual([])
    })

    test('a MultiEdit is judged on the call\'s path, whatever path an edit names', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block', files: { '/work/example/CLAUDE.md': '# notes\n' } })
      await start($)
      // an edit that names another file does not turn the call\'s own, existing file into a new one, nor hide a new one
      expect(denial(await $.tool.call({ tool: 'MultiEdit', file_path: '/work/example/CLAUDE.md', edits: [{ file_path: '/work/example/AGENTS.md', old_string: 'notes', new_string: 'rules' }] } as never))).toBe('')
      expect(denial(await $.tool.call({ tool: 'MultiEdit', file_path: '/work/example/AGENTS.md', edits: [{ file_path: '/work/example/CLAUDE.md', old_string: '', new_string: 'x' }] } as never))).toContain('only created when the user asks')
      expect(denial(await $.tool.call({ tool: 'MultiEdit', file_path: '/work/example/AGENTS.md', edits: [{ file_path: '', old_string: '', new_string: 'x' }, null] } as never))).toContain('failed')
    })

    test('a filesystem that cannot answer refuses the edit', { options }, async ($, on) => {
      const w = world(on, { answer: 'Create', failExists: true })
      await start($)
      for (const [, input] of CREATORS) expect(denial(await $.tool.call(input as never))).toContain('the instruction-file guard failed')
      expect(written(w)).toEqual([])
    })

    test('a command that changes directory first is asked about even when the root file exists', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block', files: { '/work/example/CLAUDE.md': '# root\n' } })
      await start($)
      expect(denial(await bash($, 'echo x >> CLAUDE.md'))).toBe('')
      expect(denial(await bash($, 'cd sub && echo x > CLAUDE.md'))).toContain('only created when the user asks')
      for (const command of ['bash -c "cd sub && echo x > CLAUDE.md"', "echo 'cd sub; touch CLAUDE.md' | sh", 'cd; touch CLAUDE.md', 'env --chdir=sub tee CLAUDE.md']) {
        expect([command, denial(await bash($, command)).includes('only created when the user asks')]).toEqual([command, true])
      }
      expect(commandsRun(w)).toEqual(['echo x >> CLAUDE.md'])
    })

    test('Bash forms that create an instruction file are asked about', { options }, async ($, on) => {
      const w = world(on, { answer: 'Block' })
      await start($)
      for (const command of ['echo x > CLAUDE.md', 'install a.md CLAUDE.md', 'ln -s a.md AGENTS.md', 'dd if=a of=CLAUDE.md', 'truncate -s 0 CLAUDE.md', 'sh -c "echo x > CLAUDE.md"']) {
        expect([command, denial(await bash($, command)).includes('only created when the user asks')]).toEqual([command, true])
      }
      expect(commandsRun(w)).toEqual([])
    })
  })
}

describe('the shell forms that name an instruction file', () => {
  const CASES: [string, string[]][] = [
    ['echo x > CLAUDE.md', ['CLAUDE.md']],
    ['cat <<EOF > AGENTS.md\nhi\nEOF', ['AGENTS.md']],
    ['printf x | tee CLAUDE.md', ['CLAUDE.md']],
    ['cp a.md CLAUDE.md', ['CLAUDE.md']],
    ['install -m 644 a.md CLAUDE.md', ['CLAUDE.md']],
    ['ln -s a.md CLAUDE.md', ['CLAUDE.md']],
    ["echo 'echo x > CLAUDE.md' | sh", ['CLAUDE.md']],
    ['rsync -a src/ dst/ --exclude CLAUDE.md', []],
    ['dd if=a of=CLAUDE.md', ['CLAUDE.md']],
    ['truncate -s 0 CLAUDE.md', ['CLAUDE.md']],
    ['bash -c "echo x > CLAUDE.md"', ['CLAUDE.md']],
    ['sh -lc "touch AGENTS.md"', ['AGENTS.md']],
    ['bash -c "sh -c \\"echo x > CLAUDE.md\\""', ['CLAUDE.md']],
    ['eval "echo x > CLAUDE.md"', ['CLAUDE.md']],
    ["cat <<'EOF' | sh\necho x > CLAUDE.md\nEOF", ['CLAUDE.md']],
    ['cat build.sh | sh', []],
    ['cp ~/.claude/CLAUDE.md .', ['./CLAUDE.md']],
    ['cp /x/AGENTS.md sub/', ['sub/AGENTS.md']],
    ['cp /x/CLAUDE.md sub', []],
    ['mv x/AGENTS.md ./', ['./AGENTS.md']],
    ['install a/CLAUDE.md .', ['./CLAUDE.md']],
    ['cp -t . a/CLAUDE.md', ['./CLAUDE.md']],
    ['cp --target-directory=out a/CLAUDE.md', ['out/CLAUDE.md']],
    ['ln -s /x/CLAUDE.md', ['./CLAUDE.md']],
    ['ln -s /x/CLAUDE.md link.md', []],
    ['cp CLAUDE.md backup.md', []],
    ['cp CLAUDE.md notes', []],
    ['cp src/a.ts .', []],
    ['ls CLAUDE.md', []],
    ['cat CLAUDE.md', []],
    ['cp CLAUDE.md backup.md', []],
    ['ln -s CLAUDE.md link', []],
    ['dd if=CLAUDE.md of=copy', []],
    ['bash -c "cat CLAUDE.md"', []],
  ]
  for (const [command, expected] of CASES) test(JSON.stringify(command), () => expect(instructionFilesWritten(command)).toEqual(expected))
})

// built at run time from parts, as the other fixtures are, and shaped like no credential
const SECRET = ['tok', 'a1b2c3d4e5f60718'].join('')

for (const [label, options] of CONFIGS) {
  describe(`subscriptionOnly never reads an unknown sign-in as a subscription (${label})`, () => {
    const on_ = { ...options, subscriptionOnly: true }
    for (const [why, over] of [
      ['the engine reports no credential', { credential: null }],
      ['the engine does not answer', { failAuthorize: true }],
    ] as const) {
      test(`${why}: the prompt and the model request are refused, with a way to recover`, { options: on_ }, async ($, on) => {
        const w = world(on, over)
        await start($)
        const dropped = (await prompt($, 'Add rate limiting')).drop
        expect(dropped).toContain('AUTH / UNVERIFIED')
        expect(dropped).toContain('/login')
        expect(dropped).toContain('"subscriptionOnly"')
        expect(w.submitted).toEqual([])
        expect((await step($, 'claude-sonnet-5-5')).answer).toBe('AUTH / UNVERIFIED')
        expect(w.requests).toEqual([])
      })
    }

    test('a refusal carries no credential, even when one is configured', { options: on_ }, async ($, on) => {
      const w = world(on, { credential: null, env: { ANTHROPIC_API_KEY: SECRET } })
      await start($)
      const dropped = (await prompt($, 'Add rate limiting')).drop
      expect(dropped).toContain('AUTH / API DETECTED')
      expect(String(dropped)).not.toContain(SECRET)
      expect(w.requests).toEqual([])
    })

    test('signing in is the recovery: the next prompt and request go through', { options: on_ }, async ($, on) => {
      const w = world(on, { credential: null })
      await start($)
      expect((await prompt($, 'Add rate limiting')).drop).toContain('AUTH / UNVERIFIED')
      w.credential = { handle: 'h', kind: 'bearer' }
      await slash($, 'login')
      expect((await prompt($, 'Add rate limiting')).drop).toBeUndefined()
      expect((await step($, 'claude-sonnet-5-5')).answer).not.toBe('AUTH / UNVERIFIED')
    })

    test('a sign-in made outside the plugin\'s commands is seen before anything is refused', { options: on_ }, async ($, on) => {
      const w = world(on, { credential: null })
      await start($)
      w.credential = { handle: 'h', kind: 'bearer' }
      expect((await prompt($, 'Add rate limiting')).drop).toBeUndefined()
    })

    test('subscriptionOnly off: an unconfirmed sign-in is not refused', { options }, async ($, on) => {
      world(on, { credential: null })
      await start($)
      expect((await prompt($, 'Add rate limiting')).drop).toBeUndefined()
    })
  })
}

describe('a path is inside the plugin folder only when it says so plainly', () => {
  test('climbing out with .. or wandering with . is not inside', () => {
    expect(isInsideFolder('/p/root', '/p/root/hooks/a.ts')).toBe(true)
    expect(isInsideFolder('/p/root', '/p/root/../elsewhere/CLAUDE.md')).toBe(false)
    expect(isInsideFolder('/p/root', '/p/root/a/../../x/CLAUDE.md')).toBe(false)
    expect(isInsideFolder('/p/root', '/p/root/./CLAUDE.md')).toBe(false)
    expect(isInsideFolder('/p/root', '/p/rootsibling/CLAUDE.md')).toBe(false)
    expect(isInsideFolder('/p/root', 'CLAUDE.md')).toBe(false)
  })
})
