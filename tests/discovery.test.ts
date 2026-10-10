// Adaptive discovery (v0.5.1): the level a task gets, the records it keeps and
// the goal check it needs before it can read DONE. The pure rules first, then
// the real host hooks: what a prompt is given, and what reaches the ledger.

import { describe, expect, test } from 'claude-code/testing'

import { align, classify, criteriaMissing, decide, discover, discoveryRows, guidanceFor, invalidateAlignment, isAlignmentSatisfied, markGuided, needsAlignment, unpin, withDiscovery } from '../hooks/discovery'
import { groundsAvailable, mandatoryGrounds, promptGroundsOf, requireReview } from '../hooks/consult'
import { decisionsMarkdown, emptyLedger, ledgerLines, migrateLedger, recordDiscovery, storageLedger, jsonBytes, STORE_LEDGER_BYTES } from '../hooks/ledger'
import { applyAction, newTask, percentOf, settle, setGate, summaryOf, touchFile } from '../hooks/model'
import type { Ledger, Task } from '../types'
import { command, FIVE, GATE_NAMES, hostState, passAllGates, planAndComplete, progress, prompt, start, world } from './world'

const secret = ['sk', 'abcdefghijklmnop1234567890'].join('-')
const stage = (text: string, files: string[] = []): Task => withDiscovery({ ...newTask(1, text, 0, 'abc1234'), files: files.map(path => ({ path, added: 1, removed: 0 })) }, null, { prompt: text, files, milestones: 0, grounds: promptGroundsOf(text) })
const level = (text: string, files: string[] = []) => stage(text, files).discovery!.level
const drive = (task: Task, calls: Record<string, unknown>[]): Task => {
  let current = task
  for (const call of calls) {
    const out = applyAction(current, call, 1000, 'abc1234')
    if (out.error !== undefined) throw new Error(out.error)
    current = settle(out.task).task
  }

  return current
}
const PLAN = { action: 'plan', kind: 'coding', milestones: FIVE }
const pass = GATE_NAMES.map(gate => ({ action: 'gate', gate, state: 'pass', evidence: `${gate} checked` }))
const EV = "cancel test 'booking is refunded' passes in test/api.test.js (5 pass)"
const aligned = { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: EV }] } }
const standard = (): Task => drive(stage('Add booking cancellation to the API and the UI'), [{ action: 'discover', criteria: ['A booking can be cancelled'] }, PLAN])
const run = [PLAN, ...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })), ...pass, { action: 'complete', milestone: 'm5' }]
const finished = (task: Task): Task => drive(task, [...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })), ...pass])

describe('the discovery level', () => {
  test('trivial, read-only and conversational prompts are LIGHT and cost no prompt text', () => {
    for (const p of ['Fix the typo in the README heading', 'Change the button label to Save', 'Rename the variable tmp to total', 'What does parseStatus do?', 'Find every place the logger is called.', 'thanks']) {
      expect(level(p)).toBe('LIGHT')
      expect(guidanceFor(stage(p))).toBeNull()
    }
  })
  test('multi-file features and real debugging are STANDARD', () => {
    expect(level('Add booking cancellation to the API and the UI')).toBe('STANDARD')
    expect(level('Fix the flaky login redirect bug')).toBe('STANDARD')
    expect(level('Change a label', ['a.ts', 'b.ts', 'c.ts'])).toBe('STANDARD')
    expect(classify({ prompt: 'Change a label', files: ['a.ts', 'b.ts', 'c.ts'], milestones: 0, grounds: [] }).reasons).toContain('files:3')
  })
  test('high-risk work is DEEP, on the same grounds the consultation policy reads', () => {
    for (const p of ['Migrate the payments schema to the new ledger', 'Add OAuth authentication to the API', 'Fix the race condition in the job queue', 'Redesign the persistence layer across modules.']) expect(level(p)).toBe('DEEP')
    expect(level('Tidy up the helper', ['src/auth/session.ts'])).toBe('DEEP')
  })
  test('a level only goes up; the model may raise it and never lower it', () => {
    let task = stage('Add booking cancellation to the API and the UI')
    task = discover(task, { level: 'DEEP' }, 5).task
    expect(task.discovery!.level).toBe('DEEP')
    expect(task.discovery!.reasons).toContain('model-raised')
    task = discover(task, { level: 'STANDARD' }, 6).task
    expect(task.discovery!.level).toBe('DEEP')
    expect(withDiscovery(task, null, { prompt: 'thanks', files: [], milestones: 0, grounds: [] }).discovery!.level).toBe('DEEP')
  })
  test('the operator pins a level and can give it back; the pin is kept when the evidence changes', () => {
    const pinned = withDiscovery(stage('Migrate the payments schema'), 'LIGHT')
    expect(pinned.discovery).toMatchObject({ level: 'LIGHT', source: 'operator', reasons: ['operator'] })
    expect(withDiscovery(pinned, null, { prompt: 'Migrate more payments', files: [], milestones: 0, grounds: ['security'] }).discovery!.level).toBe('LIGHT')
    expect(unpin(pinned).discovery).toMatchObject({ level: 'DEEP', source: 'auto' })
  })
  test('guidance is short, only for STANDARD and DEEP, and said once per level', () => {
    const task = stage('Add booking cancellation to the API and the UI')
    const line = guidanceFor(task)!
    expect(line).toContain('STANDARD')
    expect(line.length).toBeLessThan(450)
    expect(guidanceFor(markGuided(task))).toBeNull()
    const deeper = discover(markGuided(task), { level: 'DEEP' }, 3).task
    expect(guidanceFor(deeper)).toContain('DEEP')
    expect(guidanceFor(deeper)).toContain('swarm action "consult"')
    expect(guidanceFor(markGuided(deeper))).toBeNull()
  })
  test('the classification reads nothing a router could supply', () => {
    // same facts, same answer: there is no input for a router, a model or a clock
    const facts = { prompt: 'Add booking cancellation', files: [], milestones: 0, grounds: [] } as const
    expect(classify(facts)).toEqual(classify({ ...facts }))
    expect(Object.keys(facts).sort()).toEqual(['files', 'grounds', 'milestones', 'prompt'])
  })
})

