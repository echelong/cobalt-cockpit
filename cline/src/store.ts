// Durable mission store.
//
//   <state>/missions/<id>/mission.json      immutable header
//   <state>/missions/<id>/live.json          unfinished and uncertain work only (atomic replace)
//   <state>/missions/<id>/archive/           finished tasks, paginated: page-NNNNNN.jsonl,
//                                            index.json and ids/<xx>.json (hash-sharded id lookup)
//   <state>/missions/<id>/ledger/            hash-chained, segmented event log
//   <state>/missions/<id>/runs/<task>/<n>/   per-attempt evidence
//   <git-common-dir>/cobalt-cockpit-cline/   repo-scoped write claims and mission markers
//
// Reload reads mission.json, live.json and archive/index.json only, so it is bounded by
// live work, not by history. Claims are never deleted to save space: a claim is retired
// only after the worker it covers is verified gone (see sandbox.ts).
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { redactSecrets } from './core/engine.ts'
import { processIdentity, sameProcess } from './proc.ts'
import type { ProcessIdentity } from './proc.ts'

export const stateRoot = (): string => process.env.COCKPIT_CLINE_STATE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'cobalt-cockpit-cline')

/** Atomic replace: temp file, fsync, rename, fsync directory. */
export const writeAtomic = (file: string, data: string): void => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
  try { const d = openSync(dirname(file), 'r'); try { fsyncSync(d) } finally { closeSync(d) } } catch { /* directory fsync unsupported */ }
}
export const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T

// ---------------------------------------------------------------------------
// Exclusive lock files (pid + /proc start time). A lock whose holder is gone is stale.
export type LockBody = { holder: ProcessIdentity; host: string; at: string; purpose: string }

export const tryLock = (file: string, purpose: string): { ok: true } | { ok: false; holder: LockBody | null; stale: boolean } => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const body: LockBody = { holder: processIdentity(process.pid), host: hostname(), at: new Date().toISOString(), purpose }
  try {
    const fd = openSync(file, 'wx', 0o600)
    try { writeSync(fd, JSON.stringify(body)); fsyncSync(fd) } finally { closeSync(fd) }
    return { ok: true }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    let holder: LockBody | null = null
    try { holder = readJson<LockBody>(file) } catch { /* torn or unreadable */ }
    const stale = holder !== null && holder.host === hostname() && !sameProcess(holder.holder)
    return { ok: false, holder, stale }
  }
}
export const unlock = (file: string): void => {
  try { const b = readJson<LockBody>(file); if (b.holder.pid === process.pid) unlinkSync(file) } catch { /* not ours or gone */ }
}
/** Takes a lock whose holder is verified gone. Returns false if the holder still runs. */
export const breakStaleLock = (file: string): boolean => {
  const r = tryLock(file, 'probe')
  if (r.ok) { unlinkSync(file); return true }
  if (!r.stale) return false
  unlinkSync(file); return true
}
/** Runs fn under a short critical-section lock, retrying while another live holder has it. */
export const withLock = async <T>(file: string, purpose: string, fn: () => T | Promise<T>, timeoutMs = 10_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  for (;;) {
    const r = tryLock(file, purpose)
    if (r.ok) { try { return await fn() } finally { unlock(file) } }
    if (r.stale) { breakStaleLock(file); continue }
    if (Date.now() > until) throw new Error(`lock ${file} held by ${r.holder ? `pid ${r.holder.holder.pid} (${r.holder.purpose})` : 'an unreadable holder'}`)
    await new Promise(res => setTimeout(res, 25))
  }
}

/** Redacts credential-like text in every string value; structure is never re-parsed. */
export const redactDeep = (v: unknown, depth = 0): unknown => {
  if (typeof v === 'string') return redactSecrets(v)
  if (depth > 12 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(x => redactDeep(x, depth + 1))
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactDeep(x, depth + 1)]))
}

// ---------------------------------------------------------------------------
// Hash-chained, segmented ledger.
export type LedgerEntry = { seq: number; at: string; kind: string; task: string | null; data: unknown; prev: string; hash: string }
const SEGMENT_BYTES = 1 << 20

