// The agent inspector (v0.6.0): `/cockpit agents` and `/cockpit agents <task>`. A read-only view of what Cockpit already
// holds: the swarm's tasks and the Run Ledger's agents. Nothing here keeps state, schedules or decides anything.
//
// Authority. Why a queued task cannot start is asked of the swarm's own admission rule (`admissionReason`), whose answer is
// worded here and nowhere re-derived; there is no second scheduler. A suggestion is information: it names what a person or the
// commander could do, never does it, and is only offered when the recorded state supports it. A security hold, a failed
// verification and a release NO-GO are never cleared from here.
//
// Honesty. A figure is shown only when the host reported it. An effort level Cockpit requested is not an effort level the
// engine applied; a result an agent reported is not a result anyone verified; a task nobody has seen move has no "last activity".
// What is unknown says so.

import { admissionReason, limitsOf, occupancyOf, routingOf } from './swarm'
import { shortenPaths, shortResource } from './paths'
import type { LedgerAgent, ModelTier, RouteCounts, Swarm, SwarmTask } from '../types'

export { shortenPaths, shortResource } from './paths'

const UNKNOWN = 'unknown'
const known = (v: unknown): v is string => typeof v === 'string' && v !== UNKNOWN && v !== ''
const clip = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, Math.max(0, n - 1))}…`)
const one = (text: string): string => text.replace(/\s+/g, ' ').trim()
/** How long ago, in the coarsest honest unit; null when the clock is behind the moment. */
export const ageOf = (ms: number): string | null => (ms < 0 ? null : ms < 60_000 ? 'just now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ago` : ms < 172_800_000 ? `${Math.floor(ms / 3_600_000)}h ago` : `${Math.floor(ms / 86_400_000)}d ago`)

const TERMINAL: readonly string[] = ['completed', 'failed', 'cancelled']
const isLive = (t: SwarmTask): boolean => t.endedAt === null && !TERMINAL.includes(t.state) && (t.state === 'reserved' || t.state === 'running' || t.agentId !== null || (t.state === 'stalled' && t.startedAt !== null))

const ownsText = (t: SwarmTask, max: number): string => {
  const list = t.owned.map(shortResource)

  return `${t.mode === 'write' ? 'write' : 'read'} ${list.slice(0, max).join(', ')}${list.length > max ? ` +${list.length - max}` : ''}`
}

export type BlockerKind = 'dependency' | 'capacity' | 'ownership' | 'commander' | 'architect' | 'awaiting-spawn' | 'stalled' | 'escalation' | 'cancelling' | 'failed' | 'cancelled' | 'unverified' | 'admissible' | 'unknown'
export type Blocker = {
  kind: BlockerKind
  /** Why it is not progressing, from recorded state only. */
  why: string
  /** Information only: what could move it. Absent when the recorded state supports no suggestion. Nothing is done by it. */
  suggestion?: string
}

/**
 * Why this task is not progressing, or null when it is progressing (or finished and settled). For a task waiting for admission
 * the answer is the swarm's own `admissionReason`, parsed back into words; if that wording ever changes, the tests that pin each
 * form fail rather than this explanation quietly going wrong.
 */
