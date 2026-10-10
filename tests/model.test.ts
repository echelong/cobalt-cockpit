// The task model: progress is milestones completed, 100% is gated, and a
// failed check takes progress back.

import { describe, expect, test } from 'claude-code/testing'

import { withDiscovery } from '../hooks/discovery'

import {
  applyAction,
  completeMilestone,
  GATES,
  newTask,
  percentOf,
  phaseOfTitle,
  setGate,
  settle,
  startMilestone,
  unsatisfiedGates,
} from '../hooks/model'
import type { Cue } from '../hooks/model'
import type { Task } from '../types'

const FIVE = [{ title: 'Inspect' }, { title: 'Implement' }, { title: 'Test' }, { title: 'Fix' }, { title: 'Verify' }]

/** Applies tool calls in order, settling after each, and collects the cues. */
const drive = (task: Task, calls: Record<string, unknown>[], at = 1000): { task: Task; cues: Cue[]; notes: string[] } => {
  const cues: Cue[] = []
  const notes: string[] = []
  let current = task
  for (const call of calls) {
    const outcome = applyAction(current, call, at, 'abc1234')
    if (outcome.error !== undefined) throw new Error(outcome.error)
    if (outcome.note !== undefined) notes.push(outcome.note)
    const settled = settle(outcome.task)
    cues.push(...settled.cues)
    current = settled.task
  }

  return { task: current, cues, notes }
}

// Pinned LIGHT: these tests are about milestones and gates; the goal check of STANDARD and DEEP work is in discovery.test.ts.
const planned = (): Task => withDiscovery(drive(newTask(1, 'Add rate limiting', 0, 'abc1234'), [{ action: 'plan', milestones: FIVE }]).task, 'LIGHT')

const allGatesPass = GATES.map(gate => ({ action: 'gate', gate, state: 'pass', evidence: `${gate} checked` }))

describe('progress', () => {
  test('is completed milestones over all milestones', () => {
    let { task } = drive(planned(), [])
    expect(task.percent).toBe(0)
    for (const [done, percent] of [[1, 20], [2, 40], [3, 60], [4, 80]] as const) {
      task = drive(task, [{ action: 'complete', milestone: `m${done}` }]).task
      expect(task.percent).toBe(percent)
    }
  })

  test('a task with no milestones claims no progress', () => {
    const task = settle(newTask(1, 'What does this function do?', 0, null)).task
    expect(task.percent).toBe(0)
    expect(task.status).toBe('idle')
  })

  test('rounds down, never up to a milestone not yet reached', () => {
    const three = drive(newTask(1, 'x', 0, null), [
      { action: 'plan', milestones: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] },
      { action: 'complete', milestone: 'm1' },
      { action: 'complete', milestone: 'm2' },
    ]).task
    expect(three.percent).toBe(66)
  })

  test('does not depend on time', () => {
    const early = drive(planned(), [{ action: 'complete', milestone: 'm1' }], 1_000).task
    const late = drive(planned(), [{ action: 'complete', milestone: 'm1' }], 9_000_000).task
    expect(late.percent).toBe(early.percent)
  })
})