export class Ledger {
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }) }
  private head(): { seg: number; seq: number; hash: string } {
    try { return readJson(join(this.dir, 'head.json')) } catch { return { seg: 1, seq: 0, hash: 'genesis' } }
  }
  append(kind: string, task: string | null, data: unknown): LedgerEntry {
    const h = this.head()
    const body = { seq: h.seq + 1, at: new Date().toISOString(), kind, task, data: redactDeep(data ?? null), prev: h.hash }
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const entry: LedgerEntry = { ...body, hash }
    let seg = h.seg
    const file = (n: number) => join(this.dir, `seg-${String(n).padStart(6, '0')}.jsonl`)
    try { if (statSync(file(seg)).size > SEGMENT_BYTES) seg += 1 } catch { /* new segment */ }
    appendFileSync(file(seg), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    writeAtomic(join(this.dir, 'head.json'), JSON.stringify({ seg, seq: entry.seq, hash }))
    return entry
  }
  /** Streams every entry in order and checks the chain. */
  verify(): { ok: boolean; entries: number; problem: string | null; last: LedgerEntry | null } {
    let prev = 'genesis'; let n = 0; let last: LedgerEntry | null = null
    const segs = existsSync(this.dir) ? readdirSync(this.dir).filter(f => /^seg-\d+\.jsonl$/.test(f)).sort() : []
    for (const s of segs) for (const line of readFileSync(join(this.dir, s), 'utf8').split('\n')) {
      if (!line) continue
      let e: LedgerEntry
      try { e = JSON.parse(line) as LedgerEntry } catch { return { ok: false, entries: n, problem: `${s}: unparsable line after seq ${last?.seq ?? 0}`, last } }
      const { hash, ...body } = e
      if (e.prev !== prev) return { ok: false, entries: n, problem: `seq ${e.seq}: chain broken (prev ${e.prev.slice(0, 12)} != ${prev.slice(0, 12)})`, last }
      if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== hash) return { ok: false, entries: n, problem: `seq ${e.seq}: entry altered`, last }
      prev = hash; n++; last = e
    }
    const h = this.head()
    if (h.hash !== prev) return { ok: false, entries: n, problem: `head ${h.hash.slice(0, 12)} does not match last entry ${prev.slice(0, 12)} (truncated or rewritten)`, last }
    return { ok: true, entries: n, problem: null, last }
  }
  *entries(): Generator<LedgerEntry> {
    const segs = existsSync(this.dir) ? readdirSync(this.dir).filter(f => /^seg-\d+\.jsonl$/.test(f)).sort() : []
    for (const s of segs) for (const line of readFileSync(join(this.dir, s), 'utf8').split('\n')) if (line) yield JSON.parse(line) as LedgerEntry
  }
}

// ---------------------------------------------------------------------------
// Paginated archive of finished task records.
export type ArchiveIndex = { pages: { n: number; count: number }[]; total: number; bytes: number }

