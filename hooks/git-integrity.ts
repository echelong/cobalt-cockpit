// Authoritative tracked-content evidence comes from the commit tree and the disk, never the index's stat cache.

// v0.6.6: submodules are never examined (a submodule's own configuration can run a program during a superproject's status or
// diff), and no command recurses into one; a repository that records a gitlink is refused before any such command (repoState).
export const GIT_SAFE = ['--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'submodule.recurse=false', '-c', 'status.submoduleSummary=false', '-c', 'core.checkStat=default', '-c', 'core.trustctime=true', '-c', 'log.showSignature=false', '-c', 'format.pretty=medium']
export const TRACKED_LIMIT = 100_000
export type CommitEntry = { path: string; oid: string; mode: '100644' | '100755' | '120000' | '160000' }
export type DiskEntry = CommitEntry & { raw: string; isSameType: boolean; diskMode?: string }
export type Measurement = { entries: DiskEntry[] } | { why: string }

export const commitEntries = (text: string): CommitEntry[] | null => {
  if (text !== '' && !text.endsWith('\0')) return null
  const out: CommitEntry[] = [], seen = new Set<string>()
  for (const record of text.split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(record)
    if (!match) return null
    const [, mode, kind, oid, path] = match
    if (!path || path.startsWith('/') || path.split('/').some(p => p === '' || p === '.' || p === '..') || seen.has(path) || (mode === '160000') !== (kind === 'commit')) return null
    seen.add(path)
    out.push({ path, oid: oid!, mode: mode as CommitEntry['mode'] })
    if (out.length > TRACKED_LIMIT) return null
  }
  return out
}

// --- Bounded measurement (v0.6.4) ---
// A repository decides what Git and the inspection tools read: a link to /dev/zero among the untracked files, an
// excludes, attributes, order or alternates file pointed at a device, a FIFO where Git expects a file. Read whole,
// those exhausted memory within seconds or blocked until the host's timeout (measured). The host bounds a process's
// time, not its memory, so every measurement process starts through a constant script that sets kernel limits and
// then replaces itself with the real command. The command's own words are passed as separate arguments, never
// interpolated into the script.

/** Address space of one measurement process, in KiB (1 GiB). Measured: every fingerprint command fits in 384 MiB with GIT_BOUNDED. */
export const BOUND_AS_KIB = 1_048_576
/** CPU seconds of one measurement process; the host's timeout normally ends it long before. */
export const BOUND_CPU_S = 20
/** The script's $0, which also tells a reader (and the test host) that the command after it is bounded. */
export const BOUND_TAG = 'cockpit-bounded'
/**
 * Most a measurement process may write to one regular file, in 512-byte blocks (64 MiB; a shell that counts 1024-byte blocks
 * allows 128 MiB). Not 0: where a host captures output through a file, 0 would end every measurement on its first write
 * (measured). Git's own measurement commands write nothing.
 */
export const BOUND_FILE_BLOCKS = 131_072
/**
 * Lowers a limit to a value, and never raises one: a host or container whose limit is already stricter keeps it (raising a hard
 * limit is refused, which made every `ulimit` fail under a stricter outer limit; measured).
 */
const LOWER = 'lower() { c=$(ulimit "$1") || return 1; if [ "$c" = unlimited ] || [ "$c" -gt "$2" ]; then ulimit "$1" "$2"; fi; }'
const LIMITS = (memory: boolean): string => `${LOWER} && ${memory ? `lower -v ${BOUND_AS_KIB} && ` : ''}lower -t ${BOUND_CPU_S} && lower -f ${BOUND_FILE_BLOCKS} && lower -c 0`
/**
 * CPU, file size and no core dump; with `memory`, the address space too. Then the command, by exec, as its own words, after
 * the seconds it may run (the script's first argument). With `group`, it runs under GNU `timeout -s KILL` (the second argument,
 * by absolute path since v0.6.6), which puts it in a process group of its own and kills the whole group when the time is up, so
 * no child a measurement started outlives it. If any limit cannot be set, nothing after it runs: the command is never started
 * without its limits.
 */
export const boundScript = (memory: boolean, group: boolean): string =>
  `${LIMITS(memory)} && t=$1 && shift && ${group ? 'k=$1 && shift && exec "$k" -s KILL "$t" "$@"' : 'exec "$@"'}`
/** Whether this host's `timeout` (its absolute path the first argument) is GNU's, whose process-group kill the script relies on. */
export const BOUND_PROBE_GROUP = 'exec "$1" --version'
/** Measurement processes running at once, at most; with the address-space limit, the most they hold together. */
export const BOUND_SLOTS = 2
/** Probes, once a session: are the limits accepted, and is the memory cap actually enforced (a 64 MiB allocation under 32 MiB must fail, and succeed without it)? */
export const BOUND_PROBE_SET = (memory: boolean): string => `${LIMITS(memory)} && echo set`
export const BOUND_PROBE_CONTROL = 'exec dd if=/dev/zero of=/dev/null bs=67108864 count=1'
export const BOUND_PROBE_CAPPED = `${LOWER} && lower -v 32768 && exec dd if=/dev/zero of=/dev/null bs=67108864 count=1`
/** No repository hooks, and no diff order file (read whole by status, diff and log; one pointed at a device exhausted memory). Also on a helper's rebuilt Git inspection. */
export const GIT_OVERRIDES = ['-c', 'core.hooksPath=/dev/null', '-c', 'diff.orderFile=/dev/null']
/**
 * Git settings that keep a legitimate command inside the cap: small pack windows, streaming for files over 16 MiB, no index
 * threads, no hooks, and no diff order file (status and diff read a configured one whole; measured: one pointed at a device
 * exhausted memory; the order of a listing never matters here).
 */
export const GIT_BOUNDED = [...GIT_OVERRIDES, '-c', 'core.packedGitWindowSize=32m', '-c', 'core.packedGitLimit=256m', '-c', 'core.deltaBaseCacheLimit=64m', '-c', 'core.bigFileThreshold=16m', '-c', 'core.preloadIndex=false', '-c', 'index.threads=1']
/** glibc reserves address space per malloc arena; two keep a bounded Git well inside its cap. */
export const BOUND_ENV = { MALLOC_ARENA_MAX: '2' }
/**
 * v0.6.6: laid over every measurement process's environment last, so no caller can take them back. A missing object is never
 * fetched: Git's own switch (documented from 2.45.0, ignored where Git does not know it) and a protocol allow-list no transport
 * matches, which overrides all protocol configuration (measured: it stopped a repository's `ext::` transport program on 2.43.0
 * and 2.47.3). No measurement fetches anything, so neither changes what a legitimate measurement reads.
 */
export const BOUND_PINS: Readonly<Record<string, string>> = { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'cockpit-none' }

// --- The clean launch (v0.6.6 Stage B) ---
// The host lays a process's `env` over its own environment and cannot take a variable away (measured), so a measurement process
// would inherit whatever the host's environment holds: Git's own variables, the dynamic loader's, exported shell functions (one
// named `ulimit` would replace the builtin the limit script relies on). Every measurement process therefore starts as
// `/usr/bin/env -i <allow-list> /bin/sh -c <limit script> …` with each program by absolute path: the host looks nothing up, and
// the shell and the program see only the variables listed here.

/** The two programs every measurement process starts through, by absolute path. */
export const CLEAN_ENV = '/usr/bin/env'
export const CLEAN_SHELL = '/bin/sh'
/**
 * Laid over the host's environment for `/usr/bin/env` itself, the one program that starts with it: the dynamic loader ignores
 * an empty value. Everything after `env -i` starts with none of them.
 */
export const LOADER_BLANK: Readonly<Record<string, string>> = { LD_PRELOAD: '', LD_LIBRARY_PATH: '', LD_AUDIT: '', DYLD_INSERT_LIBRARIES: '', DYLD_LIBRARY_PATH: '', DYLD_FRAMEWORK_PATH: '', DYLD_FALLBACK_LIBRARY_PATH: '' }
/** The programs measurement finds once a load: the five it runs, GNU `timeout` for the group kill, and `id` for the owner check. */
export const MEASURE_PROGRAMS = ['git', 'stat', 'find', 'readlink', 'realpath', 'timeout', 'id'] as const
export type MeasureProgram = (typeof MEASURE_PROGRAMS)[number]
/**
 * Programs measurement cannot run without. `timeout` and `id` only weaken what is killed or trusted when absent; without Git no Git
 * call starts, and a session with no Git and no `.git` anywhere is outside every repository, as it was before (outsideGit).
 */
export const REQUIRED_PROGRAMS: readonly MeasureProgram[] = ['stat', 'find', 'readlink', 'realpath']
/** Finds each on the PATH it is given, in the clean shell, one line each: its path, or an empty line. `command -v` is the shell's own builtin, so nothing on PATH runs to answer. */
export const RESOLVE_SCRIPT = `for p in ${MEASURE_PROGRAMS.join(' ')}; do command -v "$p" || echo; done`
/** The answer to RESOLVE_SCRIPT: each program's absolute path where found; null for any other output. */
export const resolvedOf = (text: string): Partial<Record<MeasureProgram, string>> | null => {
  if (!text.endsWith('\n')) return null
  const lines = text.slice(0, -1).split('\n')
  if (lines.length !== MEASURE_PROGRAMS.length) return null
  const out: Partial<Record<MeasureProgram, string>> = {}
  for (const [k, line] of lines.entries()) {
    // a builtin, an alias or a function answers with a word, not a path: not found
    if (line === '' || !line.startsWith('/')) continue
    out[MEASURE_PROGRAMS[k]!] = line
  }
  return out
}
/**
 * The PATH entries measurement searches: the absolute ones, in order, once each. An empty or relative entry names the current
 * directory, which may be the repository, so it is never searched. An unset PATH is the shell's usual default.
 */
export const trustedPathOf = (path: string | undefined): string[] => [...new Set((path ?? '/usr/bin:/bin').split(':').filter(entry => entry.startsWith('/') && !entry.includes('\n')))]
/** `stat -L` forms for a program's owner and mode, GNU and BSD; the GNU one carries the name asked for. */
export const OWNER_GNU = '%u %f %n\\0'
export const OWNER_BSD = '%u %p'
export type Owner = { uid: number; mode: number }
/** Parses OWNER_GNU or OWNER_BSD output for `names`, in order; null for anything malformed or out of order. */
export const ownersOf = (text: string, gnu: boolean, names: readonly string[]): Owner[] | null => {
  const rows = gnu ? (text.endsWith('\0') ? text.slice(0, -1).split('\0') : null) : text.endsWith('\n') ? text.slice(0, -1).split('\n') : null
  if (rows === null || rows.length !== names.length) return null
  const out: Owner[] = []
  for (const [k, row] of rows.entries()) {
    const m = gnu ? /^(\d+) ([0-9a-f]+) ([\s\S]+)$/.exec(row) : /^(\d+) ([0-7]+)$/.exec(row)
    if (m === null || (gnu && m[3] !== names[k])) return null
    out.push({ uid: Number(m[1]), mode: parseInt(m[2]!, gnu ? 16 : 8) })
  }
  return out
}
/**
 * Whether a program may be started for measurement: a regular file owned by root or by the session's user (`uid`; root only
 * when it is not known), not writable by its group or others, in a directory others cannot write to.
 */
export const programTrusted = (file: Owner, dir: Owner, uid: number | null): boolean =>
  kindOfMode(file.mode) === 'file' && (file.uid === 0 || (uid !== null && file.uid === uid)) && (file.mode & 0o022) === 0 && kindOfMode(dir.mode) === 'dir' && (dir.mode & 0o002) === 0
/**
 * Variables that make the person's own Git use another repository, index, object store, configuration or attributes than it
 * would find from the session directory. The clean environment does not pass them, so where one is set Cockpit's Git would
 * measure something other than what the person's Git sees: measurement is refused instead (register.tsx reads each by its
 * literal name, and only whether it is set). Variables that only change what Git runs or where it writes are simply not passed.
 */
export const GIT_ENV_MEASURED: readonly string[] = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_ATTR_SOURCE', 'GIT_ATTR_NOSYSTEM',
]
/** What a measurement process may see beyond the fixed variables: where to find programs, and where the person's global Git configuration is (so it reads what the person's Git reads). */
export type CleanBase = { readonly path: readonly string[]; readonly home?: string; readonly xdgConfigHome?: string }
/** The only variable a caller may add, with the only value it may have. */
export const CALLER_ENV: Readonly<Record<string, string>> = { LC_ALL: 'C' }
/** Whether a caller's own variables are admitted: none, or LC_ALL=C. */
export const callerEnvAdmitted = (env: Readonly<Record<string, string>> | undefined): boolean =>
  env === undefined || Object.entries(env).every(([name, value]) => CALLER_ENV[name] === value)
