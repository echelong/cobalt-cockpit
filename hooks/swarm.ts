/** Pure, bounded swarm control. The host alone spawns/cancels agents; this module
 * reserves ownership first and never calls a model or a local-control writer.
 * Resource limits are configurable safety budgets, not a product agent ceiling.
 */
import type { EffortLevel, ModelTier, Wave, TaskState, Verification, SwarmResult, Handoff, SwarmTask, SwarmEvent, SwarmConfig, Swarm, TaskInput } from '../types'
export type { ModelTier, Wave, TaskState, Verification, SwarmResult, Handoff, SwarmTask, SwarmEvent, SwarmConfig, Swarm, TaskInput } from '../types'
import { BASE_EFFORT, effortEscalation, isEffortLevel } from './effort'
import { redactSecrets } from './secrets'
export const DEFAULT_SWARM_CONFIG: SwarmConfig = { sonnet: 'AUTO', haiku: 'AUTO', total: 'AUTO', opus: 0, maxTasks: 512, maxEvents: 256, stallMs: 300_000 }
/** SONNET_LED's conservative budget: four helpers in all, two Sonnet, two Haiku and one Opus within them. */
export const SONNET_LED_SWARM: Partial<SwarmConfig> = { total: 4, sonnet: 2, haiku: 2, opus: 1 }
const integer = (n: number, fallback: number, min = 0): number => Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback
const normalizeConfig = (c: Partial<SwarmConfig>): SwarmConfig => {
  const out = { ...DEFAULT_SWARM_CONFIG, ...c }
  for (const key of ['sonnet', 'haiku', 'total'] as const) out[key] = out[key] === 'AUTO' ? 'AUTO' : integer(out[key], key === 'sonnet' ? 8 : 16)
  out.opus = integer(out.opus ?? 0, 0)
  out.maxTasks = integer(out.maxTasks, 512, 1); out.maxEvents = integer(out.maxEvents, 256, 1); out.stallMs = integer(out.stallMs, 300_000, 1)
  return out
}
export const emptySwarm = (config: Partial<SwarmConfig> = {}): Swarm => ({ version: 2, wave: 'RECONNAISSANCE', config: normalizeConfig(config), tasks: [], events: [], sequence: 0, requested: 0, actual: 0, highWater: 0, conflicts: 0, droppedEvents: 0 })
export const configureSwarm = (s: Swarm, config: Partial<SwarmConfig>): Swarm => ({ ...s, config: normalizeConfig({ ...s.config, ...config }) })
/** Lexical paths only: host must canonicalize symlinks before declaring ownership.
 * Empty, wildcard or ambiguous glob claims conservatively own the whole repo. */
