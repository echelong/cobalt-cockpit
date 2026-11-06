// The mission supervisor: admission, scheduling, workers, verification, integration,
// escalation and the mission verdict. Host-side policy is authoritative; models
// propose, the supervisor decides. Everything durable goes through store.ts.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { cpus, freemem, loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import {
  emptySwarm, submitTask, admitTask, bindAgent, uncertainSpawn, finishTask, releaseReservation, overlaps, POOL_OF, ROLES,
} from './core/engine.ts'
import type { Role, Swarm } from './core/engine.ts'
import type { Config } from './config.ts'
import type { Resolution } from './catalog.ts'
import { routeTask, nextStep, healthKey, classifyFailureText, IMPLEMENTATION, backoffMs } from './router.ts'
import type { FailureClass, Health, RouteDecision, TaskSpec } from './router.ts'
import { chargeOf, checkBudget, pricingFor } from './cost.ts'
import type { Usage } from './cost.ts'
import { emptyFacts, foldLine, runWorker, targetOf } from './worker.ts'
import type { StreamFacts, WorkerOutcome, WorkerSpec, Control } from './worker.ts'
import type { Identity } from './sandbox.ts'
import { census, processIdentity, sameProcess, terminate } from './proc.ts'
import type { Census, ProcessIdentity, Target } from './proc.ts'
import type { WireVerdict } from './reasoning.ts'
import { gateTaint, gitGate, packageScripts, runCommandGate, securityGate } from './gates.ts'
import type { GateResult, GateSpec } from './gates.ts'
import { git } from './git.ts'
import { addTaskWorktree, changesOf, commitTask, createIntegration, diffText, headOf, integrate, integratedCommitFor, missionBranch, repoInfo } from './git.ts'
import type { RepoInfo } from './git.ts'
import { isPlanTask, needsCommander, parsePlan, parseRequest, planPrefix, plannerPrompt, repoSummaryText, workerPrompt } from './planner.ts'
import { ownedCovers } from './hook/policy.ts'
import {
  Archive, Ledger, breakStaleLock, claimsLock, epochToken, listClaims, lostMissions, newId, readJson, retireClaim, retireMarker,
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
  /** The git admin dir of this attempt's worktree: host git is pinned to it. */ adminDir?: string | null
  /** Gate definition files (e.g. package.json, a test entry point) this attempt changed. */ gateTaint?: string[]
  /** Processes of this attempt still to be accounted for after the worker itself ended (a gate's sandbox): recovery censuses these. */ heldTarget?: Target | null
}
export type TaskState = 'queued' | 'running' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'held' | 'refused'
export type TaskRecord = {
  spec: TaskSpec; state: TaskState; attempts: AttemptRecord[]; transientRetries: number; escalations: number
  escalateTo: Role | null; evidence: string[]; createdAt: number; updatedAt: number; reason: string | null
  verification: 'PROVISIONAL_CHECKED' | 'SELF_REPORTED_UNCHECKED' | null; integratedHead: string | null; children: string[]; requestsRefused: string[]
  /** Correction attempts made on the same model after an implementation failure. */ corrections?: number
  /** A transient failure's backoff: the task is not admitted before this time (epoch ms). */ retryAt?: number | null
}
export type Verdict = { state: 'DONE' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'STOPPED' | 'UNVERIFIED'; reasons: string[]; at: string }
export type Live = {
  version: 1; missionId: string; epoch: string; state: 'planning' | 'running' | 'finalizing' | 'done' | 'stopped'
  supervisor: ProcessIdentity | null; tasks: Record<string, TaskRecord>; swarm: Swarm
  session: { spentUsd: number; tokens: number; archivedUsd: number; archivedTokens: number; unmetered: boolean; alertsFired: number[]; capReached: boolean; unmeteredTasks: string[]; /** attempts whose cost is an estimate from configured pricing, not a reported figure */ estimatedTasks?: string[]; /** attempts a restart interrupted: their cost is what the stream recorded, a lower bound */ lowerBoundTasks?: string[] }
  health: Health; aimd: Record<string, number>; spawnTimes: number[]
  counters: { created: number; completed: number; failed: number; cancelled: number; refused: number; archived: number; attempts: number }
  /** usd: null when none of the task's cost was measured; partial: some attempts' cost is unknown, so usd is a lower bound. */
  recent: { id: string; title: string; state: TaskState; role: Role | null; model: string | null; usd: number | null; partial?: boolean; at: string }[]
  integration: { dir: string; branch: string; base: string; head: string }
  finalGates: GateResult[]; review: { text: string | null; attempt: string | null } | null
  verdict: Verdict | null; alerts: string[]; stopRequested: string | null; updatedAt: string
  /** Durable verdict reasons found along the way: rejected or partly dropped plans, refused requests, gate taint, head drift. */
  problems?: string[]
  /** The head the branch-level final gates ran on: shown only while the branch is still at it. */
  finalGatesHead?: string | null
  /** A closed conversation is never resumed by the interactive shell. */
  closed?: boolean
}
export type Header = {
  id: string; repoRoot: string; commonDir: string; base: string; createdAt: string; profile: string; strict: boolean
  goal: string; epoch: string; configDigest: string; gates: GateSpec[]; clineVersion: string; mode: 'single' | 'commander' | 'plan-file' | 'conversation'
  modeReason: string; review: boolean; requireGates: boolean
}
export type Deps = {
  clineBin: string; clineDataDir: string; now: () => number
  runWorker: typeof runWorker
  shareDirs: { from: string; to: string }[]
  log: (line: string) => void
  /** Every parsed JSONL event of a worker, for live display (the interactive shell streams text from it). */
  onEvent?: (taskId: string, attemptId: string, event: Record<string, unknown>) => void
}

const TERMINAL: TaskState[] = ['completed', 'failed', 'cancelled', 'refused']
const CPU_COUNT = Math.max(1, cpus().length) // os.cpus() is slow; the count does not change
const SUCCESS_CLAIM = /\b(?:all\s+tests?\s+pass|tests?\s+(?:pass|passed|passing)|done|completed?|finished|fixed|implemented|works)\b/i

export const missionDir = (root: string, id: string): string => join(root, 'missions', id)

/** Whether an attempt's cost is known: measured (reported or estimated from usage), or it never launched and spent nothing. */
export const costMeasured = (a: AttemptRecord): boolean => (a.charge.usd !== null && (a.usageEvents > 0 || a.charge.basis !== 'unmetered')) || (a.identity === null && a.usageEvents === 0 && (a.iterations ?? 0) === 0)

/** Stable digest of the effective configuration (keys sorted), fixed at mission creation. */
export const configDigest = (c: Config): string => {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map(k => [k, sorted((v as Record<string, unknown>)[k])])) : v
  return createHash('sha256').update(JSON.stringify(sorted(c))).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
export class Mission {
  readonly ledger: Ledger
  readonly archive: Archive
  private controls = new Map<string, Control>()
  /** Task ids the person cancelled; checked again right before any launch. */
  private pendingCancel = new Set<string>()
  private running = new Map<string, Promise<void>>()
  private integrating: Promise<unknown> = Promise.resolve()
  private lastPersist = 0
  private lockFile: string
  private storeChecked = { at: 0, bytes: 0 }

  constructor(readonly dir: string, readonly header: Header, public live: Live, readonly config: Config, readonly resolutions: Record<Role, Resolution>, readonly deps: Deps) {
    this.ledger = new Ledger(join(dir, 'ledger'))
    this.archive = new Archive(join(dir, 'archive'), config.limits.pageSize)
    this.lockFile = join(dir, 'supervisor.lock')
  }

