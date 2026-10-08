// Pure, bounded accounting. Every absent measurement is literally unknown.
import type { EffortVia, GitState, NwhoEvent, Task, Value, Counts, Run, LedgerAgent, ToolEntry, Reading, Request, Checkpoint, Ledger } from '../types'
export type { Value, Counts, Run, LedgerAgent, ToolEntry, Reading, Request, Checkpoint, Ledger } from '../types'
import { appendReplay, safeFile, safeText, secretText } from './replay'
import type { ReplayStep } from './replay'
import { emptySwarm } from './swarm'
import { roleOf } from './orchestra'
import { activityOf } from './classify'
export const UNKNOWN = 'unknown' as const
export const LIMITS = { runs: 32, agents: 96, tools: 512, requests: 512, usage: 64, receipts: 256, warnings: 32 }
const counts = (): Counts => ({ tools: 0, reads: 0, edits: 0, writes: 0, tests: 0, builds: 0, git: 0, failures: 0, retries: UNKNOWN })
export const emptyLedger = (sessionId: string = UNKNOWN): Ledger => ({ schema: 2, swarm: emptySwarm(), sessionId, currentRun: UNKNOWN, turns: {}, runs: [], agents: [], tools: [], requests: [], usage: [], receipts: [], warnings: [], replay: [], checkpoint: null })
export const word = (v: unknown): Value<string> => typeof v === 'string' && /^[a-zA-Z0-9_.:/ -]{1,160}$/.test(v) && !secretText(v) ? safeText(v) : UNKNOWN
export const numberOf = (v: unknown): Value<number> => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : UNKNOWN
export const textOf = (v: unknown): string => typeof v === 'string' && !secretText(v) ? safeText(v).replace(/\s+/g, ' ').slice(0, 160) : UNKNOWN
export const elapsed = (start: Value<number>, end: Value<number>, now: number): Value<number> => start === UNKNOWN ? UNKNOWN : Math.max(0, (end === UNKNOWN ? now : end) - start)
export const startRun = (l: Ledger, turnId: string, at: number): Ledger => {
  const id = `${l.sessionId}:${turnId}`
  if (l.runs.some(r => r.id === id)) return { ...l, currentRun: id, turns: { ...l.turns, main: turnId } }
  const runs = [...l.runs, { id, turnId, parentRun: UNKNOWN, start: at, end: UNKNOWN, status: 'running', model: UNKNOWN, effort: UNKNOWN, effortSource: 'unknown', latest: UNKNOWN, counts: counts() } satisfies Run]
  // Active originating runs are retained even after their main turn ended.
  const pinned = new Set(l.agents.filter(a => a.status === 'running').map(a => a.runId))
  const kept = runs.filter((r, i) => i >= runs.length - LIMITS.runs || pinned.has(r.id)).slice(-(LIMITS.runs + LIMITS.agents))
  return { ...l, currentRun: id, turns: { ...l.turns, main: turnId }, runs: kept }
}
export const originOf = (l: Ledger, agentId?: string): Value<string> => agentId ? l.agents.find(a => a.id === agentId)?.runId ?? UNKNOWN : l.currentRun
export const addAgent = (l: Ledger, e: { agentId: string; subagentType: string; description?: string; model?: string; requestedModel?: string; parentAgentId?: string; source?: string; background?: boolean; originRun?: Value<string>; originTurn?: Value<string> }, at: number): Ledger => {
  const existing = l.agents.find(a => a.id === e.agentId)
  if (existing && existing.start !== UNKNOWN) return l
  const runId = e.originRun ?? originOf(l, e.parentAgentId)
  const a: LedgerAgent = { id: e.agentId, role: roleOf(e.subagentType), name: textOf(e.description), runId, originTurn: e.originTurn ?? l.turns[e.parentAgentId ?? 'main'] ?? UNKNOWN, parentAgent: e.parentAgentId ?? UNKNOWN, requestedModel: word(e.requestedModel), requestedEffort: UNKNOWN, model: word(e.model), effort: UNKNOWN, effortSource: 'unknown', start: at, end: UNKNOWN, status: 'running', latest: 'Starting', counts: counts(), source: word(e.source), background: e.background ?? UNKNOWN }
  const agents = [...l.agents.filter(old => old.id !== a.id), existing ? { ...a, counts: existing.counts, latest: existing.latest, model: existing.model === UNKNOWN ? a.model : existing.model, effort: existing.effort, effortSource: existing.effortSource, requestedEffort: existing.requestedEffort, status: existing.status, end: existing.end } : a]
  // Preserve live agents; admission applies independent resource budgets.
  const finished = agents.filter(a => a.status !== 'running').slice(-LIMITS.agents)
  return { ...l, agents: [...finished, ...agents.filter(a => a.status === 'running')],
    tools: l.tools.map(t => t.agentId === a.id && t.runId === UNKNOWN ? { ...t, runId } : t),
    requests: l.requests.map(r => r.agentId === a.id && r.runId === UNKNOWN ? { ...r, runId } : r),
    replay: l.replay.map(r => r.agentId === a.id && r.runId === UNKNOWN ? { ...r, runId } : r),
    runs: existing?.runId === UNKNOWN ? l.runs.map(r => r.id === runId ? { ...r, counts: { ...r.counts, ...Object.fromEntries(Object.entries(r.counts).filter(([k]) => k !== 'retries').map(([k, n]) => [k, (n as number) + (existing.counts[k as keyof Counts] as number)])), retries: UNKNOWN } } : r) : l.runs,
  }
}
export const warn = (l: Ledger, warning: string): Ledger => ({ ...l, warnings: [...l.warnings.filter(w => w !== warning), textOf(warning)].slice(-LIMITS.warnings) })
/**
 * One model request, as it went. `actual.via` says who put the effort on it:
 * `host` when it carried the level the engine resolved itself, which is then
 * the engine's own and an observation of what was applied; `hook` when this
 * plugin rewrote it, which the engine does not report back.
 */
