// SONNET_LED: Sonnet builds, Haiku scouts, Opus reviews on admission. The
// session router has its own file (router.test.ts). The pure policy first (grounds, packet, bounds, the review hold),
// then the same rules through the real host hooks: what reached the engine,
// what was refused, and what the task model let finish.

import { describe, expect, test } from 'claude-code/testing'
import { consultVerdict, groundsAvailable, locationPath, mandatoryGrounds, packetOf, problemKey, promptGroundsOf, readScopeOf, requireReview, statusOf, CONSULT_EFFORT, FAILURE_STREAK, MAX_PER_TASK } from '../hooks/consult'
import type { ConsultFacts } from '../hooks/consult'
import { desiredRequest, mainModel, policyMismatch, OPUS_MODEL } from '../hooks/model-policy'
import { applyAction, newTask, percentOf, settle } from '../hooks/model'
import { admitTask, bindAgent, configureSwarm, emptySwarm, finishTask, submitTask, SONNET_LED_SWARM } from '../hooks/swarm'
import { orchestrationText, orchestraRows, roleOf } from '../hooks/orchestra'
import type { OrchestraView } from '../hooks/orchestra'
import { usageByTier, usageLine, ledgerLines, emptyLedger, storageLedger } from '../hooks/ledger'
import type { Consultation, EvidencePacket, Ledger, Swarm, Task } from '../types'
import { FIVE, GATE_NAMES, hostState, progress, prompt, start, world } from './world'

type Engine = Parameters<typeof start>[0]
const SWARM = 'mcp__cobalt-cockpit__swarm'
const SONNET = 'claude-sonnet-5-5'
const LED = { options: { orchestration: true, profile: 'SONNET_LED' } }
const LEGACY = { options: { orchestration: true } }

const facts = (over: Partial<ConsultFacts> = {}): ConsultFacts => ({ prompt: 'Fix the typo in the README', files: ['README.md'], milestones: 2, errorStreak: 0, ...over })
const packet = (over: Partial<EvidencePacket> = {}): EvidencePacket => ({ objective: 'Choose the cache layer', architecture: 'Single process; JSON store', files: ['src/cache.ts'], alternatives: ['LRU in memory', 'SQLite'], failures: [], risk: 'Stale reads under concurrency', decision: 'Which cache design?', ...over })
const consult = (id: string, p: EvidencePacket, ground: Consultation['ground'] = 'architecture', progressTask: number | null = 1): Consultation => ({ id, ground, key: problemKey(ground, p), packet: p, progressTask, isMandatory: false, requestedAt: 0 })
const ledSwarm = (): Swarm => configureSwarm(emptySwarm(), SONNET_LED_SWARM)
const opusTask = (s: Swarm, id: string): Swarm => submitTask(s, { id, tier: 'OPUS', role: 'ARCHITECT', objective: `decide ${id}`, owned: [`/r/${id}`], mode: 'read' }, 0).swarm

describe('SONNET_LED model policy', () => {
  test('the main loop leads on Sonnet; Opus is a high-effort specialist tier; legacy is unchanged', () => {
    expect(mainModel('SONNET_LED')).toBe(SONNET)
    expect(mainModel()).toBe(OPUS_MODEL)
    expect(desiredRequest(undefined, 'SONNET', 'SONNET_LED')).toEqual({ model: SONNET })
    expect(desiredRequest('a1', 'OPUS', 'SONNET_LED')).toEqual({ model: OPUS_MODEL, effort: 'high' })
    expect(desiredRequest()).toEqual({ model: OPUS_MODEL })
    // the main loop's effort is the host's in either profile
    for (const effort of ['low', 'medium', 'high', undefined]) expect(policyMismatch(SONNET, effort, undefined, 'SONNET', 'SONNET_LED')).toBeNull()
    expect(policyMismatch(OPUS_MODEL, 'high', undefined, 'SONNET', 'SONNET_LED')).toContain('MODEL POLICY')
  })
  test('the system prompt states the division of labour and the consult path', () => {
    const text = orchestrationText(4, 'SONNET_LED')
    for (const term of ['Sonnet 5.5 main session', 'swarm action consult', 'cobalt-cockpit:architect', 'never a background model', 'advice until verified', 'At most 4 helpers']) expect(text).toContain(term)
    expect(text).not.toContain('Opus 5.5 commander')
    expect(orchestrationText(16)).toContain('Opus 5.5 commander')
    expect(roleOf('cobalt-cockpit:architect')).toBe('ARCHITECT')
  })
})

