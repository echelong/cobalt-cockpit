// Release-approval integrity: the architect's recommendation is parsed strictly, recorded once and never rewritten,
// a release review fulfils an explicit "ask Opus" only when both came from the same prompt, and a mandatory review
// raised before any plan is not lost. Mutation tests try each way of turning a NO-GO, or nothing, into a GO.

import { describe, expect, test } from 'claude-code/testing'
import { clearReview, fulfilsAsked, promptOrigin, releaseDecision, requireReview, revalidateRelease, withRelease } from '../hooks/consult'
import type { Consultation, Ledger, ReleaseRecord, ReviewRequirement, Task } from '../types'
import { FIVE, GATE_NAMES, hostState, progress, prompt, start, world } from './world'

type Engine = Parameters<typeof start>[0]
const SONNET = 'claude-sonnet-5-5'
const LED = { options: { orchestration: true, profile: 'SONNET_LED' } }
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const SWARM = 'mcp__cobalt-cockpit__swarm'
const GO = 'RATIONALE: nothing blocking.\nDECISION: GO\nFINDINGS: none above medium.'
const NO_GO = 'RATIONALE: a high defect remains.\nDECISION: NO-GO\nFINDINGS: H1 at hooks/consult.ts:1.'
const ASK = 'Have Opus review the release candidate before we tag'
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: SWARM, ...input } as never)
let seq = 0
const spawn = ($: Engine, description: string) => $.agent.spawn({ prompt: 'brief', description, subagentType: 'cobalt-cockpit:architect', tool_use_id: `ri-${++seq}`, parentModel: SONNET, provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false } as never)
const finish = ($: Engine, agentId: string, answer: string, turnId = `turn-${agentId}`) => $.turn.complete({ agentId, turnId, reason: 'answer', answer, durationMs: 20, isAborted: false } as never)
type Held = ReturnType<typeof hostState>
const ledger = (held: Held) => held.get('run-ledger')!.value as Ledger
const task = (held: Held) => held.get('task')!.value as Task
const releasePacket = { action: 'consult', ground: 'release', objective: 'Release v0.5.1', architecture: 'Plugin hooks', locations: ['hooks/consult.ts'], risk: 'Broken admission', question: 'Approve the release?' }
const text = async ($: Engine, input: Record<string, unknown>) => String((await call($, input)).result)
const records = (w: ReturnType<typeof world>) => w.storeWrites.filter(x => x.key === 'release-reviews').at(-1)?.value as ReleaseRecord[] | undefined

const finishWork = async ($: Engine) => {
  await progress($, { action: 'plan', milestones: FIVE })
  for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
  for (const g of GATE_NAMES) await progress($, { action: 'gate', gate: g, state: 'na', evidence: 'fixture' })
}
const releaseTask = async ($: Engine, ask = ASK) => { await start($); await prompt($, ask); await finishWork($) }
/** Admit a release consultation and let the architect finish; returns the consultation id and the agent. */
const admitAndReturn = async ($: Engine, held: Held, answer: string) => {
  expect(await text($, releasePacket)).toContain('OPUS ADMITTED')
  const id = ledger(held).consults!.at(-1)!.id
  const agentId = (await spawn($, `[task:${id}] Opus consultation`)).agentId!
  await finish($, agentId, answer)

  return { id, agentId }
}
const verify = ($: Engine, id: string, over: Record<string, unknown> = {}) => text($, { action: 'verify', task_id: id, state: 'pass', evidence: ['checked'], ...over })
const consult = (over: Partial<Consultation> = {}): Consultation => ({ id: 'c1', ground: 'release', key: 'k', packet: { objective: 'o', architecture: '', files: ['hooks/consult.ts'], alternatives: [], failures: [], risk: 'r', decision: 'd' }, progressTask: 1, isMandatory: true, requestedAt: 0, candidate: A, ...over })
const two = (over: Partial<ReviewRequirement> = {}): ReviewRequirement => ({ grounds: ['asked', 'release'], consult: 'c1', state: 'admitted', raised: { asked: 'o1', release: 'o1' }, ...over })

