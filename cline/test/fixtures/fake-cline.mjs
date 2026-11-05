#!/usr/bin/env node
// Fake `cline` for offline tests. Same argv, JSONL shape and wire-capture files as
// Cline 3.0.74, a deterministic script read from [[...]] tokens in the prompt, and the
// REAL Cockpit PreToolUse hook called before every tool action.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'

const args = process.argv.slice(2)
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
const provider = opt('-P'), model = opt('-m'), thinking = opt('--thinking'), cwd = opt('-c'), hooksDir = opt('--hooks-dir')
const prompt = args[args.length - 1]
// Like a model following the latest request: with a conversation transcript in the prompt, only the
// current request's tokens are acted on (earlier turns are context, already carried out).
const CURRENT = 'Current request from the person:\n'
const scriptText = prompt.includes(CURRENT) ? prompt.slice(prompt.lastIndexOf(CURRENT)) : prompt
const steps = [...scriptText.matchAll(/\[\[([a-z0-9_-]+)(?::([\s\S]*?))?\]\]/g)].map(m => ({ op: m[1], arg: m[2] ?? '' }))
const has = (op) => steps.some(s => s.op === op)
const argOf = (op) => steps.find(s => s.op === op)?.arg
const out = (o) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const reportedModel = argOf('model') ?? model
const effortFor = (t) => has('downgrade') ? 'high' : t === 'xhigh' && !/qwen3\.8-max/.test(model) ? 'max' : t === 'none' ? undefined : t // Qwen3.8 Max lists xhigh natively
let totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCost: 0 }
let req = 0

const request = (u = [9000, 100, 0.001]) => {
  req++
  const cap = process.env.CLINE_CAPTURE_DIR
  if (cap && !has('nocapture')) {
    mkdirSync(cap, { recursive: true })
    const body = { model: reportedModel, ...(effortFor(thinking) ? { reasoning_effort: effortFor(thinking) } : {}), stream: true }
    if (has('toggle-off')) body.reasoning = { enabled: false }
    // the request carries the conversation after its top-level fields, as Cline's bodies do
    body.messages = [{ role: 'user', content: has('bigbody') ? 'x'.repeat(90_000) + ' "model":"evil/other-model" ' : 'hello' }]
    const wire = { url: 'https://fake.invalid/v1/chat/completions', method: 'POST', body: JSON.stringify(body) }
    const text = JSON.stringify(wire)
    // Cline 3.0.74 truncates captures above CLINE_CAPTURE_MAX_PREVIEW_BYTES (65 536 by default):
    // the payload becomes {truncated, bytes, sha256, preview} with the serialised payload cut short
    const payload = text.length > 65_536 ? { truncated: true, bytes: Buffer.byteLength(text), sha256: 'f'.repeat(64), preview: text.slice(0, 65_536) } : wire
    writeFileSync(join(cap, `cap_run_fake_${req}.wire_request.1.provider-request.json`), JSON.stringify({ timestamp: new Date().toISOString(), captureStage: 'wire_request', payload }))
  }
  if (has('nousage')) return
  const [i, o, c] = u
  totals = { inputTokens: totals.inputTokens + i, outputTokens: totals.outputTokens + o, cacheReadTokens: totals.cacheReadTokens + Math.floor(i / 2), totalCost: totals.totalCost + c }
  // [[nocost]]: tokens are reported but no cost field at all (a provider without cost telemetry)
  const cost = has('nocost') ? {} : { cost: c, totalCost: totals.totalCost }
  out({ type: 'agent_event', event: { type: 'usage', inputTokens: i, outputTokens: o, cacheReadTokens: Math.floor(i / 2), totalInputTokens: totals.inputTokens, totalOutputTokens: totals.outputTokens, totalCacheReadTokens: totals.cacheReadTokens, ...cost } })
}
const finalUsage = () => has('nousage') ? {} : has('nocost') ? { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: 0 } : { ...totals, cacheWriteTokens: 0 }

