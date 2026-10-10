// The budget of a mandatory release review: separate from the three discretionary consultations, tied to one
// full commit id, bounded, and never satisfied by another commit. Pure rules first, then the same rules through the host.

import { describe, expect, test } from 'claude-code/testing'
import { addConsult, briefOf, consultVerdict, isCandidate, problemKey, withRelease, MAX_DISCRETIONARY_LEDGER, MAX_PER_TASK, MAX_RELEASE_ATTEMPTS, MAX_RELEASE_RECORDS, MAX_RELEASE_SESSION } from '../hooks/consult'
import type { ConsultFacts } from '../hooks/consult'
import { emptyLedger, migrateLedger, storageLedger } from '../hooks/ledger'
import { admitTask, bindAgent, configureSwarm, emptySwarm, finishTask, submitTask, SONNET_LED_SWARM } from '../hooks/swarm'
import type { Consultation, EvidencePacket, Ledger, ReleaseRecord, Swarm, Task } from '../types'
import { FIVE, GATE_NAMES, hostState, progress, prompt, start, world } from './world'

type Engine = Parameters<typeof start>[0]
const SONNET = 'claude-sonnet-5-5'
const LED = { options: { orchestration: true, profile: 'SONNET_LED' } }
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const facts = (over: Partial<ConsultFacts> = {}): ConsultFacts => ({ prompt: 'Approve the release of v0.5.1', files: ['README.md'], milestones: 2, errorStreak: 0, ...over })
const packet = (over: Partial<EvidencePacket> = {}): EvidencePacket => ({ objective: 'Choose the cache layer', architecture: 'Single process', files: ['src/cache.ts'], alternatives: ['LRU', 'SQLite'], failures: [], risk: 'Stale reads', decision: 'Which design?', ...over })
const ledSwarm = (): Swarm => configureSwarm(emptySwarm(), SONNET_LED_SWARM)
const consult = (id: string, ground: Consultation['ground'], over: Partial<Consultation> = {}): Consultation => ({ id, ground, key: problemKey(ground, packet({ decision: id })), packet: packet({ decision: id }), progressTask: 1, isMandatory: ground === 'release', requestedAt: 0, ...over })
/** A consultation as a swarm task: returned, failed or still open. */
const ran = (swarm: Swarm, id: string, how: 'returned' | 'failed' | 'open'): Swarm => {
  const queued = submitTask(swarm, { id, tier: 'OPUS', role: 'REVIEW', objective: id, owned: [`/r/${id}`], mode: 'read' }, 0).swarm
  if (how === 'open') return queued

  return finishTask(bindAgent(admitTask(queued, id, 1).swarm, id, `a-${id}`, 1), id, how === 'returned' ? 'completed' : 'failed', how === 'returned' ? { conclusion: 'ok' } : null, 2)
}
const ask = (over: Record<string, unknown> = {}) => ({ profile: 'SONNET_LED' as const, ground: 'release' as const, packet: packet(), facts: facts(), consults: [] as Consultation[], swarm: ledSwarm(), progressTask: 1, candidate: A, history: [] as ReleaseRecord[], ...over })
const refused = (v: ReturnType<typeof consultVerdict>) => (v.ok ? 'ADMITTED' : v.reason)