describe('unknowns', () => {
  test('material unknowns are recorded as reported, updated by id and bounded', () => {
    let task = discover(stage('Add booking cancellation to the API and the UI'), { unknowns: [{ text: 'Are partial refunds allowed?' }, { text: 'Is there an admin override?' }], risks: ['compatibility', 'rollback'] }, 5).task
    expect(task.discovery!.unknowns.map(u => [u.id, u.state])).toEqual([['u1', 'open'], ['u2', 'open']])
    task = discover(task, { unknowns: [{ id: 'u1', state: 'assumed', note: 'full refunds only' }] }, 6).task
    expect(task.discovery!.unknowns[0]).toMatchObject({ state: 'assumed', note: 'full refunds only' })
    expect(discoveryRows(task).join('\n')).toContain('UNKNOWNS / 1 unresolved')
    task = discover(task, { unknowns: Array.from({ length: 30 }, (_, n) => ({ text: `unknown ${n}` })) }, 7).task
    expect(task.discovery!.unknowns.length).toBeLessThanOrEqual(8)
  })
})

describe('decision records', () => {
  const decision = { problem: 'Where to cancel', chosen: 'A service method', alternatives: [{ option: 'A database trigger', rejected_because: 'hidden from the tests' }], tradeoffs: 'one more layer', evidence: ['bookings.ts:40 owns state'], status: 'provisional' }
  test('keeps the alternatives, their reasons and the evidence exactly as reported', () => {
    const task = decide(stage('Add booking cancellation to the API and the UI'), { decision }, 9).task
    expect(task.decisions).toEqual([{ id: 'd1', taskId: 1, problem: 'Where to cancel', chosen: 'A service method', alternatives: [{ option: 'A database trigger', rejectedBecause: 'hidden from the tests' }], tradeoffs: 'one more layer', evidence: ['bookings.ts:40 owns state'], status: 'provisional', at: 9 }])
  })
  test('invents nothing: an alternative needs its reason and a verified decision needs evidence', () => {
    const base = stage('Add booking cancellation to the API and the UI')
    for (const bad of [{ ...decision, alternatives: [{ option: 'A trigger' }] }, { ...decision, status: 'verified', evidence: [] }, { chosen: 'x' }, { problem: 'x' }]) {
      const out = decide(base, { decision: bad }, 9)
      expect(out.error).toBeDefined()
      expect(out.task).toBe(base)
    }
    expect(decide(base, { decision: undefined }, 9).error).toBeDefined()
    expect(decide(base, { decision: 'text' }, 9).error).toBeDefined()
  })
  test('a revision keeps the id and is marked revised; the record count is bounded', () => {
    let task = decide(stage('Add booking cancellation to the API and the UI'), { decision }, 9).task
    task = decide(task, { decision: { ...decision, status: undefined, id: 'd1', chosen: 'A queue worker' } }, 10).task
    expect(task.decisions).toHaveLength(1)
    expect(task.decisions![0]).toMatchObject({ id: 'd1', chosen: 'A queue worker', status: 'revised' })
    for (let n = 0; n < 30; n++) task = decide(task, { decision: { ...decision, problem: `p${n}` } }, 11 + n).task
    expect(task.decisions!.length).toBeLessThanOrEqual(12)
  })
  test('credentials are redacted before the task or the ledger holds them', () => {
    const task = decide(stage('Add booking cancellation to the API and the UI'), { decision: { ...decision, chosen: `Use the key ${secret} for the call`, evidence: [`header Bearer ${secret}`], alternatives: [{ option: `key=${secret}`, rejected_because: `token is ${secret}` }] } }, 9).task
    expect(JSON.stringify(task)).not.toContain(secret)
    // and the ledger redacts again, whatever it is handed
    const raw = { ...task, decisions: [{ ...task.decisions![0]!, problem: `leaks ${secret}` }] }
    const l = recordDiscovery(emptyLedger('s1'), raw, 9)
    expect(JSON.stringify(l)).not.toContain(secret)
    expect(l.decisions).toHaveLength(1)
  })
})

