// One worker attempt: a `cline --json` process inside its own sandbox.
// The supervisor learns everything from Cline's JSONL stream and wire capture, and
// declares the attempt ended only after a clean process census of its namespace.
import { chmodSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PACKAGE_DIR } from './config.ts'
import { launch, MARKER_VAR } from './sandbox.ts'
import type { Identity, SandboxSpec } from './sandbox.ts'
import { census, terminate } from './proc.ts'
import type { Census, Target } from './proc.ts'
import type { Policy } from './hook/policy.ts'
import { judgeWire, readWireCaptures } from './reasoning.ts'
import type { WireVerdict } from './reasoning.ts'
import { estimateUsd, ZERO_USAGE } from './cost.ts'
import type { Usage } from './cost.ts'
import type { Pricing } from './config.ts'

export type WorkerSpec = {
  attemptId: string; runDir: string; workdir: string; writable: boolean
  gitCommonDir: string | null; gitAdminDir: string | null
  provider: string; model: string; cliThinking: string; expectedWire: string
  prompt: string; policy: Policy; timeoutSeconds: number; clineRetries: number
  hide: string[]; network: boolean; clineBin: string; clineDataDir: string
  /** Live limits: crossing either ends the attempt at once. */
  budgetUsd: number | null; budgetTokens: number
  /** Pricing for the estimate that enforces budgetUsd when Cline reports no cost; null when unknown. */
  pricing: Pricing | null
  /** When false, a run whose cost cannot be measured is stopped instead of running unmetered. */
  allowUnmetered: boolean
}
export type StreamFacts = {
  usage: Usage; usageEvents: number; toolCalls: Record<string, number>; iterations: number
  finishReason: string | null; aborted: string | null; resultText: string | null
  reportedModel: string | null; reportedProvider: string | null; agentErrors: number; lines: number; badLines: number
  sessionIds: string[]; firstEventAt: string | null; lastEventAt: string | null
}
export type WorkerOutcome = {
  identity: Identity | null; exitCode: number | null; signal: string | null
  facts: StreamFacts; wire: WireVerdict; census: Census
  stoppedBy: 'exit' | 'timeout' | 'budget' | 'unmetered' | 'cancel' | 'spawn_error'
  stopDetail: string | null; hookRefusals: { tool: string; reason: string }[]
  /** The first error a `facts` observer threw; the stream kept being read regardless. */
  observerError: string | null
  /** The first 2000 characters of the worker's stderr, for failure classification (never trusted for success). */
  stderrHead?: string
}

/**
 * The live budget decision for one stream position. Missing cost telemetry never passes
 * silently: a reported cost is used when present, else an estimate from known pricing,
 * else the run is unmeasurable and is stopped unless unmetered runs are allowed. A model
 * turn that ended without any usage event is unmeasurable too.
 */
export const budgetVerdict = (f: Pick<StreamFacts, 'usage' | 'usageEvents' | 'iterations'>, w: Pick<WorkerSpec, 'budgetUsd' | 'budgetTokens' | 'pricing' | 'allowUnmetered'>): { stop: 'budget' | 'unmetered'; detail: string } | null => {
  const tokens = f.usage.inputTokens + f.usage.outputTokens
  if (tokens > w.budgetTokens) return { stop: 'budget', detail: `${tokens} tokens exceeded the task token budget ${w.budgetTokens}` }
  if (f.usageEvents === 0 && f.iterations > 0 && !w.allowUnmetered) return { stop: 'unmetered', detail: `${f.iterations} model turn(s) ended without a usage event: cost cannot be measured` }
  if (w.budgetUsd === null || f.usageEvents === 0) return null
  const estimate = w.pricing ? estimateUsd(f.usage, w.pricing) : null
  // a reported $0 for real tokens of a priced model is not a cost figure: hold the budget against the estimate
  const reportedUsable = f.usage.reportedUsd !== null && !(f.usage.reportedUsd === 0 && tokens > 0 && (estimate ?? 0) > 0)
  const charged = reportedUsable ? f.usage.reportedUsd : estimate
  if (charged === null) return w.allowUnmetered ? null : { stop: 'unmetered', detail: 'Cline reported no cost and no pricing is configured for this model: the task budget cannot be enforced' }
  if (charged > w.budgetUsd) return { stop: 'budget', detail: `${reportedUsable ? 'reported' : 'estimated'} cost $${charged.toFixed(5)} exceeded the task budget $${w.budgetUsd.toFixed(2)}` }
  return null
}

