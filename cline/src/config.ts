// Configuration: shipped defaults, an optional user file, then explicit overrides.
// Validation is strict: an unknown role, a missing model or an unknown reasoning
// level is an error, never a silent default.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLES, isRole } from './core/engine.ts'
import { mountProblem } from './sandbox.ts'
import type { Role } from './core/engine.ts'

export const CLI_THINKING = ['none', 'low', 'medium', 'high', 'xhigh'] as const
export type Thinking = typeof CLI_THINKING[number]
export type RoleSpec = { provider: string; model: string; reasoning: Thinking; requireName?: string }
export type Pricing = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Config = {
  schema: 1; profile: string; strict: boolean
  profiles: Record<string, { description: string; roles: Record<Role, RoleSpec> }>
  pricingOverrides: Record<string, Pricing>
  escalation: Record<Role, Role | null>
  budgets: { sessionUsd: number; sessionTokens: number; taskUsd: Record<Role, number>; taskTokens: Record<Role, number>; alertAt: number[]; allowUnmetered: boolean; onSessionCap: 'cancel' | 'drain' }
  estimates: Record<Role, { input: number; output: number; cacheRatio: number }>
  limits: {
    maxTasksPerMission: number | null; maxQueue: number; maxDelegationDepth: number; maxChildrenPerTask: number
    concurrency: { total: number } & Record<Role, number>; perProvider: Record<string, number>; spawnsPerMinute: number
    minFreeMemoryMB: number; maxLoadPerCpu: number
    maxAttemptsPerTask: number; maxEscalationsPerTask: number; maxTransientRetries: number; providerUnhealthyAfter: number
    /** Correction attempts by the same model, given its diff and the gate evidence, before escalating. */ maxCorrectionsPerTask: number
    /** Exponential backoff with full jitter for transient failures: base * 2^n, capped. */ retryBaseMs: number; retryMaxMs: number
    workerTimeoutSeconds: number; gateTimeoutSeconds: number; clineRetries: number; pageSize: number; maxStoreBytes: number
  }
  /** "provider/model" ids that may run although they carry no required version (an explicit opt-in). */
  unpinnedAllowed: string[]
  /**
   * Workers and gates see only an allowlist of the host (see sandbox.ts). allowRead adds read-only paths the
   * owner approves (a toolchain, a dependency cache); hide covers paths inside what is mounted. Workers reach
   * only the Cline API, through the host-side broker; gates have no network.
   */
  sandbox: { hide: string[]; allowRead: string[] }
  tools: { allowed: string[]; readOnlyAllowed: string[] }
}

export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CONFIG_FILE = join(PACKAGE_DIR, 'config', 'default.json')
export const USER_CONFIG_FILE = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cobalt-cockpit-cline', 'config.json')

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const merge = (a: unknown, b: unknown): unknown => {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v)
  return out
}
const num = (v: unknown, path: string, min = 0): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new Error(`config ${path}: expected a number >= ${min}`)
  return v
}