export const blockerOf = (s: Swarm, t: SwarmTask, now: number): Blocker | null => {
  if (t.cancellationRequested && isLive(t)) return { kind: 'cancelling', why: 'Cancellation was requested; ownership is held until the host confirms the agent stopped.', suggestion: 'Wait for the host to report the stop. Nothing here cancels or releases anything.' }
  if (t.state === 'queued' || t.state === 'blocked') {
    const reason = admissionReason(s, t.id)
    if (reason === null) return { kind: 'admissible', why: 'Nothing recorded stops it: it is admissible now and has not been admitted.', suggestion: 'The commander admits it; Cockpit does not start work by itself.' }
    const dep = /^dependency (.+): (\S+)$/.exec(reason)
    if (dep !== null) {
      const state = dep[2] as string
      const failed = state === 'failed' || state === 'cancelled'
      return {
        kind: 'dependency', why: `Waiting for task ${dep[1]} (${state}).`,
        ...(failed ? { suggestion: `Task ${dep[1]} ended ${state} and will not complete this one's dependency; the commander decides whether to replace the task or drop the dependency.` } : state === 'unknown' ? { suggestion: `Task ${dep[1]} is not in the swarm; the dependency cannot be met until it is assigned.` } : { suggestion: `Wait for ${dep[1]}; /cockpit agents ${dep[1]} shows where it stands.` }),
      }
    }
    const own = /^ownership conflict: (.+)$/.exec(reason)
    if (own !== null) {
      const other = s.tasks.find(x => x.id === own[1])
      const overlap = other === undefined ? [] : t.owned.filter(a => other.owned.some(b => a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))).map(shortResource)
      return { kind: 'ownership', why: `Resource ownership conflict with task ${own[1]}${overlap.length > 0 ? ` over ${overlap.slice(0, 3).join(', ')}` : ''}; a write claim cannot overlap another live claim.`, suggestion: `Wait for ${own[1]} to finish, or the commander narrows one of the two claims. Cockpit changes neither.` }
    }
    if (reason === 'resource budget') {
      const lim = limitsOf(s)
      const used = occupancyOf(s)
      const pool = t.tier === 'SONNET' ? `SONNET ${used.sonnet} of ${lim.sonnet}` : t.tier === 'HAIKU' ? `HAIKU ${used.haiku} of ${lim.haiku}` : `OPUS ${used.opus} of ${lim.opus}`
      // name the bound that holds it, counted as admission counts it
      const slots = t.tier === 'OPUS' ? used.total : used.counted
      const why = slots >= lim.total ? `Agent capacity exhausted: all ${lim.total} slots in use (${pool}).` : `Agent capacity exhausted: the ${t.tier} pool is full (${pool}; ${slots} of ${lim.total} slots in use).`

      return { kind: 'capacity', why, suggestion: 'Wait for a running task to finish. The limits come from the Cockpit settings (maxSubagents, maxSonnet, maxHaiku); only the person changes them.' }
    }
    if (reason === 'commander occupied') return { kind: 'commander', why: 'The commander is occupied: OPUS work runs in the main loop, which another task holds.', suggestion: 'It starts when the commander finishes the task it holds.' }
    if (reason === 'architect occupied') return { kind: 'architect', why: 'An architect consultation is already running; only the configured number run at once.', suggestion: 'Wait for the running consultation to return.' }
    return { kind: 'unknown', why: `The swarm reports: ${clip(one(reason), 120)}.` }
  }
  if (t.state === 'reserved') return { kind: 'awaiting-spawn', why: 'A slot and its ownership are reserved; the host has not yet reported the agent.', suggestion: 'If no agent ever appears, the commander releases the reservation; Cockpit does not.' }
  if (t.state === 'stalled') {
    const quiet = ageOf(now - t.lastActivityAt)
    return { kind: 'stalled', why: `No activity observed${quiet === null ? '' : ` since ${quiet}`} (stall threshold ${Math.round(s.config.stallMs / 60_000)} min); ownership is retained until the host confirms the agent stopped or recovers.`, suggestion: 'A stalled mark is not proof the agent stopped writing. Wait for the host, or ask the commander to check on it.' }
  }
  if (t.state === 'escalated') {
    const to = t.escalation?.to ?? 'the commander'
    return { kind: 'escalation', why: `Escalated to ${to}: the agent stopped and its question is unresolved.`, suggestion: 'The commander resolves it with a conclusion and evidence (resolveEscalation); nothing here resolves it. Until then the task is not completed.' }
  }
  if (t.state === 'failed') return { kind: 'failed', why: `The task failed${t.result?.conclusion ? `: ${clip(shortenPaths(one(t.result.conclusion)), 100)}` : ' (no reason was reported)'}.` }
  if (t.state === 'cancelled') return { kind: 'cancelled', why: 'The task was cancelled.' }
  if (t.state === 'completed' && t.verification !== 'pass') {
    const word = t.verification === 'fail' ? 'verification FAILED' : t.verification === 'unknown' ? 'verification is UNKNOWN' : 'verification is pending'
    return { kind: 'unverified', why: `Completed and reported; ${word}. A report is not a verified result.`, suggestion: t.verification === 'fail' ? 'A failed verification stays failed until the commander records a new one on new evidence.' : 'The commander verifies it against the evidence; Cockpit does not.' }
  }

  return null
}