export const emptyFacts = (): StreamFacts => ({ usage: { ...ZERO_USAGE }, usageEvents: 0, toolCalls: {}, iterations: 0, finishReason: null, aborted: null, resultText: null, reportedModel: null, reportedProvider: null, agentErrors: 0, lines: 0, badLines: 0, sessionIds: [], firstEventAt: null, lastEventAt: null })

/** Folds one JSONL line from `cline --json` into the facts. Unknown lines are counted, not trusted. */
export const foldLine = (f: StreamFacts, line: string): StreamFacts => {
  if (!line.trim()) return f
  f.lines++
  let o: Record<string, unknown>
  try { o = JSON.parse(line) as Record<string, unknown> } catch { f.badLines++; return f }
  const ts = typeof o.ts === 'string' ? o.ts : null
  if (ts) { f.firstEventAt ??= ts; f.lastEventAt = ts }
  if (o.type === 'agent_event') {
    const e = (o.event ?? {}) as Record<string, unknown>
    if (e.type === 'usage') {
      f.usageEvents++
      const n = (k: string): number | null => typeof e[k] === 'number' && Number.isFinite(e[k] as number) ? e[k] as number : null
      // totals are cumulative for the run; fall back to summing per-request figures
      const ti = n('totalInputTokens'), to = n('totalOutputTokens'), tc = n('totalCacheReadTokens'), tw = n('totalCacheWriteTokens'), cost = n('totalCost')
      f.usage = {
        inputTokens: ti ?? f.usage.inputTokens + (n('inputTokens') ?? 0),
        outputTokens: to ?? f.usage.outputTokens + (n('outputTokens') ?? 0),
        cacheReadTokens: tc ?? f.usage.cacheReadTokens + (n('cacheReadTokens') ?? 0),
        cacheWriteTokens: tw ?? f.usage.cacheWriteTokens + (n('cacheWriteTokens') ?? 0),
        reasoningTokens: n('reasoningTokenCount') !== null ? (f.usage.reasoningTokens ?? 0) + (n('reasoningTokenCount') ?? 0) : f.usage.reasoningTokens,
        reportedUsd: cost ?? (n('cost') !== null ? (f.usage.reportedUsd ?? 0) + (n('cost') ?? 0) : f.usage.reportedUsd),
      }
    } else if (e.type === 'content_start' && e.contentType === 'tool' && typeof e.toolName === 'string') f.toolCalls[e.toolName] = (f.toolCalls[e.toolName] ?? 0) + 1
    else if (e.type === 'iteration_end') f.iterations = Math.max(f.iterations, typeof e.iteration === 'number' ? e.iteration : f.iterations)
    else if (e.type === 'done' && typeof e.text === 'string') f.resultText = e.text
  } else if (o.type === 'hook_event') {
    if (o.hookEventName === 'agent_error') f.agentErrors++
  } else if (o.type === 'run_result') {
    f.finishReason = typeof o.finishReason === 'string' ? o.finishReason : 'unknown'
    if (typeof o.text === 'string') f.resultText = o.text
    if (typeof o.iterations === 'number') f.iterations = o.iterations
    const m = (o.model ?? {}) as { id?: unknown; provider?: unknown }
    f.reportedModel = typeof m.id === 'string' ? m.id : null
    f.reportedProvider = typeof m.provider === 'string' ? m.provider : null
    const u = (o.aggregateUsage ?? o.usage ?? {}) as Record<string, unknown>
    const n = (k: string): number | null => typeof u[k] === 'number' && Number.isFinite(u[k] as number) ? u[k] as number : null
    if (n('inputTokens') !== null) f.usage = { ...f.usage, inputTokens: n('inputTokens') ?? 0, outputTokens: n('outputTokens') ?? 0, cacheReadTokens: n('cacheReadTokens') ?? 0, cacheWriteTokens: n('cacheWriteTokens') ?? 0, reportedUsd: n('totalCost') ?? f.usage.reportedUsd }
  } else if (o.type === 'run_aborted') {
    f.aborted = `${String(o.reason ?? 'aborted')}${typeof o.message === 'string' ? `: ${o.message}` : ''}`
  }
  return f
}