describe('the discretionary budget is unchanged and the release allowance is separate', () => {
  test('three discretionary consultations, then a mandatory release review is still admitted', () => {
    let swarm = ledSwarm()
    const spent: Consultation[] = []
    for (const id of ['x1', 'x2', 'x3']) { swarm = ran(swarm, id, 'returned'); spent.push(consult(id, 'architecture', { isMandatory: false })) }
    expect(MAX_PER_TASK).toBe(3)
    const arch = { ground: 'architecture' as const, facts: facts({ prompt: 'Redesign the data model', files: ['a/x.ts', 'b/y.ts', 'c/z.ts'] }), packet: packet({ decision: 'a fourth' }) }
    expect(refused(consultVerdict(ask({ ...arch, consults: spent, swarm })))).toContain('TASK BUDGET')
    expect(consultVerdict(ask({ consults: spent, swarm }))).toMatchObject({ ok: true, isMandatory: true })
  })
  test('resetting the task does not give more discretionary consultations: the ledger has its own bound', () => {
    let swarm = ledSwarm()
    const spent: Consultation[] = []
    for (let i = 0; i < MAX_DISCRETIONARY_LEDGER; i++) { swarm = ran(swarm, `d${i}`, 'returned'); spent.push(consult(`d${i}`, 'architecture', { progressTask: 1 + Math.floor(i / 3), isMandatory: false })) }
    const arch = { ground: 'architecture' as const, facts: facts({ prompt: 'Redesign the data model', files: ['a/x.ts', 'b/y.ts', 'c/z.ts'] }), packet: packet({ decision: 'one more' }), progressTask: 99 }
    expect(refused(consultVerdict(ask({ ...arch, consults: spent, swarm })))).toContain('LEDGER BUDGET')
  })
  test('release consultations are not counted against either discretionary bound', () => {
    const only = Array.from({ length: 2 }, (_, i) => consult(`r${i}`, 'release', { candidate: B }))
    const arch = { ground: 'architecture' as const, facts: facts({ prompt: 'Redesign the data model', files: ['a/x.ts', 'b/y.ts', 'c/z.ts'] }), packet: packet({ decision: 'design' }) }
    expect(consultVerdict(ask({ ...arch, consults: only, swarm: ran(ran(ledSwarm(), 'r0', 'failed'), 'r1', 'failed') }))).toMatchObject({ ok: true })
  })
})

