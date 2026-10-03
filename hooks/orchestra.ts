// Orchestration: who is doing the work, and the rules delegation runs under.
//
// The main session plans, delegates, integrates and verifies; subagents do
// isolated work on Sonnet unless a call names another model; NobodyWho sits
// around tool output locally. There is no advisor and nothing here calls a
// model: every decision in this module is arithmetic over state the engine
// already reported.
//
//   - LIMIT. At most `limit` subagents run at once (3 unless configured).
//   - DEFAULT MODEL. A spawn that names no model runs on Sonnet rather than
//     inheriting the parent's.
//   - REVIEWER. A reviewer is admitted for a failure that repeated, for the
//     final check of a substantial task, or when the person asked for a review,
//     one at a time. It is never started by the plugin and never per tool call.
//
// The drawing half turns real spawns, real tool calls and real completions into
// the orchestration rows. A role is read off the agent type the engine spawned,
// a model off the id the engine resolved, an activity off the agent's own tool
// call. An agent that was never spawned has no row.

import type { Activity, ActivityKind, AgentRole, AgentStrip, Meter, Orchestra, Task } from '../types'
import { cellsOf, fitText } from './pixels'
import { FABLE_RULE } from './policy'
import { STAGE_LABEL } from './theme'
import { duration } from './view'
import type { Row } from './view'

export type { AgentRole, Orchestra } from '../types'

export const DEFAULT_SUBAGENT_MODEL = 'sonnet'
export const DEFAULT_LIMIT = 3
export const LIMIT_MAX = 8
/** The same failure this many times in a row is a repeated error. */
export const REVIEW_AFTER = 2
/** A task this large earns one final review. */
export const SUBSTANTIAL_MILESTONES = 5
export const SUBSTANTIAL_FILES = 5

export const EMPTY_ORCHESTRA: Orchestra = {
  spawned: 0,
  errorKey: null,
  errorStreak: 0,
  streakAt: null,
  reviewArmed: false,
  hinted: false,
  reviewedTask: null,
  reviewers: 0,
  refusedLimit: 0,
  refusedReview: 0,
}

/** The configured limit, held to a whole number the workflow can honour. */
export const limitOf = (value: unknown): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_LIMIT

  return Math.max(1, Math.min(LIMIT_MAX, n))
}

/**
 * The role a spawned agent plays, from its agent type alone: Cockpit's own
 * four, the built-ins that do the same job, and `AGENT` for everything else.
 */
export const roleOf = (subagentType: string): AgentRole => {
  const name = subagentType.toLowerCase().replace(/^.*:/, '')
  if (/review/.test(name)) return 'REVIEWER'
  if (/^(explore|explorer)$/.test(name)) return 'EXPLORER'
  if (/^(researcher|research|claude-code-guide)$/.test(name)) return 'RESEARCHER'
  if (/^(worker|implementer)$/.test(name)) return 'WORKER'

  return 'AGENT'
}

/** The model family an id belongs to, or null for one this plugin does not name. */
export const tierOf = (model: string | null | undefined): 'OPUS' | 'SONNET' | 'HAIKU' | null => {
  const id = (model ?? '').toLowerCase()
  if (id.includes('opus')) return 'OPUS'
  if (id.includes('sonnet')) return 'SONNET'
  if (id.includes('haiku')) return 'HAIKU'

  return null
}

/**
 * The model a spawn runs on: the one the call named, and Sonnet when it named
 * none. A fork always runs on its parent's model, so nothing is chosen for it.
 */
export const modelFor = (spawn: { model?: string | undefined; fork: boolean }): string | undefined => {
  if (spawn.fork) return spawn.model
  const named = (spawn.model ?? '').trim()

  return named === '' || named === 'inherit' ? DEFAULT_SUBAGENT_MODEL : spawn.model
}

/** Null when one more subagent may start, else why it may not. */
export const admitSpawn = (running: number, limit: number): string | null =>
  running < limit
    ? null
    : `SUBAGENT LIMIT / ${limit}. ${running} subagent${running === 1 ? ' is' : 's are'} already running, the most this workflow runs at once, so nothing was started. Wait for one to finish or do this part in the main session; do not split the same work across more agents.`

