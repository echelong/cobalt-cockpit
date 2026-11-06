// Capability-checked reasoning. A requested level is never translated blindly:
// it is checked against the model's catalog reasoning values, and the effort that
// actually reached the provider is read back from Cline's own wire capture.
//
// Verified on Cline 3.0.74, provider "cline", 2026-11-05: `--thinking xhigh` for
// deepseek/deepseek-v4.1-flash-1017 (catalog values none|low|high|max) sent
// "reasoning_effort":"max" on the wire. That translation (xhigh -> max when the
// model lists max but not xhigh) is the only non-identity mapping accepted here.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readUntrusted, realDir } from './sandbox.ts'
import type { Thinking } from './config.ts'

export type ReasoningPlan =
  | { ok: true; requested: Thinking; cliFlag: Thinking; expectedWire: string; mapping: 'exact' | 'xhigh->max' | 'toggle'; note: string }
  | { ok: false; requested: Thinking; reason: string }

/** Toggle-only models (no effort levels) are planned as thinking on/off; their wire check reads the toggle. */
export const planReasoning = (requested: Thinking, values: readonly string[], toggle = false): ReasoningPlan => {
  if (values.length === 0 && toggle) return requested === 'none'
    ? { ok: true, requested, cliFlag: 'none', expectedWire: 'off', mapping: 'toggle', note: 'toggle-only model: thinking off' }
    : { ok: true, requested, cliFlag: requested, expectedWire: 'on', mapping: 'toggle', note: `toggle-only model: levels are not supported, so "${requested}" means thinking on (wire-verified per request)` }
  if (values.includes(requested)) return { ok: true, requested, cliFlag: requested, expectedWire: requested, mapping: 'exact', note: `model lists "${requested}"` }
  if (requested === 'xhigh' && values.includes('max')) return { ok: true, requested, cliFlag: 'xhigh', expectedWire: 'max', mapping: 'xhigh->max', note: 'model lists max but not xhigh; Cline sends max for --thinking xhigh (wire-verified per request)' }
  return { ok: false, requested, reason: `reasoning "${requested}" is not supported by this model (catalog: ${values.length ? values.join('|') : 'no effort levels'}); refusing rather than downgrading` }
}

/**
 * One captured provider request. `source` says how it was read:
 *   body       the full request body was in the capture
 *   preview    Cline truncated the capture (bodies over CLINE_CAPTURE_MAX_PREVIEW_BYTES, 65 536 by
 *              default, become {truncated, bytes, sha256, preview}); the top-level fields were read
 *              from the escaped body head in the preview
 *   unreadable neither: nothing about this request is known
 */
export type WireRequest = { file: string; model: string | null; effort: string | null; thinking: 'on' | 'off' | null; at: string | null; source?: 'body' | 'preview' | 'unreadable'; bytes?: number | null; sha256?: string | null }

/**
 * The JSON text of the request body inside a truncated preview. The preview is the capture
 * payload serialised as JSON and cut at the byte limit, so the body is an escaped JSON string
 * that usually ends mid-way; it is decoded up to the last complete character.
 */
export const previewBodyHead = (preview: string): string | null => {
  const key = preview.indexOf('"body":')
  if (key < 0) return null
  let i = key + '"body":'.length
  while (preview[i] === ' ') i++
  if (preview[i] === '{') return preview.slice(i)            // body serialised as an object: already JSON text
  if (preview[i] !== '"') return null
  let raw = ''
  for (let j = i + 1; j < preview.length; j++) {
    const ch = preview[j]
    if (ch === '\\') { if (j + 1 >= preview.length) break; raw += ch + preview[j + 1]; j++; continue }
    if (ch === '"') break
    raw += ch
  }
  raw = raw.replace(/\\u[0-9a-fA-F]{0,3}$/, '')              // a \u escape cut short
  try { return JSON.parse(`"${raw}"`) as string } catch { return null }
}

