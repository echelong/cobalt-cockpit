import { describe, expect, test } from 'claude-code/testing'
import { agentsText, taskText } from '../hooks/inspector'
import { orchestrationText } from '../hooks/orchestra'
import { admitTask, bindAgent, emptySwarm, finishTask, routeTask, routingOf, submitTask, suggestRoute, summarizeSwarm, verifyTask } from '../hooks/swarm'
import type { EffortRequest, Ledger, ModelTier, Swarm, SwarmTask, Wave } from '../types'
import { hostState, start, spawnWorld as world } from './world'

// The route's suggestion: read from fields the commander set on purpose, recorded beside the commander's own choice, and
// never acted on. The cases are assignments of the kinds a real engineering session makes.

type Case = { what: string; tier: ModelTier; role: string; mode: 'read' | 'write'; effort: EffortRequest; wave: Wave; suggests: ModelTier }
const REPRESENTATIVE: Case[] = [
  // bounded, extractive reads
  { what: 'inventory of the verification commands across docs and CI', tier: 'HAIKU', role: 'SCOUT', mode: 'read', effort: 'low', wave: 'RECONNAISSANCE', suggests: 'HAIKU' },
  { what: 'file discovery: every test that touches alerts', tier: 'SONNET', role: 'scout', mode: 'read', effort: 'AUTO', wave: 'ENGINEERING', suggests: 'HAIKU' },
  { what: 'narrow reference search: callers of one function', tier: 'SONNET', role: 'Reference search', mode: 'read', effort: 'AUTO', wave: 'RECONNAISSANCE', suggests: 'HAIKU' },
  { what: 'classification of a bounded failure log', tier: 'SONNET', role: 'UTILITY', mode: 'read', effort: 'AUTO', wave: 'VERIFICATION', suggests: 'HAIKU' },
  { what: 'mechanical comparison of two schema files', tier: 'HAIKU', role: 'cobalt-cockpit:utility', mode: 'read', effort: 'low', wave: 'ENGINEERING', suggests: 'HAIKU' },
  { what: 'simple read-only lookup the commander named light', tier: 'SONNET', role: 'Lookup', mode: 'read', effort: 'low', wave: 'ENGINEERING', suggests: 'HAIKU' },
  { what: 'triage of which tests failed, by name', tier: 'SONNET', role: 'triage', mode: 'read', effort: 'AUTO', wave: 'VERIFICATION', suggests: 'HAIKU' },
  // investigation and review: engineering judgement
  { what: 'trace a code path through the admission hook', tier: 'SONNET', role: 'EXPLORER', mode: 'read', effort: 'AUTO', wave: 'ENGINEERING', suggests: 'SONNET' },
  { what: 'an explorer sent during reconnaissance is still an investigator', tier: 'SONNET', role: 'cobalt-cockpit:explorer', mode: 'read', effort: 'AUTO', wave: 'RECONNAISSANCE', suggests: 'SONNET' },
  { what: 'substantial investigation the commander named high', tier: 'SONNET', role: 'Reader', mode: 'read', effort: 'high', wave: 'RECONNAISSANCE', suggests: 'SONNET' },
  { what: 'documentation research', tier: 'SONNET', role: 'RESEARCHER', mode: 'read', effort: 'AUTO', wave: 'RECONNAISSANCE', suggests: 'SONNET' },
  { what: 'independent review of the complete diff', tier: 'SONNET', role: 'REVIEWER', mode: 'read', effort: 'AUTO', wave: 'REVIEW', suggests: 'SONNET' },
  { what: 'security review, even during reconnaissance', tier: 'SONNET', role: 'Security review', mode: 'read', effort: 'AUTO', wave: 'RECONNAISSANCE', suggests: 'SONNET' },
  { what: 'a review asked of Haiku', tier: 'HAIKU', role: 'reviewer', mode: 'read', effort: 'low', wave: 'REVIEW', suggests: 'SONNET' },
  // writes: never Haiku's
  { what: 'feature implementation', tier: 'SONNET', role: 'WORKER', mode: 'write', effort: 'AUTO', wave: 'ENGINEERING', suggests: 'SONNET' },
  { what: 'debugging a failing guard', tier: 'SONNET', role: 'worker', mode: 'write', effort: 'high', wave: 'ENGINEERING', suggests: 'SONNET' },
  { what: 'refactoring', tier: 'SONNET', role: 'implementer', mode: 'write', effort: 'AUTO', wave: 'ENGINEERING', suggests: 'SONNET' },
  { what: 'a scout asked to write', tier: 'HAIKU', role: 'SCOUT', mode: 'write', effort: 'low', wave: 'RECONNAISSANCE', suggests: 'SONNET' },
  { what: 'a risky migration asked of a Haiku utility', tier: 'HAIKU', role: 'utility', mode: 'write', effort: 'AUTO', wave: 'ENGINEERING', suggests: 'SONNET' },
  // the role's label is read as written: by whole word, whatever surrounds it
  { what: 'a review whose label has a colon in it', tier: 'SONNET', role: 'Reviewer: security', mode: 'read', effort: 'AUTO', wave: 'RECONNAISSANCE', suggests: 'SONNET' },
  { what: 'a scout whose label has a colon in it', tier: 'SONNET', role: 'Scout: inventory', mode: 'read', effort: 'AUTO', wave: 'ENGINEERING', suggests: 'HAIKU' },
  { what: 'an inventory of the architecture is an inventory', tier: 'HAIKU', role: 'Architecture inventory', mode: 'read', effort: 'AUTO', wave: 'ENGINEERING', suggests: 'HAIKU' },
  { what: 'a worker that only reads is still an engineer', tier: 'SONNET', role: 'worker', mode: 'read', effort: 'AUTO', wave: 'RECONNAISSANCE', suggests: 'SONNET' },
  { what: 'a debugger sent during reconnaissance investigates', tier: 'SONNET', role: 'Debugger', mode: 'read', effort: 'AUTO', wave: 'RECONNAISSANCE', suggests: 'SONNET' },
  // the commander's own
  { what: 'an architecture decision', tier: 'SONNET', role: 'Architect', mode: 'read', effort: 'AUTO', wave: 'RECONNAISSANCE', suggests: 'OPUS' },
  { what: 'integration kept in the main loop', tier: 'OPUS', role: 'Integration', mode: 'write', effort: 'AUTO', wave: 'INTEGRATION', suggests: 'OPUS' },
]

