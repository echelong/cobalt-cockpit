// migrate-config: what a configuration change would do to the existing missions and conversations, and (only with
// --apply) recording the snapshot that lets a conversation continue across a change of descriptive settings alone.
//
// The dry run reads and never writes. --apply only creates config-snapshot.json (the configuration the mission
// provably started with) in open conversations that need it to continue. It never changes a mission's header,
// ledger, digest or settings, never edits the person's configuration and never accepts a configuration change.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG_FILE, mergedConfig, USER_CONFIG_FILE, validateConfig } from './config.ts'
import { compatibility, configDigest, describeChanges, diffConfig, readSnapshot, runtimeFingerprint, SNAPSHOT_FILE, snapshotFor } from './compat.ts'
import type { Change, SnapshotState } from './compat.ts'
import { readJson } from './store.ts'
import type { LockBody } from './store.ts'
import { sameProcess } from './proc.ts'
import { missionDir } from './supervisor.ts'
import type { Header } from './supervisor.ts'

export type MigrateOptions = {
  stateRoot: string
  /** The person's configuration file as it is now (default: the user file, if it exists; null: none). */
  userFile?: string | null
  /** The configuration file the person proposes (default: the current one). */
  proposedFile?: string
  /** Shipped defaults the existing missions may have run under (earlier versions); the first is "current" in the report. */
  previousDefaults?: string[]
  /** The installed Cline version, if known: a mission started on another one needs acceptance whatever the config. */
  clineVersion?: string
  apply?: boolean
}
export type Outcome = 'unchanged' | 'continues' | 'continues-after-apply' | 'requires-acceptance'
export type MissionReport = {
  id: string; mode: string; repoRoot: string; closed: boolean; shellResumes: boolean; profile: string; strict: boolean
  startedWith: string; clineVersion: string; snapshot: SnapshotState['state']
  original: 'snapshot' | 'reconstructed' | 'unproven'; originalSource: string | null
  proposedDigest: string; proposedRuntime: string
  outcome: Outcome; why: string; changes: Change[] | null
  applied: string | null
}
export type Report = {
  current: { digest: string; runtime: string; defaults: string; user: string | null }
  proposed: { digest: string; runtime: string; defaults: string; user: string | null }
  differences: Change[]
  missions: MissionReport[]
  unreadable: { id: string; why: string }[]
}

const fileSha = (f: string): string => createHash('sha256').update(readFileSync(f, 'utf8')).digest('hex').slice(0, 16)
const describeFile = (f: string | null): string => f ? `${f} (sha256 ${fileSha(f)})` : 'none'
/** Parsing a configuration file, without echoing its text (V8 quotes input in JSON errors). */
const readable = (f: string, what: string): void => {
  let text: string
  try { text = readFileSync(f, 'utf8') } catch (e) { throw new Error(`${what} ${f}: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`) }
  try { JSON.parse(text) } catch { throw new Error(`${what} ${f}: not valid JSON`) }
}