export const recordRequest = (l: Ledger, e: { turnId: string; index: number; agentId?: string; model: string; effort?: unknown }, actual: { model?: string; effort?: unknown; usage?: Record<string, unknown> | null; routingReason?: string; fallbackReason?: string | null; via?: EffortVia }): Ledger => {
  const id = `${e.agentId ?? 'main'}:${e.turnId}:${e.index}`
  const runId = originOf(l, e.agentId)
  const u = actual.usage
  const model = word(u?.['model'] ?? actual.model)
  const effort = actual.effort === undefined ? UNKNOWN : textOf(String(actual.effort))
  const reason = actual.routingReason === undefined ? UNKNOWN : textOf(actual.routingReason)
  const fallback = actual.fallbackReason === undefined || actual.fallbackReason === null ? UNKNOWN : textOf(actual.fallbackReason)
  const isOwn = actual.via === 'host' && effort !== UNKNOWN
  const source = effort === UNKNOWN ? 'unknown' as const : isOwn ? 'engine' as const : 'request' as const
  const seen = { ...(actual.via === undefined ? {} : { effortVia: actual.via }), ...(isOwn ? { effectiveEffort: effort } : {}) }
  const request: Request = { id, runId, turnId: e.turnId, agentId: e.agentId ?? UNKNOWN, requestedModel: word(e.model), requestedEffort: e.effort === undefined ? UNKNOWN : textOf(String(e.effort)), model, effort, effectiveEffort: isOwn ? effort : UNKNOWN, input: numberOf(u?.['input_tokens']), output: numberOf(u?.['output_tokens']), cacheRead: numberOf(u?.['cache_read_input_tokens']), cacheWrite: numberOf(u?.['cache_creation_input_tokens']) }
  return { ...l, turns: Object.fromEntries(Object.entries({ ...l.turns, [e.agentId ?? 'main']: e.turnId }).filter(([key]) => key === 'main' || l.agents.some(a => a.id === key))), requests: [...l.requests.filter(r => r.id !== id), request].slice(-LIMITS.requests), runs: l.runs.map(r => r.id === runId && !e.agentId ? { ...r, model, effort, effortSource: source, ...seen, requestedEffort: request.requestedEffort, routingReason: reason, fallbackReason: fallback } : r), agents: l.agents.map(a => a.id === e.agentId ? { ...a, model, effort, effortSource: source, ...seen, requestedEffort: request.requestedEffort, routingReason: reason, fallbackReason: fallback } : a) }
}
export const finishTurn = (l: Ledger, e: { turnId: string; agentId?: string; reason: string }, at: number): Ledger => ({ ...l, runs: l.runs.map(r => !e.agentId && r.turnId === e.turnId ? { ...r, end: at, status: e.reason === 'answer' ? 'success' : e.reason } : r), agents: l.agents.map(a => a.id === e.agentId ? { ...a, end: at, status: e.reason === 'answer' ? 'success' : e.reason } : a) })
export const beginTool = (l: Ledger, e: Record<string, unknown>, at: number): Ledger => {
  const id = word(e['tool_use_id'])
  if (id === UNKNOWN || l.tools.some(t => t.id === id)) return l
  const agentId = typeof e['agentId'] === 'string' ? e['agentId'] : undefined
  const tool = word(e['tool'])
  const family = activityOf(tool, e).kind
  const entry: ToolEntry = { id, runId: originOf(l, agentId), turnId: l.turns[agentId ?? 'main'] ?? UNKNOWN, agentId: agentId ?? UNKNOWN, tool, family, durationMs: UNKNOWN, file: safeFile(e['file_path']), start: at, end: UNKNOWN, status: 'running', source: tool.startsWith('mcp__') ? word(tool.split('__')[1]) : 'engine' }
  const bump = (c: Counts): Counts => ({ ...c, tools: c.tools + 1, reads: c.reads + (tool === 'Read' ? 1 : 0), edits: c.edits + (tool === 'Edit' ? 1 : 0), writes: c.writes + (tool === 'Write' ? 1 : 0), tests: c.tests + (family === 'TEST' ? 1 : 0), builds: c.builds + (family === 'BUILD' ? 1 : 0), git: c.git + (family === 'GIT' ? 1 : 0) })
  return { ...l, tools: [...l.tools, entry].filter((t, i, all) => i >= all.length - LIMITS.tools || t.status === 'running').slice(-(LIMITS.tools + 64)), runs: l.runs.map(r => r.id === entry.runId ? { ...r, counts: bump(r.counts), latest: `${tool} ${entry.file === UNKNOWN ? family : entry.file}` } : r), agents: l.agents.map(a => a.id === agentId ? { ...a, counts: bump(a.counts), latest: `${tool} ${entry.file === UNKNOWN ? family : entry.file}` } : a) }
}
export const finishTool = (l: Ledger, id: string, failed: boolean, at: number): Ledger => {
  const tool = l.tools.find(t => t.id === id)
  if (!tool || tool.end !== UNKNOWN) return l
  return { ...l, tools: l.tools.map(t => t.id === id ? { ...t, end: at, status: failed ? 'failure' : 'success' } : t), runs: l.runs.map(r => failed && r.id === tool.runId ? { ...r, counts: { ...r.counts, failures: r.counts.failures + 1 } } : r), agents: l.agents.map(a => failed && a.id === tool.agentId ? { ...a, counts: { ...a.counts, failures: a.counts.failures + 1 } } : a) }
}
export const reading = (l: Ledger, context: { tokens?: number; window?: number; percent?: number }, at: number): Ledger => {
  const sample: Reading = { at, turnId: l.turns['main'] ?? UNKNOWN, tokens: numberOf(context.tokens), window: numberOf(context.window), percent: numberOf(context.percent) }
  const last = l.usage.at(-1)
  if (last && last.turnId === sample.turnId && last.tokens === sample.tokens && last.window === sample.window && last.percent === sample.percent) return l
  return { ...l, usage: [...l.usage, sample].slice(-LIMITS.usage) }
}
export const receipts = (l: Ledger, events: readonly NwhoEvent[]): Ledger => ({ ...l, receipts: [...l.receipts, ...events.filter(e => !l.receipts.some(old => old.requestId === e.requestId))].filter((e, i, all) => all.findIndex(x => x.requestId === e.requestId) === i).slice(-LIMITS.receipts) })
export const checkpointOf = (l: Ledger, task: Task | null, git: GitState | null, at: number): Checkpoint => ({ at, goal: task?.milestones.length && task.goal !== task.lastPrompt ? textOf(task.goal) : UNKNOWN, phase: task?.phase ?? UNKNOWN, completed: task?.milestones.filter(m => m.state === 'done').map(m => textOf(m.title)) ?? [], remaining: task?.milestones.filter(m => m.state !== 'done').map(m => textOf(m.title)) ?? [], latest: l.tools.at(-1)?.tool ?? UNKNOWN, gates: Object.fromEntries(Object.entries(task?.gates ?? {}).map(([k, g]) => [k, g.state])), branch: word(git?.branch), startingSha: word(git?.startSha), currentSha: word(git?.sha), repo: word(git?.project), dirty: git?.isRepo ? numberOf(git.dirty) : UNKNOWN, blockers: task?.blocker ? [textOf(task.blocker)] : [], backgroundAgents: l.agents.filter(a => a.status === 'running').map(a => a.id) })
export const withReplay = (l: Ledger, step: ReplayStep): Ledger => ({ ...l, replay: appendReplay(l.replay, step) })
// Export explicitly excludes snapshots and any checkpoint prose. Only typed telemetry.
export const exportJSON = (l: Ledger): string => JSON.stringify({ schema: l.schema, sessionId: l.sessionId, swarm: l.swarm, runs: l.runs, agents: l.agents.map(({ name: _name, ...a }) => a), tools: l.tools, requests: l.requests, usage: l.usage, nobodywho: l.receipts, warnings: l.warnings, replay: l.replay.map(({ before: _before, after: _after, ...s }) => s), checkpoint: l.checkpoint === null ? null : { at: l.checkpoint.at, phase: l.checkpoint.phase, gates: l.checkpoint.gates, branch: l.checkpoint.branch, startingSha: l.checkpoint.startingSha, currentSha: l.checkpoint.currentSha, repo: l.checkpoint.repo, dirty: l.checkpoint.dirty, backgroundAgents: l.checkpoint.backgroundAgents } }, (_key, value: unknown) => typeof value === 'string' ? (secretText(value) ? UNKNOWN : safeText(value)) : value, 2)
export const ledgerLines = (l: Ledger, now: number, auth: string = UNKNOWN): string[] => {
  const run = l.runs.find(r => r.id === l.currentRun) ?? l.runs.at(-1)
  const tokens = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => l.requests.length === 0 || l.requests.some(r => r[key] === UNKNOWN) ? UNKNOWN : l.requests.reduce((sum, r) => sum + (r[key] as number), 0)
  const tierCounts = (op: 'decision' | 'prune', tiers: string[]) => tiers.map(t => `${t} ${l.receipts.filter(e => e.op === op && e.tier === t).length}`).join(' · ')
  const ns = (key: 'proposed' | 'accepted' | 'rejected') => l.receipts.some(e => e[key] !== null) ? l.receipts.reduce((s, e) => s + (e[key] ?? 0), 0) : UNKNOWN
  const rows = ['COBALT CONTROL / RUN LEDGER', `AUTH / ${auth}`, '01 RUN', `session ${l.sessionId}`, `run ${run?.id ?? UNKNOWN} · turn ${run?.turnId ?? UNKNOWN}`, `status ${run?.status ?? UNKNOWN} · elapsed ${run ? elapsed(run.start, run.end, now) : UNKNOWN}ms`, `main ${run?.model ?? UNKNOWN} · ${run?.effort ?? UNKNOWN} (${run?.effortSource ?? UNKNOWN}) · coordinator`, `reasoning requested ${run?.requestedEffort ?? UNKNOWN} · applied ${run?.effort ?? UNKNOWN} · observed ${run?.effectiveEffort ?? UNKNOWN}`, ...(run && run.routingReason !== undefined && run.routingReason !== UNKNOWN ? [`reason ${run.routingReason}`] : []), ...(run && run.fallbackReason !== undefined && run.fallbackReason !== UNKNOWN ? [`fallback ${run.fallbackReason}`] : []), '02 ORCHESTRATION', 'MAIN → delegate → integrate → verify (observed)', ...l.warnings.map(w => `WARNING ${w}`), '03 SUBAGENTS']
  for (const a of l.agents) rows.push(`TASK ${a.name}`, `CLAUDE role ${a.role} · requested ${a.requestedModel} / ${a.requestedEffort}`, `ACTUAL ${a.model} · ${a.effort} (${a.effortSource}) · observed ${a.effectiveEffort ?? UNKNOWN}${a.fallbackReason !== undefined && a.fallbackReason !== UNKNOWN ? ` · fallback ${a.fallbackReason}` : ''} · ${a.id}`, `origin ${a.runId} / ${a.originTurn} · parent ${a.parentAgent}`, 'NOBODYWHO decision unknown · pruning unknown (no agent correlation in receipts)', `RESULT ${a.status} · ${elapsed(a.start, a.end, now)}ms · tools ${a.counts.tools} · reads ${a.counts.reads} · edits ${a.counts.edits} · writes ${a.counts.writes} · retries ${a.counts.retries}`, `latest ${a.latest}`)
  rows.push('04 NOBODYWHO', `DECISION ${tierCounts('decision', ['P0', '0.6B', '9B'])}`, `PRUNING ${tierCounts('prune', ['P0', 'Q4B', '9B'])}`, `proposed ${ns('proposed')} · accepted ${ns('accepted')} · rejected ${ns('rejected')}`)
  for (const e of l.receipts.slice(-8)) rows.push(`${e.op} ${e.tier} · ${e.route ?? UNKNOWN} · ${e.latencyMs}ms · abstention ${e.abstention ?? UNKNOWN} · fallback ${e.fallbackTier ?? UNKNOWN}`)
  rows.push('05 USAGE', `context ${l.usage.at(-1)?.tokens ?? UNKNOWN} / ${l.usage.at(-1)?.window ?? UNKNOWN} · ${l.usage.at(-1)?.percent ?? UNKNOWN}%`, `retained request tokens: input ${tokens('input')} · output ${tokens('output')} · cache read ${tokens('cacheRead')} · cache write ${tokens('cacheWrite')}`, `context trend ${l.usage.slice(-12).map(s => s.percent === UNKNOWN ? '?' : `${s.percent}%`).join(' → ')}`, '06 FILES', `read paths ${new Set(l.tools.filter(t => t.tool === 'Read' && t.file !== UNKNOWN).map(t => t.file)).size} · changed paths ${new Set(l.tools.filter(t => (t.tool === 'Edit' || t.tool === 'Write') && t.status === 'success' && t.file !== UNKNOWN).map(t => t.file)).size} (retained history)`)
  for (const t of l.tools.filter(t => t.file !== UNKNOWN).slice(-32)) rows.push(`${t.tool} ${t.file} · ${t.status}`)
  rows.push('07 FAILURES / RETRIES', `tools ${run?.counts.tools ?? 0} · failures ${run?.counts.failures ?? 0} · retries unknown`)
  for (const t of l.tools.filter(t => t.status === 'failure').slice(-12)) rows.push(`${t.id} · ${t.tool} · failure`)
  rows.push('08 VERIFICATION', ...Object.entries(l.checkpoint?.gates ?? {}).map(([k, v]) => `${k} ${v}`), `git ${l.checkpoint?.branch ?? UNKNOWN} · ${l.checkpoint?.currentSha ?? UNKNOWN} · dirty ${l.checkpoint?.dirty ?? UNKNOWN}`, '09 REPLAY / HISTORY', `${l.replay.length} snapshots · /replay · ${l.runs.length} runs`, 'Bounded observed history; unknown means unexposed or unobserved. No cost estimates.')
  if (l.swarm?.tasks.length) {
    rows.push('10 ELASTIC SWARM', `wave ${l.swarm.wave} · requested ${l.swarm.requested} · actual ${l.swarm.actual} · high-water ${l.swarm.highWater} · conflicts ${l.swarm.conflicts}`)
    for (const t of l.swarm.tasks) rows.push(`${t.id} ${t.tier} ${t.role} · ${t.state} · effort ${t.requestedEffort}${t.appliedEffort ? ` → ${t.appliedEffort}` : ''} · agent ${t.agentId ?? UNKNOWN} · parent ${t.parentTask ?? UNKNOWN}/${t.parentAgent ?? UNKNOWN}`, `why ${t.spawnReason} · objective ${t.objective}`, `ownership ${t.mode} ${t.owned.join(', ')} · dependencies ${t.dependencies.join(', ') || 'none'} · wave ${t.wave}`, `result ${t.result?.conclusion ?? UNKNOWN} · verification ${t.verification}${t.escalation ? ` · escalation ${t.tier} → ${t.escalation.to}: ${t.escalation.question}` : ''}${t.effortEscalation ? ` · effort escalation ${t.effortEscalation.from} → ${t.effortEscalation.to}: ${t.effortEscalation.reason}` : ''}`)
    rows.push(`Lifecycle ${l.swarm.events.length} retained events · ${l.swarm.droppedEvents} evicted · /replay`)
  }
  return rows
}


