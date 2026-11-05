// OS enforcement for workers: bubblewrap. The hook is a second layer; this is the boundary.
//   - read-only root, private /tmp, own /dev and /proc
//   - pid, ipc and uts namespaces: when the sandbox ends, the kernel kills every process
//     in it, detached or not; --die-with-parent ends it when the supervisor dies
//   - only the task's worktree (or nothing, for read-only work), the attempt's own output
//     directory and Cline's data directory are writable
//   - the repository's git common dir is read-only except the worktree's own admin dir
//   - configured secret directories are hidden behind empty tmpfs mounts
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { pidNamespaceOf, processIdentity, startTimeOf } from './proc.ts'
import type { ProcessIdentity } from './proc.ts'

export type SandboxSpec = {
  workdir: string; writable: boolean
  gitCommonDir: string | null; gitAdminDir: string | null
  readOnly: string[]; readWrite: string[]; hide: string[]
  network: boolean; marker: string; env: Record<string, string>
  /** Extra read-only binds placed after the workdir (e.g. the main checkout's node_modules for gates). */
  binds?: { from: string; to: string }[]
}
export const expandHome = (p: string): string => p === '~' ? homedir() : p.startsWith('~/') ? `${homedir()}/${p.slice(2)}` : p
export const MARKER_VAR = 'COCKPIT_CLINE_ATTEMPT'

export const bwrapArgs = (s: SandboxSpec): string[] => {
  const a = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try']
  if (!s.network) a.push('--unshare-net')
  a.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp')
  for (const raw of s.hide) {
    const p = expandHome(raw)
    if (!existsSync(p)) continue
    if (statSync(p).isDirectory()) a.push('--tmpfs', p); else a.push('--ro-bind', '/dev/null', p)
  }
  if (s.gitCommonDir) a.push('--ro-bind', s.gitCommonDir, s.gitCommonDir)
  for (const p of s.readOnly) a.push('--ro-bind', p, p)
  a.push(s.writable ? '--bind' : '--ro-bind', s.workdir, s.workdir)
  if (s.writable && s.gitAdminDir) a.push('--bind', s.gitAdminDir, s.gitAdminDir)
  for (const b of s.binds ?? []) if (existsSync(b.from)) a.push('--ro-bind', b.from, b.to)
  for (const p of s.readWrite) a.push('--bind', p, p)
  a.push('--setenv', MARKER_VAR, s.marker)
  for (const [k, v] of Object.entries(s.env)) a.push('--setenv', k, v)
  a.push('--chdir', s.workdir, '--info-fd', '3')
  return a
}

export type Identity = { supervisor: ProcessIdentity; outer: ProcessIdentity; initPid: number | null; initStart: string | null; pidNs: string | null; marker: string; startedAt: string; since: number }

export type Launched = { child: ChildProcess; identity: Promise<Identity> }

/** Starts `argv` inside the sandbox. The identity resolves once bwrap reports its init pid. */
export const launch = (s: SandboxSpec, argv: string[], bwrap = process.env.COCKPIT_CLINE_BWRAP ?? 'bwrap'): Launched => {
  const child = spawn(bwrap, [...bwrapArgs(s), '--', ...argv], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, [MARKER_VAR]: s.marker },
    detached: false,
  })
  const supervisor = processIdentity(process.pid)
  const since = Date.now()
  const identity = new Promise<Identity>(resolve => {
    let buf = ''
    const info = child.stdio[3]
    const done = (): void => {
      let initPid: number | null = null
      try { const j = JSON.parse(buf) as { 'child-pid'?: number }; initPid = typeof j['child-pid'] === 'number' ? j['child-pid'] : null } catch { /* bwrap exited before reporting */ }
      resolve({ supervisor, outer: processIdentity(child.pid ?? -1), initPid, initStart: initPid !== null ? startTimeOf(initPid) : null, pidNs: initPid !== null ? pidNamespaceOf(initPid) : null, marker: `${MARKER_VAR}=${s.marker}`, startedAt: new Date(since).toISOString(), since })
    }
    if (!info) { done(); return }
    info.on('data', (d: Buffer) => { buf += d.toString(); if (buf.trim().endsWith('}')) { info.removeAllListeners('data'); done() } })
    info.on('end', () => { if (buf === '' || !buf.trim().endsWith('}')) done() })
    info.on('error', () => done())
  })
  return { child, identity }
}

export const bwrapAvailable = (bwrap = process.env.COCKPIT_CLINE_BWRAP ?? 'bwrap'): Promise<{ ok: boolean; detail: string }> => new Promise(resolve => {
  const c = spawn(bwrap, ['--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', 'true'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  c.stderr?.on('data', d => { err += d })
  c.on('error', e => resolve({ ok: false, detail: e.message }))
  c.on('exit', code => resolve(code === 0 ? { ok: true, detail: 'bubblewrap with unprivileged pid namespaces works' } : { ok: false, detail: `bwrap exit ${code}: ${err.trim().slice(0, 200)}` }))
})