describe('the Run Ledger', () => {
  test('records why a level was chosen, without prompt text, and one entry per task', () => {
    const task = stage('Migrate the payments schema for ACME-secret-project')
    let l = recordDiscovery(emptyLedger('s1'), task, 5)
    l = recordDiscovery(l, task, 6)
    expect(l.discoveries).toEqual([{ taskId: 1, level: 'DEEP', source: 'auto', reasons: expect.arrayContaining(['high-risk-term']), unknownsOpen: 0, alignment: 'NONE', criteriaTotal: 0, criteriaMet: 0, at: 6 }])
    expect(JSON.stringify(l)).not.toContain('ACME-secret-project')
    expect(ledgerLines(l, 10).join('\n')).toContain('DISCOVERY task 1 DEEP')
  })
  test('LIGHT work records its level and nothing else', () => {
    const l = recordDiscovery(emptyLedger('s1'), stage('Fix the typo'), 5)
    expect(l.discoveries).toMatchObject([{ level: 'LIGHT', reasons: ['trivial-shape'] }])
    expect(l.decisions).toEqual([])
  })
  test('a revised decision replaces its earlier form; other tasks keep theirs', () => {
    const d = { problem: 'p', chosen: 'a', alternatives: [], evidence: [] }
    const t1 = decide(stage('Add booking cancellation to the API'), { decision: d }, 1).task
    let l = recordDiscovery(emptyLedger('s1'), t1, 1)
    l = recordDiscovery(l, decide(t1, { decision: { ...d, id: 'd1', chosen: 'b' } }, 2).task, 2)
    expect(l.decisions!.map(x => [x.id, x.chosen, x.status])).toEqual([['d1', 'b', 'revised']])
    const t2 = decide({ ...stage('Add export to the API'), id: 2 }, { decision: d }, 3).task
    l = recordDiscovery(l, t2, 3)
    expect(l.decisions!.map(x => x.taskId)).toEqual([1, 2])
  })
  test('decisions export as Markdown on request only, as printed text, redacted', () => {
    expect(decisionsMarkdown(emptyLedger('s1'))).toBe('No decisions recorded in this ledger.')
    const t = decide(stage('Add booking cancellation to the API'), { decision: { problem: 'Where', chosen: 'Service', alternatives: [{ option: 'Trigger', rejected_because: 'hidden' }], evidence: ['bookings.ts:40'], tradeoffs: 'one layer', status: 'verified' } }, 1).task
    const md = decisionsMarkdown(recordDiscovery(emptyLedger('s1'), t, 1))
    expect(md).toContain('## d1 (task 1): Where')
    expect(md).toContain('- Rejected: Trigger — hidden')
    expect(md).toContain('- Evidence: bookings.ts:40')
    expect(md).toContain('- Status: verified')
  })
  test('a v0.5.0 ledger migrates and stays readable', () => {
    const old = JSON.parse(JSON.stringify(emptyLedger('s0'))) as Ledger
    delete (old as { decisions?: unknown }).decisions
    delete (old as { discoveries?: unknown }).discoveries
    const migrated = migrateLedger(old)
    expect(migrated).toMatchObject({ schema: 2, decisions: [], discoveries: [] })
    expect(ledgerLines(old, 10).length).toBeGreaterThan(5)
    expect(ledgerLines(old, 10).some(r => r.startsWith('DISCOVERY task') || r.startsWith('DECISION d'))).toBe(false)
  })
  test('storage is bounded: decision detail goes before decisions do', () => {
    let l = emptyLedger('s1')
    const big = 'x '.repeat(70)
    for (let n = 1; n <= 80; n++) {
      const t = decide({ ...stage('Add booking cancellation to the API'), id: n }, { decision: { problem: big, chosen: big, alternatives: [{ option: big, rejected_because: big }, { option: big, rejected_because: big }], evidence: [big, big], tradeoffs: big } }, n).task
      l = recordDiscovery(l, t, n)
    }
    expect(l.decisions!.length).toBeLessThanOrEqual(64)
    const stored = storageLedger({ ...l, tools: [], requests: [] })
    expect(jsonBytes(stored)).toBeLessThanOrEqual(STORE_LEDGER_BYTES)
  })
})