describe('the route suggestion on representative assignments', () => {
  test('each kind of work is suggested to the tier that suits it', () => {
    for (const c of REPRESENTATIVE) expect([c.what, suggestRoute(c).tier]).toEqual([c.what, c.suggests])
  })
  test('every suggestion carries its reason', () => {
    for (const c of REPRESENTATIVE) expect(suggestRoute(c).reason.length).toBeGreaterThan(8)
    expect(suggestRoute(REPRESENTATIVE[0]!).reason).toBe('bounded extractive read (the role)')
    expect(suggestRoute({ tier: 'SONNET', role: 'Lookup', mode: 'read', effort: 'low', wave: 'ENGINEERING' }).reason).toBe('read-only work the commander named light')
    expect(suggestRoute({ tier: 'SONNET', role: 'Lookup', mode: 'read', effort: 'AUTO', wave: 'RECONNAISSANCE' }).reason).toBe('read-only reconnaissance')
    expect(suggestRoute({ tier: 'SONNET', role: 'Engineer', mode: 'read', effort: 'low', wave: 'RECONNAISSANCE' }).reason).toBe('an engineering role, even when it only reads')
    expect(suggestRoute({ tier: 'HAIKU', role: 'utility', mode: 'write', effort: 'AUTO', wave: 'ENGINEERING' }).reason).toBe('a write task is engineering work')
    expect(suggestRoute({ tier: 'HAIKU', role: 'reviewer', mode: 'read', effort: 'low', wave: 'REVIEW' }).reason).toBe('independent review needs engineering judgement')
    expect(suggestRoute({ tier: 'SONNET', role: 'Reader', mode: 'read', effort: 'xhigh', wave: 'RECONNAISSANCE' }).reason).toBe('the commander named heavy reasoning (xhigh)')
    expect(suggestRoute({ tier: 'SONNET', role: 'Architect', mode: 'read', effort: 'AUTO', wave: 'ENGINEERING' }).reason).toBe('architecture belongs with the commander')
  })
  test('Haiku is never suggested for a write, a review, an architect or work named heavy, whatever else is true', () => {
    const waves: Wave[] = ['RECONNAISSANCE', 'ENGINEERING', 'REVIEW', 'INTEGRATION', 'VERIFICATION']
    const efforts: EffortRequest[] = ['AUTO', 'low', 'medium', 'high', 'xhigh', 'max']
    for (const wave of waves) for (const effort of efforts) for (const role of ['SCOUT', 'utility', 'Lookup', 'Engineer', 'worker', 'implementer', 'reviewer', 'Reviewer: security', 'cobalt-cockpit:reviewer', 'Security audit', 'Verifier', 'Architect', 'explorer', '']) {
      for (const tier of ['HAIKU', 'SONNET'] as const) {
        expect(suggestRoute({ tier, role, mode: 'write', effort, wave }).tier).not.toBe('HAIKU')
        if (/review|audit|verif|secur|architect|engineer|worker|implementer/i.test(role) || ['high', 'xhigh', 'max'].includes(effort)) expect([role, effort, wave, suggestRoute({ tier, role, mode: 'read', effort, wave }).tier === 'HAIKU']).toEqual([role, effort, wave, false])
      }
    }
  })
  test('the objective\'s words are not evidence: the same fields give the same suggestion', () => {
    let s = emptySwarm()
    s = submitTask(s, { id: 'a', tier: 'SONNET', role: 'Lookup', objective: 'inventory, list, scan, classify every file', mode: 'read' }, 1).swarm
    s = submitTask(s, { id: 'b', tier: 'SONNET', role: 'Lookup', objective: 'redesign the architecture of the security boundary', mode: 'read' }, 2).swarm
    expect(s.tasks.map(t => t.suggestedTier)).toEqual(['HAIKU', 'HAIKU'])   // both: a read in the reconnaissance wave
    s = { ...s, wave: 'ENGINEERING' }
    s = submitTask(s, { id: 'c', tier: 'SONNET', role: 'Lookup', objective: 'inventory, list, scan, classify every file', mode: 'read' }, 3).swarm
    expect(s.tasks.at(-1)?.suggestedTier).toBe('SONNET')
  })
  test('the suggestion agrees with routeTask on its three outcomes', () => {
    expect(routeTask({ extractive: true, bounded: true })).toBe(suggestRoute({ tier: 'SONNET', role: 'scout', mode: 'read', effort: 'AUTO', wave: 'ENGINEERING' }).tier)
    expect(routeTask({ extractive: true, bounded: false })).toBe(suggestRoute({ tier: 'SONNET', role: 'scout', mode: 'read', effort: 'high', wave: 'ENGINEERING' }).tier)
    expect(routeTask({ architecture: true, extractive: true, bounded: true })).toBe(suggestRoute({ tier: 'SONNET', role: 'Architect scout', mode: 'read', effort: 'low', wave: 'RECONNAISSANCE' }).tier)
  })
})

