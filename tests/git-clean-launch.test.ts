// v0.6.6 Stage B: the clean launch. Every measurement process starts as `/usr/bin/env -i <allow-list> /bin/sh -c <limit script>`
// with each program by absolute path, so nothing of the host's environment reaches the shell or the program but what is listed;
// the programs are found on the absolute PATH entries only, owned by root or the session's user, closed to writes by others, and
// never inside the repository. An environment in which the person's Git would see another repository or configuration is refused
// rather than measured. A helper's rebuilt inspection starts the same way. Everything a refusal touches is UNKNOWN, never clean.
// Through the fake host only: what the real host and real Git do with these argv is for the approved real-Git acceptance.
import { describe, expect, test } from 'claude-code/testing'
import { BOUND_ENV, BOUND_PINS, CALLER_ENV, CLEAN_ENV, CLEAN_SHELL, GIT_ENV_MEASURED, GIT_ENV_REFUSED, LOADER_BLANK, MEASURE_PROGRAMS, OWNER_BSD, OWNER_GNU, RESOLVE_SCRIPT, boundScript, callerEnvAdmitted, cleanAssignments, helperAssignments, ownersOf, programTrusted, resolvedOf, trustedPathOf } from '../hooks/git-integrity'
import { checkpointOf, emptyLedger, UNKNOWN } from '../hooks/ledger'
import { dirtyLabel } from '../hooks/git'
import type { GitState, Task } from '../types'
import { blobOf, command, FIVE, GATE_NAMES, hostState, passAllGates, planAndComplete, progress, prompt, start, world } from './world'
import type { World } from './world'

type Engine = Parameters<typeof start>[0]
const SCRIPT = '/work/check.sh'
const ROOT = '/work/example'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 3, ...extra } })
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Changed the parser to reject empty input and added a regression test.' }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const fixture = (on: any, overrides: Partial<World> = {}) => {
  const w = world(on, overrides); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
  w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
  return { w, h: hostState(on, {}) }
}
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')?.value as Task | null | undefined
const gitOf = (h: ReturnType<typeof hostState>) => h.get('git')?.value as GitState | null | undefined
const kept = (h: ReturnType<typeof hostState>) => ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: { complete: boolean; summary: string }[] }).stopChecks ?? []
/** The measurement processes that started (through the clean launch), by program name. */
const measured = (w: World, from = 0): string[][] => w.runs.slice(from).filter((_, i) => w.programPaths[from + i] !== null)
const scriptRuns = (w: World): number => w.runs.filter(r => r[0] === SCRIPT).length

// --- the pure parts ---