describe('original-goal verification', () => {
  test('passing every gate is not alignment: STANDARD work stays unverified without the goal check', () => {
    const task = drive(finished(standard()), [{ action: 'complete', milestone: 'm5' }])
    expect(task.percent).toBe(80)
    expect(task.status).toBe('unverified')
    expect(task.milestones[4]!.state).toBe('active')
    expect(summaryOf(task)).toContain('alignment PENDING')
  })
  test('real acceptance evidence satisfies it and the task reaches DONE', () => {
    const task = drive(finished(standard()), [aligned, { action: 'complete', milestone: 'm5' }])
    expect(task).toMatchObject({ percent: 100, status: 'done' })
    expect(task.alignment).toMatchObject({ state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: EV, status: 'met' }] })
  })
  test('ALIGNED is refused while evidence, work, gates or unknowns are missing', () => {
    const open = drive(standard(), [{ action: 'discover', unknowns: [{ text: 'Refund policy?' }] }])
    const cases: [Task, Record<string, unknown>, string][] = [
      [finished(standard()), { action: 'align', alignment: { state: 'ALIGNED' } }, 'criterion c1 (A booking can be cancelled) has no evaluation under id "c1"'],
      [finished(standard()), { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: 'ok' }], missing: ['admin override'] } }, 'reported missing'],
      [standard(), aligned, 'milestone(s) m1, m2, m3, m4 not complete'],
      [drive(standard(), [{ action: 'complete', milestone: 'm1' }, { action: 'complete', milestone: 'm2' }, { action: 'complete', milestone: 'm3' }, { action: 'complete', milestone: 'm4' }]), aligned, 'gate(s) CODE, TEST, TYPE, BUILD, SECURITY, GIT not satisfied'],
      [finished(open), aligned, 'unknown(s) still open'],
      [drive(finished(standard()), [{ action: 'block', milestone: 'm5', note: 'waiting on a decision' }]), aligned, 'the task is blocked'],
    ]
    for (const [task, call, why] of cases) {
      const out = applyAction(task, call, 5, 'abc1234')
      expect(out.error).toContain(why)
      expect(out.task).toBe(task)
    }
    expect(applyAction(standard(), { action: 'align', alignment: { state: 'GREAT' } }, 5, null).error).toContain('must be')
    expect(applyAction(standard(), { action: 'align' }, 5, null).error).toBeDefined()
  })
  test('DEEP work with no declared criteria is BLOCKED, never ALIGNED, whatever evidence is offered', () => {
    const deep = drive(stage('Migrate the payments schema to the new ledger'), [PLAN, ...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })), ...pass])
    expect(deep.discovery!.level).toBe('DEEP')
    const out = applyAction(deep, { action: 'align', state: 'ALIGNED', evidence: EV }, 3, null)
    expect(out.note).toContain('CRITERIA MISSING')
    expect(out.task.alignment!.state).toBe('BLOCKED')
    expect(isAlignmentSatisfied(out.task)).toBe(false)
    const withCriteria = drive(deep, [{ action: 'discover', criteria: ['The migration completes without data loss'] }])
    expect(applyAction(withCriteria, { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: EV }] } }, 3, null).task.alignment!.state).toBe('ALIGNED')
  })
  test('PARTIAL, BLOCKED and UNKNOWN are recorded, and none of them completes the task', () => {
    for (const state of ['PARTIAL', 'BLOCKED', 'UNKNOWN']) {
      const task = drive(finished(standard()), [{ action: 'align', alignment: { state, missing: ['admin override'], assumptions: ['full refunds only'] } }, { action: 'complete', milestone: 'm5' }])
      expect(task.alignment).toMatchObject({ state, missing: ['admin override'], assumptions: ['full refunds only'] })
      expect(task.percent).toBe(80)
      expect(isAlignmentSatisfied(task)).toBe(false)
    }
  })
  test('work after the check, or a failing required gate, takes the alignment back', () => {
    const done = drive(finished(standard()), [aligned, { action: 'complete', milestone: 'm5' }])
    const edited = settle(touchFile(done, 'src/bookings.ts', 3, 1)).task
    expect(edited.alignment).toMatchObject({ state: 'PENDING', note: 'reset: files changed' })
    expect(edited.percent).toBeLessThan(100)
    const broken = settle(setGate(done, 'TEST', 'fail', 'npm test', 'auto', 20)).task
    expect(broken.alignment!.state).toBe('PENDING')
    expect(invalidateAlignment(standard(), 'x').alignment).toBeUndefined()
  })
  test('a criterion added after the check was not checked', () => {
    const done = drive(finished(standard()), [aligned])
    expect(discover(done, { criteria: ['Cancelling twice is harmless'] }, 30).task.alignment!.state).toBe('PENDING')
  })
  test('discovery is reported before any plan exists, which is when the guidance asks for it', () => {
    let task = stage('Add booking cancellation to the API and the UI')
    expect(task.milestones).toHaveLength(0)
    task = drive(task, [{ action: 'discover', criteria: ['A booking can be cancelled'], unknowns: [{ text: 'Partial refunds?' }] }, { action: 'decide', decision: { problem: 'p', chosen: 'c' } }])
    expect(summaryOf(task)).toContain('Discovery STANDARD: 1 unknown open, 1 decision, alignment decided at plan')
    expect(summaryOf(stage('Fix the typo'))).not.toContain('Discovery')
  })
  test('it never blocks LIGHT, read-only or pinned-LIGHT work, nor a task from before v0.5.1', () => {
    const light = drive(stage('Fix the typo in the README heading'), run)
    expect(needsAlignment(light)).toBe(false)
    expect(light).toMatchObject({ percent: 100, status: 'done' })
    const readonly = drive(stage('Add booking cancellation to the API and the UI'), [{ action: 'plan', kind: 'readonly', milestones: FIVE }, ...[1, 2, 3, 4, 5].map(n => ({ action: 'complete', milestone: `m${n}` }))])
    expect(readonly).toMatchObject({ percent: 100, status: 'done' })
    const pinned = drive(withDiscovery(stage('Add booking cancellation to the API and the UI'), 'LIGHT'), run)
    expect(pinned.percent).toBe(100)
    const { discovery: _d, ...legacy } = finished(standard())
    expect(percentOf(legacy as Task)).toBe(80)
    expect(summaryOf(legacy as Task)).not.toContain('Discovery')
  })
  test('a pinned LIGHT never waives a required consultation, and no discovery path reads as reviewed', () => {
    const asked = 'Ask Opus to review the cache design.'
    let task = requireReview(stage(asked), mandatoryGrounds({ prompt: asked, files: [], milestones: 0, errorStreak: 0, promptGrounds: groundsAvailable({ prompt: asked, files: [], milestones: 0, errorStreak: 0 }) }))
    expect(task.review?.state).toBe('required')
    task = withDiscovery(task, 'LIGHT')
    task = drive(task, run)
    expect(task.review?.state).toBe('required')
    expect(task.percent).toBe(80)
    // a DEEP task with the goal checked still waits for its consultation
    let deep = requireReview(stage('Migrate the payments schema'), ['release'])
    deep = drive(deep, [{ action: 'discover', criteria: ['The migration completes without data loss'] }, PLAN, ...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })), ...pass, { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: EV }] } }, { action: 'complete', milestone: 'm5' }])
    expect(deep.percent).toBe(80)
    expect(deep.review?.state).toBe('required')
  })
})