export const STORE_LEDGER_BYTES = 384_000
export const jsonBytes = (value: unknown): number => [...JSON.stringify(value)].reduce((n, ch) => { const cp = ch.codePointAt(0)!; return n + (cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4) }, 0)
export const storageLedger = (ledger: Ledger): Ledger => {
  let l = { ...ledger, tools: [...ledger.tools], requests: [...ledger.requests], replay: [...ledger.replay], receipts: [...ledger.receipts] }
  // Keep live agents, their originating runs, and counters. Evict oldest detail.
  while (jsonBytes(l) > STORE_LEDGER_BYTES) {
    if (l.tools.length > 32) l.tools = l.tools.slice(Math.max(1, Math.floor(l.tools.length / 4)))
    else if (l.requests.length > 32) l.requests = l.requests.slice(Math.max(1, Math.floor(l.requests.length / 4)))
    else if (l.replay.length > 1) l.replay = l.replay.slice(Math.max(1, Math.floor(l.replay.length / 4)))
    else if (l.swarm && l.swarm.events.length > 8) l = { ...l, swarm: { ...l.swarm, events: l.swarm.events.slice(Math.max(1,Math.floor(l.swarm.events.length / 4))), droppedEvents: l.swarm.droppedEvents + Math.max(1,Math.floor(l.swarm.events.length / 4)) } }
    else if (l.swarm?.tasks.some(t => t.result && (t.result.evidence.length || t.result.changes.length || t.result.verification.length || t.result.conclusion.length > 160) || t.escalation && (t.escalation.evidence.length || t.escalation.discoveries.length))) l = { ...l, swarm: { ...l.swarm, tasks: l.swarm.tasks.map(t => ({ ...t, result: t.result ? { ...t.result, conclusion: t.result.conclusion.slice(0,160), evidence:[], changes:[], verification:[], unresolved:['Stored detail pruned; commander verification unchanged'], confidence:null, escalation:null, rawRef:null } : null, escalation: t.escalation ? { ...t.escalation, evidence:[], discoveries:[], question:t.escalation.question.slice(0,160), nextAction:t.escalation.nextAction.slice(0,160), locations:t.escalation.locations.slice(0,4) } : null })) } }
    else if (l.receipts.length > 8) l.receipts = l.receipts.slice(Math.max(1, Math.floor(l.receipts.length / 4)))
    else break
  }
  return l
}


