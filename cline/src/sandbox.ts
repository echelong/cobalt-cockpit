// OS enforcement for workers and gates: bubblewrap, default-deny. The hook is a second layer; this is the boundary.
//   - no host root: an empty root (remounted read-only) with only an allowlist mounted into it:
//     /usr and /etc read-only, the node runtime that runs Cline read-only, the task's worktree, the
//     attempt's own directories and paths the owner approved (read-only). Everything else on the
//     host (other repositories, the home directory, .env files, keys, the real ~/.cline) is absent.
//   - a disposable HOME (and XDG directories under it) per run; the environment is cleared and rebuilt
//   - user, pid, ipc, uts, cgroup and network namespaces; nested user namespaces are disabled, so a
//     worker cannot gain capabilities to mount or unshare anything; no_new_privs blocks setuid gain
//   - network: none (gates), provider (workers: loopback only, plus the host broker's socket), or
//     host (an explicit, unsafe opt-in). When the sandbox ends, the kernel kills every process in it.
//   - the repository's git common dir is read-only (its Cockpit claim store hidden)
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pidNamespaceOf, processIdentity, startTimeOf } from './proc.ts'
import type { ProcessIdentity } from './proc.ts'

export type NetworkMode = 'none' | 'provider' | 'host'
export type SandboxSpec = {
  workdir: string; writable: boolean
  gitCommonDir: string | null; gitAdminDir: string | null
  /** The run's disposable home directory (writable); HOME and the XDG directories point into it. */
  home: string
  readOnly: string[]; readWrite: string[]
  /** Extra read-only paths the owner approved (toolchains, dependency caches); nothing else of the host is visible. */
  allowRead: string[]
  /** Paths hidden even inside mounted trees (a second layer; the allowlist is the boundary). */
  hide: string[]
  network: NetworkMode
  /** provider mode: the directory holding the broker's unix socket, mounted read-only. */
  brokerDir?: string | null
  marker: string; env: Record<string, string>
  /** Extra read-only binds placed after the workdir (e.g. the main checkout's node_modules for gates). */
  binds?: { from: string; to: string }[]
  /** A stripped copy of the repository's git config (no remotes, credentials, hooks or commands) shown in place of the real one. */
  gitConfig?: string | null
}

/** Home-relative places that hold credentials or private state: never mounted, and never an ancestor of a mount. */
export const SECRET_HOME_PATHS: readonly string[] = ['.cline', '.ssh', '.gnupg', '.aws', '.azure', '.config', '.local/share', '.local/state', '.cache', '.claude', '.claude-main', '.netrc', '.git-credentials', '.gitconfig', '.docker', '.kube', '.password-store', '.npmrc', '.npm', '.yarnrc', '.pypirc', '.mozilla', '.pki', '.terraform.d', '.vault-token', '.oci', '.s3cfg', '.boto', '.m2', '.gradle', '.gem', '.cargo/credentials', '.cargo/credentials.toml', '.var', '.Xauthority', '.bash_history', '.zsh_history', '.python_history', '.psql_history', '.mysql_history', '.bashrc', '.zshrc', '.profile', '.bash_profile']
/** System trees that are never mounted from the host (each sandbox gets its own /proc, /dev and empty /run). */
const SYSTEM_TREES: readonly string[] = ['/proc', '/sys', '/dev', '/run', '/var/run', '/boot', '/root']
const real = (p: string): string => { try { return realpathSync(p) } catch { return p } }
const accountHome = (): string => { try { return userInfo().homedir } catch { return homedir() } }
/**
 * Why mounting `raw` (read-only) would undo the boundary, or null. Judged on the real path (symlinks resolved,
 * `.`, `..` and `//` normalised): the root, a home directory as a whole or an ancestor of it, and anything that
 * is, contains or lies inside a credential store are refused.
 */