describe('bypasses found in review', () => {
  test('ALIGNED cannot be recorded before there is a plan, and a plan or replan starts the check over', () => {
    const early = applyAction(drive(stage('Add booking cancellation to the API and the UI'), [{ action: 'discover', criteria: ['A booking can be cancelled'] }]), { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: EV }] } }, 5, null)
    expect(early.error).toContain('no plan exists yet')
    const checked = drive(finished(standard()), [aligned])
    expect(checked.alignment!.state).toBe('ALIGNED')
    const replanned = drive(checked, [{ action: 'plan', replan: true, milestones: [...FIVE, { title: 'Extra' }] }])
    expect(replanned.alignment).toBeUndefined()
    expect(isAlignmentSatisfied(replanned)).toBe(false)
  })
  test('a plan restart cannot lower the level the evidence reached', () => {
    const risky = drive(stage('Add booking cancellation to the API and the UI'), [{ action: 'discover', level: 'DEEP' }, PLAN])
    expect(risky.discovery!.level).toBe('DEEP')
    const restarted = drive(risky, [{ action: 'plan', milestones: FIVE }])
    expect(restarted.id).toBe(2)
    expect(restarted.discovery!.level).toBe('DEEP')
    expect(restarted.discovery!.criteria).toEqual([])
  })
  test('a read-only plan that goes on to edit files still needs the goal check', () => {
    const task = drive(stage('Add booking cancellation to the API and the UI'), [{ action: 'plan', kind: 'readonly', milestones: FIVE }])
    const edited = settle(touchFile(task, 'src/bookings.ts', 5, 0)).task
    expect(needsAlignment(edited)).toBe(true)
    const done = drive(edited, [...[1, 2, 3, 4, 5].map(n => ({ action: 'complete', milestone: `m${n}` }))])
    expect(done.status).not.toBe('done')
  })
  test('a question or a trivial-looking noun does not hide a request to build something', () => {
    for (const p of ['How should retries work? Implement backoff in the client', 'Implement comment threading for posts', 'Add a colour picker to settings']) expect(level(p)).toBe('STANDARD')
    for (const p of ['Fix typo in README', 'Change the font size of the heading', 'How should retries work?']) expect(level(p)).toBe('LIGHT')
  })
  test('a new open unknown, or a milestone that fails after the check, takes it back', () => {
    const checked = drive(finished(standard()), [aligned])
    expect(discover(checked, { unknowns: [{ text: 'Late question' }] }, 40).task.alignment!.state).toBe('PENDING')
    expect(applyAction(checked, { action: 'fail', milestone: 'm2', note: 'broke' }, 41, null).task.alignment!.state).toBe('PENDING')
  })
  test('a task stored by v0.5.0 keeps its percent and status when it is only read', () => {
    const { discovery: _d, ...legacy } = finished(standard())
    const out = applyAction(legacy as Task, { action: 'status' }, 5, null)
    expect(out.task.discovery).toBeUndefined()
    expect(settle(out.task).task.percent).toBe(80)
  })
  test('the evidence id is a short plain token, never free text', () => {
    const out = align(finished(standard()), { alignment: { state: 'PARTIAL', demonstrated: [{ id: secret, evidence: 'x' }] } }, 5, [])
    expect(JSON.stringify(out.task)).not.toContain(secret)
  })
})

