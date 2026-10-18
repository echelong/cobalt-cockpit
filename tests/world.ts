// The world beneath the plugin, for tests: a clock that moves when told, a
// store in memory, a git that answers from a string, audio players that can
// be missing or broken, and tools that run nothing. Every call the plugin
// makes on the host is recorded, so a test asserts on what really happened.

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import { BOUND_PROBE_CAPPED, BOUND_PROBE_CONTROL, BOUND_PROBE_GROUP, BOUND_PROBE_SET, BOUND_TAG, INSPECT_BSD, INSPECT_GNU } from '../hooks/git-integrity'
import type { Kind } from '../hooks/git-integrity'

export const PLUGIN = 'cobalt-cockpit'
export const TOOL = 'mcp__cobalt-cockpit__progress'

export type PlayerBehavior = 'ok' | 'fails' | 'missing' | 'hangs'

export type World = {
  clock: MockClock
  /** Every `$.process.run`, as its argv; a command started through the limit script is recorded as itself (see `wrappers`). */
  runs: string[][]
  /** v0.6.4, in the order of `runs`: the limit script a command was started through, or null when it was started directly. */
  wrappers: (string | null)[]
  /** The limit probes the plugin ran, as their scripts; they are not in `runs`. */
  boundProbes: string[]
  /** v0.6.4, in the order of `runs`: the seconds the limit script's group timeout was given, or null when there was no script. */
  wrapperSeconds: (string | null)[]
  /** Whether this host's `timeout` is GNU's (process-group kill). */
  groupTimeout: boolean
  /** Most measurement processes seen running at once. */
  peakRunning: number
  /** Event-loop turns each measurement process takes, so that concurrent ones overlap (0: none). */
  runDelayTicks: number
  /**
   * Whether a `.git` entry is in the session directory (unset: there is one exactly when `gitStatus` is a repository). Parents never
   * have one. A `.git` with no repository Git can read is a damaged repository, not a project outside Git.
   */
  dotGitPresent: boolean | null
  /** `realpath` fails (as it would for a directory that cannot be resolved). */
  realpathFails: boolean
  /** What `git rev-parse` prints outside a repository (Git's own words; the mount-point form is the other real one), and its exit. */
  notRepository: string
  notRepositoryExit: number
  /**
   * What this host's `sh` makes of the limits: all enforced (`full`); the memory limit accepted but not enforced (`partial`);
   * no memory limit accepted (`basic`); no `sh` at all (`none`); `flaky`: the first enforcement probe does not answer, later ones
   * are `full`.
   */
  boundMode: 'full' | 'partial' | 'basic' | 'none' | 'flaky'
  /**
   * What `stat` (without -L) sees at a path, relative to the work tree or absolute outside it; unset: from `diskModes`, a watched
   * or embedded directory, else an ordinary file (alternates: missing). `followKinds` is what `stat -L` sees through a link
   * (unset: an ordinary file). `sizes` overrides a file's size (default: its content's), `inodes` its inode (default 1).
   */
  kinds: Record<string, Kind>
  followKinds: Record<string, Kind>
  sizes: Record<string, number>
  inodes: Record<string, number>
  /** A path's modification time as `stat` prints it (default 1.000000000). */
  mtimes: Record<string, string>
  /**
   * What `rev-parse --git-path <name>` prefixes: `.git/` (relative, as real Git answers in a main worktree) by default, an
   * absolute common directory for a linked worktree.
   */
  gitPathBase: string
  /** The text of a symbolic link, as `readlink` prints it (default `target`); `outputs.readlink` overrides it. */
  linkTargets: Record<string, string>
  /** Which `stat` this host has: GNU (`--printf`) or BSD (`-f`). */
  statFlavor: 'gnu' | 'bsd'
  /**
   * The ignored-entry `stat --printf` fails as if an entry vanished, and the BSD-form fallback answers as GNU `stat -f` does:
   * file-system status, one line per name, none of them the form asked for.
   */
  statFileSystem: boolean
  /** The mkdir, chmod and rm the plugin ran on its own telemetry directory; kept apart so `runs` stays the commands a test is about. */
  telemetryRuns: string[][]
  /** What the plugin's telemetry mkdir, chmod and stat get back: they work, are refused, or read back a wider mode than asked. */
  telemetryModes: 'ok' | 'denied' | 'wide'
  /** Every $.fs.write fails, as a full disk would. */
  failWrites: boolean
  /** Every `$.fs.exists` throws, as an unreadable filesystem would. */
  failExists: boolean
  /** `$.session.authorize()` throws, as an engine that does not answer would. */
  failAuthorize: boolean
  /** Every `$.ui.notify` the plugin made. */
  notified: { text: string; title: string | undefined }[]
  /** What `$.session.cwd()` answers. */
  cwd: string
  /** What the host's notification channel does with one. */
  notifyMode: 'sent' | 'throws' | 'disabled'
  /** Runs while a notification is being written, before the host answers: what a person does in that moment. */
  duringNotify?: () => Promise<unknown>
  /** The channel the host says it wrote to (default kitty). */
  notifyChannel?: 'iterm2' | 'iterm2_with_bell' | 'kitty' | 'ghostty' | 'terminal_bell'
  /** The environment each process was started with over the host's own, in the order of `runs`; undefined when none was given. */
  runEnvs: (Readonly<Record<string, string>> | undefined)[]
  /** The tool calls that reached the engine, in order: what actually ran. */
  ran: Record<string, unknown>[]
  /** The questions put to the person. */
  asked: string[]
  /** The label the person picks; null dismisses the dialog. */
  answer: string | null
  /** Lines the plugin wrote to the transcript (not the debug log). */
  transcript: string[]
  blits: number
  /** What `git status --porcelain=v2 --branch` prints; null: not a repository. */
  gitStatus: string | null
  /** `git ls-files -v -z` output: index flags (a lowercase tag is assume-unchanged, S is skip-worktree). */
  indexFlags: string
  /** Paths `git ls-files -o` lists as untracked and not ignored. */
  untracked: string[]
  /** Entries `git ls-files -o -i` lists: untracked and ignored (by .gitignore, info/exclude or a global file). */
  ignoredEntries: string[]
  /** What `git ls-files -o` prints on stderr while exiting 0 (real git: "warning: could not open directory 'd/': Permission denied"); null: nothing. */
  lsFilesWarning: string | null
  /** Tracked files git lists as stat-dirty (`ls-files -m`), whether or not `diff` reports them (a clean filter can hide them). */
  statDirty: string[]
  /** The blob id the base commit holds for a path, as `ls-tree` reports it (absent: none). */
  headBlobs: Record<string, string>
  /** Commit entry modes and actual disk file modes, independent of any cached index state. */
  headModes: Record<string, string>
  diskModes: Record<string, number>
  /** Native Git normalization result; raw hashing still observes the original bytes. */
  normalized: Record<string, string>
  gitConfig: Record<string, string>
  /** The content of .git/info/attributes. */
  attributes: string
  /** `size mtime` per ignored entry, as stat reports it; absent means `1 1`. */
  ignoredMeta: Record<string, string>
  /**
   * Ignored FILES by path, each with its stat line (`size mtime`). `ls-files -o -i --directory` collapses them to their top directory
   * (whose own stat is `dirMeta`, and does not move when a child is rewritten); without --directory every file is listed.
   */
  ignoredFiles: Record<string, string>
  /** The stat line of a collapsed top-level ignored directory, by name with its trailing slash. */
  dirMeta: Record<string, string>
  /** Directories the plugin may be told to watch: git cannot hash them as objects; `find` lists their files. */
  watchedDirs: Record<string, string[]>
  /** Paths `find` cannot read in full: it exits 1 after printing some of the files, as it does with an unreadable subdirectory. */
  watchedUnreadable: string[]
  /** Watched paths whose parent cannot be entered: find and stat both fail, stat with "Permission denied" (real: the path is there, git/find just cannot reach it). */
  watchedDenied: string[]
  /** Ignored directories that hold their own repository: git lists each as ONE `dir/` entry (real git, with or without --directory). */
  embeddedRepos: Record<string, string[]>
  /** Content of files outside git's view that the fingerprint watches (path -> content). */
  watched: Record<string, string>
  /** Calls to stat that measure ignored and watched entries, for cost. */
  statCalls: number
  /** v0.6.4: calls to stat that inspect a path's kind before it is read, for cost. */
  inspectCalls: number
  /** A git subcommand that times out (throws), by name; `<subcommand> <option>` hangs only when the option is given. */
  gitHangs: string | null
  /** v0.6.4: a git subcommand whose output the host cuts short (isStdoutTruncated), by name. */
  gitTruncates: string | null
  /** v0.6.6: promisor pack markers in the object store's pack directory (names ending .promisor), as `find` lists them. */
  promisorPacks: string[]
  /** v0.6.6: the pack directory cannot be listed (`find` fails). */
  packListFails: boolean
  /** v0.6.6: paths staged as gitlinks (mode 160000) in the index only, as `ls-files -z --stage` lists them. */
  indexGitlinks: string[]
  /** v0.6.6: what `git --version` prints. */
  gitVersion: string
  /** v0.6.6: `git config --null --list` exits 1 with nothing printed (as a signal can read where GNU timeout is absent). */
  configListFails: boolean
  /** v0.6.6: revision names that peel to another commit (GITLINK_COMMIT), whose tree records a gitlink at vendor/lib; HEAD and the index do not. */
  gitlinkRevisions: string[]
  /** v0.6.6: a repository with no commit yet: `rev-parse --verify HEAD` and any HEAD tree listing fail as real Git does. */
  headUnborn: boolean
  /** v0.6.6: `rev-parse --verify HEAD` fails in some other way (a damaged HEAD): not Git's words for a repository with no commit. */
  headUnreadable: boolean
  /** The content of .git/info/exclude. */
  excludes: string
  /** The working tree as git sees it against HEAD: path to content. Changing it is a change the fingerprint must notice. */
  tree: Record<string, string>
  /** HEAD: a commit moves it and leaves `tree` alone. */
  head: string
  /** The work tree git reports for `rev-parse --show-toplevel`. */
  top: string
  /** Names that do not resolve to a commit: `rev-parse --verify <name>^{commit}` fails for each (a tree, a blob, an unknown name). */
  nonCommits: string[]
  /** Symbolic links `realpath` follows: a path at or below a key resolves to the same place at or below its value. */
  links: Record<string, string>
  gitPrefix: string
  gitFilterConfig: string
  gitFilterAttributes: string
  /** A repository-controlled fsmonitor / replace ref: `status` reports clean unless git is run with the hardened flags (see GIT_SAFE). */
  statusHidden: boolean
  /** A status warning or truncated stderr means the supposedly clean listing is incomplete. */
  statusWarning: string
  statusStderrTruncated: boolean
  /** Whether `git status --porcelain` reports changes (a release candidate must be clean). */
  uncommitted: boolean
  players: Record<string, PlayerBehavior>
  /** A program that answers with this stdout (exit 0), by name; checked before `players`. */
  outputs: Record<string, (argv: readonly string[]) => string>
  /** The tools the plugin registered, as it registered them. */
  registered: Record<string, unknown>[]
  usage: { percent?: number; tokens?: number; window: number }
  files: Record<string, string>
  /** Commands that exit non-zero. */
  failing: RegExp | null
  /** Tools other than Bash that answer with an error, by name. */
  failingTools: string[]
  version: string
  /** What `prompt.submit` carried into the session. */
  submitted: { text: string; context: readonly string[] }[]
  /** Panes the plugin opened. */
  opened: string[]
  /** Runs while a question is on screen, before it is answered. */
  whileAsked: ((question: string) => Promise<void>) | null
  /** The credential the engine holds, as `$.session.authorize()` answers it; null: none. */
  credential: { handle: string; kind: 'bearer' | 'api-key' } | null
  /** What `$.settings.read()` answers. */
  settings: Record<string, unknown>
  /** The environment beneath the plugin; a test sets a variable before `start`. */
  env: Record<string, string>
  /** What `$.session.model()` answers: the main loop's model. */
  model: string
  /** The session's subagents, as `$.agent.list()` answers them. */
  agents: { id: string; description: string; type: string; status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed' }[]
  /** The spawns that reached the engine, as they arrived: what really started. */
  spawns: Record<string, unknown>[]
  /** The model requests that reached the engine: what was really sent. */
  requests: { model: string; agentId?: string }[]
  /** The effort each request really carried after the hooks rewrote it. */
  efforts: { model: string; effort?: unknown; agentId?: string }[]
  /** The model that answers a request, when it is not the one asked for. */
  answersAs: string | null
  /** Toasts the plugin showed. */
  toasts: string[]
  /** Every `/config` row the plugin set by itself, by key: a setting written, not read. */
  configured: string[]
  /**
   * Every way out to a model or the network the plugin took by itself, named:
   * `http.fetch`, `model.complete`, `model.fork`, `model.classify`, `mcp.call`.
   * The plugin has no business with any of them, so a test asserts this stays empty.
   */
  outbound: string[]
  /** Every value the plugin handed to `$.store.set`, in order: what it persisted
   * beyond the session, so a test can read back a stored ledger. */
  storeWrites: { key: string; value: unknown }[]
  /** What the plugin's store holds now: a test reads it, and writes to it as another session would. */
  store: Map<string, unknown>
  /** Durable store keys whose write raises an error, for persistence recovery tests. */
  failStoreWrites: string[]
  /** Runs inside a process call, before it answers: a host event racing a process (a command typed while a router request is in flight). */
  duringRun: ((argv: readonly string[]) => void | Promise<void>) | null
  /** Runs inside the native tool call, before it answers: a host event racing a
   * tool (a turn completing while its handback is still running). */
  duringToolCall: ((call: Record<string, unknown>) => void | Promise<void>) | null
}

const MODEL_ALIAS: Record<string, string> = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' }

/** v0.6.6: the commit a gitlink revision peels to (see `gitlinkRevisions`); no other test uses it as HEAD. */
export const GITLINK_COMMIT = '5ee1ed0c0ffee'.padEnd(40, '5')
export const CLEAN_REPO = '# branch.oid 1111111aaaaaaa\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n'

const ran = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** Registers the bottom of every chain the plugin reaches, and returns the handles a test steers by. */
export const world = (on: On, overrides: Partial<World> = {}, stored: Readonly<Record<string, unknown>> = {}): World => {
  const w: World = {
    clock: mock.clock(on, { now: 1_000_000 }),
    runs: [],
    wrappers: [],
    wrapperSeconds: [],
    groupTimeout: true,
    peakRunning: 0,
    runDelayTicks: 0,
    dotGitPresent: null,
    notRepository: 'fatal: not a git repository (or any of the parent directories): .git\n',
    notRepositoryExit: 128,
    realpathFails: false,
    boundProbes: [],
    boundMode: 'full',
    kinds: {},
    followKinds: {},
    sizes: {},
    inodes: {},
    mtimes: {},
    gitPathBase: '.git/',
    linkTargets: {},
    statFlavor: 'gnu',
    statFileSystem: false,
    telemetryRuns: [],
    telemetryModes: 'ok',
    failWrites: false,
    failExists: false,
    failAuthorize: false,
    notified: [],
    cwd: '/work/example',
    gitPrefix: '',
    gitFilterConfig: '',
    gitFilterAttributes: '',
    notifyMode: 'sent',
    runEnvs: [],
    ran: [],
    asked: [],
    answer: 'Cancel',
    transcript: [],
    blits: 0,
    gitStatus: CLEAN_REPO,
    indexFlags: '',
    untracked: [],
    ignoredEntries: [],
    statDirty: [],
    headBlobs: {},
    headModes: {},
    diskModes: {},
    normalized: {},
    gitConfig: {},
    attributes: '',
    ignoredMeta: {},
    ignoredFiles: {},
    lsFilesWarning: null,
    dirMeta: {},
    watchedDirs: {},
    watchedUnreadable: [],
    watchedDenied: [],
    embeddedRepos: {},
    watched: {},
    statCalls: 0,
    inspectCalls: 0,
    gitHangs: null,
    gitTruncates: null,
    promisorPacks: [],
    packListFails: false,
    indexGitlinks: [],
    gitVersion: 'git version 2.47.3',
    configListFails: false,
    gitlinkRevisions: [],
    headUnborn: false,
    headUnreadable: false,
    excludes: '',
    tree: {},
    head: 'a'.repeat(40),
    top: '/work/example',
    nonCommits: [],
    links: {},
    statusHidden: false,
    statusWarning: '',
    statusStderrTruncated: false,
    uncommitted: false,
    players: { 'pw-play': 'ok' },
    outputs: {},
    registered: [],
    usage: { percent: 39, tokens: 78_000, window: 200_000 },
    files: {},
    failing: null,
    failingTools: [],
    version: '2.1.288',
    submitted: [],
    opened: [],
    whileAsked: null,
    credential: { handle: 'held-by-the-engine', kind: 'bearer' },
    settings: {},
    env: {},
    model: 'claude-opus-5-5',
    agents: [],
    spawns: [],
    requests: [],
    efforts: [],
    answersAs: null,
    toasts: [],
    configured: [],
    outbound: [],
    storeWrites: [],
    store: new Map(),
    failStoreWrites: [],
    duringToolCall: null,
    duringRun: null,
    ...overrides,
  }
  // A store write is the plugin's durable persistence. `mock.store` registers
  // `store.set` itself, so this outermost wildcard observes every write before
  // handing the event down to it. It records only `store.set` and passes all
  // other events through untouched.
  on('*', ($, e, next) => {
    if (next.is('store.set', e)) {
      if (w.failStoreWrites.includes(e.key)) throw new Error('injected store write failure')
      w.storeWrites.push({ key: e.key, value: e.value })
    }

    return next(e)
  })
  // The store is held here, as the engine keeps a plugin's own, so a test can read it and can write to it as another session would.
  const data = new Map<string, unknown>(Object.entries(stored).map(([k, v]) => [k, JSON.parse(JSON.stringify(v)) as unknown]))
  w.store = data
  on('store.get', (_$, e) => ({ value: data.has(e.key) ? JSON.parse(JSON.stringify(data.get(e.key))) as unknown : undefined }))
  on('store.set', (_$, e) => { data.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('store.delete', (_$, e) => { data.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...data.keys()] }))
  mock.env(on, { HOME: '/home/tester', ...w.env })

  on('session.version', () => ({ value: { version: w.version, base: w.version } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: w.usage.window, ...(w.usage.percent === undefined ? {} : { percent: w.usage.percent, tokens: w.usage.tokens ?? 0 }) }, rateLimits: [] },
  }))
  on('config.list', () => ({ value: [] }))
  // The engine starting a subagent: it resolves the model the spawn names (an
  // alias to its id, none to the haiku this world has always answered) and
  // lists the agent as running until its turn completes.
  on('agent.spawn', ($, e) => {
    w.spawns.push(e as unknown as Record<string, unknown>)
    const agentId = `spawned-${w.spawns.length}`
    w.agents.push({ id: agentId, description: e.description, type: e.subagentType, status: 'running' })

    return { agentId, model: e.model === undefined ? 'claude-haiku-4-5' : (MODEL_ALIAS[e.model] ?? e.model) }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.list', () => ({ value: w.agents.map(one => ({ ...one })) }))
  on('session.model', () => ({ value: w.model }))
  on('session.authorize', () => { if (w.failAuthorize) throw new Error('authorize unavailable'); return { value: w.credential } })
  on('settings.read', () => ({ value: w.settings }))
  on('config.set', ($, e) => {
    w.configured.push(e.key)

    return { value: e.value }
  })
  on('http.fetch', ($, e) => {
    w.outbound.push(`http.fetch ${e.url}`)

    return { value: { status: 599, headers: {}, body: '' } } as never
  })
  on('model.complete', ($, e) => {
    w.outbound.push(`model.complete ${e.model}`)

    return { value: { reason: 'refused by the test world' } } as never
  })
  on('model.fork', () => {
    w.outbound.push('model.fork')

    return { value: { reason: 'refused by the test world' } } as never
  })
  on('model.classify', () => {
    w.outbound.push('model.classify')

    return { value: undefined }
  })
  on('mcp.call', ($, e) => {
    w.outbound.push(`mcp.call ${String((e as { server?: unknown }).server ?? '')}`)

    return { value: { content: [] } } as never
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  // A model request reaching the engine: recorded, then answered by the model
  // it named unless the test says another one answers.
  on('turn.step', async function* ($, e) {
    w.requests.push({ model: e.model, ...(e.agentId === undefined ? {} : { agentId: e.agentId }) })
    w.efforts.push({ model: e.model, ...(e.effort === undefined ? {} : { effort: e.effort }), ...(e.agentId === undefined ? {} : { agentId: e.agentId }) })
    const usage = { model: w.answersAs ?? e.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    yield { kind: 'text', index: 0, text: 'ok' } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage } as never

    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('session.cwd', () => ({ value: w.cwd }))
  on('tool.register', ($, e) => { w.registered.push({ ...e }); return { value: { tool: `mcp__${PLUGIN}__${e.name}` } } })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.log', ($, e) => {
    if (e.to === 'transcript') w.transcript.push(e.text)

    return { value: undefined }
  })
  on('ui.blit', () => {
    w.blits += 1

    return { value: {} }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('fs.exists', ($, e) => { if (w.failExists) throw new Error(`EIO: ${e.path}`); return { value: e.path in w.files } })
  // `stat` answers from the same map the reads come from, so a test that puts a
  // ledger in `files` gets a size that matches what `read` will hand back.
  on('fs.stat', ($, e) => {
    const text = w.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = w.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    if ((e as { as?: string }).as === 'bytes') return { value: { base64: btoa(String.fromCharCode(...new TextEncoder().encode(text))) } }

    return { value: text }
  })

  // writes land in the same map the reads come from, so a test reads back what the plugin kept
  on('fs.write', ($, e) => { if (w.failWrites) throw new Error('ENOSPC: no space left on device'); w.files[e.path] = e.text; return { value: undefined } })
  on('fs.list', ($, e) => {
    const dir = `${e.path ?? ''}/`
    const names = Object.keys(w.files).filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/')).map(f => f.slice(dir.length))

    return { value: names.map(name => ({ name, kind: 'file' as const, size: w.files[`${dir}${name}`]!.length, mtimeMs: 0, isLink: false })) }
  })

  // v0.6.4: what `stat` sees at one path, without or with -L, as the plugin inspects it before anything is read
  const KIND_MODE: Record<string, number> = { file: 0x81a4, link: 0xa1ff, dir: 0x41ed, fifo: 0x11a4, socket: 0xc1ed, char: 0x21b6, block: 0x61b0 }
  const KIND_OF: Record<number, Kind> = { 0x8000: 'file', 0xa000: 'link', 0x4000: 'dir', 0x1000: 'fifo', 0xc000: 'socket', 0x2000: 'char', 0x6000: 'block' }
  const keyOf = (raw: string): string => { const p = raw.replace(/^\.\//, ''); return p.startsWith(`${w.top}/`) ? p.slice(w.top.length + 1) : p }
  // `untracked` is `w.untracked` as a set, made once per `stat` call: a lookup per path in the list itself made the model quadratic
  const contentOf = (raw: string, untracked: ReadonlySet<string>): string => {
    const bare = raw.replace(/^\.\//, ''), key = keyOf(raw)
    return key.endsWith('info/exclude') ? w.excludes : key.endsWith('info/attributes') ? w.attributes : w.watched[bare] ?? w.watched[key] ?? w.tree[key] ?? (untracked.has(key) ? 'u' : '')
  }
  const inspectOne = (raw: string, follow: boolean, untracked: ReadonlySet<string>): { mode: number; size: number; ino: number; mtime: string } | 'missing' | 'denied' => {
    const bare = raw.replace(/^\.\//, ''), key = keyOf(raw)
    if (w.watchedDenied.includes(raw) || w.watchedDenied.includes(bare)) return 'denied'
    let kind: Kind | undefined = w.kinds[key] ?? w.kinds[bare]
    if (kind === undefined) {
      const m = w.diskModes[key]
      if (m !== undefined) kind = m === 0 ? 'missing' : KIND_OF[m & 0xf000] ?? 'file'
      else if (w.watchedDirs[raw] !== undefined || w.watchedDirs[bare] !== undefined || w.watchedUnreadable.includes(raw) || w.embeddedRepos[`${key}/`] !== undefined) kind = 'dir'
      // as in a new repository: an exclude file, no attributes file (unless a test wrote one), no alternates
      // the session's own `.git` is there with a repository; no parent has one
      else if (key === '.git') kind = (w.dotGitPresent ?? w.gitStatus !== null) ? 'dir' : 'missing'
      else if (key.endsWith('/.git')) kind = 'missing'
      else kind = key.endsWith('objects/info/alternates') || (key.endsWith('info/attributes') && w.attributes === '') ? 'missing' : 'file'
    }
    if (follow && kind === 'link') kind = w.followKinds[key] ?? w.followKinds[bare] ?? 'file'
    if (kind === 'missing') return 'missing'
    const disk = w.diskModes[key]
    const mode = kind === 'file' && disk !== undefined && (disk & 0xf000) === 0x8000 ? disk : KIND_MODE[kind]!
    const size = w.sizes[key] ?? w.sizes[bare] ?? (kind === 'file' ? new TextEncoder().encode(contentOf(raw, untracked)).length : kind === 'link' ? (w.linkTargets[key] ?? 'target').length : 0)
    return { mode, size, ino: w.inodes[key] ?? w.inodes[bare] ?? 1, mtime: w.mtimes[key] ?? w.mtimes[bare] ?? '1.000000000' }
  }
  const PROBES = new Set([BOUND_PROBE_SET(true), BOUND_PROBE_SET(false), BOUND_PROBE_CONTROL, BOUND_PROBE_CAPPED, BOUND_PROBE_GROUP])

  let running = 0
  on('process.run', async ($, e) => {
    if (['mkdir', 'chmod', 'rm', 'stat'].includes(e.argv[0] ?? '') && e.argv.some(a => a.includes('/cobalt-cockpit/telemetry') || a.endsWith('/.local/state/cobalt-cockpit'))) {
      w.telemetryRuns.push([...e.argv])
      if (w.telemetryModes === 'denied') throw new Error('refused by the host')
      if (e.argv[0] === 'stat') return ran(0, `${w.telemetryModes === 'wide' ? '755' : String(e.argv.at(-1)).endsWith('.jsonl') ? '600' : '700'}\n`)

      return ran(0)
    }
    // The limit probes: `full` accepts and enforces every limit, `partial` accepts them but a 64 MiB allocation still succeeds
    // under the 32 MiB cap, `none` has no `sh`.
    if (e.argv[0] === 'sh' && e.argv[1] === '-c' && PROBES.has(String(e.argv[2]))) {
      const script = String(e.argv[2])
      w.boundProbes.push(script)
      if (w.boundMode === 'none') throw new Error('spawn sh ENOENT')
      if (w.boundMode === 'basic' && script === BOUND_PROBE_SET(true)) return ran(2)
      if (w.boundMode === 'flaky' && script === BOUND_PROBE_CAPPED && w.boundProbes.filter(x => x === BOUND_PROBE_CAPPED).length === 1) throw new Error('sh was still running at the timeout')
      if (script === BOUND_PROBE_GROUP) return ran(0, w.groupTimeout ? 'timeout (GNU coreutils) 9.4\n' : '')

      return script === BOUND_PROBE_CAPPED ? ran(w.boundMode === 'partial' ? 0 : 1) : script === BOUND_PROBE_CONTROL ? ran(0) : ran(0, 'set\n')
    }
    // A command started through the limit script is answered as itself; the script is recorded beside it.
    const isWrapped = e.argv[0] === 'sh' && e.argv[1] === '-c' && e.argv[3] === BOUND_TAG
    const argv: readonly string[] = isWrapped ? e.argv.slice(5) : e.argv
    w.runs.push([...argv])
    w.wrappers.push(isWrapped ? String(e.argv[2]) : null)
    w.wrapperSeconds.push(isWrapped ? String(e.argv[4]) : null)
    if (isWrapped) { running++; w.peakRunning = Math.max(w.peakRunning, running) }
    try {
    if (isWrapped) for (let tick = 0; tick < w.runDelayTicks; tick++) await Promise.resolve()
    w.runEnvs.push(e.init?.env)
    if (w.duringRun !== null) await w.duringRun(argv)
    const program = argv[0] ?? ''
    const inspecting = program === 'stat' && ((argv.includes('--printf') && argv[argv.indexOf('--printf') + 1] === INSPECT_GNU) || (argv.includes('-f') && argv[argv.indexOf('-f') + 1] === INSPECT_BSD))
    if (inspecting && w.players['stat'] !== 'fails') {
      const gnu = argv.includes('--printf')
      if ((w.statFlavor === 'gnu') !== gnu) return { value: { exitCode: 1, stdout: '', stderr: gnu ? 'stat: illegal option -- -\n' : 'stat: cannot read file system information\n', isStdoutTruncated: false, isStderrTruncated: false } }
      w.inspectCalls++
      const names = argv.slice(argv.indexOf('--') + 1)
      const untracked = new Set(w.untracked)
      const seen = names.map(n => inspectOne(n, argv.includes('-L'), untracked))
      const errors = names.flatMap((n, k) => (seen[k] === 'missing' ? [`stat: cannot statx '${n}': No such file or directory\n`] : seen[k] === 'denied' ? [`stat: cannot statx '${n}': Permission denied\n`] : []))
      const stdout = seen.map((x, k) => (typeof x === 'string' ? '' : gnu ? `${x.mode.toString(16)} ${x.size} ${x.ino} ${x.mtime} 1.000000000 ${names[k]}\0` : `${x.mode.toString(8)} ${x.size} ${x.ino} ${x.mtime.split('.')[0]} 1\n`)).join('')

      return { value: { exitCode: errors.length > 0 ? 1 : 0, stdout, stderr: errors.join(''), isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (program === 'stat' && w.statFileSystem && (argv.includes('--printf') || (argv.includes('-f') && argv[argv.indexOf('-f') + 1] === '%i %z %m %c %N'))) {
      const names = argv.slice(argv.indexOf('--') + 1)
      if (argv.includes('--printf')) return { value: { exitCode: 1, stdout: '', stderr: `stat: cannot statx '${names[0]}': No such file or directory\n`, isStdoutTruncated: false, isStderrTruncated: false } }

      return ran(0, names.map(n => `  File: "${n}"    ID: 0        Namelen: 255     Type: ext2/ext3\n`).join(''))
    }
    if (program === 'stat' && argv.includes('--printf') && w.players['stat'] !== 'fails') {
      w.statCalls++
      const names = argv.slice(argv.indexOf('--') + 1)

      // the form `%i %s %.9Y %.9Z %n` prints: inode, then the test's `size mtime`, then a change time
      return ran(0, names.map(n => `1 ${w.ignoredFiles[n] ?? w.dirMeta[n] ?? w.ignoredMeta[n] ?? '1 1'} 1.000000000 ${n}\0`).join(''))
    }
    if (program === 'readlink' && w.outputs['readlink'] === undefined) {
      const asked = String(argv.at(-1))
      const text = w.linkTargets[keyOf(asked)] ?? 'target'

      return ran(0, argv.includes('-z') ? `${text}\0` : `${text}\n`)
    }
    // v0.6.6: the preflight's listing of promisor pack markers in the pack directory
    if (program === 'find' && argv.includes('-name') && argv[argv.indexOf('-name') + 1] === '*.promisor') {
      const asked = String(argv[2])
      if (w.packListFails) return { value: { exitCode: 1, stdout: '', stderr: `find: '${asked}': Permission denied\n`, isStdoutTruncated: false, isStderrTruncated: false } }

      return ran(0, w.promisorPacks.map(name => `${asked}/${name}\0`).join(''))
    }
    if (program === 'find') {
      const asked = String(argv[2])
      if (w.watchedUnreadable.includes(asked)) return ran(1, `${(w.watchedDirs[asked] ?? []).slice(0, 1).map(n => `${n}\0`).join('')}`)
      const dir = w.watchedDirs[asked] ?? w.embeddedRepos[`${asked.replace(/^\/work\/example\//, '')}/`]
      if (dir === undefined || w.watchedDenied.includes(asked)) return ran(1)

      return ran(0, dir.map(n => `${n}\0`).join(''))
    }
    if (program === 'stat' && !argv.includes('--printf')) {
      const asked = String(argv.at(-1))
      if (w.watchedUnreadable.includes(asked)) return ran(0, '')
      const why = w.watchedDenied.includes(asked) ? 'Permission denied' : 'No such file or directory'

      return { value: { exitCode: 1, stdout: '', stderr: `stat: cannot statx '${asked}': ${why}\n`, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (program === 'realpath' && w.realpathFails) return { value: { exitCode: 1, stdout: '', stderr: 'realpath: cannot resolve\n', isStdoutTruncated: false, isStderrTruncated: false } }
    if (program === 'realpath') {
      const asked = String(argv.at(-1)).replace(/\/+$/, '')
      const link = Object.keys(w.links).find(from => asked === from || asked.startsWith(`${from}/`))

      return ran(0, (link === undefined ? asked : `${w.links[link]}${asked.slice(link.length)}`) + '\n')
    }
    if (program === 'git') {
      if (w.gitStatus === null) return { value: { exitCode: argv.includes('rev-parse') ? w.notRepositoryExit : 128, stdout: '', stderr: argv.includes('rev-parse') ? w.notRepository : '', isStdoutTruncated: false, isStderrTruncated: false } }

      // global options (--no-optional-locks, --no-replace-objects, -c k=v) and -C <top> come before the subcommand
      let at = 1
      while (at < argv.length) {
        const a = argv[at] as string
        if (a === '-c' || a === '-C') at += 2
        else if (a.startsWith('--no-') || a === '--literal-pathspecs') at += 1
        else break
      }
      const git = argv.slice(at)
      // a subcommand, or a subcommand with one of its options (`ls-files -o`: only the listings that read .gitignore)
      const [hangs, hangsWith] = (w.gitHangs ?? '').split(' ')
      if (w.gitHangs !== null && git[0] === hangs && (hangsWith === undefined || git.includes(hangsWith))) throw new Error('git was still running at the timeout')
      if (w.gitTruncates !== null && git[0] === w.gitTruncates) return { value: { exitCode: 0, stdout: 'cut', stderr: '', isStdoutTruncated: true, isStderrTruncated: false } }
      if (git[0] === 'rev-parse' && git.includes('--git-path')) return ran(0, git.flatMap((a, i) => (a === '--git-path' ? [`${w.gitPathBase}${git[i + 1]}\n`] : [])).join(''))
      // v0.6.6: every configuration entry, as `config --null --list` prints them (key, newline, value, NUL)
      if (git[0] === 'config' && git.includes('--list') && w.configListFails) return ran(1)
      if (git[0] === 'config' && git.includes('--list')) return ran(0, Object.entries(w.gitConfig).map(([key, value]) => `${key}\n${value}\0`).join('') + w.gitFilterConfig)
      if (git[0] === '--version') return ran(0, `${w.gitVersion}\n`)
      if (git[0] === 'config') return git.includes('--get-regexp') && w.gitFilterConfig !== '' ? ran(0, w.gitFilterConfig) : w.gitConfig[git.at(-1)!] !== undefined ? ran(0, w.gitConfig[git.at(-1)!] + '\n') : ran(1)
      if (git[0] === 'check-attr') return ran(0, w.gitFilterAttributes)
      if (git[0] === 'rev-parse' && git.includes('--show-prefix')) return ran(0, w.gitPrefix + '\n')
      if (w.headUnreadable && git[0] === 'rev-parse' && git.includes('--verify') && git.at(-1) === 'HEAD') return { value: { exitCode: 128, stdout: '', stderr: 'fatal: bad object HEAD\n', isStdoutTruncated: false, isStderrTruncated: false } }
      if (w.headUnborn && ((git[0] === 'rev-parse' && git.includes('--verify') && git.at(-1)?.startsWith('HEAD')) || (git[0] === 'ls-tree' && git.at(-1) === 'HEAD'))) return { value: { exitCode: 128, stdout: '', stderr: git[0] === 'rev-parse' ? 'fatal: Needed a single revision\n' : 'fatal: Not a valid object name HEAD\n', isStdoutTruncated: false, isStderrTruncated: false } }
      if (git[0] === 'rev-parse' && git.includes('--verify') && w.nonCommits.some(name => git.at(-1) === `${name}^{commit}`)) return ran(1)
      if (git[0] === 'rev-parse' && git.includes('--verify') && w.gitlinkRevisions.some(name => git.at(-1) === `${name}^{commit}`)) return ran(0, `${GITLINK_COMMIT}\n`)
      if (git[0] === 'ls-tree' && git.at(-1) === GITLINK_COMMIT) return ran(0, `160000 commit ${'c'.repeat(40)}\tvendor/lib\0`)
      if (git[0] === 'rev-parse') return ran(0, git.includes('--verify') ? `${w.head}\n` : `${w.top}\n`)
      if (git[0] === 'diff') {
        // like git, `diff` does not see a path the index is told to ignore (assume-unchanged: lowercase tag; skip-worktree: S)
        const hidden = new Set(w.indexFlags.split('\0').filter(l => l.length > 2 && (/[a-z]/.test(l[0] as string) || l[0] === 'S')).map(l => l.slice(2)))
        const seen = Object.keys(w.tree).filter(path => !hidden.has(path))

        return ran(0, git.includes('--diff-filter=D') ? '' : seen.join('\0') + (seen.length ? '\0' : ''))
      }
      if (git[0] === 'status' && git.includes('--porcelain')) {
        const hardened = argv.includes('--no-replace-objects') && argv.includes('core.fsmonitor=false') && argv.includes('core.untrackedCache=false')

        const answer = ran(0, w.uncommitted && !(w.statusHidden && !hardened) ? ' M src/api.js\n' : '')
        answer.value.stderr = w.statusWarning
        answer.value.isStderrTruncated = w.statusStderrTruncated
        return answer
      }
      // v0.6.6: the index's stage entries: the committed paths with their modes, and any gitlink staged in the index only
      if (git[0] === 'ls-files' && git.includes('--stage')) {
        const oidOf = (value: string | undefined) => (value !== undefined && /^[0-9a-f]{40}$/.test(value) ? value : 'e'.repeat(40))
        const committed = Object.keys(w.headBlobs).map(path => `${w.headModes[path] ?? '100644'} ${oidOf(w.headBlobs[path])} 0\t${path}\0`)

        return ran(0, [...committed, ...w.indexGitlinks.map(path => `160000 ${'c'.repeat(40)} 0\t${path}\0`)].join(''))
      }
      if (git[0] === 'ls-files' && git.includes('-o') && w.lsFilesWarning !== null) {
        const out = git.includes('-i') ? w.ignoredEntries : w.untracked

        return { value: { exitCode: 0, stdout: out.join('\0') + (out.length ? '\0' : ''), stderr: w.lsFilesWarning, isStdoutTruncated: false, isStderrTruncated: false } }
      }
      if (git[0] === 'ls-files' && git.includes('-i') && (Object.keys(w.ignoredFiles).length > 0 || Object.keys(w.embeddedRepos).length > 0)) {
        const excluded = git.filter(a => a.startsWith(':(exclude)')).map(a => a.slice(10))
        const files = Object.keys(w.ignoredFiles).filter(f => !excluded.some(x => f.startsWith(x)))
        const listed = git.includes('--directory') ? [...new Set(files.map(f => (f.includes('/') ? `${f.slice(0, f.indexOf('/'))}/` : f)))] : files

        return ran(0, [...listed, ...Object.keys(w.embeddedRepos), ...w.ignoredEntries].join('\0') + '\0')
      }
      if (git[0] === 'hash-object' && git.slice(git.indexOf('--') + 1).some(p => w.watchedDirs[p] !== undefined || w.watchedDenied.includes(p))) return ran(128)
      if (git[0] === 'ls-files') return ran(0, git.includes('-m') ? w.statDirty.join('\0') + (w.statDirty.length ? '\0' : '') : git.includes('-i') ? w.ignoredEntries.join('\0') + (w.ignoredEntries.length ? '\0' : '') : git.includes('-v') ? w.indexFlags : git.includes('-o') ? w.untracked.join('\0') + (w.untracked.length ? '\0' : '') : w.indexFlags.split('\0').filter(Boolean).map(entry => entry.slice(2)).join('\0') + (w.indexFlags ? '\0' : ''))
      if (git[0] === 'ls-tree') {
        const names = git.includes('--full-tree') ? Object.keys(w.headBlobs) : git.slice(git.indexOf('--') + 1)

        return ran(0, names.filter(n => w.headBlobs[n] !== undefined).map(n => `${w.headModes[n] ?? '100644'} ${w.headModes[n] === '160000' ? 'commit' : 'blob'} ${w.headBlobs[n]}\t${n}\0`).join(''))
      }
      if (git[0] === 'hash-object' && git.includes('--stdin')) return ran(0, blobOf(e.init?.stdin ?? '') + '\n')
      if (git[0] === 'hash-object') return ran(0, git.slice(git.indexOf('--') + 1).map(raw => {
        const path = raw.replace(/^\.\//, '')
        const contents = path.endsWith('info/exclude') ? w.excludes : path.endsWith('info/attributes') ? w.attributes : (!git.includes('--no-filters') && w.normalized[path] !== undefined ? w.normalized[path]! : w.watched[path] ?? w.tree[path] ?? (w.untracked.includes(path) ? 'u' : ''))
        return blobOf(contents)
      }).join('\n') + '\n')

      return ran(0, w.gitStatus)
    }
    const output = w.outputs[program]
    if (output !== undefined) return ran(0, output(argv))
    const behavior = w.players[program] ?? 'missing'
    if (behavior === 'missing') throw new Error(`spawn ${program} ENOENT`)
    if (behavior === 'hangs') throw new Error(`${program} was still running at the timeout`)

    return ran(behavior === 'ok' ? 0 : 1)
    } finally {
      if (isWrapped) running--
    }
  })

  // the engine's own drawing, where the plugin draws nothing or wraps it
  on('ui.render', ($, e) => {
    // a dialog is the engine's to draw: one engine node, which a hook may wrap
    if (e.component === 'AskUserQuestion') return { type: 'engine', ref: 1 }
    const { Box, Text } = $.ui.resolve(e)

    return Box({ children: [Text({ children: `engine:${e.component}` })] })
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => {
    w.submitted.push({ text: e.text, context: e.context ?? [] })

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => {
    // a subagent whose turn ended is no longer running
    const agent = w.agents.find(one => one.id === e.agentId)
    if (agent !== undefined) agent.status = e.reason === 'answer' ? 'completed' : 'failed'

    return { text: e.answer }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  on('attribution.text', ($, e) => ({ text: e.text }))
  on('command.run', () => ({ text: '' }))
  on('classic.PostToolUse', () => ({}))
  on('classic.Stop', () => ({}))
  on('ui.notify', ($, e) => {
    w.notified.push({ text: e.text, title: e.title })
    if (w.duringNotify !== undefined) { const act = w.duringNotify; delete w.duringNotify; return act().then(() => (w.notifyMode === 'disabled' ? { value: { isSent: false as const, reason: 'disabled' as const } } : { value: { isSent: true as const, channel: 'kitty' as const } })) }
    if (w.notifyMode === 'throws') throw new Error('notification write failed')

    return { value: w.notifyMode === 'disabled' ? { isSent: false as const, reason: 'disabled' as const } : { isSent: true as const, channel: w.notifyChannel ?? ('kitty' as const) } }
  })

  on('tool.call', async ($, e) => {
    const call = e as unknown as Record<string, unknown>
    w.ran.push(call)
    if (w.duringToolCall !== null) await w.duringToolCall(call)
    if (e.tool === 'AskUserQuestion') {
      const question = String((call['questions'] as { question: string }[])[0]?.question ?? '')
      w.asked.push(question)
      if (w.whileAsked !== null) await w.whileAsked(question)
      if (w.answer === null) return { deny: 'The user dismissed the question.' }

      return { result: { questions: call['questions'], answers: { [question]: w.answer } } } as never
    }
    if (e.tool === 'Bash') {
      const command = String(call['command'] ?? '')
      if (w.failing !== null && w.failing.test(command)) {
        return { isError: true, result: 'Exit code 1', text: 'Exit code 1' } as never
      }

      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    }
    if (w.failingTools.includes(e.tool)) return { isError: true, result: 'The tool reported an error', text: 'The tool reported an error' } as never
    if (e.tool === 'Write' && !(String(call['file_path']) in w.files)) {
      return { result: { type: 'create', filePath: call['file_path'], content: call['content'], structuredPatch: [] } } as never
    }
    if (e.tool === 'Edit' || e.tool === 'Write') {
      return {
        result: { filePath: call['file_path'], structuredPatch: [{ lines: [' same', '+added one', '+added two', '-removed'] }] },
      } as never
    }

    return { result: {} } as never
  })

  return w
}

export const start = ($: Engine) => $.session.start({ cwd: '/work/example', surface: 'terminal', isInteractive: true })

export const prompt = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

/** One call of the progress tool, answered with its text. */
export const progress = async ($: Engine, input: Record<string, unknown>): Promise<string> => {
  const answer = await $.tool.call({ tool: TOOL, ...input } as never)

  return String((answer as { result?: unknown }).result ?? '')
}

export const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)

const band = (columns: number, isWorking: boolean) => ({
  plugin: PLUGIN,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking,
    maxRows: 12,
    bodyColumns: columns,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
  viewport: { columns, rows: 40, isFullscreen: true },
})

/** Mounts the HUD on a surface at a width. */
export const mountHud = ($: Engine, surface: 'terminal' | 'desktop', columns = 120, isWorking = false) =>
  $.ui.mount({ ...band(columns, isWorking), surface })

/** Mounts the Mission Control pane. */
export const mountPane = ($: Engine, surface: 'terminal' | 'desktop', columns = 80) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PLUGIN,
    props: {
      title: 'Cockpit',
      isFocused: false,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
    viewport: { columns: columns + 40, rows: 40, isFullscreen: true },
  })

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string

const textOfNode = (node: unknown): string => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node === null || typeof node !== 'object') return ''
  const element = node as Exclude<Node, string>
  if (element.type === 'Raster') {
    const cells = Uint8Array.from(atob(String(element.props?.['cells'] ?? '')), c => c.charCodeAt(0))
    const view = new DataView(cells.buffer)
    return Array.from({ length: cells.length / 12 }, (_, i) => String.fromCodePoint(view.getUint32(i * 12, true))).join('')
  }
  if (element.type === 'Svg') return element.props?.['isInteractive'] ? '' : String(element.props?.['alt'] ?? '').split(' ')[0]?.slice(0, Math.floor(Number(element.props?.['width'] ?? 0) / 8)) ?? ''

  const children = element.children ?? (element.props?.['children'] as unknown[] | undefined) ?? []

  return (Array.isArray(children) ? children : [children]).map(textOfNode).join('')
}

/** Every element in the drawing, depth first, for assertions `find` cannot make. */
export const elementsOf = async (ui: { drawn: () => Promise<unknown> }): Promise<Exclude<Node, string>[]> => {
  const out: Exclude<Node, string>[] = []
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const element = node as Exclude<Node, string>
    if (element.type !== undefined) out.push(element)
    for (const child of element.children ?? (element.props?.['children'] as unknown[] | undefined) ?? []) walk(child)
  }
  walk(await ui.drawn())

  return out
}

/** The one element of `type` a drawing carries, or undefined. */
export const elementOf = async (ui: { drawn: () => Promise<unknown> }, type: string, at = 0): Promise<Exclude<Node, string> | undefined> =>
  (await elementsOf(ui)).filter(one => one.type === type)[at]

/**
 * The foreground colour of the middle cell of the operator's badge, as the
 * `0x00RRGGBB` a Raster cell carries: what state the badge is painted in.
 */
export const badgeLitOf = async (ui: { drawn: () => Promise<unknown> }): Promise<number> => {
  const tree = (await ui.drawn()) as Exclude<Node, string>
  const find = (node: unknown): (Exclude<Node, string> & { props: Record<string, unknown> }) | undefined => {
    if (node === null || typeof node !== 'object') return undefined
    const element = node as Exclude<Node, string> & { props: Record<string, unknown> }
    if (element.type === 'Raster' && element.props['key'] === 'operator') return element
    for (const child of element.children ?? (element.props?.['children'] as unknown[] | undefined) ?? []) {
      const hit = find(child)
      if (hit !== undefined) return hit
    }

    return undefined
  }
  const badge = find(tree)
  const cells = Uint8Array.from(atob(String(badge?.props['cells'] ?? '')), c => c.charCodeAt(0))

  // cell layout is [codePoint, foreground, background]; the visor is cell one
  return new DataView(cells.buffer).getUint32(3 * 4 + 4, true)
}

/**
 * The engine's own drawing for a component, as the mock hands it back.
 *
 * `AbovePrompt` is documented as a band where "the engine draws nothing of its
 * own here", so in a real session `next(e)` resolves to nothing and Cockpit
 * simply keeps it. The mock still resolves it to a labelled sentinel row, which
 * `rowsOf` drops so a test reads Cockpit's rows and not the mock's marker.
 */
const isEngineSentinel = (node: unknown): boolean => typeof node === 'object' && node !== null && textOfNode(node) === 'engine:AbovePrompt'

/** The drawing as rows of text: one string per row Box or line; a Raster reads as `~`. */
export const rowsOf = async (ui: { drawn: () => Promise<unknown> }): Promise<string[]> => {
  const tree = (await ui.drawn()) as Exclude<Node, string>
  const children = tree.children ?? (tree.props?.['children'] as unknown[] | undefined) ?? []

  return (Array.isArray(children) ? children : [children]).filter(child => !isEngineSentinel(child) && !isFlowRow(child)).map(textOfNode)
}

/** The Neural Flow row, a Raster on a terminal and a text row elsewhere: read apart from the rows the older tests were written about. */
const isFlowRow = (node: unknown): boolean => {
  if (typeof node !== 'object' || node === null) return false
  const element = node as { key?: unknown; props?: Record<string, unknown> }
  if (['neural-flow', 'flow-text'].includes(String(element.props?.['key'] ?? element.key))) return true

  // a row of text carries no key the mock keeps: it is known by what it draws, a node glyph first and the braille edge after it
  const text = textOfNode(node)

  return /^[●○◉◎✕⊘] /.test(text) && /[⠶⠤]/.test(text)
}
export const flowRowsOf = async (ui: { drawn: () => Promise<unknown> }): Promise<string[]> => {
  const tree = (await ui.drawn()) as Exclude<Node, string>
  const children = tree.children ?? (tree.props?.['children'] as unknown[] | undefined) ?? []

  return (Array.isArray(children) ? children : [children]).filter(isFlowRow).map(textOfNode)
}

/**
 * The Activity Field as text: one string per row of its Raster, or its SVG's
 * alt when the surface has no Raster. The field is the first thing above the
 * HUD, so this reads the drawing element-by-element rather than by row index,
 * which keeps the assertion honest on either surface.
 */
export const fieldRowsOf = async (ui: { drawn: () => Promise<unknown> }): Promise<string[]> => {
  const drawn = await elementsOf(ui)
  const field = drawn.find(one => one.props?.['key'] === 'activity-field')
  if (field?.type !== 'Raster') return [String(field?.props?.['alt'] ?? '')]
  const columns = Number(field.props?.['columns'] ?? 0)
  const rows = Number(field.props?.['rows'] ?? 1)
  const cells = Uint8Array.from(atob(String(field.props?.['cells'] ?? '')), c => c.charCodeAt(0))
  const view = new DataView(cells.buffer)

  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, col) => String.fromCodePoint(view.getUint32((row * columns + col) * 12, true))).join(''),
  )
}

/** The Bash commands that reached the engine: what actually ran. */
export const commandsRun = (w: World): string[] =>
  w.ran.filter(call => call['tool'] === 'Bash').map(call => String(call['command']))

/** How many times a cue's file was handed to a player. */
export const plays = (w: World, cue: 'checkpoint' | 'complete'): string[][] =>
  w.runs.filter(argv => argv.some(arg => arg.endsWith(`assets/sounds/${cue}.wav`)))

/**
 * State the host already holds when the module loads: what a hot reload
 * finds. Answers `$.state` beneath the plugin from a map seeded with it.
 */
export const hostState = (on: On, seed: Record<string, unknown>, faults: { get?: (key: string) => boolean; set?: (key: string) => boolean } = {}): Map<string, { value: unknown; version: number }> => {
  const held = new Map(Object.entries(seed).map(([key, value]) => [key, { value, version: 1 }]))
  on('state.get', ($, e) => {
    if (faults.get?.(e.key)) throw new Error('injected state read failure')
    const one = held.get(e.key)

    return { value: { value: one?.value, version: one?.version ?? 0 } } as never
  })
  on('state.set', ($, e) => {
    const write = e as unknown as { key: string; value: unknown; ifVersion?: number }
    const standing = held.get(write.key)?.version ?? 0
    if (faults.set?.(e.key)) return { value: { isSet: false, version: standing } } as never
    if (write.ifVersion !== undefined && write.ifVersion !== standing) {
      return { value: { isSet: false, version: standing } } as never
    }
    held.set(write.key, { value: write.value, version: standing + 1 })

    return { value: { isSet: true, version: standing + 1 } } as never
  })

  return held
}

/** The id the test world's `hash-object` gives a file with this content, for seeding `headBlobs`. */
export const blobOf = (content: string): string => [...content].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(40, '0')

export const command = ($: Engine, args: string) =>
  $.command.run({ command: 'cockpit', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

export const FIVE = ['Inspect', 'Implement', 'Test', 'Fix', 'Verify'].map(title => ({ title }))
export const GATE_NAMES = ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT'] as const

/** Plans the usual five milestones and completes the first `done` of them. */
export const planAndComplete = async ($: Engine, done: number): Promise<string> => {
  let last = await progress($, { action: 'plan', milestones: FIVE })
  for (let n = 1; n <= done; n++) last = await progress($, { action: 'complete', milestone: `m${n}` })

  return last
}

/**
 * Passes every gate. Unless `align` is false it also records one acceptance criterion and its evidence, which is what STANDARD
 * and DEEP work needs before it can read DONE. Both are refused, and change nothing, while milestones before verification are open.
 */
export const passAllGates = async ($: Engine, options: { align?: boolean } = {}): Promise<void> => {
  for (const gate of GATE_NAMES) await progress($, { action: 'gate', gate, state: 'pass', evidence: `${gate} verified` })
  if (options.align === false) return
  await progress($, { action: 'discover', criteria: ['The fixture behaviour is accepted'] })
  await progress($, { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "fixture test 'acceptance' passes in fixture.test.ts (1 pass)" }] } })
}