export const migrationReport = (o: MigrateOptions): Report => {
  const userFile = o.userFile === null ? undefined : o.userFile ?? (existsSync(USER_CONFIG_FILE) ? USER_CONFIG_FILE : undefined)
  const proposedFile = o.proposedFile ?? userFile
  const candidates = [...new Set([...(o.previousDefaults ?? []), DEFAULT_CONFIG_FILE])]
  const previous = candidates[0]
  for (const [f, what] of [[userFile, 'configuration'], [proposedFile, 'proposed configuration'], ...candidates.map(c => [c, 'defaults'] as const)] as const) if (f) readable(f, what)
  // exactly the files named: the person's file (or none), never one picked up from the environment
  const loadOrDefaults = (defaultsFile: string, file: string | undefined, profile?: string, strict?: boolean): unknown =>
    mergedConfig({ defaultsFile, file: file ?? null, profile, strict })
  const current = loadOrDefaults(previous, userFile)
  const proposed = loadOrDefaults(DEFAULT_CONFIG_FILE, proposedFile)
  validateConfig(proposed)
  const report: Report = {
    current: { digest: configDigest(current), runtime: runtimeFingerprint(current), defaults: describeFile(previous), user: userFile ? describeFile(userFile) : null },
    proposed: { digest: configDigest(proposed), runtime: runtimeFingerprint(proposed), defaults: describeFile(DEFAULT_CONFIG_FILE), user: proposedFile ? describeFile(proposedFile) : null },
    differences: diffConfig(current, proposed), missions: [], unreadable: [],
  }
  let ids: string[] = []
  try { ids = readdirSync(join(o.stateRoot, 'missions')).sort() } catch { /* no missions */ }
  const rows: { h: Header; closed: boolean; dir: string }[] = []
  for (const id of ids) {
    const dir = missionDir(o.stateRoot, id)
    try {
      const h = readJson<Header>(join(dir, 'mission.json'))
      const l = existsSync(join(dir, 'live.json')) ? readJson<{ closed?: boolean }>(join(dir, 'live.json')) : {}
      if (h.id !== id || typeof h.configDigest !== 'string') throw new Error('header does not describe this mission')
      rows.push({ h, closed: !!l.closed, dir })
    } catch (e) { report.unreadable.push({ id, why: e instanceof SyntaxError ? 'mission.json or live.json is not valid JSON' : (e as NodeJS.ErrnoException).code ?? (e as Error).message.slice(0, 120) }) }
  }
  // the interactive shell resumes only the newest open conversation of a repository (shell.ts openMission)
  const newest = new Map<string, string>()
  for (const r of [...rows].sort((a, b) => b.h.id.localeCompare(a.h.id))) if (r.h.mode === 'conversation' && !r.closed && !newest.has(r.h.repoRoot)) newest.set(r.h.repoRoot, r.h.id)
  for (const { h, closed, dir } of rows) {
    const snap = readSnapshot(dir, h)
    // the configuration the mission started with, proven by its own digest
    let original: unknown = null, how: MissionReport['original'] = 'unproven', source: string | null = null
    if (snap.state === 'valid') { original = snap.snapshot.config; how = 'snapshot'; source = snap.snapshot.source ?? snap.snapshot.method }
    else for (const d of candidates) {
      const c = loadOrDefaults(d, userFile, h.profile, h.strict)
      if (configDigest(c) === h.configDigest) { original = c; how = 'reconstructed'; source = `defaults ${describeFile(d)}; user configuration ${describeFile(userFile ?? null)}`; break }
    }
    const next = loadOrDefaults(DEFAULT_CONFIG_FILE, proposedFile, h.profile, h.strict)
    const versionChanged = o.clineVersion !== undefined && o.clineVersion !== h.clineVersion
    let outcome: Outcome, why: string, changes: Change[] | null = null
    const c = compatibility(h.configDigest, snap, next)
    if (c.outcome === 'identical') { outcome = 'unchanged'; why = 'same configuration digest' }
    else if (c.outcome === 'equivalent') { outcome = 'continues'; why = 'only descriptive settings differ from its snapshot'; changes = c.changes }
    else if (snap.state === 'absent' && how === 'reconstructed') {
      const c2 = compatibility(h.configDigest, { state: 'valid', snapshot: snapshotFor(h.id, h.configDigest, original, 'migrated', source) }, next)
      changes = c2.outcome === 'identical' ? [] : c2.changes
      if (c2.outcome === 'equivalent' && (h.mode !== 'conversation' || closed)) { outcome = 'requires-acceptance'; why = `only descriptive settings differ, but --apply records snapshots only for open conversations (this is ${closed ? 'a closed conversation' : `a ${h.mode} mission`})` }
      else if (c2.outcome === 'equivalent') { outcome = 'continues-after-apply'; why = 'only descriptive settings differ; recording its snapshot (--apply) lets it continue' }
      else { outcome = 'requires-acceptance'; why = c2.outcome === 'changed' ? c2.why : 'unexpected' }
    } else { outcome = 'requires-acceptance'; why = c.outcome === 'changed' && c.changes ? c.why : how === 'unproven' ? 'the configuration it started with cannot be proven (neither a snapshot nor the given defaults and user configuration reproduce its digest)' : (c as { why: string }).why; changes = c.outcome === 'changed' ? c.changes : null }
    if (versionChanged && outcome !== 'requires-acceptance') { outcome = 'requires-acceptance'; why = `it started on Cline ${h.clineVersion}; installed is ${o.clineVersion}` }
    report.missions.push({
      id: h.id, mode: h.mode, repoRoot: h.repoRoot, closed, shellResumes: newest.get(h.repoRoot) === h.id, profile: h.profile, strict: h.strict,
      startedWith: h.configDigest, clineVersion: h.clineVersion, snapshot: snap.state, original: how, originalSource: source,
      proposedDigest: configDigest(next), proposedRuntime: runtimeFingerprint(next), outcome, why, changes, applied: null,
    })
    const row = report.missions[report.missions.length - 1]
    // only open conversations: a closed conversation is never resumed, and a finished mission's state is evidence
    if (o.apply && outcome === 'continues-after-apply') {
      try { row.applied = recordSnapshot(dir, h.id, original, source) }
      catch (e) { row.applied = `skipped: ${(e as NodeJS.ErrnoException).code ?? 'the snapshot could not be written'}` }
    }
  }
  return report
}

/**
 * Who holds a lock file, if anyone may: a lock that exists but cannot be read (being written, torn) counts as held,
 * and so does one from another host. Only a readable lock of a process provably gone on this host is free. The file
 * is only read: never created, taken over or removed.
 */
const holder = (file: string): string | null => {
  if (!existsSync(file)) return null
  let b: LockBody
  try { b = readJson<LockBody>(file) } catch { return 'an unreadable lock holder' }
  if (!b || typeof b !== 'object' || typeof b.host !== 'string' || !b.holder || typeof b.holder.pid !== 'number') return 'an unreadable lock holder'
  if (b.host !== hostname() || sameProcess(b.holder)) return `pid ${b.holder?.pid ?? '?'} (${b.purpose ?? 'unknown purpose'}${b.host !== hostname() ? ` on ${b.host}` : ''})`
  return null
}

