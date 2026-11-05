// The live activity timeline. Two real sources only: the supervisor's hash-chained ledger (routing,
// admission, gates, integration, failures, retries, escalations, budget, verdicts), tailed by byte
// offset, and the worker's own Cline event stream (tool calls, edits, commands). Nothing is
// inferred or synthesised; an event the sources do not report is not shown.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Token } from './term.ts'
import { sanitize } from './term.ts'

export type EventKind =
  | 'queued' | 'admit' | 'start' | 'waiting' | 'refused' | 'tool' | 'read' | 'scan' | 'edit' | 'command' | 'test' | 'abort'
  | 'exit' | 'gate' | 'integrate' | 'fail' | 'retry' | 'correct' | 'escalate' | 'stop' | 'cancel' | 'budget' | 'health'
  | 'plan' | 'delegate' | 'ended' | 'final' | 'verdict' | 'held' | 'info'
export type TimelineEvent = {
  seq: number; at: number; kind: EventKind; task: string | null; attempt: string | null
  source: 'supervisor' | 'worker'; text: string; detail: string[]; tone: Token
}

const GLYPH: Record<EventKind, string> = {
  queued: '+', admit: '→', start: '▶', waiting: '…', refused: '⊘', tool: '•', read: '◇', scan: '⌕', edit: '✎', command: '$', test: '⚑', abort: '■',
  exit: '◁', gate: '◆', integrate: '⇢', fail: '✗', retry: '⟳', correct: '↺', escalate: '⇧', stop: '■', cancel: '⊘', budget: '¤', health: '⚠',
  plan: '◈', delegate: '⑂', ended: '●', final: '◆', verdict: '◉', held: '■', info: '·',
}
export const glyphOf = (k: EventKind): string => GLYPH[k]

const TEST_CMD = /\b(?:test|tests|jest|vitest|mocha|pytest|cargo\s+test|go\s+test|node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|tsc|typecheck|lint)\b/i
const clip = (s: unknown, n = 160): string => sanitize(String(s ?? '')).replace(/\s+/g, ' ').trim().slice(0, n)
const attemptNo = (attempt: unknown): string => { const m = /\.(\d+)$/.exec(String(attempt ?? '')); return m ? `#${m[1]}` : '' }

export type LedgerEntry = { seq: number; at: string; kind: string; task: string | null; data: Record<string, unknown> | null }