  // ----- creation and loading --------------------------------------------------
  static async create(o: { stateRoot: string; repoDir: string; goal: string; config: Config; resolutions: Record<Role, Resolution>; deps: Deps; gates: GateSpec[]; clineVersion: string; tasks?: TaskSpec[]; single?: boolean; swarm?: boolean; review?: boolean; allowDirty?: boolean; requireGates?: boolean; conversation?: boolean }): Promise<Mission> {
    const repo = await repoInfo(o.repoDir)
    const lost = lostMissions(repo.commonDir)
    if (lost.length) throw new Error(`mission state is missing for ${lost.map(l => `${l.marker.missionId} (${l.why})`).join('; ')}. Run: cockpit-cline recover --lost <id>. No new mission starts while a mission's claims cannot be accounted for.`)
    if (repo.dirty && !o.allowDirty) throw new Error('the repository has uncommitted changes; workers start from HEAD and would not see them. Commit them, or pass --allow-dirty to proceed from HEAD anyway.')
    const id = newId('m')
    const dir = missionDir(o.stateRoot, id)
    mkdirSync(join(dir, 'runs'), { recursive: true, mode: 0o700 })
    const epoch = epochToken()
    const decision = o.conversation ? { commander: false, reason: 'interactive conversation: each turn is routed on its own' } : o.tasks ? { commander: false, reason: 'plan file supplied' } : needsCommander(o.goal, { swarm: o.swarm, single: o.single })
    const header: Header = {
      id, repoRoot: repo.root, commonDir: repo.commonDir, base: repo.head, createdAt: new Date().toISOString(), profile: o.config.profile, strict: o.config.strict,
      goal: o.goal, epoch, configDigest: configDigest(o.config), gates: o.gates, clineVersion: o.clineVersion,
      mode: o.conversation ? 'conversation' : o.tasks ? 'plan-file' : decision.commander ? 'commander' : 'single', modeReason: decision.reason, review: o.conversation ? false : (o.review ?? decision.commander), requireGates: o.requireGates ?? true,
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
      session: { spentUsd: 0, tokens: 0, archivedUsd: 0, archivedTokens: 0, unmetered: false, alertsFired: [], capReached: false, unmeteredTasks: [], estimatedTasks: [] }, health: {}, aimd: {}, spawnTimes: [],
      counters: { created: 0, completed: 0, failed: 0, cancelled: 0, refused: 0, archived: 0, attempts: 0 }, recent: [],
      integration: { dir: integrationDir, branch: missionBranch(id), base: repo.head, head: repo.head },
      finalGates: [], review: null, verdict: null, alerts: [], stopRequested: null, updatedAt: new Date().toISOString(),
    }
    const m = new Mission(dir, header, live, o.config, o.resolutions, o.deps)
    m.ledger.append('mission_created', null, { header: { ...header, goal: header.goal.slice(0, 2000) }, models: Object.fromEntries(ROLES.map(r => [r, o.resolutions[r].ok ? `${o.resolutions[r].provider}/${o.resolutions[r].model}` : `UNRESOLVED: ${(o.resolutions[r] as { reason: string }).reason}`])) })
    if (o.conversation) { /* turns arrive one by one through addTask */ }
    else if (o.tasks) for (const t of o.tasks) m.addTask(t, 'plan-file')
    else if (decision.commander) m.addTask({ id: 'plan', title: 'Commander: decompose the goal', kind: 'architecture', risk: 'medium', complexity: 4, mode: 'read', owned: ['*'], dependencies: [], prompt: plannerPrompt(o.goal, await m.repoSummary()), priority: 9, depth: 0, parent: null }, 'commander-planning')
    else m.addTask({ id: 'task', title: o.goal.split('\n')[0].slice(0, 120), kind: 'implement', risk: 'medium', complexity: 3, mode: 'write', owned: ['*'], dependencies: [], prompt: o.goal, priority: 5, depth: 0, parent: null }, 'single')
    m.live.state = 'running'
    m.persist(true)
    return m
  }

  /**
   * Reopens a mission. The configuration it was created with (models, reasoning, budgets,
   * strictness, limits) is fixed: a different config is refused unless the person accepts the
   * change explicitly, and the acceptance is written to the ledger.
   */
  static open(stateRoot: string, id: string, config: Config, resolutions: Record<Role, Resolution>, deps: Deps, opts: { acceptConfigChange?: boolean; clineVersion?: string } = {}): Mission {
    const dir = missionDir(stateRoot, id)
    if (!existsSync(join(dir, 'mission.json'))) throw new Error(`mission ${id} not found under ${stateRoot}`)
    const header = readJson<Header>(join(dir, 'mission.json'))
    const live = readJson<Live>(join(dir, 'live.json'))
    if (live.epoch !== header.epoch) throw new Error(`mission ${id}: live state epoch differs from header (store replaced); refusing`)
    const digest = configDigest(config)
    const versionChanged = opts.clineVersion !== undefined && opts.clineVersion !== header.clineVersion
    if ((digest !== header.configDigest || versionChanged) && !opts.acceptConfigChange) {
      throw new Error(`mission ${id} was created with config ${header.configDigest} on Cline ${header.clineVersion}; now config ${digest}${opts.clineVersion ? ` on Cline ${opts.clineVersion}` : ''}. Resume with the original profile, flags and config, or pass --accept-config-change to continue under the new one (recorded in the ledger).`)
    }
    const m = new Mission(dir, header, live, config, resolutions, deps)
    if (digest !== header.configDigest || versionChanged) {
      m.ledger.append('config_changed', null, { from: header.configDigest, to: digest, clineFrom: header.clineVersion, clineTo: opts.clineVersion ?? header.clineVersion, accepted: 'by --accept-config-change' })
      m.problem(`resumed under a different configuration (${header.configDigest} -> ${digest}) accepted by the person`)
    }
    return m
  }

