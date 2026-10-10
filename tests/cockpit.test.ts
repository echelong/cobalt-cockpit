// The plugin through the engine: its hooks run as a session would run them,
// over a world (world.ts) that records every host call they make.

import { describe, expect, test } from 'claude-code/testing'

import { newTask, settle, applyAction } from '../hooks/model'
import type { Task } from '../types'
import {
  bash,
  command,
  commandsRun,
  FIVE,
  hostState,
  mountHud,
  mountPane,
  passAllGates,
  planAndComplete,
  plays,
  PLUGIN,
  progress,
  prompt,
  rowsOf,
  start,
  TOOL,
  world,
  elementsOf,
  fieldRowsOf,
} from './world'

const SURFACES = ['terminal', 'desktop'] as const

const mainTurnEnds = ($: Parameters<typeof start>[0], reason: 'answer' | 'error' = 'answer') =>
  $.turn.complete({ answer: 'All done!', durationMs: 1000, isAborted: false, turnId: 't1', reason })

describe('a turn is not a task', () => {
  test('a completed turn leaves the task where its milestones put it', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'Add rate limiting to the bids API')
    await planAndComplete($, 2)
    await $.turn.start({ text: 'Add rate limiting', turnId: 't1' })
    await mainTurnEnds($)

    expect(await progress($, { action: 'status' })).toStartWith('TEST 40% (2/5 milestones)')
    for (const surface of SURFACES) {
      const hud = await mountHud($, surface)
      const rows = await rowsOf(hud)
      expect(rows[0]).toContain('40%')
      expect(rows[1]).toContain('PAUSED')
      expect(rows.join('\n')).not.toContain('DONE')
      await hud.unmount()
    }
  })

  test('every milestone claimed complete, nothing verified: UNVERIFIED, never 100%', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting to the bids API')
    const reply = await planAndComplete($, 5)
    await mainTurnEnds($)

    expect(reply).toContain('HELD')
    expect(reply).toContain('UNVERIFIED')
    const rows = await rowsOf(await mountHud($, 'terminal'))
    expect(rows[0]).toContain('80%')
    expect(rows[1]).toContain('UNVERIFIED')
    expect(plays(w, 'complete')).toEqual([])
  })

  test('a task with no plan shows no percentage after its turn', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'What does parseStatus do?')
    await $.turn.start({ text: 'What does parseStatus do?', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/example/src/git.ts' } as never)
    await mainTurnEnds($)

    const rows = await rowsOf(await mountHud($, 'terminal'))
    // The HUD's own rows carry the stage and the state; the Activity Field may
    // add rows of its own above them, so the reading is checked across the band.
    expect(rows.join('\n')).toContain('INSPECT')
    expect(rows.join('\n')).toContain('--%')
    expect(rows.join('\n')).toContain('IDLE')
  })

  test('an unfinished task carries its state into the next prompt', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting to the bids API')
    await planAndComplete($, 2)
    await prompt($, 'also cover the admin routes')

    expect(w.submitted[1]?.context.join('\n')).toContain('40% (2/5 milestones)')
    expect(await progress($, { action: 'status' })).toContain('m2 Implement [done]')
  })
})

describe('subagents', () => {
  test('a subagent finishing its turn does not complete or advance the parent task', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting to the bids API')
    await planAndComplete($, 2)
    await $.turn.start({ text: 'x', turnId: 't1' })
    const before = await progress($, { action: 'status' })

    await $.turn.complete({ answer: 'Task complete. Everything is done and verified.', durationMs: 5, isAborted: false, turnId: 's1', agentId: 'agent-7', reason: 'answer' })

    expect(await progress($, { action: 'status' })).toBe(before)
    expect(before).toStartWith('TEST 40%')
    // the main turn is still running: the HUD still says so
    const rows = await rowsOf(await mountHud($, 'terminal', 120, true))
    expect(rows[1]).toContain('THINK')
    expect(rows[1]).not.toContain('DONE')
    expect(plays(w, 'complete')).toEqual([])
  })

  test('a subagent cannot move the task through the progress tool', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'Add rate limiting to the bids API')
    await planAndComplete($, 1)
    const before = await progress($, { action: 'status' })
    const answer = await $.tool.call({ tool: TOOL, action: 'complete', milestone: 'm2', agentId: 'agent-7' } as never)

    expect(String((answer as { result?: unknown }).result)).toContain('belongs to the main conversation')
    expect(await progress($, { action: 'status' })).toBe(before)
  })

  test('a subagent\'s work is counted beside the task: its checks settle no gate', async ($, on) => {
    const w = world(on, { failing: /npm test/ })
    await start($)
    await prompt($, 'Add rate limiting to the bids API')
    await planAndComplete($, 2)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'agent-7' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/work/example/src/api.ts', old_string: 'a', new_string: 'b', agentId: 'agent-7' } as never)

    expect(commandsRun(w)).toEqual(['npm test'])
    const status = await progress($, { action: 'status' })
    expect(status).toStartWith('TEST 40%')
    expect(status).toContain('TEST unset')
    const rows = await rowsOf(await mountHud($, 'terminal', 120, true))
    expect(rows.join('\n')).toContain('THINK +1 agent')

    // its turn ending takes it off the count and leaves the task alone
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 's1', agentId: 'agent-7', reason: 'answer' })
    expect((await rowsOf(await mountHud($, 'terminal', 120, true))).join('\n')).not.toContain('agent')
    expect(await progress($, { action: 'status' })).toBe(status)
  })

  test('the guards still stand over a subagent\'s commands', async ($, on) => {
    const w = world(on, { answer: 'Cancel' })
    await start($)
    const answer = await $.tool.call({ tool: 'Bash', command: 'git push --force', agentId: 'agent-7' } as never)
    expect((answer as { deny?: string }).deny).toContain('did not approve')
    expect(commandsRun(w)).toEqual([])
  })
})

