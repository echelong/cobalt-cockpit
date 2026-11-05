// The mission supervisor: admission, scheduling, workers, verification, integration,
// escalation and the mission verdict. Host-side policy is authoritative; models
// propose, the supervisor decides. Everything durable goes through store.ts.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { cpus, freemem, loadavg } from 'node:os'
import { join } from 'node:path'
import {
  emptySwarm, submitTask, admitTask, bindAgent, uncertainSpawn, finishTask, releaseReservation, overlaps, POOL_OF, ROLES,
} from './core/engine.ts'
import type { Role, Swarm } from './core/engine.ts'
import type { Config } from './config.ts'
import type { Resolution } from './catalog.ts'
import { routeTask, nextStep, healthKey } from './router.ts'
import type { FailureClass, Health, RouteDecision, TaskSpec } from './router.ts'
import { chargeOf, checkBudget, pricingFor } from './cost.ts'
import type { Usage } from './cost.ts'
import { runWorker, targetOf } from './worker.ts'
import type { StreamFacts, WorkerOutcome, WorkerSpec, Control } from './worker.ts'
import type { Identity } from './sandbox.ts'
import { census, processIdentity, sameProcess, terminate } from './proc.ts'
import type { Census, ProcessIdentity } from './proc.ts'
import type { WireVerdict } from './reasoning.ts'
import { gitGate, runCommandGate, securityGate } from './gates.ts'
import type { GateResult, GateSpec } from './gates.ts'
import { addTaskWorktree, changesOf, commitTask, createIntegration, headOf, integrate, missionBranch, repoInfo } from './git.ts'
import type { RepoInfo } from './git.ts'
import { needsCommander, parsePlan, parseRequest, plannerPrompt, workerPrompt } from './planner.ts'
import { ownedCovers } from './hook/policy.ts'
import {
  Archive, Ledger, claimsLock, epochToken, listClaims, lostMissions, newId, readJson, retireClaim, retireMarker,
  storeBytes, tryLock, unlock, withLock, writeAtomic, writeClaim, writeMarker,
} from './store.ts'

// ---------------------------------------------------------------------------
export type AttemptRecord = {
  n: number; id: string; role: Role; provider: string; model: string
  requestedReasoning: string | null; cliThinking: string | null; expectedWire: string | null; mapping: string | null
  route: RouteDecision; engineId: string; phase: 'reserved' | 'dispatching' | 'running' | 'ended' | 'held'
  startedAt: string; endedAt: string | null; identity: Identity | null; worktree: string | null; base: string | null
  usage: Usage; usageEvents: number; toolCalls: Record<string, number>; iterations: number
  finishReason: string | null; reportedModel: string | null; reportedProvider: string | null
  wire: WireVerdict | null; census: Census | null; stoppedBy: string | null; exitCode: number | null
  charge: { usd: number | null; basis: 'reported' | 'estimate' | 'unmetered' }; estimateUsd: number | null
  failure: FailureClass | 'cancelled' | 'integration_conflict' | null; failureDetail: string | null
  gates: GateResult[]; changes: string[]; commit: string | null; resultExcerpt: string | null
  hookRefusals: { tool: string; reason: string }[]; alerts: number[]
}
export type TaskState = 'queued' | 'running' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'held' | 'refused'
export type TaskRecord = {
  spec: TaskSpec; state: TaskState; attempts: AttemptRecord[]; transientRetries: number; escalations: number
  escalateTo: Role | null; evidence: string[]; createdAt: number; updatedAt: number; reason: string | null
  verification: 'PROVISIONAL_CHECKED' | 'SELF_REPORTED_UNCHECKED' | null; integratedHead: string | null; children: string[]; requestsRefused: string[]
}
export type Verdict = { state: 'DONE' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'STOPPED' | 'UNVERIFIED'; reasons: string[]; at: string }
export type Live = {
  version: 1; missionId: string; epoch: string; state: 'planning' | 'running' | 'finalizing' | 'done' | 'stopped'
  supervisor: ProcessIdentity | null; tasks: Record<string, TaskRecord>; swarm: Swarm
  session: { spentUsd: number; tokens: number; archivedUsd: number; archivedTokens: number; unmetered: boolean; alertsFired: number[]; capReached: boolean; unmeteredTasks: string[] }
  health: Health; aimd: Record<string, number>; spawnTimes: number[]
  counters: { created: number; completed: number; failed: number; cancelled: number; refused: number; archived: number; attempts: number }
  recent: { id: string; title: string; state: TaskState; role: Role | null; model: string | null; usd: number | null; at: string }[]
  integration: { dir: string; branch: string; base: string; head: string }
  finalGates: GateResult[]; review: { text: string | null; attempt: string | null } | null
  verdict: Verdict | null; alerts: string[]; stopRequested: string | null; updatedAt: string
}
export type Header = {
  id: string; repoRoot: string; commonDir: string; base: string; createdAt: string; profile: string; strict: boolean
  goal: string; epoch: string; configDigest: string; gates: GateSpec[]; clineVersion: string; mode: 'single' | 'commander' | 'plan-file'
  modeReason: string; review: boolean; requireGates: boolean
}
export type Deps = {
  clineBin: string; clineDataDir: string; now: () => number
  runWorker: typeof runWorker
  shareDirs: { from: string; to: string }[]
  log: (line: string) => void
}

const TERMINAL: TaskState[] = ['completed', 'failed', 'cancelled', 'refused']
const CPU_COUNT = Math.max(1, cpus().length) // os.cpus() is slow; the count does not change
const SUCCESS_CLAIM = /\b(?:all\s+tests?\s+pass|tests?\s+(?:pass|passed|passing)|done|completed?|finished|fixed|implemented|works)\b/i

export const missionDir = (root: string, id: string): string => join(root, 'missions', id)

// ---------------------------------------------------------------------------
export class Mission {
  readonly ledger: Ledger
  readonly archive: Archive
  private controls = new Map<string, Control>()
  private running = new Map<string, Promise<void>>()
  private integrating: Promise<unknown> = Promise.resolve()
  private lastPersist = 0
  private lockFile: string

  constructor(readonly dir: string, readonly header: Header, public live: Live, readonly config: Config, readonly resolutions: Record<Role, Resolution>, readonly deps: Deps) {
    this.ledger = new Ledger(join(dir, 'ledger'))
    this.archive = new Archive(join(dir, 'archive'), config.limits.pageSize)
    this.lockFile = join(dir, 'supervisor.lock')
  }

