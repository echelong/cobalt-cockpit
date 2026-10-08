// The orchestration rules on their own: roles, the default model, the limit,
// the failure streak and the reviewer's grounds, and the rows they draw. Pure.

import { describe, expect, test } from 'claude-code/testing'

import { newTask } from '../hooks/model'
import {
  DEFAULT_LIMIT,
  EMPTY_ORCHESTRA,
  REVIEW_AFTER,
  admitSpawn,
  groupLabel,
  hasRole,
  headerText,
  isSubstantial,
  limitOf,
  mainLabel,
  mainWord,
  modelFor,
  noteOutcome,
  orchestraRows,
  orchestrationText,
  reviewAdmitted,
  reviewHint,
  reviewVerdict,
  roleOf,
  roleStrip,
  tierOf,
} from '../hooks/orchestra'
import type { OrchestraView } from '../hooks/orchestra'
import { cellsOf } from '../hooks/pixels'
import type { Row } from '../hooks/view'
import type { Activity, AgentStrip, Meter, Task } from '../types'

const COLORS = { accent: '#E01E41', ok: 'success', bad: 'error', steel: '#646A7E' }
const METER: Meter = { percent: 39, tokens: 78_000, window: 200_000, model: 'claude-opus-5-5', effort: 'high' }
const IDLE: Activity = { kind: 'IDLE', detail: '', isWorking: false, toolUseId: null, agents: [], at: 0 }
const textOf = (rows: Row[]): string[] => rows.map(row => row.map(one => one.text).join(''))