describe('strict parsing: one unambiguous DECISION line', () => {
  test('exactly GO or NO-GO on a line of its own, surrounding blanks only', () => {
    expect(releaseDecision('DECISION: GO')).toBe('go')
    expect(releaseDecision('\tDECISION: NO-GO \n')).toBe('no-go')
    expect(releaseDecision('a\r\nDECISION: GO\r\nb')).toBe('go')
  })
  test('every decorated, hedged, cased, truncated, repeated or embedded form is undefined (never approves)', () => {
    const bad = [
      'decision: go', 'Decision: GO', 'DECISION:GO', 'DECISION:  GO', 'DECISION: Go', 'DECISION: GO.', 'DECISION: GO!', 'DECISION: GO —',
      'DECISION: GO — ship it', 'DECISION: GO/NO-GO', 'DECISION: GO maybe', 'DECISION: GO unless tests fail', 'DECISION: NO', 'DECISION: NOGO',
      'DECISION: NO GO', 'DECISION: NOT GO', 'DECISION: G', 'DECISION:', '**DECISION: GO**', '`DECISION: GO`', '> DECISION: GO', '- DECISION: GO',
      '# DECISION: GO', 'RESULT DECISION: GO', 'We say DECISION: GO here', 'DECISION: GO\nDECISION: GO', 'DECISION: GO\nDECISION: NO-GO',
      'DECISION: NO-GO\nDECISION: GO', 'DECISION: NO-GO\nI would write DECISION: GO if fixed', 'DECISION: GO\n> DECISION: NO-GO', 'DECISION: GO\n**DECISION**: NO-GO',
      'DECISION: GO\nDECISION *: NO-GO', 'DECISION: GO\u200b', 'DECISION:\u00a0GO', '\uFF24\uFF25\uFF23\uFF29\uFF33\uFF29\uFF2F\uFF2E: GO', 'DECISION: GO\nDECISION`: NO-GO',
    ]
    for (const answer of bad) expect(releaseDecision(answer), JSON.stringify(answer)).toBeUndefined()
    for (const answer of [undefined, null, 0, {}, [], '', ' ', 'GO', 'NO-GO']) expect(releaseDecision(answer)).toBeUndefined()
  })
})

describe('mutation: a recorded recommendation is final', () => {
  const rec = (over: Partial<ReleaseRecord> = {}): ReleaseRecord => ({ candidate: A, id: 'x1', at: 1, returned: true, verified: 'pass', outcome: 'no-go', ...over })
  test('a later write cannot turn NO-GO into GO, or change what it was verified as', () => {
    const merged = withRelease([rec()], rec({ at: 9, verified: 'pass', outcome: 'go' }))
    expect(merged).toEqual([rec()])
    expect(withRelease([rec({ verified: 'fail' })], rec({ verified: 'pass', outcome: 'go' }))).toEqual([rec({ verified: 'fail' })])
    expect(withRelease([rec({ outcome: 'go' })], rec({ outcome: 'no-go' }))).toEqual([rec({ outcome: 'go' })])
  })
  test('before a recommendation exists, the record may still gain one, and a flag never goes back', () => {
    const open = rec({ verified: undefined, outcome: undefined })
    delete (open as Partial<ReleaseRecord>).verified
    delete (open as Partial<ReleaseRecord>).outcome
    expect(withRelease([open], rec({ returned: false, outcome: 'go', verified: 'pass' }))).toEqual([rec({ outcome: 'go' })])
    expect(withRelease([rec()], rec({ returned: false }))[0]?.returned).toBe(true)
  })
  test('the candidate and the time of a record are never rewritten', () => {
    expect(withRelease([rec()], rec({ candidate: B, at: 99 }))).toEqual([rec()])
  })
  test('through the host: a recorded NO-GO cannot be judged again as GO, and nothing is cleared', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    const { id } = await admitAndReturn($, held, NO_GO)
    await verify($, id, { release_outcome: 'no-go' })
    expect(records(w)).toMatchObject([{ id, outcome: 'no-go', verified: 'pass' }])
    const again = await verify($, id, { release_outcome: 'go' })
    expect(again).toContain('RECORDED')
    expect(records(w)).toMatchObject([{ id, outcome: 'no-go' }])
    expect(task(held).review?.cleared ?? []).toEqual([])
    expect(task(held).percent).toBeLessThan(100)
  })
})

