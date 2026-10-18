// v0.6.6 Stage A: Git hardening. A submodule's own configuration can make a superproject's status or diff run a program, and a
// lazy fetch in a partial clone runs the remote's transport (both recorded on real Git). Here, through the host: such a repository
// is refused before any Git command that could enter or fetch, at every entry point that measures, and a refusal is never a clean
// tree, an accepted goal check, a verified Stop check, a release candidate or a helper's inspection. The runner admits a Git read
// of repository state only with the check's pass, every Git process carries the lazy-fetch and protocol pins, and fingerprints of
// ordinary repositories are the ones v0.6.5 took. What real Git does with these argv is for the approved real-Git acceptance.
import { describe, expect, test } from 'claude-code/testing'
import { BOUND_PINS, BOUND_PROGRAMS, GIT_ENV_REFUSED, GIT_SAFE, HELPER_PINS, IGNORED_BSD, IGNORED_GNU, INSPECT_BSD, INSPECT_GNU, REPO_REFUSAL_SHORT, REPO_REFUSAL_WORDS, TRACKED_LIMIT, filterRecordsOf, gitAccessOf, gitCallOf, gitVersionOf, nonGitAdmitted, partialCloneOf, promisorPacksOf, stageGitlinks } from '../hooks/git-integrity'
import { checkpointOf, emptyLedger, UNKNOWN } from '../hooks/ledger'
import { filterCommands } from '../hooks/git'
import type { RepoRefusal } from '../hooks/git-integrity'
import { dirtyLabel, refusedReason, treeNeedsAttention } from '../hooks/git'
import { gitVersionText } from '../hooks/doctor'
import type { GitState, Task } from '../types'
import { blobOf, command, FIVE, GATE_NAMES, HELPER_START, hostState, mountHud, passAllGates, planAndComplete, progress, prompt, rowsOf, start, world } from './world'
import type { World } from './world'