  // ----- creation and loading --------------------------------------------------
  static async create(o: { stateRoot: string; repoDir: string; goal: string; config: Config; resolutions: Record<Role, Resolution>; deps: Deps; gates: GateSpec[]; clineVersion: string; tasks?: TaskSpec[]; single?: boolean; swarm?: boolean; review?: boolean; allowDirty?: boolean; requireGates?: boolean }): Promise<Mission> {
    const repo = await repoInfo(o.repoDir)
    const lost = lostMissions(repo.commonDir)
    if (lost.length) throw new Error(`mission state is missing for ${lost.map(l => `${l.marker.missionId} (${l.why})`).join('; ')}. Run: cockpit-cline recover --lost <id>. No new mission starts while a mission's claims cannot be accounted for.`)
    if (repo.dirty && !o.allowDirty) throw new Error('the repository has uncommitted changes; workers start from HEAD and would not see them. Commit them, or pass --allow-dirty to proceed from HEAD anyway.')
    const id = newId('m')
    const dir = missionDir(o.stateRoot, id)
    mkdirSync(join(dir, 'runs'), { recursive: true, mode: 0o700 })
    const epoch = epochToken()
    const decision = o.tasks ? { commander: false, reason: 'plan file supplied' } : needsCommander(o.goal, { swarm: o.swarm, single: o.single })
    const header: Header = {
      id, repoRoot: repo.root, commonDir: repo.commonDir, base: repo.head, createdAt: new Date().toISOString(), profile: o.config.profile, strict: o.config.strict,
      goal: o.goal, epoch, configDigest: createHash('sha256').update(JSON.stringify(o.config)).digest('hex').slice(0, 16), gates: o.gates, clineVersion: o.clineVersion,
      mode: o.tasks ? 'plan-file' : decision.commander ? 'commander' : 'single', modeReason: decision.reason, review: o.review ?? decision.commander, requireGates: o.requireGates ?? true,
    }
    const integrationDir = join(o.stateRoot, 'worktrees', id, '_integration')
    mkdirSync(join(o.stateRoot, 'worktrees', id), { recursive: true, mode: 0o700 })
    writeAtomic(join(dir, 'mission.json'), JSON.stringify(header, null, 1))
    writeMarker(repo.commonDir, { missionId: id, stateDir: dir, epoch, createdAt: header.createdAt })
    await createIntegration(repo, id, repo.head, integrationDir)
    const pools = o.config.limits.concurrency.total
    const live: Live = {
      version: 1, missionId: id, epoch, state: 'planning', supervisor: null, tasks: {},
      swarm: emptySwarm({ total: pools, sonnet: pools, haiku: pools, opus: Math.max(1, o.config.limits.concurrency.commander), maxTasks: 4096, maxEvents: 256 }),
      session: { spentUsd: 0, tokens: 0, archivedUsd: 0, archivedTokens: 0, unmetered: false, alertsFired: [], capReached: false, unmeteredTasks: [] }, health: {}, aimd: {}, spawnTimes: [],
      counters: { created: 0, completed: 0, failed: 0, cancelled: 0, refused: 0, archived: 0, attempts: 0 }, recent: [],
      integration: { dir: integrationDir, branch: missionBranch(id), base: repo.head, head: repo.head },
      finalGates: [], review: null, verdict: null, alerts: [], stopRequested: null, updatedAt: new Date().toISOString(),
    }
    const m = new Mission(dir, header, live, o.config, o.resolutions, o.deps)
    m.ledger.append('mission_created', null, { header: { ...header, goal: header.goal.slice(0, 2000) }, models: Object.fromEntries(ROLES.map(r => [r, o.resolutions[r].ok ? `${o.resolutions[r].provider}/${o.resolutions[r].model}` : `UNRESOLVED: ${(o.resolutions[r] as { reason: string }).reason}`])) })
    if (o.tasks) for (const t of o.tasks) m.addTask(t, 'plan-file')
    else if (decision.commander) m.addTask({ id: 'plan', title: 'Commander: decompose the goal', kind: 'architecture', risk: 'medium', complexity: 4, mode: 'read', owned: ['*'], dependencies: [], prompt: plannerPrompt(o.goal, `${repo.root} at ${repo.head.slice(0, 12)}`), priority: 9, depth: 0, parent: null }, 'commander-planning')
    else m.addTask({ id: 'task', title: o.goal.split('\n')[0].slice(0, 120), kind: 'implement', risk: 'medium', complexity: 3, mode: 'write', owned: ['*'], dependencies: [], prompt: o.goal, priority: 5, depth: 0, parent: null }, 'single')
    m.live.state = 'running'
    m.persist(true)
    return m
  }

  static open(stateRoot: string, id: string, config: Config, resolutions: Record<Role, Resolution>, deps: Deps): Mission {
    const dir = missionDir(stateRoot, id)
    if (!existsSync(join(dir, 'mission.json'))) throw new Error(`mission ${id} not found under ${stateRoot}`)
    const header = readJson<Header>(join(dir, 'mission.json'))
    const live = readJson<Live>(join(dir, 'live.json'))
    if (live.epoch !== header.epoch) throw new Error(`mission ${id}: live state epoch differs from header (store replaced); refusing`)
    return new Mission(dir, header, live, config, resolutions, deps)
  }

  // ----- supervisor exclusivity ------------------------------------------------
  acquire(): void {
    const r = tryLock(this.lockFile, `supervise ${this.header.id}`)
    if (!r.ok) {
      if (!r.stale) throw new Error(`mission ${this.header.id} is supervised by pid ${r.holder?.holder.pid ?? '?'}; a second supervisor is refused`)
      unlinkSync(this.lockFile)
      const again = tryLock(this.lockFile, `supervise ${this.header.id}`)
      if (!again.ok) throw new Error('could not take over the supervisor lock')
      this.ledger.append('supervisor_takeover', null, { previous: r.holder })
    }
    this.live.supervisor = processIdentity(process.pid)
  }
  release(): void { unlock(this.lockFile) }

  // ----- persistence -----------------------------------------------------------
  persist(force = false): void {
    const now = this.deps.now()
    if (!force && now - this.lastPersist < 500) return
    this.lastPersist = now
    for (const [id, t] of Object.entries(this.live.tasks)) {
      if (!TERMINAL.includes(t.state) || t.attempts.some(a => a.phase !== 'ended')) continue
      this.archive.put(id, t as unknown as { state: string })
      const usd = t.attempts.reduce((x, a) => x + (a.charge.usd ?? 0), 0)
      this.live.session.archivedUsd += usd
      this.live.session.archivedTokens += t.attempts.reduce((x, a) => x + a.usage.inputTokens + a.usage.outputTokens, 0)
      const last = t.attempts.at(-1)
      this.live.recent = [{ id, title: t.spec.title, state: t.state, role: last?.role ?? null, model: last?.model ?? null, usd: t.attempts.some(a => a.charge.usd === null && a.usageEvents === 0 && a.iterations > 0) ? null : usd, at: new Date().toISOString() }, ...this.live.recent].slice(0, 50)
      delete this.live.tasks[id]
      this.live.counters.archived++
    }
    this.live.swarm = { ...this.live.swarm, tasks: this.live.swarm.tasks.filter(t => !['completed', 'failed', 'cancelled'].includes(t.state)) }
    this.live.updatedAt = new Date(now).toISOString()
    writeAtomic(join(this.dir, 'live.json'), JSON.stringify(this.live))
  }

