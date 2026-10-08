// Dynamic, task-aware reasoning effort.
//
// This module is pure: it is arithmetic and naming over facts the commander,
// the task and the engine already reported. It never calls a model, never
// touches `$`, and never sets a global engine setting. The one place effort is
// actually applied is `turn.step` in register.tsx, which rewrites a request's
// `effort` for a single turn — so two agents running side by side can ask for
// different levels without a global setting moving under either of them.
//
// Three ideas are kept apart on purpose:
//
//   - REQUESTED. What the commander (or AUTO) asked for: a level or AUTO.
//   - SELECTED. For AUTO, what the task facts imply; for a manual request, the
//     level itself.
//   - APPLIED. What the model's capability actually allows, after a fallback.
//
// A requested level that a model cannot honour is not silently pretended: the
// applied level is the closest supported one and the fallback is named.

import type { EffortEscalation, EffortLevel, EffortRequest, EffortSource, ModelTier } from '../types'
export type { EffortEscalation, EffortLevel, EffortRequest, EffortSource } from '../types'

/** The engine's effort levels, weakest first. Order is the escalation order. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const EFFORT_LOW = 'low' as const
export const DEFAULT_CEILING: EffortLevel = 'max'
/** Hard stop on escalation: no task climbs forever. */
export const MAX_ESCALATIONS = 4

export const isEffortLevel = (v: unknown): v is EffortLevel => typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)
export const isEffortRequest = (v: unknown): v is EffortRequest => v === 'AUTO' || isEffortLevel(v)

export const effortRank = (level: EffortLevel): number => EFFORT_LEVELS.indexOf(level)
const byRank = (levels: readonly EffortLevel[]): EffortLevel[] => [...levels].sort((a, b) => effortRank(a) - effortRank(b))

/**
 * The model family an id belongs to, or null for one this policy does not
 * name. Kept local so this module stays a leaf: nothing here imports the
 * drawing or orchestration code.
 */
export const modelFamily = (model: string | null | undefined): ModelTier | null => {
  const id = (model ?? '').toLowerCase()
  if (id.includes('opus')) return 'OPUS'
  if (id.includes('sonnet')) return 'SONNET'
  if (id.includes('haiku')) return 'HAIKU'

  return null
}

/**
 * Declared capability: the levels each family is asked for by default. This is
 * a *declared* baseline, not a discovered fact — `source` says so, and a
 * runtime observation (below) replaces it. `haiku` is deliberately capped at
 * `high` and no family is assumed to reach `max` without an observation.
 */
export const DECLARED_CAPABILITY: Record<ModelTier, readonly EffortLevel[]> = {
  OPUS: ['low', 'medium', 'high', 'xhigh', 'max'],
  SONNET: ['low', 'medium', 'high', 'xhigh'],
  HAIKU: ['low', 'medium', 'high'],
}
/** A family this policy cannot name is treated as the conservative common core. */
export const UNKNOWN_CAPABILITY: readonly EffortLevel[] = ['low', 'medium', 'high']

export type Capability = {
  model: string
  tier: ModelTier | null
  /** The levels that may be applied, weakest first. */
  allowed: EffortLevel[]
  /** The strongest level among `allowed`. */
  ceiling: EffortLevel
  /** Where `allowed` came from: a declared baseline, a runtime observation, or an operator override. */
  source: 'declared' | 'observed' | 'configured'
  /** A short note for the diagnostics line. */
  note: string
}

/**
 * What a model may be asked for, preferring runtime observation over the
 * declared baseline. `known` is a capability map gathered from real engine
 * reports (`observeCapability`); `configured` is an operator override.
 */