const assignAll = (): Swarm => {
  let s = emptySwarm({ total: 6, sonnet: 3, haiku: 4 })
  for (const [n, c] of REPRESENTATIVE.entries()) s = submitTask({ ...s, wave: c.wave }, { id: `t${n}`, tier: c.tier, role: c.role, objective: c.what, mode: c.mode, owned: [`/work/t${n}`], effort: c.effort }, n).swarm

  return s
}

describe('the suggestion is recorded and never acted on', () => {
  test('an assignment keeps the commander\'s tier and records what the route suggested, with why', () => {
    const s = assignAll()
    for (const [n, c] of REPRESENTATIVE.entries()) {
      const t = s.tasks[n] as SwarmTask
      expect([c.what, t.tier, t.suggestedTier]).toEqual([c.what, c.tier, c.suggests])
      expect(t.state).toBe('queued')
      expect(t.agentId).toBeNull()
    }
    // nothing was admitted, reserved or spawned by assigning
    expect(s.actual).toBe(0)
    expect(s.highWater).toBe(0)
    expect(s.events.every(e => e.kind === 'assignment')).toBe(true)
    // the difference is in the event the Ledger keeps, and only where there is one
    const differing = REPRESENTATIVE.map((c, n) => ({ c, n })).filter(({ c }) => c.tier !== c.suggests)
    expect(differing.length).toBeGreaterThan(0)
    for (const { c, n } of differing) expect(s.events[n]!.detail).toContain(`route suggested ${c.suggests}`)
    for (const [n, c] of REPRESENTATIVE.entries()) if (c.tier === c.suggests) expect(s.events[n]!.detail).not.toContain('route suggested')
  })
  test('the funnel counts suggested, requested, admitted, spawned, completed and verified apart', () => {
    let s = assignAll()
    const before = routingOf(s)
    const count = (f: (c: Case) => boolean) => REPRESENTATIVE.filter(f).length
    expect(before.tiers.HAIKU).toEqual({ suggested: count(c => c.suggests === 'HAIKU'), requested: count(c => c.tier === 'HAIKU'), admitted: 0, spawned: 0, completed: 0, verified: 0 })
    expect(before.tiers.SONNET.requested).toBe(count(c => c.tier === 'SONNET'))
    expect(before.tiers.OPUS).toEqual({ suggested: 2, requested: 1, admitted: 0, spawned: 0, completed: 0, verified: 0 })
    expect(before.differing).toBe(count(c => c.tier !== c.suggests))
    expect(before.unrecorded).toBe(0)
    // t0 and t4 are the two requested of Haiku that the route also suggests to Haiku
    s = admitTask(s, 't0', 100).swarm
    expect(routingOf(s).tiers.HAIKU).toMatchObject({ admitted: 1, spawned: 0, completed: 0 })
    s = bindAgent(s, 't0', 'agent-0', 101)
    s = admitTask(s, 't4', 102).swarm
    expect(routingOf(s).tiers.HAIKU).toMatchObject({ admitted: 2, spawned: 1, completed: 0, verified: 0 })
    s = finishTask(s, 't0', 'completed', { conclusion: 'listed' }, 110)
    expect(routingOf(s).tiers.HAIKU).toMatchObject({ admitted: 2, spawned: 1, completed: 1, verified: 0 })
    s = verifyTask(s, 't0', 'pass', 120, 'checked against the files')
    expect(routingOf(s).tiers.HAIKU).toMatchObject({ admitted: 2, spawned: 1, completed: 1, verified: 1 })
    // a task that failed was spawned and is not completed; a cancelled one that never started was never admitted
    s = bindAgent(s, 't4', 'agent-4', 121)
    s = finishTask(s, 't4', 'failed', { conclusion: 'could not read' }, 130)
    s = finishTask(s, 't1', 'cancelled', null, 131)
    expect(routingOf(s).tiers.HAIKU).toMatchObject({ requested: count(c => c.tier === 'HAIKU'), admitted: 2, spawned: 2, completed: 1, verified: 1 })
    expect(summarizeSwarm(s).routing).toEqual(routingOf(s))
  })
  test('a ledger written before v0.6.1 has tasks with no suggestion: they are counted as unrecorded, never guessed', () => {
    const now = assignAll()
    const old: Swarm = { ...now, tasks: now.tasks.map(({ suggestedTier: _s, routeReason: _r, ...t }) => t) }
    const routing = routingOf(old)
    expect(routing.unrecorded).toBe(REPRESENTATIVE.length)
    expect(routing.differing).toBe(0)
    expect(routing.tiers.HAIKU.suggested + routing.tiers.SONNET.suggested + routing.tiers.OPUS.suggested).toBe(0)
    expect(routing.tiers.HAIKU.requested).toBe(routingOf(now).tiers.HAIKU.requested)
    const view = { swarm: old, agents: [], now: 1000, columns: 120 }
    expect(agentsText(view)).toContain(`${REPRESENTATIVE.length} tasks carry no suggestion (assigned before v0.6.1)`)
    expect(taskText(view, 't0')).toContain('route: no suggestion recorded (assigned before v0.6.1)')
    // and such a ledger still admits, runs and completes as before
    let s = admitTask(old, 't0', 100).swarm
    s = finishTask(bindAgent(s, 't0', 'agent-0', 101), 't0', 'completed', { conclusion: 'done' }, 110)
    expect(s.tasks[0]!.state).toBe('completed')
  })
})