describe('milestone transitions', () => {
  test('the phase follows the milestone in hand', () => {
    let { task } = drive(planned(), [{ action: 'start', milestone: 'm1' }])
    expect(task.phase).toBe('RESEARCH')
    task = drive(task, [{ action: 'complete', milestone: 'm1' }, { action: 'start', milestone: 'Implement' }]).task
    expect(task.phase).toBe('IMPLEMENT')
    expect(task.milestones.map(one => one.state)).toEqual(['done', 'active', 'pending', 'pending', 'pending'])
  })

  test('one milestone is active at a time', () => {
    const { task } = drive(planned(), [{ action: 'start', milestone: 'm1' }, { action: 'start', milestone: 'm2' }])
    expect(task.milestones.filter(one => one.state === 'active').map(one => one.id)).toEqual(['m2'])
  })

  test('a failed milestone is not progress and turns the phase to FIX', () => {
    const { task } = drive(planned(), [
      { action: 'complete', milestone: 'm1' },
      { action: 'fail', milestone: 'm2', note: 'the API changed' },
    ])
    expect(task.percent).toBe(20)
    expect(task.phase).toBe('FIX')
    expect(task.failures[0]?.text).toContain('the API changed')
  })

  test('a blocked milestone shows BLOCKED, and unblock resumes it', () => {
    let { task } = drive(planned(), [{ action: 'block', milestone: 'm2', note: 'no database credentials' }])
    expect(task.status).toBe('blocked')
    expect(task.phase).toBe('BLOCKED')
    expect(task.blocker).toBe('no database credentials')
    task = drive(task, [{ action: 'unblock' }]).task
    expect(task.status).toBe('active')
    expect(task.milestones[1]?.state).toBe('active')
  })

  test('an unknown milestone is refused, naming the known ones', () => {
    const outcome = startMilestone(planned(), 'm9', 0)
    expect(outcome.error).toContain('m1 Inspect')
  })

  test('a title implies its phase when the plan names none', () => {
    expect(phaseOfTitle('Inspect the handlers')).toBe('RESEARCH')
    expect(phaseOfTitle('Write tests')).toBe('TEST')
    expect(phaseOfTitle('Fix failing tests')).toBe('FIX')
    expect(phaseOfTitle('Verify final state')).toBe('VERIFY')
    expect(phaseOfTitle('Add the limiter')).toBe('IMPLEMENT')
  })

  test('a new plan never inherits progress from the last task by title', () => {
    const finishedFour = drive(planned(), [1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` }))).task
    const next = drive(finishedFour, [{ action: 'plan', goal: 'A different task', milestones: FIVE }]).task
    expect(next.id).toBe(finishedFour.id + 1)
    expect(next.percent).toBe(0)
    expect(next.milestones.every(one => one.state === 'pending')).toBe(true)
  })

  test('a re-plan keeps the state of the milestones it keeps', () => {
    const two = drive(planned(), [{ action: 'complete', milestone: 'm1' }, { action: 'complete', milestone: 'm2' }]).task
    const refined = drive(two, [
      { action: 'plan', replan: true, milestones: [...FIVE.slice(0, 2), { title: 'Migrate data' }, ...FIVE.slice(2)] },
    ]).task
    expect(refined.id).toBe(two.id)
    expect(refined.milestones.map(one => one.state)).toEqual(['done', 'done', 'pending', 'pending', 'pending', 'pending'])
    expect(refined.percent).toBe(33)
  })
})

describe('100% is gated', () => {
  test('every milestone complete without verification is not done', () => {
    const { task, notes } = drive(planned(), [1, 2, 3, 4, 5].map(n => ({ action: 'complete', milestone: `m${n}` })))
    expect(task.percent).toBe(80)
    expect(task.status).toBe('unverified')
    expect(task.phase).toBe('VERIFY')
    expect(task.milestones[4]?.state).toBe('active')
    expect(notes[0]).toContain('HELD')
    expect(unsatisfiedGates(task)).toEqual([...GATES])
  })

  test('a plan with no verify milestone still stops short of 100 unverified', () => {
    const { task } = drive(newTask(1, 'x', 0, null), [
      { action: 'plan', milestones: [{ title: 'Implement' }, { title: 'Write tests' }] },
      { action: 'complete', milestone: 'm1' },
      { action: 'complete', milestone: 'm2' },
    ])
    expect(task.percent).toBe(99)
    expect(task.status).toBe('unverified')
  })

  test('one unsatisfied gate is enough to withhold it', () => {
    const { task } = drive(planned(), [
      ...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })),
      ...allGatesPass.filter(call => call.gate !== 'SECURITY'),
      { action: 'complete', milestone: 'm5' },
    ])
    expect(task.percent).toBe(80)
    expect(task.status).toBe('unverified')
    expect(unsatisfiedGates(task)).toEqual(['SECURITY'])
  })

  test('reaches 100 and DONE once every gate is pass or explicitly not applicable', () => {
    const { task } = drive(planned(), [
      ...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })),
      ...allGatesPass.filter(call => call.gate !== 'BUILD'),
      { action: 'gate', gate: 'BUILD', state: 'na', evidence: 'interpreted code, no build step' },
      { action: 'complete', milestone: 'm5' },
    ])
    expect(task.percent).toBe(100)
    expect(task.status).toBe('done')
    expect(task.phase).toBe('DONE')
  })

  test('pass and na need evidence', () => {
    expect(applyAction(planned(), { action: 'gate', gate: 'TEST', state: 'pass' }, 0, null).error).toContain('evidence')
    expect(applyAction(planned(), { action: 'gate', gate: 'BUILD', state: 'na' }, 0, null).error).toContain('why')
  })

  test('a pending gate does not satisfy', () => {
    const task = setGate(planned(), 'TEST', 'pending', 'npm test | tail (masked)', 'auto', 0)
    expect(unsatisfiedGates(task)).toContain('TEST')
  })

  test('a read-only task needs no gates', () => {
    const { task } = drive(newTask(1, 'Explain the auth flow', 0, null), [
      { action: 'plan', kind: 'readonly', milestones: [{ title: 'Read the code' }, { title: 'Explain' }] },
      { action: 'complete', milestone: 'm1' },
      { action: 'complete', milestone: 'm2' },
    ])
    expect(task.percent).toBe(100)
    expect(task.status).toBe('done')
  })
})

describe('regression', () => {
  const done = (): Task =>
    drive(planned(), [
      ...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })),
      ...allGatesPass,
      { action: 'complete', milestone: 'm5' },
    ]).task

  test('a test that fails after completion reopens Test, Fix and Verify', () => {
    const before = done()
    expect(before.percent).toBe(100)
    const after = settle(setGate(before, 'TEST', 'fail', 'npm test (failed)', 'auto', 5000)).task
    expect(after.percent).toBe(40)
    expect(after.status).toBe('active')
    expect(after.phase).toBe('FIX')
    expect(after.milestones.map(one => one.state)).toEqual(['done', 'done', 'pending', 'pending', 'pending'])
    expect(after.failures.at(-1)?.text).toContain('TEST failed')
  })

  test('a failing type check reopens Fix and Verify but not Test', () => {
    const after = settle(setGate(done(), 'TYPE', 'fail', 'tsc (failed)', 'auto', 5000)).task
    expect(after.milestones.map(one => one.state)).toEqual(['done', 'done', 'done', 'pending', 'pending'])
    expect(after.percent).toBe(60)
  })

  test('passing again does not restore progress by itself', () => {
    const failed = settle(setGate(done(), 'TEST', 'fail', 'npm test (failed)', 'auto', 5000)).task
    const passing = settle(setGate(failed, 'TEST', 'pass', 'npm test (exit 0)', 'auto', 6000)).task
    expect(passing.percent).toBe(40)
    expect(completeMilestone(passing, 'm3', null, 7000).error).toBeUndefined()
  })
})

describe('cues', () => {
  test('the checkpoint fires at the first crossing of 80% and not again', () => {
    const first = drive(planned(), [1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })))
    expect(first.cues).toEqual(['checkpoint'])
    const more = drive(first.task, [{ action: 'start', milestone: 'm5' }, { action: 'gate', gate: 'CODE', state: 'pass', evidence: 'eslint' }, { action: 'status' }])
    expect(more.cues).toEqual([])
  })

  test('completion fires once, and only at a verified 100%', () => {
    const run = drive(planned(), [
      ...[1, 2, 3, 4, 5].map(n => ({ action: 'complete', milestone: `m${n}` })),
      ...allGatesPass,
      { action: 'complete', milestone: 'm5' },
      { action: 'status' },
      { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'ran again' },
    ])
    expect(run.cues).toEqual(['checkpoint', 'complete'])
  })

  test('a small dip below 80% does not re-arm the checkpoint', () => {
    const ten = Array.from({ length: 10 }, (_, n) => ({ title: `Step ${n + 1}`, phase: n === 9 ? 'VERIFY' : n === 8 ? 'FIX' : 'IMPLEMENT' }))
    const at80 = drive(newTask(1, 'x', 0, null), [
      { action: 'plan', milestones: ten },
      ...[1, 2, 3, 4, 5, 6, 7, 9].map(n => ({ action: 'complete', milestone: `m${n}` })),
    ])
    expect(at80.task.percent).toBe(80)
    expect(at80.cues).toEqual(['checkpoint'])
    // the Fix milestone reopens: 70%, above the re-arm line
    const dipped = settle(setGate(at80.task, 'TYPE', 'fail', 'tsc (failed)', 'auto', 1))
    expect(dipped.task.percent).toBe(70)
    expect(dipped.task.lifecycle).toBe(1)
    const back = drive(dipped.task, [{ action: 'complete', milestone: 'm9' }])
    expect(back.task.percent).toBe(80)
    expect(back.cues).toEqual([])
  })

  test('a fall to 60% or below starts a new lifecycle and re-arms both cues', () => {
    const finished = drive(planned(), [
      ...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })),
      ...allGatesPass,
      { action: 'complete', milestone: 'm5' },
    ])
    expect(finished.cues).toEqual(['checkpoint', 'complete'])
    const broken = settle(setGate(finished.task, 'TEST', 'fail', 'npm test (failed)', 'auto', 1))
    expect(broken.task.percent).toBe(40)
    expect(broken.task.lifecycle).toBe(2)
    expect(broken.cues).toEqual([])
    const again = drive(broken.task, [
      { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'npm test (exit 0)' },
      { action: 'complete', milestone: 'm3' },
      { action: 'complete', milestone: 'm4' },
      { action: 'complete', milestone: 'm5' },
    ])
    expect(again.task.percent).toBe(100)
    expect(again.cues).toEqual(['checkpoint', 'complete'])
  })

  test('a jump straight to 100% plays the completion cue alone', () => {
    const run = drive(newTask(1, 'x', 0, null), [
      { action: 'plan', kind: 'readonly', milestones: [{ title: 'Answer' }] },
      { action: 'complete', milestone: 'm1' },
    ])
    expect(run.cues).toEqual(['complete'])
  })

  test('percentOf agrees with settle', () => {
    const { task } = drive(planned(), [{ action: 'complete', milestone: 'm1' }])
    expect(percentOf(task)).toBe(task.percent)
  })
})