const TIER_ORDER: Record<string, number> = { OPUS: 0, SONNET: 1, HAIKU: 2 }
const STATE_RANK: Record<string, number> = { stalled: 0, escalated: 1, blocked: 2, queued: 3, reserved: 4, running: 5, completed: 6, failed: 7, cancelled: 8 }
const byAttention = (a: SwarmTask, b: SwarmTask): number => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || a.createdAt - b.createdAt

const effortText = (t: SwarmTask, a: LedgerAgent | undefined): string => {
  const parts = [`requested ${t.requestedEffort}`]
  parts.push(t.launchEffort === undefined || t.launchEffort === null ? 'launch: none set on the call' : `launch ${t.launchEffort}`)
  // a level Cockpit itself set on requests is not one the engine confirmed: it is named for what it is
  parts.push(t.appliedEffort === null ? 'applied: not observed' : t.launchEffort !== undefined && t.launchEffort !== null ? (t.appliedEffort === t.launchEffort ? `applied ${t.appliedEffort} (the launch level)` : `applied ${t.appliedEffort}`) : `set on requests by Cockpit ${t.appliedEffort} (not reported back by the engine)`)
  if (a !== undefined) parts.push(known(a.effectiveEffort) ? `engine reported ${a.effectiveEffort}` : a.effortSource === 'engine' && known(a.effort) ? `engine reported ${a.effort}` : 'engine: no report')

  return parts.join(' · ')
}
const modelText = (t: SwarmTask, a: LedgerAgent | undefined): string => {
  if (a === undefined) return `${t.tier} assigned; model not observed (no agent bound)`
  const asked = known(a.requestedModel) ? ` (asked for ${a.requestedModel})` : ''

  return known(a.model) ? `${a.model}${asked} · tier ${t.tier}` : `not observed${asked} · tier ${t.tier}`
}
const outcomeText = (t: SwarmTask): string => {
  if (t.result === null) return t.state === 'completed' ? 'completed without a report' : 'none yet'
  const delivery = t.resultDelivery === 'host_accepted' ? 'report accepted by the host' : t.resultDelivery === 'answer_observed' ? 'answer observed' : t.resultDelivery === 'unavailable' ? 'report unavailable' : 'reported by the agent'
  // The commander's judgment is a report: it ran no check here and attests no security state.
  const verified = t.verification === 'pass' ? 'commander report PASS · SELF_REPORTED_UNCHECKED' : t.verification === 'fail' ? 'commander report FAILED · SELF_REPORTED_UNCHECKED' : t.verification === 'unknown' ? 'commander report UNKNOWN · SELF_REPORTED_UNCHECKED' : 'NOT verified (pending)'

  return `${delivery}; ${verified}`
}
const activityText = (t: SwarmTask, now: number): string => {
  if (t.state === 'queued' || t.state === 'blocked') return 'none: not started'
  if (TERMINAL.includes(t.state) || t.state === 'escalated') {
    const ended = t.endedAt === null ? null : ageOf(now - t.endedAt)

    return t.endedAt === null ? 'none recorded' : ended === null ? 'ended (time not comparable)' : `ended ${ended}`
  }
  const since = t.startedAt ?? t.createdAt
  if (t.lastActivityAt <= since) return 'none observed since it started'
  const age = ageOf(now - t.lastActivityAt)

  return age === null ? 'observed (time not comparable)' : `last observed ${age}`
}
/** One tier's funnel in the widest wording that fits the width as it really is, so no figure is cut while a shorter form would keep it. The six figures are six different facts and are never merged. */
const routeLine = (tier: ModelTier, c: RouteCounts, columns: number): string => {
  const forms = [
    `ROUTE ${tier} · suggested ${c.suggested} · requested ${c.requested} · admitted ${c.admitted} · spawned ${c.spawned} · completed ${c.completed} · verified ${c.verified}`,
    `ROUTE ${tier} · sug ${c.suggested} · req ${c.requested} · adm ${c.admitted} · spawn ${c.spawned} · done ${c.completed} · ver ${c.verified}`,
    `${tier} sug${c.suggested} req${c.requested} adm${c.admitted} spn${c.spawned} done${c.completed} ver${c.verified}`,
    `${tier[0]} s${c.suggested} r${c.requested} a${c.admitted} p${c.spawned} d${c.completed} v${c.verified}`,
  ]

  return forms.find(form => form.length <= columns) ?? clip(forms[forms.length - 1] as string, columns)
}
const ROUTE_ORDER: readonly ModelTier[] = ['HAIKU', 'SONNET', 'OPUS']
/** The delegation funnel, one line per tier that has anything to show, then what differs from the suggestion. */
const routeLines = (s: Swarm, columns: number): string[] => {
  const { tiers, differing, unrecorded } = routingOf(s)
  const lines = ROUTE_ORDER.filter(tier => tiers[tier].requested > 0 || tiers[tier].suggested > 0).map(tier => routeLine(tier, tiers[tier], columns))
  if (differing > 0) lines.push(clip(`  ${differing} assignment${differing === 1 ? ' differs' : 's differ'} from the route's suggestion; the commander's tier stands`, columns))
  if (unrecorded > 0) lines.push(clip(`  ${unrecorded} task${unrecorded === 1 ? ' carries' : 's carry'} no suggestion (assigned before v0.6.1)`, columns))

  return lines
}
const routeText = (t: SwarmTask): string =>
  t.suggestedTier === undefined ? 'no suggestion recorded (assigned before v0.6.1)'
    : t.suggestedTier === t.tier ? `${t.tier}, as the route suggested (${t.routeReason ?? 'no reason recorded'})`
      : `requested ${t.tier}; the route suggested ${t.suggestedTier} (${t.routeReason ?? 'no reason recorded'}). The commander's tier stands`