  // ----- tasks -------------------------------------------------------------------
  allTaskIds(): Set<string> { return new Set([...Object.keys(this.live.tasks)]) }
  taskState(id: string): string | null { return this.live.tasks[id]?.state ?? this.archive.stateOf(id) }

  addTask(spec: TaskSpec, source: string): { ok: boolean; reason: string | null } {
    const queued = Object.values(this.live.tasks).filter(t => t.state === 'queued').length
    const max = this.config.limits.maxTasksPerMission
    let reason: string | null = null
    if (this.live.tasks[spec.id] || this.archive.stateOf(spec.id)) reason = `duplicate task id ${spec.id}`
    else if (queued >= this.config.limits.maxQueue) reason = `backpressure: ${queued} tasks queued (limit ${this.config.limits.maxQueue})`
    else if (max !== null && this.live.counters.created >= max) reason = `mission task limit ${max} reached`
    else if ((spec.depth ?? 0) > this.config.limits.maxDelegationDepth) reason = `delegation depth ${spec.depth} exceeds ${this.config.limits.maxDelegationDepth}`
    else if (this.live.session.capReached) reason = 'session budget reached: no new work is admitted'
    if (reason) { this.ledger.append('task_refused', spec.id, { source, reason }); return { ok: false, reason } }
    const now = this.deps.now()
    this.live.tasks[spec.id] = { spec, state: 'queued', attempts: [], transientRetries: 0, escalations: 0, escalateTo: null, evidence: [], createdAt: now, updatedAt: now, reason: null, verification: null, integratedHead: null, children: [], requestsRefused: [] }
    this.live.counters.created++
    this.ledger.append('task_added', spec.id, { source, spec: { ...spec, prompt: spec.prompt.slice(0, 2000) } })
    return { ok: true, reason: null }
  }

  private depsReady(t: TaskRecord): { ready: boolean; dead: string | null } {
    for (const d of t.spec.dependencies) {
      const s = this.taskState(d)
      if (s === 'completed') continue
      if (s === 'failed' || s === 'cancelled' || s === 'refused' || s === null) return { ready: false, dead: `dependency ${d}: ${s ?? 'unknown'}` }
      return { ready: false, dead: null }
    }
    return { ready: true, dead: null }
  }

  private runningByRole(): Record<string, number> {
    const c: Record<string, number> = {}
    for (const t of Object.values(this.live.tasks)) for (const a of t.attempts) if (a.phase !== 'ended') { c[a.role] = (c[a.role] ?? 0) + 1; c[`p:${a.provider}`] = (c[`p:${a.provider}`] ?? 0) + 1; c.total = (c.total ?? 0) + 1 }
    return c
  }

  /** Resource admission: why no new worker may start now, or null. */
  capacityRefusal(role: Role, provider: string): string | null {
    const l = this.config.limits; const c = this.runningByRole()
    if (this.live.stopRequested) return `stop requested: ${this.live.stopRequested}`
    if (this.live.session.capReached) return 'session budget reached'
    if (this.live.session.unmetered && !this.config.budgets.allowUnmetered) return 'session usage is unmetered (a run reported no usage): admissions stopped'
    if ((c.total ?? 0) >= l.concurrency.total) return `concurrency: ${c.total} of ${l.concurrency.total} workers running`
    if ((c[role] ?? 0) >= l.concurrency[role]) return `concurrency: ${c[role]} ${role} worker(s) of ${l.concurrency[role]}`
    const provCap = Math.min(l.perProvider[provider] ?? l.concurrency.total, this.live.aimd[provider] ?? l.concurrency.total)
    if ((c[`p:${provider}`] ?? 0) >= provCap) return `provider ${provider}: ${c[`p:${provider}`]} of ${provCap} concurrent (adaptive)`
    const now = this.deps.now()
    this.live.spawnTimes = this.live.spawnTimes.filter(t => now - t < 60_000)
    if (this.live.spawnTimes.length >= l.spawnsPerMinute) return `rate: ${this.live.spawnTimes.length} spawns in the last minute (limit ${l.spawnsPerMinute})`
    const freeMb = Math.floor(freemem() / 1048576)
    if (freeMb < l.minFreeMemoryMB && (c.total ?? 0) > 0) return `memory: ${freeMb} MB free, below ${l.minFreeMemoryMB} MB`
    const load = loadavg()[0] / CPU_COUNT
    if (load > l.maxLoadPerCpu && (c.total ?? 0) > 0) return `cpu: load ${load.toFixed(2)} per cpu above ${l.maxLoadPerCpu}`
    return null
  }

  private readyQueue(): TaskRecord[] {
    const now = this.deps.now()
    const eff = (t: TaskRecord): number => Math.min(12, (t.spec.priority ?? 5) + Math.floor((now - t.updatedAt) / 60_000))
    return Object.values(this.live.tasks).filter(t => t.state === 'queued').sort((a, b) => eff(b) - eff(a) || a.createdAt - b.createdAt)
  }

  // ----- the loop ----------------------------------------------------------------
  async run(): Promise<Verdict> {
    this.acquire()
    const onSignal = (sig: string) => () => { this.requestStop(`signal ${sig}`) }
    const handlers = { SIGINT: onSignal('SIGINT'), SIGTERM: onSignal('SIGTERM') }
    process.on('SIGINT', handlers.SIGINT); process.on('SIGTERM', handlers.SIGTERM)
    try {
      await this.reconcile()
      for (;;) {
        this.readControl()
        if (!this.live.stopRequested) await this.schedule()
        const active = this.running.size
        const queued = Object.values(this.live.tasks).filter(t => t.state === 'queued')
        if (active === 0) {
          const startable = queued.filter(t => this.depsReady(t).ready)
          if (this.live.stopRequested || startable.length === 0) {
            for (const t of queued) { const d = this.depsReady(t); if (!d.ready) this.endTask(t, 'refused', d.dead ?? (this.live.stopRequested ? `not started: ${this.live.stopRequested}` : 'dependencies never completed')) }
            if (this.live.stopRequested || !(await this.finalize())) break
            continue
          }
          if (startable.length && this.capacityBlockedForever(startable)) {
            for (const t of startable) this.endTask(t, 'refused', t.reason ?? 'not admissible')
            continue
          }
        }
        await Promise.race([...this.running.values(), new Promise(r => setTimeout(r, 250))])
        this.persist()
      }
      if (this.live.stopRequested) await this.cancelAll(this.live.stopRequested)
      this.live.verdict = this.verdict()
      this.live.state = this.live.stopRequested ? 'stopped' : 'done'
      this.ledger.append('mission_verdict', null, this.live.verdict)
      this.persist(true)
      this.writeReport()
      return this.live.verdict
    } finally {
      process.off('SIGINT', handlers.SIGINT); process.off('SIGTERM', handlers.SIGTERM)
      this.release()
    }
  }

