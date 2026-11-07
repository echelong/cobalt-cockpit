// Configuration compatibility for existing missions and conversations.
//
// A mission records `configDigest`, a digest of its whole effective configuration, when it starts, and reopening it
// under a configuration with another digest is refused unless the person accepts the change (--accept-config-change).
// That digest also covers text that never changes behaviour (a profile's description), so a wording fix would strand
// every conversation. This module lets a conversation continue across such a change, and only such a change:
//
//   - A mission keeps a snapshot of the exact configuration it started with (config-snapshot.json, written when it is
//     created; for missions made before snapshots existed, written only by `migrate-config --apply`). A snapshot is
//     trusted only if it hashes to the digest in the mission's own header, so it cannot claim another configuration.
//   - The runtime view of a configuration is the whole configuration minus an explicit, enumerated list of
//     descriptive settings (DESCRIPTIVE_PATHS). Nothing else is ever left out: an unknown key, a reordered list, a
//     larger budget, a smaller hide list, an extra tool or a different model is a runtime change.
//   - A mission continues without acceptance when its digest is unchanged, or when its snapshot is valid and the
//     runtime views of the snapshot and the current configuration are identical. Anything else still needs the
//     person's explicit acceptance, exactly as before; there is no exception for changes that look "stronger".
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The mission-directory file holding the configuration the mission started with. */
export const SNAPSHOT_FILE = 'config-snapshot.json'
/** Bumped whenever DESCRIPTIVE_PATHS changes, so fingerprints from different rules are never compared as equal. */
export const RUNTIME_VIEW_VERSION = 1
/**
 * The only settings that describe and never decide. '*' matches any one key. A profile's description is printed by
 * `doctor` and read by nothing else (a test scans the source for any other use).
 */
export const DESCRIPTIVE_PATHS: readonly (readonly string[])[] = [['profiles', '*', 'description']]

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** JSON with object keys sorted at every level; arrays keep their order (it can matter, so it counts). */
export const stableJson = (v: unknown): string => {
  const sorted = (x: unknown): unknown => Array.isArray(x) ? x.map(sorted) : isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sorted(x[k])])) : x
  return JSON.stringify(sorted(v))
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

/** The digest every mission header records: the whole effective configuration, keys sorted. Unchanged since 0.6. */
export const configDigest = (c: unknown): string => sha(stableJson(c)).slice(0, 16)

const matches = (path: readonly string[], pattern: readonly string[]): boolean => path.length === pattern.length && pattern.every((p, i) => p === '*' || p === path[i])
export const isDescriptive = (path: readonly string[]): boolean => DESCRIPTIVE_PATHS.some(p => matches(path, p))

/** The configuration without its descriptive settings (a deep copy; the input is not changed). */
export const runtimeView = (c: unknown, path: string[] = []): unknown => {
  if (Array.isArray(c)) return c.map((x, i) => runtimeView(x, [...path, String(i)]))
  if (!isObj(c)) return c
  const out: Record<string, unknown> = {}
  // defined, not assigned: a key named __proto__ stays an ordinary key and cannot change the copy's prototype
  for (const [k, v] of Object.entries(c)) if (!isDescriptive([...path, k])) Object.defineProperty(out, k, { value: runtimeView(v, [...path, k]), enumerable: true, writable: true, configurable: true })
  return out
}
/** A versioned fingerprint of the runtime view, for display and records; equality is decided on the views themselves. */
export const runtimeFingerprint = (c: unknown): string => `r${RUNTIME_VIEW_VERSION}:${sha(stableJson(runtimeView(c))).slice(0, 32)}`
export const sameRuntime = (a: unknown, b: unknown): boolean => stableJson(runtimeView(a)) === stableJson(runtimeView(b))

// ---------------------------------------------------------------------------
// Differences, for the person: which settings changed, and whether the change touches isolation, tools, models,
// pinning, budgets or limits. The classification explains; it never decides compatibility.
export type Category = 'descriptive' | 'sandbox' | 'tools' | 'models' | 'budget' | 'limits' | 'other'
export type Change = { path: string; category: Category; securityRelevant: boolean; before: unknown; after: unknown; note: string | null }

export const categoryOf = (path: readonly string[]): Category => {
  if (isDescriptive(path)) return 'descriptive'
  const top = path[0]
  if (top === 'sandbox') return 'sandbox'
  if (top === 'tools') return 'tools'
  // roles, models, reasoning, version pins and their opt-outs, strictness, escalation
  if (top === 'profile' || top === 'profiles' || top === 'strict' || top === 'unpinnedAllowed' || top === 'escalation' || top === 'schema') return 'models'
  if (top === 'budgets' || top === 'pricingOverrides' || top === 'estimates') return 'budget'
  if (top === 'limits') return 'limits'
  return 'other'
}

