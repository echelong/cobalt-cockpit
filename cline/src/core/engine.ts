// Host-neutral facade over the existing Cobalt Cockpit engine.
//
// Every function here comes from the unchanged pure modules in ../../../hooks/.
// Nothing under hooks/ is modified for Cline: the Claude Code plugin keeps its
// exact bytes. This file maps Cline roles onto the engine's capacity classes
// and re-exports the pieces the Cline supervisor needs.
//
// Capacity classes: the engine names its admission pools after the Claude
// tiers (SONNET, HAIKU, OPUS). For Cline those names are pools, not models:
//   commander  -> OPUS pool    (Kimi K3.1 Pro by default; opus pool > 0)
//   coder      -> SONNET pool  (DeepSeek V4.1 Flash 1017, the default coder)
//   specialist -> SONNET pool  (Xiaomi MiMo V2.6 Pro)
//   frontend   -> SONNET pool  (Qwen3.8 Max 0902)
//   utility    -> HAIKU pool   (GLM 5.3 Flash)
// Per-role, per-provider and resource limits are applied by the Cline scheduler
// before the engine admits a task; the engine keeps ownership, overlap,
// dependency and uncertain-spawn semantics.
// The model each role uses is resolved separately (catalog.ts), never here.

export {
  emptySwarm, configureSwarm, submitTask, admitTask, admissionReason, bindAgent, uncertainSpawn,
  finishTask, requestCancel, releaseReservation, overlaps, normalizeOwned, hasActiveOwnership,
  ownershipAllows, summarizeSwarm, heartbeat,
} from '../../../hooks/swarm'
export type { Swarm, SwarmTask, TaskInput, ModelTier, TaskState } from '../../../hooks/swarm'
export { assessCommand } from '../../../hooks/guard'
export { redactSecrets, carriesCredential, secretText } from '../../../hooks/secrets'
export { EFFORT_LEVELS, effortRank, isEffortLevel } from '../../../hooks/effort'
export { lexicalFeatures } from '../../../hooks/router'
export { CLAIMABLE_STATES, STATE_MEANING, NOT_SECURITY_ATTESTED } from '../../../hooks/verification'
export type { ClaimedVerification } from '../../../hooks/verification'

import type { ModelTier } from '../../../hooks/swarm'

export type Role = 'commander' | 'coder' | 'specialist' | 'frontend' | 'utility'
export const ROLES: readonly Role[] = ['commander', 'coder', 'specialist', 'frontend', 'utility']
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v)

/** The engine admission pool a Cline role occupies. */
export const POOL_OF: Readonly<Record<Role, ModelTier>> = { commander: 'OPUS', coder: 'SONNET', specialist: 'SONNET', frontend: 'SONNET', utility: 'HAIKU' }
