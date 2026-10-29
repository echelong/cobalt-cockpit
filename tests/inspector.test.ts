// v0.6.0 agent inspector and verification readiness. Both are read-only views of records Cockpit already holds: they ask the swarm's
// own admission rule why a task waits, apply the completion rules of model.ts to say what stands before DONE, invent no figure the
// host did not report, and change nothing. Synthetic: they run no agent and verify nothing.

import { describe, expect, test } from 'claude-code/testing'
import { agentsText, ageOf, blockerOf, shortResource, taskText } from '../hooks/inspector'
import { readinessOf, readyText } from '../hooks/readiness'
import { emptyLedger } from '../hooks/ledger'
import { admitTask, admissionReason, bindAgent, configureSwarm, emptySwarm, escalateTask, finishTask, markStalled, reportResult, requestCancel, submitTask, verifyTask } from '../hooks/swarm'
import type { Swarm, TaskInput } from '../hooks/swarm'
import { GATES, applyAction, newTask, settle, setGuardRequired } from '../hooks/model'
import type { LedgerAgent, Task } from '../types'
import { FIVE, command, hostState, passAllGates, planAndComplete, progress, start, world } from './world'

const NOW = 10_000_000
const input = (id: string, over: Partial<TaskInput> = {}): TaskInput => ({ id, tier: 'SONNET', role: 'worker', objective: `objective of ${id}`, ...over })
const add = (s: Swarm, i: TaskInput, at = 1000): Swarm => submitTask(s, i, at).swarm
const run = (s: Swarm, id: string, agent: string, at = 2000): Swarm => bindAgent(admitTask(s, id, at).swarm, id, agent, at + 1)
const agent = (id: string, over: Partial<LedgerAgent> = {}): LedgerAgent => ({ id, role: 'WORKER', name: 'n', runId: 'r', originTurn: 't', parentAgent: 'unknown', requestedModel: 'unknown', requestedEffort: 'unknown', model: 'unknown', effort: 'unknown', effortSource: 'unknown', start: 'unknown', end: 'unknown', status: 'running', latest: 'x', counts: { tools: 0, reads: 0, edits: 0, writes: 0, tests: 0, builds: 0, git: 0, failures: 0, retries: 'unknown' }, source: 'unknown', background: 'unknown', ...over } as LedgerAgent)
const view = (swarm: Swarm, agents: LedgerAgent[] = [], columns = 100) => ({ swarm, agents, now: NOW, columns })
const task = (s: Swarm, id: string) => s.tasks.find(t => t.id === id)!
const reasonKind = (s: Swarm, id: string) => blockerOf(s, task(s, id), NOW)?.kind