/** Top-level request fields from (possibly truncated) body JSON text: only the part before the message list counts. */
export const headFields = (head: string): Record<string, unknown> => {
  const cut = ['"messages"', '"input"', '"tools"', '"contents"', '"system"'].map(k => head.indexOf(k)).filter(n => n >= 0)
  const top = cut.length ? head.slice(0, Math.min(...cut)) : head
  const str = (re: RegExp): string | undefined => re.exec(top)?.[1]
  const bool = (re: RegExp): boolean | undefined => { const m = re.exec(top)?.[1]; return m === undefined ? undefined : m === 'true' }
  const reasoningEffort = str(/"reasoning"\s*:\s*\{[^}]*"effort"\s*:\s*"([^"\\]*)"/)
  const reasoningEnabled = bool(/"reasoning"\s*:\s*\{[^}]*"enabled"\s*:\s*(true|false)/)
  const thinkingType = str(/"thinking"\s*:\s*\{[^}]*"type"\s*:\s*"([^"\\]*)"/)
  return {
    model: str(/"model"\s*:\s*"([^"\\]*)"/),
    reasoning_effort: str(/"reasoning_effort"\s*:\s*"([^"\\]*)"/),
    ...(reasoningEffort !== undefined || reasoningEnabled !== undefined ? { reasoning: { effort: reasoningEffort, enabled: reasoningEnabled } } : {}),
    ...(thinkingType !== undefined ? { thinking: { type: thinkingType } } : {}),
    enable_thinking: bool(/"enable_thinking"\s*:\s*(true|false)/),
  }
}

/** Reads every wire request Cline captured into `dir` (CLINE_CAPTURE_WIRE=true). Only model and effort are kept. */
export const readWireCaptures = (dir: string): WireRequest[] => {
  let names: string[] = []
  // the capture directory is worker-writable: a symlink in place of it, or of a file in it, is never followed
  if (!realDir(dir)) return []
  // bounded: a worker cannot stall the supervisor with thousands of files or huge ones
  try { names = readdirSync(dir).filter(n => n.includes('.wire_request.') && n.endsWith('.json')).sort().slice(0, 2000) } catch { return [] }
  const out: WireRequest[] = []
  for (const name of names) {
    try {
      const doc = JSON.parse(readUntrusted(join(dir, name), 2 << 20)) as { timestamp?: string; payload?: { body?: unknown; truncated?: unknown; preview?: unknown; bytes?: unknown; sha256?: unknown } }
      const p = doc.payload ?? {}
      let b: Record<string, unknown> | null = null
      let source: WireRequest['source'] = 'unreadable'
      if (p.body !== undefined) {
        let body = p.body
        if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = null } }
        if (body && typeof body === 'object') { b = body as Record<string, unknown>; source = 'body' }
      } else if (p.truncated === true && typeof p.preview === 'string') {
        const head = previewBodyHead(p.preview)
        if (head !== null) { b = headFields(head); source = 'preview' }
      }
      const bb = (b ?? {}) as { model?: unknown; reasoning_effort?: unknown; reasoning?: { effort?: unknown; enabled?: unknown }; thinking?: unknown; enable_thinking?: unknown; chat_template_kwargs?: { enable_thinking?: unknown } }
      const effort = typeof bb.reasoning_effort === 'string' ? bb.reasoning_effort : typeof bb.reasoning?.effort === 'string' ? bb.reasoning.effort : null
      const model = typeof bb.model === 'string' && bb.model ? bb.model : null
      out.push({ file: name, model, effort, thinking: b ? thinkingOf(bb, effort) : null, at: doc.timestamp ?? null, source: model === null ? 'unreadable' : source, bytes: typeof p.bytes === 'number' ? p.bytes : null, sha256: typeof p.sha256 === 'string' ? p.sha256 : null })
    } catch { out.push({ file: name, model: null, effort: null, thinking: null, at: null, source: 'unreadable', bytes: null, sha256: null }) }
  }
  return out
}

/** Thinking on/off as the request body states it, or null when the body does not say. */
const thinkingOf = (b: Record<string, unknown> & { reasoning?: { enabled?: unknown }; thinking?: unknown; enable_thinking?: unknown; chat_template_kwargs?: { enable_thinking?: unknown } }, effort: string | null): 'on' | 'off' | null => {
  const flags: unknown[] = [b.reasoning?.enabled, b.enable_thinking, b.chat_template_kwargs?.enable_thinking]
  const t = b.thinking as { type?: unknown } | boolean | undefined
  if (typeof t === 'boolean') flags.push(t)
  else if (t && typeof t === 'object' && typeof t.type === 'string') flags.push(t.type === 'enabled' || t.type === 'adaptive')
  const known = flags.filter((f): f is boolean => typeof f === 'boolean')
  if (known.length) return known.every(Boolean) ? 'on' : 'off'
  if (effort !== null) return effort === 'none' ? 'off' : 'on'
  return null
}