describe('consultation grounds', () => {
  test('ordinary work raises no ground', () => {
    expect(groundsAvailable(facts())).toEqual([])
    expect(groundsAvailable(facts({ prompt: 'Run the tests and update the docs', files: ['docs/a.md', 'tests/a.test.ts'] }))).toEqual([])
  })
  test('each ground holds on evidence', () => {
    expect(groundsAvailable(facts({ prompt: 'Please ask Opus to review the plan' }))).toContain('asked')
    expect(groundsAvailable(facts({ prompt: 'Run the release gate for v1.2' }))).toContain('release')
    expect(groundsAvailable(facts({ files: ['src/auth/session.ts'] }))).toContain('security')
    expect(groundsAvailable(facts({ files: ['a/x.ts', 'b/y.ts', 'c/z.ts'] }))).toContain('architecture')
    expect(groundsAvailable(facts({ milestones: 5 }))).toContain('architecture')
    expect(groundsAvailable(facts({ prompt: 'Plan the database migration' }))).toContain('architecture')
  })
  test('a repeated failure counts only after the approach was meant to change', () => {
    expect(groundsAvailable(facts({ errorStreak: FAILURE_STREAK - 1 }))).not.toContain('repeated-failure')
    expect(groundsAvailable(facts({ errorStreak: FAILURE_STREAK }))).toContain('repeated-failure')
  })
  test('negated requests are not requests', () => {
    expect(groundsAvailable(facts({ prompt: 'Do not ask Opus; no release gate, never publish the release' }))).toEqual([])
    expect(promptGroundsOf('Work on main. No tags, no GitHub release. Do not publish until I review.')).toEqual([])
  })
  test('asked, release and changed security-sensitive files are mandatory; architecture never is', () => {
    expect(mandatoryGrounds(facts({ prompt: 'ask opus', files: ['hooks/guard.ts'] }))).toEqual(['security', 'asked'])
    expect(mandatoryGrounds(facts({ prompt: 'Approve the release' }))).toEqual(['release'])
    expect(mandatoryGrounds(facts({ milestones: 7, prompt: 'redesign the architecture' }))).toEqual([])
    expect(mandatoryGrounds(facts({ prompt: 'explain the security model' }))).toEqual([])
    expect(mandatoryGrounds(facts({ files: ['docs/author.md'] }))).toEqual([])
    expect(mandatoryGrounds(facts({ promptGrounds: ['asked'] }))).toEqual(['asked'])
  })
})

describe('evidence packet', () => {
  test('missing parts are named; fields are bounded', () => {
    expect('error' in packetOf('architecture', { objective: 'x', decision: 'y', risk: 'z', files: [] })).toBe(true)
    expect(packetOf('repeated-failure', { objective: 'x', decision: 'y', risk: 'z', files: ['a'], alternatives: ['b'] })).toEqual({ error: 'failures required: the failing output, briefly' })
    expect(packetOf('asked', { objective: 'x', risk: 'z' })).toEqual({ error: 'question required: the precise decision Opus is asked for' })
    const made = packetOf('asked', { objective: 'o'.repeat(5000), decision: 'd', risk: 'r', files: Array.from({ length: 40 }, (_, i) => `f${i}`) })
    expect('packet' in made && made.packet.objective.length).toBe(1200)
    expect('packet' in made && made.packet.files.length).toBe(12)
  })
  test('a location names its file: line references are dropped for the read scope, kept in the packet', () => {
    for (const [loc, path] of [['src/stats.js:8-12', 'src/stats.js'], ['src/stats.js:8', 'src/stats.js'], ['src/stats.js:8:3', 'src/stats.js'], ['src/a.ts#L8-L12', 'src/a.ts'], ['src/a.ts#L8', 'src/a.ts'], ['src/a.ts:8-12:3', 'src/a.ts'], [' /abs/b.ts:1-2 ', '/abs/b.ts'], ['src/dir', 'src/dir'], ['src/v1:2/x.ts', 'src/v1:2/x.ts']] as const) expect(locationPath(loc)).toBe(path)
    const p = packet({ files: ['src/stats.js:8-12', 'src/stats.js:40', 'src/util.ts#L3-L9'] })
    expect(readScopeOf(p)).toEqual(['src/stats.js', 'src/util.ts'])
    expect(p.files).toContain('src/stats.js:8-12')
    expect(CONSULT_EFFORT).toBe('high')
  })
  test('the key ignores spacing and order but not new evidence', () => {
    expect(problemKey('architecture', packet())).toBe(problemKey('architecture', packet({ objective: '  choose   the CACHE layer ', alternatives: ['SQLite', 'LRU in memory'] })))
    expect(problemKey('architecture', packet())).not.toBe(problemKey('architecture', packet({ failures: ['new failure'] })))
  })
})

