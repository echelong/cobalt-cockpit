// Model resolution against the INSTALLED Cline: its own model registry (@cline/llms)
// and its own provider settings. Displayed names are never taken as API ids.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Role } from './core/engine.ts'
import type { RoleSpec } from './config.ts'

export type ModelInfo = {
  id: string; name?: string; contextWindow?: number; maxTokens?: number
  capabilities?: string[]
  reasoningOptions?: { type: string; values?: string[] }[]
  pricing?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  releaseDate?: string; family?: string
}
export type Catalog = {
  clineVersion: string; sdkVersion: string; source: string
  models: (provider: string) => Promise<Record<string, ModelInfo> | null>
}

/** The cline package root behind the `cline` on PATH (or COCKPIT_CLINE_CATALOG_BIN). Worker binaries (COCKPIT_CLINE_BIN) never change the catalog. */
export const clinePackageRoot = (bin = process.env.COCKPIT_CLINE_CATALOG_BIN ?? 'cline'): string => {
  const path = bin.includes('/') ? bin : (process.env.PATH ?? '').split(':').filter(Boolean).map(d => join(d, bin)).find(p => existsSync(p))
  if (!path) throw new Error(`cline not found on PATH (${bin})`)
  return dirname(dirname(realpathSync(path)))
}

export const loadCatalog = async (root = clinePackageRoot()): Promise<Catalog> => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string }
  if (pkg.name !== 'cline') throw new Error(`unexpected package at ${root}: ${pkg.name}`)
  const llmsDir = join(root, 'node_modules', '@cline', 'llms')
  const llmsPkg = JSON.parse(readFileSync(join(llmsDir, 'package.json'), 'utf8')) as { version: string }
  const entry = join(llmsDir, 'dist', 'models.js')
  if (!existsSync(entry)) throw new Error(`@cline/llms model registry missing at ${entry}`)
  const mod = await import(pathToFileURL(entry).href) as { getModelsForProvider: (p: string) => Promise<Record<string, ModelInfo>>; getProviderIds: () => string[] }
  return {
    clineVersion: pkg.version, sdkVersion: llmsPkg.version, source: entry,
    models: async provider => (mod.getProviderIds().includes(provider) ? await mod.getModelsForProvider(provider) : null),
  }
}

/** A catalog built from fixed data, for offline tests and fake providers. */
export const staticCatalog = (data: Record<string, Record<string, ModelInfo>>, clineVersion = 'fixture'): Catalog => ({
  clineVersion, sdkVersion: 'fixture', source: 'static',
  models: async provider => data[provider] ?? null,
})

export type Resolution =
  | { ok: true; role: Role; provider: string; model: string; info: ModelInfo; reasoningValues: string[]; reasoningToggle: boolean; notes: string[] }
  | { ok: false; role: Role; provider: string; model: string; reason: string }

const ALIAS = /(^~)|latest|(^|[/-])auto$/i

/** Resolves one role's configured provider/model against the installed catalog. Fails closed. */
export const resolveRole = async (catalog: Catalog, role: Role, spec: RoleSpec, unpinnedAllowed: readonly string[] = []): Promise<Resolution> => {
  const base = { role, provider: spec.provider, model: spec.model }
  if (ALIAS.test(spec.model)) return { ...base, ok: false, reason: `"${spec.model}" is an alias; a version-pinned model id is required` }
  const models = await catalog.models(spec.provider)
  if (!models) return { ...base, ok: false, reason: `provider "${spec.provider}" is not known to installed Cline ${catalog.clineVersion}` }
  const info = models[spec.model]
  if (!info) return { ...base, ok: false, reason: `model "${spec.model}" is not in provider "${spec.provider}"'s catalog (Cline ${catalog.clineVersion})` }
  if (info.id !== spec.model) return { ...base, ok: false, reason: `catalog entry id "${info.id}" differs from configured "${spec.model}"` }
  const notes: string[] = []
  if (spec.requireName && !(info.id.includes(spec.requireName) && (info.name ?? '').includes(spec.requireName))) {
    const why = `model "${info.id}" (${info.name ?? 'no name'}) does not carry required version "${spec.requireName}" in both id and name`
    if (!unpinnedAllowed.includes(`${spec.provider}/${spec.model}`)) return { ...base, ok: false, reason: `${why}; add "${spec.provider}/${spec.model}" to unpinnedAllowed to opt in` }
    notes.push(`UNPINNED (opted in): ${why}`)
  }
  if (!(info.capabilities ?? []).includes('tools')) return { ...base, ok: false, reason: `model "${info.id}" does not declare tool use` }
  const effort = (info.reasoningOptions ?? []).find(o => o.type === 'effort')
  const toggle = (info.reasoningOptions ?? []).some(o => o.type === 'toggle')
  return { ...base, ok: true, info, reasoningValues: effort?.values ?? [], reasoningToggle: toggle, notes }
}

export type AuthState = { provider: string; configured: boolean; kind: 'oauth' | 'api-key' | 'none'; expiresAt: number | null; note: string }

/** Reads only whether a provider has credentials in Cline's settings. Never returns or logs secret values. */
export const providerAuth = (provider: string, dataDir = join(homedir(), '.cline', 'data')): AuthState => {
  const file = join(dataDir, 'settings', 'providers.json')
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { providers?: Record<string, { settings?: { apiKey?: unknown; auth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } } }> }
    const s = doc.providers?.[provider]?.settings
    if (!s) return { provider, configured: false, kind: 'none', expiresAt: null, note: `no "${provider}" entry in Cline settings` }
    const token = typeof s.auth?.accessToken === 'string' && s.auth.accessToken.length > 0
    const refresh = typeof s.auth?.refreshToken === 'string' && s.auth.refreshToken.length > 0
    const key = typeof s.apiKey === 'string' && s.apiKey.length > 0
    const expiresAt = typeof s.auth?.expiresAt === 'number' ? s.auth.expiresAt : null
    if (token || refresh) return { provider, configured: true, kind: 'oauth', expiresAt, note: expiresAt !== null && expiresAt < Date.now() ? (refresh ? 'access token expired; the Cockpit broker refreshes it on the host before a worker uses it' : 'access token expired and no refresh token') : 'signed in' }
    if (key) return { provider, configured: true, kind: 'api-key', expiresAt: null, note: 'api key present' }
    return { provider, configured: false, kind: 'none', expiresAt: null, note: 'entry has no credentials' }
  } catch (e) {
    return { provider, configured: false, kind: 'none', expiresAt: null, note: `Cline settings unreadable (${(e as Error).message.split('\n')[0]})` }
  }
}