const strip = (over: Partial<AgentStrip> = {}): AgentStrip => ({
  id: 'a1',
  title: 'Implement the limiter',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  tool: 'Edit',
  state: 'running',
  startedAt: 0,
  endedAt: null,
  role: 'WORKER',
  seq: 1,
  kind: 'EDIT',
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({ ...newTask(1, 'Add rate limiting', 0, null), kind: 'coding', ...over })
const milestones = (count: number): Task['milestones'] =>
  Array.from({ length: count }, (_, at) => ({ id: `m${at + 1}`, title: `step ${at + 1}`, phase: 'IMPLEMENT' as const, state: 'pending' as const, note: null }))

const view = (over: Partial<OrchestraView> = {}): OrchestraView => ({ meter: METER, task: null, activity: IDLE, isWorking: false, agents: [], nwho: null, limit: 3, now: 32_000, ...over })

describe('roles and models, from what the engine spawned', () => {
  test('the four Cockpit agent types are the four roles', () => {
    expect(roleOf('cobalt-cockpit:worker')).toBe('WORKER')
    expect(roleOf('cobalt-cockpit:explorer')).toBe('EXPLORER')
    expect(roleOf('cobalt-cockpit:researcher')).toBe('RESEARCHER')
    expect(roleOf('cobalt-cockpit:reviewer')).toBe('REVIEWER')
  })

  test('built-ins that do the same job read as that job; anything else is an agent', () => {
    expect(roleOf('Explore')).toBe('EXPLORER')
    expect(roleOf('claude-code-guide')).toBe('RESEARCHER')
    expect(roleOf('code-reviewer')).toBe('REVIEWER')
    expect(roleOf('general-purpose')).toBe('AGENT')
    expect(roleOf('Plan')).toBe('AGENT')
    expect(roleOf('fork')).toBe('AGENT')
  })

  test('a model family is named only for an id that carries it', () => {
    expect(tierOf('claude-opus-5-5')).toBe('OPUS')
    expect(tierOf('claude-sonnet-5-5')).toBe('SONNET')
    expect(tierOf('sonnet')).toBe('SONNET')
    expect(tierOf('claude-haiku-4-5-20251001')).toBe('HAIKU')
    expect(tierOf(null)).toBeNull()
    expect(tierOf('some-other-model')).toBeNull()
    // Fable is never given a name to draw
    expect(tierOf('claude-fable-5-1')).toBeNull()
  })

  test('a spawn that names no model runs on Sonnet; a named one is kept', () => {
    expect(modelFor({ fork: false })).toBe('sonnet')
    expect(modelFor({ model: undefined, fork: false })).toBe('sonnet')
    expect(modelFor({ model: '', fork: false })).toBe('sonnet')
    expect(modelFor({ model: 'inherit', fork: false })).toBe('sonnet')
    expect(modelFor({ model: 'opus', fork: false })).toBe('opus')
    expect(modelFor({ model: 'haiku', fork: false })).toBe('haiku')
    expect(modelFor({ model: 'claude-sonnet-5-5', fork: false })).toBe('claude-sonnet-5-5')
    // a fork runs on its parent's model whatever is said: nothing is chosen for it
    expect(modelFor({ fork: true })).toBeUndefined()
  })
})

describe('the subagent limit', () => {
  test('resource budget defaults beyond three and preserves explicit limits', () => {
    expect(DEFAULT_LIMIT).toBe(16)
    expect(limitOf(undefined)).toBe(16)
    expect(limitOf('5')).toBe(16)
    expect(limitOf(Number.NaN)).toBe(16)
    expect(limitOf(2)).toBe(2)
    expect(limitOf(2.9)).toBe(2)
    expect(limitOf(0)).toBe(16)
    expect(limitOf(-4)).toBe(1)
    expect(limitOf(99)).toBe(99)
    expect(limitOf(999)).toBe(128)
  })

  test('one more may start below the limit and not at it', () => {
    expect(admitSpawn(0, 3)).toBeNull()
    expect(admitSpawn(2, 3)).toBeNull()
    expect(admitSpawn(3, 3)).toContain('SUBAGENT LIMIT / 3')
    expect(admitSpawn(7, 3)).toContain('nothing was started')
    expect(admitSpawn(1, 1)).toContain('1 subagent is already running')
  })
})

describe('the failure streak', () => {
  test('one failure is not a repeated error', () => {
    const once = noteOutcome(EMPTY_ORCHESTRA, 'TEST', true, 100)
    expect(once).toMatchObject({ errorKey: 'TEST', errorStreak: 1, streakAt: 100, reviewArmed: false })
    expect(reviewHint(once, null)).toBeNull()
  })

  test('the same failure again is, and arms one reviewer', () => {
    const twice = noteOutcome(noteOutcome(EMPTY_ORCHESTRA, 'TEST', true, 100), 'TEST', true, 200)
    expect(twice).toMatchObject({ errorKey: 'TEST', errorStreak: REVIEW_AFTER, streakAt: 100, reviewArmed: true })
    const hint = reviewHint(twice, null)
    expect(hint).toContain('repeated 2 times (TEST)')
    expect(hint).toContain('Recover normally first')
    expect(hint).toContain('cobalt-cockpit:reviewer')
    expect(hint).not.toContain('local router')
  })

  test('the local router\'s decision is passed on only when one really arrived', () => {
    const twice = noteOutcome(noteOutcome(EMPTY_ORCHESTRA, 'TEST', true, 100), 'TEST', true, 200)
    expect(reviewHint(twice, 'STOP')).toContain('reads STOP')
    expect(reviewHint(twice, 'RETRY')).toContain('reads RETRY')
  })

  test('the note is given once per streak, however long it runs', () => {
    let o = noteOutcome(noteOutcome(EMPTY_ORCHESTRA, 'TEST', true, 100), 'TEST', true, 200)
    o = { ...o, hinted: true }
    for (let n = 0; n < 5; n++) {
      o = noteOutcome(o, 'TEST', true, 300 + n)
      expect(reviewHint(o, null)).toBeNull()
    }
    expect(o.errorStreak).toBe(7)
  })

  test('a different failure starts over; two different errors are not one repeated error', () => {
    const other = noteOutcome(noteOutcome(EMPTY_ORCHESTRA, 'TEST', true, 100), 'TYPE', true, 200)
    expect(other).toMatchObject({ errorKey: 'TYPE', errorStreak: 1, streakAt: 200, reviewArmed: false, hinted: false })
  })

  test('the same thing succeeding ends the streak and disarms the reviewer', () => {
    const twice = noteOutcome(noteOutcome(EMPTY_ORCHESTRA, 'TEST', true, 100), 'TEST', true, 200)
    expect(noteOutcome(twice, 'TEST', false, 300)).toMatchObject({ errorKey: null, errorStreak: 0, streakAt: null, reviewArmed: false, hinted: false })
  })

  test('an unrelated success changes nothing, and is the same object', () => {
    const once = noteOutcome(EMPTY_ORCHESTRA, 'TEST', true, 100)
    expect(noteOutcome(once, 'Read', false, 150)).toBe(once)
    expect(noteOutcome(EMPTY_ORCHESTRA, 'Read', false, 150)).toBe(EMPTY_ORCHESTRA)
  })
})

describe('the reviewer\'s grounds', () => {
  const none = { task: task({ lastPrompt: 'Add rate limiting to the bids API' }), reviewerRunning: false }

  test('with no ground, no reviewer', () => {
    const verdict = reviewVerdict(EMPTY_ORCHESTRA, none)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('REVIEWER / HELD')
    expect(reviewVerdict(EMPTY_ORCHESTRA, { task: null, reviewerRunning: false }).ok).toBe(false)
  })

  test('a repeated failure admits one, and the ground is then spent', () => {
    const armed = noteOutcome(noteOutcome(EMPTY_ORCHESTRA, 'TEST', true, 1), 'TEST', true, 2)
    expect(reviewVerdict(armed, none)).toEqual({ ok: true, why: 'repeated-error' })
    const spent = reviewAdmitted(armed, 'repeated-error', 1)
    expect(spent).toMatchObject({ reviewers: 1, reviewArmed: false })
    expect(reviewVerdict({ ...spent, hinted: true }, none).ok).toBe(false)
  })

  test('never two at once, whatever the ground', () => {
    const armed = noteOutcome(noteOutcome(EMPTY_ORCHESTRA, 'TEST', true, 1), 'TEST', true, 2)
    const verdict = reviewVerdict(armed, { ...none, reviewerRunning: true })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('already running')
  })

  test('the person asking for a review is a ground', () => {
    expect(reviewVerdict(EMPTY_ORCHESTRA, { task: task({ lastPrompt: 'Please review the auth changes' }), reviewerRunning: false })).toEqual({ ok: true, why: 'asked' })
    expect(reviewVerdict(EMPTY_ORCHESTRA, { task: task({ lastPrompt: 'get a second opinion on this' }), reviewerRunning: false })).toEqual({ ok: true, why: 'asked' })
    // a word that merely contains it is not a request
    expect(reviewVerdict(EMPTY_ORCHESTRA, { task: task({ lastPrompt: 'add a preview pane' }), reviewerRunning: false }).ok).toBe(false)
  })

  test('a substantial task gets one final review, and one only', () => {
    const big = task({ lastPrompt: 'Rework the bidding engine', milestones: milestones(5) })
    expect(isSubstantial(big)).toBe(true)
    expect(reviewVerdict(EMPTY_ORCHESTRA, { task: big, reviewerRunning: false })).toEqual({ ok: true, why: 'substantial' })
    const spent = reviewAdmitted(EMPTY_ORCHESTRA, 'substantial', big.id)
    expect(spent.reviewedTask).toBe(big.id)
    expect(reviewVerdict(spent, { task: big, reviewerRunning: false }).ok).toBe(false)
    // the next substantial task is a new ground
    expect(reviewVerdict(spent, { task: { ...big, id: big.id + 1 }, reviewerRunning: false }).ok).toBe(true)
  })

  test('small, read-only and unplanned work is not substantial', () => {
    expect(isSubstantial(null)).toBe(false)
    expect(isSubstantial(task({ milestones: milestones(3) }))).toBe(false)
    expect(isSubstantial(task({ kind: 'readonly', milestones: milestones(6) }))).toBe(false)
    expect(isSubstantial(task({ files: Array.from({ length: 5 }, (_, at) => ({ path: `src/${at}.ts`, added: 1, removed: 0 })) }))).toBe(true)
  })
})

describe('a subagent\'s row', () => {
  test('number, role, model, activity and elapsed time', () => {
    expect(roleStrip(strip() as never, 100, 32_000)).toBe('01 WORKER      SONNET · MEDIUM EDIT        32s')
    expect(roleStrip(strip({ seq: 2, role: 'EXPLORER', kind: 'READ', tool: 'Read' }) as never, 60, 18_000)).toBe('02 EXPLORER    READ        18s')
  })

  test('a finished one keeps its outcome and its time', () => {
    const done = roleStrip(strip({ seq: 3, role: 'RESEARCHER', state: 'done', tool: 'Done', endedAt: 41_000 }) as never, 60, 99_000)
    expect(done).toBe('03 RESEARCHER  Done        ✓ 41s')
    expect(roleStrip(strip({ state: 'error', tool: 'Failed', endedAt: 5_000 }) as never, 60, 99_000)).toContain('Failed      ✗ 5s')
  })

  test('before its first tool call it is starting, not doing something invented', () => {
    const fresh = strip({ kind: undefined, tool: 'Starting' })
    delete (fresh as { kind?: unknown }).kind
    expect(roleStrip(fresh as never, 60, 1_000)).toContain('START')
  })

  test('it never outgrows the width it is given', () => {
    for (let width = 1; width <= 140; width++) {
      for (const one of [strip(), strip({ role: 'RESEARCHER', seq: 12, state: 'done', tool: 'Done', endedAt: 4_000_000 }), strip({ state: 'waiting', tool: 'Needs approval' })]) {
        expect(cellsOf(roleStrip(one as never, width, 32_000))).toBeLessThanOrEqual(width)
      }
    }
  })

  test('a strip held from before roles existed is not one of these', () => {
    const { role: _role, seq: _seq, kind: _kind, ...old } = strip()
    expect(hasRole(old)).toBe(false)
    expect(hasRole(strip())).toBe(true)
  })

  test('the group is named for the models really in it', () => {
    expect(groupLabel([strip(), strip({ id: 'b' })])).toBe('SONNET / SUBAGENTS')
    expect(groupLabel([strip(), strip({ id: 'b', model: 'claude-haiku-4-5' })])).toBe('SONNET+HAIKU / SUBAGENTS')
    expect(groupLabel([strip({ model: null })])).toBe('SUBAGENTS')
    expect(groupLabel([])).toBe('SUBAGENTS')
  })
})

describe('the orchestration rows', () => {
  test('with nothing delegated there is only main', () => {
    const rows = textOf(orchestraRows(view({ isWorking: true, activity: { ...IDLE, kind: 'THINK', isWorking: true } }), 80, COLORS))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('OPUS / MAIN')
    expect(rows[0]).toContain('THINK · HIGH')
    expect(rows.join('\n')).not.toContain('SUBAGENTS')
    expect(rows.join('\n')).not.toContain('NWHO')
    expect(rows.join('\n')).not.toContain('BACK TO MAIN')
  })

  test('main shows the task\'s real phase and the engine\'s effort', () => {
    const planning = view({ task: task({ phase: 'PLAN', milestones: milestones(3) }), isWorking: true })
    expect(mainLabel(METER)).toBe('OPUS / MAIN')
    expect(mainWord(planning)).toBe('PLAN · HIGH')
    expect(mainWord(view({ meter: { ...METER, effort: null } }))).toBe('IDLE')
    expect(mainLabel({ ...METER, model: null })).toBe('MODEL / MAIN')
  })

  test('the whole picture, when each part really happened', () => {
    const agents = [
      strip(),
      strip({ id: 'a2', seq: 2, role: 'EXPLORER', kind: 'READ', tool: 'Read', startedAt: 14_000 }),
      strip({ id: 'a3', seq: 3, role: 'RESEARCHER', kind: 'WEB', tool: 'Done', state: 'done', startedAt: 0, endedAt: 20_000 }),
    ]
    const rows = textOf(orchestraRows(view({ task: task({ phase: 'PLAN', milestones: milestones(3) }), isWorking: true, agents, nwho: 'PRUNE · Q4B · 4→2 · 37ms' }), 80, COLORS))
    expect(rows[0]).toMatch(/OPUS \/ MAIN\s+PLAN · HIGH/)
    expect(rows[1]).toMatch(/NWHO \/ LOCAL\s+PRUNE · Q4B · 4→2 · 37ms/)
    expect(rows[2]).toMatch(/SONNET \/ SUBAGENTS\s+2\/3 running/)
    expect(rows[3]).toContain('01 WORKER')
    expect(rows[3]).toContain('EDIT')
    expect(rows[4]).toContain('02 EXPLORER')
    expect(rows[4]).toContain('18s')
    expect(rows[5]).toContain('03 RESEARCHER')
    expect(rows[5]).toContain('✓')
    expect(rows).toHaveLength(6)
  })

  test('back to main only once every subagent has returned and main is working', () => {
    const done = [strip({ state: 'done', tool: 'Done', endedAt: 30_000 })]
    const back = textOf(orchestraRows(view({ task: task({ phase: 'VERIFY', milestones: milestones(3) }), isWorking: true, agents: done }), 80, COLORS))
    expect(back[back.length - 1]).toMatch(/BACK TO MAIN\s+VERIFY · HIGH/)
    expect(textOf(orchestraRows(view({ isWorking: false, agents: done }), 80, COLORS)).join('\n')).not.toContain('BACK TO MAIN')
    expect(textOf(orchestraRows(view({ isWorking: true, agents: [strip()] }), 80, COLORS)).join('\n')).not.toContain('BACK TO MAIN')
  })

  test('the HUD line fits its columns and names the group or the return', () => {
    const live = view({ task: task({ phase: 'IMPLEMENT', milestones: milestones(3) }), isWorking: true, agents: [strip(), strip({ id: 'b', seq: 2 })] })
    expect(headerText(live, 100)).toBe('OPUS / MAIN · IMPLEMENT · HIGH   SONNET / SUBAGENTS 2/3')
    expect(headerText(live, 40)).toBe('SONNET / SUBAGENTS 2/3')
    const back = view({ task: task({ phase: 'VERIFY', milestones: milestones(3) }), isWorking: true, agents: [strip({ state: 'done', tool: 'Done', endedAt: 1 })] })
    expect(headerText(back, 100)).toContain('BACK TO MAIN · VERIFY · HIGH')
    for (let columns = 1; columns <= 160; columns++) expect(cellsOf(headerText(live, columns))).toBeLessThanOrEqual(columns)
  })

  test('nothing the rows draw names Fable', () => {
    const agents = [strip(), strip({ id: 'x', seq: 2, model: 'claude-fable-5-1' })]
    const said = [...textOf(orchestraRows(view({ agents, isWorking: true }), 100, COLORS)), headerText(view({ agents, isWorking: true }), 100)].join('\n')
    expect(said.toLowerCase()).not.toContain('fable')
  })
})

describe('the system prompt section', () => {
  const text = orchestrationText(3)

  test('it states the division of labour, the roles, the limit and the block', () => {
    expect(text).toContain('Opus 5.5 commander, at the reasoning effort the user set')
    expect(text).toContain('cobalt-cockpit:worker, explorer, researcher and reviewer')
    expect(text).toContain('cobalt-cockpit:scout and utility')
    expect(text).toContain('Sonnet at medium effort')
    expect(text).toContain('At most 3 subagents run at once')
    expect(text).toContain('Haiku → Sonnet → Opus')
    expect(text).toContain('MODEL BLOCK / FABLE / POLICY')
    expect(orchestrationText(1)).toContain('At most 1 subagents run at once')
  })

  test('it tells main not to delegate the trivial', () => {
    expect(text).toContain('trivial or tightly coupled')
    expect(text).toContain('Never manufacture subagent work')
    expect(text).toContain('avoid duplicate tasks')
  })
})
