// Deterministic, auditable model routing. The planner (or the person) proposes a
// task's kind, risk and complexity; the router alone picks the role, from fixed
// rules plus independent lexical signals from the engine. Every decision lists
// the rules that fired, the alternatives rejected and why. Any doubt fails closed:
// a route is refused, never silently substituted with another model.
import { createHash } from 'node:crypto'
import { lexicalFeatures, normalizeOwned } from './core/engine.ts'
import type { Role } from './core/engine.ts'
import type { Config, RoleSpec } from './config.ts'
import type { Resolution } from './catalog.ts'
import { planReasoning } from './reasoning.ts'
import { preSpawnEstimate, pricingFor } from './cost.ts'

/** `ask`: a read-only conversational answer about the code; it takes the default (coder) rule. */
export const KINDS = ['scout', 'implement', 'frontend', 'test', 'debug', 'architecture', 'review', 'docs', 'ask'] as const
export type Kind = typeof KINDS[number]
export const RISKS = ['low', 'medium', 'high', 'critical'] as const
export type Risk = typeof RISKS[number]
const rank = (r: Risk): number => RISKS.indexOf(r)

export type TaskSpec = {
  id: string; title: string; kind: Kind; risk: Risk; complexity: number
  mode: 'read' | 'write'; owned: string[]; dependencies: string[]; prompt: string
  /** Scheduling priority 0 (low) to 9 (high); default 5. */ priority?: number
  /** Expected context the task must hold, in tokens, when known. */ contextTokens?: number
  /** Delegation depth: 0 for the person's task, 1 for planner tasks, +1 per worker request. */ depth?: number
  /** The task that requested this one, if any. */ parent?: string | null
  /**
   * Background handed to the worker before its request (the conversation so far, the commander's
   * design). Routing never reads it: a task is routed on its own title and request only.
   */
  context?: string
  /** A conversation turn may legitimately end with no edits (it is reported as such, not escalated). Never set from model output. */ allowNoChanges?: boolean
}
export type FailureHistory = { attempts: number; gateFailures: number; escalated: boolean; lastFailure: FailureClass | null }
/** Circuit breaker per provider/model: open after consecutive errors, until `until` (epoch ms); then one half-open try. */
export type Health = Record<string, { consecutiveErrors: number; unhealthy: boolean; until?: number }>
export type RouteInput = {
  task: TaskSpec; history: FailureHistory; config: Config
  resolutions: Record<Role, Resolution>; health: Health
  spentSessionUsd: number | null; escalateTo?: Role
  /** A correction attempt stays on the role of the attempt it corrects. */ pinRole?: Role
  now?: number
}
export type RouteDecision = {
  ok: boolean; taskId: string; role: Role | null; provider: string | null; model: string | null
  requestedReasoning: string | null; cliThinking: string | null; expectedWireEffort: string | null; reasoningMapping: string | null
  effectiveRisk: Risk; signals: string[]; rules: string[]; rejected: { role: Role; why: string }[]
  estimateUsd: number | null; pricingSource: string | null; refusal: string | null; inputDigest: string
}

const healthKey = (s: RoleSpec): string => `${s.provider}/${s.model}`
export { healthKey }
const FRONTEND = /\b(?:ui|ux|front-?end|css|scss|tailwind|react|vue|svelte|angular|jsx|tsx|component|layout|design\s+system|responsive|accessibility|a11y|screenshot|figma|mockup|animation|landing\s+page|html|visual)\b/i
const LONG_CONTEXT = 300_000
const WHY_NOT: Record<Role, string> = {
  commander: 'not architecture, critical review or critical debugging; reserved for evidence-backed escalation',
  coder: 'a more specific rule matched this task',
  specialist: 'not non-trivial debugging, independent review or advanced (complexity 4+) engineering',
  frontend: 'no frontend/UI kind or wording, and no long context',
  utility: 'not low-risk bounded scouting or a narrow docs edit',
}