export const capabilityFor = (
  model: string,
  known: Readonly<Record<string, readonly EffortLevel[]>> = {},
  configured: Readonly<Record<string, readonly EffortLevel[]>> = {},
): Capability => {
  const tier = modelFamily(model)
  const declared: readonly EffortLevel[] = tier === null ? UNKNOWN_CAPABILITY : DECLARED_CAPABILITY[tier]
  if (isEffortLevel(configured[model]?.[0]) || (configured[model]?.length ?? 0) > 0) {
    const allowed = byRank(configured[model]!.filter(isEffortLevel))
    if (allowed.length > 0) return { model, tier, allowed, ceiling: allowed[allowed.length - 1]!, source: 'configured', note: `${tier ?? 'unknown'} configured` }
  }
  if ((known[model]?.length ?? 0) > 0) {
    const allowed = byRank(known[model]!.filter(isEffortLevel))
    if (allowed.length > 0) return { model, tier, allowed, ceiling: allowed[allowed.length - 1]!, source: 'observed', note: `${tier ?? 'unknown'} observed` }
  }
  const allowed = byRank(declared)

  return { model, tier, allowed, ceiling: allowed[allowed.length - 1]!, source: 'declared', note: `${tier ?? 'unknown'} declared` }
}

export const supportsEffort = (capability: Capability, level: EffortLevel): boolean => capability.allowed.includes(level)

/**
 * Folds one real observation into the capability map. The engine reports the
 * level it *actually* applied; when that is below what was requested, the
 * requested level is not supported and is removed; when it matches, the
 * requested level is known to work and is added. Nothing is invented.
 */
export const observeCapability = (
  known: Readonly<Record<string, readonly EffortLevel[]>>,
  model: string,
  requested: EffortLevel,
  actual: EffortLevel,
): Record<string, readonly EffortLevel[]> => {
  const prior = known[model] ?? (() => {
    const tier = modelFamily(model)

    return tier === null ? UNKNOWN_CAPABILITY : DECLARED_CAPABILITY[tier]
  })()
  const next = effortRank(actual) >= effortRank(requested)
    ? byRank([...prior, requested])
    : byRank(prior.filter(level => level !== requested))

  return { ...known, [model]: next.length > 0 ? next : [actual] }
}

/** The closest level a capability can apply to `wanted`, preferring one at or below it. */
export const clampToCapability = (wanted: EffortLevel, capability: Capability): { applied: EffortLevel | undefined; fallbackReason: string | null } => {
  if (supportsEffort(capability, wanted)) return { applied: wanted, fallbackReason: null }
  const atOrBelow = capability.allowed.filter(level => effortRank(level) <= effortRank(wanted))
  if (atOrBelow.length > 0) {
    const applied = atOrBelow[atOrBelow.length - 1]!
    return { applied, fallbackReason: `${wanted} is not supported by ${capability.model} (${capability.source}); applied ${applied}` }
  }
  // Everything the model supports is above what was asked; take the weakest.
  const applied = capability.allowed[0]
  return applied === undefined
    ? { applied: undefined, fallbackReason: `no effort level is known for ${capability.model}; applied none` }
    : { applied, fallbackReason: `${wanted} is below ${capability.model}'s floor (${capability.source}); applied ${applied}` }
}

// ---------------------------------------------------------------------------
// AUTO selection: what a task deserves.
//
// The routing examples in the v0.3 brief are encoded as work classes, from the
// lightest to the heaviest. They are guidelines: the commander can always name
// a level by hand, and a manual level always wins.
// ---------------------------------------------------------------------------

export type EffortFacts = {
  /** The tier the work runs on; when absent it is chosen by `selectModel`. */
  tier?: ModelTier
  // Light, extractive work.
  inventory?: boolean
  extraction?: boolean
  classification?: boolean
  summary?: boolean
  // Normal engineering.
  implementation?: boolean
  simpleTest?: boolean
  feature?: boolean
  bugfix?: boolean
  refactor?: boolean
  dependencyMap?: boolean
  inspection?: boolean
  triage?: boolean
  coordination?: boolean
  // Heavy reasoning.
  recon?: boolean
  investigation?: boolean
  architecture?: boolean
  verification?: boolean
  debug?: boolean
  concurrency?: boolean
  migration?: boolean
  security?: boolean
  integrationFailure?: boolean
  // Signals that raise concern.
  highRisk?: boolean
  ambiguous?: boolean
  uncertainty?: boolean
  coupled?: boolean
  /** Unusually difficult, high-stakes reasoning that warrants the top level. */
  extraordinary?: boolean
  failedAttempts?: number
  verificationFailed?: boolean
}