const depText = (s: Swarm, t: SwarmTask): string => t.dependencies.map(d => `${d} ${s.tasks.find(x => x.id === d)?.state ?? 'unknown'}`).join(' · ')

/**
 * The HUD's one line about the swarm, and null when nothing in it needs anyone: tasks that are blocked (admission refused
 * them: a dependency, a full pool or an ownership conflict), quiet (the swarm's `stalled` mark: no activity observed for
 * the stall threshold, which is not proof an agent stopped) or escalated (the agent stopped with an unresolved question).
 * A queued task is assigned and not yet tried: it is not a problem and is not counted. Every figure is recorded state,
 * read as it is; nothing is timed or inferred here. The widest form that fits is used, and the states stay apart until
 * only a total fits.
 */
export const swarmHint = (s: Swarm, columns: number): string | null => {
  const count = (state: string): number => s.tasks.filter(t => t.state === state).length
  const blocked = count('blocked')
  const quiet = count('stalled')
  const escalated = count('escalated')
  const total = blocked + quiet + escalated
  if (total === 0) return null
  // rounded down: a task marked at 90 seconds has been quiet for at least one minute, not two
  const threshold = s.config.stallMs >= 60_000 ? `${Math.floor(s.config.stallMs / 60_000)}m+` : `${Math.max(1, Math.floor(s.config.stallMs / 1000))}s+`
  const parts = (b: string, q: string, e: string): string => [blocked > 0 ? `${blocked} ${b}` : '', quiet > 0 ? `${quiet} ${q}` : '', escalated > 0 ? `${escalated} ${e}` : ''].filter(p => p !== '').join(' · ')
  const where = ' · /cockpit agents'
  const forms = [
    `SWARM: ${parts('BLOCKED', `QUIET ${threshold}`, 'ESCALATED')}${where}`,
    `SWARM: ${parts('BLOCKED', 'QUIET', 'ESCALATED')}${where}`,
    `SWARM: ${parts('BLK', 'QUIET', 'ESC')}${where}`,
    `SWARM: ${total} ATTN${where}`,
    `SWARM: ${total} ATTN`,
  ]

  return forms.find(form => form.length <= columns) ?? clip(forms[forms.length - 1] as string, Math.max(1, columns))
}