describe('the acceptance-criteria invariant', () => {
  const goal = 'Add booking cancellation to the API and the UI'
  const ev = (n: number) => `test 'criterion ${n} behaves' passes in test/api.test.js (${n} pass)`
  const ready = (criteria: string[], prompt = goal): Task => drive(stage(prompt), [...(criteria.length ? [{ action: 'discover', criteria }] : []), PLAN, ...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })), ...pass])
  const claim = (task: Task, demonstrated: Record<string, unknown>[], extra: Record<string, unknown> = {}) => applyAction(task, { action: 'align', alignment: { state: 'ALIGNED', demonstrated, ...extra } }, 9, null)
  const three = ['A booking can be cancelled', 'An unknown id returns 404', 'The freed slot can be booked again']

  test('a STANDARD task with zero criteria is BLOCKED, shows CRITERIA MISSING and cannot reach DONE', () => {
    const task = ready([])
    expect(task.discovery!.level).toBe('STANDARD')
    expect(task.discovery!.criteria).toEqual([])
    const out = claim(task, [{ id: 'c1', evidence: EV }])
    expect(out.note).toContain('CRITERIA MISSING')
    expect(out.task.alignment!.state).toBe('BLOCKED')
    expect(discoveryRows(out.task).join('\n')).toContain('CRITERIA / MISSING')
    expect(discoveryRows(out.task).join('\n')).toContain('ALIGNMENT / BLOCKED')
    const done = drive(out.task, [{ action: 'complete', milestone: 'm5' }])
    expect(done.status).not.toBe('done')
    expect(done.milestones[4]!.state).toBe('active')
    expect(summaryOf(done)).toContain('CRITERIA MISSING')
  })
  test('the completion predicate itself refuses an ALIGNED mark that has no criteria behind it', () => {
    // a hand-built or stored task claiming ALIGNED with an empty criteria set is not "all criteria met"
    const forged = { ...ready([]), alignment: { state: 'ALIGNED' as const, demonstrated: [{ id: 'e1', evidence: EV }], missing: [], assumptions: [], note: null, at: 1 } }
    expect(isAlignmentSatisfied(forged)).toBe(false)
    expect(settle(drive(forged, [{ action: 'complete', milestone: 'm5' }])).task.status).not.toBe('done')
  })
  test('a DEEP task with zero criteria cannot be ALIGNED', () => {
    const task = ready([], 'Migrate the payments schema to the new ledger')
    expect(task.discovery!.level).toBe('DEEP')
    expect(claim(task, [{ id: 'c1', evidence: EV }]).task.alignment!.state).toBe('BLOCKED')
  })
  test('one free-text evidence line cannot stand in for missing criteria', () => {
    const task = ready([])
    expect(applyAction(task, { action: 'align', state: 'ALIGNED', evidence: EV }, 9, null).task.alignment!.state).toBe('BLOCKED')
    expect(applyAction(task, { action: 'align', alignment: { state: 'ALIGNED', evidence: EV } }, 9, null).task.alignment!.state).toBe('BLOCKED')
  })
  test('one verified criterion cannot satisfy three, and neither can one line repeated three times', () => {
    const task = ready(three)
    expect(claim(task, [{ id: 'c1', evidence: ev(1) }]).error).toContain('criterion c2')
    const once = claim(task, [{ id: 'c1', evidence: ev(1) }, { id: 'c2', evidence: ev(1) }, { id: 'c3', evidence: ev(1) }])
    expect(once.error).toContain('reuses another criterion')
  })
  test('every criterion evaluated with its own observed evidence permits ALIGNED and DONE', () => {
    const task = ready(three)
    const out = claim(task, [{ id: 'c1', evidence: ev(1) }, { id: 'c2', evidence: ev(2) }, { id: 'c3', evidence: ev(3) }])
    expect(out.error).toBeUndefined()
    expect(out.task.discovery!.criteria.map(c => [c.id, c.status, c.basis])).toEqual([['c1', 'met', 'reported'], ['c2', 'met', 'reported'], ['c3', 'met', 'reported']])
    const done = drive(out.task, [{ action: 'complete', milestone: 'm5' }])
    expect(done).toMatchObject({ percent: 100, status: 'done' })
  })
  test('evidence must name an observation: bare verdicts, restated criteria and tiny strings are refused', () => {
    const task = ready(['A booking can be cancelled'])
    for (const bad of ['tests pass', 'all good, works as expected', 'A booking can be cancelled', 'ok', 'a.js line 3', 'implemented fully and verified by me']) {
      expect(claim(task, [{ id: 'c1', evidence: bad }]).error).toContain('criterion c1 evidence')
    }
    expect(claim(task, [{ id: 'c1', evidence: EV }]).error).toBeUndefined()
  })
  test('a failed or unresolved criterion blocks ALIGNED and DONE', () => {
    const task = ready(three)
    for (const status of ['failed', 'unresolved']) {
      const out = claim(task, [{ id: 'c1', evidence: ev(1) }, { id: 'c2', evidence: ev(2), status }, { id: 'c3', evidence: ev(3) }])
      expect(out.error).toContain(`criterion c2 is ${status}`)
    }
    // reporting it as PARTIAL is recorded, and does not complete
    const partial = applyAction(task, { action: 'align', alignment: { state: 'PARTIAL', demonstrated: [{ id: 'c1', evidence: ev(1) }, { id: 'c2', evidence: ev(2), status: 'failed' }] } }, 9, null).task
    expect(partial.discovery!.criteria.map(c => c.status)).toEqual(['met', 'failed', 'pending'])
    expect(drive(partial, [{ action: 'complete', milestone: 'm5' }]).status).not.toBe('done')
  })
  test('criteria must be meaningful sentences; nothing is recorded otherwise', () => {
    for (const bad of ['ok', 'works', 'done', 'tests pass']) {
      const out = applyAction(stage(goal), { action: 'discover', criteria: [bad] }, 1, null)
      expect(out.error).toContain('too short or generic')
      expect(out.task.discovery!.criteria).toEqual([])
    }
  })
  test('a new criterion, a revised one, a replan and a failing gate each void earlier evidence', () => {
    const base = claim(ready(['A booking can be cancelled']), [{ id: 'c1', evidence: ev(1) }]).task
    expect(base.alignment!.state).toBe('ALIGNED')
    const added = discover(base, { criteria: ['An unknown id returns 404'] }, 20).task
    expect([added.alignment!.state, added.discovery!.criteria[0]!.status, added.discovery!.criteria[0]!.evidence]).toEqual(['PENDING', 'pending', null])
    const revised = discover(base, { criteria: [{ id: 'c1', text: 'A booking can be cancelled by its owner only' }] }, 21).task
    expect([revised.alignment!.state, revised.discovery!.criteria[0]!.status]).toEqual(['PENDING', 'pending'])
    const replanned = drive(base, [{ action: 'plan', replan: true, milestones: FIVE }])
    expect([replanned.alignment, replanned.discovery!.criteria[0]!.status]).toEqual([undefined, 'pending'])
    const failed = settle(setGate(base, 'TEST', 'fail', 'npm test', 'auto', 22)).task
    expect([failed.alignment!.state, failed.discovery!.criteria[0]!.status]).toEqual(['PENDING', 'pending'])
  })
  test('a helper edit and a main edit void the evidence; reading files does not', () => {
    const base = claim(ready(['A booking can be cancelled']), [{ id: 'c1', evidence: ev(1) }]).task
    const helper = invalidateAlignment({ ...base, edited: true }, 'a helper changed files')
    expect([helper.alignment!.state, helper.discovery!.criteria[0]!.status]).toEqual(['PENDING', 'pending'])
    expect(settle(touchFile(base, 'src/a.ts', 1, 0)).task.alignment!.state).toBe('PENDING')
    expect(drive(base, [{ action: 'status' }]).alignment!.state).toBe('ALIGNED')
  })
  test('edits made by a helper under a read-only plan, or before a restart as read-only, still need the goal check', () => {
    const planned = drive(stage(goal), [{ action: 'plan', kind: 'readonly', milestones: FIVE }])
    const helperEdit = { ...planned, edited: true as const }
    expect(needsAlignment(helperEdit)).toBe(true)
    expect(drive(helperEdit, [...[1, 2, 3, 4, 5].map(n => ({ action: 'complete', milestone: `m${n}` }))]).status).not.toBe('done')
    const edited = settle(touchFile(drive(stage(goal), [PLAN]), 'src/a.ts', 1, 0)).task
    const restarted = drive(edited, [{ action: 'plan', kind: 'readonly', milestones: FIVE }])
    expect(restarted.edited).toBe(true)
    expect(needsAlignment(restarted)).toBe(true)
  })
  test('raising the level takes an earlier ALIGNED back, by the model, the rules or the operator', () => {
    const base = claim(ready(['A booking can be cancelled']), [{ id: 'c1', evidence: ev(1) }]).task
    expect(discover(base, { level: 'DEEP' }, 30).task.alignment!.state).toBe('PENDING')
    expect(withDiscovery(base, 'DEEP').alignment!.state).toBe('PENDING')
    expect(withDiscovery(base, null, { prompt: 'Migrate the payments schema', files: [], milestones: 0, grounds: [] }).alignment!.state).toBe('PENDING')
  })
  test('auto after a pin never lands below the level the rules had reached', () => {
    const risky = withDiscovery(stage('Migrate the payments schema to the new ledger'), null)
    expect(unpin(withDiscovery(risky, 'LIGHT')).discovery!.level).toBe('DEEP')
  })
  test('LIGHT tasks and read-only questions are not asked for criteria', () => {
    const light = drive(stage('Fix the typo in the README heading'), run)
    expect(light).toMatchObject({ percent: 100, status: 'done' })
    expect(criteriaMissing(light)).toBe(false)
    expect(discoveryRows(light).join('\n')).toContain('ALIGNMENT / NOT REQUIRED')
  })
  test('tasks stored by v0.5.0 are not given a criteria hold', () => {
    const { discovery: _d, ...legacy } = ready([])
    expect(needsAlignment(legacy as Task)).toBe(false)
    expect(isAlignmentSatisfied(legacy as Task)).toBe(true)
    expect(percentOf(legacy as Task)).toBe(80)
  })
  test('the mandatory Opus review still holds with every criterion met', () => {
    let task = requireReview(stage(goal), ['release'])
    task = drive(task, [{ action: 'discover', criteria: ['A booking can be cancelled'] }, PLAN, ...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })), ...pass])
    const out = claim(task, [{ id: 'c1', evidence: ev(1) }])
    expect(out.error).toBeUndefined()
    const done = drive(out.task, [{ action: 'complete', milestone: 'm5' }])
    expect(done.review?.state).toBe('required')
    expect(done.status).not.toBe('done')
  })
})