export type WireVerdict = { state: 'confirmed' | 'unconfirmed' | 'mismatch'; requests: number; effective: string | null; models: string[]; detail: string }

/** Every captured request must carry the routed model and the expected effort. */
export const judgeWire = (requests: readonly WireRequest[], model: string, expectedEffort: string): WireVerdict => {
  const models = [...new Set(requests.map(r => r.model ?? '?'))]
  const efforts = [...new Set(requests.map(r => r.effort ?? '?'))]
  if (requests.length === 0) return { state: 'unconfirmed', requests: 0, effective: null, models, detail: 'no wire request captured; effective reasoning cannot be confirmed' }
  // A readable different model is a mismatch. An unreadable capture says nothing about the model:
  // it is unconfirmed (strict mode still fails it), never reported as "another model was sent".
  const wrongModel = requests.filter(r => r.model !== null && r.model !== model)
  if (wrongModel.length) return { state: 'mismatch', requests: requests.length, effective: efforts.join(','), models, detail: `${wrongModel.length} request(s) sent model ${[...new Set(wrongModel.map(r => r.model))].join(',')} instead of ${model}` }
  const unreadable = requests.filter(r => r.model === null)
  if (unreadable.length) return { state: 'unconfirmed', requests: requests.length, effective: null, models, detail: `${unreadable.length} of ${requests.length} request capture(s) unreadable (${unreadable.slice(0, 3).map(r => r.file).join(', ')}); model and reasoning cannot be confirmed for them` }
  const viaPreview = requests.filter(r => r.source === 'preview').length
  const note = viaPreview ? ` (${viaPreview} read from truncated capture previews; sizes and sha256 recorded)` : ''
  if (expectedEffort === 'on' || expectedEffort === 'off') {
    const unknown = requests.filter(r => r.thinking === null)
    if (unknown.length) return { state: 'unconfirmed', requests: requests.length, effective: null, models, detail: `${unknown.length} request(s) do not state thinking on/off; effective reasoning cannot be confirmed` }
    const wrong = requests.filter(r => r.thinking !== expectedEffort)
    if (wrong.length) return { state: 'mismatch', requests: requests.length, effective: [...new Set(requests.map(r => r.thinking))].join(','), models, detail: `${wrong.length} of ${requests.length} request(s) sent thinking ${wrong[0].thinking} instead of ${expectedEffort}` }
    const inferred = requests.some(r => r.effort !== null)
    const sent = [...new Set(requests.map(r => r.effort).filter(Boolean))].join(',')
    return { state: 'confirmed', requests: requests.length, effective: inferred ? `thinking ${expectedEffort} (sent reasoning_effort=${sent})` : `thinking ${expectedEffort}`, models, detail: `${requests.length} request(s) sent ${model} with thinking ${expectedEffort}${inferred ? ` (inferred from reasoning_effort=${sent}: a toggle-only model has no levels, and whether the provider honours the level is not observable)` : ''}` }
  }
  // a truncated head without the effort field cannot show that none was sent: unconfirmed, not a downgrade
  const headWithoutEffort = requests.filter(r => r.source === 'preview' && r.effort === null)
  if (headWithoutEffort.length && expectedEffort !== 'none') return { state: 'unconfirmed', requests: requests.length, effective: null, models, detail: `${headWithoutEffort.length} truncated capture(s) do not show the reasoning field in their head; reasoning cannot be confirmed for them` }
  const wrongEffort = requests.filter(r => r.effort !== expectedEffort)
  if (wrongEffort.length) return { state: 'mismatch', requests: requests.length, effective: efforts.join(','), models, detail: `${wrongEffort.length} of ${requests.length} request(s) sent reasoning ${[...new Set(wrongEffort.map(r => r.effort ?? 'none-sent'))].join(',')} instead of ${expectedEffort}` }
  return { state: 'confirmed', requests: requests.length, effective: expectedEffort, models, detail: `${requests.length} request(s) sent ${model} at reasoning ${expectedEffort}${note}` }
}
