import { describe, expect, test } from 'claude-code/testing'
import { emptySwarm, submitTask, admitTask, bindAgent, finishTask, requestCancel, reportResult, escalateTask, markStalled, setWave, verifyTask, summarizeSwarm, routeTask, ownershipAllows, overlaps, normalizeOwned, releaseReservation, configureSwarm, resolveEscalation } from '../hooks/swarm'
import type { Swarm, ModelTier, Handoff } from '../hooks/swarm'
const add = (s: Swarm, id: string, tier: ModelTier = 'SONNET', owned = [`/${id}`], mode: 'read' | 'write' = 'read') => submitTask(s, { id, tier, role: 'Engineer', objective: `Task ${id}`, owned, mode }, 1).swarm
const run = (s: Swarm, id: string) => bindAgent(admitTask(s, id, 2).swarm, id, `agent-${id}`, 3)
const handoff = (to: ModelTier): Handoff => ({ to, objective: 'Investigate', discoveries: ['complex'], evidence: ['/a:1'], question: 'Architecture?', risk: 'cross-cutting', nextAction: 'Review', locations: ['/a'] })
describe('elastic swarm resource control', () => {
  test('multiple engineering agents exceed former three-agent cap; mixed utility pool', () => {
    let s = emptySwarm()
    for (let i = 0; i < 6; i++) s = run(add(s, `s${i}`), `s${i}`)
    for (let i = 0; i < 5; i++) s = run(add(s, `h${i}`, 'HAIKU'), `h${i}`)
    expect(summarizeSwarm(s)).toMatchObject({ sonnet: 6, haiku: 5, actual: 11, highWater: 11, tokens: null, cost: null })
  })
  test('twenty utility tasks obey queue budgets with independent pools', () => {
    let s = emptySwarm({ haiku: 4, sonnet: 6, total: 10 })
    for (let i = 0; i < 20; i++) s = add(s, `h${i}`, 'HAIKU')
    for (let i = 0; i < 20; i++) { const a = admitTask(s, `h${i}`, 2); s = a.ok ? bindAgent(a.swarm, `h${i}`, `h-agent-${i}`, 3) : a.swarm }
    s = run(add(s, 's'), 's')
    expect(summarizeSwarm(s)).toMatchObject({ haiku: 4, sonnet: 1, blocked: 16, requested: 21, actual: 5 })
    s = finishTask(s, 'h0', 'completed', { conclusion: 'done' }, 4)
    expect(admitTask(s, 'h4', 5).ok).toBe(true)
  })
  test('zero tier budget disables that pool; shrinking budget preserves live locks', () => {
    let s = run(add(emptySwarm(), 'a'), 'a')
    s = configureSwarm(add(s, 'b'), { sonnet: 0 })
    expect(admitTask(s, 'b', 4).reason).toBe('resource budget')
    expect(summarizeSwarm(s).parallelism).toBe(1)
  })
  test('equivalent active work is suppressed; completed work can be assigned again', () => {
    const s = run(add(emptySwarm(), 'a'), 'a')
    const duplicate = submitTask(s, { id: 'b', tier: 'SONNET', role: 'Other', objective: 'Task a', owned: ['/a'] }, 4)
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.swarm.tasks.length).toBe(1)
    expect(duplicate.swarm.requested).toBe(2)
    expect(submitTask(finishTask(s, 'a', 'completed', null, 5), { id: 'b', tier: 'SONNET', role: 'Engineer', objective: 'Task a', owned: ['/a'] }, 6).duplicate).toBe(false)
  })
})
describe('adversarial ownership and lifecycle', () => {
  test('writers cannot overlap exact, normalized ancestor, global or read scopes', () => {
    const s = run(add(emptySwarm(), 'writer', 'SONNET', ['/src/a/../shared'], 'write'), 'writer')
    for (const [i, p] of ['/src/shared', '/src/shared/x', '/src', '*', '/src/**'].entries()) {
      expect(admitTask(add(s, `r${i}`, 'HAIKU', [p], 'read'), `r${i}`, 4).ok).toBe(false)
    }
    expect(admitTask(add(s, 'independent', 'SONNET', ['/src/shared-other'], 'write'), 'independent', 4).ok).toBe(true)
    expect(normalizeOwned('../../unsafe')).toBe('*')
    expect(overlaps('/src/a', '/src/ab')).toBe(false)
  })
  test('read-only agents parallelize same scope, reject writes and global shell', () => {
    const s = run(add(emptySwarm(), 'reader', 'HAIKU', ['/src']), 'reader')
    expect(admitTask(add(s, 'reader2', 'HAIKU', ['/src']), 'reader2', 4).ok).toBe(true)
    expect(ownershipAllows(s, 'reader', '/src/a', 'read')).toBe(true)
    expect(ownershipAllows(s, 'reader', '/src/a', 'write')).toBe(false)
    expect(ownershipAllows(s, 'reader', '*', 'read')).toBe(false)
  })
  test('cancellation/result/escalation/stall do not release running writer ownership', () => {
    let s = run(add(emptySwarm({ stallMs: 10 }), 'writer', 'HAIKU', ['/src'], 'write'), 'writer')
    s = add(s, 'other', 'SONNET', ['/src'], 'write')
    s = reportResult(s, 'writer', { conclusion: 'done' }, 4)
    s = escalateTask(s, 'writer', handoff('SONNET'), 5)
    s = requestCancel(s, 'writer', 6)
    s = markStalled(s, 20)
    expect(admitTask(s, 'other', 21).ok).toBe(false)
    expect(ownershipAllows(s, 'writer', '/src/x')).toBe(false)
    expect(summarizeSwarm(s).actual).toBe(1)
    s = finishTask(s, 'writer', 'cancelled', null, 22)
    expect(admitTask(s, 'other', 23).ok).toBe(true)
  })
  test('stalled reservation retains lock; known spawn denial requeues safely', () => {
    let s = admitTask(add(emptySwarm({ stallMs: 10 }), 'a', 'SONNET', ['/a'], 'write'), 'a', 2).swarm
    expect(admitTask(add(markStalled(s, 20), 'b', 'SONNET', ['/a'], 'write'), 'b', 21).ok).toBe(false)
    s = releaseReservation(s, 'a', 3, 'Host refused')
    expect(s.tasks[0]?.state).toBe('queued')
    expect(s.actual).toBe(0)
    expect(admitTask(s, 'a', 4).ok).toBe(true)
  })
  test('queued cancellation and failed agent leave siblings intact', () => {
    let s = run(add(emptySwarm(), 'a'), 'a'); s = run(add(s, 'b'), 'b'); s = add(s, 'q')
    s = requestCancel(s, 'q', 4); s = finishTask(s, 'a', 'failed', { conclusion: 'Failure' }, 5)
    expect(s.tasks.map(t => t.state)).toEqual(['failed', 'running', 'cancelled'])
  })
  test('failed/unknown dependencies block, parent cannot finish before child', () => {
    let s = add(emptySwarm(), 'parent', 'OPUS')
    s = admitTask(s, 'parent', 2).swarm
    s = submitTask(s, { id: 'child', tier: 'HAIKU', role: 'Scout', objective: 'Scan', parentTask: 'parent', dependencies: ['unknown'] }, 3).swarm
    expect(admitTask(s, 'child', 4).ok).toBe(false)
    expect(() => finishTask(s, 'parent', 'completed', null, 5)).toThrow()
    s = finishTask(s, 'child', 'failed', null, 6)
    expect(finishTask(s, 'parent', 'completed', null, 7).tasks[0]?.state).toBe('completed')
  })
  test('dependency completion admits work; cycles and reuse of agent IDs refused', () => {
    let s = run(add(emptySwarm(), 'a'), 'a')
    s = submitTask(s, { id: 'b', tier: 'SONNET', role: 'Engineer', objective: 'B', dependencies: ['a'], owned: ['/b'] }, 4).swarm
    expect(admitTask(s, 'b', 5).ok).toBe(false)
    s = finishTask(s, 'a', 'completed', null, 6)
    s = admitTask(s, 'b', 7).swarm
    expect(() => bindAgent(s, 'b', 'agent-a', 8)).toThrow()
    const future = submitTask(emptySwarm(), { id: 'x', tier: 'HAIKU', role: 'Scout', objective: 'X', dependencies: ['y'] }, 1).swarm
    expect(() => submitTask(future, { id: 'y', tier: 'HAIKU', role: 'Scout', objective: 'Y', dependencies: ['x'] }, 2)).toThrow()
  })
})
describe('routing, escalation and observable evidence', () => {
  test('semantic routing preserves commander authority and direct execution', () => {
    expect(routeTask({ trivial: true })).toBe('OPUS')
    expect(routeTask({ architecture: true, extractive: true, bounded: true })).toBe('OPUS')
    expect(routeTask({ extractive: true, bounded: true })).toBe('HAIKU')
    expect(routeTask({ bounded: true })).toBe('SONNET')
    expect(routeTask({ trivial: true, commanderChoice: 'HAIKU' })).toBe('HAIKU')
    expect(emptySwarm().actual).toBe(0)
  })
  test('Haiku to Sonnet or Opus, Sonnet to Opus; completion distinct from escalation', () => {
    const s = run(add(emptySwarm(), 'h', 'HAIKU'), 'h')
    const e = escalateTask(s, 'h', handoff('SONNET'), 4)
    expect(e.tasks[0]?.state).toBe('running')
    expect(e.events.at(-1)?.kind).toBe('escalation')
    expect(escalateTask(s, 'h', handoff('OPUS'), 4).tasks[0]?.escalation?.to).toBe('OPUS')
    const n = run(add(emptySwarm(), 's'), 's')
    expect(() => escalateTask(n, 's', handoff('HAIKU'), 4)).toThrow()
  })
  test('wave, result and verification events bounded; unavailable telemetry stays unknown', () => {
    let s = run(add(emptySwarm({ maxEvents: 4 }), 'a'), 'a')
    for (const wave of ['ENGINEERING', 'REVIEW', 'INTEGRATION', 'VERIFICATION'] as const) s = setWave(s, wave, 4)
    s = reportResult(s, 'a', { conclusion: 'x'.repeat(4000), evidence: Array.from({ length: 100 }, () => 'e'), rawRef: '/artifact' }, 5)
    expect(s.tasks[0]?.result?.conclusion.length).toBe(1500)
    expect(s.tasks[0]?.result?.evidence.length).toBe(12)
    expect(s.tasks[0]?.verification).toBe('pending')
    expect(s.tasks[0]?.result?.confidence).toBe(null)
    s = finishTask(s, 'a', 'completed', null, 6)
    s = verifyTask(s, 'a', 'pass', 7, 'Commander test run')
    expect(s.events.length).toBe(4)
    expect(s.droppedEvents > 0).toBe(true)
    expect(summarizeSwarm(s)).toMatchObject({ tokens: null, cost: null, wave: 'VERIFICATION' })
  })
})