/**
 * One main-loop result folded into the failure streak.
 *
 * The same thing failing again lengthens the streak and, at `REVIEW_AFTER`,
 * arms one reviewer. The same thing succeeding ends it. A different failure
 * starts over, because two different errors are not one repeated error.
 */
export const noteOutcome = (o: Orchestra, key: string, failed: boolean, at: number): Orchestra => {
  if (!failed) return o.errorKey === key ? { ...o, errorKey: null, errorStreak: 0, streakAt: null, reviewArmed: false, hinted: false } : o
  if (o.errorKey !== key) return { ...o, errorKey: key, errorStreak: 1, streakAt: at, reviewArmed: false, hinted: false }
  const errorStreak = o.errorStreak + 1

  return { ...o, errorStreak, reviewArmed: o.reviewArmed || (errorStreak === REVIEW_AFTER && !o.hinted) }
}

/**
 * What the model is told, once, when a failure has repeated: recover normally
 * first, heed the local router's last decision if it made one since the streak
 * began, and that one reviewer is now permitted. Null at every other moment,
 * which is what keeps a second model off the ordinary tool call.
 */
export const reviewHint = (o: Orchestra, route: string | null): string | null => {
  if (o.hinted || o.errorKey === null || o.errorStreak < REVIEW_AFTER) return null
  const local = route === null ? '' : ` The local router's latest decision since this began reads ${route}; follow it where it applies.`

  return `Cobalt Cockpit: the same failure has now repeated ${o.errorStreak} times (${o.errorKey}). Recover normally first: read the error again and change the approach, not the retry count.${local} If an independent second context would genuinely help, one cobalt-cockpit:reviewer subagent is permitted for this failure; otherwise carry on in the main session.`
}

const ASKS_REVIEW = /\b(review|reviewer|second opinion|audit|sanity[- ]check)\b/i

export type ReviewWhy = 'repeated-error' | 'substantial' | 'asked'

/** Whether a task is large enough that an independent final review is worth a subagent. */
export const isSubstantial = (task: Task | null): boolean =>
  task !== null && task.kind === 'coding' && (task.milestones.length >= SUBSTANTIAL_MILESTONES || task.files.length >= SUBSTANTIAL_FILES)

/**
 * Whether a reviewer may start now, and on what ground.
 *
 * In order: never two at once; a repeated failure that armed one; the person's
 * own request; the one final review a substantial task gets.
 */
export const reviewVerdict = (o: Orchestra, facts: { task: Task | null; reviewerRunning: boolean }): { ok: true; why: ReviewWhy } | { ok: false; reason: string } => {
  if (facts.reviewerRunning) return { ok: false, reason: 'REVIEWER / HELD. One reviewer is already running; wait for its answer. Nothing was started.' }
  if (o.reviewArmed) return { ok: true, why: 'repeated-error' }
  if (facts.task !== null && ASKS_REVIEW.test(facts.task.lastPrompt)) return { ok: true, why: 'asked' }
  if (isSubstantial(facts.task) && o.reviewedTask !== facts.task?.id) return { ok: true, why: 'substantial' }

  return {
    ok: false,
    reason: `REVIEWER / HELD. A reviewer is for a failure that has repeated, for the one final check of a substantial task (${SUBSTANTIAL_MILESTONES}+ milestones or ${SUBSTANTIAL_FILES}+ files touched), or when the user asks for a review. None of those holds now, so nothing was started. Verify in the main session.`,
  }
}

/** The state after a reviewer was admitted on `why`: the ground is spent. */
export const reviewAdmitted = (o: Orchestra, why: ReviewWhy, taskId: number | null): Orchestra => ({
  ...o,
  reviewers: o.reviewers + 1,
  reviewArmed: why === 'repeated-error' ? false : o.reviewArmed,
  reviewedTask: why === 'substantial' ? taskId : o.reviewedTask,
})

const VERB: Partial<Record<ActivityKind, string>> = { IDLE: 'START', THINK: 'THINK', TOOL: 'TOOL' }