  /** Nothing runs and the queue cannot start: e.g. a route refusal that no running work can clear. */
  private capacityBlockedForever(ts: TaskRecord[]): boolean { return ts.every(t => t.reason?.startsWith('route refused') === true) }

  requestStop(why: string): void {
    if (this.live.stopRequested) return
    this.live.stopRequested = why
    this.ledger.append('stop_requested', null, { why })
    for (const c of this.controls.values()) c.cancel(why)
    this.persist(true)
  }
  private readControl(): void {
    const f = join(this.dir, 'control.json')
    if (!existsSync(f)) return
    try {
      const c = readJson<{ cancel?: 'all' | string[]; nonce?: string }>(f)
      unlinkSync(f)
      if (c.cancel === 'all') this.requestStop('cancel requested by the person')
      else if (Array.isArray(c.cancel)) for (const id of c.cancel) { const t = this.live.tasks[id]; if (!t) continue; this.ledger.append('cancel_requested', id, {}); if (t.state === 'queued') this.endTask(t, 'cancelled', 'cancelled by the person'); for (const a of t.attempts) if (a.phase !== 'ended') this.controls.get(a.id)?.cancel('cancelled by the person') }
    } catch { /* torn write: read next tick */ }
  }
  private async cancelAll(why: string): Promise<void> {
    for (const c of this.controls.values()) c.cancel(why)
    await Promise.allSettled([...this.running.values()])
  }

  private async schedule(): Promise<void> {
    for (const t of this.readyQueue()) {
      const d = this.depsReady(t)
      if (d.dead) { this.endTask(t, 'refused', d.dead); continue }
      if (!d.ready) continue
      const route = this.route(t)
      if (!route.ok) {
        t.reason = `route refused: ${route.refusal}`; t.updatedAt = this.deps.now()
        this.ledger.append('route_refused', t.spec.id, route)
        if (!route.refusal?.startsWith('budget') && !route.refusal?.startsWith('session cost')) { this.endTask(t, 'refused', t.reason); continue }
        continue
      }
      const why = this.capacityRefusal(route.role as Role, route.provider as string)
      if (why) { t.reason = `waiting: ${why}`; continue }
      const admitted = await this.admit(t, route)
      if (!admitted) continue
    }
  }

  route(t: TaskRecord): RouteDecision {
    const last = t.attempts.at(-1)
    return routeTask({
      task: t.spec, config: this.config, resolutions: this.resolutions, health: this.live.health,
      history: { attempts: t.attempts.length, gateFailures: t.attempts.filter(a => a.failure === 'gate_failed' || a.failure === 'misreported_completion').length, escalated: t.escalations > 0, lastFailure: (last?.failure ?? null) as FailureClass | null },
      spentSessionUsd: this.live.session.unmetered ? null : this.live.session.spentUsd,
      ...(t.escalateTo ? { escalateTo: t.escalateTo } : {}),
    })
  }