export const mountProblem = (raw: string): string | null => {
  if (typeof raw !== 'string' || !raw.trim()) return 'a path is required'
  const ex = expandHome(raw.trim())
  if (!ex.startsWith('/')) return 'an absolute path (or ~/...) is required'
  const p = real(resolve(ex))
  for (const t of SYSTEM_TREES) { const r = real(t); if (p === t || p.startsWith(`${t}/`) || p === r || p.startsWith(`${r}/`)) return `${t} is never mounted from the host` }
  // $HOME and the account's home directory (they can differ): both, and everything sensitive in them
  const homes = [...new Set([real(homedir()), real(accountHome())])]
  for (const home of homes) {
    if (p === '/' || p === '/home' || /^\/home\/[^/]+$/.test(p) || p === home || home.startsWith(`${p}/`)) return 'the root or a whole home directory would expose everything in it'
    for (const rel of SECRET_HOME_PATHS) {
      const s = real(join(home, rel))
      if (p === s || p.startsWith(`${s}/`) || s.startsWith(`${p}/`)) return `it overlaps ${s.replace(home, '~')}, which holds credentials or private state`
    }
  }
  return null
}
const mustMount = (p: string, what: string): void => { const why = mountProblem(p); if (why) throw new Error(`sandbox: refusing to mount ${what} ${p}: ${why}`) }