type Engine = Parameters<typeof start>[0]
const SCRIPT = '/work/check.sh'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 3, ...extra } })
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Changed the parser to reject empty input and added a regression test.' }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const fixture = (on: any) => {
  const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
  return { w, h: hostState(on, {}) }
}
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')?.value as Task | null | undefined
const gitOf = (h: ReturnType<typeof hostState>) => h.get('git')?.value as GitState | null | undefined
const kept = (h: ReturnType<typeof hostState>) => ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: { complete: boolean; summary: string }[] }).stopChecks ?? []
/** The Git subcommands run since `from`, after Cockpit's global options. */
const subcommands = (w: World, from = 0): string[] => w.runs.slice(from).filter(r => r[0] === 'git').map(r => {
  let at = 1
  while (r[at] === '-c' || r[at] === '-C' || r[at] === '--no-optional-locks' || r[at] === '--no-replace-objects' || r[at] === '--literal-pathspecs') at += r[at] === '-c' || r[at] === '-C' ? 2 : 1
  return r[at]!
})
/** One turn of the event loop: the HUD refresh a session start does not wait for has landed by then (v0.6.6 Stage B). */
const settled = () => new Promise<void>(resolve => { (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(resolve, 0) })
/** What reads a repository's work tree, index or objects beyond the refusal check's own listings. */
const READS_STATE = ['status', 'diff', 'hash-object', 'check-attr', 'ls-tree']

// --- the runner's admission and the refusal check's parsers (pure) ---

describe('the runner admits Git commands by form', () => {
  // v0.6.6 Stage B: by exact form (before: any GIT_SAFE setting in any order, and any arguments for an admitted subcommand)
  const R = '/r'
  const git = (...words: string[]) => ['git', ...GIT_SAFE, ...words]
  test('the words before the subcommand are GIT_SAFE, word for word, then at most one absolute -C', () => {
    expect(gitCallOf(git('-C', R, 'status'))).toEqual({ sub: 'status', args: [], dir: R })
    expect(gitCallOf(git('rev-parse', '--show-toplevel'))).toEqual({ sub: 'rev-parse', args: ['--show-toplevel'], dir: null })
    expect(gitCallOf(['git', '--version'])).toEqual({ sub: '--version', args: [], dir: null })
    const [first, ...rest] = GIT_SAFE
    for (const argv of [
      ['git'], ['env', 'git', 'status'], ['/usr/bin/git', 'status'], ['git', '-C', R, 'status'], ['git', 'status'],
      // GIT_SAFE incomplete, reordered, with one setting changed or one more added
      ['git', ...rest, '-C', R, 'status'], ['git', ...rest, first!, '-C', R, 'status'], git('-c', 'core.fsmonitor=false', '-C', R, 'status'),
      ['git', ...GIT_SAFE.map(word => (word === 'diff.ignoreSubmodules=all' ? 'diff.ignoreSubmodules=none' : word)), '-C', R, 'diff'],
      git('-c', 'alias.x=!sh', 'x'), git('--git-dir=/x', 'status'), git('--exec-path=/x', 'status'), git('--no-pager', 'status'),
      git('-C', R, '-C', '/b', 'status'), git('-C', '', 'status'), git('-C', 'relative', 'status'), git('-C', './r', 'status'), git('-C'), git(), ['git', '--version', 'x'],
    ]) expect([argv, gitCallOf(argv)]).toEqual([argv, null])
  })
  test('every form Cockpit writes is admitted, with what it reads', () => {
    const access = (...words: string[]) => { const call = gitCallOf(git(...words)); return call === null ? 'not a call' : gitAccessOf(call) }
    const discovery = [
      ['rev-parse', '--show-toplevel'], ['rev-parse', '--show-prefix'],
      ['-C', R, 'rev-parse', '--git-path', 'info/exclude', '--git-path', 'info/attributes', '--git-path', 'objects/info/alternates'], ['-C', R, 'rev-parse', '--git-path', 'objects/pack'], ['-C', R, 'rev-parse', '--verify', 'HEAD'],
      ['-C', R, 'config', '--null', '--list'], ['-C', R, 'config', '--type=path', '--get', 'core.excludesFile'], ['-C', R, 'config', '--type=path', '--get', 'core.attributesFile'],
      ['-C', R, 'config', '--bool', '--get', 'core.symlinks'], ['-C', R, 'config', '--bool', '--get', 'core.filemode'],
    ]
    for (const words of discovery) expect([words, access(...words)]).toEqual([words, 'discovery'])
    expect(gitAccessOf(gitCallOf(['git', '--version'])!)).toBe('discovery')
    for (const words of [['-C', R, 'ls-files', '-z', '--stage'], ['-C', R, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'], ['-C', R, 'ls-tree', '-r', '-z', '--full-tree', 'a'.repeat(40)], ['-C', R, 'ls-tree', '-r', '-z', '--full-tree', 'b'.repeat(64)]]) expect([words, access(...words)]).toEqual([words, 'listing'])
    const state = [
      ['rev-parse', '--verify', '--quiet', 'main^{commit}'], ['rev-parse', '--verify', '--quiet', 'origin/release-1.2~3^{commit}'],
      ['ls-files', '-z'], ['ls-files', '-v', '-z'], ['ls-files', '-o', '--exclude-standard', '-z'], ['ls-files', '-o', '-i', '--exclude-standard', '-z', '--', '.'], ['ls-files', '-o', '-i', '--exclude-standard', '-z', '--', '.', ':(exclude)dist/', ':(exclude).cache/'],
      ['check-attr', '-z', '--stdin', 'filter'],
      ['hash-object', '--no-filters', '--stdin'], ['hash-object', '--no-filters', '--', './a', '/w/b', '.git/info/exclude'], ['hash-object', '--', './a'],
      ['diff', 'HEAD', '-O/dev/null', '--no-renames', '--ignore-submodules=all', '--name-only', '-z', '--diff-filter=d'], ['diff', 'a'.repeat(40), '-O/dev/null', '--no-renames', '--ignore-submodules=all', '--name-only', '-z', '--diff-filter=D'],
      ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all'], ['status', '--porcelain=v2', '--branch', '--ignore-submodules=all'],
    ]
    for (const words of state) expect([words, access('-C', R, ...words)]).toEqual([words, 'state'])
  })
  test('anything else is refused, the forms next to Cockpit\'s own included', () => {
    // a command that is no Git call the runner knows (gitCallOf null) is refused as well
    const access = (...words: string[]) => { const call = gitCallOf(git(...words)); return call === null ? 'refused' : gitAccessOf(call) }
    for (const words of [
      // finding the repository runs in the session directory; everything else names the repository with -C
      ['-C', R, 'rev-parse', '--show-toplevel'], ['rev-parse', '--verify', 'HEAD'], ['config', '--null', '--list'], ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all'], ['-C', R, '--version'],
      ['-C', R, 'rev-parse', '--verify', 'HEAD^{commit}'], ['-C', R, 'rev-parse', '--verify', 'main'], ['-C', R, 'rev-parse'], ['-C', R, 'rev-parse', '--git-path', 'x'], ['-C', R, 'rev-parse', '--show-toplevel', '--show-prefix'],
      ['-C', R, 'rev-parse', '--verify', '--quiet', '-x^{commit}'], ['-C', R, 'rev-parse', '--verify', '--quiet', 'a:b^{commit}'], ['-C', R, 'rev-parse', '--verify', '--quiet', 'a b^{commit}'], ['-C', R, 'rev-parse', '--verify', '--quiet', 'a..b^{commit}'],
      ['-C', R, 'config', '--null', '--get-regexp', '^filter\\..*\\.(clean|process)$'], ['-C', R, 'config', '--type=path', '--get', 'core.hooksPath'], ['-C', R, 'config', '--bool', '--get', 'core.bare'], ['-C', R, 'config', '--get', 'core.excludesFile'],
      ['-C', R, 'config', '--add', 'a', 'b'], ['-C', R, 'config', '--file', '/x', '--get', 'a'], ['-C', R, 'config', '--null', '--list', '--show-origin'], ['-C', R, 'config', '--unset', 'a'],
      ['-C', R, 'ls-files', '-z', '--stage', '--', 'x'], ['-C', R, 'ls-files'], ['-C', R, 'ls-files', '-z', '-v'], ['-C', R, 'ls-files', '-o', '-z'], ['-C', R, 'ls-files', '--recurse-submodules', '-z'],
      ['-C', R, 'ls-files', '-o', '-i', '--exclude-standard', '-z', '--', '.', 'x'], ['-C', R, 'ls-files', '-o', '-i', '--exclude-standard', '-z', '--', '.', ':(exclude)'],
      ['-C', R, 'ls-tree', '-r', '-z', '--full-tree', 'main'], ['-C', R, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD~1'], ['-C', R, 'ls-tree', '-r', '-z', 'HEAD'], ['-C', R, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', 'a'],
      ['-C', R, 'check-attr', '-z', '--stdin', 'diff'], ['-C', R, 'check-attr', '-a', '--stdin'], ['-C', R, 'check-attr', '-z', '--stdin', 'filter', 'x'],
      ['-C', R, 'hash-object', '-w', '--', 'a'], ['-C', R, 'hash-object', '--no-filters', '-w', '--', 'a'], ['-C', R, 'hash-object', '--no-filters', '--'], ['-C', R, 'hash-object', '--'], ['-C', R, 'hash-object', 'a'],
      ['-C', R, 'hash-object', '-t', 'commit', '--', 'a'], ['-C', R, 'hash-object', '--stdin'], ['-C', R, 'hash-object', '--no-filters', '--stdin', '-w'], ['-C', R, 'hash-object', '--', ''],
      ['-C', R, 'diff', 'HEAD'], ['-C', R, 'diff', 'main', '-O/dev/null', '--no-renames', '--ignore-submodules=all', '--name-only', '-z', '--diff-filter=d'],
      ['-C', R, 'diff', 'HEAD', '-O/dev/null', '--no-renames', '--ignore-submodules=all', '--name-only', '-z', '--diff-filter=d', '--output=/tmp/x'],
      ['-C', R, 'diff', 'HEAD', '-O/dev/null', '--no-renames', '--ignore-submodules=none', '--name-only', '-z', '--diff-filter=d'], ['-C', R, 'diff', 'HEAD', '-O/dev/null', '--no-renames', '--ignore-submodules=all', '--ext-diff', '-z', '--diff-filter=d'],
      ['-C', R, 'diff', '--output=/tmp/x', '-O/dev/null', '--no-renames', '--ignore-submodules=all', '--name-only', '-z', '--diff-filter=d'],
      ['-C', R, 'status', '--porcelain'], ['-C', R, 'status', '--porcelain', '--untracked-files=all'], ['-C', R, 'status', '--porcelain=v2', '--branch'], ['-C', R, 'status', '--porcelain=v2', '--branch', '--ignore-submodules=all', '--', 'x'],
      ['-C', R, 'cat-file', '--batch-check'], ['-C', R, 'fetch'], ['-C', R, 'submodule', 'update'], ['-C', R, 'gc'], ['-C', R, 'log', '-p'], ['-C', R, 'show', 'HEAD'], ['-C', R, 'grep', 'x'],
    ]) expect([words, access(...words)]).toEqual([words, 'refused'])
  })
  test('the other measurement programs: only the forms Cockpit writes', () => {
    for (const argv of [
      ['stat', '--printf', INSPECT_GNU, '--', './a', '/w/b'], ['stat', '-L', '--printf', INSPECT_GNU, '--', 'a'], ['stat', '-f', INSPECT_BSD, '--', 'a'], ['stat', '-L', '-f', INSPECT_BSD, '--', 'a'],
      ['stat', '--printf', IGNORED_GNU, '--', 'a', 'b'], ['stat', '-f', IGNORED_BSD, '--', 'a'], ['stat', '--', '/w/dir'],
      ['readlink', '-z', '--', './a'], ['readlink', './a'], ['readlink', '/w/a'], ['realpath', '-e', '--', '/a'], ['realpath', '-m', '--', '/a/not/yet'],
      ['find', '-H', '/w/dir', '(', '-type', 'f', '-o', '-type', 'l', ')', '-print0'], ['find', '-H', './.git/objects/pack', '-maxdepth', '1', '-name', '*.promisor', '-print0'],
    ]) expect([argv, nonGitAdmitted(argv)]).toEqual([argv, true])
    for (const argv of [
      ['stat', '--printf', '%s', '--', 'a'], ['stat', '-L', '--printf', IGNORED_GNU, '--', 'a'], ['stat', '-L', '--', 'a'], ['stat', '--printf', INSPECT_GNU, '--'], ['stat', '--printf', INSPECT_GNU, 'a'], ['stat', '--', 'a', 'b'], ['stat', '-c', '%a', 'a'], ['stat', '--', ''],
      ['readlink', 'a'], ['readlink', '-f', 'a'], ['readlink', '-z', 'a'], ['readlink', '-z', '--', 'a', 'b'], ['realpath', '-m', '--', 'relative'], ['realpath', '-e', '--', 'relative'], ['realpath', '-s', '--', '/a'], ['realpath', '-e', '/a'], ['realpath', '-e', '--', '/a', '/b'],
      ['find', '-H', '/w', '-exec', 'sh', '{}', ';'], ['find', '/w', '-print0'], ['find', '-H', '-delete'], ['find', '-H', '/w', '-maxdepth', '1', '-name', '*.promisor', '-fprint', '/tmp/x'],
      ['find', '-H', '/w', '(', '-type', 'f', '-o', '-type', 'l', ')', '-print0', '-delete'], ['sh', '-c', 'x'], ['tail', '-c', '1', 'a'], ['git', 'status'],
    ]) expect([argv, nonGitAdmitted(argv)]).toEqual([argv, false])
  })
  test('the measurement programs are exactly the five that measure', () => {
    expect([...BOUND_PROGRAMS].sort()).toEqual(['find', 'git', 'readlink', 'realpath', 'stat'])
  })
})

describe('the refusal check reads strictly', () => {
  test('a partial clone, from every configuration form; doubt counts as partial', () => {
    const list = (...records: string[]) => records.map(r => `${r}\0`).join('')
    expect(partialCloneOf('')).toBe(false)
    expect(partialCloneOf(list('core.bare\nfalse', 'remote.origin.url\nhttps://example.invalid/r.git', 'remote.origin.promisor\nfalse', 'remote.up.promisor\nNo', 'remote.x.promisor\nOFF', 'remote.y.promisor\n0'))).toBe(false)
    for (const value of ['true', 'yes', 'on', '1', '1k', '', 'TRUE', 'maybe']) expect([value, partialCloneOf(list(`remote.origin.promisor\n${value}`))]).toEqual([value, true])
    expect(partialCloneOf(list('remote.origin.promisor'))).toBe(true)                                // a key with no value is true
    expect(partialCloneOf(list('remote.origin.promisor\nfalse', 'remote.origin.promisor\ntrue'))).toBe(true)
    expect(partialCloneOf(list('extensions.partialclone\norigin'))).toBe(true)
    expect(partialCloneOf(list('extensions.partialClone'))).toBe(true)
    expect(partialCloneOf(list('remote.Origin.partialCloneFilter\nblob:none'))).toBe(true)
    expect(partialCloneOf(list('remote.a.b.c.promisor\ntrue'))).toBe(true)                           // a subsection with dots
    for (const bad of ['remote.origin.promisor\ntrue', 'core.bare\nfalse\0\0', '\0', 'not a key\nx\0', '.x\ny\0']) expect([bad, partialCloneOf(bad)]).toEqual([bad, null])
  })
  test('gitlinks in the index\'s stage entries; anything malformed or past the limit is no answer', () => {
    const oid = 'a'.repeat(40)
    expect(stageGitlinks('')).toBe(0)
    const records = (...r: string[]) => r.map(x => `${x}\0`).join('')
    expect(stageGitlinks(records(`100644 ${oid} 0\tsrc/a.ts`, `120000 ${oid} 0\tlink`))).toBe(0)
    expect(stageGitlinks(records(`100644 ${oid} 0\tsrc/a.ts`, `160000 ${oid} 0\tvendor/lib`, `160000 ${'b'.repeat(64)} 0\tsub two`))).toBe(2)
    expect(stageGitlinks(`100644 ${oid} 2\tconflict\0`)).toBe(0)
    expect(stageGitlinks(records(`100644 ${oid} 0\tname with spaces\nand a newline`, `160000 ${oid} 3\tx`))).toBe(1)
    for (const bad of [`100644 ${oid} 0\tsrc/a.ts`, `100644 ${oid}\tsrc/a.ts\0`, `10064 ${oid} 0\ta\0`, `100644 ${oid} 0\t\0`, `100644 xyz 0\ta\0`, `100644 ${oid} 4\ta\0`,
      `100648 ${oid} 0\ta\0`, `100644 ${oid}a 0\ta\0`, `100644 ${'a'.repeat(39)} 0\ta\0`, `100644 ${'a'.repeat(65)} 0\ta\0`, `100644 ${oid.toUpperCase()} 0\ta\0`, `100644  ${oid} 0\ta\0`, `100644 ${oid} 0 a\0`, `100644 ${oid} 0\ta\0\0`, `\0`]) expect([bad, stageGitlinks(bad)]).toEqual([bad, null])
    expect(stageGitlinks(Array.from({ length: TRACKED_LIMIT + 1 }, (_, i) => `100644 ${oid} 0\tf${i}\0`).join(''))).toBeNull()
  })
  test('the filter drivers come from the one configuration listing, in the form the filter check reads', () => {
    const list = ['core.bare\nfalse', 'filter.lfs.clean\ngit-lfs clean -- %f', 'filter.lfs.process\ngit-lfs filter-process', 'filter.Hide.clean\nprintf x', 'filter.dormant.smudge\ncat', 'filter.empty.clean\n'].map(r => `${r}\0`).join('')
    expect([...filterCommands(filterRecordsOf(list))!].sort()).toEqual(['Hide', 'lfs'])
    expect(filterRecordsOf('')).toBe('')
    expect(filterCommands(filterRecordsOf('filter.x.clean\0'))).toBeNull()                    // a value-less driver: no answer, never "no filter"
  })
  test('promisor pack markers', () => {
    expect(promisorPacksOf('')).toBe(0)
    expect(promisorPacksOf('./.git/objects/pack/pack-1.promisor\0./.git/objects/pack/pack-2.promisor\0')).toBe(2)
    for (const bad of ['./.git/objects/pack/pack-1.promisor', './.git/objects/pack/pack-1.pack\0', '\0']) expect([bad, promisorPacksOf(bad)]).toEqual([bad, null])
  })
  test('the Git version, read strictly, and what its doctor line says', () => {
    expect(gitVersionOf('git version 2.47.3\n')).toEqual({ version: '2.47.3', lazyFetchSwitch: true })
    expect(gitVersionOf('git version 2.45.0\n')).toEqual({ version: '2.45.0', lazyFetchSwitch: true })
    expect(gitVersionOf('git version 2.44.1\n')).toEqual({ version: '2.44.1', lazyFetchSwitch: false })
    expect(gitVersionOf('git version 2.39.5 (Apple Git-154)\n')).toEqual({ version: '2.39.5', lazyFetchSwitch: false })
    expect(gitVersionOf('git version 3.0\n')).toEqual({ version: '3.0', lazyFetchSwitch: true })
    for (const bad of ['', 'git 2.47.3', 'git version x\n', 'git version 2.47.3\nextra\n']) expect([bad, gitVersionOf(bad)]).toEqual([bad, null])
    expect(gitVersionText({ version: '2.47.3', lazyFetchSwitch: true })).toContain('Git 2.47.3: measurement never fetches')
    expect(gitVersionText({ version: '2.39.5', lazyFetchSwitch: false })).toContain('older than 2.45')
    expect(gitVersionText(null)).toContain('Git version UNKNOWN')
    for (const text of [gitVersionText(null), gitVersionText({ version: '2.39.5', lazyFetchSwitch: false })]) expect(text).toContain('repositories with a submodule or a partial clone are not measured')
  })
  test('every refusal has words, and the two a person can act on say what can be measured instead', () => {
    for (const key of ['submodule', 'partial-clone', 'unreadable', 'moved'] as RepoRefusal[]) expect(REPO_REFUSAL_WORDS[key].length).toBeGreaterThan(40)
    expect(REPO_REFUSAL_WORDS.submodule).toContain('a checkout without submodules can be measured')
    expect(REPO_REFUSAL_WORDS['partial-clone']).toContain('a full clone, made without --filter, can be measured')
    for (const key of ['submodule', 'partial-clone'] as RepoRefusal[]) expect(REPO_REFUSAL_WORDS[key]).toContain('goal checks and Stop checks cannot be verified')
  })
})

describe('pins on every Git process', () => {
  test('the settings and variables themselves', () => {
    expect(BOUND_PINS).toEqual({ GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'cockpit-none' })
    expect(GIT_SAFE).toContain('diff.ignoreSubmodules=all')
    expect(GIT_SAFE).toContain('submodule.recurse=false')
    expect(GIT_SAFE).not.toContain('diff.ignoreSubmodules=none')
    expect(HELPER_PINS).toEqual(['-c', 'diff.submodule=short', '-c', 'protocol.allow=never', ...['ext', 'file', 'ssh', 'git', 'http', 'https'].flatMap(p => ['-c', `protocol.${p}.allow=never`])])
  })
  test('every measurement process of a Stop carries both variables, whatever environment its caller gave; every status and diff ignores submodules', guard(), async ($, on) => {
    const { w } = fixture(on)
    w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'; w.untracked = ['notes.md', 'latest']; w.kinds['latest'] = 'link'; w.ignoredEntries = ['.cache/x']
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/a.ts'] = 'b'
    const from = w.runs.length
    await stop($)
    const measuring = w.runs.map((r, i) => ({ r, env: w.runEnvs[i], wrapped: w.wrappers[i] !== null })).slice(from).filter(x => x.wrapped)
    expect(measuring.length).toBeGreaterThan(20)
    expect(measuring.some(x => x.env?.['LC_ALL'] === 'C')).toBe(true)                   // callers that set their own variables keep the pins too
    for (const x of measuring) expect([x.r[0], x.env?.['GIT_NO_LAZY_FETCH'], x.env?.['GIT_ALLOW_PROTOCOL']]).toEqual([x.r[0], '1', 'cockpit-none'])
    const compares = w.runs.slice(from).filter(r => r[0] === 'git' && (r.includes('status') || r.includes('diff')))
    expect(compares.length).toBeGreaterThan(0)
    for (const r of compares) { expect(r).toContain('--ignore-submodules=all'); expect(r).not.toContain('--ignore-submodules=none') }
  })
})

// --- hostile repository states, at every entry point that measures ---

type Hostile = { name: string; set: (w: World) => void; refusal: RepoRefusal }
const HOSTILE: Hostile[] = [
  { name: 'a gitlink staged in the index only', set: w => { w.indexGitlinks = ['vendor/lib'] }, refusal: 'submodule' },
  { name: 'a gitlink committed at HEAD', set: w => { w.headBlobs['vendor/lib'] = 'c'.repeat(40); w.headModes['vendor/lib'] = '160000' }, refusal: 'submodule' },
  { name: 'a promisor remote', set: w => { w.gitConfig['remote.origin.promisor'] = 'true' }, refusal: 'partial-clone' },
  { name: 'extensions.partialClone', set: w => { w.gitConfig['extensions.partialClone'] = 'origin' }, refusal: 'partial-clone' },
  { name: 'a partial-clone filter', set: w => { w.gitConfig['remote.origin.partialclonefilter'] = 'blob:none' }, refusal: 'partial-clone' },
  { name: 'promisor packs with no promisor configuration left', set: w => { w.promisorPacks = ['pack-1.promisor'] }, refusal: 'partial-clone' },
  { name: 'a configuration listing that exits 1 (never read as "absent")', set: w => { w.configListFails = true }, refusal: 'unreadable' },
  { name: 'a pack directory that cannot be listed', set: w => { w.packListFails = true }, refusal: 'unreadable' },
]
const SHORT = REPO_REFUSAL_SHORT

describe('a refused repository: the Stop guard never verifies it', () => {
  for (const hostile of HOSTILE) {
    test(`${hostile.name}: the Stop's measurement is refused before anything is compared, and the passing check is not recorded as verified`, guard(), async ($, on) => {
      const { w, h } = fixture(on)
      w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
      await start($); await enroll($); await prompt($, 'tidy it')
      expect(taskOf(h)?.startTree).toEqual(expect.any(String))                          // begun on a measured tree
      hostile.set(w)
      const from = w.runs.length
      await stop($)
      const last = kept(h).at(-1)
      expect(last?.complete).toBe(false)
      expect(last?.summary).toContain(REPO_REFUSAL_WORDS[hostile.refusal])
      expect(taskOf(h)?.guardDone).toBeUndefined()
      expect(taskOf(h)?.status).not.toBe('done')
      expect(subcommands(w, from).filter(s => READS_STATE.includes(s))).toEqual([])
    })
  }
})

describe('a refused repository: a task begun in it has no baseline, and its goal check is never accepted', () => {
  for (const hostile of HOSTILE) {
    test(`${hostile.name}: no baseline, ALIGNED is recorded UNKNOWN with the reason, and the task does not reach DONE`, async ($, on) => {
      const w = world(on); hostile.set(w); const h = hostState(on, {})
      await start($)
      const from = w.runs.length
      await prompt($, 'Add booking cancellation to the API and the UI')
      expect(taskOf(h)?.startTree ?? null).toBeNull()
      expect(subcommands(w, from).filter(s => READS_STATE.includes(s))).toEqual([])
      await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
      await planAndComplete($, 4)
      await passAllGates($, { align: false })
      const answer = await progress($, { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "cancel test 'frees the slot' passes in test/api.test.js (4 pass)" }] } })
      expect(answer).toStartWith('error: ALIGNED not accepted')
      expect(answer).toContain('recorded as UNKNOWN')
      expect(answer).toContain(REPO_REFUSAL_WORDS[hostile.refusal].slice(0, 60))
      expect(await progress($, { action: 'complete', milestone: 'm5' })).not.toStartWith('DONE')
      expect(await progress($, { action: 'status' })).not.toStartWith('DONE')
    })
  }
})

const LED = { options: { orchestration: true, profile: 'SONNET_LED' } }
const PACKET = { action: 'consult', ground: 'release', objective: 'Release v0.6.6', architecture: 'Plugin hooks', locations: ['hooks/register.tsx'], risk: 'Candidate mismatch', question: 'Approve the release?' }
const admit = async ($: Engine, beforeConsult?: () => void) => {
  await start($); await prompt($, 'Have Opus review the release candidate')
  await progress($, { action: 'plan', milestones: FIVE })
  for (const milestone of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone })
  for (const gate of GATE_NAMES) await progress($, { action: 'gate', gate, state: 'na', evidence: 'fixture' })
  beforeConsult?.()
  return String((await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', ...PACKET } as never)).result)
}

describe('a refused repository: no release candidate', () => {
  test('control: a clean, ordinary repository is a candidate', LED, async ($, on) => {
    world(on); hostState(on, {})
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
  for (const hostile of HOSTILE) {
    test(`${hostile.name}: the release check never names a candidate, and runs no status`, LED, async ($, on) => {
      const w = world(on); hostState(on, {}); hostile.set(w)
      expect(await admit($)).not.toContain('OPUS ADMITTED')
      expect(subcommands(w)).not.toContain('status')
    })
  }
})

describe('a refused repository: the HUD says so, and a Stop with no task asks for the check', () => {
  // The Stop with no task refreshes the HUD's Git state and waits for it (a session start does not wait), so it is the probe here.
  for (const hostile of HOSTILE) {
    test(`${hostile.name}: the HUD's Git line is refused, never clean; a Stop with no task and nothing owed asks for the check; no status runs`, guard(), async ($, on) => {
      const { w, h } = fixture(on)
      await start($); await enroll($)
      hostile.set(w)
      const from = w.runs.length
      const out = await stop($)
      const git = gitOf(h)
      expect(git?.isRepo).toBe(true)
      expect(git?.refused).toBe(hostile.refusal)
      expect(dirtyLabel(git ?? null)).toBe(`not measured (${SHORT[hostile.refusal]})`)
      expect((await rowsOf(await mountHud($, 'terminal', 160))).join('\n')).toContain(`not measured (${SHORT[hostile.refusal]})`)
      expect(subcommands(w, from)).not.toContain('status')
      // possibly changed: a coding task for which the check runs, and whose pass on an unidentifiable tree is not recorded as
      // verified, so the task is held (the stop itself goes through: a check that cannot be recorded is not asked for again)
      const task = taskOf(h)
      expect(task).toEqual(expect.objectContaining({ edited: true }))
      expect(w.runs.filter(r => r[0] === SCRIPT)).toHaveLength(1)
      expect(kept(h).at(-1)?.complete).toBe(false)
      expect(task?.status).not.toBe('done')
      expect(task?.stopHold).toBeDefined()
      expect(out.block).toBeUndefined()
    })
  }
  test('control: an ordinary clean repository with no task stops without a check, and its HUD line is clean', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await start($); await enroll($)
    expect((await stop($)).block).toBeUndefined()
    expect(taskOf(h) ?? null).toBeNull()
    expect(gitOf(h)?.refused).toBeUndefined()
    expect(dirtyLabel(gitOf(h) ?? null)).toBe('clean')
    expect(w.runs.filter(r => r[0] === SCRIPT)).toEqual([])
  })
  test('a failed status in a verified repository is a refusal too, never a stale or a clean line', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await start($); await enroll($)
    w.gitHangs = 'status'
    await stop($)
    expect(gitOf(h)?.refused).toBe('unreadable')
    expect(taskOf(h)).toEqual(expect.objectContaining({ edited: true }))
  })
  test('a status listing cut short by the host is no count: refused, never an undercount', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await start($); await enroll($)
    w.gitTruncates = 'status'
    await stop($)
    expect(gitOf(h)?.refused).toBe('unreadable')
    expect(taskOf(h)).toEqual(expect.objectContaining({ edited: true }))
  })
  test('a Git that does not answer before the repository is even found is no clean tree either', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await start($); await enroll($)
    w.gitHangs = 'rev-parse'
    await stop($)
    const task = taskOf(h)
    expect(task).toEqual(expect.objectContaining({ edited: true }))
    expect(w.runs.filter(r => r[0] === SCRIPT)).toHaveLength(1)
    expect(kept(h).at(-1)?.complete).toBe(false)
    expect(task?.stopHold).toBeDefined()
  })
  test('with no shell to set limits, nothing is measured and a Stop with no task is not allowed through as clean', guard(), async ($, on) => {
    const { w, h } = fixture(on); w.boundMode = 'none'
    await start($); await enroll($)
    await stop($)
    expect(taskOf(h)).toEqual(expect.objectContaining({ edited: true }))
    expect(w.runs.filter(r => r[0] === 'git')).toEqual([])
  })
  test('control: a session outside every Git repository with no task still stops without a check', guard(), async ($, on) => {
    const { w, h } = fixture(on); w.gitStatus = null
    await start($); await enroll($)
    expect((await stop($)).block).toBeUndefined()
    expect(taskOf(h) ?? null).toBeNull()
    expect(w.runs.filter(r => r[0] === SCRIPT)).toEqual([])
  })
  test('the Run Ledger\'s checkpoint never records a refused repository as clean', () => {
    const git: GitState = { isRepo: true, project: 'example', branch: null, isDetached: false, sha: null, startSha: null, dirty: 0, ahead: null, behind: null, refused: 'submodule', at: 0 }
    expect(checkpointOf(emptyLedger('s'), null, git, 0).dirty).toBe(UNKNOWN)
    expect(checkpointOf(emptyLedger('s'), null, { ...git, refused: undefined }, 0).dirty).toBe(0)
  })
})