/** The `NAME=value` words after `env -i`, in order; the pins last, so nothing before them can take them back. */
export const cleanAssignments = (base: CleanBase, env: Readonly<Record<string, string>> | undefined): string[] => [
  `PATH=${base.path.join(':')}`,
  ...(base.home === undefined ? [] : [`HOME=${base.home}`]),
  ...(base.xdgConfigHome === undefined ? [] : [`XDG_CONFIG_HOME=${base.xdgConfigHome}`]),
  ...Object.entries(BOUND_ENV).map(([name, value]) => `${name}=${value}`),
  ...Object.entries(env ?? {}).filter(([name, value]) => CALLER_ENV[name] === value).map(([name, value]) => `${name}=${value}`),
  ...Object.entries(BOUND_PINS).map(([name, value]) => `${name}=${value}`),
]
/** A helper's rebuilt Git inspection (git-inspect.ts): the same clean start, without the measurement limits it never ran under. */
export const helperAssignments = (base: CleanBase): string[] => [
  `PATH=${base.path.join(':')}`,
  ...(base.home === undefined ? [] : [`HOME=${base.home}`]),
  ...(base.xdgConfigHome === undefined ? [] : [`XDG_CONFIG_HOME=${base.xdgConfigHome}`]),
  ...Object.entries(BOUND_PINS).map(([name, value]) => `${name}=${value}`),
]
/** How a helper's inspection starts: the assignments after `env -i`, and Git by absolute path. */
export type HelperLaunch = { readonly env: readonly string[]; readonly git: string }

