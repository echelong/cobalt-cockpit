// The HUD's view model: a pure function of the supervisor's live state, its archived records,
// repository claims and the worker activity the timeline has seen. It decides nothing about the
// mission; it only states what the records say, and says "unknown" where they say nothing.
import type { Role } from '../core/engine.ts'
import { ROLES } from '../core/engine.ts'
import type { Config } from '../config.ts'
import type { Resolution } from '../catalog.ts'
import type { AttemptRecord, Header, Live, TaskRecord } from '../supervisor.ts'
import type { GateResult } from '../gates.ts'
import type { Claim } from '../store.ts'
import { statusOf } from '../status.ts'
import type { Status } from '../status.ts'
import { isPlanTask } from '../planner.ts'
import type { Activity } from './timeline.ts'
import { sanitize } from './term.ts'

export const ROLE_LABEL: Record<Role, string> = { commander: 'COMMANDER', coder: 'CODER', specialist: 'SPECIALIST', frontend: 'FRONTEND', utility: 'UTILITY' }
export const ROLE_DUTY: Record<Role, string> = { commander: 'plans · architecture · review', coder: 'default coder', specialist: 'debugging · hard review', frontend: 'UI · pages · styling', utility: 'scouting · docs · small edits' }

export type AgentState = 'running' | 'verifying' | 'retrying' | 'waiting' | 'queued' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'refused' | 'idle' | 'unavailable'
export type ReasoningStatus = 'confirmed' | 'mismatch' | 'unconfirmed' | 'inferred' | 'pending' | 'unobserved'
export type ReasoningView = { requested: string; effective: string; status: ReasoningStatus; detail: string }

export type RoleView = {
  role: Role; label: string; duty: string; name: string; model: string; provider: string; isDefault: boolean
  reasoning: ReasoningView; state: AgentState; stateText: string; task: string | null; activity: string
  tokensIn: number | null; tokensOut: number | null; cacheRead: number | null; usd: number | null; basis: 'reported' | 'estimate' | 'unmetered' | null
  elapsedMs: number | null; attempts: number; queued: number; orchestrating: boolean; escalatedFrom: Role | null; unresolved: string | null
}
export type AttemptView = {
  id: string; task: string; n: number; title: string; kind: string; risk: string; role: Role; model: string; provider: string
  state: AgentState; phase: string; reasoning: ReasoningView; rules: string[]; signals: string[]
  tokensIn: number | null; tokensOut: number | null; cacheRead: number | null; reasoningTokens: number | null; usd: number | null; basis: string
  elapsedMs: number; startedAt: number; endedAt: number | null; tools: Record<string, number>; iterations: number; changes: string[]
  gates: GateResult[]; failure: string | null; failureDetail: string | null; commit: string | null; integrated: boolean
  pid: number | null; census: string | null; worktree: string | null; owned: string[]; mode: string; activity: Activity | null
  verification: string | null; estimateUsd: number | null; wire: string | null; prompt: string
}

/** The five gate families; OTHER appears only when a configured gate (lint, format, …) belongs to none of them. */
export type GateName = 'TEST' | 'TYPE' | 'BUILD' | 'SECURITY' | 'GIT' | 'OTHER'
export const GATE_NAMES: GateName[] = ['TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT']
export type GateState = 'pass' | 'fail' | 'pending' | 'skipped' | 'unverifiable' | 'unset'
export type GateRun = { gate: GateResult; where: string; at: number | null }
export type GateView = { name: GateName; state: GateState; summary: string; evidence: string[]; runs: GateRun[] }

/**
 * Totals per model or task. `known` counts the attempts whose usage was reported: a row where none
 * was is unknown (shown —), and one where only some were is a lower bound (shown ≥).
 */
export type CostRow = { key: string; role: Role | null; model: string; attempts: number; known: number; tokensIn: number; tokensOut: number; cacheRead: number; usd: number; estimated: boolean; unmetered: number }
export type CostView = {
  budget: number; spent: number; committed: number; remaining: number; tokens: number
  /** Split of the session spend; null when older tasks are archived out of view and the split cannot be shown exactly. */
  reported: number | null; estimated: number | null; estimatedAttempts: number
  unmetered: boolean; unmeteredTasks: string[]; capReached: boolean; alertsFired: number[]; byModel: CostRow[]; byTask: CostRow[]
  /** The per-model and per-task lists cover only these many of the session's tasks (the rest are archived). */
  coverage: { shown: number; total: number }
}