/** The baseline level for a tier when the task itself names no class. */
export const BASE_EFFORT: Record<ModelTier, EffortLevel> = { HAIKU: 'low', SONNET: 'medium', OPUS: 'high' }
/** The strongest level AUTO will select for a tier before capability clamps it. */
export const TIER_CEILING: Record<ModelTier, EffortLevel> = { HAIKU: 'high', SONNET: 'xhigh', OPUS: 'max' }

const raise = (current: EffortLevel, cap: EffortLevel): EffortLevel =>
  effortRank(current) >= effortRank(cap) ? current : EFFORT_LEVELS[effortRank(current) + 1]!

/** The heaviest work class the facts name, with why. Null when none is named. */
const workClass = (facts: EffortFacts): { level: EffortLevel; why: string } | null => {
  if (facts.extraordinary === true) return { level: 'max', why: 'unusually difficult, high-stakes reasoning' }
  if (facts.highRisk === true && (facts.architecture === true || facts.integrationFailure === true)) return { level: 'xhigh', why: 'high-risk architectural or integration reasoning' }
  if (facts.concurrency === true) return { level: 'xhigh', why: 'concurrency investigation' }
  if (facts.security === true) return { level: 'xhigh', why: 'security analysis' }
  if (facts.migration === true) return { level: 'xhigh', why: 'difficult migration' }
  if (facts.debug === true) return { level: 'xhigh', why: 'complex debugging' }
  if (facts.integrationFailure === true) return { level: 'xhigh', why: 'complex integration failure' }
  if (facts.highRisk === true) return { level: 'high', why: 'high-risk reasoning' }
  if (facts.architecture === true) return { level: 'high', why: 'architectural coordination' }
  if (facts.verification === true) return { level: 'high', why: 'independent verification' }
  if (facts.investigation === true) return { level: 'high', why: 'difficult code investigation' }
  if (facts.recon === true) return { level: 'high', why: 'complex reconnaissance' }
  if (facts.ambiguous === true || facts.uncertainty === true) return { level: 'high', why: 'ambiguous or uncertain scope' }
  if (facts.coupled === true) return { level: 'high', why: 'tightly coupled reasoning' }
  if (facts.feature === true) return { level: 'medium', why: 'normal feature development' }
  if (facts.bugfix === true) return { level: 'medium', why: 'bug fixing' }
  if (facts.refactor === true) return { level: 'medium', why: 'refactoring' }
  if (facts.dependencyMap === true) return { level: 'medium', why: 'dependency mapping' }
  if (facts.inspection === true) return { level: 'medium', why: 'bounded code inspection' }
  if (facts.triage === true) return { level: 'medium', why: 'test triage' }
  if (facts.coordination === true) return { level: 'medium', why: 'routine coordination and integration' }
  if (facts.implementation === true || facts.simpleTest === true) return { level: 'low', why: 'straightforward implementation' }
  if (facts.inventory === true) return { level: 'low', why: 'repository inventory' }
  if (facts.extraction === true) return { level: 'low', why: 'extraction' }
  if (facts.classification === true) return { level: 'low', why: 'simple classification' }
  if (facts.summary === true) return { level: 'low', why: 'log summarization' }

  return null
}

/**
 * The effort a task deserves, from its facts alone. The tier's baseline is used
 * when the task names no class; the heaviest class otherwise. Concern signals
 * (uncertainty, a failure that repeated, a failed verification) raise the level
 * by exactly one step, so a failed light task moves to the next level and not
 * straight to the top.
 */
export const selectEffort = (facts: EffortFacts): { effort: EffortLevel; reason: string } => {
  const tier = facts.tier ?? selectModel(facts).tier
  const cap = TIER_CEILING[tier]
  const named = workClass(facts)
  let effort = named === null ? BASE_EFFORT[tier] : named.level
  let reason = named === null ? `${tier} baseline for an unclassified task` : named.why
  // A named class may not exceed the tier's own ceiling.
  if (effortRank(effort) > effortRank(cap)) effort = cap

  const attempts = Math.max(0, Math.floor(facts.failedAttempts ?? 0))
  const raised = attempts >= 1 || facts.verificationFailed === true
  if (raised) {
    const before = effort
    effort = raise(effort, cap)
    if (effort !== before) {
      const why = attempts >= 1 ? `the same task failed ${attempts} time${attempts === 1 ? '' : 's'}` : 'verification failed'
      reason = `${reason}; raised for ${why}`
    }
  }

  return { effort, reason }
}