const hook = (toolName, parameters) => {
  const file = hooksDir && ['PreToolUse.sh', 'PreToolUse'].map(n => join(hooksDir, n)).find(existsSync)
  if (!file) return { cancel: false }
  const r = spawnSync(file, [], { input: JSON.stringify({ hookName: 'tool_call', agent_id: 'agent_fake', preToolUse: { toolName, parameters } }), encoding: 'utf8' })
  const last = (r.stdout || '').trim().split('\n').filter(Boolean).at(-1)
  try { return JSON.parse(last) } catch { return { cancel: false } }
}

const abort = (why) => {
  out({ type: 'hook_event', hookEventName: 'agent_error', agentId: 'agent_fake' })
  out({ type: 'run_result', finishReason: 'aborted', iterations: req, usage: totals, aggregateUsage: totals, text: why, model: { id: reportedModel, provider } })
  out({ type: 'run_aborted', reason: 'external_abort', message: 'aborted by another client' })
  process.exit(0)
}

out({ type: 'hook_event', hookEventName: 'agent_start', agentId: 'agent_fake', taskId: 'conv_fake' })
// [[fail-times:N:KIND]]: the first N runs of this prompt fail (KIND 503 | 429 | 401). The counter
// lives in the Cline data dir, the one place a sandboxed worker may write besides its worktree.
const failTimes = argOf('fail-times')
if (failTimes) {
  const [n, kind] = failTimes.split(':'); const dataDir = opt('--data-dir') ?? '/tmp'
  const key = join(dataDir, `fake-count-${Buffer.from(failTimes + (argOf('key') ?? '')).toString('hex').slice(0, 32)}`)
  let count = 0; try { count = Number((await import('node:fs')).readFileSync(key, 'utf8')) } catch { /* first run */ }
  writeFileSync(key, String(count + 1))
  if (count < Number(n)) {
    const msg = kind === '429' ? 'Provider error: 429 Too Many Requests (rate limited)' : kind === '401' ? 'Provider error: 401 Unauthorized: invalid API key' : 'Provider error: 503 upstream overloaded'
    out({ type: 'hook_event', hookEventName: 'agent_error', agentId: 'agent_fake' })
    out({ type: 'run_result', finishReason: 'error', iterations: 0, usage: {}, aggregateUsage: {}, text: msg, model: { id: reportedModel, provider } })
    process.exit(1)
  }
}
const correction = /did not pass Cockpit's verification/.test(prompt)
// [[fail-on-correction:N]]: the first N correction/escalation runs hit a transient provider error
const failCorr = argOf('fail-on-correction')
if (failCorr && correction) {
  const key = join(opt('--data-dir') ?? '/tmp', `fake-corr-${Buffer.from(prompt.slice(0, 200)).toString('hex').slice(0, 24)}`)
  let count = 0; try { count = Number((await import('node:fs')).readFileSync(key, 'utf8')) } catch { /* first */ }
  writeFileSync(key, String(count + 1))
  if (count < Number(failCorr)) {
    out({ type: 'run_result', finishReason: 'error', iterations: 0, usage: {}, aggregateUsage: {}, text: 'Provider error: 503 upstream overloaded', model: { id: reportedModel, provider } })
    process.exit(1)
  }
}
if (has('crash-early')) process.exit(137)
const usage = argOf('usage') ? argOf('usage').split(',').map(Number) : undefined
const repeat = Number(argOf('repeat') ?? 1)
for (let n = 0; n < repeat; n++) {
  out({ type: 'agent_event', event: { type: 'iteration_start', iteration: n + 1 } })
  request(usage)
  if (argOf('delay')) await sleep(Number(argOf('delay')))
  // like Cline: each model turn ends with iteration_end
  out({ type: 'agent_event', event: { type: 'iteration_end', iteration: n + 1, hadToolCalls: false, toolCallCount: 0 } })
}