describe('a refused repository: a helper\'s Git inspection is refused, and nothing is sent', () => {
  const SWARM = 'mcp__cobalt-cockpit__swarm'
  const options = { options: { orchestration: true, maxSubagents: 32, maxSonnetAgents: 16, maxHaikuAgents: 24 } }
  const ROOT = '/work/example'
  const assign = ($: Engine, id: string, owned: string[]) =>
    $.tool.call({ tool: SWARM, action: 'assign', task_id: id, tier: 'SONNET', role: 'REVIEW', objective: `Review ${id}`, scope: `Scope ${id}`, owned_resources: owned, mode: 'read', spawn_reason: 'Independent bounded review' } as never)
  const spawn = ($: Engine, id: string) =>
    $.agent.spawn({ prompt: `Review ${id}`, description: `[task:${id}] bounded review`, subagentType: 'cobalt-cockpit:reviewer', tool_use_id: `spawn-${id}`, parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true } as never)
  const reviewer = async ($: Engine, owned: string[]) => { await start($); await assign($, 'rev', owned); return (await spawn($, 'rev')).agentId! }
  const git = async ($: Engine, agentId: string, cmd: string) => (await $.tool.call({ tool: 'Bash', agentId, command: cmd } as never)) as { deny?: string }
  const sent = (w: World) => w.ran.filter(call => call['tool'] === 'Bash')
  for (const hostile of HOSTILE) {
    for (const [kind, owned, cmd] of [['wildcard', ['*'], 'git diff main...HEAD -- hooks/swarm.ts'], ['scoped', [`${ROOT}/hooks/swarm.ts`], 'git diff main...HEAD -- hooks/swarm.ts']] as const) {
      test(`${hostile.name}: a ${kind} inspection is refused with the reason`, options, async ($, on) => {
        const w = world(on); const a = await reviewer($, [...owned])
        hostile.set(w)
        const out = await git($, a, cmd)
        expect(out.deny).toContain(`refused in this repository (${SHORT[hostile.refusal]})`)
        expect(sent(w)).toEqual([])
        expect(w.runs.filter(r => r.includes('--verify') && r.some(x => x.endsWith('^{commit}')))).toEqual([])   // no revision read
      })
    }
  }
  test('a scoped inspection naming a revision whose tree records a gitlink is refused (HEAD and the index hold none)', options, async ($, on) => {
    const w = world(on); const a = await reviewer($, [`${ROOT}/hooks/swarm.ts`])
    w.gitlinkRevisions = ['old']
    const out = await git($, a, 'git diff old -- hooks/swarm.ts')
    expect(out.deny).toContain('a revision it names records a submodule')
    expect(sent(w)).toEqual([])
    expect((await git($, a, 'git diff main -- hooks/swarm.ts')).deny).toBeUndefined()                 // control
  })
  for (const name of GIT_ENV_REFUSED) {
    test(`an environment that sets ${name} refuses every inspection: the helper's command would inherit it`, options, async ($, on) => {
      const w = world(on, { env: { [name]: '/elsewhere' } }); const a = await reviewer($, ['*'])
      const out = await git($, a, 'git status')
      expect(out.deny).toContain(`the environment sets ${name}`)
      expect(sent(w)).toEqual([])
    })
  }
  test('a repository with no commit yet: inspection is allowed (there is no HEAD tree to hold a gitlink), and the index is still checked', options, async ($, on) => {
    const w = world(on, { headUnborn: true }); const a = await reviewer($, ['*'])
    const from = w.runs.length
    expect((await git($, a, 'git status')).deny).toBeUndefined()
    expect(sent(w)).toHaveLength(1)
    // Git's words are read in the C locale: elsewhere they could be translated, and would not be recognised (a refusal, never a pass)
    const heads = w.runs.map((r, i) => ({ r, env: w.runEnvs[i] })).slice(from).filter(x => x.r[0] === 'git' && x.r.includes('--verify') && x.r.at(-1) === 'HEAD')
    expect(heads.length).toBeGreaterThan(0)
    for (const x of heads) expect(x.env?.['LC_ALL']).toBe('C')
    w.indexGitlinks = ['vendor/lib']
    expect((await git($, a, 'git status')).deny).toContain(`refused in this repository (${SHORT.submodule})`)
    expect(sent(w)).toHaveLength(1)
  })
  const WORDS = 'fatal: Needed a single revision\n'
  const answer = (exitCode: number, stdout: string, stderr: string, cut: { out?: boolean; err?: boolean } = {}) => ({ exitCode, stdout, stderr, isStdoutTruncated: cut.out === true, isStderrTruncated: cut.err === true })
  for (const [name, head] of [
    ['a damaged HEAD (exit 128, other words)', answer(128, '', 'fatal: bad object HEAD\n')],
    ['a kill by a resource limit (exit 137, nothing printed)', answer(137, '', '')],
    ['a timeout (exit 124)', answer(124, '', '')],
    ['a signal (the host reads it as exit 1, nothing printed)', answer(1, '', '')],
    ["Git's words with another exit status", answer(1, '', WORDS)],
    ["Git's words after a warning", answer(128, '', `warning: ignoring broken ref refs/heads/x\n${WORDS}`)],
    ["Git's words with output", answer(128, 'x\n', WORDS)],
    ["Git's words, its error output cut short", answer(128, '', WORDS, { err: true })],
    ["Git's words, its output cut short", answer(128, '', WORDS, { out: true })],
    ['a commit named with a warning', answer(0, `${'a'.repeat(40)}\n`, 'warning: refname is ambiguous\n')],
  ] as const) {
    test(`a HEAD that is not Git's own answer for a repository with no commit (${name}): refused, and nothing is sent`, options, async ($, on) => {
      const w = world(on, { headUnreadable: head }); const a = await reviewer($, ['*'])
      await settled()                                                              // the session start's HUD refresh lands before `from`
      const from = w.runs.length
      expect((await git($, a, 'git status')).deny).toContain('cannot establish safe repository identity')
      expect(sent(w)).toEqual([])
      expect(w.runs.slice(from).filter(r => r[0] === 'git' && r.includes('ls-files') && r.includes('--stage'))).toEqual([])   // refused before the check
    })
  }
  test('control: variables the host sets that do not move Git (GIT_EDITOR, GIT_PAGER) refuse nothing', options, async ($, on) => {
    const w = world(on, { env: { GIT_EDITOR: 'true', GIT_PAGER: 'cat' } }); const a = await reviewer($, ['*'])
    expect((await git($, a, 'git status')).deny).toBeUndefined()
    expect(sent(w)).toHaveLength(1)
  })
  test('a wildcard inspection runs in the verified directory, with the pins, whatever the helper typed', options, async ($, on) => {
    const w = world(on); const a = await reviewer($, ['*'])
    expect((await git($, a, 'git log --oneline -3')).deny).toBeUndefined()
    const command = String(sent(w)[0]!['command'])
    expect(command.startsWith(`${HELPER_START.map(word => `'${word}'`).join(' ')} '--no-pager'`)).toBe(true)        // Stage B: the clean launch
    expect(command).toContain(`'-C' '${ROOT}' 'log' '--no-ext-diff' '--no-textconv' '--ignore-submodules=all' '--oneline' '-3'`)
    for (const pin of HELPER_PINS.filter(p => p !== '-c')) expect(command).toContain(`'${pin}'`)
  })
  test('submodule options in any spelling are no inspection: refused, and nothing is sent', options, async ($, on) => {
    const w = world(on); const a = await reviewer($, ['*'])
    for (const cmd of ['git diff --submodule=diff', 'git diff --submodule', 'git log -p --submodule=log -1', 'git status --ignore-submodules=none', 'git diff --ignore-submodules=dirty', 'git grep --recurse-submodules -n x', 'git ls-files --recurse-submodules', 'git diff --submod=diff', 'git grep --recurse -n x']) {
      expect([cmd, (await git($, a, cmd)).deny === undefined]).toEqual([cmd, false])
    }
    expect(sent(w)).toEqual([])
  })
})