describe('escalation integration and verification discipline', () => {
  test('stopped escalation releases locks but blocks dependencies until commander resolves', () => {
    let s = run(add(emptySwarm(), 'h', 'HAIKU', ['/src'], 'write'), 'h')
    s = escalateTask(s, 'h', handoff('SONNET'), 4)
    expect(() => resolveEscalation(s, 'h', { conclusion: 'Integrated', evidence: ['checked'] }, 5)).toThrow()
    s = finishTask(s, 'h', 'completed', null, 6)
    expect(s.tasks[0]?.state).toBe('escalated')
    expect(finishTask(s, 'h', 'completed', null, 7)).toBe(s)
    expect(summarizeSwarm(s).parallelism).toBe(0)
    s = submitTask(s, { id: 'd', tier: 'SONNET', role: 'Engineer', objective: 'Depends', owned: ['/src'], mode: 'write', dependencies: ['h'] }, 7).swarm
    expect(admitTask(s, 'd', 8).ok).toBe(false)
    expect(() => verifyTask(s, 'h', 'pass', 8, 'Unchecked')).toThrow()
    expect(() => resolveEscalation(s, 'h', { conclusion: 'Trust me' }, 9)).toThrow()
    s = resolveEscalation(s, 'h', { conclusion: 'Integrated', evidence: ['Commander inspection'] }, 10)
    expect(admitTask(s, 'd', 11).ok).toBe(true)
    expect(verifyTask(s, 'h', 'pass', 12, 'Command passed').tasks[0]?.verification).toBe('pass')
  })
  test('unknown, unadmitted and terminal results cannot fabricate evidence', () => {
    let s = add(emptySwarm(), 'a')
    expect(() => reportResult(s, 'missing', {}, 2)).toThrow()
    expect(() => reportResult(s, 'a', {}, 2)).toThrow()
    expect(() => verifyTask(s, 'missing', 'pending', 2, '')).toThrow()
    expect(() => verifyTask(s, 'a', 'pass', 2, '')).toThrow()
    s = finishTask(run(s, 'a'), 'a', 'completed', null, 3)
    expect(() => reportResult(s, 'a', { conclusion: 'Overwrite' }, 4)).toThrow()
  })
  test('host-denied stalled unbound reservation can release safely', () => {
    let s = admitTask(add(emptySwarm({ stallMs: 10 }), 'a'), 'a', 2).swarm
    s = markStalled(s, 20)
    s = releaseReservation(s, 'a', 21, 'Host denied')
    expect(s.tasks[0]?.state).toBe('queued')
    expect(summarizeSwarm(s).parallelism).toBe(0)
  })
})