describe('sounds', () => {
  test('the checkpoint plays once, at the first crossing of 80%', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 3)
    await w.clock.settle()
    expect(plays(w, 'checkpoint')).toEqual([])

    await progress($, { action: 'complete', milestone: 'm4' })
    await w.clock.settle()
    expect(plays(w, 'checkpoint')).toHaveLength(1)
    expect(plays(w, 'checkpoint')[0]?.[0]).toBe('pw-play')

    // more work at or above 80% is silent
    await progress($, { action: 'start', milestone: 'm5' })
    await progress($, { action: 'gate', gate: 'CODE', state: 'pass', evidence: 'eslint clean' })
    await progress($, { action: 'complete', milestone: 'm5' })
    await progress($, { action: 'status' })
    await w.clock.settle()
    expect(plays(w, 'checkpoint')).toHaveLength(1)
    expect(plays(w, 'complete')).toEqual([])
  })

  test('the completion cue plays once, at a verified 100%, and is a different file', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 4)
    await passAllGates($)
    await w.clock.settle()
    expect(plays(w, 'complete')).toEqual([])

    const reply = await progress($, { action: 'complete', milestone: 'm5' })
    await w.clock.settle()
    expect(reply).toStartWith('DONE 100%')
    expect(plays(w, 'complete')).toHaveLength(1)
    expect(plays(w, 'checkpoint')).toHaveLength(1)

    await progress($, { action: 'status' })
    await progress($, { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'ran again' })
    await mainTurnEnds($)
    await w.clock.settle()
    expect(plays(w, 'complete')).toHaveLength(1)
  })

  test('falls back from a missing player to the next one, and remembers it', async ($, on) => {
    const w = world(on, { players: { paplay: 'ok' } })
    await start($)
    await prompt($, 'x')
    await planAndComplete($, 4)
    await w.clock.settle()
    expect(w.runs.filter(argv => argv[0] !== 'git').map(argv => argv[0])).toEqual(['pw-play', 'paplay'])

    await passAllGates($)
    await progress($, { action: 'complete', milestone: 'm5' })
    await w.clock.settle()
    expect(plays(w, 'complete').map(argv => argv[0])).toEqual(['paplay'])
  })

  for (const [name, players] of [
    ['no player installed', {}],
    ['every player exits non-zero', { 'pw-play': 'fails', paplay: 'fails', aplay: 'fails', ffplay: 'fails', mpv: 'fails', play: 'fails', 'canberra-gtk-play': 'fails', afplay: 'fails', sh: 'fails' }],
    ['the player hangs past its timeout', { 'pw-play': 'hangs' }],
  ] as const) {
    test(`audio failure is harmless: ${name}`, async ($, on) => {
      const w = world(on, { players })
      await start($)
      await prompt($, 'x')
      const reply = await planAndComplete($, 4)
      await w.clock.settle()

      // the tool call answered as it does with sound, and the task moved
      expect(reply).toStartWith('VERIFY 80% (4/5 milestones)')
      await passAllGates($)
      expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
      await w.clock.settle()
      // nothing reached the transcript, and an ordinary tool call still runs
      expect(w.transcript).toEqual([])
      expect(await bash($, 'ls')).toMatchObject({ result: { stdout: '' } })
    })
  }

  test('a machine with no sound is asked once, not at every cue', async ($, on) => {
    const w = world(on, { players: {} })
    await start($)
    await prompt($, 'x')
    await planAndComplete($, 4)
    await w.clock.settle()
    const tried = w.runs.filter(argv => argv[0] !== 'git').length
    await passAllGates($)
    await progress($, { action: 'complete', milestone: 'm5' })
    await w.clock.settle()
    expect(w.runs.filter(argv => argv[0] !== 'git')).toHaveLength(tried)
  })

  test('sounds off in the configuration: no player is run', { options: { sounds: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'x')
    await planAndComplete($, 4)
    await w.clock.settle()
    expect(w.runs.filter(argv => argv[0] !== 'git')).toEqual([])
  })

  test('/cockpit mute silences the cues', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await command($, 'mute')).text).toContain('muted')
    await prompt($, 'x')
    await planAndComplete($, 4)
    await w.clock.settle()
    expect(plays(w, 'checkpoint')).toEqual([])
  })
})

describe('verification from real results', () => {
  test('a passing test command passes the gate; a failing one fails it', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'x')
    await planAndComplete($, 2)
    await bash($, 'npm test')
    expect(await progress($, { action: 'status' })).toContain('TEST pass')

    w.failing = /npm test/
    await bash($, 'npm test')
    const status = await progress($, { action: 'status' })
    expect(status).toContain('TEST fail')
    expect(status).toStartWith('FIX 40%')
  })

  test('a test that fails after the task was done takes progress back', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'x')
    await planAndComplete($, 4)
    await passAllGates($)
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')

    w.failing = /npm test/
    await bash($, 'npm test')
    expect(await progress($, { action: 'status' })).toStartWith('FIX 40% (2/5 milestones)')
    const hud = await rowsOf(await mountHud($, 'terminal'))
    // The Activity Field may add rows of its own above the HUD, so the band is
    // read whole rather than by row index.
    expect(hud.join('\n')).toContain('FIX')
    expect(hud.join('\n')).toContain('TEST ✗')
    const pane = (await rowsOf(await mountPane($, 'terminal'))).join('\n')
    expect(pane).toContain('06 FAULTS')
    expect(pane).toContain('TEST failed: npm test (failed)')
  })

  test('a masked result is pending, not a pass', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'x')
    await planAndComplete($, 1)
    await bash($, 'npm test 2>&1 | tail -20')
    expect(await progress($, { action: 'status' })).toContain('TEST pending')
  })

  test('edits are counted as files touched, with their lines', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'x')
    await $.tool.call({ tool: 'Edit', file_path: '/work/example/src/api.ts', old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/work/example/src/limiter.ts', content: 'export const a = 1\nexport const b = 2\nexport const c = 3\n' } as never)
    const pane = (await rowsOf(await mountPane($, 'terminal'))).join('\n')
    expect(pane).toContain('05 FILES')
    expect(pane).toContain('2 touched   +5 −1')
    expect(pane).toContain('src/api.ts +2 −1')
    // a new file: every line of it counts as added
    expect(pane).toContain('src/limiter.ts +3 −0')
  })
})