describe('the clean launch, piece by piece', () => {
  test('PATH keeps its absolute entries only, in order, once each; unset, the shell\'s usual default', () => {
    expect(trustedPathOf('/opt/git/bin:/usr/bin:/bin')).toEqual(['/opt/git/bin', '/usr/bin', '/bin'])
    // an empty entry and a relative one name the current directory, which may be the repository
    expect(trustedPathOf('./bin::/usr/bin:node_modules/.bin:.:/usr/bin:/bin:')).toEqual(['/usr/bin', '/bin'])
    expect(trustedPathOf(undefined)).toEqual(['/usr/bin', '/bin'])
    expect(trustedPathOf('relative:.')).toEqual([])
  })
  test('the clean shell\'s `command -v` answer, line by line: a path, or not found', () => {
    const lines = (...paths: string[]) => paths.map(p => `${p}\n`).join('')
    expect(RESOLVE_SCRIPT).toBe(`for p in ${MEASURE_PROGRAMS.join(' ')}; do command -v "$p" || echo; done`)
    expect(resolvedOf(lines('/usr/bin/git', '/usr/bin/stat', '/usr/bin/find', '/usr/bin/readlink', '/usr/bin/realpath', '/usr/bin/timeout', '/usr/bin/id'))).toEqual({ git: '/usr/bin/git', stat: '/usr/bin/stat', find: '/usr/bin/find', readlink: '/usr/bin/readlink', realpath: '/usr/bin/realpath', timeout: '/usr/bin/timeout', id: '/usr/bin/id' })
    // a builtin, alias or function answers with a word: not found, never run
    expect(resolvedOf(lines('/usr/bin/git', 'stat', '', '/usr/bin/readlink', '/usr/bin/realpath', '', '/usr/bin/id'))).toEqual({ git: '/usr/bin/git', readlink: '/usr/bin/readlink', realpath: '/usr/bin/realpath', id: '/usr/bin/id' })
    for (const bad of ['', '/usr/bin/git', lines('/usr/bin/git'), lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')]) expect([bad, resolvedOf(bad)]).toEqual([bad, null])
  })
  test('owners and modes read strictly, GNU (named) or BSD', () => {
    expect(ownersOf(`0 81ed /usr/bin/git\0${''}1000 41ed /usr/bin\0`, true, ['/usr/bin/git', '/usr/bin'])).toEqual([{ uid: 0, mode: 0x81ed }, { uid: 1000, mode: 0x41ed }])
    expect(ownersOf('0 100755\n0 40755\n', false, ['/usr/bin/git', '/usr/bin'])).toEqual([{ uid: 0, mode: 0o100755 }, { uid: 0, mode: 0o40755 }])
    for (const [text, gnu] of [['0 81ed /usr/bin/other\0', true], ['0 81ed /usr/bin/git', true], ['x 81ed /usr/bin/git\0', true], ['0 100755', false], ['0 100755\n0 40755\n', false]] as const) expect([text, ownersOf(text, gnu, ['/usr/bin/git'])]).toEqual([text, null])
    expect([OWNER_GNU, OWNER_BSD]).toEqual(['%u %f %n\\0', '%u %p'])
  })
  test('a program may start: a regular file of root or this user, closed to writes by others, in a directory others cannot write to', () => {
    const file = (uid: number, mode: number) => ({ uid, mode: 0o100000 | mode }), dir = (uid: number, mode: number) => ({ uid, mode: 0o40000 | mode })
    expect(programTrusted(file(0, 0o755), dir(0, 0o755), 1000)).toBe(true)
    expect(programTrusted(file(1000, 0o755), dir(1000, 0o755), 1000)).toBe(true)                       // Homebrew, a ~/.local/bin
    expect(programTrusted(file(0, 0o555), dir(0, 0o775), 1000)).toBe(true)                            // a group-writable directory, as /usr/local/bin can be
    expect(programTrusted(file(1001, 0o755), dir(0, 0o755), 1000)).toBe(false)                        // another user's
    expect(programTrusted(file(1000, 0o755), dir(0, 0o755), null)).toBe(false)                        // the user unknown: root's only
    expect(programTrusted(file(0, 0o775), dir(0, 0o755), 1000)).toBe(false)                           // writable by its group
    expect(programTrusted(file(0, 0o757), dir(0, 0o755), 1000)).toBe(false)                           // writable by anyone
    expect(programTrusted(file(0, 0o755), dir(0, 0o1777), 1000)).toBe(false)                          // in /tmp
    expect(programTrusted({ uid: 0, mode: 0o40755 }, dir(0, 0o755), 1000)).toBe(false)                // not a file
    expect(programTrusted(file(0, 0o755), file(0, 0o755), 1000)).toBe(false)                          // its "directory" is not one
  })
  test('the variables, in order, the pins last; a caller may add LC_ALL=C and nothing else', () => {
    const base = { path: ['/opt/git/bin', '/usr/bin'], home: '/home/p', xdgConfigHome: '/home/p/.config' }
    expect(cleanAssignments(base, { LC_ALL: 'C' })).toEqual(['PATH=/opt/git/bin:/usr/bin', 'HOME=/home/p', 'XDG_CONFIG_HOME=/home/p/.config', 'MALLOC_ARENA_MAX=2', 'LC_ALL=C', 'GIT_NO_LAZY_FETCH=1', 'GIT_ALLOW_PROTOCOL=cockpit-none'])
    expect(cleanAssignments({ path: ['/usr/bin'] }, undefined)).toEqual(['PATH=/usr/bin', 'MALLOC_ARENA_MAX=2', 'GIT_NO_LAZY_FETCH=1', 'GIT_ALLOW_PROTOCOL=cockpit-none'])
    // nothing a caller gives can take the pins back or add a variable
    expect(cleanAssignments({ path: ['/usr/bin'] }, { GIT_ALLOW_PROTOCOL: 'ext', LD_PRELOAD: '/x.so', LC_ALL: 'en_US' })).toEqual(['PATH=/usr/bin', 'MALLOC_ARENA_MAX=2', 'GIT_NO_LAZY_FETCH=1', 'GIT_ALLOW_PROTOCOL=cockpit-none'])
    expect(CALLER_ENV).toEqual({ LC_ALL: 'C' })
    expect([callerEnvAdmitted(undefined), callerEnvAdmitted({}), callerEnvAdmitted({ LC_ALL: 'C' })]).toEqual([true, true, true])
    const refused: Record<string, string>[] = [{ LC_ALL: 'en_US.UTF-8' }, { GIT_DIR: '/x' }, { LC_ALL: 'C', PATH: '/tmp' }, { MALLOC_ARENA_MAX: '64' }]
    for (const env of refused) expect([env, callerEnvAdmitted(env)]).toEqual([env, false])
    expect(helperAssignments(base)).toEqual(['PATH=/opt/git/bin:/usr/bin', 'HOME=/home/p', 'XDG_CONFIG_HOME=/home/p/.config', 'GIT_NO_LAZY_FETCH=1', 'GIT_ALLOW_PROTOCOL=cockpit-none'])
  })
  test('the loader\'s variables are blanked for /usr/bin/env itself; every measured name is also refused for helpers', () => {
    expect(Object.values(LOADER_BLANK).every(v => v === '')).toBe(true)
    expect(Object.keys(LOADER_BLANK)).toEqual(expect.arrayContaining(['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES']))
    expect(GIT_ENV_MEASURED).toHaveLength(20)
    for (const name of GIT_ENV_MEASURED) expect([name, GIT_ENV_REFUSED.includes(name)]).toEqual([name, true])
  })
})

// --- what every measurement process sees, through the fake host ---

describe('every measurement process starts clean', () => {
  test('/usr/bin/env -i, exactly the allow-list, /bin/sh with the limit script, the program by absolute path; nothing inherited reaches it', guard(), async ($, on) => {
    // a host environment full of what must not reach Git: loader, Git, shell and engine variables
    const { w } = fixture(on, { env: { LD_PRELOAD: '/tmp/evil.so', LD_LIBRARY_PATH: '/tmp', BASH_ENV: '/tmp/rc', ENV: '/tmp/rc', GIT_EDITOR: 'vim', GIT_TRACE: '/tmp/t', GIT_EXEC_PATH: '/tmp/x', NODE_OPTIONS: '--require=/tmp/x.js', SSH_AUTH_SOCK: '/tmp/s', PATH: '/usr/bin:/bin' } })
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/a.ts'] = 'b'
    const from = w.runs.length
    await stop($)
    const runs = measured(w, from)
    expect(runs.length).toBeGreaterThan(20)
    for (let i = from; i < w.runs.length; i++) {
      if (w.programPaths[i] === null) continue
      const env = w.runEnvs[i]!
      const names = Object.keys(env).sort()
      expect([w.runs[i]![0], names]).toEqual([w.runs[i]![0], env['LC_ALL'] === undefined ? ['GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH', 'HOME', 'MALLOC_ARENA_MAX', 'PATH'] : ['GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH', 'HOME', 'LC_ALL', 'MALLOC_ARENA_MAX', 'PATH']])
      expect([env['PATH'], env['HOME'], env['MALLOC_ARENA_MAX'], env['GIT_NO_LAZY_FETCH'], env['GIT_ALLOW_PROTOCOL']]).toEqual(['/usr/bin:/bin', '/home/tester', BOUND_ENV.MALLOC_ARENA_MAX, BOUND_PINS.GIT_NO_LAZY_FETCH, BOUND_PINS.GIT_ALLOW_PROTOCOL])
      if (env['LC_ALL'] !== undefined) expect(env['LC_ALL']).toBe('C')
      // what the host lays over its own environment, for /usr/bin/env alone: the loader's variables, blanked
      expect(w.hostEnvs[i]).toEqual(LOADER_BLANK)
      expect(w.programPaths[i]).toBe(`/usr/bin/${w.runs[i]![0]}`)
      expect(w.wrappers[i]).toBe(boundScript(true, true))
    }
  })
  test('the launch words themselves: env -i, then the shell by absolute path, then the seconds, GNU timeout\'s path and the program', guard(), async ($, on) => {
    const { w } = fixture(on)
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/a.ts'] = 'b'
    await stop($)
    const words = w.launched.filter(argv => argv.includes('cockpit-bounded'))
    expect(words.length).toBeGreaterThan(20)
    for (const argv of words) {
      const at = argv.indexOf(CLEAN_SHELL)
      expect(argv.slice(0, 2)).toEqual([CLEAN_ENV, '-i'])
      expect(argv.slice(2, at).every(word => /^[A-Z_]+=/.test(word))).toBe(true)
      expect(argv.slice(at, at + 2)).toEqual([CLEAN_SHELL, '-c'])
      expect(argv[at + 3]).toBe('cockpit-bounded')
      expect(argv[at + 4]).toMatch(/^\d+$/)
      expect(argv[at + 5]).toBe('/usr/bin/timeout')
      expect(argv[at + 6]).toMatch(/^\/usr\/bin\/(?:git|stat|find|readlink|realpath)$/)
    }
  })
  test('PATH\'s empty and relative entries are never searched; Git is the one the clean shell finds on the rest', guard(), async ($, on) => {
    const { w, h } = fixture(on, { env: { PATH: './bin::/opt/git/bin:node_modules/.bin:/usr/bin:' }, programs: { git: '/opt/git/bin/git' } })
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/a.ts'] = 'b'
    await stop($)
    expect(w.launchProbes.filter(p => p[0] === 'resolve')).toEqual([['resolve', '/opt/git/bin:/usr/bin']])
    const gits = w.runs.map((r, i) => ({ r, path: w.programPaths[i], env: w.runEnvs[i] })).filter(x => x.r[0] === 'git' && x.path !== null)
    expect(gits.length).toBeGreaterThan(0)
    for (const x of gits) { expect(x.path).toBe('/opt/git/bin/git'); expect(x.env?.['PATH']).toBe('/opt/git/bin:/usr/bin') }
    expect(taskOf(h)?.startTree).toEqual(expect.any(String))                        // a measured tree
    expect(kept(h).filter(check => !check.complete)).toEqual([])
  })
  test('a PATH entry inside the repository is never passed on, though Git outside it still measures', guard(), async ($, on) => {
    const { w, h } = fixture(on, { env: { PATH: `${ROOT}/node_modules/.bin:/usr/bin:/bin` }, files: { [`${ROOT}/.git`]: '' } })
    await start($); await enroll($); await prompt($, 'tidy it')
    expect(taskOf(h)?.startTree).toEqual(expect.any(String))
    const paths = w.runEnvs.filter((_, i) => w.programPaths[i] !== null).map(env => env?.['PATH'])
    expect(paths.length).toBeGreaterThan(0)
    expect(new Set(paths)).toEqual(new Set(['/usr/bin:/bin']))
  })
  test('a session directory too deep to walk to the root refuses: the check never answers about part of the path', guard(), async ($, on) => {
    world(on, { cwd: `/${'d/'.repeat(300)}w` })
    await start($)
    expect(String((await command($, 'doctor')).text)).toContain('none starts here: whether a measurement program lies inside the repository could not be checked')
  })
  test('a file check that fails refuses: whether a program lies inside the repository is never assumed', guard(), async ($, on) => {
    const { w, h } = fixture(on, { failExists: true })
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/a.ts'] = 'b'
    await stop($)
    expect(kept(h).at(-1)?.summary).toContain('whether a measurement program lies inside the repository could not be checked')
  })
  test('outside a repository the check is made again: a .git made later, with Git inside it, refuses from then on', guard(), async ($, on) => {
    const { w, h } = fixture(on, { programs: { git: `${ROOT}/bin/git` } })
    await start($); await enroll($); await prompt($, 'tidy it')
    expect(taskOf(h)?.startTree).toEqual(expect.any(String))                        // no repository holds that Git yet
    w.files[`${ROOT}/.git`] = ''
    w.tree['src/a.ts'] = 'b'
    const from = w.runs.length
    await stop($)
    expect(kept(h).at(-1)?.summary).toContain(`${ROOT}/bin/git lies inside the repository`)
    expect(measured(w, from)).toEqual([])
  })
  test('the programs are found and checked once a load, not once a process', guard(), async ($, on) => {
    const { w } = fixture(on)
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/a.ts'] = 'b'
    await stop($); await stop($)
    expect(w.launchProbes).toEqual([['resolve', '/usr/bin:/bin'], ['id'], ['owners', 'gnu']])
  })
  test('XDG_CONFIG_HOME, where set, reaches Git with HOME, so it reads the global configuration the person\'s Git reads', guard(), async ($, on) => {
    const { w } = fixture(on, { env: { XDG_CONFIG_HOME: '/home/tester/.cfg' } })
    await start($); await enroll($); await prompt($, 'tidy it')
    const envs = w.runEnvs.filter((_, i) => w.programPaths[i] !== null)
    expect(envs.length).toBeGreaterThan(0)
    for (const env of envs) expect([env?.['HOME'], env?.['XDG_CONFIG_HOME']]).toEqual(['/home/tester', '/home/tester/.cfg'])
  })
  test('without GNU timeout no timeout path is given and the script has no group kill; BSD stat answers the owner check', guard(), async ($, on) => {
    const { w, h } = fixture(on, { programs: { timeout: null }, statFlavor: 'bsd' })
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/a.ts'] = 'b'
    await stop($)
    expect(w.launchProbes).toEqual([['resolve', '/usr/bin:/bin'], ['id'], ['owners', 'gnu'], ['owners', 'bsd']])
    expect(new Set(w.wrappers.filter((_, i) => w.programPaths[i] !== null))).toEqual(new Set([boundScript(true, false)]))
    expect(taskOf(h)?.startTree).toEqual(expect.any(String))
    expect(kept(h).filter(check => !check.complete)).toEqual([])
  })
})

// --- environments in which no measurement process starts ---

type Refusing = { name: string; set: Partial<World>; words: string }
const LAUNCH_REFUSED: Refusing[] = [
  ...GIT_ENV_MEASURED.map(name => ({ name: `${name} set`, set: { env: { [name]: name === 'GIT_CONFIG_COUNT' ? '1' : '/elsewhere' } }, words: `the environment sets ${name}` })),
  { name: 'a relative HOME', set: { env: { HOME: 'home' } }, words: 'HOME is not an absolute path' },
  { name: 'a relative XDG_CONFIG_HOME', set: { env: { XDG_CONFIG_HOME: 'cfg' } }, words: 'XDG_CONFIG_HOME is not an absolute path' },
  { name: 'a PATH with no absolute entry', set: { env: { PATH: '.:bin' } }, words: 'PATH has no absolute entry' },
  { name: 'no stat on PATH', set: { programs: { stat: null } }, words: 'stat was not found on an absolute PATH entry' },
  { name: 'a git of another user\'s', set: { owners: { '/usr/bin/git': { uid: 1001, mode: 0x81ed } } }, words: '/usr/bin/git is not a regular file owned by root or this user' },
  { name: 'a git writable by its group', set: { owners: { '/usr/bin/git': { uid: 0, mode: 0x81fd } } }, words: '/usr/bin/git is not a regular file' },
  { name: 'a git in a directory anyone can write to', set: { programs: { git: '/tmp/git' }, owners: { '/tmp': { uid: 0, mode: 0x43ff } } }, words: '/tmp/git is not a regular file' },
  { name: 'a /bin/sh writable by anyone', set: { realPaths: { '/bin/sh': '/usr/bin/dash' }, owners: { '/usr/bin/dash': { uid: 0, mode: 0x81ff } } }, words: '/usr/bin/dash is not a regular file' },
  { name: 'a user-owned git when the user cannot be told', set: { uid: null, owners: { '/usr/bin/git': { uid: 1000, mode: 0x81ed } } }, words: '/usr/bin/git is not a regular file owned by root and' },
  { name: 'a git that cannot be resolved to the file it is', set: { realPaths: { '/usr/bin/git': 'somewhere' } }, words: '/usr/bin/git could not be resolved' },
  { name: 'a git inside the repository', set: { programs: { git: `${ROOT}/bin/git` }, files: { [`${ROOT}/.git`]: '' } }, words: `${ROOT}/bin/git lies inside the repository` },
  { name: 'a git that is a link into the repository', set: { programs: { git: '/usr/local/bin/git' }, realPaths: { '/usr/local/bin/git': `${ROOT}/tools/git` }, files: { [`${ROOT}/.git`]: '' } }, words: `${ROOT}/tools/git lies inside the repository` },
  { name: 'a git inside an enclosing repository', set: { programs: { git: '/work/vendor/git' }, files: { '/work/.git': '' } }, words: '/work/vendor/git lies inside the repository' },
  // the session directory named through a link: its physical path's repository is checked too
  { name: 'a git inside the repository the session directory physically is', set: { programs: { git: '/data/example/bin/git' }, realPaths: { [ROOT]: '/data/example' }, files: { '/data/example/.git': '' } }, words: '/data/example/bin/git lies inside the repository' },
]
const merged = (set: Partial<World>): Partial<World> => ({ ...set, ...(set.files === undefined ? {} : { files: { ...set.files } }) })

describe('an environment Cockpit does not measure in: the Stop guard never verifies a tree there', () => {
  for (const refusing of LAUNCH_REFUSED) {
    test(`${refusing.name}: UNKNOWN with the reason, no measurement process starts, and the passing check is not verified`, guard(), async ($, on) => {
      const { w, h } = fixture(on, merged(refusing.set))
      await start($); await enroll($)
      const from = w.runs.length
      await prompt($, 'tidy it')
      expect(taskOf(h)?.startTree ?? null).toBeNull()                                // no baseline
      w.tree['src/a.ts'] = 'b'
      await stop($)
      const last = kept(h).at(-1)
      expect(last?.complete).toBe(false)
      expect(last?.summary).toContain(refusing.words)
      expect(taskOf(h)?.status).not.toBe('done')
      expect(measured(w, from)).toEqual([])
    })
  }
  test('control: the same fixture in an ordinary environment is measured and verified', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await start($); await enroll($); await prompt($, 'tidy it')
    expect(taskOf(h)?.startTree).toEqual(expect.any(String))
    w.tree['src/a.ts'] = 'b'
    await stop($)
    expect(kept(h).filter(check => !check.complete)).toEqual([])
  })
})

const REPRESENTATIVE = [LAUNCH_REFUSED[0]!, LAUNCH_REFUSED.find(r => r.name === 'a relative HOME')!, LAUNCH_REFUSED.find(r => r.name === 'no stat on PATH')!, LAUNCH_REFUSED.find(r => r.name === 'a git inside the repository')!]

describe('an environment Cockpit does not measure in: goal checks, the HUD, the release check, the Ledger and helpers', () => {
  for (const refusing of REPRESENTATIVE) {
    test(`${refusing.name}: a goal check claimed ALIGNED is recorded UNKNOWN, and the task does not reach DONE`, async ($, on) => {
      world(on, merged(refusing.set)); hostState(on, {})
      await start($)
      await prompt($, 'Add booking cancellation to the API and the UI')
      await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
      await planAndComplete($, 4)
      await passAllGates($, { align: false })
      const answer = await progress($, { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "cancel test 'frees the slot' passes in test/api.test.js (4 pass)" }] } })
      expect(answer).toStartWith('error: ALIGNED not accepted')
      expect(answer).toContain('recorded as UNKNOWN')
      expect(await progress($, { action: 'complete', milestone: 'm5' })).not.toStartWith('DONE')
    })
    test(`${refusing.name}: the HUD says not measured (environment), and a Stop with no task runs the check and holds the task`, guard(), async ($, on) => {
      const { w, h } = fixture(on, merged(refusing.set))
      await start($); await enroll($)
      const out = await stop($)
      expect(gitOf(h)?.refused).toBe('environment')
      expect(dirtyLabel(gitOf(h) ?? null)).toBe('not measured (environment)')
      expect(scriptRuns(w)).toBeGreaterThan(0)                                       // the check ran
      expect(out.block).toBeUndefined()
      expect(String((await command($, 'doctor')).text)).toContain(`WARN measurement processes start only with a clean environment, and none starts here: ${refusing.words}`)
    })
    test(`${refusing.name}: the release check names no candidate`, { options: { orchestration: true, profile: 'SONNET_LED' } }, async ($, on) => {
      world(on, merged(refusing.set)); hostState(on, {})
      await start($); await prompt($, 'Have Opus review the release candidate')
      await progress($, { action: 'plan', milestones: FIVE })
      for (const milestone of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone })
      for (const gate of GATE_NAMES) await progress($, { action: 'gate', gate, state: 'na', evidence: 'fixture' })
      const result = String((await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', action: 'consult', ground: 'release', objective: 'Release v0.6.6', architecture: 'Plugin hooks', locations: ['hooks/register.tsx'], risk: 'Candidate mismatch', question: 'Approve the release?' } as never)).result)
      expect(result).toContain('CANDIDATE UNKNOWN')
      expect(result).toContain('an environment in which Cockpit starts no measurement process')
    })
    test(`${refusing.name}: a helper's Git inspection is refused with the reason, and nothing is sent`, { options: { orchestration: true, maxSubagents: 32, maxSonnetAgents: 16, maxHaikuAgents: 24 } }, async ($, on) => {
      const w = world(on, merged(refusing.set))
      await start($)
      await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', action: 'assign', task_id: 'rev', tier: 'SONNET', role: 'REVIEW', objective: 'Review rev', scope: 'Scope rev', owned_resources: ['*'], mode: 'read', spawn_reason: 'Independent bounded review' } as never)
      const a = (await $.agent.spawn({ prompt: 'Review rev', description: '[task:rev] bounded review', subagentType: 'cobalt-cockpit:reviewer', tool_use_id: 'spawn-rev', parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true } as never)).agentId!
      const out = (await $.tool.call({ tool: 'Bash', agentId: a, command: 'git status' } as never)) as { deny?: string }
      expect(out.deny).toContain('SWARM / read-only Git inspection is refused here')
      // GIT_* names the helper's own list refuses first; the clean launch's own reasons otherwise
      expect(out.deny).toContain(refusing.name.endsWith(' set') ? `the environment sets ${refusing.name.slice(0, -4)}` : refusing.words)
      expect(w.ran.filter(call => call['tool'] === 'Bash')).toEqual([])
    })
  }
  test('the Run Ledger records a tree in such an environment as of unknown change count, never 0', () => {
    const git: GitState = { isRepo: true, project: 'example', branch: null, isDetached: false, sha: null, startSha: null, dirty: 0, ahead: null, behind: null, refused: 'environment', at: 1 }
    expect(checkpointOf(emptyLedger('s'), null, git, 0).dirty).toBe(UNKNOWN)
  })
  test('a helper\'s inspection starts as measurement does: Git on the trusted PATH, with HOME and XDG_CONFIG_HOME, by absolute path', { options: { orchestration: true, maxSubagents: 32, maxSonnetAgents: 16, maxHaikuAgents: 24 } }, async ($, on) => {
    const w = world(on, { env: { PATH: '.:/opt/git/bin:/usr/bin', XDG_CONFIG_HOME: '/home/tester/.cfg' }, programs: { git: '/opt/git/bin/git' } })
    await start($)
    await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', action: 'assign', task_id: 'rev', tier: 'SONNET', role: 'REVIEW', objective: 'Review rev', scope: 'Scope rev', owned_resources: ['*'], mode: 'read', spawn_reason: 'Independent bounded review' } as never)
    const a = (await $.agent.spawn({ prompt: 'Review rev', description: '[task:rev] bounded review', subagentType: 'cobalt-cockpit:reviewer', tool_use_id: 'spawn-rev', parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true } as never)).agentId!
    expect(((await $.tool.call({ tool: 'Bash', agentId: a, command: 'git log --oneline -3 | git status' } as never)) as { deny?: string }).deny).toBeUndefined()
    const sent = String(w.ran.find(call => call['tool'] === 'Bash')?.['command'])
    const start_ = ["'/usr/bin/env'", "'-i'", "'PATH=/opt/git/bin:/usr/bin'", "'HOME=/home/tester'", "'XDG_CONFIG_HOME=/home/tester/.cfg'", "'GIT_NO_LAZY_FETCH=1'", "'GIT_ALLOW_PROTOCOL=cockpit-none'", "'/opt/git/bin/git'", "'--no-pager'"].join(' ')
    // both commands of the pipeline, each from its own clean start
    expect(sent.split(' | ').map(part => part.startsWith(start_))).toEqual([true, true])
  })
})

