// What the HUD says: git states, the context meter, the waveform, and how
// the rows give ground as the terminal narrows.

import { describe, expect, test } from 'claude-code/testing'

import { gateOfCommand, readBash } from '../hooks/classify'
import { aheadBehindLabel, branchLabel, dirtyLabel, parseStatus, shaLabel } from '../hooks/git'
import { applyAction, GATES, isGuardRequired, newTask, setGate, setGuardRequired, settle, uidOf } from '../hooks/model'
import { completionEvidenceOf } from '../hooks/verification'
import { hudRows, paneRows, rowText, statusWord, waveCells, waveLevels, waveText } from '../hooks/view'
import type { HudInput } from '../hooks/view'
import type { Activity, Gate, GateName, GitState, Meter, Task } from '../types'

const IDLE: Activity = { kind: 'IDLE', detail: '', isWorking: false, toolUseId: null, agents: [], at: 0 }
const METER: Meter = { percent: 39, tokens: 78_000, window: 200_000, model: 'claude-opus-5-5', effort: 'high' }

const repo = (over: Partial<GitState> = {}): GitState => ({
  isRepo: true,
  project: 'example',
  branch: 'main',
  isDetached: false,
  sha: 'e4f5a6b7c8d9',
  startSha: 'a1b2c3d4e5f6',
  dirty: 3,
  ahead: 1,
  behind: 0,
  at: 0,
  ...over,
})

const taskAt = (done: number): Task => {
  let task = applyAction(
    newTask(1, 'Add rate limiting', 0, 'a1b2c3d4e5f6'),
    { action: 'plan', milestones: ['Inspect', 'Implement', 'Test', 'Fix', 'Verify'].map(title => ({ title })) },
    0,
    null,
  ).task
  for (let n = 1; n <= done; n++) task = applyAction(task, { action: 'complete', milestone: `m${n}` }, 0, null).task
  for (const gate of ['CODE', 'TEST', 'TYPE'] as const) task = setGate(task, gate, 'pass', 'checked', 'model', 0)
  task = setGate(task, 'BUILD', 'pending', 'npm run build | tail', 'auto', 0)
  task = setGate(task, 'GIT', 'pass', 'git status clean', 'model', 0)

  return settle(task).task
}

const input = (over: Partial<HudInput> = {}): HudInput => ({
  task: taskAt(4),
  activity: IDLE,
  git: repo(),
  meter: METER,
  isWorking: false,
  ...over,
})

const lines = (given: HudInput, columns: number, maxRows = 3): string[] => hudRows(given, columns, maxRows).map(rowText)
const widest = (rows: string[]): number => Math.max(...rows.map(row => [...row].length))

describe('git display', () => {
  test('reads branch, HEAD, dirty count and ahead/behind from porcelain v2', () => {
    const read = parseStatus(
      [
        '# branch.oid e4f5a6b7c8d9e0f1',
        '# branch.head feature/limits',
        '# branch.upstream origin/feature/limits',
        '# branch.ab +2 -5',
        '1 .M N... 100644 100644 100644 abc def src/api.ts',
        '1 M. N... 100644 100644 100644 abc def src/limiter.ts',
        '2 R. N... 100644 100644 100644 abc def R100 new.ts\told.ts',
        'u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts',
        '? notes.md',
        '! ignored.log',
        '',
      ].join('\n'),
    )
    expect(read).toEqual({ branch: 'feature/limits', isDetached: false, sha: 'e4f5a6b7c8d9e0f1', dirty: 5, ahead: 2, behind: 5 })
  })

  test('a detached HEAD, a branch with no upstream, and a repository with no commits', () => {
    expect(parseStatus('# branch.oid abc1234\n# branch.head (detached)\n')).toMatchObject({ isDetached: true, branch: null, ahead: null })
    expect(parseStatus('# branch.oid abc1234\n# branch.head topic\n')).toMatchObject({ branch: 'topic', ahead: null, behind: null })
    expect(parseStatus('# branch.oid (initial)\n# branch.head main\n')).toMatchObject({ sha: null, branch: 'main' })
  })

  test('labels: clean, dirty, no repository', () => {
    expect(dirtyLabel(repo({ dirty: 0 }))).toBe('clean')
    expect(dirtyLabel(repo({ dirty: 3 }))).toBe('3 changed')
    expect(dirtyLabel(repo({ isRepo: false }))).toBe('no repo')
    expect(branchLabel(repo({ isDetached: true, branch: null }))).toBe('detached')
    expect(branchLabel(repo({ isRepo: false }))).toBe('')
  })

  test('labels: ahead and behind, shown only when there is something to say', () => {
    expect(aheadBehindLabel(repo({ ahead: 1, behind: 0 }))).toBe('↑1')
    expect(aheadBehindLabel(repo({ ahead: 2, behind: 5 }))).toBe('↑2 ↓5')
    expect(aheadBehindLabel(repo({ ahead: 0, behind: 0 }))).toBe('')
    expect(aheadBehindLabel(repo({ ahead: null, behind: null }))).toBe('')
  })

  test('labels: start and current HEAD', () => {
    expect(shaLabel('a1b2c3d4e5f6', 'e4f5a6b7c8d9')).toBe('a1b2c3d→e4f5a6b')
    expect(shaLabel('a1b2c3d4e5f6', 'a1b2c3d4e5f6')).toBe('a1b2c3d')
    expect(shaLabel(null, null)).toBe('')
  })

  test('the HUD carries project, branch, both SHAs, dirty count and ahead/behind', () => {
    const [top] = lines(input(), 120)
    expect(top).toBe('· STATE / IDLE   VECTOR   REPO / EXAMPLE · main · a1b2c3d→e4f5a6b · 3 changed · ↑1')
  })

  test('outside a repository it says so and draws no branch', () => {
    const [top] = lines(input({ git: repo({ isRepo: false, project: 'scratch', branch: null, sha: null, startSha: null, dirty: 0, ahead: null, behind: null }), task: null }), 120)
    expect(top).toBe('· STATE / IDLE   VECTOR   REPO / SCRATCH · no repo')
  })
})

