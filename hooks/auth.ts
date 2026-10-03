// How this session is authenticated, said honestly.
//
// The plugin never sees a credential. The engine answers the kind of the
// session's own credential (`$.session.authorize()` hands back an opaque handle
// and `bearer` or `api-key`), and register.tsx checks whether each API-style
// variable or setting is present, by name. What reaches this module is that
// kind and a list of names from the fixed table below; a value is never passed
// in, so one cannot be stored, drawn or logged.
//
// The reading is conservative in one direction only: SUBSCRIPTION and
// `API BILLING / OFF` are claimed when the engine holds a sign-in credential
// and nothing API-shaped is configured, and in every other case the diagnostic
// says what it found instead of what would be reassuring.

import type { AuthMode, AuthState, Credential, PolicyState } from '../types'
import type { Row } from './view'

export type { AuthMode, AuthState, Credential } from '../types'

/** Environment variables that switch Claude Code to a key, a token, a gateway or another provider. */
export const API_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
] as const

export type ApiEnv = (typeof API_ENV)[number]

const SETTINGS_KEYS = ['apiKeyHelper'] as const

/**
 * The API-style configuration a settings object carries, as names: the key
 * helper, and any of the variables above set through the `env` block.
 */
export const settingsSources = (settings: Readonly<Record<string, unknown>>): string[] => {
  const found: string[] = []
  for (const key of SETTINGS_KEYS) {
    const value = settings[key]
    if (typeof value === 'string' && value.trim() !== '') found.push(`settings ${key}`)
  }
  const env = settings['env']
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    for (const name of API_ENV) {
      const value = (env as Record<string, unknown>)[name]
      if (value !== undefined && value !== null && value !== '') found.push(`settings env ${name}`)
    }
  }

  return found
}

/** A name from the fixed tables above, or nothing: a source can never carry a value. */
const KNOWN = new Set<string>([...API_ENV.map(name => `env ${name}`), ...API_ENV.map(name => `settings env ${name}`), ...SETTINGS_KEYS.map(key => `settings ${key}`)])

/**
 * The session's authentication, from the credential's kind and the names of
 * whatever API-style configuration is present.
 *
 * `api`: the engine holds an API key, or a key, token, gateway or provider
 * switch is configured, any of which can take the session off the
 * subscription. `subscription`: a sign-in credential and none of those.
 * `unverified`: the engine did not say, and nothing is claimed.
 */
export const authOf = (credential: Credential, present: readonly string[], at: number): AuthState => {
  const sources = [...new Set(present.filter(name => KNOWN.has(name)))]
  const mode: AuthMode = credential === 'api-key' || sources.length > 0 ? 'api' : credential === 'bearer' ? 'subscription' : 'unverified'

  return { mode, credential, sources, at }
}

/**
 * The startup diagnostic, in the HUD's label grammar.
 *
 * `API BILLING / OFF` appears only beside `AUTH / SUBSCRIPTION`. It is a
 * statement about how the session is authenticated, not a cost figure: the
 * plugin has no way to price a subscription's usage and does not try.
 */
export const authLines = (auth: AuthState | null, blocksFable = true): string[] => {
  if (auth === null) return []
  if (auth.mode === 'subscription') return ['AUTH / SUBSCRIPTION', 'API BILLING / OFF', blocksFable ? 'FABLE / BLOCKED' : 'FABLE / ALLOWED']
  if (auth.mode === 'api') return ['AUTH / API DETECTED', blocksFable ? 'FABLE / BLOCKED' : 'FABLE / ALLOWED']

  return ['AUTH / UNVERIFIED', blocksFable ? 'FABLE / BLOCKED' : 'FABLE / ALLOWED']
}

/** What a prompt is refused with while the session is not on the subscription. */
export const API_REFUSAL =
  'AUTH / API DETECTED. This workflow runs on the Claude subscription only, and API-style authentication is configured for this session, so nothing was sent. Remove API-style configuration from your session, sign in to your subscription, or set the plugin option "subscriptionOnly" to false to allow it.'

const line = (name: string, value: string, color?: string, dim = false): Row => [
  { text: ` ${name.padEnd(13)}`, isDim: true },
  { text: value, ...(color === undefined ? {} : { color }), ...(dim ? { isDim: true } : {}) },
]

/**
 * The detailed diagnostics for /cockpit: how the session is authenticated,
 * where any API-style configuration was found (names only), and the Fable
 * policy with the calls actually counted in this session.
 */
export const authRows = (auth: AuthState | null, policy: PolicyState, colors: { ok: string; bad: string; warn: string }, blocksFable = true): Row[] => {
  const rows: Row[] = []
  if (auth === null) {
    rows.push(line('Auth', 'not read yet', undefined, true))
  } else if (auth.mode === 'subscription') {
    rows.push(line('Auth', 'SUBSCRIPTION', colors.ok), line('API billing', 'OFF', colors.ok))
  } else if (auth.mode === 'api') {
    rows.push(line('Auth', 'API DETECTED', colors.bad))
    rows.push(line('API billing', 'not established as off', colors.warn))
    if (auth.credential === 'api-key') rows.push(line('Credential', 'API key held by the engine', colors.warn))
    for (const source of auth.sources) rows.push(line('Source', `${source} is set`, colors.warn))
  } else {
    rows.push(line('Auth', 'UNVERIFIED', colors.warn), line('API billing', 'not established', colors.warn))
  }
  rows.push([{ text: ' FABLE', isDim: true }])
  rows.push(line('  Policy', blocksFable ? 'BLOCKED' : 'ALLOWED', colors.ok))
  rows.push(line('  Calls', String(policy.calls), policy.calls === 0 ? colors.ok : colors.bad))
  if (policy.blocks > 0) rows.push(line('  Refused', String(policy.blocks), colors.warn))

  return rows
}