/** One working-tree file the fingerprint reads, and all of them together, at most; beyond either, the tree is UNKNOWN. */
export const FINGERPRINT_FILE_BYTES = 1024 ** 3
export const FINGERPRINT_TOTAL_BYTES = 8 * 1024 ** 3
/** An excludes or attributes file Git reads whole must be a regular file of at most this. */
export const SOURCE_BYTES = 1024 * 1024

export type Kind = 'file' | 'link' | 'dir' | 'fifo' | 'socket' | 'char' | 'block' | 'missing'
/**
 * What `stat` (or `stat -L`) said about one path: its kind, its size, and an identity that moves when the file is replaced or
 * rewritten. `name` is the path the record answers for, where the form carries it (GNU).
 */
export type Inspected = { kind: Kind; mode: number; size: number; identity: string; name?: string }

export const kindOfMode = (mode: number): Kind | null => {
  switch (mode & 0o170000) {
    case 0o100000: return 'file'
    case 0o120000: return 'link'
    case 0o040000: return 'dir'
    case 0o010000: return 'fifo'
    case 0o140000: return 'socket'
    case 0o020000: return 'char'
    case 0o060000: return 'block'
    default: return null
  }
}
/**
 * GNU `stat --printf` and BSD `stat -f` forms of the same five facts: raw mode, size, inode, modification and change time. The
 * GNU form also carries the name asked for, so a batch in which some paths failed still answers for the others.
 */
