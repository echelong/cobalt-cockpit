// The release-approval state machine, through the host. Four things stay apart: a consultation RETURNED (the host saw
// the architect finish), its advice VERIFIED (the main session judged it, pass or fail), a release RECOMMENDATION
// (GO or NO-GO, read off the architect's own returned DECISION line and confirmed by the main session), and the review
// SATISFIED (every ground cleared by a consultation of its own ground, the release ground only by a returned, verified
// GO for the exact clean commit). Owner approval to publish is a fifth thing, and nothing here records or implies it.

import { describe, expect, test } from 'claude-code/testing'
import { clearReview, consultVerdict, releaseEligible, releaseDecision, statusOf, withRelease } from '../hooks/consult'
import { admitTask, bindAgent, configureSwarm, emptySwarm, finishTask, submitTask, SONNET_LED_SWARM } from '../hooks/swarm'
import type { Consultation, Ledger, ReleaseRecord, ReviewRequirement, Swarm, Task } from '../types'
import { FIVE, GATE_NAMES, hostState, progress, prompt, start, world } from './world'

type Engine = Parameters<typeof start>[0]
const SONNET = 'claude-sonnet-5-5'
const LED = { options: { orchestration: true, profile: 'SONNET_LED' } }
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const SWARM = 'mcp__cobalt-cockpit__swarm'
const GO = 'RATIONALE: nothing blocking.\nDECISION: GO\nFINDINGS: none above medium.'
const NO_GO = 'RATIONALE: a high defect remains.\nDECISION: NO-GO\nFINDINGS: H1 at hooks/consult.ts:1.'
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: SWARM, ...input } as never)
let seq = 0
const spawn = ($: Engine, description: string) => $.agent.spawn({ prompt: 'brief', description, subagentType: 'cobalt-cockpit:architect', tool_use_id: `rs-${++seq}`, parentModel: SONNET, provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false } as never)
const finish = ($: Engine, agentId: string, answer: string) => $.turn.complete({ agentId, turnId: `turn-${agentId}`, reason: 'answer', answer, durationMs: 20, isAborted: false } as never)
type Held = ReturnType<typeof hostState>
const ledger = (held: Held) => held.get('run-ledger')!.value as Ledger
const task = (held: Held) => held.get('task')!.value as Task
const releasePacket = { action: 'consult', ground: 'release', objective: 'Release v0.5.1', architecture: 'Plugin hooks', locations: ['hooks/consult.ts'], risk: 'Broken admission', question: 'Approve the release?' }
const askedPacket = { action: 'consult', ground: 'asked', objective: 'Design review', architecture: 'Plugin hooks', locations: ['hooks/consult.ts'], risk: 'Wrong design', question: 'Is the design sound?' }
const SECURE = 'Please approve the release of v0.5.1; the security of the credentials handling matters'
const securityPacket = { ...askedPacket, ground: 'security' }
const text = async ($: Engine, input: Record<string, unknown>) => String((await call($, input)).result)
const records = (w: ReturnType<typeof world>) => w.storeWrites.filter(x => x.key === 'release-reviews').at(-1)?.value as ReleaseRecord[] | undefined

const finishWork = async ($: Engine) => {
  await progress($, { action: 'plan', milestones: FIVE })
  for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
  for (const g of GATE_NAMES) await progress($, { action: 'gate', gate: g, state: 'na', evidence: 'fixture' })
}
const releaseTask = async ($: Engine, ask = 'Please approve the release of v0.5.1 after checking everything') => {
  await start($)
  await prompt($, ask)
  await finishWork($)
}
/** Admit a consultation, let the architect finish with `answer`, and return its id. */
const consultAndReturn = async ($: Engine, held: Held, packet: Record<string, unknown>, answer: string) => {
  expect(await text($, packet)).toContain('OPUS ADMITTED')
  const id = ledger(held).consults!.at(-1)!.id
  await finish($, (await spawn($, `[task:${id}] Opus consultation`)).agentId!, answer)

  return id
}
const verify = ($: Engine, id: string, over: Record<string, unknown> = {}) => text($, { action: 'verify', task_id: id, state: 'pass', evidence: ['checked'], ...over })
/** A full release review: consult, return, verify. The outcome is the main session's confirmation of what the architect said. */
const review = async ($: Engine, held: Held, answer: string, outcome?: 'go' | 'no-go', state: 'pass' | 'fail' = 'pass') => {
  const id = await consultAndReturn($, held, releasePacket, answer)
  const verdict = await verify($, id, { state, ...(outcome === undefined ? {} : { release_outcome: outcome }) })

  return { id, verdict }
}
const laterTask = async ($: Engine, ask = 'Now approve the release of v0.5.1 and cut a tag') => {
  await prompt($, ask)
  await finishWork($)
}