export class Archive {
  constructor(readonly dir: string, readonly pageSize: number) { mkdirSync(join(dir, 'ids'), { recursive: true, mode: 0o700 }) }
  index(): ArchiveIndex { try { return readJson(join(this.dir, 'index.json')) } catch { return { pages: [], total: 0, bytes: 0 } } }
  private shard(id: string): string { return join(this.dir, 'ids', `${createHash('sha256').update(id).digest('hex').slice(0, 2)}.json`) }
  put(id: string, record: { state: string }): void {
    const idx = this.index()
    let page = idx.pages.at(-1)
    if (!page || page.count >= this.pageSize) { page = { n: (page?.n ?? 0) + 1, count: 0 }; idx.pages.push(page) }
    const line = `${JSON.stringify({ id, ...record })}\n`
    appendFileSync(join(this.dir, `page-${String(page.n).padStart(6, '0')}.jsonl`), line, { mode: 0o600 })
    page.count += 1; idx.total += 1; idx.bytes += Buffer.byteLength(line)
    const shardFile = this.shard(id)
    let shard: Record<string, { page: number; state: string }> = {}
    try { shard = readJson(shardFile) } catch { /* new shard */ }
    shard[id] = { page: page.n, state: record.state }
    writeAtomic(shardFile, JSON.stringify(shard))
    writeAtomic(join(this.dir, 'index.json'), JSON.stringify(idx))
  }
  /** One shard read: the finished state of an archived task, or null. */
  stateOf(id: string): string | null { try { return readJson<Record<string, { state: string }>>(this.shard(id))[id]?.state ?? null } catch { return null } }
  /** One page of records, newest page last. */
  page(n: number): unknown[] {
    try { return readFileSync(join(this.dir, `page-${String(n).padStart(6, '0')}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
  }
  get(id: string): unknown | null {
    let shard: Record<string, { page: number }> = {}
    try { shard = readJson(this.shard(id)) } catch { return null }
    const at = shard[id]; if (!at) return null
    return (this.page(at.page) as { id: string }[]).filter(r => r.id === id).at(-1) ?? null
  }
}

// ---------------------------------------------------------------------------
// Repo-scoped claims and mission markers, kept in the repository's git common dir
// so that they survive a deleted or relocated state directory (C3) and are shared
// by every supervisor process and every mission on that repository (C1, C2).
export type Claim = { missionId: string; taskId: string; attempt: number; owned: string[]; mode: 'read' | 'write'; state: 'reserved' | 'bound' | 'uncertain'; identity: unknown; supervisor: ProcessIdentity; stateDir: string; at: string }

export const repoDir = (gitCommonDir: string): string => join(gitCommonDir, 'cobalt-cockpit-cline')
const claimFile = (gitCommonDir: string, missionId: string, taskId: string): string => join(repoDir(gitCommonDir), 'claims', `${missionId}__${taskId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)

export const listClaims = (gitCommonDir: string): { claims: Claim[]; unreadable: string[] } => {
  const dir = join(repoDir(gitCommonDir), 'claims')
  const claims: Claim[] = []; const unreadable: string[] = []
  let names: string[] = []
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(dir) }
  for (const n of names) { try { claims.push(readJson<Claim>(join(dir, n))) } catch { unreadable.push(n) } }
  return { claims, unreadable }
}
export const writeClaim = (gitCommonDir: string, c: Claim): void => writeAtomic(claimFile(gitCommonDir, c.missionId, c.taskId), JSON.stringify(c))
export const retireClaim = (gitCommonDir: string, missionId: string, taskId: string): void => { try { unlinkSync(claimFile(gitCommonDir, missionId, taskId)) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e } }
export const claimsLock = (gitCommonDir: string): string => join(repoDir(gitCommonDir), 'claims.lock')

export type Marker = { missionId: string; stateDir: string; epoch: string; createdAt: string }
export const writeMarker = (gitCommonDir: string, m: Marker): void => writeAtomic(join(repoDir(gitCommonDir), 'missions', `${m.missionId}.json`), JSON.stringify(m))
export const listMarkers = (gitCommonDir: string): Marker[] => {
  const dir = join(repoDir(gitCommonDir), 'missions')
  try { return readdirSync(dir).filter(n => n.endsWith('.json')).map(n => readJson<Marker>(join(dir, n))) } catch { return [] }
}
export const retireMarker = (gitCommonDir: string, missionId: string): void => { try { unlinkSync(join(repoDir(gitCommonDir), 'missions', `${missionId}.json`)) } catch { /* gone */ } }

/** Markers whose state directory or epoch no longer matches: the store was deleted, moved or replaced. */
export const lostMissions = (gitCommonDir: string): { marker: Marker; why: string }[] => {
  const out: { marker: Marker; why: string }[] = []
  for (const m of listMarkers(gitCommonDir)) {
    const header = join(m.stateDir, 'mission.json')
    if (!existsSync(header)) { out.push({ marker: m, why: `state directory ${m.stateDir} is missing` }); continue }
    try { const h = readJson<{ epoch: string }>(header); if (h.epoch !== m.epoch) out.push({ marker: m, why: 'state epoch differs from the repository marker (store replaced)' }) } catch { out.push({ marker: m, why: 'mission header unreadable' }) }
    if (!existsSync(join(m.stateDir, 'live.json'))) out.push({ marker: m, why: 'live state file is missing' })
  }
  return out
}

export const storeBytes = (dir: string): number => {
  let total = 0
  const walk = (d: string): void => { let names: string[] = []; try { names = readdirSync(d) } catch { return } for (const n of names) { const p = join(d, n); try { const s = statSync(p); if (s.isDirectory()) walk(p); else total += s.size } catch { /* raced */ } } }
  walk(dir); return total
}

export const newId = (prefix: string): string => `${prefix}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`
export const epochToken = (): string => randomBytes(12).toString('hex')
export { writeFileSync }