export type AgentsView = { swarm: Swarm; agents: readonly LedgerAgent[]; now: number; columns: number }

const MAX_LISTED = 12
const MAX_UNTRACKED = 6
/** `/cockpit agents`: the swarm at a glance, the tasks that need attention first, and the host agents Cockpit did not assign. */
export const agentsText = (v: AgentsView): string => {
  const { swarm: s, now, columns } = v
  const lim = limitsOf(s)
  const used = occupancyOf(s)
  const count = (st: string): number => s.tasks.filter(t => t.state === st).length
  const waiting = count('queued') + count('blocked')
  const head = columns >= 90
    ? `AGENTS · wave ${s.wave} · ${used.total} active · ${waiting} waiting · ${count('stalled')} stalled · ${count('escalated')} escalated · ${count('completed')} completed of ${s.tasks.length}`
    // a stalled mark is silence, not a stopped agent, so it is never merged into a word that says more; a zero is left out to keep the done count and the wave in view
    : `AGENTS · ${used.total} active · ${waiting} waiting${count('stalled') > 0 ? ` · ${count('stalled')} stalled` : ''}${count('escalated') > 0 ? ` · ${count('escalated')} esc` : ''} · ${count('completed')}/${s.tasks.length} done · ${s.wave}`
  const lines = [clip(head, columns)]
  lines.push(clip(`CAPACITY · ${used.counted} of ${lim.total} slots · SONNET ${used.sonnet}/${lim.sonnet} · HAIKU ${used.haiku}/${lim.haiku}${lim.opus > 0 ? ` · OPUS ${used.opus}/${lim.opus}` : ' · OPUS in the main loop'}${s.conflicts > 0 ? ` · ${s.conflicts} ownership conflict${s.conflicts === 1 ? '' : 's'} recorded` : ''}`, columns))
  if (s.tasks.length === 0) lines.push('No tasks assigned in this session. The commander assigns work with the swarm tool; Cockpit invents none.')
  lines.push(...routeLines(s, columns))
  const sorted = [...s.tasks].sort(byAttention)
  for (const t of sorted.slice(0, MAX_LISTED)) {
    const blocker = blockerOf(s, t, now)
    const wide = columns >= 80
    const head = `${t.id} ${t.tier} ${t.role} · ${t.state}${t.cancellationRequested && isLive(t) ? ' (cancelling)' : ''}`
    const tail = wide ? ` · ${t.agentId === null ? 'no agent' : `agent ${t.agentId.slice(0, 8)}`} · ${activityText(t, now)}` : ''
    lines.push(clip(`  ${head}${tail}`, columns))
    if (blocker !== null && blocker.kind !== 'unverified') lines.push(clip(`    ↳ ${blocker.why}`, columns))
    else if (blocker !== null && wide) lines.push(clip(`    ↳ ${outcomeText(t)}`, columns))
  }
  if (sorted.length > MAX_LISTED) lines.push(clip(`  +${sorted.length - MAX_LISTED} more (${sorted.slice(MAX_LISTED).filter(t => t.state === 'completed').length} completed); /cockpit agents <task> shows any one`, columns))
  const bound = new Set(s.tasks.map(t => t.agentId).filter((x): x is string => x !== null))
  const untracked = v.agents.filter(a => !bound.has(a.id))
  if (untracked.length > 0) {
    lines.push(clip(`HOST AGENTS NOT ASSIGNED BY COCKPIT · ${untracked.length}`, columns))
    for (const a of untracked.slice(-MAX_UNTRACKED)) lines.push(clip(`  ${a.id.slice(0, 8)} ${a.role} · ${a.status} · model ${known(a.model) ? a.model : 'not observed'}`, columns))
  }
  lines.push(clip('Read-only. /cockpit agents <task> explains one; /cockpit ready, what is left before DONE.', columns))

  return lines.join('\n')
}