describe('field names a model reaches for', () => {
  test('are folded into the documented ones, and every rule still applies', () => {
    let task = drive(stage('Add booking cancellation to the API and the UI'), [{ action: 'discover', objective: 'Cancel bookings', acceptance: ['A booking can be cancelled'] }])
    expect(task.discovery).toMatchObject({ objective: 'Cancel bookings', criteria: [{ id: 'c1' }] })
    expect(applyAction(newTask(1, 'x', 0, null), { action: 'discover', criteria: ['First criterion text'] }, 1, null).note).toContain('c1 First criterion text')
    task = drive(task, [PLAN, { action: 'decide', problem: 'p', chosen: 'c', alternatives: [{ option: 'o', rejected_because: 'r' }] }])
    expect(task.decisions![0]).toMatchObject({ problem: 'p', chosen: 'c', alternatives: [{ option: 'o', rejectedBecause: 'r' }] })
    // names are mapped, nothing is invented: a bare list of rejected options has no reasons
    expect(applyAction(task, { action: 'decide', problem: 'p', chosen: 'c', alternatives: ['sqlite'] }, 2, null).error).toBeDefined()
    // a blanket evidence string cannot stand in for a declared criterion's own id
    const done = drive(task, [...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })), { action: 'gates', gates: pass.map(g => ({ gate: g.gate, state: 'pass', evidence: 'ok' })) }])
    expect(applyAction(done, { action: 'align', state: 'ALIGNED', evidence: 'npm test passes' }, 3, null).error).toContain('criterion c1')
    expect(applyAction(done, { action: 'align', state: 'ALIGNED', evidence: 'npm test passes', alignment: undefined }, 3, null).task.alignment).toBeUndefined()
    const ok = applyAction(done, { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: EV }] } }, 3, null)
    expect(ok.task.alignment!.state).toBe('ALIGNED')
    // with no declared criteria the shorthand is recorded BLOCKED, as the long form is
    const bare = drive(stage('Add booking cancellation to the API and the UI'), [PLAN, ...[1, 2, 3, 4].map(n => ({ action: 'complete', milestone: `m${n}` })), ...pass])
    expect(applyAction(bare, { action: 'align', state: 'PARTIAL', evidence: 'half done', missing: ['admin'] }, 3, null).task.alignment).toMatchObject({ state: 'PARTIAL', missing: ['admin'] })
    expect(applyAction(bare, { action: 'align', state: 'ALIGNED', evidence: EV }, 3, null).task.alignment!.state).toBe('BLOCKED')
  })
})