describe('the architect’s recommendation is read, not declared', () => {
  test('releaseDecision reads exactly one DECISION line, and fails closed on anything else', () => {
    expect(releaseDecision(GO)).toBe('go')
    expect(releaseDecision(NO_GO)).toBe('no-go')
    expect(releaseDecision('DECISION: GO')).toBe('go')
    expect(releaseDecision('  DECISION: NO-GO  \r\nmore')).toBe('no-go')
    for (const bad of [undefined, '', 'GO', 'The release looks fine.', 'DECISION: maybe', 'DECISION: GO\nDECISION: NO-GO', 'DECISION: NOT GO', 'decision: go']) expect(releaseDecision(bad)).toBeUndefined()
  })
  test('a GO the main session declares over an architect NO-GO is refused and clears nothing', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    const { verdict } = await review($, held, NO_GO, 'go')
    expect(verdict).toContain('NO-GO')
    expect(task(held).review?.state).not.toBe('adjudicated')
    expect(task(held).review?.cleared ?? []).toEqual([])
    expect(records(w)?.[0]?.outcome).not.toBe('go')
  })
  for (const [name, answer] of [['missing', 'The release looks fine.'], ['ambiguous', 'DECISION: GO\nDECISION: NO-GO']] as const) {
    test(`a ${name} recommendation fails closed`, LED, async ($, on) => {
      const w = world(on); const held = hostState(on, {}); await releaseTask($)
      const { verdict } = await review($, held, answer, 'go')
      expect(verdict).toContain('DECISION')
      expect(task(held).review?.cleared ?? []).toEqual([])
      expect(task(held).percent).toBeLessThan(100)
      expect(records(w)?.[0]?.outcome).not.toBe('go')
    })
  }
  test('the main session may be stricter than the architect, never looser', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    await review($, held, GO, 'no-go')
    expect(task(held).review?.cleared ?? []).toEqual([])
    expect(records(w)).toMatchObject([{ returned: true, verified: 'pass', outcome: 'no-go' }])
  })
  test('the recommendation is bound to the release consultation: another ground’s answer cannot carry a GO', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($, 'Have Opus review the release candidate')
    held.get('task')!.value = { ...task(held), review: { grounds: ['asked', 'release'], consult: null, state: 'required' } }
    const id = await consultAndReturn($, held, askedPacket, GO)
    await verify($, id, { release_outcome: 'go' })
    expect(task(held).review?.cleared).toEqual([{ ground: 'asked', consult: id }])
    expect(task(held).review?.state).toBe('required')
  })
})