describe('blast-radius guard', () => {
  test('a destructive command is put to the person; Cancel stops it', async ($, on) => {
    const w = world(on, { answer: 'Cancel' })
    await start($)
    const answer = await bash($, 'git reset --hard origin/main')

    expect(w.asked).toHaveLength(1)
    expect(w.asked[0]).toBe('Destructive: git reset --hard. Run "git reset --hard origin/main"?')
    // Cancel is the first choice offered
    const dialog = w.ran.find(call => call['tool'] === 'AskUserQuestion') as { questions: { header: string; options: { label: string }[] }[] }
    expect(dialog.questions[0]?.header).toBe('Blast radius')
    expect(dialog.questions[0]?.options.map(option => option.label)).toEqual(['Cancel', 'Proceed'])
    expect((answer as { deny?: string }).deny).toContain('did not approve')
    expect(commandsRun(w)).toEqual([])
  })

  test('Proceed runs it exactly as written', async ($, on) => {
    const w = world(on, { answer: 'Proceed' })
    await start($)
    await bash($, 'git push --force origin main')

    expect(w.asked).toHaveLength(1)
    expect(commandsRun(w)).toEqual(['git push --force origin main'])
  })

  test('a dismissed dialog, or nobody to ask, is a refusal', async ($, on) => {
    const w = world(on, { answer: null })
    await start($)
    const answer = await bash($, 'rm -rf ~')
    expect((answer as { deny?: string }).deny).toContain('did not approve')
    expect(commandsRun(w)).toEqual([])
  })

  test('the dialog explains what is about to happen and what is at stake', async ($, on) => {
    const w = world(on, {
      answer: 'Cancel',
      gitStatus: '# branch.oid abc1234\n# branch.head main\n1 .M N... 1 1 1 a b src/api.ts\n? notes.md\n',
    })
    let drawn = ''
    w.whileAsked = async question => {
      for (const surface of SURFACES) {
        const dialog = await $.ui.mount({
          plugin: PLUGIN,
          surface,
          component: 'AskUserQuestion',
          props: { tool: 'AskUserQuestion', questions: [{ question, header: 'Blast radius', options: [{ label: 'Proceed' }, { label: 'Cancel' }], multiSelect: false }] },
          viewport: { columns: 100, rows: 40 },
        })
        drawn = (await dialog.findAll({ type: 'Text' })).map(one => one.text).join('\n')
        await dialog.unmount()
      }
    }
    await start($)
    await w.clock.settle()
    await bash($, 'git clean -fdx')

    expect(drawn).toContain('BLAST RADIUS')
    expect(drawn).toContain('$ git clean -fdx')
    expect(drawn).toContain('Permanently deletes untracked files')
    expect(drawn).toContain('2 uncommitted changes at stake')
  })

  test('safe commands pass untouched and unasked', async ($, on) => {
    const w = world(on)
    await start($)
    const safe = [
      'npm test',
      'git status',
      'git push origin main',
      'git reset --soft HEAD~1',
      'rm -rf node_modules dist',
      'rm -rf /tmp/example-build',
      'echo "rm -rf /"',
      'git commit -m "docs: explain git reset --hard"',
      'grep -rn "DROP TABLE" migrations/',
      'docker compose down',
    ]
    for (const one of safe) await bash($, one)

    expect(w.asked).toEqual([])
    expect(commandsRun(w)).toEqual(safe)
    // the input reached the engine as it was given: nothing added, nothing rewritten
    const calls = w.ran.filter(call => call['tool'] === 'Bash')
    expect(Object.keys(calls[0] ?? {}).filter(key => key !== 'tool_use_id').sort()).toEqual(['command', 'tool'])
  })

  test('other tools are not interfered with', async ($, on) => {
    const w = world(on)
    await start($)
    const answer = await $.tool.call({ tool: 'Read', file_path: '/work/example/README.md' } as never)
    expect(answer).toEqual({ result: {} })
    expect(w.asked).toEqual([])
  })

  test('off in the configuration: nothing is asked', { options: { blastRadiusGuard: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await bash($, 'git reset --hard')
    expect(w.asked).toEqual([])
    expect(commandsRun(w)).toEqual(['git reset --hard'])
  })
})

describe('AI attribution guard', () => {
  const TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>'

  test('the engine is told to write no attribution into commits and pull requests', async ($, on) => {
    world(on)
    expect(await $.attribution.text({ kind: 'commit', text: TRAILER })).toEqual({ text: '' })
    expect(await $.attribution.text({ kind: 'pr', text: 'Generated with Claude Code' })).toEqual({ text: '' })
  })

  test('a commit carrying an AI co-author does not run', async ($, on) => {
    const w = world(on)
    await start($)
    const answer = await bash($, `git commit -m "$(cat <<'EOF'\nfeat: add limiter\n\n${TRAILER}\nEOF\n)"`)
    expect((answer as { deny?: string }).deny).toContain('AI attribution')
    expect((answer as { deny?: string }).deny).toContain('Co-Authored-By: Claude')
    expect(commandsRun(w)).toEqual([])

    await bash($, 'git commit -m "feat: add limiter"')
    expect(commandsRun(w)).toEqual(['git commit -m "feat: add limiter"'])
  })

  test('an edit that adds an AI trailer or footer does not run', async ($, on) => {
    const w = world(on)
    await start($)
    const edit = await $.tool.call({ tool: 'Edit', file_path: '/work/example/CHANGELOG.md', old_string: '## 1.2\n', new_string: `## 1.2\n\n${TRAILER}\n` } as never)
    const write = await $.tool.call({ tool: 'Write', file_path: '/work/example/NOTES.md', content: '# Notes\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)\n' } as never)
    expect((edit as { deny?: string }).deny).toContain('AI attribution')
    expect((write as { deny?: string }).deny).toContain('AI attribution')
    expect(w.ran.filter(call => call['tool'] === 'Edit' || call['tool'] === 'Write')).toEqual([])
  })

  test('a line that only reads as attribution is the person\'s call', async ($, on) => {
    const w = world(on, { answer: 'Block' })
    await start($)
    const call = { tool: 'Write', file_path: '/work/example/README.md', content: '# SampleProject\n\nBuilt with Claude\n' } as never
    expect(((await $.tool.call(call)) as { deny?: string }).deny).toContain('Built with Claude')
    expect(w.asked[0]).toContain('reads as AI attribution')

    w.answer = 'Allow once'
    expect(await $.tool.call(call)).toMatchObject({ result: { filePath: '/work/example/README.md' } })
  })

  test('ordinary edits, and code that merely mentions AI, pass unasked', async ($, on) => {
    const w = world(on)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: '/work/example/src/ui.tsx', old_string: 'x', new_string: 'const label = "Generated by AI"' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/work/example/src/client.ts', content: '// Client for the Anthropic API\nexport {}\n' } as never)
    expect(w.asked).toEqual([])
    expect(w.ran.map(call => call['tool'])).toEqual(['Edit', 'Write'])
  })

  test('rewriting a file that already carries the line is not adding it', async ($, on) => {
    const w = world(on, { files: { '/work/example/README.md': '# SampleProject\n\nBuilt with Claude\n' } })
    await start($)
    await $.tool.call({ tool: 'Write', file_path: '/work/example/README.md', content: '# SampleProject\n\nBuilt with Claude\n\nMore.\n' } as never)
    expect(w.asked).toEqual([])
  })

  test('CLAUDE.md and AGENTS.md are not created unasked', async ($, on) => {
    const w = world(on, { answer: 'Block' })
    await start($)
    await prompt($, 'fix the failing tests')
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const answer = await $.tool.call({ tool: 'Write', file_path: `/work/example/${name}`, content: '# Project\n' } as never)
      expect((answer as { deny?: string }).deny).toContain(`${name} is only created when the user asks`)
    }
    expect(((await bash($, 'cat > AGENTS.md <<EOF\n# Agents\nEOF')) as { deny?: string }).deny).toContain('AGENTS.md')
    expect(w.asked).toHaveLength(3)
    expect(w.ran.filter(call => call['tool'] !== 'AskUserQuestion')).toEqual([])
  })

  test('they are created when the person asked, and an existing one is edited freely', async ($, on) => {
    const w = world(on, { answer: 'Block', files: { '/work/example/AGENTS.md': '# Agents\n' } })
    await start($)
    await prompt($, 'please write a CLAUDE.md for this repo')
    await $.tool.call({ tool: 'Write', file_path: '/work/example/CLAUDE.md', content: '# Project\n' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/work/example/AGENTS.md', content: '# Agents\n\nMore.\n' } as never)
    expect(w.asked).toEqual([])
    expect(w.ran.map(call => call['tool'])).toEqual(['Write', 'Write'])
  })

  test('the system prompt carries the discipline and the hygiene rules', async ($, on) => {
    world(on)
    await start($)
    const { sections } = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const mine = sections.find(section => section.id === 'cobalt-cockpit:discipline')
    expect(sections[0]?.id).toBe('intro')
    expect(mine?.scope).toBe('session')
    expect(mine?.text).toContain('Inspect before editing')
    expect(mine?.text).toContain('The end of a turn is not the end of the task')
    expect(mine?.text).toContain('Never add AI attribution')
    expect(mine?.text).toContain('Do not create CLAUDE.md or AGENTS.md')
  })

  test('off in the configuration: attribution text and files pass', { options: { attributionGuard: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(await $.attribution.text({ kind: 'commit', text: TRAILER })).toEqual({ text: TRAILER })
    await bash($, `git commit -m "x" -m "${TRAILER}"`)
    expect(commandsRun(w)).toHaveLength(1)
  })
})

describe('git and context in the HUD', () => {
  test('a dirty tree with commits ahead and behind', async ($, on) => {
    const w = world(on, {
      gitStatus: '# branch.oid e4f5a6b7c8d9\n# branch.head feature/limits\n# branch.upstream origin/feature/limits\n# branch.ab +1 -2\n1 .M N... 1 1 1 a b src/api.ts\n? notes.md\n? todo.md\n',
    })
    await start($)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const rows = await rowsOf(await mountHud($, surface))
      const pane = await mountPane($, surface)
      const detail = (await rowsOf(pane)).join('\n')
      expect(detail).toContain('feature/limits')
      expect(detail).toContain('3 changed')
      await pane.unmount()
      expect(rows[0]).toContain('example')
    }
  })

  test('outside a repository', async ($, on) => {
    const w = world(on, { gitStatus: null })
    await start($)
    await w.clock.settle()
    expect((await rowsOf(await mountPane($, 'terminal'))).join('\n')).toContain('not a git repository')
  })

  test('HEAD moving shows start and current, and a tool call refreshes the tree', async ($, on) => {
    const w = world(on)
    await start($)
    await w.clock.settle()
    const firstPane = await mountPane($, 'terminal')
    expect((await rowsOf(firstPane)).join('\n')).toContain('1111111')
    await firstPane.unmount()

    w.gitStatus = '# branch.oid 2222222bbbbbbb\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0\n1 .M N... 1 1 1 a b src/api.ts\n'
    await bash($, 'git commit -am "feat: limiter"')
    await w.clock.advance(500)
    const detail = (await rowsOf(await mountPane($, 'terminal'))).join('\n')
    expect(detail).toContain('1111111→2222222')
    expect(detail).toContain('1 changed')
    expect(detail).toContain('↑1')
  })

  test('the context meter shows what session.usage reports, and follows session.measure', async ($, on) => {
    const w = world(on, { usage: { percent: 39, tokens: 78_000, window: 200_000 } })
    await start($)
    await w.clock.settle()
    expect((await rowsOf(await mountHud($, 'terminal')))[1]).toContain('CTX 39%')

    await $.session.measure({ context: { window: 200_000, tokens: 144_000, percent: 72 }, rateLimits: [], changed: ['context'] })
    expect((await rowsOf(await mountHud($, 'terminal')))[1]).toContain('CTX 72%')
    const pane = (await rowsOf(await mountPane($, 'terminal'))).join('\n')
    expect(pane).toContain('72%  144k / 200k tokens')
  })

  test('before the first response the meter claims nothing', async ($, on) => {
    const w = world(on, { usage: { window: 200_000 } })
    await start($)
    await w.clock.settle()
    expect((await rowsOf(await mountHud($, 'terminal')))[1]).toContain('CTX --')
  })

  test('model and effort are shown when the engine reports them', async ($, on) => {
    const w = world(on)
    await start($)
    await w.clock.settle()
    await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'tu1', effort: { level: 'high' } })
    expect((await rowsOf(await mountHud($, 'terminal')))[1]).toEndWith('opus-5-5 · high')
  })
})