// --- no Git at all: no Git call starts, and outside every repository that is a project without Git, as before ---

describe('no Git on the trusted PATH', () => {
  const claim = async ($: Engine): Promise<string> => {
    await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    return progress($, { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "cancel test 'frees the slot' passes in test/api.test.js (4 pass)" }] } })
  }
  test('outside every repository (no .git anywhere): ALIGNED as before, marked UNPROTECTED, and no Git call starts', async ($, on) => {
    const w = world(on, { programs: { git: null }, gitStatus: null }); hostState(on, {})
    const reply = await claim($)
    expect(reply).toContain('UNPROTECTED: this project is not a Git repository')
    expect(w.runs.filter((r, i) => r[0] === 'git' && w.programPaths[i] !== null)).toEqual([])
  })
  test('a .git is here: UNKNOWN, never taken for a project outside Git', async ($, on) => {
    const w = world(on, { programs: { git: null } }); hostState(on, {})
    const reply = await claim($)
    expect(reply).toContain('recorded as UNKNOWN')
    expect(reply).toContain('a Git repository is here')
    expect(w.runs.filter((r, i) => r[0] === 'git' && w.programPaths[i] !== null)).toEqual([])
  })
  test('a helper\'s inspection is refused, naming it', { options: { orchestration: true, maxSubagents: 32, maxSonnetAgents: 16, maxHaikuAgents: 24 } }, async ($, on) => {
    const w = world(on, { programs: { git: null } })
    await start($)
    await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', action: 'assign', task_id: 'rev', tier: 'SONNET', role: 'REVIEW', objective: 'Review rev', scope: 'Scope rev', owned_resources: ['*'], mode: 'read', spawn_reason: 'Independent bounded review' } as never)
    const a = (await $.agent.spawn({ prompt: 'Review rev', description: '[task:rev] bounded review', subagentType: 'cobalt-cockpit:reviewer', tool_use_id: 'spawn-rev', parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true } as never)).agentId!
    expect(((await $.tool.call({ tool: 'Bash', agentId: a, command: 'git status' } as never)) as { deny?: string }).deny).toContain('git was not found on an absolute PATH entry')
    expect(w.ran.filter(call => call['tool'] === 'Bash')).toEqual([])
  })
})