export type MissionView = {
  id: string; profile: string; strict: boolean; clineVersion: string; repo: string; branch: string; head: string; base: string
  status: Status; verdict: Live['verdict']; problems: string[]; alerts: string[]; guard: string | null; claims: Claim[]
  counters: Live['counters']; orchestrating: { task: string; attempt: number } | null; turn: string | null
  milestones: { id: string; state: AgentState; title: string }[]; finalGatesFresh: boolean; startedAt: number
}

export type View = { mission: MissionView; roles: RoleView[]; attempts: AttemptView[]; gates: GateView[]; cost: CostView; now: number }
export type ViewInput = {
  header: Header; live: Live; records: readonly TaskRecord[]; claims: Claim[]; config: Config; resolutions: Record<Role, Resolution>
  committedUsd: number; activity: ReadonlyMap<string, Activity>; turn: string | null; now: number
  /** The router's own decision for a queued task (a pure function); without it a queued task is shown by its kind. */
  predictRole?: (t: TaskRecord) => Role | null
}

// ----- reasoning: verified only when the wire says so ---------------------------------------------
export const reasoningOf = (a: Pick<AttemptRecord, 'requestedReasoning' | 'expectedWire' | 'wire' | 'mapping' | 'phase'> | null, requestedDefault: string): ReasoningView => {
  if (!a) return { requested: requestedDefault, effective: '?', status: 'unobserved', detail: 'no request sent yet: effective reasoning is unknown' }
  const requested = a.requestedReasoning ?? requestedDefault
  const w = a.wire
  if (!w) return { requested, effective: a.expectedWire ?? '?', status: 'pending', detail: a.phase === 'ended' ? 'no wire capture was read for this attempt' : `expected ${a.expectedWire ?? '?'} on the wire; not observed yet` }
  if (w.state === 'mismatch') return { requested, effective: w.effective ?? '?', status: 'mismatch', detail: w.detail }
  if (w.state === 'unconfirmed') return { requested, effective: a.expectedWire ?? '?', status: 'unconfirmed', detail: w.detail }
  // a toggle-only model receives the field, but whether the provider honours a level is not observable
  if (a.mapping === 'toggle') return { requested, effective: /\b(?:off|none|disabled)\b/i.test(w.effective ?? '') ? 'off' : 'on', status: 'inferred', detail: `sent ${w.effective ?? 'on'} (toggle-only model: the provider's use of a level is inferred, not observed)` }
  return { requested, effective: w.effective ?? a.expectedWire ?? '?', status: 'confirmed', detail: w.detail }
}

const live = (a: AttemptRecord): boolean => a.phase !== 'ended' && a.phase !== 'held'
const attemptState = (t: TaskRecord, a: AttemptRecord): AgentState => {
  if (a.phase === 'held') return 'blocked'
  if (live(a)) return 'running'
  if (a !== t.attempts.at(-1)) return a.failure === 'cancelled' ? 'cancelled' : 'failed'
  // the worker has exited and the supervisor is classifying it: neither failed nor done yet
  if (t.state === 'verifying' || t.state === 'running') return 'verifying'
  if (t.state === 'completed') return 'completed'
  if (t.state === 'cancelled') return 'cancelled'
  if (t.state === 'queued') return (t.retryAt ?? 0) > Date.now() ? 'retrying' : 'queued'
  return t.state === 'refused' ? 'refused' : 'failed'
}
const taskState = (t: TaskRecord, now: number): AgentState => {
  if (t.state === 'held') return 'blocked'
  if (t.attempts.some(live)) return 'running'
  if (t.state === 'verifying' || t.state === 'running') return 'verifying'
  if (t.state === 'queued') return (t.retryAt ?? 0) > now ? 'retrying' : t.reason?.startsWith('waiting: ') ? 'waiting' : 'queued'
  return t.state === 'completed' ? 'completed' : t.state === 'cancelled' ? 'cancelled' : t.state === 'refused' ? 'refused' : t.state === 'failed' ? 'failed' : 'queued'
}
const usageKnown = (a: AttemptRecord): boolean => a.usageEvents > 0