/** The repository's git config reduced to what reading a worktree needs ([core] format keys and [extensions]); remotes, credentials, hooks and commands are left out. */
const SAFE_CORE = new Set(['repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'ignorecase', 'precomposeunicode', 'symlinks', 'autocrlf', 'eol', 'safecrlf', 'quotepath', 'checkstat', 'trustctime', 'splitindex', 'sparsecheckout', 'commitgraph', 'multipackindex', 'compression', 'loosecompression', 'abbrev', 'longpaths'])
export const strippedGitConfig = (text: string): string => {
  const out: string[] = []; let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const h = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/.exec(line)
    if (h) { section = h[1].toLowerCase(); if ((section === 'core' || section === 'extensions') && !/"/.test(line)) out.push(`[${section}]`); else section = `skip:${section}`; continue }
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    if (section === 'extensions' || (section === 'core' && SAFE_CORE.has(key))) out.push(`\t${key} = ${(kv[2] ?? 'true').replace(/[\r\n]/g, '')}`)
  }
  return `${out.join('\n')}\n`
}

/**
 * Files inside a git directory that are covered with an empty file: per-worktree configs, submodule configs
 * (remote URLs can embed tokens) and fsmonitor daemon sockets (a path socket is reachable whatever the network
 * namespace), in the common dir, its linked worktrees and its submodules (three levels deep).
 */
export const gitCovers = (commonDir: string): string[] => {
  const out: string[] = []
  const at = (dir: string, depth: number): void => {
    for (const f of ['config.worktree', 'fsmonitor--daemon.ipc']) if (existsSync(join(dir, f))) out.push(join(dir, f))
    if (depth > 0 && existsSync(join(dir, 'config'))) out.push(join(dir, 'config'))
    for (const sub of ['worktrees', 'modules']) {
      let names: string[] = []
      try { names = readdirSync(join(dir, sub)) } catch { continue }
      for (const n of names.slice(0, 256)) if (depth < 3) at(join(dir, sub, n), depth + 1)
    }
  }
  at(commonDir, 0)
  return out
}

/** The /etc files ordinary tools read (users, name service, dynamic linker, certificates, time zone, alternatives); not /etc as a whole. */
export const ETC_ALLOW: readonly string[] = ['passwd', 'group', 'nsswitch.conf', 'host.conf', 'hosts', 'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'ssl/certs', 'ssl/openssl.cnf', 'ssl/cert.pem', 'pki/tls/certs', 'pki/tls/openssl.cnf', 'pki/tls/cert.pem', 'pki/ca-trust', 'ca-certificates', 'crypto-policies', 'localtime', 'alternatives', 'os-release', 'protocols', 'services', 'mime.types', 'terminfo', 'inputrc', 'locale.conf', 'shells']
export const expandHome = (p: string): string => p === '~' ? homedir() : p.startsWith('~/') ? `${homedir()}/${p.slice(2)}` : p
export const MARKER_VAR = 'COCKPIT_CLINE_ATTEMPT'

/**
 * Reads a file a sandboxed process could have written (captures, hook log) without following a
 * symlink it may have planted there: only a regular file is read, up to `max` bytes. The host never
 * becomes a deputy that reads its own secrets through a worker's link.
 */
export const readUntrusted = (path: string, max = 64 << 20): string => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error(`${path}: not a regular file`)
    const n = Math.min(st.size, max); const buf = new Uint8Array(n); let off = 0
    while (off < n) { const r = readSync(fd, buf, off, n - off, off); if (r <= 0) break; off += r }
    return Buffer.from(buf.buffer, 0, off).toString('utf8')
  } finally { closeSync(fd) }
}
/** A directory a sandboxed process could have replaced: true only when it is still a real directory (not a symlink). */
export const realDir = (path: string): boolean => { try { const st = lstatSync(path); return st.isDirectory() && !st.isSymbolicLink() } catch { return false } }

/** The node installation that runs Cline and the hook (its prefix holds `cline` and global packages), when outside /usr. */
export const runtimeRoots = (): string[] => {
  const prefix = dirname(dirname(realpathSync(process.execPath)))
  return prefix === '/usr' || prefix.startsWith('/usr/') ? [] : [prefix]
}
/** The Cockpit code a worker's hook runs (read-only): the adapter's sources and loader, and the engine it imports. */
export const cockpitRoots = (packageDir: string): string[] => [join(packageDir, 'src'), join(packageDir, 'loader'), join(packageDir, '..', 'hooks'), join(packageDir, '..', 'types')]

/** The operating system, read-only; /bin, /lib... follow the host's layout (symlinks into /usr on merged-/usr systems). */
const osMounts = (): string[] => {
  const a = ['--ro-bind', '/usr', '/usr']
  for (const p of ['/bin', '/sbin', '/lib', '/lib64']) {
    try { const st = lstatSync(p); if (st.isSymbolicLink()) a.push('--symlink', readlinkSync(p), p); else if (st.isDirectory()) a.push('--ro-bind', p, p) } catch { /* absent */ }
  }
  a.push('--dir', '/etc')
  for (const f of ETC_ALLOW) a.push('--ro-bind-try', `/etc/${f}`, `/etc/${f}`)
  a.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp', '--tmpfs', '/run')
  return a
}
const under = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`)
const ENV_KEEP = /^(?:USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z]+|TERM|COLORTERM|TZ)$/
/** The environment a sandboxed process starts with: cleared, then only these. Nothing of the host's secrets or paths. */
export const sandboxEnv = (s: SandboxSpec, host: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(host)) if (v !== undefined && ENV_KEEP.test(k)) out[k] = v
  const bins = [...runtimeRoots().map(r => join(r, 'bin')), ...s.allowRead.map(expandHome).filter(p => /\/bin$/.test(p)), '/usr/local/bin', '/usr/bin', '/bin']
  Object.assign(out, {
    HOME: s.home, XDG_CONFIG_HOME: join(s.home, '.config'), XDG_CACHE_HOME: join(s.home, '.cache'), XDG_DATA_HOME: join(s.home, '.local', 'share'), XDG_STATE_HOME: join(s.home, '.local', 'state'),
    TMPDIR: '/tmp', PATH: [...new Set(bins)].join(':'), [MARKER_VAR]: s.marker,
  }, s.env)
  return out
}

export const bwrapArgs = (s: SandboxSpec): string[] => {
  const a = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--disable-userns', '--assert-userns-disabled']
  if (s.network !== 'host') a.push('--unshare-net')
  a.push(...osMounts())
  const sources: string[] = ['/usr', '/etc']
  const ro = (p: string): void => { if (existsSync(p)) { a.push('--ro-bind', p, p); sources.push(p) } }
  // every host path mounted below is checked on its real path first; a refusal stops the launch (fail closed)
  for (const p of runtimeRoots()) {
    mustMount(p, 'the node runtime'); ro(p)
    // a global npmrc can hold a registry token
    if (existsSync(join(p, 'etc', 'npmrc'))) a.push('--ro-bind', '/dev/null', join(p, 'etc', 'npmrc'))
  }
  for (const p of s.allowRead) { mustMount(p, 'approved path'); ro(real(resolve(expandHome(p)))) }
  if (s.gitCommonDir) {
    mustMount(s.gitCommonDir, 'the git directory'); ro(s.gitCommonDir)
    // other missions' claims and markers are not the worker's business
    if (existsSync(join(s.gitCommonDir, 'cobalt-cockpit-cline'))) a.push('--tmpfs', join(s.gitCommonDir, 'cobalt-cockpit-cline'))
    // remotes (a URL can embed a token), credential helpers, hooks and commands are not shown: a stripped config is
    if (existsSync(join(s.gitCommonDir, 'config'))) { if (!s.gitConfig) throw new Error('sandbox: the git directory needs a stripped config copy'); a.push('--ro-bind', s.gitConfig, join(s.gitCommonDir, 'config')) }
    for (const f of gitCovers(s.gitCommonDir)) a.push('--ro-bind', '/dev/null', f)
  }
  for (const p of s.readOnly) ro(p)
  a.push(s.writable ? '--bind' : '--ro-bind', s.workdir, s.workdir); sources.push(s.workdir)
  // The worktree's .git link stays read-only (and, being a mount point, cannot be replaced),
  // and its admin dir stays inside the read-only git common dir: host git later trusts both.
  if (s.writable && existsSync(`${s.workdir}/.git`)) a.push('--ro-bind', `${s.workdir}/.git`, `${s.workdir}/.git`)
  for (const b of s.binds ?? []) if (existsSync(b.from)) { mustMount(b.from, 'shared dependency directory'); a.push('--ro-bind', b.from, b.to); sources.push(b.from) }
  for (const p of s.readWrite) { a.push('--bind', p, p); sources.push(p) }
  a.push('--bind', s.home, s.home)
  if (s.network === 'provider') { if (!s.brokerDir) throw new Error('sandbox: provider network needs the broker socket directory'); a.push('--ro-bind', s.brokerDir, s.brokerDir) }
  // a second layer inside what is mounted: configured secret paths are covered over
  for (const raw of [...new Set(s.hide)]) {
    const p = expandHome(raw)
    if (!existsSync(p) || !sources.some(src => under(p, src))) continue
    if (statSync(p).isDirectory()) a.push('--tmpfs', p); else a.push('--ro-bind', '/dev/null', p)
  }
  // the root itself (only directories bwrap made for the mounts above) becomes read-only
  a.push('--remount-ro', '/', '--clearenv')
  for (const [k, v] of Object.entries(sandboxEnv(s))) a.push('--setenv', k, v)
  a.push('--chdir', s.workdir, '--info-fd', '3')
  return a
}

export type Identity = { supervisor: ProcessIdentity; outer: ProcessIdentity; initPid: number | null; initStart: string | null; pidNs: string | null; marker: string; startedAt: string; since: number }

export type Launched = { child: ChildProcess; identity: Promise<Identity> }

/** Starts `argv` inside the sandbox. The identity resolves once bwrap reports its init pid. */
export const launch = (s: SandboxSpec, argv: string[], bwrap = process.env.COCKPIT_CLINE_BWRAP ?? 'bwrap'): Launched => {
  const child = spawn(bwrap, [...bwrapArgs(s), '--', ...argv], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    // bwrap itself needs only PATH; the sandboxed process gets the cleared environment built above
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', [MARKER_VAR]: s.marker },
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

/** Whether the full isolation this module asks for can be established here (doctor, readiness). */
export const bwrapAvailable = (bwrap = process.env.COCKPIT_CLINE_BWRAP ?? 'bwrap'): Promise<{ ok: boolean; detail: string }> => new Promise(resolve => {
  const c = spawn(bwrap, ['--unshare-user', '--unshare-pid', '--unshare-net', '--disable-userns', '--assert-userns-disabled', ...osMounts(), '--remount-ro', '/', '--', '/usr/bin/true'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  c.stderr?.on('data', d => { err += d })
  c.on('error', e => resolve({ ok: false, detail: e.message }))
  c.on('exit', code => resolve(code === 0 ? { ok: true, detail: 'bubblewrap: allowlisted root, user/pid/net namespaces, nested user namespaces disabled' } : { ok: false, detail: `bwrap exit ${code}: ${err.trim().slice(0, 200)}` }))
})