describe('consultation admission', () => {
  const base = { profile: 'SONNET_LED' as const, ground: 'architecture' as const, packet: packet(), facts: facts({ milestones: 6 }), consults: [], swarm: ledSwarm(), progressTask: 1 }
  test('legacy profile and ordinary work are refused', () => {
    expect(consultVerdict({ ...base, profile: 'OPUS_LED' })).toMatchObject({ ok: false, reason: expect.stringContaining('LEGACY PROFILE') })
    expect(consultVerdict({ ...base, facts: facts() })).toMatchObject({ ok: false, reason: expect.stringContaining('ordinary work') })
    expect(consultVerdict({ ...base, ground: 'release' })).toMatchObject({ ok: false, reason: expect.stringContaining('grounds that do are architecture') })
  })
  test('a holding ground is admitted, mandatory only where its ground is', () => {
    expect(consultVerdict(base)).toMatchObject({ ok: true, isMandatory: false })
    expect(consultVerdict({ ...base, ground: 'release', facts: facts({ prompt: 'approve the release' }) })).toMatchObject({ ok: true, isMandatory: true })
  })
  test('one live Opus; an unchanged problem once; bounded retries and task budget', () => {
    const c1 = consult('c1', packet())
    const open = opusTask(ledSwarm(), 'c1')
    expect(consultVerdict({ ...base, consults: [c1], swarm: open, packet: packet({ decision: 'other' }) })).toMatchObject({ ok: false, reason: expect.stringContaining('OCCUPIED') })
    const admitted = admitTask(open, 'c1', 1).swarm
    const returned = finishTask(bindAgent(admitted, 'c1', 'a1', 1), 'c1', 'completed', { conclusion: 'Use SQLite' }, 2)
    expect(statusOf(returned.tasks[0])).toBe('returned')
    expect(consultVerdict({ ...base, consults: [c1], swarm: returned })).toMatchObject({ ok: false, reason: expect.stringContaining('DUPLICATE') })
    expect(consultVerdict({ ...base, consults: [c1], swarm: returned, packet: packet({ failures: ['SQLite locked under load'] }) })).toMatchObject({ ok: true })
    const failed = finishTask(bindAgent(admitTask(opusTask(opusTask(ledSwarm(), 'f1'), 'f2'), 'f1', 1).swarm, 'f1', 'a1', 1), 'f1', 'failed', null, 2)
    const twice = finishTask(bindAgent(admitTask(failed, 'f2', 3).swarm, 'f2', 'a2', 3), 'f2', 'cancelled', null, 4)
    expect(consultVerdict({ ...base, consults: [consult('f1', packet()), consult('f2', packet())], swarm: twice })).toMatchObject({ ok: false, reason: expect.stringContaining('RETRY BUDGET') })
    const spent = ['x1', 'x2', 'x3'].map(id => consult(id, packet({ decision: id })))
    let done = ledSwarm()
    for (const id of ['x1', 'x2', 'x3']) done = finishTask(bindAgent(admitTask(opusTask(done, id), id, 1).swarm, id, `a-${id}`, 1), id, 'completed', { conclusion: 'ok' }, 2)
    expect(MAX_PER_TASK).toBe(3)
    expect(consultVerdict({ ...base, consults: spent, swarm: done })).toMatchObject({ ok: false, reason: expect.stringContaining('TASK BUDGET') })
  })
  test('the Opus pool is one, inside a total of four', () => {
    let s = opusTask(opusTask(ledSwarm(), 'o1'), 'o2')
    s = admitTask(s, 'o1', 1).swarm
    expect(admitTask(s, 'o2', 1).reason).toBe('architect occupied')
    for (const id of ['s1', 's2', 'h1']) s = admitTask(submitTask(s, { id, tier: id.startsWith('h') ? 'HAIKU' : 'SONNET', role: 'w', objective: id, owned: [`/r/${id}`], mode: 'write' }, 1).swarm, id, 1).swarm
    s = submitTask(s, { id: 'h2', tier: 'HAIKU', role: 'w', objective: 'h2', owned: ['/r/h2'] }, 1).swarm
    expect(admitTask(s, 'h2', 1).reason).toBe('resource budget')
    // legacy: an OPUS task never binds an agent
    const legacy = admitTask(opusTask(emptySwarm(), 'L'), 'L', 1).swarm
    expect(() => bindAgent(legacy, 'L', 'a', 1)).toThrow()
  })
})

describe('the review a task cannot finish without', () => {
  const finished = (review: boolean): Task => {
    let t = newTask(1, 'approve the release', 0, null)
    t = applyAction(t, { action: 'plan', milestones: [{ title: 'Implement' }] }, 1, null).task
    if (review) t = requireReview(t, ['release'])
    t = applyAction(t, { action: 'complete', milestone: 'm1' }, 2, null).task
    for (const g of GATE_NAMES) t = applyAction(t, { action: 'gate', gate: g, state: 'na', evidence: 'n/a in fixture' }, 3, null).task
    return settle(t).task
  }
  test('held at 99 until adjudicated, then 100', () => {
    expect(finished(false).percent).toBe(100)
    const held = finished(true)
    expect(held.percent).toBe(99)
    expect(held.status).not.toBe('done')
    expect(percentOf({ ...held, review: { grounds: ['release'], consult: 'c1', state: 'returned' } })).toBe(99)
    expect(percentOf({ ...held, review: { grounds: ['release'], consult: 'c1', state: 'adjudicated' } })).toBe(100)
  })
  test('a VERIFY milestone is held while the review is outstanding', () => {
    let t = requireReview(applyAction(newTask(1, 'x', 0, null), { action: 'plan', milestones: [{ title: 'Verify', phase: 'VERIFY' }] }, 1, null).task, ['asked'])
    for (const g of GATE_NAMES) t = applyAction(t, { action: 'gate', gate: g, state: 'na', evidence: 'fixture' }, 2, null).task
    const out = applyAction(t, { action: 'complete', milestone: 'm1' }, 3, null)
    expect(out.task.milestones[0]?.state).toBe('active')
    expect(out.note).toContain('Opus consultation (asked) required')
  })
  test('a new ground after adjudication reopens the review; a repeated one does not', () => {
    const t = { ...newTask(1, 'x', 0, null), review: { grounds: ['release' as const], consult: 'c1', state: 'adjudicated' as const } }
    expect(requireReview(t, ['release']).review?.state).toBe('adjudicated')
    expect(requireReview(t, ['security']).review).toEqual({ grounds: ['release', 'security'], consult: null, state: 'required' })
  })
})