describe('H1: a reviewed commit satisfies a later release task without a second consultation', () => {
  test('a returned, verified GO for the exact clean commit is reused, with provenance, and nothing more is spent', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    const { id } = await review($, held, GO, 'go')
    expect(task(held).review).toMatchObject({ state: 'adjudicated', candidate: A })
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    await laterTask($)
    expect(await text($, releasePacket)).toContain('DUPLICATE')
    expect(ledger(held).consults).toHaveLength(1)
    expect(task(held).review).toMatchObject({ state: 'adjudicated', candidate: A, cleared: [{ ground: 'release', consult: id, candidate: A, reused: true }] })
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    expect(records(w)).toMatchObject([{ id, candidate: A, returned: true, verified: 'pass', outcome: 'go' }])
  })
  test('a restart (new world, same store) reuses the stored GO for the same commit', LED, async ($, on) => {
    world(on, {}, { 'release-reviews': [{ candidate: A, id: 'opus-1-aaaaaa', at: 1, returned: true, verified: 'pass', outcome: 'go' }] }); const held = hostState(on, {}); await releaseTask($)
    expect(await text($, releasePacket)).toContain('DUPLICATE')
    expect(task(held).review).toMatchObject({ state: 'adjudicated', cleared: [{ ground: 'release', consult: 'opus-1-aaaaaa', candidate: A, reused: true }] })
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
  })
  test('a returned NO-GO never approves a release, now or in a later task', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    await review($, held, NO_GO, 'no-go')
    expect(task(held).review?.state).not.toBe('adjudicated')
    expect(records(w)).toMatchObject([{ returned: true, verified: 'pass', outcome: 'no-go' }])
    expect(await text($, releasePacket)).toContain('DUPLICATE')
    await progress($, { action: 'status' })
    expect(task(held).review?.cleared ?? []).toEqual([])
    expect(task(held).percent).toBeLessThan(100)
  })
  test('verified advice is not a GO: a pass with no outcome clears nothing', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    const { verdict } = await review($, held, GO)
    expect(verdict).toContain('release_outcome')
    expect(task(held).review?.state).not.toBe('adjudicated')
    expect(task(held).percent).toBeLessThan(100)
    expect(records(w)?.[0]?.outcome).toBeUndefined()
  })
  test('advice judged wrong (fail) is never an approval', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    await review($, held, GO, 'go', 'fail')
    expect(task(held).review?.state).not.toBe('adjudicated')
    expect(records(w)).toMatchObject([{ returned: true, verified: 'fail' }])
    expect(records(w)?.[0]?.outcome).not.toBe('go')
  })
  test('returned but not verified, failed verification, never returned, or a legacy record: none satisfy a task', LED, async ($, on) => {
    const stored = [
      { candidate: A, id: 'opus-1-aaaaaa', at: 1, returned: true },
      { candidate: A, id: 'opus-2-aaaaaa', at: 2, returned: true, verified: 'pending' },
      { candidate: A, id: 'opus-3-aaaaaa', at: 3, returned: false, verified: 'pass', outcome: 'go' },
      { candidate: A, id: 'opus-4-aaaaaa', at: 4, returned: true, verified: 'fail', outcome: 'go' },
    ] as ReleaseRecord[]
    world(on, {}, { 'release-reviews': stored }); const held = hostState(on, {}); await releaseTask($)
    await progress($, { action: 'status' })
    expect(task(held).review?.state).toBe('required')
    expect(task(held).review?.cleared ?? []).toEqual([])
    expect(releaseEligible(stored, A)).toBeUndefined()
  })
  test('a review of one commit never approves another', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    await review($, held, GO, 'go')
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    w.head = B
    await laterTask($)
    expect(task(held).review?.state).toBe('required')
    expect(task(held).review?.cleared ?? []).toEqual([])
    expect(await text($, releasePacket)).toContain('OPUS ADMITTED')
  })
  test('the eligibility rule binds the record to the exact commit and a GO that was verified', () => {
    const go: ReleaseRecord = { candidate: A, id: 'x1', at: 1, returned: true, verified: 'pass', outcome: 'go' }
    expect(releaseEligible([go], A)).toBe(go)
    expect(releaseEligible([go], B)).toBeUndefined()
    expect(releaseEligible([{ ...go, outcome: 'no-go' }], A)).toBeUndefined()
    expect(releaseEligible([{ ...go, verified: 'fail' }], A)).toBeUndefined()
    expect(releaseEligible([go, { ...go, id: 'x2', at: 2, outcome: 'no-go' }], A)).toBeUndefined()
  })
})