// --- the HUD after a failure before the repository is found (Stage A residual 9) ---

describe('the HUD never keeps a stale line after Git fails before the repository is found', () => {
  test('a line that counted a repository becomes not measured (state unreadable), never a stale clean', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await start($); await enroll($)
    await stop($)
    expect(dirtyLabel(gitOf(h) ?? null)).toBe('clean')                              // read in full first
    w.gitHangs = 'rev-parse --show-toplevel'
    await stop($)
    expect(gitOf(h)?.refused).toBe('unreadable')
    expect(dirtyLabel(gitOf(h) ?? null)).toBe('not measured (state unreadable)')
  })
  test('with no line before, a failure claims no repository: nothing is shown, and the Stop with no task still runs the check', guard(), async ($, on) => {
    const { w, h } = fixture(on, { gitHangs: 'rev-parse --show-toplevel' })
    await start($); await enroll($)
    await stop($)
    expect(gitOf(h) ?? null).toBeNull()
    expect(scriptRuns(w)).toBeGreaterThan(0)
  })
  test('control: outside every repository the line says no repo', guard(), async ($, on) => {
    const { h } = fixture(on, { gitStatus: null })
    await start($); await enroll($)
    await stop($)
    expect(dirtyLabel(gitOf(h) ?? null)).toBe('no repo')
  })
})

// --- the program list and the probe's own refusals ---

describe('the measurement programs found', () => {
  test('a clean shell that cannot answer the lookup: nothing starts, and it is asked again later', guard(), async ($, on) => {
    const { w, h } = fixture(on, { resolveOutput: 'garbled' })
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/a.ts'] = 'b'
    await stop($)
    expect(kept(h).at(-1)?.summary).toContain('the clean shell could not say where Git and the measurement programs are')
    w.resolveOutput = null
    await w.clock.advance(31_000)
    expect(String((await command($, 'doctor')).text)).toContain('OK   measurement processes start with a clean environment (/usr/bin/env -i; PATH, HOME and Cockpit\'s own settings, nothing else inherited), every program by absolute path; Git /usr/bin/git, found on 2 absolute PATH entries')
  })
})