  /** Engine ownership, then the repository-wide claim, then dispatch. */
  private async admit(t: TaskRecord, route: RouteDecision): Promise<boolean> {
    const role = route.role as Role
    const n = t.attempts.length + 1
    const attemptId = `${this.header.id}.${t.spec.id}.${n}`
    const engineId = `${t.spec.id}@${n}`
    const now = this.deps.now()
    let swarm = this.live.swarm
    if (!swarm.tasks.some(x => x.id === engineId)) swarm = submitTask(swarm, { id: engineId, tier: POOL_OF[role], role, objective: `${t.spec.title} [${attemptId}]`, owned: t.spec.owned, mode: t.spec.mode, spawnReason: route.rules.join('; ') }, now).swarm
    const adm = admitTask(swarm, engineId, now)
    this.live.swarm = adm.swarm
    if (!adm.ok) { t.reason = `waiting: ${adm.reason}`; return false }
    if (t.spec.mode === 'write') {
      const conflict = await withLock(claimsLock(this.header.commonDir), `admit ${attemptId}`, () => {
        const { claims, unreadable } = listClaims(this.header.commonDir)
        if (unreadable.length) return `repository claims unreadable (${unreadable.join(', ')}): writes held`
        const other = claims.find(c => !(c.missionId === this.header.id && c.taskId === t.spec.id) && (c.mode === 'write') && c.owned.some(a => t.spec.owned.some(b => overlaps(a, b))))
        if (other) return `repository claim held by ${other.missionId}/${other.taskId} (${other.state})`
        writeClaim(this.header.commonDir, { missionId: this.header.id, taskId: t.spec.id, attempt: n, owned: t.spec.owned, mode: t.spec.mode, state: 'reserved', identity: null, supervisor: processIdentity(process.pid), stateDir: this.dir, at: new Date().toISOString() })
        return null
      })
      if (conflict) { this.live.swarm = releaseReservation(this.live.swarm, engineId, now, conflict); t.reason = `waiting: ${conflict}`; return false }
    }
    const price = pricingFor(this.config, route.model as string, (this.resolutions[role] as { info?: never }).info)
    const a: AttemptRecord = {
      n, id: attemptId, role, provider: route.provider as string, model: route.model as string, requestedReasoning: route.requestedReasoning, cliThinking: route.cliThinking, expectedWire: route.expectedWireEffort, mapping: route.reasoningMapping,
      route, engineId, phase: 'reserved', startedAt: new Date(now).toISOString(), endedAt: null, identity: null, worktree: null, base: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: null }, usageEvents: 0, toolCalls: {}, iterations: 0,
      finishReason: null, reportedModel: null, reportedProvider: null, wire: null, census: null, stoppedBy: null, exitCode: null,
      charge: { usd: null, basis: 'unmetered' }, estimateUsd: route.estimateUsd, failure: null, failureDetail: null, gates: [], changes: [], commit: null, resultExcerpt: null, hookRefusals: [], alerts: [],
    }
    void price
    t.attempts.push(a); t.state = 'running'; t.reason = null; t.updatedAt = now
    this.live.counters.attempts++
    this.live.spawnTimes.push(now)
    this.live.swarm = uncertainSpawn(this.live.swarm, engineId, attemptId, now)
    this.ledger.append('attempt_admitted', t.spec.id, { attempt: attemptId, route })
    this.persist(true)
    const p = this.execute(t, a).catch(e => { this.deps.log(`attempt ${attemptId}: ${(e as Error).stack ?? e}`); this.hold(t, a, `supervisor error: ${(e as Error).message}`) }).finally(() => { this.running.delete(attemptId) })
    this.running.set(attemptId, p)
    return true
  }

  private hold(t: TaskRecord, a: AttemptRecord, why: string): void {
    a.phase = a.phase === 'ended' ? 'ended' : 'held'; t.state = a.phase === 'ended' ? t.state : 'held'; t.reason = why
    this.live.alerts.push(`${t.spec.id}: HELD ${why}`)
    this.ledger.append('attempt_held', t.spec.id, { attempt: a.id, why })
    this.persist(true)
  }

  private async execute(t: TaskRecord, a: AttemptRecord): Promise<void> {
    const runDir = join(this.dir, 'runs', t.spec.id, String(a.n))
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    a.base = this.live.integration.head
    let workdir = this.live.integration.dir; let admin: string | null = null
    if (t.spec.mode === 'write') {
      workdir = join(this.dir.replace(/\/missions\/[^/]+$/, ''), 'worktrees', this.header.id, `${t.spec.id}-${a.n}`)
      admin = (await addTaskWorktree({ root: this.header.repoRoot } as RepoInfo, workdir, a.base)).adminDir
    }
    a.worktree = workdir; a.phase = 'dispatching'; this.persist(true)
    const readOnly = t.spec.mode === 'read'
    const allowedTools = readOnly ? this.config.tools.readOnlyAllowed : this.config.tools.allowed
    const spec: WorkerSpec = {
      attemptId: a.id, runDir, workdir, writable: !readOnly, gitCommonDir: this.header.commonDir, gitAdminDir: admin,
      provider: a.provider, model: a.model, cliThinking: a.cliThinking ?? 'none', expectedWire: a.expectedWire ?? 'none',
      prompt: workerPrompt(t.spec, { evidence: t.evidence, readOnly, allowedTools }),
      policy: { workdir, owned: t.spec.owned, mode: t.spec.mode, allowedTools },
      timeoutSeconds: this.config.limits.workerTimeoutSeconds, clineRetries: this.config.limits.clineRetries,
      hide: this.config.sandbox.hide, network: this.config.sandbox.allowNetwork, clineBin: this.deps.clineBin, clineDataDir: this.deps.clineDataDir,
      budgetUsd: this.config.budgets.taskUsd[a.role], budgetTokens: this.config.budgets.taskTokens[a.role],
    }
    const out = await this.deps.runWorker(spec, {
      identity: id => {
        a.identity = id; a.phase = 'running'
        try { this.live.swarm = bindAgent(this.live.swarm, a.engineId, `${a.id}:${id.initPid ?? 'noinit'}:${id.initStart ?? ''}`, this.deps.now()) } catch (e) { this.ledger.append('bind_failed', t.spec.id, { attempt: a.id, error: (e as Error).message }) }
        if (t.spec.mode === 'write') writeClaim(this.header.commonDir, { missionId: this.header.id, taskId: t.spec.id, attempt: a.n, owned: t.spec.owned, mode: t.spec.mode, state: 'bound', identity: id, supervisor: processIdentity(process.pid), stateDir: this.dir, at: new Date().toISOString() })
        this.ledger.append('attempt_bound', t.spec.id, { attempt: a.id, initPid: id.initPid, pidNs: id.pidNs })
        this.persist(true)
      },
      facts: f => { this.absorb(a, f); this.chargeSession(); this.persist() },
      control: c => this.controls.set(a.id, c),
    })
    this.controls.delete(a.id)
    this.absorb(a, out.facts)
    a.wire = out.wire; a.census = out.census; a.stoppedBy = out.stoppedBy; a.exitCode = out.exitCode; a.hookRefusals = out.hookRefusals
    if (out.identity) a.identity = out.identity
    a.resultExcerpt = out.facts.resultText ? out.facts.resultText.slice(0, 4000) : null
    this.chargeSession()
    this.ledger.append('worker_exited', t.spec.id, { attempt: a.id, stoppedBy: out.stoppedBy, exit: out.exitCode, finish: out.facts.finishReason, aborted: out.facts.aborted, census: out.census, wire: out.wire, usage: a.usage, charge: a.charge, hookRefusals: out.hookRefusals, reportedModel: out.facts.reportedModel })
    if (out.census.state !== 'gone') { this.hold(t, a, `worker processes not accounted for (${out.census.detail}); ownership retained`); return }
    a.phase = 'ended'; a.endedAt = new Date(this.deps.now()).toISOString()
    const cls = this.classify(t, a, out)
    this.noteHealth(a, cls)
    if (cls) { await this.failed(t, a, cls.cls, cls.detail, cls.evidence); return }
    await this.verifyAndIntegrate(t, a)
  }

  private absorb(a: AttemptRecord, f: StreamFacts): void {
    a.usage = { ...f.usage }; a.usageEvents = f.usageEvents; a.toolCalls = { ...f.toolCalls }; a.iterations = f.iterations
    a.finishReason = f.finishReason; a.reportedModel = f.reportedModel; a.reportedProvider = f.reportedProvider
    a.charge = chargeOf(f.usage, pricingFor(this.config, a.model, (this.resolutions[a.role] as { info?: never }).info))
    const b = checkBudget(a.charge.usd, f.usage.inputTokens + f.usage.outputTokens, this.config.budgets.taskUsd[a.role], this.config.budgets.taskTokens[a.role], this.config.budgets.alertAt, a.alerts)
    for (const x of b.crossed) { a.alerts.push(x); this.live.alerts.push(`${a.id}: task budget ${Math.round(x * 100)}% (${b.detail})`); this.ledger.append('budget_alert', a.id.split('.').slice(1, -1).join('.'), { scope: 'task', at: x, detail: b.detail }) }
  }

  /** Session spend from every attempt's own charge; unmetered stays unmetered. */
  private chargeSession(): void {
    let usd = 0; let tokens = 0
    const all = Object.values(this.live.tasks).flatMap(t => t.attempts)
    for (const a of all) { usd += a.charge.usd ?? 0; tokens += a.usage.inputTokens + a.usage.outputTokens }
    usd += this.live.session.archivedUsd; tokens += this.live.session.archivedTokens
    this.live.session.spentUsd = usd; this.live.session.tokens = tokens
    const b = checkBudget(usd, tokens, this.config.budgets.sessionUsd, this.config.budgets.sessionTokens, this.config.budgets.alertAt, this.live.session.alertsFired)
    for (const x of b.crossed) { this.live.session.alertsFired.push(x); this.live.alerts.push(`session budget ${Math.round(x * 100)}% (${b.detail})`); this.ledger.append('budget_alert', null, { scope: 'session', at: x, detail: b.detail }) }
    if (b.state === 'exceeded' && !this.live.session.capReached) {
      this.live.session.capReached = true
      this.ledger.append('session_cap', null, { detail: b.detail, action: this.config.budgets.onSessionCap })
      if (this.config.budgets.onSessionCap === 'cancel') for (const c of this.controls.values()) c.cancel('session budget reached')
    }
  }

  private classify(t: TaskRecord, a: AttemptRecord, out: WorkerOutcome): { cls: FailureClass | 'cancelled'; detail: string; evidence: string[] } | null {
    const f = out.facts
    if (out.stoppedBy === 'cancel') return { cls: 'cancelled', detail: out.stopDetail ?? 'cancelled', evidence: [] }
    if (out.stoppedBy === 'budget') return { cls: 'budget_exceeded', detail: out.stopDetail ?? 'budget', evidence: [] }
    if (out.stoppedBy === 'timeout') return { cls: 'timeout', detail: out.stopDetail ?? 'timeout', evidence: [] }
    if (out.stoppedBy === 'spawn_error') return { cls: 'sandbox_error', detail: out.stopDetail ?? 'sandbox failed to start', evidence: [] }
    if (out.hookRefusals.length) return { cls: 'policy_abort', detail: `Cockpit policy refused ${out.hookRefusals.map(r => `${r.tool}: ${r.reason}`).join('; ').slice(0, 600)}`, evidence: [] }
    if (f.reportedModel !== null && f.reportedModel !== a.model) return { cls: 'model_mismatch', detail: `Cline reported model ${f.reportedModel}, routed ${a.model}`, evidence: [] }
    if (f.reportedProvider !== null && f.reportedProvider !== a.provider) return { cls: 'model_mismatch', detail: `Cline reported provider ${f.reportedProvider}, routed ${a.provider}`, evidence: [] }
    if (out.wire.state === 'mismatch') return { cls: 'wire_mismatch', detail: out.wire.detail, evidence: [] }
    if (out.wire.state === 'unconfirmed' && this.header.strict && (f.finishReason === 'completed')) return { cls: 'wire_mismatch', detail: `strict: ${out.wire.detail}`, evidence: [] }
    if (f.finishReason === 'error') return { cls: 'provider_error', detail: (f.resultText ?? 'provider error').slice(0, 300), evidence: [] }
    if (f.finishReason !== 'completed') return { cls: 'unknown_outcome', detail: `finish ${f.finishReason ?? 'none'}${f.aborted ? ` (${f.aborted})` : ''}, exit ${out.exitCode}`, evidence: [] }
    if (f.usageEvents === 0 || (a.charge.basis === 'unmetered')) {
      this.live.session.unmetered = true; this.live.session.unmeteredTasks.push(a.id)
      this.ledger.append('unmetered', t.spec.id, { attempt: a.id, detail: 'run reported no usage; session admissions stop' })
    }
    void t
    return null
  }

  private noteHealth(a: AttemptRecord, cls: { cls: string } | null): void {
    const key = `${a.provider}/${a.model}`
    const h = this.live.health[key] ?? { consecutiveErrors: 0, unhealthy: false }
    const l = this.config.limits
    if (cls?.cls === 'provider_error') {
      h.consecutiveErrors++; h.unhealthy = h.consecutiveErrors >= l.providerUnhealthyAfter
      this.live.aimd[a.provider] = Math.max(1, Math.floor((this.live.aimd[a.provider] ?? l.concurrency.total) / 2))
      this.ledger.append('provider_health', null, { key, ...h, concurrency: this.live.aimd[a.provider] })
    } else if (!cls || cls.cls !== 'cancelled') {
      h.consecutiveErrors = 0
      this.live.aimd[a.provider] = Math.min(l.perProvider[a.provider] ?? l.concurrency.total, (this.live.aimd[a.provider] ?? l.concurrency.total) + 1)
    }
    this.live.health[key] = h
  }

  private covers(t: TaskRecord): (rel: string) => boolean { return rel => ownedCovers(t.spec.owned, rel) }

  private async verifyAndIntegrate(t: TaskRecord, a: AttemptRecord): Promise<void> {
    t.state = 'verifying'; this.persist(true)
    const gates: GateResult[] = []
    const g = await gitGate(a.worktree as string, this.covers(t), t.spec.mode)
    gates.push(g.result); a.changes = g.changes.map(c => c.path)
    if (t.spec.mode === 'write') {
      gates.push(await securityGate(a.worktree as string))
      if (g.changes.length) for (const spec of this.header.gates) gates.push(await runCommandGate(spec, a.worktree as string, join(this.dir, 'runs', t.spec.id, String(a.n), 'gates'), { hide: this.config.sandbox.hide, shareDirs: this.deps.shareDirs.map(s => ({ from: s.from, to: join(a.worktree as string, s.to) })), timeoutSeconds: this.config.limits.gateTimeoutSeconds, gitCommonDir: this.header.commonDir }, a.id))
    }
    a.gates = gates
    this.ledger.append('gates', t.spec.id, { attempt: a.id, gates: gates.map(x => ({ name: x.name, state: x.state, exit: x.exitCode ?? null, sha: x.outputSha256 ?? null, evidence: x.evidence.slice(0, 600) })) })
    const bad = gates.filter(x => x.state !== 'pass')
    const structural = bad.find(x => x.kind === 'git' || x.kind === 'security')
    if (structural) { await this.failed(t, a, 'policy_abort', `${structural.name} gate: ${structural.evidence}`, []); return }
    const claimed = SUCCESS_CLAIM.test(a.resultExcerpt ?? '')
    if (t.spec.mode === 'write' && g.changes.length === 0 && !['review', 'scout'].includes(t.spec.kind)) { await this.failed(t, a, claimed ? 'misreported_completion' : 'no_changes', `write task finished with no changes${claimed ? ' while claiming success' : ''}`, [`previous attempt made no changes${claimed ? ' but reported success' : ''}`]); return }
    if (bad.length) { await this.failed(t, a, claimed ? 'misreported_completion' : 'gate_failed', `${bad.map(x => `${x.name} ${x.state}`).join(', ')}${claimed ? ' (worker claimed success)' : ''}`, bad.map(x => `${x.name} (${x.command ?? x.kind}) ${x.state}: ${x.evidence.slice(-800)}`)); return }
    if (this.header.requireGates && t.spec.mode === 'write' && this.header.gates.length === 0) this.live.alerts.push(`${t.spec.id}: no command gates configured; change is checked for scope and secrets only`)
    // Integration is serial: one pick at a time, onto the mission branch only.
    if (t.spec.mode === 'write' && g.changes.length) {
      const res = await (this.integrating = this.integrating.then(async () => {
        a.commit = await commitTask(a.worktree as string, `cockpit(${this.header.id}): ${t.spec.title} [${t.spec.id}]`)
        return integrate(this.live.integration.dir, a.commit)
      }))
      const r = res as Awaited<ReturnType<typeof integrate>>
      if (!r.ok) { await this.failed(t, a, 'integration_conflict', r.conflict, [`integration conflict: ${r.conflict.slice(0, 300)}`]); return }
      this.live.integration.head = r.head; t.integratedHead = r.head
      this.ledger.append('integrated', t.spec.id, { attempt: a.id, commit: a.commit, head: r.head })
    }
    t.verification = 'PROVISIONAL_CHECKED'
    this.harvestRequests(t, a)
    if (t.spec.id === 'plan') this.harvestPlan(t, a)
    if (t.spec.id === 'final-review') this.live.review = { text: a.resultExcerpt, attempt: a.id }
    this.endAttempt(t, a, 'completed')
    this.endTask(t, 'completed', null)
  }

  private harvestPlan(t: TaskRecord, a: AttemptRecord): void {
    const p = parsePlan(a.resultExcerpt ?? '', new Set(Object.keys(this.live.tasks)))
    if (!p.ok) { this.live.alerts.push(`plan rejected: ${p.reason}`); this.ledger.append('plan_rejected', t.spec.id, { reason: p.reason }); t.verification = 'SELF_REPORTED_UNCHECKED'; this.planRejected = p.reason; return }
    for (const s of p.tasks) { const r = this.addTask({ ...s, dependencies: s.dependencies }, 'commander-plan'); if (r.ok) t.children.push(s.id) }
    this.ledger.append('plan_accepted', t.spec.id, { tasks: p.tasks.map(x => x.id) })
  }
  planRejected: string | null = null

  private harvestRequests(t: TaskRecord, a: AttemptRecord): void {
    if (!a.resultExcerpt || t.spec.id === 'plan') return
    const r = parseRequest(a.resultExcerpt, t.spec, this.config.limits.maxChildrenPerTask, new Set(Object.keys(this.live.tasks)))
    if (r === null) return
    if (!r.ok) { t.requestsRefused.push(r.reason); this.ledger.append('delegation_refused', t.spec.id, { reason: r.reason }); return }
    for (const s of r.tasks) { const x = this.addTask(s, `request from ${t.spec.id}`); if (x.ok) t.children.push(s.id); else t.requestsRefused.push(`${s.id}: ${x.reason}`) }
    this.ledger.append('delegation', t.spec.id, { admitted: t.children, refused: t.requestsRefused })
  }

  /** Ends the engine task and retires the repo claim. Only called after a clean census. */
  private endAttempt(t: TaskRecord, a: AttemptRecord, state: 'completed' | 'failed' | 'cancelled'): void {
    if (a.census?.state !== 'gone' && a.phase !== 'ended') throw new Error('refusing to release ownership without a clean census')
    try { this.live.swarm = finishTask(this.live.swarm, a.engineId, state, { conclusion: (a.resultExcerpt ?? a.failureDetail ?? '').slice(0, 1000) }, this.deps.now()) } catch (e) { this.ledger.append('engine_finish_error', t.spec.id, { attempt: a.id, error: (e as Error).message }) }
    if (t.spec.mode === 'write') retireClaim(this.header.commonDir, this.header.id, t.spec.id)
    this.ledger.append('ownership_released', t.spec.id, { attempt: a.id, state, census: a.census?.detail ?? null })
  }

  private endTask(t: TaskRecord, state: TaskState, reason: string | null): void {
    t.state = state; t.reason = reason; t.updatedAt = this.deps.now()
    if (state === 'completed') this.live.counters.completed++
    else if (state === 'failed') this.live.counters.failed++
    else if (state === 'cancelled') this.live.counters.cancelled++
    else if (state === 'refused') this.live.counters.refused++
    const usd = t.attempts.reduce((s, a) => s + (a.charge.usd ?? 0), 0); const tok = t.attempts.reduce((s, a) => s + a.usage.inputTokens + a.usage.outputTokens, 0)
    this.ledger.append('task_ended', t.spec.id, { state, reason, attempts: t.attempts.length, usd, tokens: tok, verification: t.verification })
    this.persist(true)
  }

  private async failed(t: TaskRecord, a: AttemptRecord, cls: FailureClass | 'cancelled' | 'integration_conflict', detail: string, evidence: string[]): Promise<void> {
    a.failure = cls; a.failureDetail = detail
    this.ledger.append('attempt_failed', t.spec.id, { attempt: a.id, class: cls, detail: detail.slice(0, 800) })
    this.endAttempt(t, a, cls === 'cancelled' ? 'cancelled' : 'failed')
    if (cls === 'cancelled') { this.endTask(t, 'cancelled', detail); return }
    if (cls === 'budget_exceeded') this.live.alerts.push(`${t.spec.id}: budget exceeded on ${a.model}: ${detail}`)
    const step = cls === 'integration_conflict'
      ? (t.transientRetries < this.config.limits.maxTransientRetries + 1 && t.attempts.length < this.config.limits.maxAttemptsPerTask ? { action: 'retry_same' as const, reason: 'integration conflict: retry on the current mission head' } : { action: 'stop' as const, reason: 'integration conflict persists' })
      : nextStep(cls, a.role, { attempts: t.attempts.length, gateFailures: 0, escalated: t.escalations > 0, lastFailure: cls, transientRetries: t.transientRetries, escalations: t.escalations }, this.config, evidence)
    this.ledger.append('next_step', t.spec.id, { attempt: a.id, ...step })
    if (step.action === 'stop' || this.live.stopRequested || this.live.session.capReached) { this.endTask(t, 'failed', `${cls}: ${detail.slice(0, 300)} · ${step.reason}`); return }
    t.evidence = evidence.slice(0, 8)
    if (step.action === 'retry_same') t.transientRetries++
    if (step.action === 'escalate') { t.escalations++; t.escalateTo = step.to ?? null }
    t.state = 'queued'; t.reason = step.reason; t.updatedAt = this.deps.now()
    this.persist(true)
  }

  // ----- crash recovery ----------------------------------------------------------
  /** Reconciles attempts a previous supervisor left open, by identity, before anything new starts. */
  async reconcile(): Promise<void> {
    for (const t of Object.values(this.live.tasks)) {
      for (const a of t.attempts) {
        if (a.phase === 'ended') continue
        const target = targetOf(a.identity, `COCKPIT_CLINE_ATTEMPT=${a.id}`, Date.parse(a.startedAt))
        let c = census(target)
        if (c.state === 'alive') { this.ledger.append('reconcile_kill', t.spec.id, { attempt: a.id, pids: c.pids }); c = await terminate(target, true, 5000) }
        a.census = c
        this.ledger.append('reconciled', t.spec.id, { attempt: a.id, census: c })
        if (c.state !== 'gone') { this.hold(t, a, `after restart: ${c.detail}; ownership retained`); continue }
        a.phase = 'ended'; a.endedAt = new Date(this.deps.now()).toISOString()
        const stream = join(this.dir, 'runs', t.spec.id, String(a.n), 'rw', 'stream.jsonl')
        const sawResult = existsSync(stream) && readFileSync(stream, 'utf8').includes('"type":"run_result"')
        await this.failed(t, a, 'unknown_outcome', `supervisor ended while the attempt ran; ${sawResult ? 'a run result was written but was never verified' : 'no run result'}`, [])
      }
      if (t.state === 'verifying') { t.state = 'queued'; t.reason = 'verification interrupted: re-run' }
    }
    this.persist(true)
  }

  // ----- finalization ----------------------------------------------------------------
  /** Final gates on the mission branch and the commander's review. Returns true if new work was queued. */
  private async finalize(): Promise<boolean> {
    if (this.header.review && !this.live.review && !this.live.tasks['final-review'] && !this.archive.stateOf('final-review') && this.live.counters.completed > 0) {
      const diffBase = this.live.integration.base.slice(0, 12)
      const r = this.addTask({ id: 'final-review', title: 'Commander: critical review of the integrated change', kind: 'review', risk: 'high', complexity: 4, mode: 'read', owned: ['*'], dependencies: [], priority: 9, depth: 1, parent: null, prompt: `Review the mission's integrated change critically: run \`git diff ${diffBase}..HEAD\` and inspect the code. Goal of the mission:\n${this.header.goal}\nReport concrete defects with file and line. Do not edit files.` }, 'finalize')
      if (r.ok) return true
    }
    this.live.state = 'finalizing'
    if (this.live.integration.head !== this.live.integration.base) {
      for (const g of this.header.gates) this.live.finalGates.push(await runCommandGate(g, this.live.integration.dir, join(this.dir, 'final-gates'), { hide: this.config.sandbox.hide, shareDirs: this.deps.shareDirs.map(s => ({ from: s.from, to: join(this.live.integration.dir, s.to) })), timeoutSeconds: this.config.limits.gateTimeoutSeconds, gitCommonDir: this.header.commonDir }, `${this.header.id}-final`))
      this.ledger.append('final_gates', null, this.live.finalGates.map(x => ({ name: x.name, state: x.state, sha: x.outputSha256 })))
    }
    return false
  }

  verdict(): Verdict {
    const reasons: string[] = []
    const live = Object.values(this.live.tasks)
    const held = live.filter(t => t.state === 'held')
    const c = this.live.counters
    if (held.length) reasons.push(`${held.length} task(s) held with ownership retained: ${held.map(t => `${t.spec.id} (${t.reason})`).join('; ')}`)
    if (this.live.stopRequested) reasons.push(`stopped: ${this.live.stopRequested}`)
    if (c.failed) reasons.push(`${c.failed} task(s) failed`)
    if (c.refused) reasons.push(`${c.refused} task(s) refused or never started`)
    if (c.cancelled) reasons.push(`${c.cancelled} task(s) cancelled`)
    if (this.planRejected) reasons.push(`commander plan rejected: ${this.planRejected}`)
    if (this.live.session.unmetered) reasons.push(`usage unmetered for ${this.live.session.unmeteredTasks.join(', ')}: cost not measured`)
    if (this.live.session.capReached) reasons.push('session budget reached')
    const finalBad = this.live.finalGates.filter(g => g.state !== 'pass')
    if (finalBad.length) reasons.push(`final gates on ${this.live.integration.branch}: ${finalBad.map(g => `${g.name} ${g.state}`).join(', ')}`)
    const ledger = this.ledger.verify()
    if (!ledger.ok) reasons.push(`ledger integrity: ${ledger.problem}`)
    const noGates = this.header.gates.length === 0 && this.live.integration.head !== this.live.integration.base
    if (noGates && this.header.requireGates) reasons.push('no test/type/build gate was configured: the change is scope- and secret-checked only')
    const at = new Date().toISOString()
    if (held.length || !ledger.ok) return { state: 'BLOCKED', reasons, at }
    if (this.live.stopRequested) return { state: 'STOPPED', reasons, at }
    if (c.completed === 0) return { state: 'FAILED', reasons: reasons.length ? reasons : ['nothing completed'], at }
    if (reasons.length) return { state: noGates && reasons.length === 1 ? 'UNVERIFIED' : 'PARTIAL', reasons, at }
    return { state: 'DONE', reasons: [`${c.completed} task(s) verified by supervisor gates and integrated on ${this.live.integration.branch}; final gates pass; costs metered; ledger intact`], at }
  }

  writeReport(): void {
    const rows: unknown[] = []
    for (const id of [...Object.keys(this.live.tasks)]) rows.push(this.live.tasks[id])
    const idx = this.archive.index()
    for (const p of idx.pages) for (const r of this.archive.page(p.n)) rows.push(r)
    const tasks = rows as (TaskRecord & { id?: string })[]
    const report = {
      mission: this.header.id, goal: this.header.goal, repo: this.header.repoRoot, base: this.header.base, branch: this.live.integration.branch, head: this.live.integration.head,
      profile: this.header.profile, strict: this.header.strict, clineVersion: this.header.clineVersion, mode: this.header.mode, modeReason: this.header.modeReason,
      verdict: this.live.verdict, session: this.live.session,
      tasks: tasks.map(t => ({ id: t.spec.id, title: t.spec.title, state: t.state, verification: t.verification, reason: t.reason, attempts: t.attempts.map(a => ({ id: a.id, role: a.role, provider: a.provider, model: a.model, reasoning: { requested: a.requestedReasoning, cli: a.cliThinking, expectedWire: a.expectedWire, effective: a.wire?.effective ?? null, wire: a.wire?.state ?? null }, rules: a.route.rules, usage: a.usage, charge: a.charge, failure: a.failure, failureDetail: a.failureDetail, gates: a.gates.map(g => ({ name: g.name, state: g.state, exit: g.exitCode ?? null, sha256: g.outputSha256 ?? null })), commit: a.commit, census: a.census?.state ?? null })) })),
      finalGates: this.live.finalGates.map(g => ({ name: g.name, state: g.state, exit: g.exitCode ?? null, sha256: g.outputSha256 ?? null })),
      review: this.live.review ? { attempt: this.live.review.attempt, text: this.live.review.text, label: 'SELF_REPORTED_UNCHECKED: the commander review is advice, not verification' } : null,
      ledger: this.ledger.verify(),
    }
    writeAtomic(join(this.dir, 'report.json'), JSON.stringify(report, null, 1))
  }
}

export { storeBytes, retireMarker, sameProcess }