describe('H2: only a release-ground consultation can satisfy the release component', () => {
  const both = async ($: Engine, held: Held) => {
    await releaseTask($, 'Have Opus review the release candidate before we tag')
    held.get('task')!.value = { ...task(held), review: { grounds: ['asked', 'release'], consult: null, state: 'required' } }
  }
  test('a cancelled release attempt cannot lend its commit to a later architecture consultation', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await both($, held)
    expect(await text($, releasePacket)).toContain('OPUS ADMITTED')
    const dead = ledger(held).consults!.at(-1)!.id
    await call($, { action: 'cancel', task_id: dead })
    const id = await consultAndReturn($, held, askedPacket, GO)
    expect(id).not.toBe(dead)
    await verify($, id)
    expect(task(held).review?.state).not.toBe('adjudicated')
    expect(task(held).review?.candidate).toBeUndefined()
    expect(task(held).review?.cleared).toEqual([{ ground: 'asked', consult: id }])
    expect(task(held).percent).toBeLessThan(100)
  })
  test('a release consultation does not silently satisfy an independent security ground', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($, SECURE)
    held.get('task')!.value = { ...task(held), review: { grounds: ['security', 'release'], consult: null, state: 'required' } }
    const { id } = await review($, held, GO, 'go')
    expect(task(held).review).toMatchObject({ state: 'required', cleared: [{ ground: 'release', consult: id, candidate: A }] })
    expect(task(held).percent).toBeLessThan(100)
  })
  test('security cleared first does not satisfy release; both together do', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($, SECURE)
    held.get('task')!.value = { ...task(held), review: { grounds: ['security', 'release'], consult: null, state: 'required' } }
    const sid = await consultAndReturn($, held, securityPacket, 'DECISION: sound')
    await verify($, sid)
    expect(task(held).review).toMatchObject({ state: 'required', cleared: [{ ground: 'security', consult: sid }] })
    const { id: rid } = await review($, held, GO, 'go')
    expect(task(held).review?.state).toBe('adjudicated')
    expect(task(held).review?.cleared?.map(c => c.ground).sort()).toEqual(['release', 'security'])
    expect(task(held).review?.cleared?.find(c => c.ground === 'release')?.consult).toBe(rid)
  })
  test('clearReview is the one place a consultation clears a ground: ground, commit and recommendation all checked', () => {
    const c = (over: Partial<Consultation>): Consultation => ({ id: 'c1', ground: 'release', key: 'k', packet: { objective: 'o', architecture: '', files: [], alternatives: [], failures: [], risk: 'r', decision: 'd' }, progressTask: 1, isMandatory: true, requestedAt: 0, candidate: A, ...over })
    const r: ReviewRequirement = { grounds: ['asked', 'release'], consult: 'c1', state: 'admitted' }
    expect(clearReview(r, c({}), 'pass', 'go', A)?.cleared).toEqual([{ ground: 'release', consult: 'c1', candidate: A }])
    expect(clearReview(r, c({}), 'pass', 'go', B)?.cleared ?? []).toEqual([])
    expect(clearReview(r, c({}), 'pass', 'no-go', A)?.cleared ?? []).toEqual([])
    expect(clearReview(r, c({}), 'pass', undefined, A)?.cleared ?? []).toEqual([])
    expect(clearReview(r, c({}), 'fail', 'go', A)?.cleared ?? []).toEqual([])
    expect(clearReview(r, c({ candidate: undefined }), 'pass', 'go', A)?.cleared ?? []).toEqual([])
    expect(clearReview(r, c({ ground: 'asked', candidate: undefined }), 'pass', 'go', A)?.cleared).toEqual([{ ground: 'asked', consult: 'c1' }])
    expect(clearReview(r, c({ ground: 'architecture' }), 'pass', 'go', A)).toBe(r)
  })
})

describe('M4: an unknown git answer neither grants, restores, nor promotes an approval, and destroys nothing', () => {
  test('no approval stands for a commit that moved, and an unknown answer promotes nothing', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    const { id } = await review($, held, GO, 'go')
    w.head = B
    await progress($, { action: 'status' })
    expect(task(held).review?.state).toBe('required')
    w.gitStatus = null
    await progress($, { action: 'status' })
    expect(task(held).review?.state).toBe('required')
    expect(task(held).review?.cleared ?? []).toEqual([])
    expect(records(w)?.find(r => r.id === id)).toMatchObject({ candidate: A, verified: 'pass', outcome: 'go' })
  })
  test('a withdrawn approval is not restored on an unknown answer, and is on the exact clean commit', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    const { id } = await review($, held, GO, 'go')
    const saved = w.gitStatus
    w.uncommitted = true
    await progress($, { action: 'status' })
    expect(task(held).review?.state).toBe('required')
    expect(task(held).review?.cleared ?? []).toEqual([])
    w.uncommitted = false
    w.gitStatus = null
    await progress($, { action: 'status' })
    expect(task(held).review?.state).toBe('required')
    w.gitStatus = saved
    await progress($, { action: 'status' })
    expect(task(held).review).toMatchObject({ state: 'adjudicated', candidate: A, cleared: [{ ground: 'release', consult: id, candidate: A, reused: true }] })
  })
  test('an approval already held is kept, not withdrawn, while git does not answer', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    await review($, held, GO, 'go')
    w.gitStatus = null
    await progress($, { action: 'status' })
    expect(task(held).review?.state).toBe('adjudicated')
  })
  test('reverting to the reviewed commit gives the approval back; a different one does not', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    await review($, held, GO, 'go')
    w.head = B
    await progress($, { action: 'status' })
    expect(task(held).review?.state).toBe('required')
    w.head = A
    await progress($, { action: 'status' })
    expect(task(held).review?.state).toBe('adjudicated')
  })
})

