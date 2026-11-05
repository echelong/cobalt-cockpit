// Token and cost telemetry. Two figures are kept apart and labelled:
//   reported  - the cost Cline reports in its usage events (the billed figure it receives)
//   estimate  - measured tokens x configured pricing (catalog or override), per 1M tokens
// A missing figure stays null. Nothing is invented: no usage, no cost.
import type { Role } from './core/engine.ts'
import type { Config, Pricing } from './config.ts'
import type { ModelInfo } from './catalog.ts'

export type PricingSource = { pricing: Pricing; source: 'override' | 'catalog' | 'none' }

export const pricingFor = (config: Config, model: string, info: ModelInfo | undefined): PricingSource => {
  const o = config.pricingOverrides[model]
  if (o) return { pricing: o, source: 'override' }
  const p = info?.pricing
  if (p && [p.input, p.output].every(v => typeof v === 'number')) return { pricing: { input: p.input ?? 0, output: p.output ?? 0, cacheRead: p.cacheRead ?? p.input ?? 0, cacheWrite: p.cacheWrite ?? 0 }, source: 'catalog' }
  return { pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: 'none' }
}

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number | null; reportedUsd: number | null }
export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: null }

/** Cline's inputTokens include cache reads (checked against its reported cost on GLM 5.3 Flash, 2026-11-05). */
export const estimateUsd = (u: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>, p: Pricing): number => {
  const fresh = Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens)
  return (fresh * p.input + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite + u.outputTokens * p.output) / 1e6
}

export const preSpawnEstimate = (config: Config, role: Role, p: Pricing): number => {
  const e = config.estimates[role]
  const cache = Math.floor(e.input * e.cacheRatio)
  return estimateUsd({ inputTokens: e.input, outputTokens: e.output, cacheReadTokens: cache, cacheWriteTokens: 0 }, p)
}

/** The figure a budget is held against: the reported cost when Cline gives one, else the estimate, flagged. */
export const chargeOf = (u: Usage, p: PricingSource): { usd: number | null; basis: 'reported' | 'estimate' | 'unmetered' } => {
  const tokens = u.inputTokens + u.outputTokens
  // a reported $0 for real tokens of a priced model is a missing figure, not a free run
  const bogusZero = u.reportedUsd === 0 && tokens > 0 && p.source !== 'none' && estimateUsd(u, p.pricing) > 0
  if (u.reportedUsd !== null && !bogusZero) return { usd: u.reportedUsd, basis: 'reported' }
  if (p.source !== 'none' && (u.inputTokens > 0 || u.outputTokens > 0)) return { usd: estimateUsd(u, p.pricing), basis: 'estimate' }
  return { usd: null, basis: 'unmetered' }
}

export type BudgetCheck = { state: 'ok' | 'alert' | 'exceeded' | 'unmetered'; fraction: number | null; crossed: number[]; detail: string }

export const checkBudget = (spentUsd: number | null, tokens: number, limitUsd: number, limitTokens: number, alertAt: readonly number[], already: readonly number[] = []): BudgetCheck => {
  if (spentUsd === null) return { state: 'unmetered', fraction: null, crossed: [], detail: 'usage unavailable: cost cannot be measured' }
  const fraction = Math.max(limitUsd > 0 ? spentUsd / limitUsd : spentUsd > 0 ? Infinity : 0, limitTokens > 0 ? tokens / limitTokens : 0)
  const crossed = alertAt.filter(a => fraction >= a && !already.includes(a))
  if (fraction >= 1) return { state: 'exceeded', fraction, crossed, detail: `budget exceeded: $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(2)}, ${tokens} of ${limitTokens} tokens` }
  return { state: crossed.length ? 'alert' : 'ok', fraction, crossed, detail: `$${spentUsd.toFixed(4)} of $${limitUsd.toFixed(2)}, ${tokens} of ${limitTokens} tokens` }
}

export const usd = (v: number | null): string => v === null ? 'unknown' : `$${v < 0.01 ? v.toFixed(5) : v.toFixed(4)}`
