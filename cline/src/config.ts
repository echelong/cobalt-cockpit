// Configuration: shipped defaults, an optional user file, then explicit overrides.
// Validation is strict: an unknown role, a missing model or an unknown reasoning
// level is an error, never a silent default.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLES, isRole } from './core/engine.ts'
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
    workerTimeoutSeconds: number; gateTimeoutSeconds: number; clineRetries: number; pageSize: number; maxStoreBytes: number
  }
  /** "provider/model" ids that may run although they carry no required version (an explicit opt-in). */
  unpinnedAllowed: string[]
  sandbox: { hide: string[]; allowNetwork: boolean }
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
    }
  }
  for (const [id, p] of Object.entries(c.pricingOverrides ?? {})) for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) num(p[k], `pricingOverrides.${id}.${k}`)
  num(c.budgets.sessionUsd, 'budgets.sessionUsd'); num(c.budgets.sessionTokens, 'budgets.sessionTokens')
  for (const role of ROLES) { num(c.budgets.taskUsd[role], `budgets.taskUsd.${role}`); num(c.budgets.taskTokens[role], `budgets.taskTokens.${role}`); num(c.limits.concurrency[role], `limits.concurrency.${role}`) }
  num(c.limits.concurrency.total, 'limits.concurrency.total', 1)
  if (c.limits.maxTasksPerMission !== null) num(c.limits.maxTasksPerMission, 'limits.maxTasksPerMission', 1)
  for (const k of ['maxAttemptsPerTask', 'maxQueue', 'pageSize', 'maxStoreBytes', 'spawnsPerMinute'] as const) num(c.limits[k], `limits.${k}`, 1)
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
  return c
}

export type LoadOptions = { file?: string; profile?: string; strict?: boolean; overrides?: unknown }

export const loadConfig = (opts: LoadOptions = {}): Config => {
  let raw = JSON.parse(readFileSync(DEFAULT_CONFIG_FILE, 'utf8')) as unknown
  const user = opts.file ?? (existsSync(USER_CONFIG_FILE) ? USER_CONFIG_FILE : undefined)
  if (user) raw = merge(raw, JSON.parse(readFileSync(user, 'utf8')))
  if (opts.overrides !== undefined) raw = merge(raw, opts.overrides)
  const profile = opts.profile ?? process.env.COCKPIT_CLINE_PROFILE
  if (profile) raw = merge(raw, { profile })
  if (opts.strict !== undefined) raw = merge(raw, { strict: opts.strict })
  return validateConfig(raw)
}

export const rolesOf = (c: Config): Record<Role, RoleSpec> => c.profiles[c.profile].roles
