// Supported engine request rewrites; aliases never stand in for observed IDs.
export const MAIN_MODEL = 'claude-opus-5-5'
export const AGENT_MODEL = 'claude-sonnet-5-5'
export const desiredRequest = (agentId?: string) => ({ model: agentId ? AGENT_MODEL : MAIN_MODEL, effort: agentId ? 'medium' as const : 'high' as const })
export const policyMismatch = (model: string, effort: unknown, agentId?: string): string | null => {
  const want = desiredRequest(agentId)
  return model === want.model && effort === want.effort ? null : `MODEL POLICY / requested ${model} · ${String(effort ?? 'unknown')}; constrained to ${want.model} · ${want.effort}`
}
