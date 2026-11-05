// Capability-checked reasoning. A requested level is never translated blindly:
// it is checked against the model's catalog reasoning values, and the effort that
// actually reached the provider is read back from Cline's own wire capture.
//
// Verified on Cline 3.0.74, provider "cline", 2026-11-05: `--thinking xhigh` for
// deepseek/deepseek-v4.1-flash-1017 (catalog values none|low|high|max) sent
// "reasoning_effort":"max" on the wire. That translation (xhigh -> max when the
// model lists max but not xhigh) is the only non-identity mapping accepted here.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

export type WireRequest = { file: string; model: string | null; effort: string | null; thinking: 'on' | 'off' | null; at: string | null }

/** Reads every wire request Cline captured into `dir` (CLINE_CAPTURE_WIRE=true). Only model and effort are kept. */
export const readWireCaptures = (dir: string): WireRequest[] => {
  let names: string[] = []
  try { names = readdirSync(dir).filter(n => n.includes('.wire_request.') && n.endsWith('.json')).sort() } catch { return [] }
  const out: WireRequest[] = []
  for (const name of names) {
    try {
      const doc = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { timestamp?: string; payload?: { body?: unknown } }
      let body = doc.payload?.body
      if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = null } }
      const b = (body ?? {}) as { model?: unknown; reasoning_effort?: unknown; reasoning?: { effort?: unknown; enabled?: unknown; exclude?: unknown }; thinking?: { type?: unknown } | unknown; enable_thinking?: unknown; chat_template_kwargs?: { enable_thinking?: unknown } }
      const effort = typeof b.reasoning_effort === 'string' ? b.reasoning_effort : typeof b.reasoning?.effort === 'string' ? b.reasoning.effort : null
      out.push({ file: name, model: typeof b.model === 'string' ? b.model : null, effort, thinking: thinkingOf(b, effort), at: doc.timestamp ?? null })
    } catch { out.push({ file: name, model: null, effort: null, thinking: null, at: null }) }
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
  const wrongModel = requests.filter(r => r.model !== model)
  if (wrongModel.length) return { state: 'mismatch', requests: requests.length, effective: efforts.join(','), models, detail: `${wrongModel.length} request(s) sent model ${[...new Set(wrongModel.map(r => r.model))].join(',')} instead of ${model}` }
  if (expectedEffort === 'on' || expectedEffort === 'off') {
    const unknown = requests.filter(r => r.thinking === null)
    if (unknown.length) return { state: 'unconfirmed', requests: requests.length, effective: null, models, detail: `${unknown.length} request(s) do not state thinking on/off; effective reasoning cannot be confirmed` }
    const wrong = requests.filter(r => r.thinking !== expectedEffort)
    if (wrong.length) return { state: 'mismatch', requests: requests.length, effective: [...new Set(requests.map(r => r.thinking))].join(','), models, detail: `${wrong.length} of ${requests.length} request(s) sent thinking ${wrong[0].thinking} instead of ${expectedEffort}` }
    return { state: 'confirmed', requests: requests.length, effective: `thinking ${expectedEffort}`, models, detail: `${requests.length} request(s) sent ${model} with thinking ${expectedEffort}` }
  }
  const wrongEffort = requests.filter(r => r.effort !== expectedEffort)
  if (wrongEffort.length) return { state: 'mismatch', requests: requests.length, effective: efforts.join(','), models, detail: `${wrongEffort.length} of ${requests.length} request(s) sent reasoning ${[...new Set(wrongEffort.map(r => r.effort ?? 'none-sent'))].join(',')} instead of ${expectedEffort}` }
  return { state: 'confirmed', requests: requests.length, effective: expectedEffort, models, detail: `${requests.length} request(s) sent ${model} at reasoning ${expectedEffort}` }
}