export const validateConfig = (raw: unknown): Config => {
  if (!isObj(raw) || raw.schema !== 1) throw new Error('config: schema 1 required')
  const c = raw as unknown as Config
  if (typeof c.profile !== 'string' || !isObj(c.profiles) || !c.profiles[c.profile]) throw new Error(`config: profile "${String(c.profile)}" is not defined`)
  if (typeof c.strict !== 'boolean') throw new Error('config strict: boolean required')
  for (const [name, p] of Object.entries(c.profiles)) {
    if (!isObj(p.roles)) throw new Error(`config profiles.${name}.roles missing`)
    for (const key of Object.keys(p.roles)) if (!isRole(key)) throw new Error(`config profiles.${name}.roles: unknown role "${key}"`)
    for (const role of ROLES) {
      const r = p.roles[role]
      if (!isObj(r) || typeof r.provider !== 'string' || !r.provider || typeof r.model !== 'string' || !r.model) throw new Error(`config profiles.${name}.roles.${role}: provider and model required`)
      if (!(CLI_THINKING as readonly string[]).includes(r.reasoning)) throw new Error(`config profiles.${name}.roles.${role}.reasoning: one of ${CLI_THINKING.join('|')} (got ${String(r.reasoning)})`)
      // a null or empty pin would silently unpin the role (bypassing unpinnedAllowed): absent, or a version string
      if (r.requireName !== undefined && (typeof r.requireName !== 'string' || !r.requireName.trim())) throw new Error(`config profiles.${name}.roles.${role}.requireName: a non-empty version string, or leave it out (got ${JSON.stringify(r.requireName)})`)
    }
  }
  // pre-spawn estimates enforce the session budget before a worker starts: a typo must not disable that
  if (!isObj(c.estimates)) throw new Error('config estimates: object required')
  for (const role of ROLES) { const e = (c.estimates as Record<string, unknown>)[role]; if (!isObj(e)) throw new Error(`config estimates.${role}: object required`); num(e.input, `estimates.${role}.input`); num(e.output, `estimates.${role}.output`); num(e.cacheRatio, `estimates.${role}.cacheRatio`); if ((e.cacheRatio as number) > 1) throw new Error(`config estimates.${role}.cacheRatio: at most 1`) }
  if (!Array.isArray(c.budgets.alertAt) || !c.budgets.alertAt.every(x => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 1)) throw new Error('config budgets.alertAt: fractions in (0, 1]')
  if (typeof c.budgets.allowUnmetered !== 'boolean') throw new Error('config budgets.allowUnmetered: boolean required')
  for (const [id, p] of Object.entries(c.pricingOverrides ?? {})) for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) num(p[k], `pricingOverrides.${id}.${k}`)
  num(c.budgets.sessionUsd, 'budgets.sessionUsd'); num(c.budgets.sessionTokens, 'budgets.sessionTokens')
  for (const role of ROLES) { num(c.budgets.taskUsd[role], `budgets.taskUsd.${role}`); num(c.budgets.taskTokens[role], `budgets.taskTokens.${role}`); num(c.limits.concurrency[role], `limits.concurrency.${role}`) }
  num(c.limits.concurrency.total, 'limits.concurrency.total', 1)
  if (c.limits.maxTasksPerMission !== null) num(c.limits.maxTasksPerMission, 'limits.maxTasksPerMission', 1)
  for (const k of ['maxAttemptsPerTask', 'maxQueue', 'pageSize', 'maxStoreBytes', 'spawnsPerMinute'] as const) num(c.limits[k], `limits.${k}`, 1)
  for (const k of ['maxCorrectionsPerTask', 'retryBaseMs', 'retryMaxMs'] as const) num(c.limits[k], `limits.${k}`)
  if (c.limits.maxCorrectionsPerTask > 2) throw new Error('config limits.maxCorrectionsPerTask: at most 2')
  if (c.limits.maxTransientRetries > 5) throw new Error('config limits.maxTransientRetries: at most 5')
  if (c.limits.maxAttemptsPerTask > 8) throw new Error('config limits.maxAttemptsPerTask: at most 8')
  for (const k of ['maxDelegationDepth', 'maxChildrenPerTask', 'maxEscalationsPerTask', 'maxTransientRetries', 'providerUnhealthyAfter', 'workerTimeoutSeconds', 'gateTimeoutSeconds', 'clineRetries', 'minFreeMemoryMB', 'maxLoadPerCpu'] as const) num(c.limits[k], `limits.${k}`)
  if (c.limits.maxEscalationsPerTask > 2) throw new Error('config limits.maxEscalationsPerTask: at most 2')
  if (c.limits.maxDelegationDepth > 4) throw new Error('config limits.maxDelegationDepth: at most 4')
  if (!isObj(c.limits.perProvider)) throw new Error('config limits.perProvider: object required')
  for (const [p, n] of Object.entries(c.limits.perProvider)) num(n, `limits.perProvider.${p}`)
  if (!isObj(c.escalation)) throw new Error('config escalation: object required')
  for (const role of ROLES) { const to = c.escalation[role]; if (to !== null && to !== undefined && !isRole(to)) throw new Error(`config escalation.${role}: unknown role ${String(to)}`); if (to === role) throw new Error(`config escalation.${role}: cannot escalate to itself`) }
  if (c.budgets.onSessionCap !== 'cancel' && c.budgets.onSessionCap !== 'drain') throw new Error('config budgets.onSessionCap: cancel|drain')
  if (!Array.isArray(c.unpinnedAllowed)) throw new Error('config unpinnedAllowed: array required')
  if (!Array.isArray(c.tools.allowed) || !Array.isArray(c.tools.readOnlyAllowed)) throw new Error('config tools: allowed lists required')
  if (!isObj(c.sandbox) || !Array.isArray(c.sandbox.hide)) throw new Error('config sandbox.hide: array required')
  if ('allowNetwork' in c.sandbox) throw new Error('config sandbox.allowNetwork was removed: workers reach only the Cline API through the host-side broker, gates have no network')
  if (!Array.isArray(c.sandbox.allowRead)) throw new Error('config sandbox.allowRead: array of read-only paths required')
  for (const p of c.sandbox.allowRead) { const why = allowReadProblem(p); if (why) throw new Error(`config sandbox.allowRead ${JSON.stringify(p)}: ${why}`) }
  return c
}

/**
 * Why an approved read-only path would undo the boundary, or null. The root, a home directory as a whole,
 * anything holding the person's Cline data, keys or Cockpit state, and relative paths are refused.
 */
export const allowReadProblem = (raw: unknown): string | null => typeof raw === 'string' ? mountProblem(raw) : 'a path is required'

export type LoadOptions = { /** A user file; null for none (not even the default user file). */ file?: string | null; profile?: string; strict?: boolean; overrides?: unknown; /** Another defaults file (migrate-config compares against earlier shipped defaults). */ defaultsFile?: string }

/** Keys that would reach an object's prototype when merged by assignment: refused anywhere in a configuration file. */
const plainKeys = (v: unknown, file: string, path = ''): unknown => {
  if (Array.isArray(v)) v.forEach((x, i) => plainKeys(x, file, `${path}[${i}]`))
  else if (isObj(v)) for (const k of Object.keys(v)) { if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new Error(`config ${file}: key "${k}" is not allowed (at ${path || 'top level'})`); plainKeys(v[k], file, path ? `${path}.${k}` : k) }
  return v
}

/** The merged configuration before validation: defaults, then the user file, then overrides, profile and strictness. */
export const mergedConfig = (opts: LoadOptions = {}): unknown => {
  const defaults = opts.defaultsFile ?? DEFAULT_CONFIG_FILE
  let raw = plainKeys(JSON.parse(readFileSync(defaults, 'utf8')), defaults)
  const user = opts.file === null ? undefined : opts.file ?? (existsSync(USER_CONFIG_FILE) ? USER_CONFIG_FILE : undefined)
  if (user) raw = merge(raw, plainKeys(JSON.parse(readFileSync(user, 'utf8')), user))
  if (opts.overrides !== undefined) raw = merge(raw, opts.overrides)
  const profile = opts.profile ?? process.env.COCKPIT_CLINE_PROFILE
  if (profile) raw = merge(raw, { profile })
  if (opts.strict !== undefined) raw = merge(raw, { strict: opts.strict })
  return raw
}

export const loadConfig = (opts: LoadOptions = {}): Config => validateConfig(mergedConfig(opts))

export const rolesOf = (c: Config): Record<Role, RoleSpec> => c.profiles[c.profile].roles