const hookScript = (): string => `#!/usr/bin/env bash
# Cobalt Cockpit PreToolUse hook (generated). Any failure here cancels the run.
exec "${process.execPath}" --experimental-transform-types --no-warnings --import "${join(PACKAGE_DIR, 'loader', 'register.mjs')}" "${join(PACKAGE_DIR, 'src', 'hook', 'pretool.ts')}" || { echo '{"cancel": true, "errorMessage": "COCKPIT: hook did not run"}'; exit 0; }
`

export type Control = { cancel: (why: string) => void }

export const runWorker = async (w: WorkerSpec, on: { identity?: (id: Identity) => void; facts?: (f: StreamFacts) => void; control?: (c: Control) => void; event?: (e: Record<string, unknown>) => void } = {}, io: { launch?: typeof launch } = {}): Promise<WorkerOutcome> => {
  const ro = join(w.runDir, 'ro'), rw = join(w.runDir, 'rw'), cap = join(rw, 'capture'), cfg = join(rw, 'cline-config')
  for (const d of [join(ro, 'hooks'), cap, cfg]) mkdirSync(d, { recursive: true, mode: 0o700 })
  writeFileSync(join(ro, 'policy.json'), JSON.stringify(w.policy, null, 1), { mode: 0o400 })
  writeFileSync(join(ro, 'hooks', 'PreToolUse.sh'), hookScript(), { mode: 0o500 })
  chmodSync(join(ro, 'hooks', 'PreToolUse.sh'), 0o500)
  writeFileSync(join(ro, 'prompt.txt'), w.prompt, { mode: 0o400 })
  const sandbox: SandboxSpec = {
    workdir: w.workdir, writable: w.writable, gitCommonDir: w.gitCommonDir, gitAdminDir: w.gitAdminDir,
    readOnly: [ro, PACKAGE_DIR, join(PACKAGE_DIR, '..', 'hooks'), join(PACKAGE_DIR, '..', 'types')],
    readWrite: [rw, w.clineDataDir],
    hide: w.hide, network: w.network, marker: w.attemptId,
    env: { CLINE_CAPTURE_PROVIDER_REQUEST: 'full', CLINE_CAPTURE_WIRE: 'true', CLINE_CAPTURE_DIR: cap, COCKPIT_POLICY: join(ro, 'policy.json'), COCKPIT_HOOK_LOG: join(rw, 'hook.jsonl') },
  }
  const argv = [w.clineBin, '--json', '-P', w.provider, '-m', w.model, '--thinking', w.cliThinking, '-c', w.workdir, '--config', cfg, '--data-dir', w.clineDataDir, '--hooks-dir', join(ro, 'hooks'), '-t', String(w.timeoutSeconds), '--retries', String(w.clineRetries), w.prompt]
  writeFileSync(join(rw, 'argv.json'), JSON.stringify({ bwrap: sandbox, argv: argv.slice(0, -1).concat(['<prompt.txt>']) }, null, 1), { mode: 0o600 })
  const marker = `${MARKER_VAR}=${w.attemptId}`
  const facts = emptyFacts()
  let stoppedBy: WorkerOutcome['stoppedBy'] = 'exit'; let stopDetail: string | null = null
  let identity: Identity | null = null
  let observerError: string | null = null

  const start = io.launch ?? launch
  const launched = (() => { try { return start(sandbox, argv) } catch (e) { stopDetail = (e as Error).message; return null } })()
  if (!launched) return { identity: null, exitCode: null, signal: null, facts, wire: judgeWire([], w.model, w.expectedWire), census: census({ initPid: null, initStart: null, pidNs: null, marker, since: Date.now() - 60_000 }), stoppedBy: 'spawn_error', stopDetail, hookRefusals: [], observerError: null }
  const { child } = launched
  const started = Date.now()
  const stopNow = (why: WorkerOutcome['stoppedBy'], detail: string): void => {
    if (stoppedBy !== 'exit') return
    stoppedBy = why; stopDetail = detail
    // One kill pass only: the census that ends this attempt runs after exit and does the waiting.
    // A lingering loop would outlive the attempt and act on whatever the target later names.
    void terminate(targetOf(identity, marker, started), true, 0)
  }
  on.control?.({ cancel: why => stopNow('cancel', why) })
  const exited = new Promise<{ code: number | null; signal: string | null }>(res => {
    child.on('exit', (code, signal) => res({ code, signal }))
    child.on('error', e => { stopDetail = e.message; stoppedBy = 'spawn_error'; res({ code: null, signal: null }) })
  })
  // The identity callback binds ownership. Once this attempt has returned it never runs:
  // a late identity is kept for the record only, so a retired claim cannot be rewritten.
  let returned = false
  void launched.identity.then(id => {
    identity = id
    // A stop decided before the identity was known could only kill by marker, which may not have
    // been visible yet: now that the sandbox init is known, apply the stop to it as well.
    if (stoppedBy !== 'exit') void terminate(targetOf(id, marker, started), true, 0)
    if (returned) return
    // the callback writes claims and the ledger; its failure must not crash the supervisor unseen
    try { on.identity?.(id) } catch (e) { observerError ??= `identity observer: ${(e as Error).message}` }
  })
  const streamFile = createWriteStream(join(rw, 'stream.jsonl'), { mode: 0o600 })
  const errFile = createWriteStream(join(rw, 'stderr.txt'), { mode: 0o600 })
  child.stderr?.pipe(errFile)
  const timer = setTimeout(() => stopNow('timeout', `no completion within ${w.timeoutSeconds + 30}s`), (w.timeoutSeconds + 30) * 1000)
  const rl = child.stdout ? createInterface({ input: child.stdout }) : null
  const lines = rl ? (async () => {
    for await (const line of rl) {
      streamFile.write(`${line}\n`)
      foldLine(facts, line)
      // display passthrough only: what a worker prints is never trusted for decisions here
      if (on.event) { try { const o = JSON.parse(line) as unknown; if (o && typeof o === 'object') on.event(o as Record<string, unknown>) } catch { /* not JSON, or a failing viewer */ } }
      const b = budgetVerdict(facts, w)
      if (b) stopNow(b.stop, b.detail)
      // A failing observer (for example a full disk while persisting) must not stop the
      // stream being read: budget enforcement and the run result depend on it.
      try { on.facts?.(facts) } catch (e) { observerError ??= (e as Error).message }
    }
  })() : Promise.resolve()
  const ex = await exited
  await lines.catch(() => undefined)
  clearTimeout(timer)
  await Promise.all([new Promise(r => streamFile.end(r)), new Promise(r => errFile.end(r))])
  const id = identity ?? await Promise.race([launched.identity, new Promise<null>(r => setTimeout(() => r(null), 1000))])
  if (id) identity = id
  returned = true
  if (observerError) writeFileSync(join(rw, 'observer-error.txt'), observerError, { mode: 0o600 })
  // The outer bwrap has exited. Nothing is declared ended until the census is clean.
  // A clean exit is not proof: the census reads the sandbox init and the marker.
  const final = await terminate(targetOf(identity, marker, started), true, 5000)
  let stderrHead = ''
  try { stderrHead = readFileSync(join(rw, 'stderr.txt'), 'utf8').slice(0, 600) } catch { /* none */ }
  if (facts.lines === 0 && stoppedBy === 'exit' && /^bwrap: /m.test(stderrHead)) { stoppedBy = 'spawn_error'; stopDetail = `sandbox did not start: ${stderrHead.split('\n')[0]}` }
  const wire = judgeWire(readWireCaptures(cap), w.model, w.expectedWire)
  let hookRefusals: { tool: string; reason: string }[] = []
  try { hookRefusals = readFileSync(join(rw, 'hook.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { tool: string; allow: boolean; reason: string }).filter(e => !e.allow).map(e => ({ tool: e.tool, reason: e.reason })) } catch { /* no refusals */ }
  let stderrText = ''
  try { stderrText = readFileSync(join(rw, 'stderr.txt'), 'utf8').slice(0, 2000) } catch { /* none */ }
  return { identity, exitCode: ex.code, signal: ex.signal, facts, wire, census: final, stoppedBy, stopDetail, hookRefusals, observerError, stderrHead: stderrText }
}

export const targetOf = (id: Identity | null, marker: string, since: number): Target => ({ initPid: id?.initPid ?? null, initStart: id?.initStart ?? null, pidNs: id?.pidNs ?? null, marker, since: id?.since ?? since })

export const DEFAULT_CLINE_DATA = join(homedir(), '.cline', 'data')