for (const s of steps) {
  if (s.op === 'write') {
    const [rel, ...rest] = s.arg.split('='); const path = isAbsolute(rel) ? rel : join(cwd, rel)
    out({ type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName: 'editor', input: { path, new_text: rest.join('=') } } })
    if (hook('editor', { path, new_text: rest.join('=') }).cancel) abort(`hook refused editor ${rel}`)
    try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, rest.join('=')) } catch (e) { out({ type: 'agent_event', event: { type: 'content_end', contentType: 'tool', toolName: 'editor', output: { error: e.message } } }) }
  } else if (s.op === 'write-on-retry') {
    // writes only when the prompt is a correction or diagnosis (carries Cockpit's verification evidence)
    if (correction) {
      const [rel, ...rest] = s.arg.split('='); const path = join(cwd, rel)
      if (hook('editor', { path, new_text: rest.join('=') }).cancel) abort(`hook refused editor ${rel}`)
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, rest.join('='))
    }
  } else if (s.op === 'write-if') {
    const bar = s.arg.indexOf('|'); const want = s.arg.slice(0, bar); const [rel, ...rest] = s.arg.slice(bar + 1).split('=')
    if (want === model) {
      const path = join(cwd, rel)
      if (hook('editor', { path, new_text: rest.join('=') }).cancel) abort(`hook refused editor ${rel}`)
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, rest.join('='))
    }
  } else if (s.op === 'cmd') {
    out({ type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName: 'run_commands', input: { commands: [s.arg] } } })
    if (hook('run_commands', { commands: [s.arg] }).cancel) abort(`hook refused command`)
    spawnSync('bash', ['-c', s.arg], { cwd, stdio: 'ignore' })
  } else if (s.op === 'tool') {
    out({ type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName: s.arg, input: {} } })
    if (hook(s.arg, { task: 'x' }).cancel) abort(`hook refused ${s.arg}`)
  } else if (s.op === 'detach') {
    const c = spawn('setsid', ['sleep', s.arg || '600'], { detached: true, stdio: 'ignore' }); c.unref()
    writeFileSync(join(process.env.CLINE_CAPTURE_DIR ?? cwd, '..', 'detached-pid'), String(c.pid))
  } else if (s.op === 'sleep') await sleep(Number(s.arg))
}
if (has('hang')) { await sleep(10 * 60 * 1000) }
if (has('crash')) process.exit(137)
if (has('error')) {
  out({ type: 'hook_event', hookEventName: 'agent_error', agentId: 'agent_fake' })
  out({ type: 'run_result', finishReason: 'error', iterations: req, usage: totals, aggregateUsage: totals, text: 'Provider error: 503 upstream overloaded', model: { id: reportedModel, provider } })
  process.exit(1)
}
const planB64 = argOf('plan-b64'); const reqB64 = argOf('request-b64')
const sayB64 = argOf('say-b64')
const text = (sayB64 !== undefined ? Buffer.from(sayB64, 'base64').toString() : undefined) ?? argOf('say') ?? (planB64 !== undefined ? `Plan:\n\`\`\`json\n${Buffer.from(planB64, 'base64').toString()}\n\`\`\`` : reqB64 !== undefined ? `Done.\nCOCKPIT_REQUEST\n\`\`\`json\n${Buffer.from(reqB64, 'base64').toString()}\n\`\`\`` : argOf('plan') !== undefined ? `Plan:\n\`\`\`json\n${argOf('plan')}\n\`\`\`` : argOf('request') !== undefined ? `Done.\nCOCKPIT_REQUEST\n\`\`\`json\n${argOf('request')}\n\`\`\`` : 'Done. All changes made and tests pass.')
// like Cline: the answer streams as text deltas (content_start contentType text) before done
if (!has('nostream')) { let acc = ''; for (const chunk of text.match(/.{1,24}/gs) ?? []) { acc += chunk; out({ type: 'agent_event', event: { type: 'content_start', contentType: 'text', text: chunk, accumulated: acc } }); if (argOf('stream-delay')) await sleep(Number(argOf('stream-delay'))) } }
out({ type: 'agent_event', event: { type: 'done', reason: 'completed', text, iterations: req, usage: totals } })
out({ type: 'run_result', finishReason: 'completed', iterations: req, usage: finalUsage(), aggregateUsage: finalUsage(), durationMs: 10, text, model: { id: reportedModel, provider, info: { id: reportedModel } } })
