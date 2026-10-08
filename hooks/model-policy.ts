// Supported engine request rewrites; aliases never stand in for observed IDs.
export const MAIN_MODEL = 'claude-opus-5-5'
export const AGENT_MODEL = 'claude-sonnet-5-5'
export const HAIKU_MODEL = 'claude-haiku-5-5'
export type SubagentTier = 'SONNET' | 'HAIKU'
// The main loop names a model only: its effort is the host's (the user's own
// selection, the settings and the caps), and nothing is asked for in its place.
export const desiredRequest = (agentId?: string, tier: SubagentTier = 'SONNET'): { model: string; effort?: 'medium' } =>
  !agentId ? { model: MAIN_MODEL } : tier === 'HAIKU' ? { model: HAIKU_MODEL } : { model: AGENT_MODEL, effort: 'medium' }
export const policyMismatch = (model: string, effort: unknown, agentId?: string, tier: SubagentTier = 'SONNET'): string | null => {
  const want = desiredRequest(agentId, tier)
  return model === want.model && (want.effort === undefined || effort === want.effort) ? null : `MODEL POLICY / requested ${model} · ${String(effort ?? 'unknown')}; constrained to ${want.model} · ${want.effort ?? 'effort unspecified'}`
}