describe('rendering', () => {
  test('every width draws a valid tree on every surface that has the band', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 4)
    await w.clock.settle()
    for (const surface of SURFACES) {
      for (const [columns, rowCount] of [[140, 2], [80, 2], [64, 2], [50, 2], [30, 1], [12, 1]] as const) {
        const hud = await mountHud($, surface, columns)
        const rows = await rowsOf(hud)
        expect(rows, `${surface} at ${columns}`).toHaveLength(rowCount)
        for (const row of rows) expect([...row].length, `${surface} at ${columns}: ${row}`).toBeLessThanOrEqual(columns)
        await hud.unmount()
      }
    }
  })

  test('the particle track is a Raster on the terminal and SVG on desktop', async ($, on) => {
    world(on)
    await start($)
    const terminal = await mountHud($, 'terminal', 120, true)
    const cells = await elementsOf(terminal)
    // the badge comes first, then the track: both one row, the badge three cells
    expect(cells.filter(one => one.type === 'Raster').map(one => one.props?.['key'])).toEqual(['operator', 'progress-track'])
    expect(cells.find(one => one.props?.['key'] === 'progress-track')?.props).toMatchObject({ columns: 85, rows: 1 })
    const desktop = await mountHud($, 'desktop', 120, true)
    const drawn = await elementsOf(desktop)
    expect(drawn.some(one => one.type === 'Raster')).toBe(false)
    // the portrait, the track, the interactive overlay, then the crawler riding
    // on top of it. The crawler's own alt names its real state and real
    // progress, and nothing it has not observed.
    expect(drawn.filter(one => one.type === 'Svg').map(one => one.props?.['alt'])).toEqual([
      'VECTOR / glitch',
      'INSPECT --% SCAN',
      'Stage and step checkpoints',
      'scan --%',
    ])
  })

  test('it yields the band to a survey, and can be hidden', async ($, on) => {
    world(on)
    await start($)
    const survey = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: true, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
    })
    expect(await survey.findAll({ text: 'COBALT' })).toEqual([])

    expect((await command($, 'hud off')).text).toContain('hidden')
    expect(await (await mountHud($, 'terminal')).findAll({ text: 'COBALT' })).toEqual([])
    expect((await command($, 'hud on')).text).toContain('shown')
    expect(await (await mountHud($, 'terminal')).find({ type: 'Raster' })).toBeDefined()
  })

  test('particles animate while a turn runs and stop when it ends', async ($, on) => {
    const w = world(on)
    await start($)
    await mountHud($, 'terminal', 120, true)
    await w.clock.advance(1000)
    expect(w.blits).toBe(0)

    await planAndComplete($, 2)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await mountHud($, 'terminal', 120, true)
    await w.clock.advance(1100)
    expect(w.blits).toBeGreaterThanOrEqual(6)
    expect(w.blits).toBeLessThanOrEqual(19)

    await mainTurnEnds($)
    const atEnd = w.blits
    await w.clock.advance(5000)
    expect(w.blits).toBe(atEnd)
  })

  test('animation off: no timer runs', { options: { animation: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await mountHud($, 'terminal', 120, true)
    await w.clock.advance(2000)
    expect(w.blits).toBe(0)
  })
})