/** The word for what an agent is doing: its real activity while it runs, its outcome after. */
const verbOf = (a: AgentStrip): string => {
  if (a.state !== 'running') return a.tool
  if (a.kind === undefined) return a.tool === 'Starting' ? 'START' : a.tool === 'Thinking' ? 'THINK' : a.tool.toUpperCase()

  return VERB[a.kind] ?? a.kind
}

const tailOf = (a: AgentStrip, now: number): string => {
  const elapsed = duration((a.endedAt ?? now) - a.startedAt)

  return a.state === 'done' ? `✓ ${elapsed}` : a.state === 'error' ? `✗ ${elapsed}` : elapsed
}

/** Whether a strip carries what the orchestration rows need. */
export const hasRole = (a: AgentStrip): a is AgentStrip & { role: AgentRole; seq: number } => a.role !== undefined && a.seq !== undefined

/**
 * One subagent as a row of the orchestration: its number, its role, the model
 * it really runs on where there is room, what it is doing, and how long.
 *
 * `01 WORKER      EDIT        32s`
 */
export const roleStrip = (a: AgentStrip & { role: AgentRole; seq: number }, width: number, now: number): string => {
  const seq = String(a.seq % 100).padStart(2, '0')
  const tier = tierOf(a.model)
  const spec = width >= 80 && tier !== null ? `${[tier, a.effort?.toUpperCase()].filter(Boolean).join(' · ').padEnd(15)} ` : ''
  const tail = tailOf(a, now)
  const accounting = a.toolCount === undefined ? '' : ` · ${a.toolCount} tools`
  const origin = width >= 110 && a.originTurn !== undefined ? ` · @${a.originTurn.slice(0, 8)}` : ''
  const text = `${seq} ${a.role.padEnd(11)} ${spec}${verbOf(a).padEnd(11)} ${tail}${accounting}${origin}`

  return cellsOf(text) <= width ? text : fitText(`${seq} ${a.role} ${verbOf(a)} ${tail}${accounting}`, width)
}

/** `SONNET / SUBAGENTS`, naming only the model families the agents really run on. */
export const groupLabel = (agents: readonly AgentStrip[]): string => {
  const tiers = [...new Set(agents.map(a => tierOf(a.model)).filter((tier): tier is NonNullable<typeof tier> => tier !== null))]

  return tiers.length === 0 ? 'SUBAGENTS' : `${tiers.join('+')} / SUBAGENTS`
}

export type OrchestraView = {
  meter: Meter
  task: Task | null
  activity: Activity
  /** The main loop's turn is running. */
  isWorking: boolean
  /** The agents to draw, oldest first. */
  agents: readonly AgentStrip[]
  /** The newest NobodyWho receipt this session, already reduced to safe text; null when none arrived. */
  nwho: string | null
  limit: number
  now: number
}

const running = (agents: readonly AgentStrip[]): number => agents.filter(a => a.state === 'running' || a.state === 'waiting').length

/** `OPUS / MAIN`, from the model the engine reports for the main loop. */
export const mainLabel = (meter: Meter): string => `${tierOf(meter.model) ?? 'MODEL'} / MAIN`

/** `PLAN · HIGH`: the main loop's real phase or activity, and its effort when the engine reported one. */
export const mainWord = (view: Pick<OrchestraView, 'task' | 'activity' | 'isWorking' | 'meter'>): string => {
  const { task, activity, isWorking, meter } = view
  const doing = task !== null && task.milestones.length > 0 ? (STAGE_LABEL[task.phase] ?? task.phase) : !isWorking || activity.kind === 'IDLE' ? (isWorking ? 'THINK' : 'IDLE') : activity.kind

  return [doing, meter.effort?.toUpperCase()].filter(Boolean).join(' · ')
}

/** Whether delegated work has all come back while the main loop carries on. */
export const isBackToMain = (view: Pick<OrchestraView, 'agents' | 'isWorking'>): boolean => view.agents.length > 0 && running(view.agents) === 0 && view.isWorking

/**
 * The HUD's one orchestration line, shown only while there are subagents to
 * speak of: who is main and what it is doing, then the subagent group and how
 * many of the limit are running, or that the work is back with main.
 */
