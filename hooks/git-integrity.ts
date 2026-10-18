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
 * the seconds it may run (the script's first argument). With `group`, it runs under GNU `timeout -s KILL`, which puts it in a
 * process group of its own and kills the whole group when the time is up, so no child a measurement started outlives it. If
 * any limit cannot be set, nothing after it runs: the command is never started without its limits.
 */
export const boundScript = (memory: boolean, group: boolean): string =>
  `${LIMITS(memory)} && t=$1 && shift && ${group ? 'exec timeout -s KILL "$t" "$@"' : 'exec "$@"'}`
/** Whether this host's `timeout` is GNU's, whose process-group kill the script relies on. */
export const BOUND_PROBE_GROUP = 'timeout --version 2>/dev/null | head -n 1'
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
/**
 * Whether a measurement process that is not Git has a form Cockpit writes. `stat`, `readlink` and `realpath` take options and
 * paths and run nothing; `find` could (`-exec`, `-delete`, `-fprint`), so only its two forms are admitted: the listing of a
 * directory's files and links, and the listing of promisor pack markers.
 */
export const nonGitAdmitted = (argv: readonly string[]): boolean => {
  if (argv[0] === 'stat' || argv[0] === 'readlink' || argv[0] === 'realpath') return true
  if (argv[0] !== 'find' || argv[1] !== '-H' || argv[2] === undefined || argv[2] === '' || argv[2].startsWith('-')) return false
  const rest = argv.slice(3).join('\0')

  return rest === ['(', '-type', 'f', '-o', '-type', 'l', ')', '-print0'].join('\0') || rest === ['-maxdepth', '1', '-name', '*.promisor', '-print0'].join('\0')
}
/** A commit a preflight listing may name: HEAD or a full object id. */
const COMMIT_NAME = /^(?:HEAD|[0-9a-f]{40}|[0-9a-f]{64})$/
/** The `-c` settings a measurement may carry: exactly those of GIT_SAFE (GIT_BOUNDED's are added by the runner itself, after admission). */
const SAFE_SETTINGS: ReadonlySet<string> = new Set(GIT_SAFE.filter((_, i) => GIT_SAFE[i - 1] === '-c'))
/** The Git subcommands a measurement may run with the repository-state check's pass; any other is refused, pass or not. */
const STATE_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'ls-files', 'ls-tree', 'hash-object', 'check-attr'])
/** A Git command as the runner sees it: the subcommand, its arguments, and the directory given with `-C`. */
export type GitCall = { sub: string; args: readonly string[]; dir: string | null }
/**
 * Reads the words before the subcommand. Only Cockpit's own forms are accepted: the three safe flags, a `-c` setting of GIT_SAFE
 * and at most one `-C <dir>`. Any other word there (another global option, a second `-C`, any other setting) is no Git call the
 * runner knows, and is refused.
 */
export const gitCallOf = (argv: readonly string[]): GitCall | null => {
  if (argv[0] !== 'git') return null
  let at = 1
  let dir: string | null = null
  for (;;) {
    const word = argv[at]
    if (word === undefined) return null
    if (word === '-c') {
      const setting = argv[at + 1]
      if (setting === undefined || !SAFE_SETTINGS.has(setting)) return null
      at += 2
    } else if (word === '-C') {
      const named = argv[at + 1]
      if (named === undefined || named === '' || dir !== null) return null
      dir = named
      at += 2
    } else if (word === '--no-optional-locks' || word === '--no-replace-objects' || word === '--literal-pathspecs') {
      at += 1
    } else {
      // any other option here is a global option Cockpit does not write (`--git-dir`, `--exec-path`, `--no-pager`, …)
      return word.startsWith('-') && word !== '--version' ? null : { sub: word, args: argv.slice(at + 1), dir }
    }
  }
}
/**
 * What a Git command reads, for admission. `discovery`: where the repository and its files are, and configuration (read without
 * running any program, fetching or entering a submodule). `listing`: the two listings the refusal check itself makes, the index's
 * stage entries and one commit's tree. `state`: the reads of the index, the work tree or objects Cockpit makes (STATE_SUBCOMMANDS,
 * and a peel `rev-parse --verify --quiet <name>^{commit}`), which need the check's pass. `refused`: anything else, which no pass
 * admits (a fetch, a write, another configuration form). `rev-parse --verify HEAD` resolves a reference and reads no object.
 */
export type GitAccess = 'discovery' | 'listing' | 'state' | 'refused'
export const gitAccessOf = (call: GitCall): GitAccess => {
  const { sub, args } = call
  if (sub === '--version') return args.length === 0 ? 'discovery' : 'refused'
  if (sub === 'rev-parse') {
    if (args.length === 2 && args[0] === '--verify' && args[1] === 'HEAD') return 'discovery'
    if (args.length === 3 && args[0] === '--verify' && args[1] === '--quiet' && /^[A-Za-z0-9@][^\s]*\^\{commit\}$/.test(args[2] as string)) return 'state'
    let i = 0
    while (i < args.length) {
      const word = args[i] as string
      const next = args[i + 1]
      if (word === '--show-toplevel' || word === '--show-prefix') i += 1
      else if (word === '--git-path' && next !== undefined && next !== '' && !next.startsWith('-')) i += 2
      else return 'refused'
    }
    return args.length > 0 ? 'discovery' : 'refused'
  }
  if (sub === 'config') {
    let form: string | null = null
    let i = 0
    while (i < args.length) {
      const word = args[i] as string
      const next = args[i + 1]
      if (word === '--null' || word === '--type=path' || word === '--bool') i += 1
      else if (form === null && (word === '--get' || word === '--get-regexp') && next !== undefined && next !== '' && !next.startsWith('-') && i + 2 === args.length) { form = word; i += 2 }
      else if (form === null && word === '--list' && i + 1 === args.length) { form = word; i += 1 }
      else return 'refused'
    }
    return form === null ? 'refused' : 'discovery'
  }
  if (sub === 'ls-files' && args.length === 2 && args[0] === '-z' && args[1] === '--stage') return 'listing'
  if (sub === 'ls-tree' && args.length === 4 && args[0] === '-r' && args[1] === '-z' && args[2] === '--full-tree' && COMMIT_NAME.test(args[3] as string)) return 'listing'

  return STATE_SUBCOMMANDS.has(sub) ? 'state' : 'refused'
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
 * and the Bash tool's own shell start-up is not visible to Cockpit (docs/implementation-v0.6.6.md).
 */
export const GIT_ENV_REFUSED: readonly string[] = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  'GIT_EXEC_PATH', 'GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND', 'GIT_ALLOW_PROTOCOL',
  'GIT_ATTR_SOURCE', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_TRACE', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF',
  'GIT_TRACE_PACKET', 'GIT_TRACE_PACKFILE', 'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_SETUP', 'GIT_TRACE_SHALLOW', 'GIT_TRACE_CURL', 'GIT_TRACE_REFS', 'GIT_TRACE_FSMONITOR',
]

/** `git --version` read strictly; `lazyFetchSwitch` where Git documents its own switch for lazy fetching (2.45.0 and later). */
export const gitVersionOf = (text: string): { version: string; lazyFetchSwitch: boolean } | null => {
  const match = /^git version (\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?[^\n]{0,80}\n?$/.exec(text)
  if (match === null) return null
  const major = Number(match[1]), minor = Number(match[2])

  return { version: `${major}.${minor}${match[3] === undefined ? '' : `.${Number(match[3])}`}`, lazyFetchSwitch: major > 2 || (major === 2 && minor >= 45) }
}