describe('a release review is tied to one full commit id', () => {
  test('an unidentifiable candidate fails closed', () => {
    for (const candidate of [null, undefined, '', 'HEAD', 'abc1234', 'A'.repeat(40), 'g'.repeat(40), `${A}\n`, 'a'.repeat(41)]) expect(refused(consultVerdict(ask({ candidate })))).toContain('CANDIDATE UNKNOWN')
    expect(isCandidate(A)).toBe(true)
    expect(isCandidate('a'.repeat(64))).toBe(true)
  })
  test('the same commit is reviewed once: a returned review is a duplicate however the packet is worded', () => {
    const first = consult('r1', 'release', { candidate: A })
    const swarm = ran(ledSwarm(), 'r1', 'returned')
    expect(refused(consultVerdict(ask({ consults: [first], swarm })))).toContain('DUPLICATE')
    expect(refused(consultVerdict(ask({ consults: [first], swarm, packet: packet({ objective: 'a different wording', decision: 'again?', failures: ['new'] }) })))).toContain('DUPLICATE')
  })
  test('a failed attempt is retried once, and only once', () => {
    const f1 = consult('r1', 'release', { candidate: A })
    const f2 = consult('r2', 'release', { candidate: A })
    expect(consultVerdict(ask({ consults: [f1], swarm: ran(ledSwarm(), 'r1', 'failed') }))).toMatchObject({ ok: true })
    expect(MAX_RELEASE_ATTEMPTS).toBe(2)
    expect(refused(consultVerdict(ask({ consults: [f1, f2], swarm: ran(ran(ledSwarm(), 'r1', 'failed'), 'r2', 'failed') })))).toContain('RELEASE RETRY BUDGET')
  })
  test('a retry is not allowed while the first attempt is still open', () => {
    expect(refused(consultVerdict(ask({ consults: [consult('r1', 'release', { candidate: A })], swarm: ran(ledSwarm(), 'r1', 'open') })))).toContain('OCCUPIED')
  })
  test('a review of an older commit never satisfies a newer one', () => {
    const old = consult('r1', 'release', { candidate: A })
    const swarm = ran(ledSwarm(), 'r1', 'returned')
    expect(consultVerdict(ask({ consults: [old], swarm, candidate: B }))).toMatchObject({ ok: true })
    // and the old commit's own attempts are not spent by the new one
    const both = [old, consult('r2', 'release', { candidate: B })]
    expect(refused(consultVerdict(ask({ consults: both, swarm: ran(swarm, 'r2', 'returned'), candidate: A })))).toContain('DUPLICATE')
  })
  test('code reverted to a reviewed commit is not reviewed again: the earlier review stands for that commit', () => {
    const first = consult('r1', 'release', { candidate: A })
    const swarm = ran(ran(ledSwarm(), 'r1', 'returned'), 'r2', 'returned')
    const second = consult('r2', 'release', { candidate: B })
    expect(refused(consultVerdict(ask({ consults: [first, second], swarm, candidate: A })))).toContain('DUPLICATE')
  })
  test('the session has a bound on release consultations of all commits together', () => {
    const many = Array.from({ length: MAX_RELEASE_SESSION }, (_, i) => consult(`r${i}`, 'release', { candidate: `${i}`.repeat(40).slice(0, 40) }))
    let swarm = ledSwarm()
    for (const c of many) swarm = ran(swarm, c.id, 'failed')
    expect(refused(consultVerdict(ask({ consults: many, swarm, candidate: B })))).toContain('RELEASE ALLOWANCE')
  })
  test('a restart does not erase the store record: a returned commit is a duplicate and spent attempts stay spent', () => {
    const returned: ReleaseRecord[] = [{ candidate: A, id: 'opus-1-aaaaaa', at: 1, returned: true }]
    expect(refused(consultVerdict(ask({ history: returned })))).toContain('DUPLICATE')
    const failedTwice: ReleaseRecord[] = [{ candidate: A, id: 'x1', at: 1, returned: false }, { candidate: A, id: 'x2', at: 2, returned: false }]
    expect(refused(consultVerdict(ask({ history: failedTwice })))).toContain('RELEASE RETRY BUDGET')
    expect(consultVerdict(ask({ history: [{ candidate: A, id: 'x1', at: 1, returned: false }] }))).toMatchObject({ ok: true })
    expect(consultVerdict(ask({ history: returned, candidate: B }))).toMatchObject({ ok: true })
  })
  test('the brief names the exact commit', () => {
    expect(briefOf(consult('r1', 'release', { candidate: A }))).toContain(`CANDIDATE COMMIT\n  ${A}`)
    expect(briefOf(consult('r1', 'architecture'))).not.toContain('CANDIDATE COMMIT')
  })
  test('release records are never pushed out by ordinary ones, and the store list is bounded', () => {
    let list: Consultation[] = [consult('r1', 'release', { candidate: A })]
    for (let i = 0; i < 60; i++) list = addConsult(list, consult(`d${i}`, 'architecture'))
    expect(list.some(c => c.id === 'r1')).toBe(true)
    expect(list.length).toBeLessThanOrEqual(32)
    let held: ReleaseRecord[] = []
    for (let i = 0; i < MAX_RELEASE_RECORDS + 10; i++) held = withRelease(held, { candidate: A, id: `x${i}`, at: i, returned: false })
    expect(held).toHaveLength(MAX_RELEASE_RECORDS)
  })
  test('legacy v0.5.0 and v0.5.1 ledgers load: consultations without a candidate stay valid', () => {
    const legacy = { ...emptyLedger('s'), consults: [consult('opus-1-abc', 'release')] } as Ledger
    expect(migrateLedger(JSON.parse(JSON.stringify(legacy)) as Ledger).consults?.[0]?.candidate).toBeUndefined()
    expect(storageLedger(legacy).consults?.[0]?.id).toBe('opus-1-abc')
    expect(storageLedger({ ...legacy, consults: [consult('r1', 'release', { candidate: A })] }).consults?.[0]?.candidate).toBe(A)
    // an old release consultation without a candidate counts toward the session allowance, never as an approval of any commit
    expect(consultVerdict(ask({ consults: [consult('opus-1-abc', 'release')], swarm: ran(ledSwarm(), 'opus-1-abc', 'returned') }))).toMatchObject({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Through the host: the real git answers, the real store persists.
// ---------------------------------------------------------------------------

const SWARM = 'mcp__cobalt-cockpit__swarm'
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: SWARM, ...input } as never)
let seq = 0
const spawn = ($: Engine, description: string) => $.agent.spawn({ prompt: 'brief', description, subagentType: 'cobalt-cockpit:architect', tool_use_id: `sp-${++seq}`, parentModel: SONNET, provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false } as never)
const finish = ($: Engine, agentId: string) => $.turn.complete({ agentId, turnId: `turn-${agentId}`, reason: 'answer', answer: 'DECISION: GO', durationMs: 20, isAborted: false } as never)
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const task = (held: ReturnType<typeof hostState>) => held.get('task')!.value as Task
const releasePacket = { action: 'consult', ground: 'release', objective: 'Release v0.5.1', architecture: 'Plugin hooks', locations: ['hooks/consult.ts'], risk: 'Broken admission', question: 'Approve the release?' }
const releaseTask = async ($: Engine) => {
  await start($)
  await prompt($, 'Please approve the release of v0.5.1 after checking everything')
  await progress($, { action: 'plan', milestones: FIVE })
  for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
  for (const g of GATE_NAMES) await progress($, { action: 'gate', gate: g, state: 'na', evidence: 'fixture' })
}

describe('a release review through the host', () => {
  test('admitted for a clean commit, recorded with it, and approval is withdrawn when the commit changes', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    const reply = String((await call($, releasePacket)).result)
    expect(reply).toContain('OPUS ADMITTED')
    expect(reply).toContain(`CANDIDATE COMMIT\n  ${A}`)
    const id = ledger(held).consults![0]!.id
    expect(ledger(held).consults![0]!.candidate).toBe(A)
    // an attempt carries no commit onto the review: only a cleared release ground does
    expect(task(held).review).toMatchObject({ state: 'admitted' })
    expect(task(held).review?.candidate).toBeUndefined()
    expect(w.storeWrites.some(x => x.key === 'release-reviews')).toBe(true)
    const spawned = await spawn($, `[task:${id}] Opus release consultation`)
    await finish($, spawned.agentId!)
    await call($, { action: 'verify', task_id: id, state: 'pass', release_outcome: 'go', evidence: ['checked'] })
    expect(task(held).review).toMatchObject({ state: 'adjudicated', candidate: A })
    expect(String((await call($, releasePacket)).result)).toContain('DUPLICATE')
    // the approval stands while the commit and the tree are unchanged ...
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    // ... and is taken back by a new commit
    w.head = B
    await progress($, { action: 'status' })
    expect(task(held).review).toMatchObject({ state: 'required' })
    expect(task(held).review?.candidate).toBeUndefined()
    expect(task(held).percent).toBeLessThan(100)
    // a new candidate is reviewed under its own allowance
    expect(String((await call($, releasePacket)).result)).toContain('OPUS ADMITTED')
    expect(ledger(held).consults!.map(c => c.candidate)).toEqual([A, B])
  })
  test('uncommitted changes, an unborn HEAD or no git all fail closed and start nothing', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    w.uncommitted = true
    expect(String((await call($, releasePacket)).result)).toContain('CANDIDATE UNKNOWN')
    w.uncommitted = false
    w.head = 'HEAD'
    expect(String((await call($, releasePacket)).result)).toContain('CANDIDATE UNKNOWN')
    w.gitStatus = null
    expect(String((await call($, releasePacket)).result)).toContain('CANDIDATE UNKNOWN')
    expect(ledger(held).consults ?? []).toHaveLength(0)
    expect(w.spawns).toHaveLength(0)
    expect(task(held).review).toEqual({ grounds: ['release'], consult: null, state: 'required' })
    expect(task(held).percent).toBeLessThan(100)
  })
  test('a restart (a new world on the same store) still sees the review of that commit', LED, async ($, on) => {
    world(on, {}, { 'release-reviews': [{ candidate: A, id: 'opus-1-aaaaaa', at: 1, returned: true }] }); hostState(on, {}); await releaseTask($)
    expect(String((await call($, releasePacket)).result)).toContain('DUPLICATE')
  })
  test('a task reset does not clear the record of a review', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    await call($, releasePacket)
    await $.command.run({ command: 'cockpit', args: 'reset', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    expect(ledger(held).consults).toHaveLength(1)
    expect(w.storeWrites.filter(x => x.key === 'release-reviews').at(-1)?.value).toMatchObject([{ candidate: A, returned: false }])
  })
  const approve = async ($: Engine, held: ReturnType<typeof hostState>) => {
    const id = ledger(held).consults!.at(-1)!.id
    const spawned = await spawn($, `[task:${id}] Opus release consultation`)
    await finish($, spawned.agentId!)

    return id
  }

  test('a restart gets a fresh id: the spent attempt stays spent and is not overwritten', LED, async ($, on) => {
    // the very id a fresh ledger would give this commit: the key is the commit's, so only the counter can tell attempts apart
    const spent = `opus-1-${(consultVerdict(ask()) as { key: string }).key.slice(0, 6)}`
    const w = world(on, {}, { 'release-reviews': [{ candidate: A, id: spent, at: 1, returned: false }] }); const held = hostState(on, {}); await releaseTask($)
    expect(String((await call($, releasePacket)).result)).toContain('OPUS ADMITTED')
    const id = ledger(held).consults![0]!.id
    expect(id).not.toBe(spent)
    const stored = w.storeWrites.filter(x => x.key === 'release-reviews').at(-1)!.value as ReleaseRecord[]
    expect(stored.map(r => r.id)).toContain(spent)
    expect(stored.map(r => r.id)).toContain(id)
    // both attempts are now spent: a third request, after the second fails, is refused
    w.uncommitted = false
    expect(String((await call($, releasePacket)).result)).toContain('OCCUPIED')
  })
  test('a review that returned is recorded as returned without waiting for the verdict', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    await call($, releasePacket)
    const id = await approve($, held)
    await progress($, { action: 'status' })
    expect((w.storeWrites.filter(x => x.key === 'release-reviews').at(-1)!.value as ReleaseRecord[]).find(r => r.id === id)?.returned).toBe(true)
  })
  test('an approval given for one commit is not carried to another by a new request', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    await call($, releasePacket)
    const id = await approve($, held)
    await call($, { action: 'verify', task_id: id, state: 'pass', release_outcome: 'go', evidence: ['checked'] })
    expect(task(held).review).toMatchObject({ state: 'adjudicated', candidate: A })
    w.head = B
    const second = String((await call($, releasePacket)).result)
    expect(second).toContain('OPUS ADMITTED')
    expect(task(held).review).toMatchObject({ state: 'admitted' })
    expect(task(held).review?.candidate).toBeUndefined()
    expect(task(held).review?.consult).not.toBe(id)
  })
  test('uncommitted changes withdraw an approval, an unanswering git does not, and the same clean commit gives it back', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    await call($, releasePacket)
    const id = await approve($, held)
    await call($, { action: 'verify', task_id: id, state: 'pass', release_outcome: 'go', evidence: ['checked'] })
    const saved = w.gitStatus
    w.gitStatus = null
    await progress($, { action: 'status' })
    expect(task(held).review?.state).toBe('adjudicated')
    w.gitStatus = saved
    w.uncommitted = true
    await progress($, { action: 'status' })
    expect(task(held).review).toMatchObject({ state: 'required' })
    expect(task(held).percent).toBeLessThan(100)
    w.uncommitted = false
    await progress($, { action: 'status' })
    expect(task(held).review).toMatchObject({ state: 'adjudicated', candidate: A, consult: id })
  })
  test('an approval with no commit behind it does not stand', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($)
    const t = task(held)
    held.get('task')!.value = { ...t, review: { grounds: ['release'], consult: 'opus-1-old', state: 'adjudicated' } }
    await progress($, { action: 'status' })
    expect(task(held).review).toMatchObject({ grounds: ['release'], consult: null, state: 'required' })
    expect(task(held).review?.cleared ?? []).toEqual([])
  })
  test('an unreadable release record fails closed', LED, async ($, on) => {
    world(on, {}, { 'release-reviews': 'garbage' }); const held = hostState(on, {}); await releaseTask($)
    expect(String((await call($, releasePacket)).result)).toContain('RELEASE RECORD UNREADABLE')
    expect(ledger(held).consults ?? []).toHaveLength(0)
  })
  test('two release requests at once admit one', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await releaseTask($)
    const both = await Promise.all([call($, releasePacket), call($, releasePacket)])
    const text = both.map(x => String(x.result))
    expect(text.filter(t => t.includes('OPUS ADMITTED'))).toHaveLength(1)
    expect(text.filter(t => t.includes('OCCUPIED') || t.includes('DUPLICATE'))).toHaveLength(1)
    expect(ledger(held).consults).toHaveLength(1)
    expect(w.storeWrites.filter(x => x.key === 'release-reviews').length).toBeGreaterThan(0)
  })

  test('the native permission and ownership guards still apply: an unadmitted Opus is refused', LED, async ($, on) => {
    world(on); hostState(on, {}); await releaseTask($)
    expect((await spawn($, 'review this')).deny).toContain('NOT ADMITTED')
  })
})