export const INSPECT_GNU = '%f %s %i %.9Y %.9Z %n\\0'
export const INSPECT_BSD = '%p %z %i %m %c'
/** Parses one record of either form; null for anything malformed. */
export const inspectedOf = (record: string, gnu: boolean): Inspected | null => {
  const m = gnu ? /^([0-9a-f]+) (\d+) (\d+) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) ([\s\S]+)$/.exec(record) : /^([0-7]+) (\d+) (\d+) (\d+) (\d+)$/.exec(record)
  if (!m) return null
  const mode = parseInt(m[1]!, gnu ? 16 : 8)
  const kind = kindOfMode(mode)
  const size = Number(m[2])
  if (kind === null || !Number.isSafeInteger(size)) return null
  return { kind, mode, size, identity: `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}`, ...(gnu ? { name: m[6]! } : {}) }
}

// --- Repository state and the measurement runner's admission (v0.6.6) ---
// Some repository states make an ordinary-looking Git read run a program the repository chose: a submodule's own
// configuration during a superproject's status or diff, and a lazy fetch of a missing object in a partial clone. Such states are
// refused before any Git command that could enter or fetch (repoState in register.tsx). The runner admits a Git command that
// reads the index, the work tree or objects only with the authorisation that refusal check hands out; what it may run without
// one is the closed discovery list below.

