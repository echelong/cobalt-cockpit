// Process identity and liveness from /proc (Linux). A pid alone is not an identity:
// it is paired with the kernel start time and the boot id, so a reused pid never
// matches. Liveness questions that cannot be answered return 'unknown', and callers
// keep ownership on 'unknown'.
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'

export type ProcessIdentity = { pid: number; start: string | null; boot: string | null }

const bootId = (): string | null => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { return null } }
/** Field 22 of /proc/<pid>/stat, read after the parenthesised comm (which may hold spaces). */
export const startTimeOf = (pid: number): string | null => {
  try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null } catch { return null }
}
export const processIdentity = (pid: number): ProcessIdentity => ({ pid, start: startTimeOf(pid), boot: bootId() })
export const sameProcess = (id: ProcessIdentity): boolean => id.start !== null && id.boot === bootId() && startTimeOf(id.pid) === id.start

export const pidNamespaceOf = (pid: number): string | null => { try { return readlinkSync(`/proc/${pid}/ns/pid`) } catch { return null } }

/** A zombie has exited: it runs nothing and holds no effects, only its exit status. */
const isZombie = (pid: number): boolean => {
  try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); const st = s.slice(s.lastIndexOf(')') + 2, s.lastIndexOf(')') + 3); return st === 'Z' || st === 'X' } catch { return false }
}

export type Census = { state: 'gone' | 'alive' | 'unknown'; pids: number[]; detail: string }
export type Target = { initPid: number | null; initStart: string | null; pidNs: string | null; marker: string | null; since: number }

/** Jiffies-since-boot start time to epoch ms, for comparing with `since`. */
const startedAtMs = (start: string): number | null => {
  try {
    const up = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0])
    const hz = 100 // USER_HZ; Linux reports start time in clock ticks of 100 Hz on every mainstream build
    return Date.now() - (up - Number(start) / hz) * 1000
  } catch { return null }
}

/**
 * Whether anything of an attempt still runs.
 * 1. The sandbox init: a pid namespace's init is not reaped until every process in the
 *    namespace has exited (kernel zap_pid_ns_processes), so "init gone" proves the
 *    namespace is empty, detached children included.
 * 2. The marker: any readable process of this user, inside or outside the namespace,
 *    whose environment carries the attempt marker (catches escapes such as a process
 *    started through a service manager).
 * 3. Without a known init, a process of this user that cannot be inspected and started
 *    after the attempt began makes the answer 'unknown', never 'gone'.
 */
export const census = (t: Target): Census => {
  const uid = process.getuid?.() ?? -1
  if (t.initPid !== null && t.initStart !== null && startTimeOf(t.initPid) === t.initStart && !isZombie(t.initPid)) return { state: 'alive', pids: [t.initPid], detail: 'sandbox init still running' }
  let names: string[]
  try { names = readdirSync('/proc') } catch { return { state: 'unknown', pids: [], detail: '/proc unreadable' } }
  const found: number[] = []; let unknown = 0
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    const pid = Number(n); if (pid === process.pid) continue
    let owner = -1
    try { owner = statSync(`/proc/${n}`).uid } catch { continue }
    if (owner !== uid || isZombie(pid)) continue
    let hit = false; let read = false
    if (t.pidNs) { const ns = pidNamespaceOf(pid); if (ns !== null) { read = true; if (ns === t.pidNs) hit = true } }
    if (!hit && t.marker) { try { const env = readFileSync(`/proc/${n}/environ`, 'latin1'); read = true; if (env.split('\0').includes(t.marker)) hit = true } catch { /* not inspectable */ } }
    if (hit) { found.push(pid); continue }
    if (!read && t.initStart === null) { const st = startTimeOf(pid); const at = st === null ? null : startedAtMs(st); if (at === null || at >= t.since - 2000) unknown++ }
  }
  if (found.length) return { state: 'alive', pids: found, detail: `${found.length} process(es) of this attempt still running` }
  if (unknown) return { state: 'unknown', pids: [], detail: `sandbox init unknown and ${unknown} uninspectable process(es) started during the attempt` }
  return { state: 'gone', pids: [], detail: t.initStart !== null ? 'sandbox init reaped (namespace empty) and no marked process remains' : 'no marked or namespaced process remains' }
}

export const killAll = (pids: readonly number[]): void => { for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch { /* already gone */ } } }

/** Kills until the census is empty or time runs out; never claims 'gone' without a clean census. */
export const terminate = async (t: Target, kill = true, timeoutMs = 5000): Promise<Census> => {
  if (kill && t.initPid !== null && t.initStart !== null && startTimeOf(t.initPid) === t.initStart) { try { process.kill(t.initPid, 'SIGKILL') } catch { /* gone */ } }
  const until = Date.now() + timeoutMs
  for (;;) {
    const c = census(t)
    if (c.state === 'gone') return c
    if (c.state === 'alive' && kill) killAll(c.pids)
    if (Date.now() > until) return c
    await new Promise(r => setTimeout(r, 50))
  }
}
