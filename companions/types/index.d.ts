export type SwarmView = { tasks: { id: string; agentId: string | null; tier: string; state: string; mode: string; owned: string[]; endedAt: number | null; startedAt: number | null; cancellationRequested: boolean }[] }
export type Receipt = { capability: 'memory' | 'browser'; operation: string; status: string; at: number; durationMs: number | null; count: number | null; bank: string | null; task: string | null; executed: boolean; verification: 'pending' | 'unknown'; operations: string[]; fallback: boolean; error: string | null }
export type Capabilities = { memory: string; browser: string; bank: string | null; receipts: Receipt[] }
declare module 'claude-code' {
  interface PluginState {
    'cobalt-capabilities': { capabilities: Capabilities }
  }
}