export const routeTask = (input: RouteInput): RouteDecision => {
  const { task, history, config } = input
  const roles = config.profiles[config.profile].roles
  const rules: string[] = []; const signals: string[] = []; const rejected: { role: Role; why: string }[] = []
  const facts = lexicalFeatures({ prompt: `${task.title}\n${task.prompt}`, files: task.owned, milestones: 0, errorStreak: history.gateFailures })
  let risk: Risk = task.risk
  if (facts.security) { signals.push('security wording'); if (rank(risk) < rank('high')) { risk = 'high'; rules.push('risk-floor: security wording raises risk to high') } }
  if (facts.architecture) signals.push('architecture wording')
  if (facts.difficult) signals.push('difficult-debugging wording')
  if (facts.discovery) signals.push('discovery wording')
  const complexity = Math.max(1, Math.min(5, Math.round(task.complexity)))
  const wide = task.owned.some(o => normalizeOwned(o) === '*')

  const frontendWords = FRONTEND.test(`${task.title}\n${task.prompt}`)
  if (frontendWords) signals.push('frontend/UI wording')
  const longContext = (task.contextTokens ?? 0) > LONG_CONTEXT
  if (longContext) signals.push(`long context (${task.contextTokens} tokens)`)

  let role: Role
  if (input.escalateTo) { role = input.escalateTo; rules.push(`escalation: evidence-backed escalation to ${input.escalateTo}`) }
  else if (input.pinRole) { role = input.pinRole; rules.push(`correction: same role (${input.pinRole}) as the attempt it corrects`) }
  else if (task.kind === 'architecture') { role = 'commander'; rules.push('C1 architecture -> commander') }
  else if (task.kind === 'review' && (rank(risk) >= rank('high') || facts.security)) { role = 'commander'; rules.push(`C2 critical review (risk ${risk}${facts.security ? ', security' : ''}) -> commander`) }
  else if (task.kind === 'debug' && (risk === 'critical' || complexity >= 5)) { role = 'commander'; rules.push('C3 critical debugging -> commander') }
  else if (task.kind === 'frontend' || (frontendWords && task.mode === 'write' && (task.kind === 'implement' || task.kind === 'test')) || longContext) { role = 'frontend'; rules.push(longContext ? 'F2 long-context engineering -> frontend' : 'F1 frontend/UI work -> frontend') }
  else if (task.kind === 'debug' && (complexity >= 3 || facts.difficult || history.gateFailures >= 1)) { role = 'specialist'; rules.push('S1 non-trivial debugging -> specialist') }
  else if (task.kind === 'review') { role = 'specialist'; rules.push('S2 independent review -> specialist') }
  else if (task.kind === 'implement' && complexity >= 4) { role = 'specialist'; rules.push(`S3 advanced engineering (complexity ${complexity}) -> specialist`) }
  else if (task.mode === 'read' && (task.kind === 'scout' || task.kind === 'docs') && risk === 'low' && complexity <= 2) { role = 'utility'; rules.push('U1 low-risk bounded read-only scouting -> utility') }
  else if (task.mode === 'write' && task.kind === 'docs' && risk === 'low' && complexity === 1 && !wide) { role = 'utility'; rules.push('U2 low-risk narrow docs edit -> utility') }
  else { role = 'coder'; rules.push('D default implementation work -> coder (DeepSeek, never replaced for cost)') }

  // Guards only move work up, and never to a cheaper model for cost.
  if (role === 'utility' && rank(risk) >= rank('medium')) { rejected.push({ role: 'utility', why: `risk ${risk} is above utility's low-risk bound` }); role = 'coder'; rules.push('G1 utility bound: medium+ risk -> coder') }
  if (role === 'specialist' && risk === 'critical') { rejected.push({ role: 'specialist', why: 'critical risk needs the commander' }); role = 'commander'; rules.push('G2 critical risk -> commander') }
  for (const r of ['commander', 'coder', 'specialist', 'frontend', 'utility'] as const) if (r !== role) rejected.push({ role: r, why: WHY_NOT[r] })

  const spec = roles[role]; const res = input.resolutions[role]
  const digest = createHash('sha256').update(JSON.stringify({ task, history, profile: config.profile, spec, escalateTo: input.escalateTo ?? null })).digest('hex').slice(0, 16)
  const base = { taskId: task.id, role, provider: spec.provider, model: spec.model, effectiveRisk: risk, signals, rules, rejected, inputDigest: digest }
  const refuse = (why: string): RouteDecision => ({ ...base, ok: false, requestedReasoning: spec.reasoning, cliThinking: null, expectedWireEffort: null, reasoningMapping: null, estimateUsd: null, pricingSource: null, refusal: why })

  if (!res || !res.ok) {
    const others = (['coder', 'specialist', 'commander', 'frontend', 'utility'] as const).filter(r => r !== role && input.resolutions[r]?.ok).map(r => `${r} (${roles[r].model})`)
    return refuse(`model resolution failed for the ${role} role: ${res && !res.ok ? res.reason : 'not resolved'}. Cockpit does not switch checkpoints by itself. Permitted routes: configure an available, version-pinned model for ${role}; opt in to an unpinned id explicitly through unpinnedAllowed; or restate the task so another configured role handles it${others.length ? ` (available: ${others.join(', ')})` : ''}`)
  }
  if (res.model !== spec.model || res.provider !== spec.provider) return refuse(`resolved ${res.provider}/${res.model} differs from configured ${healthKey(spec)}`)
  const h = input.health[healthKey(spec)]
  const now = input.now ?? Date.now()
  // an open breaker delays work on this model; it never moves the work to another model
  // an open breaker always has a cool-down end; an entry without one (older state) is half-open, never a permanent block
  if (h?.unhealthy && h.until !== undefined && h.until > now) return refuse(`provider health: ${healthKey(spec)} failed ${h.consecutiveErrors} times in a row; cooling down for ${Math.ceil((h.until - now) / 1000)}s; no substitute model is chosen automatically`)
  const plan = planReasoning(spec.reasoning, res.reasoningValues, res.reasoningToggle)
  if (!plan.ok) return refuse(plan.reason)
  const price = pricingFor(config, spec.model, res.info)
  const estimate = price.source === 'none' ? null : preSpawnEstimate(config, role, price.pricing)
  if (input.spentSessionUsd === null && !config.budgets.allowUnmetered) return refuse('session cost is unmetered (a run reported no usage); budgets cannot be enforced')
  if (estimate !== null && input.spentSessionUsd !== null && input.spentSessionUsd + estimate > config.budgets.sessionUsd) return refuse(`budget: estimated $${estimate.toFixed(4)} would exceed the session budget ($${input.spentSessionUsd.toFixed(4)} of $${config.budgets.sessionUsd.toFixed(2)} spent)`)
  if (history.attempts >= config.limits.maxAttemptsPerTask) return refuse(`attempt limit: ${history.attempts} of ${config.limits.maxAttemptsPerTask}`)
  return { ...base, ok: true, requestedReasoning: plan.requested, cliThinking: plan.cliFlag, expectedWireEffort: plan.expectedWire, reasoningMapping: plan.mapping, estimateUsd: estimate, pricingSource: price.source, refusal: null }
}