describe('the Inspector shows the funnel and each task\'s route', () => {
  const s = bindAgent(admitTask(assignAll(), 't0', 100).swarm, 't0', 'agent-0', 101)
  const view = (columns: number) => ({ swarm: s, agents: [], now: 1000, columns })
  test('/cockpit agents: one line per tier, the six figures apart, and how many assignments differ', () => {
    const text = agentsText(view(120))
    const r = routingOf(s)
    expect(text).toContain(`ROUTE HAIKU · suggested ${r.tiers.HAIKU.suggested} · requested ${r.tiers.HAIKU.requested} · admitted 1 · spawned 1 · completed 0 · verified 0`)
    expect(text).toContain(`ROUTE SONNET · suggested ${r.tiers.SONNET.suggested} · requested ${r.tiers.SONNET.requested} · admitted 0 · spawned 0 · completed 0 · verified 0`)
    expect(text).toContain('ROUTE OPUS · suggested 2 · requested 1')
    expect(text).toContain(`${r.differing} assignments differ from the route's suggestion; the commander's tier stands`)
    expect(text).not.toContain('carry no suggestion')
  })
  test('narrow terminals keep every figure and every line inside the width', () => {
    const r = routingOf(s).tiers.HAIKU
    expect(agentsText(view(70))).toContain(`ROUTE HAIKU · sug ${r.suggested} · req ${r.requested} · adm 1 · spawn 1 · done 0 · ver 0`)
    expect(agentsText(view(44))).toContain(`HAIKU sug${r.suggested} req${r.requested} adm1 spn1 done0 ver0`)
    for (const columns of [30, 44, 60, 64, 79, 96, 120]) for (const line of agentsText(view(columns)).split('\n')) expect(line.length).toBeLessThanOrEqual(Math.max(columns, 30))
  })
  test('/cockpit agents <task>: the suggestion beside the commander\'s tier, which stands', () => {
    expect(taskText(view(200), 't0')).toContain('route: HAIKU, as the route suggested (bounded extractive read (the role))')
    expect(taskText(view(200), 't1')).toContain('route: requested SONNET; the route suggested HAIKU (bounded extractive read (the role)). The commander\'s tier stands')
    expect(taskText(view(200), 't18')).toContain('route: requested HAIKU; the route suggested SONNET (a write task is engineering work)')
  })
  test('an empty swarm shows no route line', () => {
    expect(agentsText({ swarm: emptySwarm(), agents: [], now: 0, columns: 120 })).not.toContain('ROUTE')
  })
})