export const headerText = (view: OrchestraView, columns: number): string => {
  const main = `${mainLabel(view.meter)} · ${mainWord(view)}`
  const group = isBackToMain(view) ? `BACK TO MAIN · ${mainWord(view)}` : `${groupLabel(view.agents)} ${running(view.agents)}/${view.limit}`

  return fitText(columns >= 60 ? `${main}   ${group}` : group, columns)
}

const pair = (name: string, value: string, color?: string): Row => [
  { text: ` ${name.padEnd(20)}`, isBold: true, ...(color === undefined ? {} : { color }) },
  { text: value },
]

/**
 * The orchestration, in full, for /cockpit:
 *
 *   OPUS / MAIN          PLAN · HIGH
 *   NWHO / LOCAL         PRUNE · Q4B · 4→2 · 37ms
 *   SONNET / SUBAGENTS   2/3
 *   01 WORKER      EDIT        32s
 *   BACK TO MAIN         VERIFY
 *
 * Every line is conditional on the thing it reports having really happened:
 * no receipt, no NWHO line; no spawn, no subagent rows; nothing come back, no
 * BACK TO MAIN.
 */
export const orchestraRows = (view: OrchestraView, columns: number, colors: { accent: string; ok: string; bad: string; steel: string }): Row[] => {
  const rows: Row[] = [pair(mainLabel(view.meter), mainWord(view), colors.accent)]
  if (view.nwho !== null) rows.push(pair('NWHO / LOCAL', view.nwho, colors.steel))
  if (view.agents.length > 0) {
    rows.push(pair(groupLabel(view.agents), `${running(view.agents)}/${view.limit} running`, colors.accent))
    for (const a of view.agents) {
      const text = hasRole(a) ? roleStrip(a, Math.max(20, columns - 2), view.now) : fitText(`${a.title} ${a.tool} ${tailOf(a, view.now)}`, Math.max(20, columns - 2))
      rows.push([{ text: ` ${text}`, ...(a.state === 'error' ? { color: colors.bad } : a.state === 'done' ? { isDim: true } : {}) }])
    }
    if (isBackToMain(view)) rows.push(pair('BACK TO MAIN', mainWord(view), colors.ok))
  }

  return rows
}

/**
 * The system-prompt section that states the division of labour. It asks for
 * nothing the hooks do not also enforce: the limit, the default model, the
 * reviewer's grounds and the Fable block all hold whether or not it is read.
 */
export const orchestrationText = (limit: number): string => `

Orchestration for this user (enforced by Cobalt Cockpit, not only asked for):
- You are the main session: understand the task, plan, decompose substantial work, delegate what is genuinely isolated, integrate the results, review the important changes, run the final verification and write the final answer. There is no advisor model. Do your own planning; do not ask another model to review routine tool calls.
- Do the work yourself when it is a one-file change, a simple fix, a sequence of dependent steps, or anything tightly tied to this conversation's context. Do not spawn a subagent for a trivial task.
- When delegation helps, use the Agent tool with these agent types, which run on Sonnet at medium effort: cobalt-cockpit:worker (implementation, focused edits, tests), cobalt-cockpit:explorer (read-only: inspect the repository, trace code paths, find the relevant files), cobalt-cockpit:researcher (documentation, APIs, external sources), cobalt-cockpit:reviewer (independent review). A subagent that names no model runs on Sonnet. Every main request is constrained to Opus 5.5 / high; every subagent request to Sonnet 5.5 / medium. Explicit spawn choices are recorded, then constrained at the request boundary; inherited forks are refused. Give each a self-contained brief and expect results only.
- At most ${limit} subagents run at once; a spawn past that is refused. Use the fewest that help (one isolated implementation task: one worker), and never give two agents the same work.
- A reviewer is admitted only for a failure that has repeated, for the one final check of a substantial task, or when the user asks for a review. On a repeated error, recover normally first and follow the local decision router where the user's instructions wire it; Cockpit says when a reviewer is permitted.
- Before calling the task done, verify it yourself. The verification gates decide 100%; a subagent's claim does not.
- ${FABLE_RULE}`