describe('the wide HUD', () => {
  test('matches the three-row layout', () => {
    expect(lines(input(), 120)).toEqual([
      '· STATE / IDLE   VECTOR   REPO / EXAMPLE · main · a1b2c3d→e4f5a6b · 3 changed · ↑1',
      'VERIFY     ████████████████░░░░ 80%  ▁▁▁▁▁▁▁  UNVERIFIED',
      'CODE ✓  TEST ✓  TYPE ✓  BUILD ◌  SECURITY ·  GIT ✓   CTX ███░░░░░ 39%  opus-5-5 · high',
    ])
  })

  test('the operator leads the row and the state is named in the panel grammar', () => {
    const working = input({ task: taskAt(2), isWorking: true, activity: { ...IDLE, kind: 'TEST', detail: 'npm test', isWorking: true } })
    expect(lines(working, 120)[0]).toContain('● STATE / ACTIVE   VECTOR')
  })

  test('a turn running with no tool inside it is scanning, in cyan', () => {
    const thinking = input({ task: taskAt(2), isWorking: true, activity: { ...IDLE, kind: 'THINK', isWorking: true } })
    expect(lines(thinking, 120)[0]).toContain('▒ STATE / SCAN')
  })

  test('while working it names the activity', () => {
    const working = input({ task: taskAt(2), isWorking: true, activity: { ...IDLE, kind: 'TEST', detail: 'npm test', isWorking: true } })
    expect(lines(working, 120)[1]).toBe('TEST       ████████░░░░░░░░░░░░ 40%  ▁▁▁▁▁▁▁  TEST npm test')
  })

  test('subagents are counted beside the task, not in it', () => {
    const withAgents = input({ task: taskAt(2), isWorking: true, activity: { ...IDLE, kind: 'AGENT', detail: '', isWorking: true, agents: ['a1', 'a2'] } })
    expect(statusWord(withAgents)).toBe('AGENT +2 agents')
    expect(withAgents.task?.percent).toBe(40)
  })

  test('a turn that ended leaves an unfinished task PAUSED, never DONE', () => {
    expect(statusWord(input({ task: taskAt(2) }))).toBe('PAUSED')
  })

  test('with no milestones it draws no percentage', () => {
    const [, middle] = lines(input({ task: settle(newTask(1, 'What is this?', 0, null)).task }), 120)
    expect(middle).toContain('--%')
    expect(middle).toContain('░'.repeat(20))
    expect(middle).not.toContain('█')
  })
})