describe('a state that appears while the tree is measured', () => {
  for (const [name, appear] of [['a gitlink staged', (w: World) => { w.indexGitlinks = ['vendor/lib'] }], ['a promisor pack', (w: World) => { w.promisorPacks = ['pack-9.promisor'] }], ['a promisor remote', (w: World) => { w.gitConfig['remote.origin.promisor'] = 'true' }], ['a clean filter driver', (w: World) => { w.gitFilterConfig = 'filter.hide.clean\nprintf x\0' }]] as const) {
    test(`${name} during the measurement: no stamp, with the reason`, guard(), async ($, on) => {
      const { w, h } = fixture(on)
      w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
      await start($); await enroll($); await prompt($, 'tidy it')
      w.tree['src/a.ts'] = 'b'
      let fired = false
      w.duringRun = argv => { if (!fired && argv[0] === 'git' && argv.includes('diff')) { fired = true; appear(w) } }
      await stop($)
      expect(fired).toBe(true)
      const last = kept(h).at(-1)
      expect(last?.complete).toBe(false)
      expect(last?.summary).toContain(REPO_REFUSAL_WORDS.moved)
    })
  }
})

describe('a state configured after the check is seen before the command that would run it', () => {
  // Each appears at the first unfiltered hash, after the repository-state check and its filter check: only the configuration read
  // again right before status or diff sees it then (repoMoved would see it only after the command ran)
  const LATE = [
    ['a filter driver', (w: World) => { w.gitFilterConfig = 'filter.hide.clean\nprintf x\0' }],
    ['a promisor remote', (w: World) => { w.gitConfig['remote.origin.promisor'] = 'true' }],
    ['a configuration listing that now exits 1', (w: World) => { w.configListFails = true }],
  ] as const
  const at = (w: World, appear: (w: World) => void) => {
    const seen = { from: -1 }
    w.duringRun = argv => { if (seen.from < 0 && argv[0] === 'git' && argv.includes('hash-object') && argv.includes('--no-filters')) { seen.from = w.runs.length; appear(w) } }
    return seen
  }
  for (const [name, appear] of LATE) {
    test(`${name}: the fingerprint reads the configuration again before its diff: UNKNOWN, and no diff runs`, guard(), async ($, on) => {
      const { w, h } = fixture(on)
      w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
      await start($); await enroll($); await prompt($, 'tidy it')
      w.tree['src/a.ts'] = 'b'
      const seen = at(w, appear)
      await stop($)
      expect(seen.from).toBeGreaterThan(0)
      expect(kept(h).at(-1)?.summary).toContain('active commit-path filters make the working tree unreliable')
      expect(subcommands(w, seen.from)).not.toContain('diff')
    })
    test(`${name}: the release check reads the configuration again before its status: no candidate, and neither status nor a filtering hash runs`, LED, async ($, on) => {
      const w = world(on); hostState(on, {})
      w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
      let seen = { from: -1 }
      const result = await admit($, () => { seen = at(w, appear) })                   // armed only once the task's own baseline is taken
      expect(seen.from).toBeGreaterThan(0)
      expect(result).toContain('CANDIDATE UNKNOWN')
      expect(subcommands(w, seen.from)).not.toContain('status')
      expect(w.runs.slice(seen.from).filter(r => r[0] === 'git' && r.includes('hash-object') && !r.includes('--no-filters'))).toEqual([])
    })
  }
  test('control: with nothing appearing, the same repository is a candidate', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
})

describe('doctor names the Git it measures with', () => {
  test('the version line', async ($, on) => {
    const w = world(on); await start($)
    expect(String((await command($, 'doctor')).text)).toContain('Git 2.47.3: measurement never fetches')
    w.gitVersion = 'git version 2.39.5'
    expect(String((await command($, 'doctor')).text)).toContain('Git 2.39.5 is older than 2.45')
  })
})

describe('the HUD\'s words for a refused repository', () => {
  const base: GitState = { isRepo: true, project: 'example', branch: 'main', isDetached: false, sha: null, startSha: null, dirty: 0, ahead: null, behind: null, at: 0 }
  test('never clean, always worth attention, with the reason', () => {
    for (const [refused, words] of [['inputs', 'unsafe Git inputs'], ['submodule', 'submodule'], ['partial-clone', 'partial clone'], ['unreadable', 'state unreadable'], ['filter', 'active filter']] as const) {
      const git = { ...base, refused }
      expect(dirtyLabel(git)).toBe(`not measured (${words})`)
      expect(refusedReason(git)).toBe(words)
      expect(treeNeedsAttention(git)).toBe(true)
    }
    expect(dirtyLabel(base)).toBe('clean')
    expect(treeNeedsAttention(base)).toBe(false)
    expect(refusedReason({ ...base, isRepo: false, refused: 'submodule' })).toBeNull()
  })
})

describe('stamp continuity: fingerprints of ordinary repositories are the ones v0.6.5 took', () => {
  // Recorded by running these scenarios against main 2dbeaf1 (v0.6.5's measurement), so a task that spans the upgrade asks nothing again.
  const GOLDEN: Record<string, [(w: World) => void, string]> = {
    clean: [w => { w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'; w.untracked = ['notes.md', 'latest']; w.kinds['latest'] = 'link'; w.ignoredEntries = ['.cache/x'] }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:4.caee0fc5c8ad4be58c1e74019b518306@03725b507abeb26707ad4e0bc41c105a'],
    modified: [w => { w.headBlobs['src/a.ts'] = blobOf('a'); w.headBlobs['src/b.ts'] = blobOf('b'); w.watched['src/a.ts'] = 'a2'; w.tree['src/a.ts'] = 'a2'; w.watched['src/b.ts'] = 'b'; w.untracked = ['n.md'] }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:3.65398f19f642a560bb7b48edd5c8c14a@03725b507abeb26707ad4e0bc41c105a'],
    flagged: [w => { w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'; w.indexFlags = 'h src/a.ts\0'; w.untracked = [] }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1.1f177c691e43d8c8fb3f0d2dcd46aa2f@03725b507abeb26707ad4e0bc41c105a'],
  }
  for (const [name, [set, stamp]] of Object.entries(GOLDEN)) {
    test(name, async ($, on) => {
      const w = world(on); const h = hostState(on, {}); set(w)
      await start($); await prompt($, 'tidy it')
      expect(taskOf(h)?.startTree).toBe(stamp)
    })
  }
})