describe('M2: release records are written one at a time, verified when read back, and never lose what they hold', () => {
  test('simultaneous consultation and housekeeping keep every attempt, and a flag never goes back', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    const first = await review($, held, NO_GO, 'no-go')
    w.head = B
    const burst = await Promise.all([text($, releasePacket), progress($, { action: 'status' }), progress($, { action: 'status' }), progress($, { action: 'status' })])
    expect(burst[0]).toContain('OPUS ADMITTED')
    const ids = records(w)!.map(r => r.id)
    expect(ids).toContain(first.id)
    expect(ids).toContain(ledger(held).consults!.at(-1)!.id)
    expect(records(w)!.find(r => r.id === first.id)).toMatchObject({ returned: true, verified: 'pass', outcome: 'no-go' })
  })
  test('withRelease merges by id and never lowers what a record already says', () => {
    const full: ReleaseRecord = { candidate: A, id: 'x1', at: 1, returned: true, verified: 'pass', outcome: 'go' }
    expect(withRelease([full], { candidate: A, id: 'x1', at: 1, returned: false })).toEqual([full])
    expect(withRelease([{ candidate: A, id: 'x1', at: 1, returned: false }], full)).toEqual([full])
    expect(withRelease([full], { candidate: B, id: 'x1', at: 2, returned: true })[0]?.candidate).toBe(A)
  })
})

describe('M1: one reading of the terminal states', () => {
  const ledSwarm = (): Swarm => configureSwarm(emptySwarm(), SONNET_LED_SWARM)
  const opus = (swarm: Swarm, id: string): Swarm => submitTask(swarm, { id, tier: 'OPUS', role: 'REVIEW', objective: id, owned: [`/r/${id}`], mode: 'read' }, 0).swarm
  const running = (swarm: Swarm, id: string): Swarm => bindAgent(admitTask(opus(swarm, id), id, 1).swarm, id, `a-${id}`, 1)
  const consult = (id: string): Consultation => ({ id, ground: 'release', key: 'k', packet: { objective: 'o', architecture: '', files: [], alternatives: [], failures: [], risk: 'r', decision: 'd' }, progressTask: 1, isMandatory: true, requestedAt: 0, candidate: A })
  const ask = (swarm: Swarm, consults: Consultation[]) => consultVerdict({ profile: 'SONNET_LED', ground: 'release', packet: consult('x').packet, facts: { prompt: 'Approve the release', files: ['README.md'], milestones: 2, errorStreak: 0 }, consults, swarm, progressTask: 1, candidate: A, history: [] })
  test('an escalated release consultation is a spent attempt, not a returned review: a retry is admitted, once', () => {
    const live = running(ledSwarm(), 'r1')
    const escalated: Swarm = { ...live, tasks: live.tasks.map(t => (t.id === 'r1' ? { ...t, state: 'escalated' as const } : t)) }
    expect(statusOf(escalated.tasks.find(x => x.id === 'r1'))).toBe('escalated')
    expect(ask(escalated, [consult('r1')])).toMatchObject({ ok: true })
  })
  test('a completed Opus task no agent was seen to finish is not a returned review', () => {
    const done = finishTask(admitTask(opus(ledSwarm(), 'r1'), 'r1', 1).swarm, 'r1', 'completed', { conclusion: 'filed by hand' }, 2)
    expect(statusOf(done.tasks.find(x => x.id === 'r1'))).toBe('failed')
    expect(ask(done, [consult('r1')])).toMatchObject({ ok: true })
  })
})