/** The tier AUTO would pick for a task, from its facts alone. */
export const selectModel = (facts: EffortFacts): { tier: ModelTier; reason: string } => {
  if (facts.architecture === true || facts.highRisk === true || facts.ambiguous === true) return { tier: 'OPUS', reason: 'architecture, risk or ambiguity belongs with the commander' }
  if (facts.extraordinary === true || facts.integrationFailure === true) return { tier: 'OPUS', reason: 'unusually difficult reasoning' }
  if (facts.inventory === true || facts.extraction === true || facts.classification === true || facts.summary === true) return { tier: 'HAIKU', reason: 'bounded extractive work' }
  if (facts.recon === true) return { tier: 'HAIKU', reason: 'reconnaissance' }

  return { tier: 'SONNET', reason: 'engineering work' }
}

/**
 * What a role's work is like, so an unclassified assignment still gets a
 * sensible AUTO choice. Read is distinguished from write: a writer is doing
 * engineering, a reader is inspecting. This only informs AUTO; an explicit
 * tier or effort always wins.
 */
export const factsFromRole = (role: string, mode: 'read' | 'write' = 'read'): EffortFacts => {
  const name = role.toLowerCase().replace(/^.*:/, '')
  if (/^(scout|inventory)/.test(name)) return mode === 'write' ? { feature: true } : { inventory: true }
  if (/^(utility|triage)/.test(name)) return { extraction: true }
  if (/review/.test(name)) return { verification: true }
  if (/^(explore|explorer)/.test(name)) return { inspection: true }
  if (/^(researcher|research|claude-code-guide)/.test(name)) return { inspection: true }
  if (/^(worker|implementer)/.test(name)) return { feature: true }

  return mode === 'write' ? { feature: true } : { inspection: true }
}

// ---------------------------------------------------------------------------
// Capability-aware resolution.
// ---------------------------------------------------------------------------

export type EffortResolution = {
  requested: EffortRequest
  /** What was wanted before capability: the manual level, or AUTO's selection. */
  selected: EffortLevel
  /** What the model can actually be asked for, or undefined when none is known. */
  applied: EffortLevel | undefined
  source: EffortSource
  /** One line on why this level was chosen. */
  reason: string
  /** Set when capability forced a level other than the selected one. */
  fallbackReason: string | null
}

/**
 * Resolves a request into what will actually be applied.
 *
 *   - `AUTO` selects from the facts; an explicit level is taken as-is.
 *   - The operator's ceiling is applied next: nothing above it is even selected,
 *     so the recorded reason says the ceiling bit rather than a capability.
 *   - The result is then clamped to the model's capability, naming any fallback.
 *   - `requested` is preserved exactly, so the ledger can keep requested and
 *     applied apart even when they differ.
 */
export const chooseEffort = (requested: EffortRequest, facts: EffortFacts, capability: Capability, ceiling: EffortLevel = DEFAULT_CEILING): EffortResolution => {
  const selection = requested === 'AUTO' ? selectEffort(facts) : { effort: requested, reason: `named by the commander (${requested})` }
  const isCapped = effortRank(selection.effort) > effortRank(ceiling)
  const selected = isCapped ? ceiling : selection.effort
  const why = isCapped ? `${selection.reason}; capped at the configured ceiling ${ceiling}` : selection.reason
  const clamped = clampToCapability(selected, capability)
  const source: EffortSource = requested === 'AUTO'
    ? (clamped.fallbackReason === null ? 'auto' : 'fallback')
    : (clamped.fallbackReason === null ? 'manual' : 'fallback')

  return {
    requested,
    selected,
    applied: clamped.applied,
    source,
    reason: why,
    fallbackReason: clamped.fallbackReason,
  }
}