/** The only programs a measurement process may be; anything else is refused before it starts. */
export const BOUND_PROGRAMS: readonly string[] = ['git', 'stat', 'find', 'readlink', 'realpath']
/** The `stat` forms the fingerprint uses for ignored and watched entries (no reads: inode, size, modification and change times). */
export const IGNORED_GNU = '%i %s %.9Y %.9Z %n\\0'
export const IGNORED_BSD = '%i %z %m %c %N'
/** A path given to a measurement program: never empty, never a NUL. Where it could be read as an option, the form puts it after `--`. */
const isPathWord = (word: string | undefined): word is string => word !== undefined && word !== '' && !word.includes('\0')
const allPaths = (words: readonly string[]): boolean => words.length > 0 && words.every(isPathWord)
const same = (args: readonly string[], form: readonly string[]): boolean => args.length === form.length && form.every((word, i) => args[i] === word)
/**
 * Whether a measurement process that is not Git has a form Cockpit writes, exactly (v0.6.6 Stage B; before, any `stat`, `readlink`
 * or `realpath` arguments were accepted). `stat`: the inspection forms (GNU or BSD, with or without `-L`), the ignored-entry forms,
 * and `stat -- <one path>`. `realpath -e -- <path>`. `readlink -z -- <path>`, or the plain fallback `readlink <path>` for a path that
 * begins with `./` or `/`. `find` could run a program (`-exec`, `-delete`, `-fprint`), so only its two listings: a directory's files
 * and links, and the promisor pack markers.
 */
export const nonGitAdmitted = (argv: readonly string[]): boolean => {
  const args = argv.slice(1)
  if (argv[0] === 'stat') {
    const rest = args[0] === '-L' ? args.slice(1) : args
    const follows = rest !== args
    if (rest[2] === '--' && ((rest[0] === '--printf' && rest[1] === INSPECT_GNU) || (rest[0] === '-f' && rest[1] === INSPECT_BSD))) return allPaths(rest.slice(3))
    if (follows) return false
    if (rest[2] === '--' && ((rest[0] === '--printf' && rest[1] === IGNORED_GNU) || (rest[0] === '-f' && rest[1] === IGNORED_BSD))) return allPaths(rest.slice(3))
    return rest.length === 2 && rest[0] === '--' && isPathWord(rest[1])
  }
  if (argv[0] === 'realpath') return args.length === 3 && args[0] === '-e' && args[1] === '--' && isPathWord(args[2])
  if (argv[0] === 'readlink') return (args.length === 3 && args[0] === '-z' && args[1] === '--' && isPathWord(args[2])) || (args.length === 1 && isPathWord(args[0]) && (args[0].startsWith('./') || args[0].startsWith('/')))
  if (argv[0] !== 'find' || argv[1] !== '-H' || argv[2] === undefined || argv[2] === '' || argv[2].startsWith('-')) return false
  const rest = argv.slice(3)

  return same(rest, ['(', '-type', 'f', '-o', '-type', 'l', ')', '-print0']) || same(rest, ['-maxdepth', '1', '-name', '*.promisor', '-print0'])
}
/** A commit a measurement names to Git: HEAD or a full object id, never an option or a revision expression. */
const COMMIT_NAME = /^(?:HEAD|[0-9a-f]{40}|[0-9a-f]{64})$/
/** A helper's revision, peeled to a commit: the scoped rule's plain name (git-inspect.ts REV_NAME), then `^{commit}`. */
const PEEL_NAME = /^[A-Za-z0-9@][A-Za-z0-9_.\/~^@-]{0,199}\^\{commit\}$/
/** A Git command as the runner sees it: the subcommand, its arguments, and the directory given with `-C`. */
export type GitCall = { sub: string; args: readonly string[]; dir: string | null }
/**
 * Reads the words before the subcommand. Only Cockpit's own form is accepted (v0.6.6 Stage B: exactly): GIT_SAFE, word for word
 * and in order, then at most one `-C` with an absolute directory; or `git --version` alone. Any other word there (another global
 * option, another setting, a relative directory) is no Git call the runner knows, and is refused.
 */