describe('through the real swarm tool: advice only', () => {
  type Engine = Parameters<typeof start>[0]
  const SWARM = 'mcp__cobalt-cockpit__swarm'
  const options = { options: { orchestration: true, maxSubagents: 6, maxSonnetAgents: 3, maxHaikuAgents: 4 } }
  const assign = ($: Engine, id: string, extra: Record<string, unknown>) => $.tool.call({ tool: SWARM, action: 'assign', task_id: id, tier: 'SONNET', role: 'Lookup', objective: `Bounded ${id}`, scope: `Scope ${id}`, owned_resources: [`/work/${id}`], mode: 'read', spawn_reason: 'Independent bounded host test', ...extra } as never)
  const spawn = ($: Engine, id: string, subagentType: string) => $.agent.spawn({ prompt: `Perform task ${id}`, description: `[task:${id}] bounded work`, subagentType, tool_use_id: `spawn-${id}`, parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false } as never)
  const swarmOf = (held: ReturnType<typeof hostState>): Swarm => (held.get('run-ledger')!.value as Ledger).swarm!

  test('the reply names a differing suggestion, changes no tier and starts nothing', options, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    const differs = String((await assign($, 'lookup', { role: 'scout' })).result)
    expect(differs).toContain('Task lookup queued; use Agent description [task:lookup]')
    expect(differs).toContain('ROUTE / HAIKU suggested (bounded extractive read (the role)); SONNET kept as assigned')
    // the advice says how it could be followed: a task id is never reused, so the work is assigned again under a new one
    expect(differs).toContain('Advice only. To follow it, cancel this task and assign the work under a new task_id.')
    await $.tool.call({ tool: SWARM, action: 'cancel', task_id: 'lookup' } as never)
    expect(String((await assign($, 'lookup', { tier: 'HAIKU', role: 'scout' })).result)).toBe('Task lookup already exists and is cancelled; nothing was assigned. A task id is never reused: assign the work under a new task_id.')
    expect(String((await assign($, 'lookup-2', { tier: 'HAIKU', role: 'scout' })).result)).toContain('Task lookup-2 queued')
    const agrees = String((await assign($, 'scan', { tier: 'HAIKU', role: 'scout' })).result)
    expect(agrees).toContain('Task scan queued')
    expect(agrees).not.toContain('ROUTE /')
    const risky = String((await assign($, 'migrate', { tier: 'HAIKU', role: 'utility', mode: 'write' })).result)
    expect(risky).toContain('ROUTE / SONNET suggested (a write task is engineering work); HAIKU kept as assigned')
    expect(swarmOf(held).tasks.map(t => [t.id, t.tier, t.suggestedTier, t.state])).toEqual([['lookup', 'SONNET', 'HAIKU', 'cancelled'], ['lookup-2', 'HAIKU', 'HAIKU', 'queued'], ['scan', 'HAIKU', 'HAIKU', 'queued'], ['migrate', 'HAIKU', 'SONNET', 'queued']])
    // assigning spawned nothing, and no model was called
    expect(w.spawns).toHaveLength(0)
    const status = JSON.parse(String((await $.tool.call({ tool: SWARM, action: 'status' } as never)).result))
    expect(status.tasks.map((t: { id: string; suggested: string }) => [t.id, t.suggested]).sort()).toEqual([['lookup', 'HAIKU'], ['lookup-2', 'HAIKU'], ['migrate', 'SONNET'], ['scan', 'HAIKU']])
    expect(status.routing.differing).toBe(2)
    expect(status.routing.tiers.HAIKU).toEqual({ suggested: 3, requested: 3, admitted: 0, spawned: 0, completed: 0, verified: 0 })
  })
  test('an Opus suggestion says where that decision is made, in each profile', options, async ($, on) => {
    world(on); await start($)
    const led = String((await assign($, 'design', { role: 'Architect' })).result)
    expect(led).toContain('ROUTE / OPUS suggested (architecture belongs with the commander); SONNET kept as assigned. Advice only. That decision is the commander\'s to make in the main session.')
    expect(led).not.toContain('new task_id')
  })
  test('in SONNET_LED an Opus suggestion points to consult, the only way Opus is admitted there', { options: { orchestration: true, profile: 'SONNET_LED' } }, async ($, on) => {
    world(on); await start($)
    const led = String((await assign($, 'design', { role: 'Architect' })).result)
    expect(led).toContain('ROUTE / OPUS suggested')
    expect(led).toContain('An Opus view is asked for with action consult, on a ground that holds.')
    expect(String((await assign($, 'direct', { tier: 'OPUS', role: 'Architect' })).result)).toContain('only through action consult')
  })
  test('a read claim is never widened: an ambiguous entry is refused, and "*" is only what the commander wrote', options, async ($, on) => {
    world(on); const held = hostState(on, {}); await start($)
    const literal = String((await assign($, 'narrow', { owned_resources: ['/work/example/hooks'] })).result)
    expect(literal).not.toContain('SCOPE /')
    // a bracketed name is a literal path, not a pattern: it is claimed narrowly
    const bracket = String((await assign($, 'bracket', { owned_resources: ['app/[id]/page.tsx'] })).result)
    expect(bracket).toContain('Task bracket queued')
    expect(swarmOf(held).tasks.find(t => t.id === 'bracket')?.owned[0]).toContain('/app/[id]/page.tsx')
    const explicit = String((await assign($, 'whole', { owned_resources: ['*'] })).result)
    expect(explicit).toContain('SCOPE / this read task claims *, the whole repository, as you wrote it.')
    for (const [id, claim, why] of [['glob', 'src/**/*.ts', 'a pattern'], ['question', 'src/?.ts', 'a pattern'], ['home', '~/notes', 'a home path']] as const) {
      const reply = String((await assign($, id, { owned_resources: ['/work/example/hooks', claim] })).result)
      expect([id, reply.includes('READ SCOPE /'), reply.includes(why), reply.includes('Nothing was assigned.')]).toEqual([id, true, true, true])
      expect(swarmOf(held).tasks.some(t => t.id === id)).toBe(false)
    }
    const none = String((await assign($, 'unnamed', { owned_resources: [] })).result)
    expect(none).toContain('READ SCOPE / a read task needs owned_resources')
    expect(swarmOf(held).tasks.some(t => t.id === 'unnamed')).toBe(false)
  })
  test('what is spawned is the commander\'s tier, within the configured pools', options, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    await assign($, 'lookup', { role: 'scout' })                        // suggested HAIKU, requested SONNET
    await assign($, 'scan', { tier: 'HAIKU', role: 'scout' })
    expect((await spawn($, 'lookup', 'cobalt-cockpit:explorer')).agentId).toBeDefined()
    expect((await spawn($, 'scan', 'cobalt-cockpit:scout')).agentId).toBeDefined()
    expect(w.spawns.map(s => String(s['model']))).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])
    expect(routingOf(swarmOf(held)).tiers).toMatchObject({ SONNET: { requested: 1, admitted: 1, spawned: 1 }, HAIKU: { suggested: 2, requested: 1, admitted: 1, spawned: 1 } })
    // the Haiku pool's ceiling is the operator's: four at once, however many are suggested
    for (const n of [1, 2, 3, 4]) await assign($, `h${n}`, { tier: 'HAIKU', role: 'scout' })
    const more = await Promise.all([1, 2, 3, 4].map(n => spawn($, `h${n}`, 'cobalt-cockpit:scout')))
    expect(more.filter(r => r.agentId).length).toBe(3)
    expect(more.filter(r => r.deny).map(r => r.deny)[0]).toContain('resource budget')
  })
  test('the commander is told when Haiku suits, what a scout can do and what a claim costs', () => {
    const text = orchestrationText(6)
    for (const term of ['Prefer a Haiku scout or utility when a read-only question is extractive and can be bounded', 'in one batch at the start of reconnaissance', 'git grep, git ls-files, git log, git diff, git show and git status', 'your own shell effects are held', 'ROUTE suggestion', 'the tier you assigned stands', 'Never manufacture subagent work']) expect(text).toContain(term)
    const led = orchestrationText(4, 'SONNET_LED')
    for (const term of ['git grep, git ls-files, git log, git diff, git show and git status', 'ROUTE suggestion', 'Never spawn an agent for a single-file lookup']) expect(led).toContain(term)
  })
})