describe('presentation and accounting', () => {
  const meter = { percent: 0, tokens: 0, window: 0, model: SONNET, effort: 'medium' }
  const view = (over: Partial<OrchestraView> = {}): OrchestraView => ({ meter, task: null, activity: { kind: 'IDLE', detail: '', isWorking: false, toolUseId: null, agents: [], at: 0 }, isWorking: true, agents: [], nwho: 'PRUNE · Q4B', limit: 4, now: 10, ...over })
  const text = (v: OrchestraView) => orchestraRows(v, 120, { accent: 'a', ok: 'o', bad: 'b', steel: 's' }).map(r => r.map(s => s.text).join('')).join('\n')
  test('roles are named in SONNET_LED and the legacy view is unchanged', () => {
    const agents = [['claude-haiku-5-5', 'SCOUT'], [SONNET, 'WORKER'], [OPUS_MODEL, 'ARCHITECT']].map(([model, role], i) => ({ id: `a${i}`, title: role!, model: model!, effort: null, tool: 'Read', state: 'running' as const, startedAt: 0, endedAt: null, role, seq: i + 1 }))
    const led = text(view({ profile: 'SONNET_LED', agents, usage: {} }))
    for (const label of ['MAIN / SONNET', 'SCOUT / HAIKU', 'ENGINEER / SONNET', 'ARCHITECT / OPUS', 'LOCAL CONTROL / NWHO', 'USAGE / OBSERVED', 'unavailable']) expect(led).toContain(label)
    const legacy = text(view({ agents }))
    expect(legacy).toContain('SONNET / MAIN')
    expect(legacy).toContain('NWHO / LOCAL')
    expect(legacy).not.toContain('ENGINEER')
  })
  test('usage is observed per tier, unreported is counted, nothing is estimated', () => {
    const req = (model: string, input: number | 'unknown', output: number | 'unknown') => ({ id: 'r', runId: 'x', turnId: 't', agentId: 'unknown', requestedModel: model, requestedEffort: 'unknown', model, effort: 'unknown', effectiveEffort: 'unknown', input, output, cacheRead: 0, cacheWrite: 0 }) as Ledger['requests'][number]
    const u = usageByTier([req(SONNET, 1000, 200), req(SONNET, 'unknown', 'unknown'), req(OPUS_MODEL, 5000, 900)])
    expect(u.SONNET).toMatchObject({ requests: 2, reported: 1, input: 1000, output: 200 })
    expect(usageLine(u)).toBe('SONNET in 1.0k out 200 (1 req) · 1 unreported · OPUS in 5.0k out 900 (1 req)')
    expect(usageLine(usageByTier([req(SONNET, 'unknown', 'unknown')]))).toBe('unavailable (SONNET 1 req unreported)')
  })
  test('the ledger records why Opus was admitted, what it returned and whether Sonnet verified it', () => {
    let swarm = finishTask(bindAgent(admitTask(opusTask(ledSwarm(), 'opus-1-abc'), 'opus-1-abc', 1).swarm, 'opus-1-abc', 'a9', 1), 'opus-1-abc', 'completed', { conclusion: 'Use SQLite with WAL' }, 2)
    swarm = { ...swarm, tasks: swarm.tasks.map(t => ({ ...t, verification: 'pass' as const })) }
    const c = { ...consult('opus-1-abc', packet(), 'release'), isMandatory: true }
    const l: Ledger = { ...emptyLedger('s'), swarm, consults: [c] }
    const lines = ledgerLines(l, 3, 'SUBSCRIPTION', 'unavailable').join('\n')
    for (const s of ['11 OPUS CONSULTATIONS', 'opus-1-abc release (mandatory) · status returned', 'decision Use SQLite with WAL', 'verified by main pass', 'host cost unavailable']) expect(lines).toContain(s)
    expect(ledgerLines(emptyLedger('s'), 3).join('\n')).not.toContain('OPUS CONSULTATIONS')
    const big: Ledger = { ...l, receipts: [], consults: Array.from({ length: 32 }, (_, i) => ({ ...c, id: `c${i}`, packet: packet({ architecture: 'z'.repeat(1200), objective: 'o'.repeat(1200), files: Array.from({ length: 12 }, () => 'f'.repeat(300)) }) })), replay: [], tools: [], requests: [] }
    const stored = storageLedger({ ...big, warnings: Array.from({ length: 32 }, () => 'w'.repeat(10_000)) })
    expect(stored.consults?.every(x => x.packet.files.length === 0 && x.packet.objective.length <= 160)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Through the real host hooks.
// ---------------------------------------------------------------------------

const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: SWARM, ...input } as never)
const step = async ($: Engine, model: string, over: Record<string, unknown> = {}) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 3, ...over } as never)
  let at = await stream.next()
  while (at.done !== true) at = await stream.next()
}
let seq = 0
const spawn = ($: Engine, description: string, subagentType = 'cobalt-cockpit:architect', model?: string) => $.agent.spawn({ prompt: 'brief', description, subagentType, tool_use_id: `sp-${++seq}`, parentModel: SONNET, provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false, ...(model ? { model } : {}) } as never)
const finish = ($: Engine, agentId: string) => $.turn.complete({ agentId, turnId: `turn-${agentId}`, reason: 'answer', answer: 'DECISION: ship', durationMs: 20, isAborted: false } as never)
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const task = (held: ReturnType<typeof hostState>) => held.get('task')!.value as Task
const releasePacket = { action: 'consult', ground: 'release', objective: 'Release v0.5.0', architecture: 'Plugin hooks', locations: ['hooks/consult.ts'], risk: 'Broken admission in production', question: 'Approve the release?' }