describe('the blocker follows the swarm\'s own admission rule', () => {
  test('waiting for another task', () => {
    let s = add(emptySwarm(), input('A'))
    s = add(s, input('B', { dependencies: ['A'] }))
    s = admitTask(s, 'B', 2000).swarm
    expect(admissionReason(s, 'B')).toBe('dependency A: queued')
    const b = blockerOf(s, task(s, 'B'), NOW)!
    expect(b.kind).toBe('dependency')
    expect(b.why).toBe('Waiting for task A (queued).')
    expect(b.suggestion).toContain('/cockpit agents A')
  })
  test('a dependency that failed or was cancelled cannot be waited for, and the suggestion says who decides', () => {
    let s = add(emptySwarm(), input('A'))
    s = add(s, input('B', { dependencies: ['A'] }))
    s = finishTask(s, 'A', 'failed', { conclusion: 'could not' }, 3000)
    const b = blockerOf(s, task(s, 'B'), NOW)!
    expect(b.why).toBe('Waiting for task A (failed).')
    expect(b.suggestion).toContain('the commander decides')
  })
  test('a resource ownership conflict names the other task and the claim', () => {
    let s = add(emptySwarm(), input('A', { mode: 'write', owned: ['/hooks/alerts.ts'] }))
    s = run(s, 'A', 'agent-a')
    s = add(s, input('B', { mode: 'write', owned: ['/hooks/alerts.ts', '/docs'] }))
    s = admitTask(s, 'B', 3000).swarm
    const b = blockerOf(s, task(s, 'B'), NOW)!
    expect(b.kind).toBe('ownership')
    expect(b.why).toContain('conflict with task A over /hooks/alerts.ts')
    expect(b.suggestion).toContain('Cockpit changes neither')
    expect(s.conflicts).toBe(1)
  })
  test('agent capacity exhausted states the numbers the admission rule uses', () => {
    let s = configureSwarm(emptySwarm(), { total: 1, sonnet: 1, haiku: 1 })
    s = run(add(s, input('A')), 'A', 'agent-a')
    s = admitTask(add(s, input('B')), 'B', 3000).swarm
    const b = blockerOf(s, task(s, 'B'), NOW)!
    expect(b.kind).toBe('capacity')
    expect(b.why).toBe('Agent capacity exhausted: all 1 slots in use (SONNET 1 of 1).')
    expect(b.suggestion).toContain('only the person changes them')
  })
  test('capacity names the bound admission applied: commander work in the main loop is not a slot', () => {
    let s = configureSwarm(emptySwarm(), { total: 4, sonnet: 2, haiku: 2, opus: 0 })
    s = admitTask(add(s, input('O', { tier: 'OPUS' })), 'O', 1500).swarm
    s = run(add(s, input('A')), 'A', 'agent-a')
    s = run(add(s, input('B')), 'B', 'agent-b')
    s = admitTask(add(s, input('C')), 'C', 3000).swarm
    expect(admissionReason(s, 'C')).toBe('resource budget')
    expect(blockerOf(s, task(s, 'C'), NOW)!.why).toBe('Agent capacity exhausted: the SONNET pool is full (SONNET 2 of 2; 2 of 4 slots in use).')
    expect(agentsText(view(s))).toContain('CAPACITY · 2 of 4 slots')
  })
  test('the commander and an architect being occupied are told apart', () => {
    let s = add(emptySwarm(), input('A', { tier: 'OPUS' }))
    s = admitTask(s, 'A', 2000).swarm
    s = admitTask(add(s, input('B', { tier: 'OPUS' })), 'B', 3000).swarm
    expect(reasonKind(s, 'B')).toBe('commander')
    let t = configureSwarm(emptySwarm(), { total: 4, sonnet: 2, haiku: 2, opus: 1 })
    t = run(add(t, input('A', { tier: 'OPUS' })), 'A', 'agent-a')
    t = admitTask(add(t, input('B', { tier: 'OPUS' })), 'B', 3000).swarm
    expect(reasonKind(t, 'B')).toBe('architect')
  })
  test('a queued task nothing stops is said to be admissible, not blocked', () => {
    const s = add(emptySwarm(), input('A'))
    const b = blockerOf(s, task(s, 'A'), NOW)!
    expect(b.kind).toBe('admissible')
    expect(b.why).toContain('has not been admitted')
  })
  test('every reason the admission rule gives is one the inspector can word: the wording cannot drift unseen', () => {
    // random small swarms; every waiting task must classify as something other than "unknown"
    let seed = 7
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let round = 0; round < 60; round++) {
      let s = configureSwarm(emptySwarm(), { total: 1 + Math.floor(rnd() * 3), sonnet: 1 + Math.floor(rnd() * 2), haiku: 1, opus: Math.floor(rnd() * 2) })
      const ids: string[] = []
      for (let i = 0; i < 6; i++) {
        const id = `T${i}`
        const tier = (['SONNET', 'HAIKU', 'OPUS'] as const)[Math.floor(rnd() * 3)]!
        const dependencies = ids.length > 0 && rnd() < 0.3 ? [ids[Math.floor(rnd() * ids.length)]!] : []
        s = add(s, input(id, { tier, mode: rnd() < 0.5 ? 'write' : 'read', owned: [rnd() < 0.5 ? '/a' : '/b'], dependencies }))
        ids.push(id)
        s = admitTask(s, id, 2000 + i).swarm
        const t = task(s, id)
        if (t.state === 'reserved' && rnd() < 0.7 && !(t.tier === 'OPUS' && (s.config.opus ?? 0) === 0)) s = bindAgent(s, id, `agent-${round}-${i}`, 3000 + i)
      }
      for (const t of s.tasks.filter(x => x.state === 'queued' || x.state === 'blocked')) expect(blockerOf(s, t, NOW)?.kind).not.toBe('unknown')
    }
  })
  test('reserved, stalled, escalated, cancelling, failed, unverified: each has a reason from recorded state, and a running task has none', () => {
    let s = add(emptySwarm(), input('R'))
    s = admitTask(s, 'R', 2000).swarm
    expect(reasonKind(s, 'R')).toBe('awaiting-spawn')
    s = add(s, input('S'))
    s = run(s, 'S', 'agent-s', 2000)
    expect(blockerOf(s, task(s, 'S'), NOW)).toBeNull()
    s = markStalled(s, 2000 + s.config.stallMs + 5)
    expect(reasonKind(s, 'S')).toBe('stalled')
    expect(blockerOf(s, task(s, 'S'), NOW)!.why).toContain('stall threshold 5 min')
    let e = run(add(emptySwarm(), input('E')), 'E', 'agent-e')
    e = escalateTask(e, 'E', { objective: 'o', discoveries: [], evidence: [], question: 'which branch?', risk: 'r', nextAction: 'n', locations: [], to: 'OPUS' }, 3000)
    e = finishTask(e, 'E', 'completed', { conclusion: 'stopped' }, 3100)
    expect(task(e, 'E').state).toBe('escalated')
    expect(blockerOf(e, task(e, 'E'), NOW)!.suggestion).toContain('resolveEscalation')
    let c = run(add(emptySwarm(), input('C')), 'C', 'agent-c')
    c = requestCancel(c, 'C', 3000)
    expect(reasonKind(c, 'C')).toBe('cancelling')
    let f = finishTask(run(add(emptySwarm(), input('F')), 'F', 'agent-f'), 'F', 'failed', { conclusion: 'tests would not run' }, 3000)
    expect(blockerOf(f, task(f, 'F'), NOW)!.why).toContain('tests would not run')
    f = add(f, input('G'))
    f = finishTask(run(f, 'G', 'agent-g'), 'G', 'completed', { conclusion: 'done' }, 3000)
    expect(blockerOf(f, task(f, 'G'), NOW)!.why).toContain('A report is not a verified result')
    f = verifyTask(f, 'G', 'pass', 4000, 'checked')
    expect(blockerOf(f, task(f, 'G'), NOW)).toBeNull()
  })
  test('a suggestion is information: it never claims to have changed or to be about to change anything', () => {
    let s = add(emptySwarm(), input('A', { mode: 'write', owned: ['/x'] }))
    s = run(s, 'A', 'agent-a')
    s = admitTask(add(s, input('B', { mode: 'write', owned: ['/x'] })), 'B', 3000).swarm
    for (const t of s.tasks) {
      const b = blockerOf(s, t, NOW)
      if (b?.suggestion !== undefined) expect(b.suggestion).not.toMatch(/\b(cleared|released|approved|resolved it|has been|was changed|will now)\b/i)
    }
  })
})