  // ----- supervisor exclusivity ------------------------------------------------
  acquire(): void {
    const r = tryLock(this.lockFile, `supervise ${this.header.id}`)
    if (!r.ok) {
      if (!r.stale) throw new Error(`mission ${this.header.id} is supervised by pid ${r.holder?.holder.pid ?? '?'}; a second supervisor is refused`)
      if (!r.holder || !breakStaleLock(this.lockFile, r.holder)) throw new Error(`mission ${this.header.id}: the stale supervisor lock changed while taking it over; retry`)
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
      const measured = t.attempts.filter(costMeasured)
      this.live.recent = [{ id, title: t.spec.title, state: t.state, role: last?.role ?? null, model: last?.model ?? null, usd: t.attempts.length && !measured.length ? null : usd, ...(measured.length < t.attempts.length && measured.length ? { partial: true } : {}), at: new Date().toISOString() }, ...this.live.recent].slice(0, 50)
      delete this.live.tasks[id]
      this.live.counters.archived++
    }
    // Engine tasks that hold nothing: finished ones, and queued/blocked reservations whose
    // mission task is no longer waiting (refused, ended or archived). Anything that may hold
    // ownership (reserved, running, stalled, uncertain) always stays.
    const waiting = (engineId: string): boolean => this.live.tasks[engineId.slice(0, engineId.lastIndexOf('@'))]?.state === 'queued'
    this.live.swarm = { ...this.live.swarm, tasks: this.live.swarm.tasks.filter(t => !['completed', 'failed', 'cancelled'].includes(t.state) && !((t.state === 'queued' || t.state === 'blocked') && !waiting(t.id))) }
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
    this.ledger.append('task_added', spec.id, { source, spec: { ...spec, prompt: spec.prompt.slice(0, 2000), ...(spec.context ? { context: spec.context.slice(0, 2000) } : {}) } })
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
    if ((c.total ?? 0) >= l.concurrency.total) return `concurrency: ${c.total ?? 0} of ${l.concurrency.total} workers running`
    if ((c[role] ?? 0) >= l.concurrency[role]) return `concurrency: ${c[role] ?? 0} ${role} worker(s) of ${l.concurrency[role]}`
    const provCap = Math.min(l.perProvider[provider] ?? l.concurrency.total, this.live.aimd[provider] ?? l.concurrency.total)
    if ((c[`p:${provider}`] ?? 0) >= provCap) return `provider ${provider}: ${c[`p:${provider}`]} of ${provCap} concurrent (adaptive)`
    const now = this.deps.now()
    this.live.spawnTimes = this.live.spawnTimes.filter(t => now - t < 60_000)
    if (this.live.spawnTimes.length >= l.spawnsPerMinute) return `rate: ${this.live.spawnTimes.length} spawns in the last minute (limit ${l.spawnsPerMinute})`
    const freeMb = Math.floor(freemem() / 1048576)
    if (freeMb < l.minFreeMemoryMB && (c.total ?? 0) > 0) return `memory: ${freeMb} MB free, below ${l.minFreeMemoryMB} MB`
    if (now - this.storeChecked.at > 30_000) this.storeChecked = { at: now, bytes: storeBytes(this.dir) }
    if (this.storeChecked.bytes > l.maxStoreBytes) return `store capacity: mission state is ${this.storeChecked.bytes} bytes, above ${l.maxStoreBytes}; nothing is deleted automatically`
    const load = loadavg()[0] / CPU_COUNT
    if (load > l.maxLoadPerCpu && (c.total ?? 0) > 0) return `cpu: load ${load.toFixed(2)} per cpu above ${l.maxLoadPerCpu}`
    return null
  }

  private readyQueue(): TaskRecord[] {
    const now = this.deps.now()
    const eff = (t: TaskRecord): number => Math.min(12, (t.spec.priority ?? 5) + Math.floor((now - t.updatedAt) / 60_000))
    // a task backing off after a transient failure waits for its retry time
    return Object.values(this.live.tasks).filter(t => t.state === 'queued' && !((t.retryAt ?? 0) > now)).sort((a, b) => eff(b) - eff(a) || a.createdAt - b.createdAt)
  }