describe('presentation', () => {
  test('a narrow terminal gets short rows and the same facts', () => {
    const task = drive(standard(), [{ action: 'discover', goal: 'Implement booking cancellation for every booking source', unknowns: [{ text: 'Is a partial refund allowed when the booking has several guests?' }, { text: 'Second' }] }])
    for (const width of [24, 32, 80]) {
      const rows = discoveryRows(task, width)
      expect(rows.every(r => r.length <= Math.max(24, width))).toBe(true)
      expect(rows.slice(0, 7).map(r => r.split(' / ')[0])).toEqual(['COBALT', 'LEVEL', 'GOAL', 'UNKNOWNS', 'DECISIONS', 'CRITERIA', 'ALIGNMENT'])
    }
    expect(discoveryRows(task, 80).slice(1).join('\n')).toContain('LEVEL / STANDARD')
    expect(discoveryRows(task, 80).join('\n')).toContain('UNKNOWNS / 2 unresolved')
    expect(discoveryRows(task, 80).join('\n')).toContain('ALIGNMENT / PENDING')
    expect(discoveryRows(null)).toEqual(['COBALT / DISCOVERY', 'No task yet.'])
    expect(discoveryRows(stage('Fix the typo')).join('\n')).toContain('ALIGNMENT / NOT REQUIRED')
  })
})

describe('restart and replay', () => {
  test('a task with discovery, decisions and alignment survives a JSON round trip unchanged', () => {
    const task = drive(finished(standard()), [{ action: 'decide', decision: { problem: 'p', chosen: 'c', alternatives: [{ option: 'o', rejected_because: 'r' }], evidence: ['e'] } }, aligned])
    const back = JSON.parse(JSON.stringify(task)) as Task
    expect(back).toEqual(task)
    expect(summaryOf(back)).toBe(summaryOf(task))
    expect(percentOf(back)).toBe(percentOf(task))
  })
})

// --- through the host ------------------------------------------------------

const ledgerOf = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const textOf = async (p: Promise<{ text?: string }>) => String((await p).text ?? '')
const guided = (w: ReturnType<typeof world>) => w.submitted.map(s => s.context.filter(c => c.includes('Cobalt Cockpit discovery')))

describe('discovery through the host', () => {
  test('a trivial prompt gets no discovery text and no tool is needed', async ($, on) => {
    const w = world(on); hostState(on, {}); await start($)
    await prompt($, 'Fix the typo in the README heading')
    await prompt($, 'What does parseStatus do?')
    expect(guided(w)).toEqual([[], []])
    expect(w.submitted[0]?.context).toEqual([])
  })
  test('a STANDARD prompt is guided once, and a follow-up is not guided again', async ($, on) => {
    const w = world(on); hostState(on, {}); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'plan', milestones: FIVE })
    await prompt($, 'also cover the admin routes')
    const lines = guided(w)
    expect(lines[0]).toHaveLength(1)
    expect(lines[0]![0]).toContain('STANDARD')
    expect(lines[1]).toEqual([])
  })
  test('a DEEP prompt gets the architecture and risks workflow', async ($, on) => {
    const w = world(on); hostState(on, {}); await start($)
    await prompt($, 'Migrate the payments schema to the new ledger')
    expect(guided(w)[0]![0]).toContain('DEEP')
  })
  test('discover, decide and align reach DONE, the ledger and /cockpit discovery', async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    expect(await progress($, { action: 'discover', goal: 'Implement booking cancellation', criteria: ['A booking can be cancelled'], unknowns: [{ text: 'Partial refunds?' }] })).toContain('Discovery STANDARD: 1 unknown open')
    expect(await progress($, { action: 'decide', decision: { problem: 'Where to cancel', chosen: 'A service method', alternatives: [{ option: 'A trigger', rejected_because: 'hidden from tests' }], evidence: [`${secret} is not stored`] } })).toContain('1 decision')
    await progress($, { action: 'discover', unknowns: [{ id: 'u1', state: 'assumed', note: 'full refunds' }] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toContain('HELD')
    expect(await progress($, { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: EV }] } })).toContain('alignment ALIGNED')
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    const view = await textOf(command($, 'discovery'))
    expect(view).toContain('LEVEL / STANDARD')
    expect(view).toContain('DECISIONS / 1 recorded')
    expect(view).toContain('ALIGNMENT / ALIGNED')
    const l = ledgerOf(held)
    expect(l.discoveries).toMatchObject([{ taskId: 1, level: 'STANDARD', alignment: 'ALIGNED' }])
    expect(l.decisions).toHaveLength(1)
    expect(l.decisions![0]!.alternatives).toEqual([{ option: 'A trigger', rejectedBecause: 'hidden from tests' }])
    expect(JSON.stringify(l)).not.toContain(secret)
    expect(w.outbound).toEqual([])
  })
  test('the operator pins LIGHT: no goal check, and the pin is this session only', async ($, on) => {
    world(on); hostState(on, {}); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    expect(await textOf(command($, 'discovery light'))).toContain('LEVEL / LIGHT (operator)')
    await planAndComplete($, 4)
    await passAllGates($)
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    expect(await textOf(command($, 'discovery bogus'))).toContain('is not a level')
    expect(await textOf(command($, 'discovery auto'))).toContain('PIN / none')
  })
  test('errors fail safely and change nothing', async ($, on) => {
    world(on); hostState(on, {}); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    expect(await progress($, { action: 'decide', decision: { chosen: 'only this' } })).toStartWith('error:')
    expect(await progress($, { action: 'align', alignment: { state: 'ALIGNED' } })).toStartWith('error:')
    expect(await progress($, { action: 'status' })).not.toContain('1 decision')
  })
  test('with the router OFF discovery asks nobody and the level still comes from the rules', async ($, on) => {
    const w = world(on); hostState(on, {}); await start($)
    await prompt($, 'Migrate the payments schema to the new ledger')
    expect(guided(w)[0]).toHaveLength(1)
    expect(w.runs.filter(argv => argv[0] === 'decision')).toEqual([])
    expect(w.outbound).toEqual([])
  })
})