export const normalizeOwned = (path: string): string => {
  const value = path.trim().replace(/\\/g, '/')
  if (!value || /[*?\[\]{}]/.test(value)) return '*'
  const parts: string[] = []
  for (const part of value.split('/')) { if (!part || part === '.') continue; if (part === '..') { if (!parts.length) return '*'; parts.pop() } else parts.push(part) }
  return parts.length ? `/${parts.join('/')}` : '*'
}
export const overlaps = (a: string, b: string): boolean => { const x = normalizeOwned(a), y = normalizeOwned(b); return x === '*' || y === '*' || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`) }
const terminal = (t: SwarmTask): boolean => ['completed', 'failed', 'cancelled'].includes(t.state)
/** A stall/escalation is not proof that a live agent stopped writing. */
const occupied = (t: SwarmTask): boolean => t.endedAt === null && (t.state === 'reserved' || t.state === 'running' || (!terminal(t) && (t.agentId !== null || (t.state === 'stalled' && t.startedAt !== null))))
const active = (s: Swarm): SwarmTask[] => s.tasks.filter(occupied)
const event = (s: Swarm, kind: string, id: string | null, at: number, detail: string): Swarm => {
  const item: SwarmEvent = { seq: s.sequence + 1, at, kind, taskId: id, agentId: s.tasks.find(t => t.id === id)?.agentId ?? null, wave: s.wave, detail: redactSecrets(detail).slice(0, 1500) }
  const all = [...s.events, item]; const dropped = Math.max(0, all.length - s.config.maxEvents)
  return { ...s, sequence: item.seq, events: all.slice(-s.config.maxEvents), droppedEvents: s.droppedEvents + dropped }
}
const update = (s: Swarm, id: string, change: Partial<SwarmTask>): Swarm => ({ ...s, tasks: s.tasks.map(t => t.id === id ? { ...t, ...change } : t) })
const dependencyReason = (s: Swarm, t: SwarmTask): string | null => {
  for (const id of t.dependencies) { const dep = s.tasks.find(d => d.id === id); if (dep?.state !== 'completed') return `dependency ${id}: ${dep?.state ?? 'unknown'}` }
  return null
}
const cycle = (s: Swarm, input: TaskInput): boolean => {
  const walk = (id: string, visited: Set<string>): boolean => { if (id === input.id) return true; if (visited.has(id)) return false; visited.add(id); return (s.tasks.find(t => t.id === id)?.dependencies ?? []).some(dep => walk(dep, visited)) }
  return (input.dependencies ?? []).some(dep => walk(dep, new Set()))
}
export const submitTask = (s: Swarm, raw: TaskInput, at: number): { swarm: Swarm; task: SwarmTask; duplicate: boolean } => {
  // free text is filtered before it is compared or kept
  const input: TaskInput = { ...raw, role: redactSecrets(raw.role), objective: redactSecrets(raw.objective), ...(raw.scope === undefined ? {} : { scope: redactSecrets(raw.scope) }), ...(raw.spawnReason === undefined ? {} : { spawnReason: redactSecrets(raw.spawnReason) }), ...(raw.effortReason === undefined ? {} : { effortReason: redactSecrets(raw.effortReason) }) }
  const owned = [...new Set((input.owned?.length ? input.owned : ['*']).map(normalizeOwned))].sort()
  const same = s.tasks.find(t => t.id === input.id || (!terminal(t) && t.tier === input.tier && t.mode === (input.mode ?? 'read') && t.objective.trim() === input.objective.trim() && t.scope === (input.scope ?? '') && t.wave === (input.wave ?? s.wave) && t.parentTask === (input.parentTask ?? null) && JSON.stringify([...t.dependencies].sort()) === JSON.stringify([...(input.dependencies ?? [])].sort()) && JSON.stringify(t.owned) === JSON.stringify(owned)))
  if (same) return { swarm: event({ ...s, requested: s.requested + 1 }, 'duplicate', same.id, at, input.id), task: same, duplicate: true }
  if (!input.id.trim() || !input.objective.trim()) throw new Error('Task ID and objective required')
  if (s.tasks.length >= s.config.maxTasks) throw new Error('Task storage budget reached; archive this run before adding work')
  if (cycle(s, input)) throw new Error('Task dependency cycle')
  if (input.parentTask && !s.tasks.some(t => t.id === input.parentTask && !terminal(t))) throw new Error('Parent task missing or terminal')
  const task: SwarmTask = { ...input, parentTask: input.parentTask ?? null, parentAgent: input.parentAgent ?? null, agentId: null, scope: input.scope ?? '', dependencies: [...new Set(input.dependencies ?? [])], owned, mode: input.mode ?? 'read', wave: input.wave ?? s.wave, spawnReason: input.spawnReason ?? 'Commander bounded assignment', requestedEffort: input.effort ?? 'AUTO', effortReason: input.effortReason ?? (input.effort !== undefined && input.effort !== 'AUTO' ? `named by the commander (${input.effort})` : 'AUTO: chosen from the task'), appliedEffort: null, launchEffort: null, effortEscalation: null, state: 'queued', cancellationRequested: false, escalation: null, result: null, verification: 'pending', createdAt: at, startedAt: null, endedAt: null, lastActivityAt: at, reason: null }
  const swarm = event({ ...s, tasks: [...s.tasks, task], requested: s.requested + 1 }, 'assignment', task.id, at, `${task.tier} ${task.role}: ${task.spawnReason}`)
  return { swarm, task, duplicate: false }
}
export const admissionReason = (s: Swarm, id: string): string | null => {
  const task = s.tasks.find(t => t.id === id)
  if (!task) return 'unknown task'
  if (task.state !== 'queued' && task.state !== 'blocked') return `task ${task.state}`
  const dep = dependencyReason(s, task); if (dep) return dep
  const live = active(s)
  const opus = s.config.opus ?? 0
  const total = s.config.total === 'AUTO' ? 16 : s.config.total
  if (task.tier === 'OPUS' && opus === 0) { if (live.some(t => t.tier === 'OPUS')) return 'commander occupied' }
  else if (task.tier === 'OPUS') {
    // An Opus specialist is a real subagent here: one pool, inside the total.
    if (live.filter(t => t.tier === 'OPUS').length >= opus) return 'architect occupied'
    if (live.length >= total) return 'resource budget'
  } else {
    const pool = task.tier === 'SONNET' ? s.config.sonnet : s.config.haiku
    const limit = pool === 'AUTO' ? (task.tier === 'SONNET' ? 8 : 16) : pool
    if (live.filter(t => opus > 0 || t.tier !== 'OPUS').length >= total || live.filter(t => t.tier === task.tier).length >= limit) return 'resource budget'
  }
  const collision = live.find(t => (task.mode === 'write' || t.mode === 'write') && task.owned.some(a => t.owned.some(b => overlaps(a, b))))
  return collision ? `ownership conflict: ${collision.id}` : null
}
export const admitTask = (s: Swarm, id: string, at: number): { swarm: Swarm; ok: boolean; reason: string | null } => {
  const reason = admissionReason(s, id)
  if (reason) {
    const task = s.tasks.find(t => t.id === id); const waiting = task && ['queued', 'blocked'].includes(task.state)
    const conflict = reason.startsWith('ownership conflict')
    let moved = waiting ? update(s, id, { state: 'blocked', reason }) : s
    if (conflict) moved = { ...moved, conflicts: moved.conflicts + 1 }
    return { swarm: event(moved, conflict ? 'conflict' : 'blocked', id, at, reason), ok: false, reason }
  }
  const reserved = update(s, id, { state: 'reserved', startedAt: at, lastActivityAt: at, reason: null })
  return { swarm: event({ ...reserved, highWater: Math.max(s.highWater, active(reserved).length) }, 'reserved', id, at, 'Slot and ownership reserved before host spawn'), ok: true, reason: null }
}
export const bindAgent = (s: Swarm, id: string, agentId: string, at: number, kind: 'spawn' | 'adopt' = 'spawn'): Swarm => {
  const t = s.tasks.find(t => t.id === id)
  if ((!t || (t.state !== 'reserved' && !(t.state === 'stalled' && t.startedAt !== null && t.agentId === null))) || (t.tier === 'OPUS' && (s.config.opus ?? 0) === 0) || !agentId || s.tasks.some(t => t.agentId === agentId)) throw new Error('Agent binding requires a unique observed agent and reserved subagent task')
  return event({ ...update(s, id, { agentId, state: 'running', lastActivityAt: at }), actual: s.actual + 1 }, kind, id, at, `${t.tier} ${t.role}${kind === 'adopt' ? ' · observed existing host agent; no new spawn' : ''}`)
}
const text = (s: string): string => redactSecrets(s).slice(0, 1500)
const list = (s: readonly string[]): string[] => s.slice(0, 12).map(text)
export const compressResult = (r: Partial<SwarmResult>): SwarmResult => ({ conclusion: text(r.conclusion ?? ''), evidence: list(r.evidence ?? []), changes: list(r.changes ?? []), verification: list(r.verification ?? []), unresolved: list(r.unresolved ?? []), confidence: r.confidence === undefined || r.confidence === null ? null : text(r.confidence), escalation: r.escalation === undefined || r.escalation === null ? null : text(r.escalation), rawRef: r.rawRef === undefined || r.rawRef === null ? null : text(r.rawRef) })
export const finishTask = (s: Swarm, id: string, state: 'completed' | 'failed' | 'cancelled', result: Partial<SwarmResult> | null, at: number): Swarm => {
  const t = s.tasks.find(t => t.id === id); if (!t || terminal(t) || t.endedAt !== null) return s
  if (state === 'completed' && (!occupied(t) || dependencyReason(s, t) || s.tasks.some(child => child.parentTask === id && !terminal(child)))) throw new Error('Cannot complete unadmitted task, unresolved dependencies or active children')
  return event(update(s, id, { state: state === 'completed' && t.escalation !== null ? 'escalated' : state, result: result === null ? t.result : compressResult(result), endedAt: at, lastActivityAt: at, reason: null }), state === 'completed' && t.escalation !== null ? 'escalation_stopped' : state, id, at, result?.conclusion ?? '')
}
/** Call only after the host confirms stop/failure: terminal transitions release locks. */
export const heartbeat = (s: Swarm, id: string, at: number): Swarm => update(s, id, { lastActivityAt: at, ...(s.tasks.find(t=>t.id===id)?.state === 'stalled' ? { state: s.tasks.find(t=>t.id===id)?.agentId ? 'running' as const : 'reserved' as const, reason:null } : {}) })
export const markStalled = (s: Swarm, at: number): Swarm => {
  let stalled = s
  for (const t of active(s)) if (t.state !== 'stalled' && at - t.lastActivityAt >= s.config.stallMs) stalled = event(update(stalled, t.id, { state: 'stalled', reason: 'Awaiting host cancellation or recovery; ownership retained' }), 'stalled', t.id, at, 'No observed activity')
  return stalled
}
const levelOf = (t: SwarmTask): EffortLevel => isEffortLevel(t.appliedEffort) ? t.appliedEffort : isEffortLevel(t.requestedEffort) ? t.requestedEffort : BASE_EFFORT[t.tier]
export const escalateTask = (s: Swarm, id: string, h: Handoff, at: number): Swarm => {
  const t = s.tasks.find(t => t.id === id)
  if (!t || terminal(t)) throw new Error('Escalation requires an active task')
  // Effort escalation keeps the tier and raises the level; a tier escalation
  // moves toward the commander. At least one of the two must actually move.
  const effortOnly = isEffortLevel(h.effort) && h.to === t.tier
  if (!effortOnly && (t.tier === 'OPUS' || h.to === 'HAIKU' || (t.tier === 'SONNET' && h.to !== 'OPUS'))) throw new Error('Escalation must move toward commander')
  const handoff: Handoff = { ...h, effort: isEffortLevel(h.effort) ? h.effort : null, effortReason: typeof h.effortReason === 'string' ? text(h.effortReason) : null, objective: text(h.objective), discoveries: list(h.discoveries), evidence: list(h.evidence), question: text(h.question), risk: text(h.risk), nextAction: text(h.nextAction), locations: list(h.locations) }
  const from = levelOf(t)
  const moved = isEffortLevel(h.effort) && h.effort !== from ? effortEscalation(from, h.effort, h.effortReason ?? 'commander raised effort', at) : t.effortEscalation
  const where = isEffortLevel(h.effort) ? `${t.tier} ${from} → ${h.effort}` : `${t.tier} → ${h.to}`
  // Reserved tasks retain their lock even before the host reports an agent ID.
  return event(update(s, id, { escalation: handoff, effortEscalation: moved, state: occupied(t) ? t.state : 'escalated', reason: `Escalation to ${h.to}` }), 'escalation', id, at, `${where}: ${handoff.question}`)
}
/** Records the level actually applied to a task's live requests, where observed. */
export const setAppliedEffort = (s: Swarm, id: string, level: string | null): Swarm => s.tasks.some(t => t.id === id) ? update(s, id, { appliedEffort: level }) : s
/**
 * Records the level set natively on a task's Agent call, or null when a launch
 * did not start. `named` is a level the commander put on the call by hand: it
 * becomes the task's requested level when the assignment itself named none.
 */
export const setLaunchEffort = (s: Swarm, id: string, level: EffortLevel | null, named: EffortLevel | null = null): Swarm => {
  const t = s.tasks.find(t => t.id === id)
  if (!t) return s

  return update(s, id, { launchEffort: level, ...(named !== null && t.requestedEffort === 'AUTO' ? { requestedEffort: named, effortReason: `named on the Agent call (${named})` } : {}) })
}
export const setWave = (s: Swarm, wave: Wave, at: number): Swarm => s.wave === wave ? s : event({ ...s, wave }, 'wave', null, at, `${s.wave} → ${wave}`)
export const verifyTask = (s: Swarm, id: string, verification: Verification, at: number, evidence: string): Swarm => {
  const task = s.tasks.find(t => t.id === id)
  if (!task) throw new Error('Unknown task')
  if (verification === 'pass' && task.state !== 'completed') throw new Error('Verification pass requires completed, resolved task')
  return event(update(s, id, { verification }), 'verification', id, at, `${verification}: ${evidence}`)
}
/** Explicit commander integration resolves a stopped escalation. */
export const resolveEscalation = (s: Swarm, id: string, result: Partial<SwarmResult>, at: number): Swarm => {
  const task = s.tasks.find(t => t.id === id)
  if (!task || task.state !== 'escalated' || task.endedAt === null) throw new Error('Resolution requires a host-stopped escalated task')
  if (dependencyReason(s, task) || s.tasks.some(child => child.parentTask === id && !terminal(child))) throw new Error('Resolution requires settled dependencies and children')
  if (!result.conclusion?.trim() || !result.evidence?.some(e => e.trim())) throw new Error('Resolution requires commander conclusion and evidence')
  return event(update(s, id, { state: 'completed', result: compressResult(result), verification: 'pending', reason: null }), 'escalation_resolved', id, at, result.conclusion)
}
export const summarizeSwarm = (s: Swarm) => ({ wave: s.wave, parallelism: active(s).length, queue: s.tasks.filter(t => t.state === 'queued').length, blocked: s.tasks.filter(t => t.state === 'blocked' || t.state === 'stalled').length, completed: s.tasks.filter(t => t.state === 'completed').length, total: s.tasks.length, sonnet: s.tasks.filter(t => t.tier === 'SONNET' && occupied(t)).length, haiku: s.tasks.filter(t => t.tier === 'HAIKU' && occupied(t)).length, opus: (s.config.opus ?? 0) > 0 ? s.tasks.filter(t => t.tier === 'OPUS' && occupied(t)).length : 0, escalations: s.tasks.filter(t => t.escalation !== null).map(t => ({ task: t.id, from: t.tier, to: t.escalation!.to })), effortEscalations: s.tasks.filter(t => t.effortEscalation !== null).map(t => ({ task: t.id, from: t.effortEscalation!.from, to: t.effortEscalation!.to })), conflicts: s.conflicts, requested: s.requested, actual: s.actual, highWater: s.highWater, tokens: null, cost: null })
/** Semantic evidence, not keyword routing. Explicit commander choice wins. */
export const routeTask = (facts: { commanderChoice?: ModelTier; trivial?: boolean; coupled?: boolean; architecture?: boolean; ambiguous?: boolean; highRisk?: boolean; extractive?: boolean; bounded?: boolean }): ModelTier => facts.commanderChoice ?? (facts.trivial || facts.coupled || facts.architecture || facts.ambiguous || facts.highRisk ? 'OPUS' : facts.extractive && facts.bounded ? 'HAIKU' : 'SONNET')

/** Cancellation intent is observable; live ownership remains until host completion. */
export const requestCancel = (s: Swarm, id: string, at: number): Swarm => {
  const t = s.tasks.find(t => t.id === id)
  if (!t || terminal(t)) return s
  return occupied(t) ? event(update(s, id, { cancellationRequested: true }), 'cancel_requested', id, at, 'Awaiting observed host completion') : finishTask(s, id, 'cancelled', null, at)
}
/** Only call when spawn failed before an agent was created. */
export const releaseReservation = (s: Swarm, id: string, at: number, reason: string): Swarm => {
  const t = s.tasks.find(t => t.id === id)
  if ((!t || !['reserved','stalled'].includes(t.state) || t.startedAt === null) || t.agentId !== null) throw new Error('Only unbound reservations can be released')
  return event(update(s, id, { state: t.cancellationRequested ? 'cancelled' : 'queued', startedAt: null, reason }), 'spawn_denied', id, at, reason)
}
/** Agent claims are evidence pending commander verification; reporting does not release ownership. */
export const reportResult = (s: Swarm, id: string, result: Partial<SwarmResult>, at: number): Swarm => {
  const task = s.tasks.find(t => t.id === id)
  if (!task || terminal(task) || !occupied(task)) throw new Error('Result requires admitted active task')
  return event(update(s, id, { result: compressResult(result), resultDelivery: task.resultDelivery === 'host_accepted' ? 'host_accepted' : 'reported' }), 'result', id, at, result.conclusion ?? '')
}
/** Only after the native host acknowledges SubagentHandback. It may finish the
 * turn before returning, so preserve the report even on a now-terminal task.
 * No ownership, lifecycle or verification transition is implied. */
export const acknowledgeHandback = (s: Swarm, agentId: string, message: string, at: number): Swarm => {
  const task = s.tasks.find(t => t.agentId === agentId)
  if (!task || !message.trim()) return s
  return event(update(s, task.id, { resultDelivery: 'host_accepted', result: task.result ?? compressResult({ conclusion: message, unresolved: ['Native handback acknowledged; commander verification pending'] }) }), 'report_acknowledged', task.id, at, 'Native host accepted report')
}
/** A shell/global operation uses '*'; a read never widens a write claim. */
export const ownershipAllows = (s: Swarm, id: string, path: string, mode: 'read' | 'write' = 'write'): boolean => {
  const t = s.tasks.find(t => t.id === id)
  if (!t || !occupied(t) || t.cancellationRequested || (mode === 'write' && t.mode !== 'write')) return false
  const claim = normalizeOwned(path)
  return t.owned.some(p => p === '*' || (claim !== '*' && (claim === p || claim.startsWith(`${p}/`))))
}