// ---------------------------------------------------------------------------
// Bounded escalation and retry. Unlimited retries are impossible by construction.
/**
 * Failure classes, by what may safely follow:
 *   transient       provider_error, rate_limited, timeout, unknown_outcome, resource_error -> same model, backoff
 *   implementation  gate_failed, misreported_completion, no_changes -> correction, then escalation
 *   final           auth_error, budget_exceeded, policy_abort, wire_mismatch, model_mismatch, unmetered,
 *                   sandbox_error -> stop with the reason (a safety refusal stays a refusal)
 */
export type FailureClass =
  | 'gate_failed' | 'misreported_completion' | 'no_changes' | 'provider_error' | 'rate_limited' | 'timeout' | 'resource_error'
  | 'auth_error' | 'budget_exceeded' | 'policy_abort' | 'wire_mismatch' | 'model_mismatch' | 'unmetered' | 'sandbox_error' | 'unknown_outcome'
export type NextStep = { action: 'retry_same' | 'correct' | 'escalate' | 'stop'; to?: Role; reason: string; delayMs?: number }
export const TRANSIENT: readonly FailureClass[] = ['provider_error', 'rate_limited', 'timeout', 'unknown_outcome', 'resource_error']
export const IMPLEMENTATION: readonly FailureClass[] = ['gate_failed', 'misreported_completion', 'no_changes']