/** Creates `file` with `data` only if it does not exist (write a private temporary file, then hard-link it in). */
export const createExclusive = (file: string, data: string): boolean => {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeSync(fd, data); fsyncSync(fd) } catch (e) { closeSync(fd); unlinkSync(tmp); throw e }
  closeSync(fd)
  try { linkSync(tmp, file); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e } finally {
    unlinkSync(tmp)
    try { const d = openSync(dirname(file), 'r'); try { fsyncSync(d) } finally { closeSync(d) } } catch { /* directory fsync unsupported */ }
  }
}

/**
 * Records a mission's snapshot. It writes exactly one new file, config-snapshot.json, created only if absent (so
 * concurrent runs record it once) and complete or not there at all (so an interrupted run leaves nothing to repair).
 * It takes no lock and writes no ledger record: the snapshot carries how and from what it was recorded, and the
 * mission's ledger records that when the mission is next opened (config_equivalent). A mission held by a live shell
 * or supervisor is skipped. The original is checked against the mission's digest again just before writing.
 */
export const recordSnapshot = (dir: string, id: string, original: unknown, source: string | null): string => {
  for (const f of ['shell.lock', 'supervisor.lock']) { const who = holder(join(dir, f)); if (who) return `skipped: the mission is held by ${who} (${f}); run again when it has stopped` }
  let h: Header
  try { h = readJson<Header>(join(dir, 'mission.json')) } catch { return 'skipped: the mission header is unreadable' }
  if (h.id !== id) return 'skipped: the mission header changed'
  const snap = readSnapshot(dir, h)
  if (snap.state === 'invalid') return `skipped: ${snap.why}; it is left as it is`
  if (snap.state === 'valid') return 'already recorded'
  if (configDigest(original) !== h.configDigest) return 'skipped: the configuration no longer matches the mission digest'
  const made = createExclusive(join(dir, SNAPSHOT_FILE), JSON.stringify({ ...snapshotFor(id, h.configDigest, original, 'migrated', source), by: 'cockpit-cline migrate-config --apply' }, null, 1))
  return made ? 'recorded' : 'already recorded'
}

/** The report as text for a terminal. */
export const reportText = (r: Report, applied: boolean): string => {
  const out: string[] = []
  out.push(`current   config ${r.current.digest}  runtime ${r.current.runtime}`)
  out.push(`          defaults ${r.current.defaults}`)
  out.push(`          user configuration ${r.current.user ?? 'none'}`)
  out.push(`proposed  config ${r.proposed.digest}  runtime ${r.proposed.runtime}`)
  out.push(`          defaults ${r.proposed.defaults}`)
  out.push(`          user configuration ${r.proposed.user ?? 'none'}`)
  const rel = r.differences.filter(c => c.securityRelevant)
  out.push(`differences: ${r.differences.length ? '' : 'none'}`)
  for (const l of describeChanges(r.differences)) out.push(`  ${l}`)
  out.push(`security-relevant settings change: ${rel.length ? `YES (${rel.map(c => c.path).join(', ')})` : 'no'}`)
  out.push('')
  const label: Record<Outcome, string> = { unchanged: 'continues (unchanged)', continues: 'continues (descriptive change only)', 'continues-after-apply': 'continues once its snapshot is recorded (--apply)', 'requires-acceptance': 'REQUIRES --accept-config-change' }
  for (const m of r.missions) {
    out.push(`${m.id}  ${m.mode}${m.closed ? ' (closed)' : ''}${m.mode === 'conversation' && !m.closed ? (m.shellResumes ? ' (the shell resumes this one)' : ' (older: the shell resumes a newer one)') : ''}  ${m.repoRoot}`)
    out.push(`  started with ${m.startedWith} on Cline ${m.clineVersion} · judged as reopened with --profile ${m.profile}${m.strict ? '' : ' --no-strict'} · original ${m.original}${m.originalSource ? ` (${m.originalSource})` : ''}`)
    out.push(`  proposed ${m.proposedDigest} ${m.proposedRuntime} -> ${label[m.outcome]}: ${m.why}`)
    for (const l of describeChanges((m.changes ?? []).filter(c => c.category !== 'descriptive'))) out.push(`    ${l}`)
    if (m.applied) out.push(`  apply: ${m.applied}`)
  }
  for (const u of r.unreadable) out.push(`${u.id}  unreadable: ${u.why}`)
  const n = (o: Outcome): number => r.missions.filter(m => m.outcome === o).length
  out.push('')
  out.push(`${r.missions.length} mission(s): ${n('unchanged')} unchanged, ${n('continues')} continue, ${n('continues-after-apply')} continue after --apply, ${n('requires-acceptance')} need --accept-config-change${r.unreadable.length ? `, ${r.unreadable.length} unreadable` : ''}`)
  out.push('Each mission is judged as reopened with its own profile and strictness (as recover does); the interactive shell uses the current --profile and --no-strict, and a --budget-usd given then also counts as a change.')
  out.push(applied ? 'applied: snapshots recorded where shown; nothing else was changed.' : 'dry run: nothing was changed. --apply records the snapshots above (open conversations only); it never accepts a configuration change.')
  return out.join('\n')
}