/** Which of the five gate rows a configured command gate belongs to, by its name or command. */
export const gateFamily = (name: string, command = ''): Exclude<GateName, 'OTHER'> | null => {
  // the gate's own name decides first; its command only when the name says nothing
  const TYPE = /\b(?:type|types|typecheck|tsc|mypy|pyright|flow)\b/i
  const BUILD = /\b(?:build|compile|bundle|webpack|vite\s+build|cargo\s+build|make)\b/i
  const TEST = /\b(?:test|tests|spec|jest|vitest|mocha|pytest|unit|e2e|check)\b/i
  for (const s of [name, command]) {
    if (TYPE.test(s) && !/\btest\b/i.test(name)) return 'TYPE'
    if (BUILD.test(s)) return 'BUILD'
    if (TEST.test(s)) return 'TEST'
  }
  return null
}

const short = (s: string, n: number): string => s.length <= n ? s : `${s.slice(0, n - 1)}…`

export const buildView = (i: ViewInput): View => {
  const { header: h, live: lv, records, config, resolutions, now } = i
  const roles = config.profiles[config.profile].roles
  const status = statusOf(lv, now)
  const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt)

  // ----- attempts, newest last ---------------------------------------------------------------
  const attempts: AttemptView[] = []
  for (const t of sorted) for (const a of t.attempts) {
    const started = Date.parse(a.startedAt) || now; const ended = a.endedAt ? Date.parse(a.endedAt) : null
    attempts.push({
      id: a.id, task: t.spec.id, n: a.n, title: sanitize(t.spec.title), kind: t.spec.kind, risk: a.route?.effectiveRisk ?? t.spec.risk, role: a.role, model: a.model, provider: a.provider,
      state: attemptState(t, a), phase: a.phase, reasoning: reasoningOf(a, roles[a.role]?.reasoning ?? '?'), rules: a.route?.rules ?? [], signals: a.route?.signals ?? [],
      tokensIn: usageKnown(a) ? a.usage.inputTokens : null, tokensOut: usageKnown(a) ? a.usage.outputTokens : null, cacheRead: usageKnown(a) ? a.usage.cacheReadTokens : null,
      // no usage and no model turn yet is "not reported", not "unmetered": a turn that used tokens without a usage event is
      reasoningTokens: usageKnown(a) ? a.usage.reasoningTokens ?? null : null,
      usd: !usageKnown(a) && (a.iterations ?? 0) === 0 ? null : a.charge.usd, basis: !usageKnown(a) && (a.iterations ?? 0) === 0 ? 'none' : a.charge.basis,
      elapsedMs: (ended ?? now) - started, startedAt: started, endedAt: ended, tools: a.toolCalls ?? {}, iterations: a.iterations ?? 0, changes: a.changes ?? [],
      gates: a.gates ?? [], failure: a.failure, failureDetail: a.failureDetail === null ? null : sanitize(a.failureDetail), commit: a.commit, integrated: !!(a.commit && t.integratedHead && a === t.attempts.at(-1) && t.state === 'completed'),
      pid: a.identity?.initPid ?? null, census: a.census?.detail ?? null, worktree: a.worktree === null ? null : sanitize(a.worktree), owned: t.spec.owned, mode: t.spec.mode, activity: i.activity.get(a.id) ?? null,
      verification: t.verification, estimateUsd: a.estimateUsd, wire: a.wire ? sanitize(a.wire.detail) : null, prompt: sanitize(t.spec.prompt.slice(0, 2000)),
    })
  }

  // ----- the five roles --------------------------------------------------------------------------
  const queuedBy = new Map<Role, TaskRecord[]>()
  for (const t of sorted) if (t.state === 'queued' && !t.attempts.some(live)) {
    // the role a queued task will get: its last attempt's, its pinned escalation, or the default for its kind
    const role = i.predictRole?.(t) ?? t.escalateTo ?? t.attempts.at(-1)?.role ?? (t.spec.kind === 'architecture' || t.spec.kind === 'review' ? 'commander' : t.spec.kind === 'frontend' ? 'frontend' : t.spec.kind === 'scout' || t.spec.kind === 'docs' ? 'utility' : 'coder')
    queuedBy.set(role, [...(queuedBy.get(role) ?? []), t])
  }
  const orchestrating = (() => { for (const t of sorted) { const a = t.attempts.find(live); if (a && a.role === 'commander' && isPlanTask(t.spec.id)) return { task: t.spec.id, attempt: a.n } } return null })()
  const roleViews: RoleView[] = ROLES.map(r => {
    const spec = roles[r]; const res = resolutions[r]
    const mine = attempts.filter(a => a.role === r)
    const running = mine.filter(a => a.state === 'running' || a.state === 'blocked')
    const cur = running[0] ?? null; const last = mine.at(-1) ?? null
    const rec = (id: string): TaskRecord | undefined => sorted.find(t => t.spec.id === id)
    const queued = queuedBy.get(r) ?? []
    const retrying = queued.filter(t => (t.retryAt ?? 0) > now)
    const waiting = queued.filter(t => t.reason?.startsWith('waiting: '))
    const verifying = mine.find(a => a.state === 'verifying') ?? null
    let state: AgentState = 'idle'; let stateText = 'idle'
    if (!res.ok) { state = 'unavailable'; stateText = 'UNAVAILABLE' }
    else if (running.some(a => a.state === 'blocked')) { state = 'blocked'; stateText = 'BLOCKED' }
    else if (cur) { state = 'running'; stateText = running.length > 1 ? `RUNNING ×${running.length}` : 'RUNNING' }
    else if (verifying) { state = 'verifying'; stateText = 'VERIFYING' }
    else if (retrying.length) { state = 'retrying'; stateText = `RETRY ${Math.max(0, Math.ceil(((retrying[0].retryAt ?? now) - now) / 1000))}s` }
    else if (waiting.length) { state = 'waiting'; stateText = 'WAITING' }
    else if (queued.length) { state = 'queued'; stateText = queued.length > 1 ? `QUEUED ×${queued.length}` : 'QUEUED' }
    else if (last) { state = last.state === 'completed' ? 'completed' : last.state === 'cancelled' ? 'cancelled' : last.state === 'refused' ? 'refused' : last.state === 'running' ? 'running' : 'failed'; stateText = state === 'completed' ? 'DONE' : state.toUpperCase() }
    const focus = cur ?? verifying ?? last
    const act = cur ? i.activity.get(cur.id) : null
    const activity = !res.ok ? `unresolved: ${short(res.reason ?? 'model not in catalog', 80)}`
      : cur ? (act?.last ? act.last : cur.phase === 'reserved' || cur.phase === 'dispatching' ? 'starting sandbox' : cur.state === 'blocked' ? 'held: processes not accounted for' : 'thinking')
      : verifying ? 'supervisor running gates'
      : retrying.length ? `backing off · ${short(retrying[0].attempts.at(-1)?.failure ?? 'transient', 30)}`
      : waiting.length ? short((waiting[0].reason ?? '').replace(/^waiting: /, ''), 90)
      : queued.length ? `next ${queued[0].spec.id}`
      : last ? (last.state === 'completed' ? (last.integrated ? `integrated ${last.commit?.slice(0, 8)} · ${last.changes.length} file(s)` : isPlanTask(last.task) ? `planned ${rec(last.task)?.children.length ?? 0} task(s)` : last.mode === 'read' ? 'answered (read-only)' : 'no changes') : last.failure ? `${last.failure}${last.failureDetail ? `: ${short(last.failureDetail, 60)}` : ''}` : last.state) : ROLE_DUTY[r]
    // tokens and cost for the focused attempt; a running attempt without usage is unknown, not zero
    const t0 = focus ? rec(focus.task) : undefined
    const escalated = focus && t0 && t0.attempts.length > 1 ? t0.attempts[t0.attempts.length - 2]?.role ?? null : null
    return {
      role: r, label: ROLE_LABEL[r], duty: ROLE_DUTY[r], name: res.ok ? res.info.name ?? spec.model : spec.model, model: spec.model, provider: spec.provider, isDefault: r === 'coder',
      reasoning: reasoningOf(focus ? (rec(focus.task)?.attempts.find(x => x.id === focus.id) ?? null) : null, spec.reasoning),
      state, stateText, task: focus?.task ?? (queued[0]?.spec.id ?? null), activity,
      tokensIn: focus?.tokensIn ?? null, tokensOut: focus?.tokensOut ?? null, cacheRead: focus?.cacheRead ?? null, usd: focus ? focus.usd : null, basis: focus && focus.basis !== 'none' ? focus.basis as RoleView['basis'] : null,
      elapsedMs: focus ? focus.elapsedMs : null, attempts: mine.length, queued: queued.length, orchestrating: r === 'commander' && orchestrating !== null,
      escalatedFrom: escalated && escalated !== r ? escalated : null, unresolved: res.ok ? null : res.reason ?? 'unresolved',
    }
  })

  // ----- the five gates: evidence first, never a pass that was not observed ---------------------
  const scope = i.turn ? sorted.filter(t => t.spec.id === i.turn || t.spec.id.startsWith(`${i.turn}.`)) : sorted
  const latest = scope.map(t => ({ t, a: t.attempts.at(-1) })).filter((x): x is { t: TaskRecord; a: AttemptRecord } => !!x.a)
  const fresh = lv.finalGates.length > 0 && (lv.finalGatesHead ?? null) === lv.integration.head
  const verifyingNow = scope.some(t => t.state === 'verifying') || lv.state === 'finalizing'
  const tainted = latest.filter(x => x.a.gateTaint?.length && x.t.state === 'completed')
  // a configured gate that belongs to none of the five families (lint, format, …) gets an OTHER row
  const famOf = (g: GateResult): GateName => g.kind === 'git' ? 'GIT' : g.kind === 'security' ? 'SECURITY' : gateFamily(g.name, g.command) ?? 'OTHER'
  const hasOther = h.gates.some(g => gateFamily(g.name, g.command) === null) || latest.some(x => (x.a.gates ?? []).some(g => famOf(g) === 'OTHER'))
  const gateViews: GateView[] = [...GATE_NAMES, ...(hasOther ? ['OTHER' as const] : [])].map(name => {
    const runs: GateRun[] = []
    const clean = (g: GateResult): GateResult => ({ ...g, evidence: sanitize(g.evidence), ...(g.command ? { command: sanitize(g.command) } : {}) })
    for (const { t, a } of latest) for (const g of a.gates ?? []) if (famOf(g) === name) runs.push({ gate: clean(g), where: `${t.spec.id}#${a.n}`, at: a.endedAt ? Date.parse(a.endedAt) : null })
    if (fresh) for (const g of lv.finalGates) if (famOf(g) === name) runs.push({ gate: clean(g), where: `branch @${lv.integration.head.slice(0, 8)}`, at: null })
    const configured = name === 'GIT' || name === 'SECURITY' || h.gates.some(g => (gateFamily(g.name, g.command) ?? 'OTHER') === name)
    const failedRun = runs.find(r => r.gate.state !== 'pass')
    const branch = runs.filter(r => r.where.startsWith('branch'))
    // gate output is test-runner text: its colours and cursor codes are removed before display
    const evidence = runs.slice(-6).map(r => sanitize(`${r.where}: ${r.gate.name} ${r.gate.state}${r.gate.exitCode != null ? ` (exit ${r.gate.exitCode})` : ''}${r.gate.command ? ` · ${r.gate.command}` : ''}${r.gate.outputSha256 ? ` · out ${r.gate.outputSha256.slice(0, 10)}` : ''} · ${r.gate.evidence.replace(/\s+/g, ' ').slice(0, 160)}`))
    let state: GateState; let summary: string
    if (!configured) { state = 'skipped'; summary = 'no gate configured (--gate name=cmd)' }
    else if (failedRun) { state = 'fail'; summary = sanitize(`${failedRun.where}: ${failedRun.gate.name} ${failedRun.gate.state}${failedRun.gate.exitCode != null ? ` exit ${failedRun.gate.exitCode}` : ''}`) }
    else if ((name === 'TEST' || name === 'TYPE' || name === 'BUILD') && tainted.length && runs.length) { state = 'unverifiable'; summary = `the change edits its own gate definition (${tainted.flatMap(x => x.a.gateTaint ?? []).slice(0, 2).join(', ')})` }
    else if (verifyingNow && !branch.length) { state = 'pending'; summary = lv.state === 'finalizing' ? 'running on the integrated branch' : 'running for a task' }
    else if (runs.length) { state = 'pass'; summary = branch.length ? `${branch.at(-1)?.gate.name} pass on branch @${lv.integration.head.slice(0, 8)}` : `${runs.length} run(s) pass · ${runs.at(-1)?.where}` }
    else if (lv.finalGates.length && !fresh && (name === 'TEST' || name === 'TYPE' || name === 'BUILD')) { state = 'pending'; summary = 'branch moved since the last branch run' }
    else { state = 'unset'; summary = scope.length ? 'not run for this work (read-only or nothing changed)' : 'nothing run yet' }
    return { name, state, summary, evidence, runs }
  })

  // ----- costs ------------------------------------------------------------------------------------
  const byModel = new Map<string, CostRow>(); const byTask: CostRow[] = []
  // an attempt counts as known only when its cost was reported or estimated from real usage
  const add = (r: CostRow, a: AttemptRecord): void => {
    r.attempts++
    if (a.charge.usd !== null && (usageKnown(a) || a.charge.basis !== 'unmetered')) { r.known++; r.usd += a.charge.usd }
    if (usageKnown(a)) { r.tokensIn += a.usage.inputTokens; r.tokensOut += a.usage.outputTokens; r.cacheRead += a.usage.cacheReadTokens }
    r.estimated ||= a.charge.basis === 'estimate'; if (a.charge.basis === 'unmetered' && (a.usageEvents > 0 || a.iterations > 0)) r.unmetered++
  }
  for (const t of sorted) {
    const row: CostRow = { key: t.spec.id, role: t.attempts.at(-1)?.role ?? null, model: [...new Set(t.attempts.map(a => a.model))].join(', ') || '—', attempts: 0, known: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, usd: 0, estimated: false, unmetered: 0 }
    for (const a of t.attempts) {
      const k = `${a.role}|${a.model}`
      const m = byModel.get(k) ?? { key: k, role: a.role, model: a.model, attempts: 0, known: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, usd: 0, estimated: false, unmetered: 0 }
      add(m, a); byModel.set(k, m); add(row, a)
    }
    if (t.attempts.length) byTask.push(row)
  }
  const s = lv.session
  // the reported/estimated split is exact only while every task of the session is in view
  const total = lv.counters.created
  const complete = sorted.length >= total
  const estimated = attempts.filter(a => a.basis === 'estimate').reduce((x, a) => x + (a.usd ?? 0), 0)
  const cost: CostView = {
    budget: config.budgets.sessionUsd, spent: s.spentUsd, committed: i.committedUsd, remaining: Math.max(0, config.budgets.sessionUsd - i.committedUsd), tokens: s.tokens,
    reported: complete ? Math.max(0, s.spentUsd - estimated) : null, estimated: complete ? estimated : null, estimatedAttempts: (s.estimatedTasks ?? []).length,
    unmetered: s.unmetered, unmeteredTasks: s.unmeteredTasks ?? [], capReached: s.capReached, alertsFired: s.alertsFired ?? [],
    byModel: [...byModel.values()].sort((a, b) => b.usd - a.usd), byTask: byTask.reverse(), coverage: { shown: sorted.length, total },
  }

  // ----- the mission ------------------------------------------------------------------------------
  // alerts, problems and verdict reasons quote model and tool output: sanitized like everything else shown
  const alerts = lv.alerts.slice(-50).map(sanitize)
  const guard = [...alerts].reverse().find(a => /HELD|refused|policy|budget|unmetered|tampered|outside|not allowed|gates are defined|mismatch|breaker/i.test(a)) ?? null
  const turnTasks = i.turn ? sorted.filter(t => t.spec.id === i.turn || t.spec.id.startsWith(`${i.turn}.`)) : []
  return {
    mission: {
      id: h.id, profile: h.profile, strict: h.strict, clineVersion: h.clineVersion, repo: sanitize(h.repoRoot), branch: sanitize(lv.integration.branch), head: lv.integration.head, base: lv.integration.base,
      status, verdict: lv.verdict ? { ...lv.verdict, reasons: lv.verdict.reasons.map(sanitize) } : null, problems: (lv.problems ?? []).map(sanitize), alerts, guard, claims: i.claims, counters: lv.counters, orchestrating, turn: i.turn,
      milestones: turnTasks.map(t => ({ id: t.spec.id, state: taskState(t, now), title: sanitize(t.spec.title) })), finalGatesFresh: fresh, startedAt: Date.parse(h.createdAt) || now,
    },
    roles: roleViews, attempts, gates: gateViews, cost, now,
  }
}