describe('the agents view shows what was observed and says what was not', () => {
  const swarm = (() => {
    let s = configureSwarm(emptySwarm(), { total: 4, sonnet: 2, haiku: 2, opus: 0 })
    s = add(s, input('A', { mode: 'write', owned: ['/home/user/Projects/secret-client/hooks/alerts.ts'], effort: 'high' }))
    s = run(s, 'A', 'agent-a-1234567890')
    s = add(s, input('B', { dependencies: ['A'] }))
    s = add(s, input('C', { tier: 'HAIKU', role: 'scout' }))
    s = admitTask(s, 'B', 3000).swarm
    return s
  })()
  test('the header counts, the capacity and the wave come from the swarm', () => {
    const text = agentsText(view(swarm))
    expect(text).toContain('AGENTS · wave RECONNAISSANCE · 1 active · 2 waiting · 0 stalled · 0 escalated · 0 completed of 3')
    expect(agentsText(view(swarm, [], 60)).split('\n')[0]).toBe('AGENTS · 1 active · 2 waiting · 0/3 done · RECONNAISSANCE')
    expect(text).toContain('CAPACITY · 1 of 4 slots · SONNET 1/2 · HAIKU 0/2 · OPUS in the main loop')
  })
  test('what needs attention comes first, with its reason under it', () => {
    const lines = agentsText(view(swarm)).split('\n')
    const b = lines.findIndex(l => l.startsWith('  B SONNET'))
    const a = lines.findIndex(l => l.startsWith('  A SONNET'))
    expect(b).toBeGreaterThan(-1)
    expect(b).toBeLessThan(a)
    expect(lines[b + 1]).toBe('    ↳ Waiting for task A (running).')
  })
  test('no figure is invented: no agent means no model, no applied effort, and no activity before a task starts', () => {
    const text = taskText(view(swarm), 'C')
    expect(text).toContain('agent: none bound')
    expect(text).toContain('model: HAIKU assigned; model not observed (no agent bound)')
    expect(text).toContain('effort: requested AUTO · launch: none set on the call · applied: not observed')
    expect(text).toContain('activity: none: not started')
    expect(text).toContain('outcome: none yet')
    expect(text).not.toMatch(/\d+%/)
  })
  test('requested, launched, applied and engine-reported effort are four different things and are shown as such', () => {
    const s = swarm
    const a = task(s, 'A')
    const bound = { ...s, tasks: s.tasks.map(t => (t.id === 'A' ? { ...t, launchEffort: 'high', appliedEffort: 'medium' } : t)) }
    const text = taskText(view(bound, [agent(a.agentId!, { model: 'claude-sonnet-5-5', requestedModel: 'sonnet', effort: 'high', effortSource: 'engine', effectiveEffort: 'high' })]), 'A')
    expect(text).toContain('model: claude-sonnet-5-5 (asked for sonnet) · tier SONNET')
    expect(text).toContain('effort: requested high · launch high · applied medium · engine reported high')
    const same = { ...s, tasks: s.tasks.map(t => (t.id === 'A' ? { ...t, launchEffort: 'high', appliedEffort: 'high' } : t)) }
    expect(taskText(view(same, [], 200), 'A')).toContain('applied high (the launch level)')
    const rewritten = { ...s, tasks: s.tasks.map(t => (t.id === 'A' ? { ...t, launchEffort: null, appliedEffort: 'high' } : t)) }
    expect(taskText(view(rewritten, [], 200), 'A')).toContain('set on requests by Cockpit high (not reported back by the engine)')
    const none = taskText(view(bound, [agent(a.agentId!)]), 'A')
    expect(none).toContain('model: not observed · tier SONNET')
    expect(none).toContain('engine: no report')
  })
  test('a report is not a verification: reported and verified are never the same word', () => {
    let s = run(add(emptySwarm(), input('A')), 'A', 'agent-a')
    s = reportResult(s, 'A', { conclusion: 'all good', evidence: ['e'] }, 3000)
    expect(taskText(view(s), 'A')).toContain('outcome: reported by the agent; NOT verified (pending)')
    s = finishTask(s, 'A', 'completed', null, 3500)
    s = verifyTask(s, 'A', 'pass', 4000, 'checked by the commander')
    expect(taskText(view(s), 'A')).toContain('commander report PASS · SELF_REPORTED_UNCHECKED')
    const failed = verifyTask(finishTask(reportResult(run(add(emptySwarm(), input('A')), 'A', 'agent-a'), 'A', { conclusion: 'c' }, 3000), 'A', 'completed', null, 3500), 'A', 'fail', 4000, 'did not hold')
    expect(taskText(view(failed), 'A')).toContain('verification FAILED')
  })
  test('activity is the last observed moment, or says nothing was observed since the start', () => {
    // the host binding the agent is the first observation; before anything after the start, nothing was observed
    const quiet = { ...swarm, tasks: swarm.tasks.map(t => (t.id === 'A' ? { ...t, lastActivityAt: t.startedAt! } : t)) }
    expect(taskText(view(quiet), 'A')).toContain('activity: none observed since it started')
    const moved = { ...swarm, tasks: swarm.tasks.map(t => (t.id === 'A' ? { ...t, lastActivityAt: NOW - 5 * 60_000 } : t)) }
    expect(taskText(view(moved), 'A')).toContain('activity: last observed 5m ago')
    const behind = { ...swarm, tasks: swarm.tasks.map(t => (t.id === 'A' ? { ...t, lastActivityAt: NOW + 5000 } : t)) }
    expect(taskText(view(behind), 'A')).toContain('observed (time not comparable)')
    expect(ageOf(-1)).toBeNull()
  })
  test('a resource claim is shortened and a private path does not appear', () => {
    expect(shortResource('/home/user/Projects/secret-client/hooks/alerts.ts')).toBe('…/hooks/alerts.ts')
    expect(shortResource('/hooks')).toBe('/hooks')
    expect(shortResource('*')).toBe('the whole repository')
    const text = `${agentsText(view(swarm))}\n${taskText(view(swarm), 'A')}`
    expect(text).not.toContain('secret-client')
    expect(text).not.toContain('/home/user')
    expect(taskText(view(swarm), 'A')).toContain('owns: write …/hooks/alerts.ts')
  })
  test('paths in free text (objective, question, conclusion) are cut to their last two segments', () => {
    const s = add(emptySwarm(), input('P', { objective: 'fix /home/user/Projects/secret-client/hooks/alerts.ts and ~/work/x/y/z.ts now' }))
    const text = taskText(view(s), 'P')
    expect(text).toContain('fix …/hooks/alerts.ts and …/y/z.ts now')
    expect(text).not.toContain('secret-client')
    const short = add(emptySwarm(), input('Q', { objective: 'look in /home/alice and /home/alice/proj and https://example.org/a/b/c' }))
    const t2 = taskText(view(short, [], 200), 'Q')
    expect(t2).not.toContain('alice')
    expect(t2).toContain('https://example.org/a/b/c')
    expect(t2).toContain('…/proj')
  })
  test('an unknown task says so and lists what is known; a task is found whatever the case', () => {
    expect(taskText(view(swarm), 'zzz')).toBe('No task "zzz" in this session. Known: A, B, C.')
    expect(taskText(view(swarm), 'b')).toContain('TASK B · SONNET worker · blocked')
    expect(taskText(view(emptySwarm()), 'x')).toBe('No task "x" in this session. None are assigned.')
  })
  test('host agents Cockpit did not assign are listed apart, with only what the Ledger observed', () => {
    const text = agentsText(view(swarm, [agent('abcdefgh-1', { role: 'EXPLORER', status: 'running', model: 'unknown' }), agent(task(swarm, 'A').agentId!)]))
    expect(text).toContain('HOST AGENTS NOT ASSIGNED BY COCKPIT · 1')
    expect(text).toContain('  abcdefgh EXPLORER · running · model not observed')
  })
  test('the empty swarm says nothing is assigned and invents no work', () => {
    const text = agentsText(view(emptySwarm()))
    expect(text).toContain('No tasks assigned in this session.')
    expect(text).toContain('0 completed of 0')
    expect(text).not.toContain('…')
  })
  test('narrow terminals: every line stays within the width, and the detail is one command away', () => {
    for (const columns of [30, 44, 60, 79, 80, 120]) {
      for (const line of agentsText(view(swarm, [], columns)).split('\n')) expect(line.length).toBeLessThanOrEqual(Math.max(columns, 30))
      for (const line of taskText(view(swarm, [], columns), 'B').split('\n')) expect(line.length).toBeLessThanOrEqual(Math.max(columns, 60))
    }
    expect(agentsText(view(swarm, [], 44))).not.toContain('agent agent-a')
  })
  test('many tasks are bounded: twelve are listed, the rest counted, and the work stays small', () => {
    let s = emptySwarm()
    for (let i = 0; i < 400; i++) s = add(s, input(`T${i}`), 1000 + i)
    const started = Date.now()
    const text = agentsText(view(s))
    const took = Date.now() - started
    expect(text.split('\n').length).toBeLessThanOrEqual(32)
    expect(text).toContain('+388 more')
    expect(took).toBeLessThan(2000)
  })
  test('the view does not change what it reads', () => {
    const before = JSON.stringify(swarm)
    agentsText(view(swarm)); taskText(view(swarm), 'A'); taskText(view(swarm), 'B')
    expect(JSON.stringify(swarm)).toBe(before)
  })
})