describe('SONNET_LED through the host', () => {
  test('the main loop is requested on Sonnet; legacy still constrains it to Opus', LED, async ($, on) => {
    const w = world(on); await start($)
    await step($, OPUS_MODEL)
    expect(w.efforts.at(-1)?.model).toBe(SONNET)
  })
  test('legacy profile still moves the main loop to Opus', LEGACY, async ($, on) => {
    const w = world(on); await start($)
    await step($, SONNET)
    expect(w.efforts.at(-1)?.model).toBe(OPUS_MODEL)
  })
  test('Opus cannot be reached around the admission', LED, async ($, on) => {
    const w = world(on); await start($)
    expect((await spawn($, 'review this', 'cobalt-cockpit:architect')).deny).toContain('NOT ADMITTED')
    expect((await spawn($, 'review this', 'general-purpose', 'opus')).deny).toContain('NOT ADMITTED')
    expect(String((await call($, { action: 'assign', task_id: 'o', tier: 'OPUS', role: 'x', objective: 'y' })).result)).toContain('only through action consult')
    await call($, { action: 'assign', task_id: 's', tier: 'SONNET', role: 'w', objective: 'y', owned_resources: ['/work/example/a.ts'], mode: 'read' })
    expect((await spawn($, '[task:s] smuggle', 'cobalt-cockpit:architect')).deny).toContain('admitted consultation')
    expect(w.spawns).toHaveLength(0)
  })
  test('ordinary work is refused a consultation and finishes without Opus', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    await prompt($, 'Fix the typo in the README')
    const reply = String((await call($, { action: 'consult', ground: 'architecture', objective: 'typo', locations: ['README.md'], alternatives: ['a'], risk: 'none', question: 'which word?' })).result)
    expect(reply).toContain('NOT ADMITTED')
    expect(ledger(held).consults ?? []).toHaveLength(0)
    await progress($, { action: 'plan', milestones: FIVE })
    for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
    for (const g of GATE_NAMES) await progress($, { action: 'gate', gate: g, state: 'na', evidence: 'fixture' })
    await progress($, { action: 'complete', milestone: 'm5' })
    expect(task(held).percent).toBe(100)
    expect(task(held).review).toBeUndefined()
    expect(w.runs.some(argv => argv[0] === 'decision')).toBe(false)
  })
  test('a release approval is mandatory, admitted once, run on Opus, and finishes only after Sonnet verifies it', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    await prompt($, 'Please approve the release of v0.5.0 after checking everything')
    await progress($, { action: 'plan', milestones: FIVE })
    expect(task(held).review).toEqual({ grounds: ['release'], consult: null, state: 'required' })
    for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
    for (const g of GATE_NAMES) await progress($, { action: 'gate', gate: g, state: 'na', evidence: 'fixture' })
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toContain('HELD')
    expect(task(held).percent).toBeLessThan(100)

    const reply = String((await call($, releasePacket)).result)
    expect(reply).toContain('OPUS ADMITTED')
    // admission is by the rules alone: no router is asked at a consultation, in any mode
    expect(reply).not.toContain('NobodyWho')
    expect(w.runs.some(argv => argv[0] === 'decision')).toBe(false)
    const id = ledger(held).consults![0]!.id
    expect(task(held).review?.state).toBe('admitted')
    expect(String((await call($, releasePacket)).result)).toContain('OCCUPIED')

    const spawned = await spawn($, `[task:${id}] Opus release consultation`)
    expect(spawned.agentId).toBeDefined()
    expect(w.spawns.at(-1)?.['model']).toBe(OPUS_MODEL)
    await step($, SONNET, { agentId: spawned.agentId })
    expect(w.efforts.at(-1)).toMatchObject({ model: OPUS_MODEL, agentId: spawned.agentId })
    await finish($, spawned.agentId!)
    expect(String((await call($, releasePacket)).result)).toContain('DUPLICATE')
    expect(task(held).percent).toBeLessThan(100)

    await call($, { action: 'verify', task_id: id, state: 'pass', evidence: ['Re-ran tests: 1000 pass'] })
    expect(task(held).review?.state).toBe('adjudicated')
    await progress($, { action: 'complete', milestone: 'm5' })
    expect(task(held).percent).toBe(100)
  })
  test('editing a security-sensitive file makes the review mandatory', LED, async ($, on) => {
    world(on); const held = hostState(on, {}); await start($)
    await prompt($, 'Tighten the check')
    await progress($, { action: 'plan', milestones: FIVE })
    await $.tool.call({ tool: 'Edit', file_path: '/work/example/hooks/guard.ts', old_string: 'a', new_string: 'b', tool_use_id: 'e1' } as never)
    expect(task(held).review?.grounds).toContain('security')
  })
  // The profile picks the main model; strict mode adds safety, not a model.
  // [options, the session's model, the model the main request reaches the engine on]
  {
    const cases: [Record<string, string | boolean>, string, string][] = [
      [{ cobaltStrict: true }, SONNET, OPUS_MODEL],
      [{ cobaltStrict: true, profile: 'OPUS_LED' }, SONNET, OPUS_MODEL],
      [{ cobaltStrict: true, profile: 'SONNET_LED' }, SONNET, SONNET],
      [{ cobaltStrict: true, profile: 'SONNET_LED' }, OPUS_MODEL, SONNET],
      [{ orchestration: true, profile: 'SONNET_LED' }, SONNET, SONNET],
      [{ orchestration: true, cobaltStrict: true, profile: 'SONNET_LED' }, SONNET, SONNET],
      // a profile is not in force without orchestration: the host's own choice stands
      [{ profile: 'SONNET_LED' }, OPUS_MODEL, OPUS_MODEL],
      [{ profile: 'SONNET_LED' }, SONNET, SONNET],
      [{}, OPUS_MODEL, OPUS_MODEL],
    ]
    for (const [options, session, reached] of cases) {
      test(`precedence: ${JSON.stringify(options)} on ${session} runs main on ${reached}`, { options }, async ($, on) => {
        const w = world(on); const held = hostState(on, {}); await start($)
        await step($, session, { effort: 'medium' })
        expect(w.efforts.at(-1)).toEqual({ model: reached, effort: 'medium' })
        expect((ledger(held).warnings ?? []).some(x => x.startsWith('MODEL POLICY'))).toBe(session !== reached)
      })
    }
  }
  test('the main loop keeps the host effort and stays on Sonnet while an Opus consultation runs', { options: { cobaltStrict: true, profile: 'SONNET_LED' } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    for (const effort of ['low', 'medium', 'high', undefined]) {
      await step($, SONNET, effort === undefined ? {} : { effort })
      expect(w.efforts.at(-1)).toEqual({ model: SONNET, ...(effort === undefined ? {} : { effort }) })
    }
    await prompt($, 'Please approve the release of v0.5.0')
    await call($, releasePacket)
    const spawned = await spawn($, `[task:${ledger(held).consults![0]!.id}] Opus release consultation`)
    await step($, OPUS_MODEL, { agentId: spawned.agentId, effort: 'high' })
    expect(w.efforts.at(-1)).toMatchObject({ model: OPUS_MODEL, agentId: spawned.agentId })
    // the main loop's next request, with the architect still running
    await step($, SONNET, { effort: 'medium' })
    expect(w.efforts.at(-1)).toEqual({ model: SONNET, effort: 'medium' })
    expect(ledger(held).warnings.filter(x => x.startsWith('MODEL POLICY'))).toEqual([])
  })
  test('the budget is four helpers', LED, async ($, on) => {
    world(on); await start($)
    for (const id of ['a', 'b', 'c', 'd', 'e']) await call($, { action: 'assign', task_id: id, tier: id < 'c' ? 'SONNET' : 'HAIKU', role: 'w', objective: id, owned_resources: [`/work/example/${id}.ts`], mode: 'read' })
    const results = []
    for (const id of ['a', 'b', 'c', 'd', 'e']) results.push(await spawn($, `[task:${id}] work`, id < 'c' ? 'cobalt-cockpit:worker' : 'cobalt-cockpit:scout'))
    expect(results.filter(r => r.agentId)).toHaveLength(4)
    expect(results.at(-1)?.deny).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// The architect's read scope and effort, through the host. The Agent call goes
// first (where the native level is set), then its spawn, then the architect's
// own tool calls, as the engine runs them.
// ---------------------------------------------------------------------------

const NATIVE = { version: '2.1.294' }
const architect = async ($: Engine, w: ReturnType<typeof world>, id: string) => {
  const tool_use_id = `arch-${++seq}`
  const description = `[task:${id}] Opus consultation`
  await $.tool.call({ tool: 'Agent', tool_use_id, description, prompt: 'brief', subagent_type: 'cobalt-cockpit:architect' } as never)
  const sent = w.ran.find(c => c['tool_use_id'] === tool_use_id)!
  const spawned = await $.agent.spawn({ prompt: 'brief', description, subagentType: 'cobalt-cockpit:architect', tool_use_id, parentModel: SONNET, provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false } as never)
  return { sent, agentId: spawned.agentId! }
}
const asks = { action: 'consult', ground: 'asked', objective: 'Correct the mean', architecture: 'Pure stats helpers', risk: 'Wrong averages in reports', question: 'Is the mean wrong, and how should it be fixed?' }
const as = ($: Engine, agentId: string, tool: string, input: Record<string, unknown>) => $.tool.call({ tool, agentId, tool_use_id: `u-${++seq}`, ...input } as never)

describe('the architect reads its evidence and runs at High', () => {
  test('line-numbered locations across files are readable; everything else is refused; the handback is delivered', { ...LED, options: { ...LED.options } }, async ($, on) => {
    const w = world(on, NATIVE); const held = hostState(on, {}); await start($)
    await prompt($, 'Ask Opus to review the stats mean')
    const reply = String((await call($, { ...asks, locations: ['src/stats.js:8-12', 'src/stats.js:40', 'lib/util.ts#L3-L9', '/etc/passwd:1'] })).result)
    expect(reply).toContain('OPUS ADMITTED')
    expect(reply).toContain('Read scope: 2 named files; 1 location not readable (outside the project, home-relative or not a plain path)')
    expect(reply).toContain('src/stats.js:8-12')
    const c = ledger(held).consults![0]!
    const t = ledger(held).swarm!.tasks.find(x => x.id === c.id)!
    expect(t.owned).toEqual(['/work/example/lib/util.ts', '/work/example/src/stats.js'])
    expect(t).toMatchObject({ mode: 'read', tier: 'OPUS', requestedEffort: 'high' })

    const { sent, agentId } = await architect($, w, c.id)
    expect(sent['effort']).toBe('high')
    expect(w.spawns.at(-1)?.['model']).toBe(OPUS_MODEL)
    for (const file_path of ['/work/example/src/stats.js', '/work/example/lib/util.ts']) expect((await as($, agentId, 'Read', { file_path })).deny).toBeUndefined()
    expect((await as($, agentId, 'Grep', { pattern: 'mean', path: '/work/example/src/stats.js' })).deny).toBeUndefined()
    for (const file_path of ['/work/example/src/secret.ts', '/etc/passwd', '/work/example/src/stats.js.bak', '/work/example/src/stats.js:8-12']) expect((await as($, agentId, 'Read', { file_path })).deny).toContain('read outside owned resources')
    expect((await as($, agentId, 'Grep', { pattern: 'x' })).deny).toContain('read outside owned resources')
    expect((await as($, agentId, 'Edit', { file_path: '/work/example/src/stats.js', old_string: 'a', new_string: 'b' })).deny).toBeDefined()
    expect((await as($, agentId, 'Bash', { command: 'cat /work/example/src/stats.js' })).deny).toBeDefined()
    expect((await as($, agentId, 'Agent', { description: 'more', prompt: 'x' })).deny).toBeDefined()
    expect((await as($, agentId, 'SubagentHandback', { message: 'DECISION: divide by n, not n-1 (src/stats.js:10)' })).deny).toBeUndefined()
    expect(w.ran.filter(r => r['tool'] === 'SubagentHandback')).toHaveLength(1)
    expect(w.ran.some(r => r['tool'] === 'Edit' || r['tool'] === 'Bash')).toBe(false)

    // the engine applied High: observed, and no fallback said
    await step($, OPUS_MODEL, { agentId, effort: 'high' })
    expect(w.efforts.at(-1)).toEqual({ model: OPUS_MODEL, effort: 'high', agentId })
    expect(ledger(held).swarm!.tasks.find(x => x.id === c.id)).toMatchObject({ launchEffort: 'high', appliedEffort: 'high' })
    expect(ledger(held).warnings.filter(x => x.includes('EFFORT FALLBACK'))).toEqual([])
    // the main loop keeps the person's level throughout
    await step($, SONNET, { effort: 'medium' })
    expect(w.efforts.at(-1)).toEqual({ model: SONNET, effort: 'medium' })
  })
  test('a consultation that names no file reads the project, never everything', LED, async ($, on) => {
    const w = world(on, NATIVE); const held = hostState(on, {}); await start($)
    await prompt($, 'Please approve the release of v0.5.0')
    expect(String((await call($, releasePacket)).result)).toContain('Read scope: 1 named file')
    await prompt($, 'Ask Opus to review the stats mean')
    const reply = String((await call($, asks)).result)
    // occupied by the first: admit the second only after it ends
    expect(reply).toContain('OCCUPIED')
    const first = ledger(held).consults![0]!
    const { agentId } = await architect($, w, first.id)
    expect((await as($, agentId, 'Read', { file_path: '/work/example/hooks/consult.ts' })).deny).toBeUndefined()
    await finish($, agentId)
    await call($, { action: 'verify', task_id: first.id, state: 'pass', evidence: ['checked'] })
    const second = String((await call($, asks)).result)
    expect(second).toContain('Read scope: the project')
    const c = ledger(held).consults!.at(-1)!
    expect(ledger(held).swarm!.tasks.find(x => x.id === c.id)!.owned).toEqual(['/work/example'])
    const b = await architect($, w, c.id)
    expect((await as($, b.agentId, 'Grep', { pattern: 'mean' })).deny).toBeUndefined()
    expect((await as($, b.agentId, 'Glob', { pattern: '**/*.ts' })).deny).toBeUndefined()
    expect((await as($, b.agentId, 'Read', { file_path: '/work/example/src/stats.js' })).deny).toBeUndefined()
    for (const file_path of ['/etc/hosts', '/home/someone/.ssh/id_ed25519', '/work/example-other/a.ts', '~/.ssh/id_rsa', '~']) expect((await as($, b.agentId, 'Read', { file_path })).deny).toContain('read outside owned resources')
    // a pattern cannot reach where the path may not: absolute, home-relative or climbing out
    for (const pattern of ['/etc/*', '/home/someone/.ssh/*', '~/.ssh/*', '../**/*.ts', 'src/../../*', '{src,..}/*']) expect((await as($, b.agentId, 'Glob', { pattern })).deny).toContain('read outside owned resources')
    for (const glob of ['/etc/*', '../*.ts']) expect((await as($, b.agentId, 'Grep', { pattern: 'x', glob })).deny).toContain('read outside owned resources')
    expect((await as($, b.agentId, 'Grep', { pattern: 'x', path: '~' })).deny).toContain('read outside owned resources')
    for (const pattern of ['src/**/*.ts', '**/..config.ts', '*.md']) expect((await as($, b.agentId, 'Glob', { pattern })).deny).toBeUndefined()
    expect((await as($, b.agentId, 'Grep', { pattern: 'x', glob: '*.ts' })).deny).toBeUndefined()
  })
  test('an engine that applies less than High is reported as what it applied, not as High', LED, async ($, on) => {
    const w = world(on, NATIVE); const held = hostState(on, {}); await start($)
    await prompt($, 'Ask Opus to review the stats mean')
    await call($, { ...asks, locations: ['src/stats.js:8'] })
    const c = ledger(held).consults![0]!
    const { sent, agentId } = await architect($, w, c.id)
    expect(sent['effort']).toBe('high')
    await step($, OPUS_MODEL, { agentId, effort: 'medium' })
    expect(ledger(held).swarm!.tasks.find(x => x.id === c.id)).toMatchObject({ requestedEffort: 'high', launchEffort: 'high', appliedEffort: 'medium' })
    expect(ledger(held).warnings).toContain('EFFORT FALLBACK / engine applied medium; requested high')
  })
  test('the operator ceiling holds the consultation below High and says so; workers keep their own levels', { options: { orchestration: true, profile: 'SONNET_LED', maxEffort: 'medium' } }, async ($, on) => {
    const w = world(on, NATIVE); const held = hostState(on, {}); await start($)
    await prompt($, 'Ask Opus to review the stats mean')
    await call($, { ...asks, locations: ['src/stats.js:8'] })
    const c = ledger(held).consults![0]!
    expect((await architect($, w, c.id)).sent['effort']).toBe('medium')
    await call($, { action: 'assign', task_id: 'scan', tier: 'HAIKU', role: 'scout', objective: 'list files', owned_resources: ['/work/example/src'], mode: 'read', effort: 'low' })
    const tool_use_id = `scan-${++seq}`
    await $.tool.call({ tool: 'Agent', tool_use_id, description: '[task:scan] list', prompt: 'x', subagent_type: 'cobalt-cockpit:scout' } as never)
    expect(w.ran.find(r => r['tool_use_id'] === tool_use_id)!['effort']).toBe('low')
  })
  test('without native effort the request itself is set to High', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    await prompt($, 'Ask Opus to review the stats mean')
    await call($, { ...asks, locations: ['src/stats.js:8'] })
    const spawned = await spawn($, `[task:${ledger(held).consults![0]!.id}] Opus asked consultation`)
    await step($, SONNET, { agentId: spawned.agentId })
    expect(w.efforts.at(-1)).toMatchObject({ model: OPUS_MODEL, effort: 'high', agentId: spawned.agentId })
  })
})