/** `/cockpit agents <task>`: one task with everything recorded about it, and why it is or is not progressing. */
export const taskText = (v: AgentsView, wanted: string): string => {
  const { swarm: s, now, columns } = v
  const t = s.tasks.find(x => x.id === wanted) ?? s.tasks.find(x => x.id.toLowerCase() === wanted.toLowerCase())
  if (t === undefined) {
    const ids = s.tasks.map(x => x.id)

    return `No task "${clip(one(wanted), 40)}" in this session.${ids.length === 0 ? ' None are assigned.' : ` Known: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ` +${ids.length - 8}` : ''}.`}`
  }
  const a = v.agents.find(x => x.id === t.agentId)
  const blocker = blockerOf(s, t, now)
  const lines = [clip(`TASK ${t.id} · ${t.tier} ${t.role} · ${t.state}${t.cancellationRequested && isLive(t) ? ' (cancellation requested)' : ''}`, columns)]
  lines.push(clip(`objective: ${clip(shortenPaths(one(t.objective)), 120)}`, columns))
  lines.push(clip(`agent: ${t.agentId === null ? 'none bound' : `${t.agentId.slice(0, 8)}… · ${a === undefined ? 'not in the Ledger' : `host status ${a.status}`}`}`, columns))
  lines.push(clip(`model: ${modelText(t, a)}`, columns))
  lines.push(clip(`route: ${routeText(t)}`, columns))
  lines.push(clip(`effort: ${effortText(t, a)}`, columns))
  lines.push(clip(`wave: ${t.wave}${t.wave === s.wave ? '' : ` (the swarm is in ${s.wave})`}${t.parentTask === null ? '' : ` · parent ${t.parentTask}`}`, columns))
  lines.push(clip(`owns: ${ownsText(t, 4)}`, columns))
  lines.push(clip(`depends on: ${t.dependencies.length === 0 ? 'nothing' : depText(s, t)}`, columns))
  const children = s.tasks.filter(x => x.parentTask === t.id)
  if (children.length > 0) lines.push(clip(`children: ${children.map(x => `${x.id} ${x.state}`).join(' · ')}`, columns))
  lines.push(clip(`activity: ${activityText(t, now)}`, columns))
  lines.push(clip(`outcome: ${outcomeText(t)}`, columns))
  if (t.escalation !== null) lines.push(clip(`escalation: to ${t.escalation.to}${t.escalation.effort ? ` (effort ${t.escalation.effort})` : ''} · ${clip(shortenPaths(one(t.escalation.question)), 100)}`, columns))
  if (t.effortEscalation !== null) lines.push(clip(`effort raised: ${t.effortEscalation.from} → ${t.effortEscalation.to}`, columns))
  if (t.result !== null && t.result.unresolved.length > 0) lines.push(clip(`unresolved by the agent: ${t.result.unresolved.length}`, columns))
  lines.push(blocker === null ? (t.state === 'running' || t.state === 'completed' ? 'blocker: none recorded' : 'blocker: none') : clip(`blocker (${blocker.kind}): ${blocker.why}`, Math.max(columns, 20)))
  if (blocker?.suggestion !== undefined) lines.push(clip(`suggestion (information only; nothing was changed): ${blocker.suggestion}`, Math.max(columns, 20)))

  return lines.join('\n')
}