describe('readiness: the recorded conditions for DONE, explained', () => {
  const fresh = (): Task => settle(applyAction(newTask(1, 'goal', 100, null), { action: 'plan', milestones: FIVE } as never, 101, null).task).task
  const doneMilestones = (t: Task, n: number): Task => {
    let cur = t
    for (let i = 1; i <= n; i++) cur = settle(applyAction(cur, { action: 'complete', milestone: `m${i}` } as never, 200 + i, null).task).task
    return cur
  }
  const gate = (t: Task, name: string, state: string, evidence = 'ev'): Task => settle(applyAction(t, { action: 'gate', gate: name, state, evidence } as never, 300, null).task).task
  test('no task, no plan', () => {
    expect(readinessOf(null, null).standing).toBe('NO TASK')
    expect(readyText(null, null, 100)).toContain('nothing to explain')
    const planless = settle(newTask(1, 'g', 100, null)).task
    expect(readinessOf(planless, null).open[0]).toContain('no milestones are defined')
  })
  test('open milestones and pending gates stand in the way; nothing is called satisfied that is not', () => {
    const t = doneMilestones(fresh(), 2)
    const r = readinessOf(t, null)
    expect(r.standing).toBe('DOES NOT PERMIT DONE')
    expect(r.open.some(l => l.startsWith('milestones 2 of 5 done'))).toBe(true)
    for (const g of GATES) expect(r.satisfied.some(l => l.startsWith(`${g} pass`))).toBe(false)
    expect(r.open.some(l => l.startsWith('CODE not reported yet'))).toBe(true)
  })
  test('a gate Claude reported is told apart from one read off a command, and neither is called verified', () => {
    let t = doneMilestones(fresh(), 5)
    t = gate(t, 'CODE', 'pass')
    const r = readinessOf(t, null)
    expect(r.satisfied.find(l => l.startsWith('CODE pass'))).toContain('reported by Claude, not read from a command')
    expect(readyText(t, null, 100)).not.toMatch(/\bverified\b(?! one)/)
  })
  test('a failed gate and a stale one are named as such', () => {
    let t = doneMilestones(fresh(), 5)
    t = gate(t, 'TEST', 'fail', 'exit 1')
    expect(readinessOf(t, null).open.some(l => l.startsWith('TEST FAILED · exit 1'))).toBe(true)
    const stale = { ...t, gates: { ...t.gates, BUILD: { ...t.gates.BUILD, state: 'pending' as const, evidence: 'stale: the working tree changed since the checks were observed' } } }
    expect(readinessOf(stale, null).open.some(l => l.startsWith('BUILD STALE'))).toBe(true)
  })
  test('the Stop guard\'s hold and its missing completion are conditions of their own', () => {
    setGuardRequired(true)
    try {
      const held = { ...doneMilestones(fresh(), 5), stopHold: { reason: 'check exit 1', at: 1, refusals: 1 } }
      expect(readinessOf(held, null).open.find(l => l.startsWith('STOP GUARD HOLD'))).toContain("your /cockpit guard release lifts it")
      expect(readinessOf(doneMilestones(fresh(), 5), null).open).toContain('the Stop guard has not yet completed its check for this task and tree')
    } finally { setGuardRequired(false) }
  })
  test('an unadjudicated review and an incomplete goal check stand in the way', () => {
    const t = doneMilestones(fresh(), 5)
    const review = { ...t, review: { grounds: ['release' as const], consult: null, state: 'required' as const } }
    expect(readinessOf(review, null).open.some(l => l.includes('Opus consultation (release) is required, not adjudicated'))).toBe(true)
    const goal = { ...t, kind: 'coding' as const, discovery: { level: 'STANDARD' as const, source: 'auto' as const, reasons: [], objective: null, criteria: [{ id: 'c1', text: 'two words', status: 'pending' as const }], unknowns: [{ id: 'u1', text: 'x', state: 'open' as const }], risks: [], via: [] } as never }
    const open = readinessOf(goal, null).open.find(l => l.includes('acceptance criteria'))!
    expect(open).toContain('0 of 1 met with evidence')
    expect(open).toContain('1 unknown still open')
  })
  test('agent escalations, unverified reports and waiting agents are noted but are not conditions of DONE', () => {
    let s = run(add(emptySwarm(), input('E')), 'E', 'agent-e')
    s = escalateTask(s, 'E', { objective: 'o', discoveries: [], evidence: [], question: 'q', risk: 'r', nextAction: 'n', locations: [], to: 'OPUS' }, 3000)
    s = run(add(s, input('G')), 'G', 'agent-g')
    s = finishTask(s, 'G', 'completed', { conclusion: 'c' }, 3100)
    s = add(s, input('Q', { dependencies: ['E'] }))
    const r = readinessOf(fresh(), s)
    expect(r.notes.join('\n')).toContain('1 agent escalation pending the commander: E')
    expect(r.notes.join('\n')).toContain('1 completed agent result without a commander-approved PASS: G (pending)')
    expect(r.notes.join('\n')).toContain('1 agent task waiting or stalled: Q queued')
    expect(r.open.join('\n')).not.toContain('escalation')
  })
  test('the answer is the recorded status, never a second opinion: DONE exactly when the task reads done', () => {
    let seed = 11
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let round = 0; round < 80; round++) {
      let t = doneMilestones(fresh(), Math.floor(rnd() * 6))
      for (const g of GATES) if (rnd() < 0.7) t = gate(t, g, (['pass', 'fail', 'pending', 'na'] as const)[Math.floor(rnd() * 4)]!)
      const r = readinessOf(t, null)
      expect(r.standing === 'PERMITS DONE').toBe(t.status === 'done')
      if (r.standing === 'PERMITS DONE') expect(r.open).toEqual([])
      else expect(r.open.length).toBeGreaterThan(0)
    }
  })
  test('all gates passed and every milestone done is DONE, and the view says what held', () => {
    let t = doneMilestones(fresh(), 4)
    for (const g of GATES) t = gate(t, g, 'pass')
    t = settle(applyAction(t, { action: 'complete', milestone: 'm5' } as never, 400, null).task).task
    expect(t.status).toBe('done')
    const r = readinessOf(t, null)
    expect(r.standing).toBe('PERMITS DONE')
    expect(r.satisfied.length).toBeGreaterThanOrEqual(7)
    expect(readyText(t, null, 100).split('\n')[0]).toBe('READY · PERMITS DONE · 100% · status DONE')
  })
  test('it reads and never writes, and a narrow width is honoured', () => {
    const t = doneMilestones(fresh(), 3)
    const before = JSON.stringify(t)
    readyText(t, emptySwarm(), 40)
    expect(JSON.stringify(t)).toBe(before)
    for (const line of readyText(t, null, 40).split('\n')) expect(line.length).toBeLessThanOrEqual(60)
  })
})