export const gitCallOf = (argv: readonly string[]): GitCall | null => {
  if (argv[0] !== 'git') return null
  if (argv.length === 2 && argv[1] === '--version') return { sub: '--version', args: [], dir: null }
  if (!GIT_SAFE.every((word, k) => argv[1 + k] === word)) return null
  let at = 1 + GIT_SAFE.length
  let dir: string | null = null
  if (argv[at] === '-C') {
    const named = argv[at + 1]
    if (!isPathWord(named) || !named.startsWith('/')) return null
    dir = named
    at += 2
  }
  const sub = argv[at]

  return sub === undefined || sub.startsWith('-') ? null : { sub, args: argv.slice(at + 1), dir }
}
/**
 * What a Git command reads, for admission. `discovery`: where the repository and its files are, and configuration (read without
 * running any program, fetching or entering a submodule). `listing`: the two listings the refusal check itself makes, the index's
 * stage entries and one commit's tree. `state`: the reads of the index, the work tree or objects Cockpit makes, which need the
 * check's pass. `refused`: anything else. v0.6.6 Stage B: every subcommand is admitted only in the argument forms Cockpit writes
 * (the table below, word for word, with commit names and paths in their places), so no pass admits `hash-object -w`,
 * `diff --output=…`, `--ext-diff` or any form not listed; and the forms that run in a repository say so with `-C`, while the two
 * that find one run in the session directory without it.
 */
export type GitAccess = 'discovery' | 'listing' | 'state' | 'refused'
export const gitAccessOf = (call: GitCall): GitAccess => {
  const { sub, args, dir } = call
  if (sub === '--version') return args.length === 0 && dir === null ? 'discovery' : 'refused'
  // finding the repository: from the session directory, no -C
  if (sub === 'rev-parse' && dir === null) return same(args, ['--show-toplevel']) || same(args, ['--show-prefix']) ? 'discovery' : 'refused'
  if (dir === null) return 'refused'
  switch (sub) {
    case 'rev-parse':
      if (same(args, ['--git-path', 'info/exclude', '--git-path', 'info/attributes', '--git-path', 'objects/info/alternates']) || same(args, ['--git-path', 'objects/pack']) || same(args, ['--verify', 'HEAD'])) return 'discovery'
      // a helper's named revision, proved a commit: it reads the commit (and a tag) object
      return args.length === 3 && args[0] === '--verify' && args[1] === '--quiet' && PEEL_NAME.test(args[2]!) ? 'state' : 'refused'
    case 'config':
      if (same(args, ['--null', '--list'])) return 'discovery'
      if (args.length === 3 && args[0] === '--type=path' && args[1] === '--get' && (args[2] === 'core.excludesFile' || args[2] === 'core.attributesFile')) return 'discovery'
      return args.length === 3 && args[0] === '--bool' && args[1] === '--get' && (args[2] === 'core.symlinks' || args[2] === 'core.filemode') ? 'discovery' : 'refused'
    case 'ls-files':
      if (same(args, ['-z', '--stage'])) return 'listing'
      if (same(args, ['-z']) || same(args, ['-v', '-z']) || same(args, ['-o', '--exclude-standard', '-z'])) return 'state'
      // the ignored entries, with the operator's volatile prefixes as exclusions
      return same(args.slice(0, 6), ['-o', '-i', '--exclude-standard', '-z', '--', '.']) && args.slice(6).every(word => word.startsWith(':(exclude)') && isPathWord(word.slice(10))) ? 'state' : 'refused'
    case 'ls-tree':
      return args.length === 4 && args[0] === '-r' && args[1] === '-z' && args[2] === '--full-tree' && COMMIT_NAME.test(args[3]!) ? 'listing' : 'refused'
    case 'check-attr':
      return same(args, ['-z', '--stdin', 'filter']) ? 'state' : 'refused'
    case 'hash-object':
      // raw bytes (no filters), or native normalisation once the filter check ruled filters out; never -w, never a type
      if (same(args, ['--no-filters', '--stdin'])) return 'state'
      if (args[0] === '--no-filters' && args[1] === '--') return allPaths(args.slice(2)) ? 'state' : 'refused'
      return args[0] === '--' && allPaths(args.slice(1)) ? 'state' : 'refused'
    case 'diff':
      return args.length === 7 && COMMIT_NAME.test(args[0]!) && same(args.slice(1, 6), ['-O/dev/null', '--no-renames', '--ignore-submodules=all', '--name-only', '-z']) && (args[6] === '--diff-filter=d' || args[6] === '--diff-filter=D') ? 'state' : 'refused'
    case 'status':
      return same(args, ['--porcelain', '--untracked-files=all', '--ignore-submodules=all']) || same(args, ['--porcelain=v2', '--branch', '--ignore-submodules=all']) ? 'state' : 'refused'
    default:
      return 'refused'
  }
}
/**
 * The filter-driver entries of a `config --null --list` answer, in the form `config --null --get-regexp` gives them, for
 * `filterCommands`: the check's one complete read of the configuration also decides the filter check, so no second read can
 * answer "no filter" from an exit status that a signal could have produced.
 */