export const adoptAgent = (l: Ledger, info: { id: string; type: string; description: string; status: string; parentId?: string; spawnedBy?: string }): Ledger => {
  if (l.agents.some(a => a.id === info.id)) return l
  const adopted = addAgent(l, { agentId: info.id, subagentType: info.type, description: info.description, parentAgentId: info.parentId, source: info.spawnedBy, originRun: UNKNOWN, originTurn: UNKNOWN }, 0)
  return { ...adopted, agents: adopted.agents.map(a => a.id === info.id ? { ...a, start: UNKNOWN, status: info.status === 'completed' ? 'success' : textOf(info.status) } : a) }
}


export const classicTelemetry = (l: Ledger, e: { tool_use_id: string; agent_id?: string; effort?: { level: string }; duration_ms?: number; mcp_server?: { name: string; source: string } }, sent?: EffortVia): Ledger => {
  const tool = l.tools.find(t => t.id === e.tool_use_id)
  const runId = tool?.runId ?? originOf(l, e.agent_id)
  // The engine reports the level its own settings resolve for the loop. A level
  // this plugin rewrote onto the request in `turn.step` is not in that report,
  // so for such a loop the report is not what was applied and is not recorded.
  // `sent` is the channel of a request still in flight, not in the ledger yet.
  const via = sent ?? (e.agent_id === undefined ? l.runs.find(r => r.id === runId)?.effortVia : l.agents.find(a => a.id === e.agent_id)?.effortVia)
  const level = e.effort === undefined || via === 'hook' ? UNKNOWN : word(e.effort.level)
  const last = [...l.requests].reverse().find(r => r.agentId === (e.agent_id ?? UNKNOWN) && r.turnId === tool?.turnId)
  return { ...l,
    tools: l.tools.map(t => t.id === e.tool_use_id ? { ...t, durationMs: numberOf(e.duration_ms), source: e.mcp_server === undefined ? t.source : `${word(e.mcp_server.name)} (${word(e.mcp_server.source)})` } : t),
    requests: l.requests.map(r => level !== UNKNOWN && r.id === last?.id ? { ...r, effectiveEffort: level } : r),
    runs: l.runs.map(r => level !== UNKNOWN && !e.agent_id && r.id === runId ? { ...r, effort: level, effortSource: 'engine' as const, effectiveEffort: level } : r),
    agents: l.agents.map(a => level !== UNKNOWN && a.id === e.agent_id ? { ...a, effort: level, effortSource: 'engine' as const, effectiveEffort: level } : a),
  }
}

/** Upgrade retained v1 histories without inventing missing assignments. */
export const migrateLedger = (l: Ledger): Ledger => ({ ...l, schema: 2, swarm: l.swarm ?? emptySwarm() })