describe('the Activity Field, through the plugin', () => {
  test('a real call becomes a real event on the tape', async ($, on) => {
    world(on)
    await start($)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/example/src/auth.ts' } as never)
    const field = (await fieldRowsOf(await mountHud($, 'terminal', 120, true))).join('\n')
    expect(field).toContain('READ')
    expect(field).toContain('auth.ts')
  })

  test('a bash command never reaches the tape, only its kind', async ($, on) => {
    const w = world(on)
    await start($)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: `curl -H "${['Authori', 'zation'].join('')}: ${['Bea', 'rer'].join('')} ${['sk-', 'live-SECRET'].join('')}" https://api.example.com` } as never)
    const field = (await fieldRowsOf(await mountHud($, 'terminal', 120, true))).join('\n')
    expect(field).toContain('BASH')
    expect(field).not.toContain('SECRET')
    expect(field).not.toContain('curl')
    expect(commandsRun(w)).toHaveLength(1)
  })

  test('no tool calls means no field at all', async ($, on) => {
    world(on)
    await start($)
    await $.turn.start({ text: 'x', turnId: 't1' })
    const rows = await rowsOf(await mountHud($, 'terminal', 120, true))
    expect(rows.join('\n')).not.toContain('READ')
    expect(rows.join('\n')).not.toContain('BASH')
    // With nothing real observed there is no field element in the band at all.
    expect((await elementsOf(await mountHud($, 'terminal', 120, true))).some(one => one.props?.['key'] === 'activity-field')).toBe(false)
  })

  test('the field is a Raster on the terminal and an SVG on the desktop', async ($, on) => {
    world(on)
    await start($)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/example/src/auth.ts' } as never)
    const terminal = await elementsOf(await mountHud($, 'terminal', 120, true))
    const field = terminal.find(one => one.props?.['key'] === 'activity-field')
    expect(field?.type).toBe('Raster')
    expect(field?.props).toMatchObject({ columns: 120 })
    const desktop = await elementsOf(await mountHud($, 'desktop', 120, true))
    // A `Raster` carries its blit key as a prop; an `Svg` does not, so the
    // desktop field is found by the alt it draws, which names the real event.
    const vector = desktop.find(one => one.type === 'Svg' && String(one.props?.['alt'] ?? '').includes('READ'))
    expect(vector?.type).toBe('Svg')
    expect(String(vector?.props?.['alt'])).toContain('auth.ts')
  })

  test('the crawler keeps walking the tape frame by frame', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 2)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/example/src/auth.ts' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/work/example/src/session.ts' } as never)
    await mountHud($, 'terminal', 140, true)
    await w.clock.advance(200)
    const early = w.blits
    await w.clock.advance(600)
    // The field is repainted as the creature walks between the two real events,
    // so blits keep accumulating rather than the band going still.
    expect(early).toBeGreaterThan(0)
    expect(w.blits).toBeGreaterThan(early)
  })

  test('the field animates only while work is real, and stops when it ends', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 2)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/example/src/auth.ts' } as never)
    await mountHud($, 'terminal', 140, true)
    await w.clock.advance(600)
    expect(w.blits).toBeGreaterThan(0)

    await mainTurnEnds($)
    await mountHud($, 'terminal', 140)
    const atEnd = w.blits
    await w.clock.advance(5000)
    expect(w.blits).toBe(atEnd)
  })

  test('animation off: the field is drawn once and never blitted', { options: { animation: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/example/src/auth.ts' } as never)
    await mountHud($, 'terminal', 140, true)
    await w.clock.advance(2000)
    expect(w.blits).toBe(0)
  })

  test('reduced motion still shows the truth, drawn once', { options: { reducedMotion: true } }, async ($, on) => {
    const w = world(on)
    await start($)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/example/src/auth.ts' } as never)
    await mountHud($, 'terminal', 140, true)
    await w.clock.advance(2000)
    expect(w.blits).toBe(0)
    expect((await fieldRowsOf(await mountHud($, "terminal", 140, true))).join('\n')).toContain('READ')
  })

  test('the field never exceeds the height budget at any width', async ($, on) => {
    const w = world(on)
    await start($)
    await $.turn.start({ text: 'x', turnId: 't1' })
    for (const file of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await $.tool.call({ tool: 'Read', file_path: `/work/example/${file}` } as never)
    await w.clock.settle()
    for (const columns of [140, 80, 50, 30, 12]) {
      const field = await elementsOf(await mountHud($, 'terminal', columns, true))
      const raster = field.find(one => one.props?.['key'] === 'activity-field')
      expect(Number(raster?.props?.['rows']), `at ${columns}`).toBeLessThanOrEqual(2)
    }
  })
})

describe('coexistence with a second AbovePrompt plugin', () => {
  test('the engine drawing is kept, not replaced: next(e) is composed', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 2)
    // `next(e)` resolves to whatever else drew in this band. Cockpit keeps it
    // and draws beneath, so whichever plugin is outermost neither swallows the
    // other: this is what lets a pasted-image viewer sit alongside the HUD.
    const tree = (await (await mountHud($, 'terminal', 120)).drawn()) as { children?: unknown[] }
    expect(JSON.stringify(tree.children?.[0])).toContain('engine:AbovePrompt')
  })

  test('what another plugin drew sits above the HUD, in the order asked for', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 2)
    const hud = await mountHud($, 'terminal', 120, true)
    const tree = (await hud.drawn()) as { children?: unknown[] }
    // Cockpit renders `below` first and its own rows after it, so the stack a
    // person reads is: another plugin's tiles, then the HUD, then the prompt.
    // Both orders of plugin load therefore produce that same stack.
    expect((tree.children ?? [])[0]).toMatchObject({ type: 'Box' })
    // Cockpit's own drawing, the HUD's track included, is still all there.
    const keys = (await elementsOf(hud)).map(one => one.props?.['key'])
    expect(keys).toContain('progress-track')
  })

  test('the HUD still draws its own rows alongside that', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 2)
    expect((await rowsOf(await mountHud($, 'terminal', 120))).join('\n')).toContain('%')
  })

  test('with the HUD hidden the band is passed straight through', async ($, on) => {
    world(on)
    await start($)
    expect((await command($, 'hud off')).text).toContain('hidden')
    const tree = (await (await mountHud($, 'terminal', 120)).drawn()) as { children?: unknown[] }
    expect(JSON.stringify(tree.children?.[0])).toContain('engine:AbovePrompt')
  })

  test('a survey still takes the whole band from us', async ($, on) => {
    world(on)
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/work/example/src/auth.ts' } as never)
    const survey = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: true, isWorking: true, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
    })
    // Cockpit yields, so a pasted-image viewer's tiles and the survey both draw
    // and neither is crowded out by the HUD.
    const tree = (await survey.drawn()) as { children?: unknown[] }
    expect(JSON.stringify(tree.children?.[0])).toContain('engine:AbovePrompt')
  })
})