describe('immutable architect answers through the host', () => {
  test('a later turn of a returned architect is kept apart and cannot flip its NO-GO to GO', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($)
    const { id, agentId } = await admitAndReturn($, held, NO_GO)
    const first = ledger(held).observedCompletions!.find(c => c.agentId === agentId)!
    expect(first.decision).toBe('no-go')
    await finish($, agentId, GO, 'turn-resume-1')
    const kept = ledger(held).observedCompletions!.find(c => c.agentId === agentId)!
    expect(kept.decision).toBe('no-go')
    expect(kept.conclusion).toBe(first.conclusion)
    expect(kept.later).toMatchObject([{ decision: 'go' }])
    const verdict = await verify($, id, { release_outcome: 'go' })
    expect(verdict).toContain('NO-GO')
    expect(task(held).review?.cleared ?? []).toEqual([])
  })
  test('a later turn cannot downgrade a returned GO either: the first answer stands, the later one is only recorded', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($)
    const { id, agentId } = await admitAndReturn($, held, GO)
    await finish($, agentId, NO_GO, 'turn-resume-2')
    expect(ledger(held).observedCompletions!.find(c => c.agentId === agentId)).toMatchObject({ decision: 'go', later: [{ decision: 'no-go' }] })
    expect(ledger(held).consults!.find(c => c.id === id)).toBeDefined()
  })
  test('only the last four later turns are kept', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($)
    const { agentId } = await admitAndReturn($, held, GO)
    for (let i = 0; i < 6; i++) await finish($, agentId, NO_GO, `turn-more-${i}`)
    expect(ledger(held).observedCompletions!.find(c => c.agentId === agentId)!.later).toHaveLength(4)
  })
})

describe('asked and release grounds', () => {
  test('a matching pair, raised by one prompt, is cleared by one release review, with provenance', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($)
    expect(task(held).review?.grounds).toEqual(expect.arrayContaining(['asked', 'release']))
    const { id } = await admitAndReturn($, held, GO)
    await verify($, id, { release_outcome: 'go' })
    expect(task(held).review).toMatchObject({ state: 'adjudicated', candidate: A })
    expect(task(held).review?.cleared).toEqual(expect.arrayContaining([{ ground: 'release', consult: id, candidate: A }, { ground: 'asked', consult: id, via: 'release' }]))
  })
  test('an asked ground raised by another prompt is not fulfilled by the release review', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($, 'Please approve the release of v0.5.1 after checking everything')
    held.get('task')!.value = { ...task(held), review: { grounds: ['asked', 'release'], consult: null, state: 'required', raised: { asked: promptOrigin('Ask Opus about the cache design'), release: promptOrigin('Please approve the release of v0.5.1 after checking everything') } } }
    const { id } = await admitAndReturn($, held, GO)
    await verify($, id, { release_outcome: 'go' })
    expect(task(held).review?.state).toBe('required')
    expect(task(held).review?.cleared).toEqual([{ ground: 'release', consult: id, candidate: A }])
    expect(task(held).percent).toBeLessThan(100)
  })
  test('a legacy review with no recorded origin never fulfils asked', () => {
    const { raised: _r, ...legacy } = two()
    expect(fulfilsAsked(legacy, consult())).toBe(false)
    expect(fulfilsAsked(two({ raised: { release: 'o1' } }), consult())).toBe(false)
    expect(fulfilsAsked(two({ raised: { asked: 'o1' } }), consult())).toBe(false)
  })
  test('fulfilsAsked needs the same origin, the admitted consultation, a mandatory one that named files, and a release ground', () => {
    expect(fulfilsAsked(two(), consult())).toBe(true)
    expect(fulfilsAsked(two({ raised: { asked: 'o1', release: 'o2' } }), consult())).toBe(false)
    expect(fulfilsAsked(two({ consult: 'other' }), consult())).toBe(false)
    expect(fulfilsAsked(two({ consult: null }), consult())).toBe(false)
    expect(fulfilsAsked(two(), consult({ isMandatory: false }))).toBe(false)
    expect(fulfilsAsked(two(), consult({ packet: { ...consult().packet, files: [] } }))).toBe(false)
    expect(fulfilsAsked(two(), consult({ ground: 'asked' }))).toBe(false)
    expect(fulfilsAsked(two({ grounds: ['release'] }), consult())).toBe(false)
    expect(fulfilsAsked(two({ grounds: ['asked'] }), consult())).toBe(false)
    expect(fulfilsAsked(two({ cleared: [{ ground: 'asked', consult: 'old' }] }), consult())).toBe(false)
  })
  test('it clears no other ground: security and architecture stay open', () => {
    const r = two({ grounds: ['asked', 'release', 'security', 'architecture'], raised: { asked: 'o1', release: 'o1', security: 'o1', architecture: 'o1' } })
    const out = clearReview(r, consult(), 'pass', 'go', A)!
    expect(out.cleared?.map(c => c.ground).sort()).toEqual(['asked', 'release'])
    expect(out.state).toBe('required')
  })
  test('a NO-GO, a failed verification or a moved commit clears neither release nor asked', () => {
    for (const [state, outcome, now] of [['pass', 'no-go', A], ['fail', 'go', A], ['pass', undefined, A], ['pass', 'go', B], ['pass', 'go', null]] as const) {
      expect(clearReview(two(), consult(), state, outcome, now)?.cleared ?? [], `${state} ${outcome} ${now}`).toEqual([])
    }
  })
  test('when the commit moves, the release approval and the asked clearance it carried are withdrawn together', () => {
    const held = clearReview(two(), consult(), 'pass', 'go', A)!
    expect(held.state).toBe('adjudicated')
    const moved = revalidateRelease(held, { sha: B }, [])
    expect(moved.state).toBe('required')
    expect(moved.cleared ?? []).toEqual([])
  })
  test('an asked clearance of its own is kept when the release approval is withdrawn', () => {
    const r = two({ cleared: [{ ground: 'asked', consult: 'mine' }], raised: { asked: 'o1', release: 'o1' } })
    const held: ReviewRequirement = { ...r, cleared: [...r.cleared!, { ground: 'release', consult: 'c1', candidate: A }], candidate: A, state: 'adjudicated' }
    expect(revalidateRelease(held, { sha: B }, []).cleared).toEqual([{ ground: 'asked', consult: 'mine' }])
  })
})

