// Supported engine request rewrites; aliases never stand in for observed IDs.
import type { EffortLevel, Profile } from '../types'
export type { Profile } from '../types'
export const OPUS_MODEL = 'claude-opus-5-5'
export const AGENT_MODEL = 'claude-sonnet-5-5'
export const HAIKU_MODEL = 'claude-haiku-5-5'
/** The legacy (OPUS_LED) main model; `mainModel` names the one a profile leads with. */
export const MAIN_MODEL = OPUS_MODEL
export const DEFAULT_PROFILE: Profile = 'OPUS_LED'
export const isProfile = (value: unknown): value is Profile => value === 'OPUS_LED' || value === 'SONNET_LED'
/** OPUS_LED: Opus commands. SONNET_LED: Sonnet builds and Opus is consulted on admission only. */
export const mainModel = (profile: Profile = DEFAULT_PROFILE): string => (profile === 'SONNET_LED' ? AGENT_MODEL : OPUS_MODEL)
/** OPUS is a subagent tier only in SONNET_LED, where it is the admitted architect/reviewer. */
export type SubagentTier = 'SONNET' | 'HAIKU' | 'OPUS'
// The main loop names a model only: its effort is the host's (the user's own
// selection, the settings and the caps), and nothing is asked for in its place.
export const desiredRequest = (agentId?: string, tier: SubagentTier = 'SONNET', profile: Profile = DEFAULT_PROFILE): { model: string; effort?: EffortLevel } =>
  !agentId ? { model: mainModel(profile) } : tier === 'HAIKU' ? { model: HAIKU_MODEL } : tier === 'OPUS' ? { model: OPUS_MODEL, effort: 'high' } : { model: AGENT_MODEL, effort: 'medium' }
export const policyMismatch = (model: string, effort: unknown, agentId?: string, tier: SubagentTier = 'SONNET', profile: Profile = DEFAULT_PROFILE): string | null => {
  const want = desiredRequest(agentId, tier, profile)
  return model === want.model && (want.effort === undefined || effort === want.effort) ? null : `MODEL POLICY / requested ${model} · ${String(effort ?? 'unknown')}; constrained to ${want.model} · ${want.effort ?? 'effort unspecified'}`
}