  // ----- the loop ----------------------------------------------------------------
  async run(): Promise<Verdict> {
    this.acquire()
    const onSignal = (sig: string) => () => { this.requestStop(`signal ${sig}`) }
    const handlers = { SIGINT: onSignal('SIGINT'), SIGTERM: onSignal('SIGTERM'), SIGHUP: onSignal('SIGHUP') }
    process.on('SIGINT', handlers.SIGINT); process.on('SIGTERM', handlers.SIGTERM); process.on('SIGHUP', handlers.SIGHUP)
    try {
      // A conversation's stop belongs to the run it was made in (a shell that quit mid-turn): the
      // next turn starts clean. Batch missions keep a stop until the person recovers them explicitly.
      if (this.header.mode === 'conversation' && this.live.stopRequested) {
        this.ledger.append('stop_cleared', null, { was: this.live.stopRequested })
        this.live.stopRequested = null
      }
      // a new run never shows the previous run's verdict while it works
      this.live.verdict = null; this.live.state = 'running'
      this.persist(true)
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
          if (startable.length && startable.every(t => this.cannotClear(t.reason))) {
            for (const t of startable) this.endTask(t, 'refused', `blocked: ${t.reason ?? 'not admissible'}`)
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
      // the repository marker guards claims; with none of this mission's left, it can go. A
      // conversation keeps it between turns and retires it when the conversation is closed.
      if (this.header.mode !== 'conversation') this.retireMarkerIfFree()
      this.persist(true)
      this.writeReport()
      return this.live.verdict
    } finally {
      process.off('SIGINT', handlers.SIGINT); process.off('SIGTERM', handlers.SIGTERM); process.off('SIGHUP', handlers.SIGHUP)
      this.release()
    }
  }

  private retireMarkerIfFree(): boolean {
    if (listClaims(this.header.commonDir).claims.some(c => c.missionId === this.header.id) || Object.values(this.live.tasks).some(t => t.state === 'held')) return false
    retireMarker(this.header.commonDir, this.header.id)
    return true
  }

  /**
   * Closes a conversation: refused while any of its tasks still holds ownership (recovery first).
   * The closed mission keeps its state and branch; only the repository marker is retired.
   */
  closeConversation(): { ok: true } | { ok: false; reason: string } {
    const held = Object.values(this.live.tasks).filter(t => t.state === 'held' || t.attempts.some(a => a.phase !== 'ended'))
    if (held.length) return { ok: false, reason: `${held.length} task(s) still hold ownership (${held.map(t => t.spec.id).join(', ')}); recover them first` }
    this.live.closed = true
    this.ledger.append('conversation_closed', null, {})
    this.retireMarkerIfFree()
    this.persist(true)
    return { ok: true }
  }

  /**
   * With nothing of this mission running, whether a waiting reason can still clear by itself.
   * Memory, cpu and rate limits, and another live mission's claim, clear with time. A route
   * refusal, a conflict with this mission's own held work, a reached cap, unmetered usage, a
   * stop, unreadable or orphaned claims and a zero concurrency limit never do: those tasks end
   * refused so the mission reaches a verdict (BLOCKED when ownership is held) instead of polling.
   */
  private cannotClear(reason: string | null): boolean {
    const r = reason ?? ''
    if (r.startsWith('route refused')) return true
    if (!r.startsWith('waiting: ')) return false
    if (/^waiting: (?:memory|cpu|rate):/.test(r)) return false
    if (/^waiting: repository claim held by /.test(r)) return /orphaned/.test(r)
    // an open provider breaker always has a cool-down end, after which one half-open try is made
    if (r.startsWith('waiting: provider health')) return false
    // Called only when nothing of this mission runs: a slot still taken then belongs to a held
    // attempt (or a zero limit), and neither clears by waiting.
    if (/^waiting: (?:concurrency|provider)\b/.test(r)) return true
    return /ownership conflict|resource budget|occupied|session budget reached|unmetered|stop requested|claims unreadable|store capacity/.test(r)
  }

  /**
   * Cancels one task (a conversation turn) without stopping the mission: a queued task ends
   * cancelled, a task being prepared is cancelled before launch, a running worker is stopped and
   * then accounted for by the usual census before its ownership is released.
   */
  cancelTask(id: string, why = 'cancelled by the person'): boolean {
    const t = this.live.tasks[id]
    if (!t || ['completed', 'failed', 'cancelled', 'refused'].includes(t.state)) return false
    this.pendingCancel.add(id)
    this.ledger.append('cancel_requested', id, { why })
    if (t.state === 'queued') this.endTask(t, 'cancelled', why)
    for (const a of t.attempts) if (a.phase !== 'ended') this.controls.get(a.id)?.cancel(why)
    return true
  }

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
      // remembered per task, so an attempt still being prepared (no control yet) is cancelled too
      else if (Array.isArray(c.cancel)) for (const id of c.cancel) { const t = this.live.tasks[id]; if (!t) continue; this.pendingCancel.add(id); this.ledger.append('cancel_requested', id, {}); if (t.state === 'queued') this.endTask(t, 'cancelled', 'cancelled by the person'); for (const a of t.attempts) if (a.phase !== 'ended') this.controls.get(a.id)?.cancel('cancelled by the person') }
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
        // an open provider breaker clears with time: the task waits on the same model, it is not refused
        if (route.refusal?.startsWith('provider health')) { if (!t.reason?.startsWith('waiting: provider health')) this.ledger.append('route_waiting', t.spec.id, { refusal: route.refusal }); t.reason = `waiting: ${route.refusal}`; continue }
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

  /** What the commander is told about the repository: tracked files at the mission head and package scripts (facts, bounded). */
  async repoSummary(): Promise<string> {
    const r = await git(['ls-files'], { cwd: this.live.integration.dir, allowFail: true })
    return repoSummaryText(this.header.repoRoot, this.live.integration.head, r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [], packageScripts(this.live.integration.dir))
  }

  /** Answers of completed tasks this one depends on (e.g. a scout's findings), bounded, for its prompt. */
  private dependencyResults(t: TaskRecord): { id: string; text: string }[] {
    const out: { id: string; text: string }[] = []
    for (const d of t.spec.dependencies.slice(0, 6)) {
      const rec = (this.live.tasks[d] ?? this.archive.get(d)) as TaskRecord | null
      const text = rec?.state === 'completed' ? rec.attempts.at(-1)?.resultExcerpt?.trim() : undefined
      if (text) out.push({ id: d, text: text.slice(0, 1500) })
    }
    return out
  }

  /**
   * Spend the session budget must already cover: what was charged, plus, for every worker
   * still in flight, the rest of its pre-spawn estimate. Several admissions in one pass then
   * cannot all see the same headroom.
   */
  committedUsd(): number {
    let reserved = 0
    for (const t of Object.values(this.live.tasks)) for (const a of t.attempts) if (a.phase !== 'ended') reserved += Math.max(0, (a.estimateUsd ?? 0) - (a.charge.usd ?? 0))
    return this.live.session.spentUsd + reserved
  }

  route(t: TaskRecord): RouteDecision {
    const last = t.attempts.at(-1)
    return routeTask({
      task: t.spec, config: this.config, resolutions: this.resolutions, health: this.live.health,
      history: { attempts: t.attempts.length, gateFailures: t.attempts.filter(a => a.failure === 'gate_failed' || a.failure === 'misreported_completion').length, escalated: t.escalations > 0, lastFailure: (last?.failure ?? null) as FailureClass | null },
      spentSessionUsd: this.live.session.unmetered ? null : this.committedUsd(),
      ...(t.escalateTo ? { escalateTo: t.escalateTo } : {}),
      // a correction (no escalation yet) stays on the role of the attempt it corrects
      ...(!t.escalateTo && (t.corrections ?? 0) > 0 && last ? { pinRole: last.role } : {}),
      now: this.deps.now(),
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
      // a claims lock that cannot be taken in time leaves the task waiting, with its reservation released
      const conflict = await withLock(claimsLock(this.header.commonDir), `admit ${attemptId}`, () => {
        const { claims, unreadable } = listClaims(this.header.commonDir)
        if (unreadable.length) return `repository claims unreadable (${unreadable.join(', ')}): writes held`
        const other = claims.find(c => !(c.missionId === this.header.id && c.taskId === t.spec.id) && (c.mode === 'write') && c.owned.some(a => t.spec.owned.some(b => overlaps(a, b))))
        // a claim whose supervisor is verifiably gone will not clear by waiting: it needs recover
        if (other) return `repository claim held by ${other.missionId}/${other.taskId} (${other.state})${sameProcess(other.supervisor) ? '' : `; orphaned: its supervisor is gone, run cockpit-cline recover ${other.missionId}`}`
        writeClaim(this.header.commonDir, { missionId: this.header.id, taskId: t.spec.id, attempt: n, owned: t.spec.owned, mode: t.spec.mode, state: 'reserved', identity: null, supervisor: processIdentity(process.pid), stateDir: this.dir, at: new Date().toISOString() })
        return null
      }).catch((e: Error) => `repository claims lock unavailable (${e.message.slice(0, 160)})`)
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

  /**
   * Keeps ownership (engine task and repo claim) and marks the task held, whatever stage it
   * reached: a held task is never finished, so the mission cannot end DONE around it. An
   * attempt whose processes ended keeps phase 'ended'; recovery releases it after re-checking.
   */
  private hold(t: TaskRecord, a: AttemptRecord, why: string): void {
    if (a.phase !== 'ended') a.phase = 'held'
    t.state = 'held'; t.reason = why
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
    a.worktree = workdir; a.adminDir = admin; a.gateTaint = []
    // A stop, a session cap or a cancel can arrive while the worktree was being created:
    // nothing has been launched yet, so the attempt ends here with nothing to account for.
    const why = this.live.stopRequested ?? (this.live.session.capReached ? 'session budget reached' : null) ?? (this.pendingCancel.has(t.spec.id) ? 'cancelled by the person' : null)
    if (why) {
      a.phase = 'ended'; a.endedAt = new Date(this.deps.now()).toISOString(); a.census = { state: 'gone', pids: [], detail: 'never launched' }
      this.ledger.append('attempt_not_launched', t.spec.id, { attempt: a.id, why })
      await this.failed(t, a, 'cancelled', `not launched: ${why}`, [])
      return
    }
    a.phase = 'dispatching'; this.persist(true)
    const readOnly = t.spec.mode === 'read'
    const allowedTools = readOnly ? this.config.tools.readOnlyAllowed : this.config.tools.allowed
    const spec: WorkerSpec = {
      attemptId: a.id, runDir, workdir, writable: !readOnly, gitCommonDir: this.header.commonDir, gitAdminDir: admin,
      provider: a.provider, model: a.model, cliThinking: a.cliThinking ?? 'none', expectedWire: a.expectedWire ?? 'none',
      prompt: workerPrompt(t.spec, { evidence: t.evidence, readOnly, allowedTools, dependencyResults: this.dependencyResults(t) }),
      policy: { workdir, owned: t.spec.owned, mode: t.spec.mode, allowedTools },
      timeoutSeconds: this.config.limits.workerTimeoutSeconds, clineRetries: this.config.limits.clineRetries,
      hide: this.config.sandbox.hide, network: this.config.sandbox.allowNetwork, clineBin: this.deps.clineBin, clineDataDir: this.deps.clineDataDir,
      budgetUsd: this.config.budgets.taskUsd[a.role], budgetTokens: this.config.budgets.taskTokens[a.role],
      pricing: (() => { const p = pricingFor(this.config, a.model, (this.resolutions[a.role] as { info?: never }).info); return p.source === 'none' ? null : p.pricing })(),
      allowUnmetered: this.config.budgets.allowUnmetered,
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
      event: e => this.deps.onEvent?.(t.spec.id, a.id, e),
      control: c => {
        this.controls.set(a.id, c)
        // a cancel, stop or cap that landed between admission and launch still applies
        const late = this.live.stopRequested ?? (this.live.session.capReached && this.config.budgets.onSessionCap === 'cancel' ? 'session budget reached' : null) ?? (this.pendingCancel.has(t.spec.id) ? 'cancelled by the person' : null)
        if (late) c.cancel(late)
      },
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
    // the full answer, not the display excerpt, is what plans and delegation requests are read from
    await this.verifyAndIntegrate(t, a, out.facts.resultText ?? '')
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
    if (out.observerError) { this.live.alerts.push(`${a.id}: state observer failed during the run (${out.observerError}); the stream was still read to the end`); this.ledger.append('observer_error', t.spec.id, { attempt: a.id, error: out.observerError }) }
    if (a.charge.basis === 'estimate') { const est = (this.live.session.estimatedTasks ??= []); if (!est.includes(a.id)) est.push(a.id) }
    // Unmetered when the model demonstrably used tokens that were not reported: an explicit unmetered
    // stop, a model turn that ended without a usage event, or a completed run without usable cost.
    // A provider error before any turn, or a cancel or timeout before the first turn ended, spent
    // nothing observable and must not stop the retry (or the rest of the mission).
    const spentUnmeasured = out.stoppedBy === 'unmetered' || (f.usageEvents === 0 && f.iterations > 0) || (f.finishReason === 'completed' && (f.usageEvents === 0 || a.charge.basis === 'unmetered'))
    if (spentUnmeasured && !this.live.session.unmeteredTasks.includes(a.id)) {
      this.live.session.unmetered = true; this.live.session.unmeteredTasks.push(a.id)
      this.ledger.append('unmetered', t.spec.id, { attempt: a.id, detail: 'run reported no usable cost; session admissions stop' })
    }
    if (out.stoppedBy === 'cancel') return { cls: 'cancelled', detail: out.stopDetail ?? 'cancelled', evidence: [] }
    if (out.stoppedBy === 'budget') return { cls: 'budget_exceeded', detail: out.stopDetail ?? 'budget', evidence: [] }
    if (out.stoppedBy === 'unmetered') return { cls: 'unmetered', detail: out.stopDetail ?? 'cost cannot be measured', evidence: [] }
    // A safety refusal, a different model or a downgraded request is final evidence about the run,
    // whatever ended it afterwards: a timeout or a sandbox fault never turns it into a retryable failure.
    if (out.hookRefusals.length) return { cls: 'policy_abort', detail: `Cockpit policy refused ${out.hookRefusals.map(r => `${r.tool}: ${r.reason}`).join('; ').slice(0, 600)}`, evidence: [] }
    if (f.reportedModel !== null && f.reportedModel !== a.model) return { cls: 'model_mismatch', detail: `Cline reported model ${f.reportedModel}, routed ${a.model}`, evidence: [] }
    if (f.reportedProvider !== null && f.reportedProvider !== a.provider) return { cls: 'model_mismatch', detail: `Cline reported provider ${f.reportedProvider}, routed ${a.provider}`, evidence: [] }
    if (out.wire.state === 'mismatch') return { cls: 'wire_mismatch', detail: out.wire.detail, evidence: [] }
    if (out.stoppedBy === 'timeout') return { cls: 'timeout', detail: out.stopDetail ?? 'timeout', evidence: [] }
    // the run's own error text decides between authentication, rate limits, resources and provider faults
    const errText = `${f.resultText ?? ''}\n${f.aborted ?? ''}\n${out.stderrHead ?? ''}\n${out.stopDetail ?? ''}`
    const textClass = classifyFailureText(errText)
    const errLine = (errText.split('\n').map(s => s.trim()).find(s => s && classifyFailureText(s)) ?? errText.trim().split('\n')[0] ?? '').slice(0, 300)
    if (out.stoppedBy === 'spawn_error') return textClass === 'resource_error' ? { cls: 'resource_error', detail: `sandbox could not start: ${errLine}`, evidence: [] } : { cls: 'sandbox_error', detail: out.stopDetail ?? 'sandbox failed to start', evidence: [] }
    if (out.wire.state === 'unconfirmed' && this.header.strict && (f.finishReason === 'completed')) return { cls: 'wire_mismatch', detail: `strict: ${out.wire.detail}`, evidence: [] }
    if (f.finishReason === 'error') return { cls: textClass ?? 'provider_error', detail: errLine || 'provider error', evidence: [] }
    if (f.finishReason !== 'completed') return { cls: textClass ?? 'unknown_outcome', detail: `${textClass ? `${errLine} · ` : ''}finish ${f.finishReason ?? 'none'}${f.aborted ? ` (${f.aborted})` : ''}, exit ${out.exitCode}`, evidence: [] }
    return null
  }

  private noteHealth(a: AttemptRecord, cls: { cls: string } | null): void {
    const key = `${a.provider}/${a.model}`
    const h = this.live.health[key] ?? { consecutiveErrors: 0, unhealthy: false }
    const l = this.config.limits
    if (cls?.cls === 'provider_error' || cls?.cls === 'rate_limited') {
      h.consecutiveErrors++; h.unhealthy = h.consecutiveErrors >= l.providerUnhealthyAfter
      // open breaker: work on this model waits a backed-off cool-down, then one half-open try
      if (h.unhealthy) h.until = this.deps.now() + backoffMs(h.consecutiveErrors - l.providerUnhealthyAfter + 1, l.retryBaseMs, l.retryMaxMs)
      this.live.aimd[a.provider] = Math.max(1, Math.floor((this.live.aimd[a.provider] ?? l.concurrency.total) / 2))
      this.ledger.append('provider_health', null, { key, ...h, concurrency: this.live.aimd[a.provider] })
    } else if (!cls) {
      // only a run that finished cleanly closes the breaker; a timeout, cancel or policy stop says nothing about the provider
      h.consecutiveErrors = 0; h.unhealthy = false; delete h.until
      this.live.aimd[a.provider] = Math.min(l.perProvider[a.provider] ?? l.concurrency.total, (this.live.aimd[a.provider] ?? l.concurrency.total) + 1)
    }
    this.live.health[key] = h
  }

  private covers(t: TaskRecord): (rel: string) => boolean { return rel => ownedCovers(t.spec.owned, rel) }

  /** Runs fn after every earlier integration step, whether that step succeeded or failed. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.integrating.catch(() => undefined).then(fn)
    this.integrating = next.catch(() => undefined)
    return next
  }

  private async verifyAndIntegrate(t: TaskRecord, a: AttemptRecord, fullText: string): Promise<void> {
    t.state = 'verifying'; this.persist(true)
    const gates: GateResult[] = []
    const wt = a.worktree as string; const admin = a.adminDir ?? null
    // A read-only task looked at the shared integration worktree: check it between picks, not during one.
    const g = t.spec.mode === 'read' ? await this.serial(() => gitGate(wt, this.covers(t), 'read', null)) : await gitGate(wt, this.covers(t), 'write', admin)
    gates.push(g.result); a.changes = g.changes.map(c => c.path)
    if (t.spec.mode === 'write') {
      gates.push(await securityGate(wt, admin))
      if (g.changes.length && g.result.state === 'pass') {
        for (const spec of this.header.gates) gates.push(await runCommandGate(spec, wt, join(this.dir, 'runs', t.spec.id, String(a.n), 'gates'), { hide: this.config.sandbox.hide, shareDirs: this.deps.shareDirs.map(s => ({ from: s.from, to: join(wt, s.to) })), timeoutSeconds: this.config.limits.gateTimeoutSeconds, gitCommonDir: this.header.commonDir }, a.id))
        let finalChanges = g.changes
        // Command gates run worker-authored code with a writable tree: whatever they changed is
        // re-checked for scope, hooks, links and credentials before anything is committed.
        if (this.header.gates.length) {
          // New untracked paths that appeared only during the gates are their artifacts (coverage/,
          // dist/, caches), not the worker's change: they are removed from this attempt's own
          // temporary worktree. Tracked or pre-existing paths the gates modified still fail below.
          const before = new Set(g.changes.map(c => c.path))
          const artifacts = (await changesOf(wt, admin)).filter(c => c.status === '??' && !before.has(c.path)).map(c => c.path)
          const removed: string[] = []
          for (const p of artifacts) { const abs = resolve(wt, p); if (abs.startsWith(`${wt}/`) && !p.split('/').includes('.git')) { rmSync(abs, { force: true, recursive: true }); removed.push(p) } }
          if (removed.length) this.ledger.append('gate_artifacts_removed', t.spec.id, { attempt: a.id, count: removed.length, paths: removed.slice(0, 50) })
          const post = await gitGate(wt, this.covers(t), 'write', admin, 'GIT(after gates)')
          gates.push(post.result, await securityGate(wt, admin, 'SECURITY(after gates)'))
          finalChanges = post.changes
          a.changes = post.changes.map(c => c.path)
        }
        // A change that weakens its own gates only reports the worker's word about itself.
        a.gateTaint = gateTaint(finalChanges, this.header.gates, packageScripts(this.live.integration.dir))
      }
    }
    a.gates = gates
    // a gate whose sandbox processes are not confirmed gone may still be running worker code: ownership is kept
    const loose = gates.find(x => x.unaccounted)
    if (loose) {
      // the attempt is held on the gate's processes, durably: a restarted supervisor (and recover --lost, through the
      // claim) censuses the gate sandbox, not the worker that already ended
      a.heldTarget = loose.target ?? null; a.phase = 'held'
      if (t.spec.mode === 'write') writeClaim(this.header.commonDir, { missionId: this.header.id, taskId: t.spec.id, attempt: a.n, owned: t.spec.owned, mode: t.spec.mode, state: 'uncertain', identity: { ...(a.identity ?? {}), ...(loose.target ?? {}) }, supervisor: processIdentity(process.pid), stateDir: this.dir, at: new Date().toISOString() })
      this.ledger.append('gates', t.spec.id, { attempt: a.id, gates: gates.map(x => ({ name: x.name, state: x.state })), held: loose.target ?? null })
      this.hold(t, a, `gate ${loose.name}: processes not accounted for (${loose.unaccounted}); ownership retained`); return
    }
    this.ledger.append('gates', t.spec.id, { attempt: a.id, gates: gates.map(x => ({ name: x.name, state: x.state, exit: x.exitCode ?? null, sha: x.outputSha256 ?? null, evidence: x.evidence.slice(0, 600) })) })
    const bad = gates.filter(x => x.state !== 'pass')
    const structural = bad.find(x => x.kind === 'git' || x.kind === 'security')
    if (structural) { await this.failed(t, a, 'policy_abort', `${structural.name} gate: ${structural.evidence}`, []); return }
    const claimed = SUCCESS_CLAIM.test(a.resultExcerpt ?? '')
    // A conversation turn may honestly need no change; claiming done work without any change is still a misreport.
    if (t.spec.mode === 'write' && g.changes.length === 0 && !['review', 'scout'].includes(t.spec.kind) && (!t.spec.allowNoChanges || claimed)) { await this.failed(t, a, claimed ? 'misreported_completion' : 'no_changes', `write task finished with no changes${claimed ? ' while claiming success' : ''}`, [`previous attempt made no changes${claimed ? ' but reported success' : ''}`]); return }
    if (bad.length) { await this.failed(t, a, claimed ? 'misreported_completion' : 'gate_failed', `${bad.map(x => `${x.name} ${x.state}`).join(', ')}${claimed ? ' (worker claimed success)' : ''}`, bad.map(x => `${x.name} (${x.command ?? x.kind}) ${x.state}: ${x.evidence.slice(-800)}`)); return }
    if (this.header.requireGates && t.spec.mode === 'write' && this.header.gates.length === 0) this.live.alerts.push(`${t.spec.id}: no command gates configured; change is checked for scope and secrets only`)
    // Integration is serial: one pick at a time, onto the mission branch only.
    if (a.gateTaint?.length) this.problem(`${t.spec.id}: the change touches what its gates are defined by: ${a.gateTaint.join(', ')}; those gate results are the worker's word about itself, review them`)
    // A cancel of this task that arrived while the gates ran wins over integration. A mission stop
    // does not: work that already passed verification is kept rather than thrown away.
    const cancelled = (): string | null => this.pendingCancel.has(t.spec.id) ? 'cancelled by the person during verification' : null
    { const why = cancelled(); if (why) { await this.failed(t, a, 'cancelled', why, []); return } }
    if (t.spec.mode === 'write' && a.changes.length) {
      const r = await this.serial(async () => {
        // checked again inside the serial section: an earlier pick may have taken a while
        const why = cancelled(); if (why) return { ok: false as const, cancelled: why, conflict: '' }
        a.commit = await commitTask(wt, `cockpit(${this.header.id}): ${t.spec.title} [${t.spec.id}]`, admin)
        return integrate(this.live.integration.dir, a.commit)
      })
      if (!r.ok && 'cancelled' in r && r.cancelled) { await this.failed(t, a, 'cancelled', r.cancelled, []); return }
      if (!r.ok) { await this.failed(t, a, 'integration_conflict', r.conflict, [`integration conflict: ${r.conflict.slice(0, 300)}`]); return }
      this.live.integration.head = r.head; t.integratedHead = r.head
      this.ledger.append('integrated', t.spec.id, { attempt: a.id, commit: a.commit, head: r.head })
      this.persist(true) // the new head is durable before anything else can fail
    }
    t.verification = 'PROVISIONAL_CHECKED'
    this.harvestRequests(t, fullText)
    if (isPlanTask(t.spec.id)) this.harvestPlan(t, fullText)
    if (t.spec.id === 'final-review') this.live.review = { text: a.resultExcerpt, attempt: a.id }
    this.endAttempt(t, a, 'completed')
    this.endTask(t, 'completed', null)
  }

  /** A durable verdict reason: survives restarts and keeps the mission from DONE. */
  private problem(why: string): void {
    (this.live.problems ??= []).push(why.slice(0, 600))
    this.live.alerts.push(why.slice(0, 300))
  }
  /** Ids already used in this mission, live or archived: model output is validated against both. */
  private known(): { has(id: string): boolean } { return { has: id => id in this.live.tasks || this.archive.stateOf(id) !== null } }

  /** Parses the commander's FULL answer (not the display excerpt). Any rejected or dropped task keeps DONE away. */
  private harvestPlan(t: TaskRecord, text: string): void {
    const p = parsePlan(text, this.known(), planPrefix(t.spec.id))
    if (!p.ok) { this.ledger.append('plan_rejected', t.spec.id, { reason: p.reason }); t.verification = 'SELF_REPORTED_UNCHECKED'; this.problem(`commander plan rejected: ${p.reason}`); return }
    const dropped: string[] = []
    // the commander's architecture is written once, in the plan, and handed to every planned task
    // as context only: the design describes the whole mission, so it must not steer each task's route
    const design = p.design ? `Architecture from the commander's plan (follow it):\n${p.design}` : undefined
    for (const s of p.tasks) { const r = this.addTask({ ...s, ...(design ? { context: design } : {}) }, 'commander-plan'); if (r.ok) t.children.push(s.id); else dropped.push(`${s.id}: ${r.reason}`) }
    this.ledger.append('plan_accepted', t.spec.id, { tasks: t.children, dropped, design: p.design ? p.design.slice(0, 2000) : null })
    if (dropped.length) { this.live.counters.refused += dropped.length; this.problem(`commander plan partly dropped (${dropped.length} of ${p.tasks.length}): ${dropped.join('; ')}`) }
  }

  /**
   * Parses a worker's FULL answer for COCKPIT_REQUEST. A child may not widen its parent:
   * a read-only parent cannot request writes, and every owned path must lie inside the
   * parent's ownership. Any violation refuses the whole request.
   */
  private harvestRequests(t: TaskRecord, text: string): void {
    if (!text || isPlanTask(t.spec.id)) return
    const r = parseRequest(text, t.spec, this.config.limits.maxChildrenPerTask, this.known())
    if (r === null) return
    let refusal = r.ok ? null : r.reason
    if (r.ok) for (const s of r.tasks) {
      if (s.mode === 'write' && t.spec.mode !== 'write') { refusal = `${s.id}: a read-only task cannot request write work`; break }
      const wide = s.owned.find(o => !t.spec.owned.some(p => p === '*' || o === p || (o !== '*' && o.startsWith(`${p}/`))))
      if (wide) { refusal = `${s.id}: owned path ${wide} is outside the requesting task's ownership (${t.spec.owned.join(', ')})`; break }
    }
    if (refusal !== null || !r.ok) { t.requestsRefused.push(refusal ?? 'invalid'); this.ledger.append('delegation_refused', t.spec.id, { reason: refusal }); this.problem(`delegation from ${t.spec.id} refused: ${refusal}`); return }
    for (const s of r.tasks) { const x = this.addTask(s, `request from ${t.spec.id}`); if (x.ok) t.children.push(s.id); else t.requestsRefused.push(`${s.id}: ${x.reason}`) }
    this.ledger.append('delegation', t.spec.id, { admitted: t.children, refused: t.requestsRefused })
    if (t.requestsRefused.length) { this.live.counters.refused += t.requestsRefused.length; this.problem(`delegation from ${t.spec.id} partly refused: ${t.requestsRefused.join('; ')}`) }
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
    if (cls === 'auth_error') this.live.alerts.push(`${t.spec.id}: provider refused authentication or billing (${detail.slice(0, 160)})`)
    const l = this.config.limits
    const step = cls === 'integration_conflict'
      ? (t.transientRetries < l.maxTransientRetries && t.attempts.length < l.maxAttemptsPerTask ? { action: 'retry_same' as const, reason: 'integration conflict: retry on the current mission head', delayMs: 0 } : { action: 'stop' as const, reason: 'integration conflict persists' })
      : nextStep(cls, a.role, { attempts: t.attempts.length, gateFailures: 0, escalated: t.escalations > 0, lastFailure: cls, transientRetries: t.transientRetries, escalations: t.escalations, corrections: t.corrections ?? 0, kind: t.spec.kind }, this.config, evidence)
    this.ledger.append('next_step', t.spec.id, { attempt: a.id, ...step })
    if (step.action === 'stop' || this.live.stopRequested || this.live.session.capReached) { this.endTask(t, 'failed', `${cls}: ${detail.slice(0, 300)} · ${step.reason}`); return }
    // Implementation failures carry what the attempt actually did: its diff (bounded) and the gate output.
    let diff = ''
    if (IMPLEMENTATION.includes(cls as FailureClass) && a.worktree && t.spec.mode === 'write') { try { diff = (await diffText(a.worktree, a.adminDir ?? null)).slice(0, 5000) } catch { /* no diff available */ } }
    const lead = step.action === 'escalate'
      ? ['Earlier attempts did not pass Cockpit\'s verification. First diagnose the root cause from the evidence below, then fix it; keep what was correct.']
      : step.action === 'correct' ? ['Your previous attempt did not pass Cockpit\'s verification. Correct it using the evidence below (the checkout starts from the mission head again).'] : []
    // A transient retry repeats the same request: a correction's evidence stays with it.
    if (step.action !== 'retry_same') t.evidence = [...lead, ...evidence.slice(0, 6), ...(diff ? [`Diff of the previous attempt:\n${diff}`] : [])]
    else if (cls === 'integration_conflict') t.evidence = [...t.evidence.filter(e => !e.startsWith('integration conflict')), ...evidence.slice(0, 2)]
    if (step.action === 'retry_same') {
      t.transientRetries++; t.retryAt = this.deps.now() + (step.delayMs ?? backoffMs(t.transientRetries, l.retryBaseMs, l.retryMaxMs))
      // never before the model's breaker would let it through: the retry is a half-open try, not a refusal
      const h = this.live.health[`${a.provider}/${a.model}`]
      if (h?.unhealthy && h.until !== undefined) t.retryAt = Math.max(t.retryAt, h.until)
    } else t.retryAt = null
    if (step.action === 'correct') t.corrections = (t.corrections ?? 0) + 1
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
        const target = a.heldTarget ?? targetOf(a.identity, `COCKPIT_CLINE_ATTEMPT=${a.id}`, Date.parse(a.startedAt))
        let c = census(target)
        if (c.state === 'alive') { this.ledger.append('reconcile_kill', t.spec.id, { attempt: a.id, pids: c.pids }); c = await terminate(target, true, 5000) }
        a.census = c
        this.ledger.append('reconciled', t.spec.id, { attempt: a.id, census: c })
        if (c.state !== 'gone') { this.hold(t, a, `after restart: ${c.detail}; ownership retained`); continue }
        a.phase = 'ended'; a.endedAt = new Date(this.deps.now()).toISOString()
        const stream = join(this.dir, 'runs', t.spec.id, String(a.n), 'rw', 'stream.jsonl')
        const text = existsSync(stream) ? readFileSync(stream, 'utf8') : ''
        const sawResult = text.includes('"type":"run_result"')
        // usage the stream recorded after the last persist is folded in; a request still in flight when the
        // supervisor ended may be billed but never reported, so the attempt's cost is a lower bound
        if (text && !a.heldTarget) { const f = emptyFacts(); for (const line of text.split('\n')) if (line.trim()) foldLine(f, line); if (f.usageEvents >= a.usageEvents) { this.absorb(a, f); this.chargeSession() } }
        // (a hold on a gate's processes came after the worker ended normally: its usage is complete)
        if (!a.heldTarget) { const lb = (this.live.session.lowerBoundTasks ??= []); if (!lb.includes(a.id)) lb.push(a.id) }
        await this.failed(t, a, 'unknown_outcome', `supervisor ended while the attempt ran; ${sawResult ? 'a run result was written but was never verified' : 'no run result'}`, [])
      }
      // Processes ended (census gone when the attempt ended) but no outcome was recorded: a crash or
      // an error during verification or integration. Its engine task and repo claim are still held;
      // release them through the normal failure path, which also decides the bounded retry.
      const last = t.attempts.at(-1)
      if (last && last.phase === 'ended' && last.failure === null && ['verifying', 'running', 'held'].includes(t.state)) {
        // Its pick may already be on the mission branch (the crash came after integrate): never redo it.
        const landed = t.spec.mode === 'write' ? await integratedCommitFor(this.live.integration.dir, this.live.integration.base, t.spec.id).catch(() => null) : null
        if (landed) {
          this.ledger.append('reconciled', t.spec.id, { attempt: last.id, census: last.census, outcome: 'already integrated', commit: landed })
          t.integratedHead = landed; t.verification = 'PROVISIONAL_CHECKED'
          this.problem(`${t.spec.id}: finished after an interruption; its commit ${landed.slice(0, 12)} had already been integrated (gates passed before the pick), but plan or delegation output from that run was not read`)
          this.endAttempt(t, last, 'completed'); this.endTask(t, 'completed', 'integrated before the interruption')
        } else {
          this.ledger.append('reconciled', t.spec.id, { attempt: last.id, census: last.census, outcome: 'interrupted after the worker ended' })
          await this.failed(t, last, 'unknown_outcome', `verification or integration was interrupted (${t.reason ?? t.state}); the attempt is re-run on the current mission head`, [])
        }
      }
    }
    // The mission branch is the integration record: if it moved past what was persisted (a crash
    // right after a pick), adopt the real head and keep the mission from DONE until a person looks.
    try {
      const actual = await headOf(this.live.integration.dir)
      if (actual !== this.live.integration.head) {
        this.problem(`mission branch head ${actual.slice(0, 12)} differs from the recorded ${this.live.integration.head.slice(0, 12)} (interrupted integration); review ${this.live.integration.branch}`)
        this.ledger.append('integration_head_drift', null, { recorded: this.live.integration.head, actual })
        this.live.integration.head = actual
      }
    } catch (e) { this.problem(`mission branch unreadable after restart: ${(e as Error).message}`) }
    this.persist(true)
  }

  // ----- finalization ----------------------------------------------------------------
  /** Final gates on the mission branch and the commander's review. Returns true if new work was queued. */
  private async finalize(): Promise<boolean> {
    if (this.header.review && !this.live.review && !this.live.tasks['final-review'] && !this.archive.stateOf('final-review') && this.live.integration.head !== this.live.integration.base) {
      const diffBase = this.live.integration.base.slice(0, 12)
      const r = this.addTask({ id: 'final-review', title: 'Commander: critical review of the integrated change', kind: 'review', risk: 'high', complexity: 4, mode: 'read', owned: ['*'], dependencies: [], priority: 9, depth: 1, parent: null, prompt: `Review the mission's integrated change critically: run \`git diff ${diffBase}..HEAD\` and inspect the code. Goal of the mission:\n${this.header.goal}\nReport concrete defects with file and line. Do not edit files.` }, 'finalize')
      if (r.ok) return true
    }
    this.live.state = 'finalizing'
    this.live.finalGates = [] // each run judges the branch as it is now, not an earlier run's result
    this.live.finalGatesHead = null
    if (this.live.integration.head !== this.live.integration.base) {
      const head = this.live.integration.head
      // without a reliable picture of the tree before the gates, nothing is removed afterwards
      const pre = await changesOf(this.live.integration.dir, null).catch(() => null)
      const before = new Set((pre ?? []).map(c => c.path))
      for (const g of this.header.gates) this.live.finalGates.push(await runCommandGate(g, this.live.integration.dir, join(this.dir, 'final-gates'), { hide: this.config.sandbox.hide, shareDirs: this.deps.shareDirs.map(s => ({ from: s.from, to: join(this.live.integration.dir, s.to) })), timeoutSeconds: this.config.limits.gateTimeoutSeconds, gitCommonDir: this.header.commonDir }, `${this.header.id}-final`))
      this.live.finalGatesHead = head
      // The final gates ran worker-authored code in the integration worktree, which later turns read and pick
      // onto: new untracked paths are their artifacts and are removed; anything else they changed is reported.
      const after = await changesOf(this.live.integration.dir, null).catch(() => null)
      if (after === null || pre === null) this.problem(`final gates: the integration worktree could not be inspected ${pre === null ? 'before' : 'after'} they ran; nothing was removed`)
      else {
        const dir = this.live.integration.dir; const removed: string[] = []
        for (const c of after) if (c.status === '??' && !before.has(c.path)) { const abs = resolve(dir, c.path); if (abs.startsWith(`${dir}/`) && !c.path.split('/').includes('.git')) { rmSync(abs, { force: true, recursive: true }); removed.push(c.path) } }
        if (removed.length) this.ledger.append('gate_artifacts_removed', null, { scope: 'final', count: removed.length, paths: removed.slice(0, 50) })
        const changed = after.filter(c => !(c.status === '??' && !before.has(c.path)) && !before.has(c.path))
        if (changed.length) this.problem(`final gates changed ${changed.length} tracked path(s) in the integration worktree (${changed.slice(0, 5).map(c => c.path).join(', ')}); review ${this.live.integration.branch}`)
      }
      for (const g of this.live.finalGates) if (g.unaccounted) this.problem(`final gate ${g.name}: processes not accounted for (${g.unaccounted})`)
      this.ledger.append('final_gates', null, { head, gates: this.live.finalGates.map(x => ({ name: x.name, state: x.state, sha: x.outputSha256 })) })
    }
    return false
  }

  verdict(): Verdict {
    const reasons: string[] = []
    const live = Object.values(this.live.tasks)
    const held = live.filter(t => t.state === 'held')
    // anything still running or verifying at the end was never finished: never DONE around it
    const unfinished = live.filter(t => t.state === 'running' || t.state === 'verifying')
    const c = this.live.counters
    if (held.length) reasons.push(`${held.length} task(s) held with ownership retained: ${held.map(t => `${t.spec.id} (${t.reason})`).join('; ')}`)
    if (unfinished.length) reasons.push(`${unfinished.length} task(s) never finished: ${unfinished.map(t => `${t.spec.id} (${t.state})`).join(', ')}`)
    if (this.live.stopRequested) reasons.push(`stopped: ${this.live.stopRequested}`)
    if (c.failed) reasons.push(`${c.failed} task(s) failed`)
    if (c.refused) reasons.push(`${c.refused} task(s) refused or never started`)
    if (c.cancelled) reasons.push(`${c.cancelled} task(s) cancelled`)
    const problems = this.live.problems ?? []
    for (const p of problems) reasons.push(p)
    const weakOnly = (r: string): boolean => /gates are defined by|no test\/type\/build gate/.test(r)
    if (this.live.session.unmetered) reasons.push(`usage unmetered for ${this.live.session.unmeteredTasks.join(', ')}: cost not measured`)
    if (this.live.session.capReached) reasons.push('session budget reached')
    const finalBad = this.live.finalGates.filter(g => g.state !== 'pass')
    if (finalBad.length) reasons.push(`final gates on ${this.live.integration.branch}: ${finalBad.map(g => `${g.name} ${g.state}`).join(', ')}`)
    const ledger = this.ledger.verify()
    if (!ledger.ok) reasons.push(`ledger integrity: ${ledger.problem}`)
    // a deleted or emptied ledger verifies trivially; a mission always has its creation entry
    const ledgerEmpty = ledger.ok && ledger.entries === 0
    if (ledgerEmpty) reasons.push('ledger integrity: the ledger has no entries (deleted or replaced)')
    const noGates = this.header.gates.length === 0 && this.live.integration.head !== this.live.integration.base
    if (noGates && this.header.requireGates) reasons.push('no test/type/build gate was configured: the change is scope- and secret-checked only')
    const at = new Date().toISOString()
    if (held.length || unfinished.length || !ledger.ok || ledgerEmpty) return { state: 'BLOCKED', reasons, at }
    if (this.live.stopRequested) return { state: 'STOPPED', reasons, at }
    if (c.completed === 0) return { state: 'FAILED', reasons: reasons.length ? reasons : ['nothing completed'], at }
    if (reasons.length) return { state: reasons.every(weakOnly) ? 'UNVERIFIED' : 'PARTIAL', reasons, at }
    const estimated = this.live.session.estimatedTasks ?? []
    const lower = this.live.session.lowerBoundTasks ?? []
    const cost = [estimated.length ? `usage measured; cost of ${estimated.length} attempt(s) estimated from configured pricing (Cline reported no cost): ${estimated.join(', ')}` : 'costs metered (Cline-reported)', ...(lower.length ? [`cost of ${lower.length} attempt(s) interrupted by a restart is a lower bound: ${lower.join(', ')}`] : [])].join('; ')
    return { state: 'DONE', reasons: [`${c.completed} task(s) verified by supervisor gates and integrated on ${this.live.integration.branch}; final gates pass; ${cost}; ledger intact`], at }
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