/** Sorts a failed run's own error text (result text, stderr) into a class; null when it says nothing classifiable. */
export const classifyFailureText = (text: string): 'auth_error' | 'rate_limited' | 'resource_error' | 'provider_error' | null => {
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api[ _-]?)?key|authenticat|not (?:signed|logged) in|(?:token|session) (?:has )?expired|insufficient (?:credits|balance|funds)|payment required|\b402\b/i.test(text)) return 'auth_error'
  if (/\b429\b|rate.?limit|too many requests|quota exceeded|slow down/i.test(text)) return 'rate_limited'
  if (/ENOSPC|ENOMEM|EMFILE|ENFILE|too many open files|out of memory|cannot allocate/i.test(text)) return 'resource_error'
  if (/\b5\d\d\b|overloaded|unavailable|bad gateway|gateway timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|upstream/i.test(text)) return 'provider_error'
  return null
}

/** Exponential backoff with full jitter: uniform in [cap/2, cap] where cap = min(max, base * 2^retry). */
export const backoffMs = (retry: number, base: number, max: number, rand: () => number = Math.random): number => {
  const cap = Math.min(max, base * 2 ** Math.max(0, retry))
  return Math.round(cap / 2 + rand() * (cap / 2))
}

/** Whom an implementation failure escalates to: debugging goes to the specialist (MiMo); otherwise the configured target (Kimi). */
export const escalationTarget = (role: Role, kind: Kind, config: Config): Role | null => {
  if ((kind === 'debug' || kind === 'test') && role !== 'specialist' && role !== 'commander') return 'specialist'
  return config.escalation[role]
}

export const nextStep = (cls: FailureClass, role: Role, history: FailureHistory & { transientRetries: number; escalations: number; corrections?: number; kind?: Kind }, config: Config, evidence: string[]): NextStep => {
  const l = config.limits
  if (history.attempts >= l.maxAttemptsPerTask) return { action: 'stop', reason: `attempt limit ${l.maxAttemptsPerTask} reached` }
  if (TRANSIENT.includes(cls)) {
    if (history.transientRetries >= l.maxTransientRetries) return { action: 'stop', reason: `${cls}: ${l.maxTransientRetries} transient retr${l.maxTransientRetries === 1 ? 'y' : 'ies'} used; no model substitution` }
    const delayMs = backoffMs(history.transientRetries + (cls === 'rate_limited' ? 1 : 0), l.retryBaseMs, l.retryMaxMs)
    return { action: 'retry_same', delayMs, reason: `${cls}: retry ${history.transientRetries + 1}/${l.maxTransientRetries} on the same model in ${(delayMs / 1000).toFixed(1)}s` }
  }
  if (IMPLEMENTATION.includes(cls)) {
    if (evidence.length === 0) return { action: 'stop', reason: `${cls} without recorded evidence: no correction or escalation` }
    if ((history.corrections ?? 0) < l.maxCorrectionsPerTask && history.escalations === 0) return { action: 'correct', reason: `${cls}: one correction attempt on ${role} with its diff and the gate evidence` }
    const to = escalationTarget(role, history.kind ?? 'implement', config)
    if (!to) return { action: 'stop', reason: `${cls} on ${role}: no escalation target configured` }
    if (history.escalations >= l.maxEscalationsPerTask) return { action: 'stop', reason: `escalation limit ${l.maxEscalationsPerTask} reached` }
    return { action: 'escalate', to, reason: `${cls} after correction: ${role} -> ${to}, which diagnoses the failure before fixing it` }
  }
  if (cls === 'auth_error') return { action: 'stop', reason: 'authentication or billing refused the request: sign in or top up with `cline auth`, then run `cockpit-cline recover`; not retried automatically' }
  return { action: 'stop', reason: `${cls}: not retried (safety, budget or configuration failure)` }
}