/** One ledger entry as a timeline event, or null for bookkeeping that is not activity. */
export const fromLedger = (e: LedgerEntry): Omit<TimelineEvent, 'seq'> | null => {
  const d = (e.data ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const at = Date.parse(e.at) || 0
  const base = { at, task: e.task, attempt: typeof d.attempt === 'string' ? d.attempt : null, source: 'supervisor' as const }
  const ev = (kind: EventKind, text: string, tone: Token, detail: string[] = []): Omit<TimelineEvent, 'seq'> => ({ ...base, kind, text: clip(text, 220), tone, detail: detail.map(x => clip(x, 400)).filter(Boolean) })
  switch (e.kind) {
    case 'task_added': { const s = d.spec ?? {}; return ev('queued', `queued · ${s.kind}/${s.risk} ${s.mode} · ${d.source ?? ''}`, 'label', [`title: ${s.title ?? ''}`, `owns: ${(s.owned ?? []).join(', ')}`, s.dependencies?.length ? `after: ${s.dependencies.join(', ')}` : '']) }
    case 'attempt_admitted': { const r = d.route ?? {}; return ev('admit', `${attemptNo(d.attempt)} routed → ${r.role} ${r.model} · ${r.requestedReasoning ?? '?'}→${r.expectedWireEffort ?? '?'}`, 'head', [`rules: ${(r.rules ?? []).join('; ')}`, r.signals?.length ? `signals: ${r.signals.join(', ')}` : '', r.estimateUsd != null ? `reserved estimate: $${Number(r.estimateUsd).toFixed(4)} (${r.pricingSource ?? 'pricing'})` : 'no pricing: cost would be unmetered']) }
    case 'attempt_bound': return ev('start', `${attemptNo(d.attempt)} sandbox up · init pid ${d.initPid ?? '?'}`, 'label', [`pid namespace ${d.pidNs ?? '?'}`])
    case 'worker_exited': { const ok = d.finish === 'completed'; return ev('exit', `${attemptNo(d.attempt)} worker exited · ${d.finish ?? d.stoppedBy ?? '?'} · exit ${d.exit ?? '—'}${d.wire?.state ? ` · wire ${d.wire.state}` : ''}`, ok ? 'label' : 'warn', [d.wire?.detail ? `wire: ${d.wire.detail}` : '', d.census?.detail ? `census: ${d.census.detail}` : '', d.aborted ? `aborted: ${d.aborted}` : '']) }
    case 'gates': { const gs = (d.gates ?? []) as { name: string; state: string; exit: number | null; evidence: string }[]; const bad = gs.filter(g => g.state !== 'pass'); return ev('gate', `${attemptNo(d.attempt)} gates ${gs.map(g => `${g.name} ${g.state === 'pass' ? '✓' : '✗'}`).join(' ')}`, bad.length ? 'fail' : 'ok', gs.map(g => `${g.name}: ${g.state}${g.exit != null ? ` (exit ${g.exit})` : ''} · ${g.evidence ?? ''}`)) }
    case 'integrated': return ev('integrate', `${attemptNo(d.attempt)} integrated ${String(d.commit ?? '').slice(0, 8)} → branch @${String(d.head ?? '').slice(0, 8)}`, 'ok')
    case 'attempt_failed': return ev('fail', `${attemptNo(d.attempt)} failed · ${d.class}: ${d.detail ?? ''}`, 'fail', [String(d.detail ?? '')])
    case 'next_step': {
      const why = String(d.reason ?? '')
      if (d.action === 'retry_same') return ev('retry', `retry on the same model${d.delayMs ? ` in ${Math.ceil(d.delayMs / 1000)}s` : ''} · ${why}`, 'warn')
      if (d.action === 'correct') return ev('correct', `correction on the same model · ${why}`, 'warn')
      if (d.action === 'escalate') return ev('escalate', `escalate → ${d.to} · ${why}`, 'accent')
      return ev('stop', `no further attempt · ${why}`, 'fail')
    }
    case 'route_waiting': return ev('waiting', `admission waits · ${d.refusal ?? ''}`, 'warn')
    case 'route_refused': return ev('refused', `route refused · ${d.refusal ?? ''}`, 'fail', [(d.rules ?? []).join('; ')])
    case 'task_refused': return ev('refused', `refused · ${d.reason ?? ''}`, 'fail')
    case 'task_ended': return ev('ended', `${d.state} · ${d.attempts} attempt(s)${typeof d.usd === 'number' ? ` · $${d.usd.toFixed(4)}` : ''}${d.verification ? ` · ${d.verification}` : ''}`, d.state === 'completed' ? 'ok' : d.state === 'cancelled' ? 'warn' : 'fail', d.reason ? [String(d.reason)] : [])
    case 'provider_health': return ev('health', `provider ${d.key} breaker ${d.unhealthy ? 'OPEN' : 'closed'} after ${d.consecutiveErrors} error(s) · concurrency ${d.concurrency ?? '?'}`, d.unhealthy ? 'fail' : 'warn')
    case 'budget_alert': return ev('budget', `budget ${d.scope ?? ''} ${Math.round(Number(d.at ?? 0) * 100)}% · ${d.detail ?? ''}`, 'warn')
    case 'session_cap': return ev('budget', `session cap reached · ${clip(JSON.stringify(d), 120)}`, 'fail')
    case 'unmetered': return ev('budget', `usage unmetered · ${clip(d.detail ?? JSON.stringify(d), 140)}`, 'warn')
    case 'plan_accepted': return ev('plan', `Kimi plan accepted · ${(d.tasks ?? []).length} task(s)${(d.dropped ?? []).length ? ` · ${(d.dropped ?? []).length} dropped` : ''}`, 'accent', [`tasks: ${(d.tasks ?? []).join(', ')}`, d.design ? `design: ${d.design}` : '', ...(d.dropped ?? []).map((x: string) => `dropped: ${x}`)])
    case 'plan_rejected': return ev('fail', `plan rejected · ${d.reason ?? ''}`, 'fail')
    case 'delegation': return ev('delegate', `delegation · admitted ${(d.admitted ?? []).length}, refused ${(d.refused ?? []).length}`, 'label', [...(d.admitted ?? []).map((x: string) => `admitted ${x}`), ...(d.refused ?? []).map((x: string) => `refused ${x}`)])
    case 'delegation_refused': return ev('refused', `delegation refused · ${d.reason ?? ''}`, 'fail')
    case 'cancel_requested': return ev('cancel', `cancel requested${d.why ? ` · ${d.why}` : ''}`, 'warn')
    case 'stop_requested': return ev('stop', `stop requested · ${d.why ?? ''}`, 'warn')
    case 'stop_cleared': return ev('info', `earlier stop cleared · ${d.was ?? ''}`, 'label')
    case 'attempt_held': return ev('held', `${attemptNo(d.attempt)} HELD: processes not accounted for; ownership kept`, 'fail', [clip(JSON.stringify(d), 300)])
    case 'final_gates': { const gs = (Array.isArray(d) ? d : d.gates ?? []) as { name: string; state: string }[]; return ev('final', `branch gates${d.head ? ` @${String(d.head).slice(0, 8)}` : ''} ${gs.map(g => `${g.name} ${g.state === 'pass' ? '✓' : '✗'}`).join(' ') || 'none configured'}`, gs.some(g => g.state !== 'pass') ? 'fail' : 'ok') }
    case 'mission_verdict': return ev('verdict', `verdict ${d.state}`, d.state === 'DONE' ? 'ok' : d.state === 'BLOCKED' || d.state === 'FAILED' ? 'fail' : 'warn', (d.reasons ?? []).map(String))
    case 'reconciled': case 'supervisor_takeover': case 'integration_head_drift': case 'config_changed': case 'reconcile_kill': case 'gate_artifacts_removed': case 'observer_error': case 'bind_failed': case 'attempt_not_launched': case 'engine_finish_error': case 'conversation_closed':
      return ev('info', `${e.kind.replace(/_/g, ' ')}${d.attempt ? ` ${attemptNo(d.attempt)}` : ''}`, e.kind === 'reconcile_kill' || e.kind === 'bind_failed' ? 'warn' : 'label', [clip(JSON.stringify(d), 300)])
    default: return null // ownership_released, mission_created: bookkeeping
  }
}

/** One Cline stream event from a worker, as a timeline event, or null when it is not activity. */
export const fromWorker = (task: string, attempt: string, e: Record<string, unknown>, now: number): Omit<TimelineEvent, 'seq'> | null => {
  const ev = (e.event ?? {}) as Record<string, unknown>
  const base = { at: now, task, attempt, source: 'worker' as const, detail: [] as string[] }
  if (e.type === 'run_aborted') return { ...base, kind: 'abort', text: `run aborted · ${clip(e.message ?? e.reason, 160)}`, tone: 'warn' }
  if (!(e.type === 'agent_event' && ev.type === 'content_start' && ev.contentType === 'tool' && typeof ev.toolName === 'string')) return null
  const tool = ev.toolName as string
  const input = (ev.input ?? {}) as Record<string, unknown>
  const paths = Array.isArray(input.paths) ? input.paths.map(String) : typeof input.path === 'string' ? [input.path] : []
  const shortPath = (p: string): string => p.replace(/^.*\/worktrees\/[^/]+\/[^/]+\//, '').replace(/^.*\/integration\//, '')
  if (Array.isArray(input.commands) || typeof input.command === 'string') {
    const cmds = (Array.isArray(input.commands) ? input.commands : [input.command]).map(c => clip(c, 200))
    const test = cmds.some(c => TEST_CMD.test(c))
    return { ...base, kind: test ? 'test' : 'command', text: `${cmds[0]}${cmds.length > 1 ? ` (+${cmds.length - 1})` : ''}`, tone: test ? 'scan' : 'label', detail: cmds }
  }
  if (/edit|write|replace|patch|create|insert/i.test(tool)) return { ...base, kind: 'edit', text: `${tool} ${paths.map(shortPath).join(', ') || ''}`.trim(), tone: 'head', detail: paths.map(shortPath) }
  if (/read/i.test(tool)) return { ...base, kind: 'read', text: `read ${paths.length > 2 ? `${paths.length} files` : paths.map(shortPath).join(', ')}`, tone: 'label', detail: paths.map(shortPath) }
  if (/search|list|find|grep/i.test(tool)) return { ...base, kind: 'scan', text: `${tool} ${clip(input.query ?? input.pattern ?? input.regex ?? input.path ?? '', 80)}`.trim(), tone: 'scan', detail: [] }
  return { ...base, kind: 'tool', text: tool, tone: 'label', detail: [clip(JSON.stringify(input), 300)] }
}

/** What one worker is doing right now, from its own stream. */
export type Activity = { last: string; kind: EventKind; at: number; tools: number; edits: Set<string>; commands: number; tests: number; textChars: number }

export class Timeline {
  readonly events: TimelineEvent[] = []
  readonly activity = new Map<string, Activity>()
  private seq = 0
  constructor(readonly max = 5000) {}
  push(e: Omit<TimelineEvent, 'seq'> | null): void {
    if (!e) return
    this.events.push({ ...e, seq: ++this.seq })
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max)
  }
  /** A worker stream event: activity counters always; a timeline event when it is one. */
  worker(task: string, attempt: string, e: Record<string, unknown>, now = Date.now()): boolean {
    const a = this.activity.get(attempt) ?? { last: '', kind: 'info' as EventKind, at: now, tools: 0, edits: new Set<string>(), commands: 0, tests: 0, textChars: 0 }
    const ev = (e.event ?? {}) as Record<string, unknown>
    if (e.type === 'agent_event' && ev.type === 'content_start' && ev.contentType === 'text' && typeof ev.text === 'string') {
      a.textChars += ev.text.length; if (a.kind !== 'edit' && a.kind !== 'command' && a.kind !== 'test') { a.last = 'writing its answer'; a.kind = 'info' } a.at = now
      this.activity.set(attempt, a); return false
    }
    const t = fromWorker(task, attempt, e, now)
    if (!t) { this.activity.set(attempt, a); return false }
    a.tools++; a.last = t.text; a.kind = t.kind; a.at = now
    if (t.kind === 'edit') for (const p of t.detail) a.edits.add(p)
    if (t.kind === 'command') a.commands++
    if (t.kind === 'test') { a.commands++; a.tests++ }
    this.activity.set(attempt, a)
    this.push(t)
    return true
  }
}

/**
 * Reads new ledger entries since the last poll, by byte offset across segment files. Partial last
 * lines (a write in progress) are kept for the next poll. Never writes.
 */
export class LedgerTail {
  private seg = ''
  private offset = 0
  private rest = ''
  // a read can end inside a multi-byte character; the decoder keeps it for the next read
  private dec = new StringDecoder('utf8')
  constructor(readonly dir: string) {}
  poll(limitBytes = 4 << 20): LedgerEntry[] {
    if (!existsSync(this.dir)) return []
    const segs = readdirSync(this.dir).filter(f => /^seg-\d+\.jsonl$/.test(f)).sort()
    const out: LedgerEntry[] = []
    let budget = limitBytes
    for (const s of segs) {
      if (this.seg && s < this.seg) continue
      if (s !== this.seg) { this.seg = s; this.offset = 0; this.rest = ''; this.dec = new StringDecoder('utf8') }
      const fd = openSync(join(this.dir, s), 'r')
      try {
        const size = fstatSync(fd).size
        if (size <= this.offset) continue
        const n = Math.min(size - this.offset, budget)
        const buf = new Uint8Array(n)
        readSync(fd, buf, 0, n, this.offset)
        this.offset += n; budget -= n
        const text = this.rest + this.dec.write(Buffer.from(buf))
        const lines = text.split('\n'); this.rest = lines.pop() ?? ''
        for (const l of lines) { if (!l) continue; try { out.push(JSON.parse(l) as LedgerEntry) } catch { /* torn line */ } }
      } finally { closeSync(fd) }
      if (budget <= 0) break
    }
    return out
  }
}