const listNote = (path: string, before: unknown, after: unknown): string | null => {
  if (!Array.isArray(before) || !Array.isArray(after)) return null
  const b = before.map(x => JSON.stringify(x)), a = after.map(x => JSON.stringify(x))
  const removed = b.filter(x => !a.includes(x)), added = a.filter(x => !b.includes(x))
  const parts: string[] = []
  const loosens: Record<string, 'added' | 'removed'> = { 'sandbox.hide': 'removed', 'sandbox.allowRead': 'added', 'tools.allowed': 'added', 'tools.readOnlyAllowed': 'added', unpinnedAllowed: 'added' }
  if (removed.length) parts.push(`removed ${removed.join(', ')}${loosens[path] === 'removed' ? ' (less protection)' : ''}`)
  if (added.length) parts.push(`added ${added.join(', ')}${loosens[path] === 'added' ? ' (less protection)' : ''}`)
  if (!removed.length && !added.length) parts.push('same entries, different order or repetition')
  return parts.join('; ')
}

/** Every setting that differs between two configurations, leaf by leaf (a list is one setting). */
export const diffConfig = (before: unknown, after: unknown, path: string[] = []): Change[] => {
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    return keys.flatMap(k => diffConfig(before[k], after[k], [...path, k]))
  }
  if (stableJson(before) === stableJson(after)) return []
  const category = categoryOf(path)
  const p = path.join('.')
  let note = listNote(p, before, after)
  if (note === null && typeof before === 'number' && typeof after === 'number') note = after > before ? 'raised' : 'lowered'
  if (note === null && p === 'strict' && before === true && after === false) note = 'strict checks turned off (less protection)'
  if (note === null && p === 'budgets.allowUnmetered' && after === true) note = 'unmetered work allowed (less protection)'
  if (note === null && path[path.length - 1] === 'requireName' && after === undefined) note = 'version pin removed (less protection)'
  return [{ path: p, category, securityRelevant: category !== 'descriptive', before, after, note }]
}

// ---------------------------------------------------------------------------
// Snapshots.
export type Snapshot = { v: 1; missionId: string; configDigest: string; recordedAt: string; method: 'created' | 'migrated'; source: string | null; by?: string; config: unknown }
export type SnapshotState = { state: 'absent' } | { state: 'valid'; snapshot: Snapshot } | { state: 'invalid'; why: string }

export const snapshotFor = (missionId: string, digest: string, config: unknown, method: Snapshot['method'], source: string | null = null): Snapshot => {
  if (configDigest(config) !== digest) throw new Error(`config snapshot for ${missionId}: the configuration does not match the mission's digest ${digest}`)
  return { v: 1, missionId, configDigest: digest, recordedAt: new Date().toISOString(), method, source, config }
}

/**
 * The mission's snapshot, trusted only when it is well formed, names this mission and hashes to the digest in the
 * mission's header. Anything else is 'invalid' and proves nothing (the mission then needs explicit acceptance).
 */
export const readSnapshot = (dir: string, header: { id: string; configDigest: string }): SnapshotState => {
  const f = join(dir, SNAPSHOT_FILE)
  if (!existsSync(f)) return { state: 'absent' }
  let s: Partial<Snapshot>
  try { s = JSON.parse(readFileSync(f, 'utf8')) as Partial<Snapshot> } catch { return { state: 'invalid', why: `${SNAPSHOT_FILE} is not readable JSON` } }
  if (!isObj(s) || s.v !== 1 || (s.method !== 'created' && s.method !== 'migrated') || !('config' in s)) return { state: 'invalid', why: `${SNAPSHOT_FILE} is not a version 1 snapshot` }
  if (s.missionId !== header.id) return { state: 'invalid', why: `${SNAPSHOT_FILE} names mission ${String(s.missionId)}` }
  if (s.configDigest !== header.configDigest || configDigest(s.config) !== header.configDigest) return { state: 'invalid', why: `${SNAPSHOT_FILE} does not match the configuration digest ${header.configDigest} the mission started with` }
  return { state: 'valid', snapshot: s as Snapshot }
}

export type Compatibility =
  | { outcome: 'identical' }
  | { outcome: 'equivalent'; changes: Change[] }
  | { outcome: 'changed'; changes: Change[] | null; why: string }

/**
 * Whether a mission that started with `digest` (and, if it has one, `snap`) may continue under `current` without
 * the person's acceptance. Only 'identical' and 'equivalent' may; 'equivalent' means only descriptive settings differ.
 */
export const compatibility = (digest: string, snap: SnapshotState, current: unknown): Compatibility => {
  if (configDigest(current) === digest) return { outcome: 'identical' }
  if (snap.state === 'absent') return { outcome: 'changed', changes: null, why: 'the configuration differs, and the mission keeps no snapshot of the one it started with to compare' }
  if (snap.state === 'invalid') return { outcome: 'changed', changes: null, why: snap.why }
  const changes = diffConfig(snap.snapshot.config, current)
  if (sameRuntime(snap.snapshot.config, current)) return { outcome: 'equivalent', changes }
  const relevant = changes.filter(c => c.category !== 'descriptive')
  return { outcome: 'changed', changes, why: `runtime settings differ: ${relevant.map(c => c.path).join(', ')}` }
}

/** One line per change, for refusals and reports. */
export const describeChanges = (changes: Change[]): string[] => changes.map(c => `${c.path} [${c.category}${c.securityRelevant ? ', runtime' : ''}]${c.note ? `: ${c.note}` : ''}`)