describe('origins are remembered with the ground', () => {
  const base = { id: 1 } as unknown as Task
  test('a ground keeps the origin of the prompt that first raised it', () => {
    const one = requireReview(base, ['release'], 'p1')
    const two = requireReview(one, ['release', 'asked'], 'p2')
    expect(two.review?.raised).toEqual({ release: 'p1', asked: 'p2' })
    expect(requireReview(two, ['asked'], 'p3')).toBe(two)
  })
  test('without an origin nothing is stamped', () => {
    expect(requireReview(base, ['release']).review?.raised).toBeUndefined()
  })
  test('the origin is a stable key of the normalised prompt', () => {
    expect(promptOrigin('Have  Opus review\nthe release')).toBe(promptOrigin('have opus review the release'))
    expect(promptOrigin('a')).not.toBe(promptOrigin('b'))
  })
})

describe('a mandatory review raised before any plan persists', () => {
  test('a later prompt on the unplanned task keeps the owed review, and it still blocks DONE', LED, async ($, on) => {
    world(on); const held = hostState(on, {})
    await start($)
    await prompt($, ASK)
    const before = task(held)
    expect(before.review?.state).toBe('required')
    await prompt($, 'Also tidy the README wording')
    expect(task(held).review?.grounds).toEqual(before.review!.grounds)
    expect(task(held).review?.state).toBe('required')
    await finishWork($)
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toContain('HELD')
    expect(task(held).percent).toBeLessThan(100)
  })
  test('the owed review is not carried into a finished task', LED, async ($, on) => {
    world(on); const held = hostState(on, {})
    await releaseTask($)
    const { id } = await admitAndReturn($, held, GO)
    await verify($, id, { release_outcome: 'go' })
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    await prompt($, 'Fix a typo in the docs')
    expect(task(held).review?.state ?? 'adjudicated').toBe('adjudicated')
  })
})