// ---------------------------------------------------------------------------
// Escalation: vertical (tier) and effort.
// ---------------------------------------------------------------------------

export type EscalationDecision =
  | { kind: 'none'; reason: string }
  | { kind: 'effort'; to: EffortLevel; reason: string }
  | { kind: 'tier'; to: ModelTier; reason: string }

/** The next level up within a capability, or null at the ceiling. */
export const nextEffort = (current: EffortLevel, capability: Capability): EffortLevel | null => {
  const above = capability.allowed.filter(level => effortRank(level) > effortRank(current))
  return above.length > 0 ? above[0]! : null
}

const NEXT_TIER: Record<ModelTier, ModelTier | null> = { HAIKU: 'SONNET', SONNET: 'OPUS', OPUS: null }

/**
 * The next escalation for a task that is failing, if any.
 *
 * One step at a time: an effort step within the tier when there is headroom,
 * otherwise a tier step. A task already at Opus `max` does not escalate: an
 * exhausted budget is reported rather than looping. A single failure never
 * jumps to the top, because only one step is ever taken.
 */
export const escalationFor = (
  facts: EffortFacts,
  current: { tier: ModelTier; effort: EffortLevel },
  capability: Capability,
): EscalationDecision => {
  const attempts = Math.max(0, Math.floor(facts.failedAttempts ?? 0))
  const failing = attempts >= 1 || facts.verificationFailed === true
  if (!failing) return { kind: 'none', reason: 'nothing failed; no escalation' }
  if (attempts > MAX_ESCALATIONS) return { kind: 'none', reason: `escalation budget exhausted after ${MAX_ESCALATIONS} steps` }
  const why = attempts >= 1 ? `the same failure repeated ${attempts} time${attempts === 1 ? '' : 's'}` : 'verification failed'
  const stronger = nextEffort(current.effort, capability)
  if (stronger !== null) return { kind: 'effort', to: stronger, reason: `${why}; one effort step to ${stronger}` }
  const tier = NEXT_TIER[current.tier]
  if (tier !== null) return { kind: 'tier', to: tier, reason: `${why} and the effort ceiling is reached; escalating to ${tier}` }

  return { kind: 'none', reason: `${why}, but ${current.tier} is already at its ceiling; no further escalation` }
}

export const effortEscalation = (from: EffortLevel, to: EffortLevel, reason: string, at: number): EffortEscalation => ({ from, to, reason, at })

/** `LOW → MEDIUM` for the HUD's escalation list. */
export const escalationLine = (e: EffortEscalation): string => `${e.from.toUpperCase()} → ${e.to.toUpperCase()}`

// ---------------------------------------------------------------------------
// The system-prompt section: the rules the hooks also enforce.
// ---------------------------------------------------------------------------

export const effortPolicyText = (mode: 'AUTO' | 'MANUAL', ceiling: EffortLevel): string => `

Dynamic reasoning (Cobalt Cockpit):
- Reasoning mode is ${mode}. Model selection and effort selection are separate decisions. Three tiers remain: Opus 5.5 commands and verifies, Sonnet 5.5 engineers, Haiku 5.5 scouts.
- Effort is chosen per task, not fixed. ${mode === 'AUTO' ? 'AUTO names a level from the task: extractive inventories, classification and summaries run light; normal feature work and refactors run medium; complex debugging, concurrency, migrations, security and high-risk architectural reasoning run high or xhigh; unusually difficult high-stakes reasoning may use max.' : 'MANUAL honours the configured level unless a task is assigned an explicit effort.'}
- A level is only ever requested. Every model does not support every level, so the applied level may be lower after a capability fallback; requested and applied effort are recorded separately and a fallback is named, never hidden.
- Escalate when a task is failing: raise effort by one step within the tier first, then move a tier (Haiku → Sonnet → Opus). Never jump straight to the top, and stop at the ceiling budget rather than retrying forever. Name the level per assignment with the swarm tool's effort field when the task itself makes it clear.
- The ceiling for any request is ${ceiling.toUpperCase()}; a higher request falls back and is recorded.`