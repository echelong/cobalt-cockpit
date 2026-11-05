// Mission control screen. Every figure comes from the durable mission state the
// supervisor writes; nothing is interpolated. Unknown is shown as "—", never guessed.
import type { Header, Live, AttemptRecord } from './supervisor.ts'
import type { Claim } from './store.ts'
import { usd } from './cost.ts'

const C = process.env.NO_COLOR ? { b: '', d: '', r: '', g: '', y: '', red: '', c: '', x: '' } : { b: '\x1b[1m', d: '\x1b[2m', r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', c: '\x1b[36m', x: '\x1b[35m' }
const pad = (s: string, n: number): string => { const v = s.length > n ? `${s.slice(0, n - 1)}…` : s; return v + ' '.repeat(Math.max(0, n - v.length)) }
const num = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
const ago = (iso: string | null, now: number): string => { if (!iso) return '—'; const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` }
const stateColor = (s: string): string => ({ DONE: C.g, completed: C.g, running: C.c, verifying: C.c, PARTIAL: C.y, queued: C.d, UNVERIFIED: C.y, held: C.red, BLOCKED: C.red, failed: C.red, FAILED: C.red, refused: C.y, cancelled: C.y, STOPPED: C.y } as Record<string, string>)[s] ?? ''

export const reasoningCell = (a: Pick<AttemptRecord, 'requestedReasoning' | 'expectedWire' | 'wire'>): string => {
  const eff = a.wire?.state === 'confirmed' ? `${a.wire.effective}✓` : a.wire?.state === 'mismatch' ? `${a.wire.effective ?? '?'}✗` : a.wire?.state === 'unconfirmed' ? 'unconfirmed' : `${a.expectedWire ?? '—'}?`
  return `${a.requestedReasoning ?? '—'}→${eff}`
}

export const render = (h: Header, live: Live, claims: Claim[], now = Date.now(), width = process.stdout.columns ?? 120): string => {
  const out: string[] = []
  const line = (s = ''): void => { out.push(s) }
  const done = live.counters.completed, total = live.counters.created
  const v = live.verdict
  line(`${C.b}COBALT COCKPIT · CLINE${C.r}  mission ${h.id}  ${stateColor(live.state)}${live.state.toUpperCase()}${C.r}${v ? `  verdict ${stateColor(v.state)}${C.b}${v.state}${C.r}` : ''}`)
  line(`${C.d}repo ${h.repoRoot} · branch ${live.integration.branch} @ ${live.integration.head.slice(0, 10)} · profile ${h.profile} · ${h.strict ? 'strict' : 'non-strict'} · ${h.mode} (${h.modeReason}) · updated ${ago(live.updatedAt, now)} ago${C.r}`)
  const barW = 30; const fill = total ? Math.round((done / total) * barW) : 0
  line(`progress ${C.g}${'█'.repeat(fill)}${C.d}${'░'.repeat(barW - fill)}${C.r} ${done}/${total} tasks verified+integrated  · failed ${live.counters.failed} · refused ${live.counters.refused} · cancelled ${live.counters.cancelled} · attempts ${live.counters.attempts}`)
  const s = live.session
  line(`cost ${C.b}${usd(s.unmetered ? null : s.spentUsd)}${C.r}${s.unmetered ? ` ${C.red}UNMETERED (${s.unmeteredTasks.length})${C.r}` : ''} · tokens ${num(s.tokens)}${s.capReached ? ` · ${C.red}SESSION CAP REACHED${C.r}` : ''}`)
  line('')
  line(`${C.b}${pad('JOB', 22)}${pad('ROLE', 11)}${pad('PROVIDER/MODEL', 40)}${pad('REASONING req→eff', 20)}${pad('PHASE', 10)}${pad('PID/NS', 16)}${pad('IT', 4)}${pad('TOOLS', 7)}${pad('TOKENS in/out/cache', 22)}${pad('COST', 10)}${pad('OWNS', 18)}AGE${C.r}`)
  const tasks = Object.values(live.tasks)
  const active = tasks.flatMap(t => t.attempts.filter(a => a.phase !== 'ended').map(a => ({ t, a })))
  if (!active.length) line(`${C.d}  no active workers${C.r}`)
  for (const { t, a } of active) {
    const tools = Object.values(a.toolCalls).reduce((x, y) => x + y, 0)
    const ns = a.identity ? `${a.identity.initPid ?? '?'}/${(a.identity.pidNs ?? '?').replace(/^pid:\[|\]$/g, '')}` : '—'
    line(`${pad(`${t.spec.id}#${a.n}`, 22)}${pad(a.role, 11)}${pad(`${a.provider}/${a.model}`, 40)}${pad(reasoningCell(a), 20)}${stateColor(a.phase === 'held' ? 'held' : 'running')}${pad(a.phase, 10)}${C.r}${pad(ns, 16)}${pad(String(a.iterations || '—'), 4)}${pad(String(tools), 7)}${pad(a.usageEvents ? `${num(a.usage.inputTokens)}/${num(a.usage.outputTokens)}/${num(a.usage.cacheReadTokens)}` : '—', 22)}${pad(usd(a.charge.usd) + (a.charge.basis === 'estimate' ? '~' : ''), 10)}${pad(t.spec.owned.join(','), 18)}${ago(a.startedAt, now)}`)
  }
  const queued = tasks.filter(t => t.state === 'queued' || t.state === 'verifying' || t.state === 'held')
  if (queued.length) {
    line('')
    line(`${C.b}QUEUE / VERIFYING / HELD${C.r}`)
    for (const t of queued.slice(0, 12)) line(`  ${stateColor(t.state)}${pad(t.state, 10)}${C.r}${pad(t.spec.id, 22)}${pad(`p${t.spec.priority ?? 5} ${t.spec.kind}/${t.spec.risk}/c${t.spec.complexity}`, 26)}${C.d}${(t.reason ?? '').slice(0, Math.max(20, width - 62))}${C.r}`)
    if (queued.length > 12) line(`  … ${queued.length - 12} more`)
  }
  const finishedLive = tasks.filter(t => ['completed', 'failed', 'refused', 'cancelled'].includes(t.state))
  const recent = [...finishedLive.map(t => ({ id: t.spec.id, state: t.state, role: t.attempts.at(-1)?.role ?? null, model: t.attempts.at(-1)?.model ?? null, usd: t.attempts.reduce((x, a) => x + (a.charge.usd ?? 0), 0), gates: t.attempts.at(-1)?.gates ?? [] })), ...live.recent.map(r => ({ ...r, gates: [] as { name: string; state: string }[] }))].slice(0, 10)
  if (recent.length) {
    line('')
    line(`${C.b}RECENT${C.r}`)
    for (const r of recent) line(`  ${stateColor(r.state)}${pad(r.state, 10)}${C.r}${pad(r.id, 22)}${pad(r.role ?? '—', 11)}${pad(r.model ?? '—', 38)}${pad(usd(r.usd), 10)}${r.gates.map(g => `${g.name}:${g.state}`).join(' ')}`)
  }
  line('')
  line(`${C.b}GATES (mission branch)${C.r} ${live.finalGates.length ? live.finalGates.map(g => `${stateColor(g.state === 'pass' ? 'completed' : 'failed')}${g.name}:${g.state}${C.r}`).join('  ') : `${C.d}not run yet${C.r}`}   ${C.b}configured${C.r} ${h.gates.length ? h.gates.map(g => g.name).join(', ') : `${C.y}none${C.r}`}`)
  line(`${C.b}CLAIMS (repository)${C.r} ${claims.length ? claims.map(c => `${c.missionId === h.id ? '' : `${c.missionId}/`}${c.taskId}#${c.attempt}:${c.state}[${c.owned.join(',')}]`).join('  ') : `${C.d}none${C.r}`}`)
  if (live.alerts.length) { line(''); line(`${C.b}ALERTS${C.r}`); for (const a of live.alerts.slice(-6)) line(`  ${C.y}${a.slice(0, width - 4)}${C.r}`) }
  if (v) { line(''); line(`${C.b}VERDICT ${stateColor(v.state)}${v.state}${C.r}`); for (const r of v.reasons.slice(0, 8)) line(`  - ${r.slice(0, width - 6)}`) }
  return out.join('\n')
}