// A finished task's word carries the evidence its DONE rests on, but only at rest: while a turn runs it names what the turn is
// doing, for every evidence state. Blocked and unverified tasks keep their word in front of the live activity.
describe('the status word of a finished task', () => {
  const live = (kind: Activity['kind'], detail = '', agents: string[] = []): Partial<HudInput> => ({ isWorking: true, activity: { ...IDLE, kind, detail, isWorking: true, agents } })
  const allGates = (source: Gate['source'], evidence: string | null): Record<GateName, Gate> =>
    Object.fromEntries(GATES.map(name => [name, { state: 'pass', isRequired: true, evidence, source, at: 10 } satisfies Gate])) as Record<GateName, Gate>
  // a LIGHT goal, so no goal check stands between the milestones and DONE
  const finishedWith = (gates: Record<GateName, Gate>, guard?: 'unchanged'): Task => {
    const planned = applyAction(newTask(1, 'goal', 0, null), { action: 'plan', milestones: ['Inspect', 'Implement', 'Verify'].map(title => ({ title })) }, 0, null).task
    const t = { ...planned, milestones: planned.milestones.map(one => ({ ...one, state: 'done' as const })), gates }
    return settle(guard === undefined ? t : { ...t, guardDone: { uid: uidOf(t), tree: 'h:1@project', check: 'check.sh@10', outcome: guard, at: 11 } }).task
  }
  const withGuard = <T>(on: boolean, f: () => T): T => {
    const before = isGuardRequired()
    setGuardRequired(on)
    try { return f() } finally { setGuardRequired(before) }
  }
  // Each case is a DONE task and the Stop-guard setting under which its evidence reads as the named state.
  const cases: { state: string; guard: boolean; task: () => Task }[] = [
    { state: 'SELF_REPORTED_UNCHECKED', guard: false, task: () => finishedWith(allGates('model', 'checked')) },
    { state: 'PROVISIONAL_CHECKED', guard: false, task: () => finishedWith(allGates('auto', 'npm test (exit 0)')) },
    { state: 'PROVENANCE_UNKNOWN', guard: false, task: () => finishedWith(allGates('auto', null)) },
    { state: 'UNCHANGED_UNCHECKED', guard: true, task: () => finishedWith(allGates('model', 'checked'), 'unchanged') },
    // settled DONE with the guard off, then read with the guard required and no guard record
    { state: 'UNKNOWN_INVALIDATED', guard: true, task: () => withGuard(false, () => finishedWith(allGates('model', 'checked'))) },
  ]

  for (const c of cases) {
    test(`${c.state}: at rest the word is DONE with its evidence; in a live turn it is the activity alone`, () => {
      withGuard(c.guard, () => {
        const task = c.task()
        expect(task.status).toBe('done')
        expect(completionEvidenceOf(task, c.guard).state).toBe(c.state)
        expect(statusWord(input({ task }))).toBe(`DONE · ${c.state}`)
        expect(statusWord(input({ task, activity: { ...IDLE, agents: ['a1'] } }))).toBe(`DONE · ${c.state} +1 agent`)
        expect(statusWord(input({ task, ...live('THINK') }))).toBe('THINK')
        expect(statusWord(input({ task, ...live('IDLE') }))).toBe('THINK')
        expect(statusWord(input({ task, ...live('TEST', 'npm test') }))).toBe('TEST npm test')
        expect(statusWord(input({ task, ...live('EDIT', 'src/limiter.ts') }))).toBe('EDIT src/limiter.ts')
        expect(statusWord(input({ task, ...live('AGENT', '', ['a1', 'a2']) }))).toBe('AGENT +2 agents')
        for (const word of [statusWord(input({ task })), statusWord(input({ task, ...live('THINK') }))]) {
          expect(word).not.toContain('SECURITY_ATTESTED')
          expect(word).not.toMatch(/\bVERIFIED\b/)
        }
      })
    })
  }

  test('an unverified task keeps its word in front of the live activity', () => {
    withGuard(false, () => {
      const task = taskAt(5)
      expect(task.status).toBe('unverified')
      expect(statusWord(input({ task }))).toBe('UNVERIFIED')
      expect(statusWord(input({ task, ...live('THINK') }))).toBe('UNVERIFIED · THINK')
      expect(statusWord(input({ task, ...live('BUILD', 'npm run build') }))).toBe('UNVERIFIED · BUILD npm run build')
      expect(statusWord(input({ task, ...live('AGENT', '', ['a1']) }))).toBe('UNVERIFIED · AGENT +1 agent')
    })
  })

  test('a blocked task keeps its word in front of the live activity', () => {
    const task = settle(applyAction(taskAt(2), { action: 'block', milestone: 'm3', note: 'waiting on credentials' }, 0, null).task).task
    expect(task.status).toBe('blocked')
    expect(statusWord(input({ task }))).toBe('BLOCKED')
    expect(statusWord(input({ task, ...live('THINK') }))).toBe('BLOCKED · THINK')
    expect(statusWord(input({ task, ...live('READ', 'src/api.ts', ['a1', 'a2', 'a3']) }))).toBe('BLOCKED · READ src/api.ts +3 agents')
  })
})