export const filterRecordsOf = (configList: string): string =>
  configList === '' ? '' : configList.slice(0, -1).split('\0').filter(record => /^filter\..+\.(?:clean|process)$/.test((record.includes('\n') ? record.slice(0, record.indexOf('\n')) : record).toLowerCase())).map(record => `${record}\0`).join('')

/** The values Git reads as false for a boolean; anything else, a key with no value included, is read as true here. */
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', 'no', 'off', '0'])
/**
 * Whether `git config --null --list` (every scope Git reads, includes and the environment's) shows a partial clone: an
 * `extensions.partialClone` key, any `remote.<name>.partialCloneFilter`, or a `remote.<name>.promisor` that is not plainly false.
 * Doubt counts as partial: an empty value, a number or a value-less key. Null for output that does not parse.
 */
export const partialCloneOf = (text: string): boolean | null => {
  if (text !== '' && !text.endsWith('\0')) return null
  for (const record of text === '' ? [] : text.slice(0, -1).split('\0')) {
    const split = record.indexOf('\n')
    const key = (split < 0 ? record : record.slice(0, split)).toLowerCase()
    if (!/^[a-z0-9-]+(?:\..+)?\.[a-z0-9-]+$/.test(key)) return null
    const value = split < 0 ? null : record.slice(split + 1)
    if (key === 'extensions.partialclone') return true
    if (/^remote\..+\.partialclonefilter$/.test(key)) return true
    if (/^remote\..+\.promisor$/.test(key) && (value === null || !FALSE_WORDS.has(value.toLowerCase()))) return true
  }

  return false
}
/**
 * How many gitlinks (mode 160000) `git ls-files -z --stage` lists; null for output that does not parse or is past the tracked-file
 * limit. Every record must be six octal digits, a space, a 40- or 64-digit lowercase hex object id, a space, a stage 0-3, a tab and
 * a non-empty path. One pass over the text, without splitting it or a pattern per record: the listing of a large index is read
 * several times per measurement (measured: 3.3 MB for 45,000 paths took 15 ms per call with a pattern per record).
 */
export const stageGitlinks = (text: string): number | null => {
  if (text === '') return 0
  if (!text.endsWith('\0')) return null
  const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 97 && c <= 102)
  let gitlinks = 0
  let records = 0
  for (let at = 0; at < text.length;) {
    const end = text.indexOf('\0', at)
    for (let k = 0; k < 6; k++) { const c = text.charCodeAt(at + k); if (!(c >= 48 && c <= 55)) return null }
    if (text.charCodeAt(at + 6) !== 32) return null
    let o = at + 7
    let digits = 0
    while (digits < 65 && isHex(text.charCodeAt(o + digits))) digits++
    if (digits !== 40 && digits !== 64) return null
    o += digits
    const stage = text.charCodeAt(o + 1)
    if (text.charCodeAt(o) !== 32 || !(stage >= 48 && stage <= 51) || text.charCodeAt(o + 2) !== 9 || o + 3 >= end) return null
    if (text.startsWith('160000', at)) gitlinks += 1
    if (++records > TRACKED_LIMIT) return null
    at = end + 1
  }

  return gitlinks
}
/** How many promisor pack markers a `find … -name '*.promisor' -print0` listed; null for output that does not parse. */
export const promisorPacksOf = (text: string): number | null => {
  if (text !== '' && !text.endsWith('\0')) return null
  const names = text === '' ? [] : text.slice(0, -1).split('\0')

  return names.every(name => name.endsWith('.promisor')) ? names.length : null
}