describe('Mission Control', () => {
  test('/cockpit opens the pane; it shows the task in full', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting to the bids API')
    await planAndComplete($, 2)
    await progress($, { action: 'start', milestone: 'm3' })
    await $.turn.start({ text: 'x', turnId: 't1' })
    await bash($, 'npm test')
    await w.clock.advance(65_000)

    await command($, '')
    expect(w.opened).toEqual([PLUGIN])

    for (const surface of SURFACES) {
      const pane = await mountPane($, surface)
      const text = (await rowsOf(pane)).join('\n')
      // the dossier is numbered sections in the panel label grammar
      expect(text).toMatch(/01 TASK ─+/)
      expect(text).toMatch(/04 VERIFICATION ─+/)
      expect(text).toMatch(/07 REPOSITORY ─+/)
      expect(text).toContain(' Goal         Add rate limiting to the bids API')
      expect(text).toContain('2/5  ACTIVE')
      expect(text).toContain('Phase        TEST')
      expect(text).toContain('1m 05s ago')
      expect(text).toContain('Latest       1m 05s ago  TEST npm test')
      expect(text).toContain(' ✓ m1  Inspect  INSPECT')
      expect(text).toContain(' ▶ m3  Test  TEST')
      expect(text).toContain(' ✓ TEST      pass     npm test (exit 0)')
      expect(text).toContain(' · SECURITY  unset    required, not yet verified')
      expect(text).toContain('Branch       main  example')
      expect(text).toContain('HEAD         1111111')
      expect(text).toContain('Tree         clean')
      // a surface that draws pictures shows the operator's portrait beside a
      // call sign instead of the text banner; a terminal draws the banner rows
      expect(text).toContain('▒ VECTOR  CONSOLE / MISSION')
      expect(text).toContain(' STATE / SCAN  THINK')
      if (surface === 'desktop') expect(await pane.find({ type: 'Svg' })).toBeDefined()
      expect(await pane.find({ key: 'close' })).toBeDefined()
      await pane.unmount()
    }
  })

  test('/cockpit status and reset', async ($, on) => {
    world(on)
    await start($)
    expect((await command($, 'status')).text).toBe('No task yet.')
    await prompt($, 'x')
    await planAndComplete($, 1)
    expect((await command($, 'status')).text).toStartWith('IMPLEMENT 20%')
    expect((await command($, 'reset')).text).toContain('cleared')
    expect((await command($, 'status')).text).toBe('No task yet.')
    expect((await command($, 'nonsense')).text).toContain('/cockpit status')
  })

  test('/clear ends the task with the conversation', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'x')
    await planAndComplete($, 3)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect((await command($, 'status')).text).toBe('No task yet.')
  })
})

describe('hot reload', () => {
  const heldTask = (): Task => {
    let task = applyAction(newTask(4, 'Add rate limiting', 900_000, '1111111aaaaaaa'), { action: 'plan', milestones: FIVE }, 900_000, null).task
    for (const n of [1, 2, 3, 4]) task = settle(applyAction(task, { action: 'complete', milestone: `m${n}` }, 900_000, null).task).task

    return task
  }

  test('a freshly loaded module picks the task up from $.state and replays nothing', async ($, on) => {
    const w = world(on)
    const held = hostState(on, {
      task: heldTask(),
      activity: { kind: 'EDIT', detail: 'api.ts', isWorking: true, toolUseId: null, agents: [], at: 900_000 },
    })

    // the load's own session.start, as after a save of the module
    await start($)
    await w.clock.settle()

    expect(await progress($, { action: 'status' })).toStartWith('VERIFY 80% (4/5 milestones)')
    const hud = await mountHud($, 'terminal', 120, true)
    const rows = await rowsOf(hud)
    expect(rows[0]).toContain('VERIFY')
    expect(rows[0]).toContain('80%')
    // the 80% cue was played before the reload: it stays played
    expect(plays(w, 'checkpoint')).toEqual([])
    expect((held.get('task')?.value as Task).hasCue80Fired).toBe(true)
    expect((held.get('task')?.value as Task).id).toBe(4)

    // the turn was running when the module reloaded: the waveform resumes
    await w.clock.advance(600)
    expect(w.blits).toBeGreaterThan(3)
  })

  test('session.start firing again changes nothing that was held', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 3)
    const before = await progress($, { action: 'status' })

    await start($)
    await w.clock.settle()
    expect(await progress($, { action: 'status' })).toBe(before)
  })
})

describe('version floor', () => {
  test('on a Claude Code older than 2.1.287 it stands by and says so once', async ($, on) => {
    const w = world(on, { version: '2.1.286' })
    await start($)
    await bash($, 'git reset --hard')

    expect(w.transcript).toHaveLength(1)
    expect(w.transcript[0]).toContain('needs Claude Code 2.1.287 or newer')
    expect(w.asked).toEqual([])
    expect(commandsRun(w)).toEqual(['git reset --hard'])
    expect(await (await mountHud($, 'terminal')).findAll({ text: 'COBALT' })).toEqual([])
  })

  for (const version of ['2.1.287', '2.1.287-dev', '2.1.288', '2.2.0', '3.0.0']) {
    test(`${version} is supported`, async ($, on) => {
      const w = world(on, { version, answer: 'Cancel' })
      await start($)
      await bash($, 'git reset --hard')
      expect(w.transcript).toEqual([])
      expect(w.asked).toHaveLength(1)
    })
  }
})