describe('in a run: the commands', () => {
  test('agents and ready are read-only: a task\'s record is the same before and after, from any origin', async ($, on) => {
    world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 2)
    const before = JSON.stringify(held.get('task')!.value)
    const out = await command($, 'agents')
    expect(String(out.text)).toContain('No tasks assigned in this session.')
    expect(String((await command($, 'ready')).text)).toContain('DOES NOT PERMIT DONE')
    for (const origin of [{ kind: 'sdk' }, { kind: 'plugin', name: 'x' }, undefined]) {
      await $.command.run({ command: 'cockpit', args: 'ready', origin, presentation: { isFullscreen: true, columns: 120 } } as never)
      await $.command.run({ command: 'cockpit', args: 'agents', origin, presentation: { isFullscreen: true, columns: 120 } } as never)
    }
    expect(JSON.stringify(held.get('task')!.value)).toBe(before)
  })
  test('ready agrees with the progress tool: DONE exactly when the task is done', async ($, on) => {
    world(on); hostState(on, {})
    await start($); await planAndComplete($, 4)
    expect(String((await command($, 'ready')).text)).toContain('DOES NOT PERMIT DONE')
    await passAllGates($)
    await progress($, { action: 'complete', milestone: 'm5' })
    const status = await progress($, { action: 'status' })
    expect(status).toContain('DONE')
    const text = String((await command($, 'ready')).text)
    expect(text).toContain('READY · PERMITS DONE · 100%')
    expect(text).toContain('HOLDS')
  })
  test('the agents view reads the Ledger\'s swarm and explains one task', async ($, on) => {
    let s = add(emptySwarm(), input('A'))
    s = add(s, input('B', { dependencies: ['A'] }))
    s = admitTask(s, 'B', 2000).swarm
    world(on); hostState(on, { 'run-ledger': { ...emptyLedger('s1'), swarm: s } })
    on('session.id', () => ({ value: 's1' }))
    await start($)
    const list = String((await command($, 'agents')).text)
    expect(list).toContain('  B SONNET worker · blocked')
    expect(list).toContain('↳ Waiting for task A (queued).')
    const one = String((await command($, 'agents b')).text)
    expect(one).toContain('blocker (dependency): Waiting for task A (queued).')
    expect(one).toContain('suggestion (information only; nothing was changed)')
    expect(String((await command($, 'agents zzz')).text)).toContain('No task "zzz"')
    expect(String((await command($, 'agents a b')).text)).toContain('Usage: /cockpit agents')
  })
  test('a legacy Ledger with no swarm is read as an empty one, and a malformed one does not throw', async ($, on) => {
    world(on); hostState(on, { 'run-ledger': { ...emptyLedger('s1'), swarm: undefined } })
    on('session.id', () => ({ value: 's1' }))
    await start($)
    expect(String((await command($, 'agents')).text)).toContain('No tasks assigned')
  })
})