/** Why a repository is not measured (v0.6.6). */
export type RepoRefusal = 'submodule' | 'partial-clone' | 'unreadable' | 'moved'
/** The reason in words, wherever an UNKNOWN reason is shown; the first two say what a person can do about it. */
export const REPO_REFUSAL_WORDS: Readonly<Record<RepoRefusal, string>> = {
  submodule: 'a submodule (gitlink) is recorded in the index, HEAD or the commit compared against; Cockpit does not measure submodules and does not let Git enter them, so goal checks and Stop checks cannot be verified in this repository (a checkout without submodules can be measured)',
  'partial-clone': 'the repository is a partial clone (a promisor remote, extensions.partialClone or promisor packs) and Git could fetch a missing object by running the remote\'s transport, so it is not measured; goal checks and Stop checks cannot be verified here (a full clone, made without --filter, can be measured)',
  unreadable: 'the repository\'s submodule and partial-clone state could not be read (Git failed, timed out, reached a limit or its output was cut short)',
  moved: 'the repository\'s submodule or partial-clone state changed while the working tree was being measured',
}
/** The same, in the few words the HUD has room for. */
export const REPO_REFUSAL_SHORT: Readonly<Record<RepoRefusal, string>> = { submodule: 'submodule', 'partial-clone': 'partial clone', unreadable: 'state unreadable', moved: 'state changed' }

/**
 * Settings a helper's rebuilt Git inspection also carries (v0.6.6), as defence in depth behind the refusal of submodule and
 * partial-clone repositories: no submodule diff, and no transport for any protocol. A helper cannot pass `-c` itself.
 */
export const HELPER_PINS: readonly string[] = ['-c', 'diff.submodule=short', '-c', 'protocol.allow=never', ...['ext', 'file', 'ssh', 'git', 'http', 'https'].flatMap(p => ['-c', `protocol.${p}.allow=never`])]
/**
 * Variables that move where Git looks, what configuration it reads, what it runs or where it writes. A helper's inspection runs
 * in the host's Bash tool with the host's environment; where Cockpit's own environment sets any of these, it is refused rather
 * than trusted (register.tsx reads each by its literal name, and only whether it is set). This is a list of known names, not a
 * sanitised environment: the plugin interface reads a variable only by a name written in the source and cannot list the rest,
 * and the Bash tool's own shell start-up is not visible to Cockpit (docs/implementation-v0.6.6.md). Since Stage B the rebuilt
 * command itself starts Git with a clean environment, so none of these reaches it; the refusal is kept, and holds every name of
 * GIT_ENV_MEASURED too, so helper inspection refuses wherever measurement would.
 */
export const GIT_ENV_REFUSED: readonly string[] = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  'GIT_EXEC_PATH', 'GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND', 'GIT_ALLOW_PROTOCOL',
  'GIT_ATTR_SOURCE', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_TRACE', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF',
  'GIT_TRACE_PACKET', 'GIT_TRACE_PACKFILE', 'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_SETUP', 'GIT_TRACE_SHALLOW', 'GIT_TRACE_CURL', 'GIT_TRACE_REFS', 'GIT_TRACE_FSMONITOR',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_GRAFT_FILE', 'GIT_CONFIG_NOSYSTEM', 'GIT_ATTR_NOSYSTEM',
]

/** `git --version` read strictly; `lazyFetchSwitch` where Git documents its own switch for lazy fetching (2.45.0 and later). */
export const gitVersionOf = (text: string): { version: string; lazyFetchSwitch: boolean } | null => {
  const match = /^git version (\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?[^\n]{0,80}\n?$/.exec(text)
  if (match === null) return null
  const major = Number(match[1]), minor = Number(match[2])

  return { version: `${major}.${minor}${match[3] === undefined ? '' : `.${Number(match[3])}`}`, lazyFetchSwitch: major > 2 || (major === 2 && minor >= 45) }
}