describe('context meter', () => {
  test('shows the percentage session.usage reports', () => {
    expect(lines(input(), 120)[2]).toContain('CTX ███░░░░░ 39%')
    expect(lines(input({ meter: { ...METER, percent: 100 } }), 120)[2]).toContain('CTX ████████ 100%')
    expect(lines(input({ meter: { ...METER, percent: 0 } }), 120)[2]).toContain('CTX ░░░░░░░░ 0%')
  })

  test('before the first response there is no reading, and none is invented', () => {
    expect(lines(input({ meter: { ...METER, percent: null, tokens: null } }), 120)[2]).toContain('CTX --')
  })

  test('colors by fill: plain, then warning from 70%, then error from 85%', () => {
    const colorAt = (percent: number) =>
      hudRows(input({ meter: { ...METER, percent } }), 120)[2]?.find(segment => segment.text === `${percent}%`)?.color
    expect(colorAt(39)).toBeUndefined()
    expect(colorAt(72)).toBe('warning')
    expect(colorAt(91)).toBe('error')
  })

  test('is its own figure, apart from task progress', () => {
    const rows = lines(input({ task: taskAt(1), meter: { ...METER, percent: 88 } }), 120)
    expect(rows[1]).toContain('20%')
    expect(rows[2]).toContain('88%')
  })
})

describe('narrow terminals', () => {
  test('no row is ever wider than the columns it is given', () => {
    const cases = [input(), input({ isWorking: true, activity: { ...IDLE, kind: 'BASH', detail: 'x'.repeat(40), isWorking: true, agents: ['a'] } }), input({ task: null, git: null })]
    for (const given of cases) {
      for (let columns = 1; columns <= 160; columns++) {
        const rows = lines(given, columns)
        expect(widest(rows), `at ${columns} columns: ${JSON.stringify(rows)}`).toBeLessThanOrEqual(columns)
      }
    }
  })

  test('from 72 to 95 columns the SHAs and the model give way', () => {
    expect(lines(input(), 80)).toEqual([
      '· STATE / IDLE   VECTOR   REPO / EXAMPLE · main · 3 changed · ↑1',
      'VERIFY     ███████████░░░ 80%  ▁▁▁▁▁▁▁  UNVERIFIED',
      'CODE ✓  TEST ✓  TYPE ✓  BUILD ◌  SECURITY ·  GIT ✓   CTX 39%',
    ])
  })

  test('from 60 columns the gates shorten to letters', () => {
    expect(lines(input(), 64)[2]).toBe('C✓ T✓ Y✓ B◌ S· G✓   CTX 39%')
  })

  test('the gate letters and their glyphs survive every width from 1 up', () => {
    expect(lines(input(), 60)[2]).toContain('C✓ T✓ Y✓ B◌ S· G✓')
  })

  test('under 60 columns it is two rows', () => {
    expect(lines(input(), 50)).toEqual(['REPO / EXAMPLE · main · ±3 · ↑1', '· VRFY ████████░░ 80% ✓✓✓◌·✓ CTX 39%'])
  })

  test('under 34 columns it is one row', () => {
    expect(lines(input(), 30)).toEqual(['· VRFY 80% ✓✓✓◌·✓ C39%'])
  })

  test('it never takes more rows than the band may', () => {
    expect(lines(input(), 120, 2)).toHaveLength(2)
    expect(lines(input(), 120, 1)).toHaveLength(1)
  })

  test('the pane fits its body too', () => {
    for (const columns of [20, 34, 60, 100]) {
      const rows = paneRows(input(), columns, 60_000).map(rowText)
      expect(widest(rows), `at ${columns}: ${JSON.stringify(rows)}`).toBeLessThanOrEqual(columns)
    }
  })
})