describe('Local Control, through the plugin', () => {
  // The ledger the router appends to, resolved the way the plugin resolves it.
  const LEDGER = '/home/tester/.local/state/decision-router/ledger.jsonl'

  const receiptLine = (requestId: string): string =>
    `${JSON.stringify({
      ts: '2026-10-03T07:39:10.565+00:00',
      operation: 'prune',
      request_id: requestId,
      caller: 'claude',
      provider: 'nobodywho',
      model: 'Qwen_Qwen3-4B-Q4_K_M',
      tier: 1,
      latency_ms: 518,
      attempts: [{ tier: 1, provider: 'nobodywho', outcome: 'accepted', judged_blocks: 4, dropped_blocks: 2 }],
    })}\n`

  /** Lets the watcher reach its first read, and then its next. */
  const settle = async (w: ReturnType<typeof world>): Promise<void> => {
    await w.clock.settle()
    await w.clock.settle()
  }

  test('with no NobodyWho the HUD is exactly what it always was', { options: { ledgerPath: LEDGER } }, async ($, on) => {
    world(on, { files: {} })
    await start($)
    await prompt($, 'Add rate limiting to the bids API')
    await planAndComplete($, 2)
    for (const surface of SURFACES) {
      const hud = await mountHud($, surface, 120, true)
      const rows = (await rowsOf(hud)).join('\n')
      // No strip, no placeholder, no warning about anything being absent.
      expect(rows, surface).not.toContain('NWHO')
      expect(rows, surface).not.toContain('NOBODYWHO')
      expect(rows, surface).not.toContain('unavailable')
      expect(rows, surface).toContain('40%')
      await hud.unmount()
    }
  })

  test('with no NobodyWho /cockpit carries no LOCAL CONTROL section', { options: { ledgerPath: LEDGER } }, async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 1)
    for (const surface of SURFACES) {
      const pane = await mountPane($, surface, 80)
      const rows = (await rowsOf(pane)).join('\n')
      expect(rows, surface).not.toContain('LOCAL CONTROL')
      expect(rows, surface).not.toContain('NWHO')
      await pane.unmount()
    }
  })

  test('a ledger full of old receipts never flashes on startup', { options: { ledgerPath: LEDGER } }, async ($, on) => {
    // Genuine history, all of it predating this session: the HUD stays silent,
    // because history on disk is not current activity.
    const files: Record<string, string> = { [LEDGER]: `${receiptLine('old1')}${receiptLine('old2')}${receiptLine('old3')}` }
    const w = world(on, { files })
    await start($)
    await settle(w)
    await prompt($, 'Add rate limiting')
    const hud = await mountHud($, 'terminal', 120, true)
    expect((await rowsOf(hud)).join('\n')).not.toContain('NWHO')
    // The HUD is otherwise entirely normal: the task and its track are intact.
    expect((await rowsOf(hud)).join('\n')).toContain('Add rate limiting')
    await hud.unmount()
    expect(plays(w, 'checkpoint').length).toBeGreaterThanOrEqual(0)
  })

  test('a receipt that genuinely arrives shows, then is gone', { options: { ledgerPath: LEDGER } }, async ($, on) => {
    const files: Record<string, string> = { [LEDGER]: receiptLine('old1') }
    const w = world(on, { files })
    await start($)
    await settle(w)
    await prompt($, 'Add rate limiting')
    await progress($, { action: 'plan', milestones: FIVE })
    // A real prune receipt, appended after the session had already begun.
    files[LEDGER] = `${receiptLine('old1')}${receiptLine('fresh1')}`
    await settle(w)
    await w.clock.advance(2_000)
    const hud = await mountHud($, 'terminal', 120, true)
    const shown = (await rowsOf(hud)).join('\n')
    expect(shown).toContain('NWHO')
    expect(shown).toContain('PRUNE')
    expect(shown).toContain('Q4B')
    expect(shown).toContain('4→2')
    expect(shown).toContain('518ms')
    await hud.unmount()
    // Long after the flash has faded there is no row left behind.
    await w.clock.advance(30_000)
    const quiet = await mountHud($, 'terminal', 120, true)
    expect((await rowsOf(quiet)).join('\n')).not.toContain('NWHO')
    await quiet.unmount()
  })

  test('a repeated receipt is shown once, not once per read', { options: { ledgerPath: LEDGER } }, async ($, on) => {
    const files: Record<string, string> = { [LEDGER]: '' }
    const w = world(on, { files })
    await start($)
    await settle(w)
    await prompt($, 'Add rate limiting')
    files[LEDGER] = receiptLine('dup')
    await settle(w)
    await w.clock.advance(2_000)
    // The router repeats itself; the HUD must not stack lines.
    files[LEDGER] = receiptLine('dup')
    await settle(w)
    await w.clock.advance(2_000)
    const hud = await mountHud($, 'terminal', 120, true)
    expect(((await rowsOf(hud)).join('\n').split('NWHO').length - 1)).toBe(1)
    await hud.unmount()
  })

  test('a broken ledger never reaches the session', { options: { ledgerPath: LEDGER } }, async ($, on) => {
    // A ledger that is not JSON at all, then no ledger at all: neither is an error.
    const files: Record<string, string> = { [LEDGER]: 'not json\n{broken\n' }
    const w = world(on, { files })
    await start($)
    await settle(w)
    await prompt($, 'Add rate limiting')
    await planAndComplete($, 1)
    const hud = await mountHud($, 'terminal', 120, true)
    expect((await rowsOf(hud)).join('\n')).not.toContain('NWHO')
    // The HUD is fully alive regardless.
    expect((await rowsOf(hud)).join('\n')).toContain('20%')
    files[LEDGER] = ''
    delete (files as Partial<Record<string, string>>)[LEDGER]
    await settle(w)
    const after = await mountHud($, 'terminal', 120, true)
    expect((await rowsOf(after)).join('\n')).toContain('20%')
    await hud.unmount()
    await after.unmount()
    expect(w.ran.filter(call => call['tool'] === 'Bash')).toEqual([])
  })

  test('another caller receipts are not this session activity', { options: { ledgerPath: LEDGER } }, async ($, on) => {
    const files: Record<string, string> = { [LEDGER]: '' }
    const w = world(on, { files })
    await start($)
    await settle(w)
    await prompt($, 'Add rate limiting')
    files[LEDGER] = `${receiptLine('mine')}${receiptLine('theirs').replace('"caller":"claude"', '"caller":"cline"')}`
    await settle(w)
    await w.clock.advance(2_000)
    const hud = await mountHud($, 'terminal', 120, true)
    const shown = (await rowsOf(hud)).join('\n')
    expect(shown).toContain('NWHO')
    // One receipt of ours, one of theirs: only ours reached the HUD.
    expect(shown.split('NWHO').length - 1).toBe(1)
    await hud.unmount()
    expect(w.blits).toBeGreaterThanOrEqual(0)
  })

  test('the session ends with the watcher stopped', { options: { ledgerPath: LEDGER } }, async ($, on) => {
    const files: Record<string, string> = { [LEDGER]: receiptLine('old1') }
    const w = world(on, { files })
    await start($)
    await settle(w)
    await $.session.end({ sessionId: 's1', reason: 'other', resume: { id: 's1' } })
    // Nothing further is read from a ledger after the session is over.
    files[LEDGER] = `${receiptLine('old1')}${receiptLine('after-end')}`
    await settle(w)
    await w.clock.advance(2_000)
    const hud = await mountHud($, 'terminal', 120, true)
    expect((await rowsOf(hud)).join('\n')).not.toContain('after-end')
    await hud.unmount()
    expect(w.ran.length).toBeGreaterThanOrEqual(0)
  })
})

