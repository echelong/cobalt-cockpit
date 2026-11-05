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
import { ZERO_USAGE } from './cost.ts'
import type { Usage } from './cost.ts'

export type WorkerSpec = {
  attemptId: string; runDir: string; workdir: string; writable: boolean
  gitCommonDir: string | null; gitAdminDir: string | null
  provider: string; model: string; cliThinking: string; expectedWire: string
  prompt: string; policy: Policy; timeoutSeconds: number; clineRetries: number
  hide: string[]; network: boolean; clineBin: string; clineDataDir: string
  /** Live limits: crossing either ends the attempt at once. */
  budgetUsd: number | null; budgetTokens: number
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
  stoppedBy: 'exit' | 'timeout' | 'budget' | 'cancel' | 'spawn_error'
  stopDetail: string | null; hookRefusals: { tool: string; reason: string }[]
}

const emptyFacts = (): StreamFacts => ({ usage: { ...ZERO_USAGE }, usageEvents: 0, toolCalls: {}, iterations: 0, finishReason: null, aborted: null, resultText: null, reportedModel: null, reportedProvider: null, agentErrors: 0, lines: 0, badLines: 0, sessionIds: [], firstEventAt: null, lastEventAt: null })

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

export const runWorker = async (w: WorkerSpec, on: { identity?: (id: Identity) => void; facts?: (f: StreamFacts) => void; control?: (c: Control) => void } = {}): Promise<WorkerOutcome> => {
  const ro = join(w.runDir, 'ro'), rw = join(w.runDir, 'rw'), cap = join(rw, 'capture'), cfg = join(rw, 'cline-config')
  for (const d of [join(ro, 'hooks'), cap, cfg]) mkdirSync(d, { recursive: true, mode: 0o700 })
  writeFileSync(join(ro, 'policy.json'), JSON.stringify(w.policy, null, 1), { mode: 0o400 })
  writeFileSync(join(ro, 'hooks', 'PreToolUse.sh'), hookScript(), { mode: 0o500 })
  chmodSync(join(ro, 'hooks', 'PreToolUse.sh'), 0o500)
  writeFileSync(join(ro, 'prompt.txt'), w.prompt, { mode: 0o400 })
  const uid = process.getuid?.() ?? 1000
  const sandbox: SandboxSpec = {
    workdir: w.workdir, writable: w.writable, gitCommonDir: w.gitCommonDir, gitAdminDir: w.gitAdminDir,
    readOnly: [ro, PACKAGE_DIR, join(PACKAGE_DIR, '..', 'hooks'), join(PACKAGE_DIR, '..', 'types')],
    readWrite: [rw, w.clineDataDir],
    hide: [...w.hide, `/run/user/${uid}`], network: w.network, marker: w.attemptId,
    env: { CLINE_CAPTURE_PROVIDER_REQUEST: 'full', CLINE_CAPTURE_WIRE: 'true', CLINE_CAPTURE_DIR: cap, COCKPIT_POLICY: join(ro, 'policy.json'), COCKPIT_HOOK_LOG: join(rw, 'hook.jsonl') },
  }
  const argv = [w.clineBin, '--json', '-P', w.provider, '-m', w.model, '--thinking', w.cliThinking, '-c', w.workdir, '--config', cfg, '--data-dir', w.clineDataDir, '--hooks-dir', join(ro, 'hooks'), '-t', String(w.timeoutSeconds), '--retries', String(w.clineRetries), w.prompt]
  writeFileSync(join(rw, 'argv.json'), JSON.stringify({ bwrap: sandbox, argv: argv.slice(0, -1).concat(['<prompt.txt>']) }, null, 1), { mode: 0o600 })
  const marker = `${MARKER_VAR}=${w.attemptId}`
  const facts = emptyFacts()
  let stoppedBy: WorkerOutcome['stoppedBy'] = 'exit'; let stopDetail: string | null = null
  let identity: Identity | null = null

  const launched = (() => { try { return launch(sandbox, argv) } catch (e) { stopDetail = (e as Error).message; return null } })()
  if (!launched) return { identity: null, exitCode: null, signal: null, facts, wire: judgeWire([], w.model, w.expectedWire), census: census({ initPid: null, initStart: null, pidNs: null, marker, since: Date.now() - 60_000 }), stoppedBy: 'spawn_error', stopDetail, hookRefusals: [] }
  const { child } = launched
  const started = Date.now()
  const stopNow = (why: WorkerOutcome['stoppedBy'], detail: string): void => {
    if (stoppedBy !== 'exit') return
    stoppedBy = why; stopDetail = detail
    void terminate(targetOf(identity, marker, started))
  }
  on.control?.({ cancel: why => stopNow('cancel', why) })
  const exited = new Promise<{ code: number | null; signal: string | null }>(res => {
    child.on('exit', (code, signal) => res({ code, signal }))
    child.on('error', e => { stopDetail = e.message; stoppedBy = 'spawn_error'; res({ code: null, signal: null }) })
  })
  void launched.identity.then(id => { identity = id; on.identity?.(id) })
  const streamFile = createWriteStream(join(rw, 'stream.jsonl'), { mode: 0o600 })
  const errFile = createWriteStream(join(rw, 'stderr.txt'), { mode: 0o600 })
  child.stderr?.pipe(errFile)
  const timer = setTimeout(() => stopNow('timeout', `no completion within ${w.timeoutSeconds + 30}s`), (w.timeoutSeconds + 30) * 1000)
  const rl = child.stdout ? createInterface({ input: child.stdout }) : null
  const lines = rl ? (async () => {
    for await (const line of rl) {
      streamFile.write(`${line}\n`)
      foldLine(facts, line)
      const tokens = facts.usage.inputTokens + facts.usage.outputTokens
      if (w.budgetUsd !== null && facts.usage.reportedUsd !== null && facts.usage.reportedUsd > w.budgetUsd) stopNow('budget', `reported cost $${facts.usage.reportedUsd.toFixed(5)} exceeded the task budget $${w.budgetUsd.toFixed(2)}`)
      if (tokens > w.budgetTokens) stopNow('budget', `${tokens} tokens exceeded the task token budget ${w.budgetTokens}`)
      on.facts?.(facts)
    }
  })() : Promise.resolve()
  const ex = await exited
  await lines.catch(() => undefined)
  clearTimeout(timer)
  await Promise.all([new Promise(r => streamFile.end(r)), new Promise(r => errFile.end(r))])
  const id = identity ?? await Promise.race([launched.identity, new Promise<null>(r => setTimeout(() => r(null), 1000))])
  if (id) identity = id
  // The outer bwrap has exited. Nothing is declared ended until the census is clean.
  // A clean exit is not proof: the census reads the sandbox init and the marker.
  const final = await terminate(targetOf(identity, marker, started), true, 5000)
  let stderrHead = ''
  try { stderrHead = readFileSync(join(rw, 'stderr.txt'), 'utf8').slice(0, 600) } catch { /* none */ }
  if (facts.lines === 0 && stoppedBy === 'exit' && /^bwrap: /m.test(stderrHead)) { stoppedBy = 'spawn_error'; stopDetail = `sandbox did not start: ${stderrHead.split('\n')[0]}` }
  const wire = judgeWire(readWireCaptures(cap), w.model, w.expectedWire)
  let hookRefusals: { tool: string; reason: string }[] = []
  try { hookRefusals = readFileSync(join(rw, 'hook.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { tool: string; allow: boolean; reason: string }).filter(e => !e.allow).map(e => ({ tool: e.tool, reason: e.reason })) } catch { /* no refusals */ }
  return { identity, exitCode: ex.code, signal: ex.signal, facts, wire, census: final, stoppedBy, stopDetail, hookRefusals }
}

export const targetOf = (id: Identity | null, marker: string, since: number): Target => ({ initPid: id?.initPid ?? null, initStart: id?.initStart ?? null, pidNs: id?.pidNs ?? null, marker, since: id?.since ?? since })

export const DEFAULT_CLINE_DATA = join(homedir(), '.cline', 'data')