describe('the waveform', () => {
  test('draws with the eight block glyphs and stays in range', () => {
    for (let frame = 0; frame < 200; frame++) {
      const levels = waveLevels(frame, 7)
      expect(levels).toHaveLength(7)
      expect(Math.min(...levels)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...levels)).toBeLessThanOrEqual(7)
      expect(waveText(frame, 7)).toMatch(/^[▁▂▃▄▅▆▇█]{7}$/)
    }
  })

  test('moves from frame to frame and rests flat when idle', () => {
    expect(waveText(3, 7)).not.toBe(waveText(4, 7))
    expect(waveText(null, 7)).toBe('▁▁▁▁▁▁▁')
  })

  test('is a pure function of the frame: no randomness to flicker', () => {
    expect(waveText(42, 7)).toBe(waveText(42, 7))
  })

  test('packs one glyph, foreground and background per Raster cell', () => {
    const bytes = Uint8Array.from(atob(waveCells(5, 7)), char => char.charCodeAt(0))
    expect(bytes).toHaveLength(7 * 12)
    const view = new DataView(bytes.buffer)
    waveLevels(5, 7).forEach((level, column) => {
      expect(view.getUint32(column * 12, true)).toBe(0x2581 + level)
    })
  })
})

describe('gates read off real commands', () => {
  test('recognizes checks by what they are', () => {
    expect(gateOfCommand(['npm', 'test'])).toBe('TEST')
    expect(gateOfCommand(['pnpm', 'run', 'test:unit'])).toBe('TEST')
    expect(gateOfCommand(['npx', 'vitest', 'run'])).toBe('TEST')
    expect(gateOfCommand(['uv', 'run', 'pytest', '-q'])).toBe('TEST')
    expect(gateOfCommand(['cargo', 'test'])).toBe('TEST')
    expect(gateOfCommand(['npx', 'tsc', '--noEmit'])).toBe('TYPE')
    expect(gateOfCommand(['mypy', 'src'])).toBe('TYPE')
    expect(gateOfCommand(['npm', 'run', 'build'])).toBe('BUILD')
    expect(gateOfCommand(['cargo', 'build', '--release'])).toBe('BUILD')
    expect(gateOfCommand(['npx', 'eslint', '.'])).toBe('CODE')
    expect(gateOfCommand(['ruff', 'check', '.'])).toBe('CODE')
    expect(gateOfCommand(['npm', 'audit'])).toBe('SECURITY')
    expect(gateOfCommand(['node', '--test'])).toBe('TEST')
    // looking a tool up is not running it
    expect(gateOfCommand(['command', '-v', 'tsc'])).toBeNull()
    expect(gateOfCommand(['which', 'pytest'])).toBeNull()
    expect(gateOfCommand(['npm', 'install'])).toBeNull()
    expect(gateOfCommand(['vite'])).toBeNull()
    expect(gateOfCommand(['ls', '-la'])).toBeNull()
  })

  test('a clean exit passes the gate and a failure fails it', () => {
    expect(readBash('npm test').read('ok')).toMatchObject([{ gate: 'TEST', state: 'pass' }])
    expect(readBash('cd app && npm test').read('error')).toMatchObject([{ gate: 'TEST', state: 'fail' }])
  })

  test('a masked exit status settles nothing', () => {
    expect(readBash('npm test | tail -20').read('ok')).toMatchObject([{ gate: 'TEST', state: 'pending' }])
    expect(readBash('npm test; echo done').read('ok')).toMatchObject([{ gate: 'TEST', state: 'pending' }])
    expect(readBash('npm test || true').read('ok')).toMatchObject([{ gate: 'TEST', state: 'pending' }])
    expect(readBash('set -o pipefail; npm test | tee out.log').read('ok')).toMatchObject([{ gate: 'TEST', state: 'pass' }])
  })

  test('a failure that may be another step\'s is not pinned on the check', () => {
    expect(readBash('npm ci && npm test').read('error')).toMatchObject([{ gate: 'TEST', state: 'pending' }])
    expect(readBash('npm test && git push').read('error')).toMatchObject([{ gate: 'TEST', state: 'pending' }])
    expect(readBash('npm ci && npm test').read('ok')).toMatchObject([{ gate: 'TEST', state: 'pass' }])
  })

  test('a background or interrupted run is pending', () => {
    expect(readBash('npm test').read('unknown')).toMatchObject([{ gate: 'TEST', state: 'pending' }])
  })

  test('the activity is named for what runs', () => {
    expect(readBash('npm test').activity).toBe('TEST')
    expect(readBash('git status').activity).toBe('GIT')
    expect(readBash('npm run build').activity).toBe('BUILD')
    expect(readBash('ls -la').activity).toBe('BASH')
  })
})