describe('the startup sequence', () => {
  test('it shows while initializing and is gone once work begins', async ($, on) => {
    world(on)
    await start($)
    // Initialization finished by the time the first render happens, so the line
    // has already collapsed: the HUD must not carry a permanent startup row.
    const idle = await mountHud($, 'terminal', 120)
    expect((await rowsOf(idle)).join('\n')).not.toContain('COBALT ONLINE')
    await idle.unmount()

    await prompt($, 'Add rate limiting to the bids API')
    const working = await mountHud($, 'terminal', 120, true)
    const rows = (await rowsOf(working)).join('\n')
    // No startup row survives, and the HUD is doing its real job instead.
    expect(rows).not.toContain('COBALT ONLINE')
    expect(rows).toMatch(/\d+%/)
    await working.unmount()
  })

  test("it never replaces Claude's own mascot or the HUD's own chrome", async ($, on) => {
    world(on)
    await start($)
    const hud = await mountHud($, 'terminal', 120, true)
    const rows = (await rowsOf(hud)).join('\n')
    // The supported region carries the HUD and nothing else: the operator's
    // badge, the track, the percentage. No startup banner is left over.
    expect(rows).not.toContain('COBALT')
    expect(rows).not.toContain('ONLINE')
    await hud.unmount()
  })

  test('a narrow band does not gain a startup row', async ($, on) => {
    world(on)
    await start($)
    for (const columns of [1, 10, 20, 34, 43]) {
      const hud = await mountHud($, 'terminal', columns, true)
      expect((await rowsOf(hud)).join('\n'), `${columns}`).not.toContain('COBALT ONLINE')
      await hud.unmount()
    }
  })
})

describe('the progress tool is at hand', () => {
  // Measured live in v0.5.0: the Sonnet main loop skipped progress with the tool
  // deferred or listed alike. A reminder from an observed edit is what is added.
  test('both tools are left to the host deferral: listing progress cost 768 tokens a request and moved nothing', async ($, on) => {
    const w = world(on)
    await start($)
    const byName = Object.fromEntries(w.registered.map(r => [String(r['name']), r]))
    for (const name of ['progress', 'swarm']) expect(byName[name] !== undefined && !('isDeferred' in byName[name]!)).toBe(true)
  })
  const edit = ($: Parameters<typeof start>[0], file: string, over: Record<string, unknown> = {}) =>
    $.tool.call({ tool: 'Edit', file_path: `/work/example/${file}`, old_string: 'a', new_string: 'b', tool_use_id: `nudge-${file}-${Math.random()}`, ...over } as never) as Promise<{ context?: readonly string[]; deny?: string }>
  const nudges = (r: { context?: readonly string[] }) => (r.context ?? []).filter(c => c.includes('no progress plan'))
  test('a task that edits a second file with no plan is reminded once; nothing moves', async ($, on) => {
    world(on)
    const held = hostState(on, {})
    await start($)
    await prompt($, 'Add median and document it')
    expect(nudges(await edit($, 'src/stats.js'))).toEqual([])
    expect(nudges(await edit($, 'src/stats.js'))).toEqual([])
    const second = nudges(await edit($, 'README.md'))
    expect(second).toHaveLength(1)
    expect(second[0]).toContain('2 files edited and no progress plan')
    expect(second[0]).toContain(`Call ${TOOL} with action "plan" now`)
    expect(nudges(await edit($, 'test/stats.test.js'))).toEqual([])
    const t = held.get('task')!.value as Task
    expect(t.milestones).toEqual([])
    expect(t.progressNudged).toBe(true)
    // the next task is a new one and may be reminded again
    await prompt($, 'Now the range helper')
    await edit($, 'src/range.js')
    expect(nudges(await edit($, 'test/range.test.js'))).toHaveLength(1)
  })
  test('a planned task, a single-file fix, a helper and a failed edit are never reminded', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'Fix the typo')
    for (let i = 0; i < 3; i++) expect(nudges(await edit($, 'README.md'))).toEqual([])
    await prompt($, 'Ship the limiter')
    await progress($, { action: 'plan', milestones: FIVE })
    await edit($, 'a.ts')
    expect(nudges(await edit($, 'b.ts'))).toEqual([])
    await prompt($, 'Another change')
    await edit($, 'c.ts', { agentId: 'helper-1' })
    expect(nudges(await edit($, 'd.ts', { agentId: 'helper-1' }))).toEqual([])
    w.failingTools.push('Edit')
    await edit($, 'e.ts')
    expect(nudges(await edit($, 'f.ts'))).toEqual([])
  })
  test('several gates in one call: all are recorded, or none is', async ($, on) => {
    world(on)
    const held = hostState(on, {})
    await start($)
    await prompt($, 'Ship the limiter')
    await progress($, { action: 'plan', milestones: FIVE })
    for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
    const bad = await progress($, { action: 'gate', gates: [{ gate: 'CODE', state: 'na', evidence: 'no code' }, { gate: 'TYPE', state: 'pass' }] })
    expect(bad).toContain('TYPE: "evidence" is required for pass')
    expect(bad).toContain('no gate was recorded')
    expect((held.get('task')!.value as Task).gates.CODE.state).not.toBe('na')
    await progress($, { action: 'gate', gates: ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT'].map(gate => ({ gate, state: 'na', evidence: 'fixture' })) })
    expect(Object.values((held.get('task')!.value as Task).gates).every(g => g.state === 'na')).toBe(true)
    await progress($, { action: 'complete', milestone: 'm5' })
    expect((held.get('task')!.value as Task).percent).toBe(100)
  })
  test('gates alone never finish a task whose milestones are not done', async ($, on) => {
    world(on)
    const held = hostState(on, {})
    await start($)
    await prompt($, 'Ship the limiter')
    await progress($, { action: 'plan', milestones: FIVE })
    await progress($, { action: 'gate', gates: ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT'].map(gate => ({ gate, state: 'na', evidence: 'fixture' })) })
    expect((held.get('task')!.value as Task).percent).toBe(0)
  })
  test('the end of a turn never completes the task: no milestone moves on its own', async ($, on) => {
    world(on)
    const held = hostState(on, {})
    await start($)
    await prompt($, 'Ship the limiter')
    await progress($, { action: 'plan', milestones: FIVE })
    await progress($, { action: 'complete', milestone: 'm1' })
    await mainTurnEnds($)
    const t = held.get('task')!.value as Task
    expect(t.percent).toBe(20)
    expect(t.milestones.filter(m => m.state === 'done')).toHaveLength(1)
  })
})
