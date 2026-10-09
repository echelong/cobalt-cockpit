import type { SwarmView, Receipt, Capabilities } from '../types'
export type { Receipt, Capabilities } from '../types'

/** Same conservative rule as Cockpit custom effects, enforced even when its
 * orchestration toggle is off. Unknown ownership cannot authorize an agent. */
export const ownershipDenial = (swarm: SwarmView | undefined, agent?: string): string | null => {
  if (!swarm) return 'Cockpit ownership state unavailable'
  const occupied = swarm.tasks.filter(t => t.endedAt === null && (t.startedAt !== null || t.agentId !== null || ['reserved','running'].includes(t.state)))
  if (!agent) return occupied.some(t => t.tier !== 'OPUS') ? 'Active agent ownership holds commander effects' : null
  const task = occupied.find(t => t.agentId === agent)
  if (!task || !['running','reserved'].includes(task.state) || task.cancellationRequested || task.mode !== 'write' || !task.owned.includes('*')) return 'Exclusive wildcard task ownership required'
  return occupied.some(t => t.id !== task.id) ? 'Another task holds resources' : null
}

const token = (v: unknown, pattern: RegExp): string | null => typeof v === 'string' && pattern.test(v) ? v : null
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 1e9) : null
/** Explicit projection: no page text, query, summary, URLs, screenshots or errors. */
export const receiptOf = (capability: 'memory' | 'browser', operation: string, value: Record<string, unknown>, at: number): Receipt => ({
  capability, operation: token(operation, /^(status|recall|retain|reflect|list|forget|task)$/) ?? 'task',
  status: token(value['status'], /^(disabled|ready|unavailable|error|success|refused|timeout|observed)$/) ?? 'error', at,
  durationMs: finite(value['duration_ms']), count: finite(value['result_count']),
  bank: token(value['bank_id'], /^cobalt-[a-f0-9]{32,64}$/), task: token(value['task_id'], /^[a-zA-Z0-9_.-]{1,80}$/),
  executed: value['executed'] === true, verification: value['executed'] === true ? 'pending' : 'unknown',
  operations: Array.isArray(value['results']) ? value['results'].slice(0,12).map(row => token((row as Record<string, unknown>)?.['operation'], /^(navigate|inspect|snapshot|console|network|screenshot|click|fill)$/)).filter((v): v is string => v !== null) : [],
  fallback: value['fallback'] === true || ['error','unavailable','timeout','refused'].includes(String(value['status'])),
  error: token(value['error'], /^(timeout|service_unavailable|operation_refused_or_invalid_response|browser_timeout|browser_output_limit|browser_unavailable|browser_policy_or_execution_error|browser_cleanup_failed|worker_unavailable_or_timeout|worker_failed|resource_busy|invalid_configuration_or_request)$/),
})
