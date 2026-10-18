// v0.6.4 fingerprint resource hardening. A repository decided what the v0.6.3 fingerprint read: an untracked link to /dev/zero,
// an excludes or attributes file pointed at a device, a FIFO where Git expects a file. Measured with real Git under hard limits,
// each exhausted memory within a second or blocked until the host's timeout. Here, through the host: every measurement process
// starts under the limit script, nothing that is not an ordinary file is ever read, every limit ends in UNKNOWN with its reason,
// and an UNKNOWN never reads as a clean tree, a passing check or DONE. Each hazard has a control that still measures normally.
import { describe, expect, test } from 'claude-code/testing'
import { BOUND_PROBE_CAPPED, BOUND_PROBE_CONTROL, BOUND_PROBE_GROUP, BOUND_PROBE_SET, BOUND_SLOTS, FINGERPRINT_FILE_BYTES, GIT_BOUNDED, SOURCE_BYTES, boundScript, inspectedOf, kindOfMode } from '../hooks/git-integrity'
import type { Task } from '../types'
import { CLEAN_REPO, bash, blobOf, command, FIVE, GATE_NAMES, hostState, passAllGates, planAndComplete, progress, prompt, start, world } from './world'
import type { World } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 3, ...extra } })
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const checks = (w: World) => w.runs.filter(r => r[0] === SCRIPT).length
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')?.value as Task | null | undefined
const kept = (h: ReturnType<typeof hostState>) => ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: { complete: boolean; summary: string }[] }).stopChecks ?? []
/** A passing check script: a check that completes shows the tree was measured; one that cannot complete shows it was not. */
const fixture = (on: any) => {
  const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'

  return { w, h: hostState(on, {}) }
}
/** A task begun on a measured tree, ready for its Stop. */
const begun = async ($: any) => { await start($); await enroll($); await prompt($, 'tidy it') }
const MEASURING = ['git', 'stat', 'find', 'readlink', 'realpath']
/** Every path given to a reading `hash-object` (not --stdin, which reads a link's text from the plugin), as the plugin named it. */
const hashedPaths = (w: World) => w.runs.filter(r => r[0] === 'git' && r.includes('hash-object') && !r.includes('--stdin')).flatMap(r => r.slice(r.indexOf('--') + 1).map(p => p.replace(/^\.\//, '')))
const gitSubcommands = (w: World, from = 0) => w.runs.slice(from).filter(r => r[0] === 'git').map(r => { let at = 1; while (r[at] === '-c' || r[at] === '-C' || r[at]?.startsWith('--no-') || r[at] === '--literal-pathspecs') at += r[at] === '-c' || r[at] === '-C' ? 2 : 1; return r[at] })
/**
 * The Stop's own measurement was not believed: it is recorded as UNKNOWN with its reason. (A later measurement of a tree that
 * has settled is a new measurement, and may identify it; a one-time swap is not a lasting UNKNOWN.)
 */
const notBelieved = (h: ReturnType<typeof hostState>, why: string) => expect(kept(h).at(-1)?.summary).toContain(`[change detection unknown: ${why}`)
/** The Stop could not identify the tree: the passing check is not recorded as verified, and the reason is kept. */
const unidentified = (h: ReturnType<typeof hostState>, why: string) => {
  const last = kept(h).at(-1)
  expect(last?.complete).toBe(false)
  expect(last?.summary).toContain(why)
  expect(taskOf(h)?.guardDone).toBeUndefined()
  expect(taskOf(h)?.status).not.toBe('done')
}

describe('the limit script', () => {
  test('is one constant: memory, CPU, file size and no core, each only ever lowered, then exec of the words it is given', () => {
    const lower = 'lower() { c=$(ulimit "$1") || return 1; if [ "$c" = unlimited ] || [ "$c" -gt "$2" ]; then ulimit "$1" "$2"; fi; }'
    // v0.6.6 Stage B: GNU timeout by the absolute path it is given after the seconds, never looked up on PATH
    expect(boundScript(true, true)).toBe(`${lower} && lower -v 1048576 && lower -t 20 && lower -f 131072 && lower -c 0 && t=$1 && shift && k=$1 && shift && exec "$k" -s KILL "$t" "$@"`)
    expect(boundScript(false, false)).toBe(`${lower} && lower -t 20 && lower -f 131072 && lower -c 0 && t=$1 && shift && exec "$@"`)
    // no command word is ever interpolated: the probes and the script are fixed strings
    for (const s of [boundScript(true, true), boundScript(false, false), BOUND_PROBE_SET(true), BOUND_PROBE_CONTROL, BOUND_PROBE_CAPPED, BOUND_PROBE_GROUP]) expect(s).not.toMatch(/\$\{|`/)
    expect(GIT_BOUNDED).toContain('core.hooksPath=/dev/null')
    expect(GIT_BOUNDED).toContain('diff.orderFile=/dev/null')
  })
  test('inspection records are parsed strictly, in either stat form, and a kind comes from the mode alone', () => {
    expect(inspectedOf('81a4 12 7 1.5 1.5 ./a b', true)).toEqual({ kind: 'file', mode: 0x81a4, size: 12, identity: '81a4 12 7 1.5 1.5', name: './a b' })
    expect(inspectedOf('100644 12 7 1 1', false)?.kind).toBe('file')
    expect(inspectedOf('20666 0 7 1 1', false)?.kind).toBe('char')
    for (const bad of ['', '81a4 12 7 1.5 1.5', '81a4 12 7 1.5', '81a4 -1 7 1 1 a', 'zz 1 1 1 1 a', `81a4 ${'9'.repeat(30)} 1 1 1 a`]) expect(inspectedOf(bad, true)).toBeNull()
    for (const bad of ['100644 12 7 1 1 extra', '100644 12 7 1.5 1']) expect(inspectedOf(bad, false)).toBeNull()
    expect([0o100644, 0o120777, 0o040755, 0o010644, 0o140755, 0o020666, 0o060660].map(kindOfMode)).toEqual(['file', 'link', 'dir', 'fifo', 'socket', 'char', 'block'])
    expect(kindOfMode(0)).toBeNull()
  })
})

describe('every measurement process is bounded', () => {
  const busyTree = (w: World) => {
    w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
    w.untracked = ['notes.md', 'latest']; w.kinds['latest'] = 'link'
    w.ignoredEntries = ['.cache/x']
  }
  test('full: git, stat, find, readlink and realpath all start under the script, Git with the bounded settings', guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w)
    await begun($); w.tree['src/a.ts'] = 'b'; await stop($)
    const measuring = w.runs.map((r, i) => ({ r, script: w.wrappers[i], seconds: w.wrapperSeconds[i], env: w.runEnvs[i] })).filter(x => MEASURING.includes(x.r[0]!))
    expect(measuring.length).toBeGreaterThan(20)
    for (const x of measuring) {
      expect(x.script).toBe(boundScript(true, true))
      expect(x.seconds).toBe('5')                                                     // a second inside the host's 6 s
      expect(x.env?.['MALLOC_ARENA_MAX']).toBe('2')
      if (x.r[0] === 'git') expect(x.r.slice(1, 1 + GIT_BOUNDED.length)).toEqual(GIT_BOUNDED)
    }
    expect(measuring.some(x => x.r[0] === 'readlink')).toBe(true)
    // the limits are probed once for the registration, not once per process
    expect(w.boundProbes).toEqual([BOUND_PROBE_SET(true), BOUND_PROBE_GROUP, BOUND_PROBE_CONTROL, BOUND_PROBE_CAPPED])
  })
  test('full: only reading Git subcommands run, hash-object never writes an object, and nothing destructive is started', guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w)
    await begun($); w.tree['src/a.ts'] = 'b'; await stop($)
    const reading = new Set(['rev-parse', 'config', 'ls-tree', 'ls-files', 'check-attr', 'diff', 'hash-object', 'status'])
    expect(gitSubcommands(w).filter(s => !reading.has(s!))).toEqual([])
    expect(w.runs.some(r => r[0] === 'git' && r.includes('hash-object') && r.includes('-w'))).toBe(false)
    // v0.6.6: `--list` is the repository-state check's read of every configuration scope; still a read
    expect(w.runs.filter(r => r[0] === 'git' && r.includes('config')).every(r => r.some(a => a === '--get' || a === '--get-regexp' || a === '--list'))).toBe(true)
    expect(w.runs.filter(r => !MEASURING.includes(r[0]!) && r[0] !== SCRIPT)).toEqual([])
  })
  test('partial: where the memory cap is accepted but not enforced, it is still set, and doctor says it is not enforced', guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w); w.boundMode = 'partial'
    await begun($); await stop($)
    const scripts = new Set(w.wrappers.filter((_, i) => MEASURING.includes(w.runs[i]![0]!)))
    expect([...scripts]).toEqual([boundScript(true, true)])
    const out = String((await command($, 'doctor')).text)
    expect(out).toContain('WARN working-tree measurement runs under CPU 20 s, files written at most 64 MiB, no core dump, at most 2 at once, and a timeout that ends the process and every child it started; this platform does NOT enforce the memory limit it accepts')
    expect(out).toContain('a file Git reads on its own (a linked worktree\'s commondir, a configuration include, grafts, sparse-checkout) is bounded only by CPU time and the timeout')
  })
  test('basic: where no memory limit can be set, CPU, file size and core still apply', guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w); w.boundMode = 'basic'
    await begun($); await stop($)
    expect([...new Set(w.wrappers.filter((_, i) => MEASURING.includes(w.runs[i]![0]!)))]).toEqual([boundScript(false, true)])
    expect(String((await command($, 'doctor')).text)).toContain('no memory limit could be set here')
  })
  test('none: with no shell to set limits nothing is started, the tree is UNKNOWN with the reason, and doctor says measurement is off', guard(), async ($, on) => {
    const { w, h } = fixture(on); busyTree(w); w.boundMode = 'none'
    await begun($); await stop($)
    expect(w.runs.filter(r => MEASURING.includes(r[0]!))).toEqual([])            // refused before launch, never run unbounded
    unidentified(h, 'resource limits could not be applied here')
    // not once per process: one unanswered probe stands a while. v0.6.6 Stage B: two, not three: GNU timeout's probe needs the
    // path the clean shell finds it at, and a shell that does not answer finds none
    expect(w.boundProbes).toHaveLength(2)
    await w.clock.advance(31_000)
    expect(String((await command($, 'doctor')).text)).toContain('WARN working-tree measurement is OFF: no shell here could set kernel limits')
    expect(w.boundProbes).toHaveLength(4)                                           // and is then tried again
  })
  test('without GNU timeout the limits still apply, without the group kill, and doctor says a child may outlive a measurement', guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w); w.groupTimeout = false
    await begun($); await stop($)
    expect([...new Set(w.wrappers.filter((_, i) => MEASURING.includes(w.runs[i]![0]!)))]).toEqual([boundScript(true, false)])
    expect(String((await command($, 'doctor')).text)).toContain('WARN working-tree measurement runs under kernel limits: memory 1024 MiB, CPU 20 s, files written at most 64 MiB, no core dump, at most 2 at once, and the host\'s timeout; no GNU timeout here, so a child process a measurement starts may outlive it')
  })
  test(`concurrent measurements share ${BOUND_SLOTS} process slots: never more run at once, and every one completes`, guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w); w.runDelayTicks = 25
    await start($); await enroll($)
    await Promise.all(Array.from({ length: 6 }, (_, i) => prompt($, `burst ${i}`)))
    await Promise.all([stop($), command($, 'doctor'), progress($, { action: 'status' })])
    expect(w.peakRunning).toBe(BOUND_SLOTS)
  })
  test('a probe that does not answer lowers nothing: the memory limit is still set, and the probe runs again until it answers', guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w); w.boundMode = 'flaky'
    await begun($); await stop($)
    expect([...new Set(w.wrappers.filter((_, i) => MEASURING.includes(w.runs[i]![0]!)))]).toEqual([boundScript(true, true)])
    expect(String((await command($, 'doctor')).text)).toContain('whether the memory limit is enforced could not be confirmed')
    await w.clock.advance(31_000)
    expect(String((await command($, 'doctor')).text)).toContain('OK   working-tree measurement runs under kernel limits')
    expect(w.boundProbes.filter(p => p === BOUND_PROBE_CAPPED)).toHaveLength(2)    // once without an answer, once settled
  })
  test('full: doctor reports the enforced limits', async ($, on) => {
    world(on); await start($)
    expect(String((await command($, 'doctor')).text)).toContain('OK   working-tree measurement runs under kernel limits: memory 1024 MiB, CPU 20 s, files written at most 64 MiB, no core dump, at most 2 at once, and a timeout that ends the process and every child it started')
  })
})

describe('vector 1: an untracked symbolic link to an unbounded device', () => {
  const link = (w: World, name: string, target: string) => { if (!w.untracked.includes(name)) w.untracked.push(name); w.kinds[name] = 'link'; w.linkTargets[name] = target }
  test('a new link to /dev/zero is a change measured by its text: Git never reads what it leads to', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); link(w, 'link-zero', '/dev/zero')
    await stop($)
    expect(checks(w)).toBe(1)                                                      // a change, so the check ran
    expect(kept(h).at(-1)?.complete).toBe(true)                                    // and the tree was identified
    expect(hashedPaths(w)).not.toContain('link-zero')
    expect(w.runs.some(r => r[0] === 'readlink' && r.at(-1) === './link-zero')).toBe(true)
  })
  test('control: the same link, there at the prompt and unchanged, is no change', guard(), async ($, on) => {
    const { w } = fixture(on); link(w, 'link-zero', '/dev/zero'); link(w, 'link-fifo', '/tmp/fifo')
    await begun($)
    expect((await stop($)).block).toBeUndefined()
    expect(checks(w)).toBe(0)
    expect(hashedPaths(w).filter(p => p.startsWith('link-'))).toEqual([])
  })
  test('pointing an existing link somewhere else is a change', guard(), async ($, on) => {
    const { w } = fixture(on); link(w, 'current', 'v1.md')
    await begun($); link(w, 'current', '/dev/zero')
    await stop($)
    expect(checks(w)).toBe(1)
  })
  test('a FIFO, socket or device among the flagged paths is measured by its kind alone and never opened', guard(), async ($, on) => {
    const { w } = fixture(on)
    w.indexFlags = 'S pipe\0S sock\0S zero\0'; w.kinds = { pipe: 'fifo', sock: 'socket', zero: 'char' }
    await begun($)
    expect((await stop($)).block).toBeUndefined()                                // measured, and equal to the prompt's measurement
    expect(hashedPaths(w).filter(p => ['pipe', 'sock', 'zero'].includes(p))).toEqual([])
  })
  test('a flagged path that turns from a file into a FIFO is a change', guard(), async ($, on) => {
    const { w } = fixture(on); w.indexFlags = 'S pipe\0'
    await begun($)
    expect(hashedPaths(w)).toContain('pipe')                                        // read as a file at the prompt
    w.kinds.pipe = 'fifo'
    const from = w.runs.length
    await stop($)
    expect(checks(w)).toBe(1)
    expect(hashedPaths({ ...w, runs: w.runs.slice(from) })).not.toContain('pipe')  // never opened as a FIFO
  })
})

describe('vector 2: configuration redirecting an input to an unbounded device', () => {
  const cases: { name: string; set: (w: World) => void; why: string; read: string }[] = [
    { name: 'core.excludesFile = /dev/zero', set: w => { w.gitConfig['core.excludesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }, why: 'core.excludesFile is a character device, not an ordinary file', read: '/dev/zero' },
    { name: 'core.attributesFile = /dev/zero', set: w => { w.gitConfig['core.attributesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }, why: 'core.attributesFile is a character device', read: '/dev/zero' },
    { name: 'core.attributesFile = a FIFO', set: w => { w.gitConfig['core.attributesFile'] = '/tmp/attr-fifo'; w.kinds['/tmp/attr-fifo'] = 'fifo' }, why: 'core.attributesFile is a FIFO', read: '/tmp/attr-fifo' },
    { name: '.git/info/attributes linked to /dev/zero', set: w => { w.kinds['.git/info/attributes'] = 'link'; w.followKinds['.git/info/attributes'] = 'char' }, why: 'info/attributes is a character device', read: '.git/info/attributes' },
    { name: '.git/info/exclude linked to a block device', set: w => { w.kinds['.git/info/exclude'] = 'link'; w.followKinds['.git/info/exclude'] = 'block' }, why: 'info/exclude is a block device', read: '.git/info/exclude' },
    { name: 'objects/info/alternates linked to /dev/zero', set: w => { w.kinds['.git/objects/info/alternates'] = 'link'; w.followKinds['.git/objects/info/alternates'] = 'char' }, why: 'objects/info/alternates is a character device', read: '.git/objects/info/alternates' },
    { name: 'a 200 MB core.excludesFile', set: w => { w.gitConfig['core.excludesFile'] = '/home/tester/huge-ignore'; w.sizes['/home/tester/huge-ignore'] = 200_000_000 }, why: `core.excludesFile is larger than ${SOURCE_BYTES / 1024 / 1024} MiB`, read: '/home/tester/huge-ignore' },
  ]
  for (const c of cases) {
    test(`${c.name}: UNKNOWN with the reason, refused before any Git command that would read it`, guard(), async ($, on) => {
      const { w, h } = fixture(on)
      await begun($)
      c.set(w)
      const from = w.runs.length
      await stop($)
      unidentified(h, c.why)
      expect(hashedPaths({ ...w, runs: w.runs.slice(from) })).not.toContain(c.read)
      // the listing, diffing, attribute and status commands that would read it never started
      expect(gitSubcommands(w, from).filter(s => ['ls-files', 'diff', 'check-attr', 'status', 'ls-tree', 'hash-object'].includes(s!))).toEqual([])
    })
  }
  test('diff.orderFile = /dev/zero: every Git command the plugin starts overrides it, so nothing reads it', guard(), async ($, on) => {
    const { w } = fixture(on)
    await begun($); w.gitConfig['diff.orderFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char'; w.watched['x'] = ''
    await stop($)
    const gits = w.runs.filter(r => r[0] === 'git')
    expect(gits.length).toBeGreaterThan(10)
    for (const r of gits) expect(r[r.indexOf('diff.orderFile=/dev/null') - 1]).toBe('-c')
    for (const r of gits.filter(r => r.includes('diff'))) expect(r).toContain('-O/dev/null')
  })
  test('a configuration Git cannot read in time is UNKNOWN, never a missing setting', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.gitHangs = 'config'
    await stop($)
    unidentified(h, 'git raised an error or timed out')
  })
  test('control: ordinary excludes and attributes files, kept as links to regular files, still measure, and editing one is a change', guard(), async ($, on) => {
    const { w } = fixture(on)
    w.gitConfig['core.excludesFile'] = '/home/tester/.gitignore_global'; w.kinds['/home/tester/.gitignore_global'] = 'link'; w.excludes = 'dist/\n'
    await begun($)
    expect((await stop($)).block).toBeUndefined()
    expect(checks(w)).toBe(0)
    w.excludes = 'dist/\nsecret.txt\n'
    await prompt($, 'again'); w.excludes = 'dist/\nsecret.txt\ncache/\n'
    await stop($)
    expect(checks(w)).toBe(1)
  })
  for (const device of [false, true]) {
    test(`the release check ${device ? 'refuses a candidate while an attributes file is a device' : 'admits the same clean candidate (control)'}`, { options: { orchestration: true, profile: 'SONNET_LED' } }, async ($, on) => {
      const w = world(on); hostState(on, {})
      w.headBlobs.a = blobOf('original'); w.watched.a = 'original'; w.indexFlags = 'H a\0'
      w.gitFilterConfig = 'filter.lfs.process\ngit-lfs filter-process\0'; w.gitFilterAttributes = 'a\0filter\0unspecified\0'
      if (device) { w.gitConfig['core.attributesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }
      const answer = await admit($)
      if (!device) { expect(answer).toContain('OPUS ADMITTED'); expect(gitSubcommands(w)).toContain('check-attr'); return }
      expect(answer).not.toContain('OPUS ADMITTED')
      expect(gitSubcommands(w).filter(s => s === 'check-attr')).toEqual([])
    })
  }
})

describe('vector 3: FIFOs and other non-regular Git metadata', () => {
  // Real Git blocks on a FIFO .gitignore, .gitattributes, HEAD, index or config until it is killed (reproduced); the host's
  // timeout kills it. Here the timeout is what the plugin sees, and it must read as UNKNOWN.
  // A FIFO .gitignore blocks the listings that read it, the untracked ones (`ls-files -o`); since v0.6.6 the index's stage listing
  // runs first, and reads no .gitignore.
  for (const [what, sub] of [['a FIFO .gitignore', 'ls-files -o'], ['a FIFO HEAD', 'rev-parse'], ['a FIFO .gitattributes', 'check-attr'], ['a FIFO index', 'diff']] as const) {
    test(`${what} blocks git ${sub} until the host's timeout: UNKNOWN, never clean`, guard(), async ($, on) => {
      const { w, h } = fixture(on)
      await begun($); w.gitHangs = sub
      // attributes are checked for a configured filter driver (an installed LFS, say)
      if (sub === 'check-attr') { w.gitFilterConfig = 'filter.lfs.process\ngit-lfs filter-process\0'; w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a' }
      await stop($)
      unidentified(h, 'git raised an error or timed out')
    })
  }
  test('a configured excludes file that is a FIFO is refused before Git opens it', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.gitConfig['core.excludesFile'] = '/tmp/pipe'; w.kinds['/tmp/pipe'] = 'fifo'
    await stop($)
    unidentified(h, 'core.excludesFile is a FIFO, not an ordinary file')
  })
  for (const kind of ['fifo', 'socket', 'char', 'block', 'dir'] as const) {
    test(`a tracked file replaced by a ${kind} is never read: UNKNOWN`, guard(), async ($, on) => {
      const { w, h } = fixture(on); w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
      await begun($); w.kinds['src/a.ts'] = kind
      const from = w.runs.length
      await stop($)
      unidentified(h, 'a tracked path is not an ordinary file or symbolic link')
      expect(hashedPaths({ ...w, runs: w.runs.slice(from) })).not.toContain('src/a.ts')
    })
  }
  test('a watched path that is a FIFO is never read: UNKNOWN', guard({ stopWatch: 'config/pipe' }), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.kinds['config/pipe'] = 'fifo'
    await stop($)
    unidentified(h, 'the watched path config/pipe is a FIFO, which is never read')
  })
})

describe('limits: sizes, totals, output and time', () => {
  test('an untracked file over 1 GiB is not read: UNKNOWN with the reason', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.untracked = ['big.bin']; w.sizes['big.bin'] = FINGERPRINT_FILE_BYTES + 1
    await stop($)
    unidentified(h, 'a file is larger than 1 GiB')
    expect(hashedPaths(w)).not.toContain('big.bin')
  })
  test('a tracked file over 1 GiB is not read: UNKNOWN with the reason', guard(), async ($, on) => {
    const { w, h } = fixture(on); w.headBlobs['data.bin'] = blobOf('d'); w.watched['data.bin'] = 'd'
    await begun($); w.sizes['data.bin'] = 2 * FINGERPRINT_FILE_BYTES
    await stop($)
    unidentified(h, 'a tracked file is larger than 1 GiB')
  })
  test('more than 8 GiB to read in all is UNKNOWN, though each file is within its own bound', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($)
    w.untracked = Array.from({ length: 9 }, (_, i) => `part${i}.bin`)
    for (const name of w.untracked) w.sizes[name] = FINGERPRINT_FILE_BYTES
    await stop($)
    unidentified(h, 'more than 8 GiB to read')
    expect(hashedPaths(w).filter(p => p.startsWith('part'))).toEqual([])
  })
  test('control: files within both bounds are read and measured', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($)
    w.untracked = ['a.bin', 'b.bin']; w.sizes['a.bin'] = FINGERPRINT_FILE_BYTES; w.sizes['b.bin'] = 1024
    await stop($)
    expect(kept(h).at(-1)?.complete).toBe(true)
    expect(hashedPaths(w)).toContain('a.bin')
  })
  test('a listing cut short by the host\'s output limit is UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.gitTruncates = 'ls-files'
    await stop($)
    unidentified(h, 'cut short')
  })
  test('hashing that runs past the host\'s timeout is UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.untracked = ['slow.bin']; w.gitHangs = 'hash-object'
    await stop($)
    unidentified(h, 'git raised an error or timed out')
  })
  test('a whole measurement past its deadline is UNKNOWN, never a partial answer', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($)
    w.untracked = Array.from({ length: 900 }, (_, i) => `gen/f${i}.ts`)
    w.duringRun = async argv => { if (argv[0] === 'stat' && argv.includes('-L') === false && argv.some(a => a.startsWith('./gen/'))) await w.clock.advance(31_000) }
    await stop($)
    unidentified(h, 'measuring the working tree took longer than 90s')
  })
})

describe('a file swapped while it is measured is not believed', () => {
  const swapDuringHash = (w: World, path: string, swap: () => void) => {
    let done = false
    w.duringRun = argv => { if (!done && argv[0] === 'git' && argv.includes('hash-object') && argv.some(a => a === path || a === `./${path}`)) { done = true; swap() } }
  }
  test('an untracked file replaced by a link to a device between inspection and read: UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.untracked = ['swap.txt']
    swapDuringHash(w, 'swap.txt', () => { w.kinds['swap.txt'] = 'link'; w.linkTargets['swap.txt'] = '/dev/zero' })
    await stop($)
    notBelieved(h, 'a file changed while it was being measured')
    // measured again once it settled: a link, by its text; what it leads to is never read
    expect(hashedPaths(w).filter(p => p === 'swap.txt')).toHaveLength(1)
  })
  test('a tracked file rewritten (new inode) while it is read: UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on); w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
    await begun($)
    swapDuringHash(w, 'src/a.ts', () => { w.inodes['src/a.ts'] = 99 })
    await stop($)
    notBelieved(h, 'a tracked file changed while it was being measured')
  })
  test('an excludes file replaced by a link to a device after it was checked: UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($)
    swapDuringHash(w, '.git/info/exclude', () => { w.kinds['.git/info/exclude'] = 'link'; w.followKinds['.git/info/exclude'] = 'char' })
    await stop($)
    notBelieved(h, 'the excludes or attributes files: a file changed while it was being measured')
    unidentified(h, 'info/exclude is a character device')                         // and once it settled on a device, never measured
  })
  test('a tracked file rewritten in place (same size and inode, new modification time) while it is read: UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on); w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
    await begun($)
    swapDuringHash(w, 'src/a.ts', () => { w.mtimes['src/a.ts'] = '2.000000000' })
    await stop($)
    notBelieved(h, 'a tracked file changed while it was being measured')
  })
  test('the release check: a changed file swapped while it is re-read is no candidate', { options: { orchestration: true, profile: 'SONNET_LED' } }, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('line\n'); w.watched.a = 'line\r\n'; w.normalized.a = 'line\n'; w.indexFlags = 'H a\0'
    w.duringRun = argv => { if (argv[0] === 'git' && argv.includes('hash-object') && !argv.includes('--no-filters')) w.inodes.a = (w.inodes.a ?? 1) + 1 }
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
})

describe('an unmeasurable tree never keeps a goal check or a passing check', () => {
  const aligned = { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "cancel test 'frees the slot' passes in test/api.test.js (4 pass)" }] } }
  const toDone = async ($: any) => {
    await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    expect(await progress($, aligned)).toContain('alignment ALIGNED')
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
  }
  const unmeasurable = (w: World) => { w.gitConfig['core.excludesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }
  test('DONE on a measured tree is withdrawn when the tree can no longer be measured', async ($, on) => {
    const w = world(on); await toDone($)
    unmeasurable(w)
    const status = await progress($, { action: 'status' })
    expect(status).not.toStartWith('DONE')
    expect(status).toContain('TEST pending')
  })
  test('a transient failure counts the same: it is not a clean tree', async ($, on) => {
    const w = world(on); await toDone($)
    w.gitHangs = 'diff'
    const status = await progress($, { action: 'status' })
    expect(status).not.toStartWith('DONE')
    expect(status).toContain('TEST pending')
  })
  test('one file changing while it is read is measured once more: a settled, unchanged tree keeps DONE', async ($, on) => {
    const w = world(on); w.untracked = ['notes.md']; await toDone($)
    let swaps = 0
    w.duringRun = argv => { if (swaps === 0 && argv[0] === 'git' && argv.includes('hash-object') && argv.includes('./notes.md')) { swaps++; w.inodes['notes.md'] = 2 } }
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
    expect(swaps).toBe(1)
  })
  test('a file that changes at every read is not settled: DONE is withdrawn', async ($, on) => {
    const w = world(on); w.untracked = ['notes.md']; await toDone($)
    w.duringRun = argv => { if (argv[0] === 'git' && argv.includes('hash-object') && argv.includes('./notes.md')) w.inodes['notes.md'] = (w.inodes['notes.md'] ?? 1) + 1 }
    const status = await progress($, { action: 'status' })
    expect(status).not.toStartWith('DONE')
    expect(status).toContain('TEST pending')
  })
  test('control: a measured tree that did not change keeps DONE', async ($, on) => {
    world(on); await toDone($)
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
  })
  test('align is refused when the checks were observed on a measured tree and the tree can no longer be measured', async ($, on) => {
    const w = world(on); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    unmeasurable(w)
    const refused = await progress($, aligned)
    expect(refused).toStartWith('error: ALIGNED refused')
    expect(refused).toContain('the working tree can no longer be measured (core.excludesFile is a character device')
    expect(await progress($, { action: 'status' })).toContain('TEST pending')
    // checks observed again on the unmeasurable tree: a repository is here, so the goal check is recorded UNKNOWN, never accepted
    await passAllGates($, { align: false })
    const again = await progress($, aligned)
    expect(again).toStartWith('error: ALIGNED not accepted')
    expect(again).toContain('recorded as UNKNOWN')
    expect(again).toContain('core.excludesFile is a character device')
  })
  test('a passing command seen on an unmeasurable tree stales the checks observed on a measured one', async ($, on) => {
    const w = world(on); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    w.gitHangs = 'diff'                                                            // nothing measurable changed: only measuring failed
    await bash($, 'npm test')
    const status = await progress($, { action: 'status' })
    expect(status).toContain('CODE pending')
  })
  test('control: a passing command on the same measured tree keeps the other checks', async ($, on) => {
    world(on); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    await bash($, 'npm test')
    expect(await progress($, { action: 'status' })).toContain('CODE pass')
  })
})

describe('inspection reads the system\'s answer, not the path', () => {
  test('the stamp is a commit, a count, a 128-bit SHA-256 digest and the project', guard(), async ($, on) => {
    const { h } = fixture(on)
    await begun($)
    expect(taskOf(h)?.startTree).toMatch(/^[0-9a-f]{40}:\d+\.[0-9a-f]{32}@[0-9a-f]{32}$/)
  })
  test('a batch with one missing and one unreadable path is not all "missing": UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($)
    w.untracked = ['a.txt', 'b.txt', 'c.txt']; w.kinds['b.txt'] = 'missing'; w.watchedDenied = ['c.txt']
    await stop($)
    unidentified(h, 'a changed or untracked path could not be inspected')
  })
  test('GNU stat -f (file-system status) is not taken for the BSD form of an ignored entry: UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on); w.ignoredEntries = ['.cache/a', '.cache/b']
    await begun($); w.statFileSystem = true
    await stop($)
    unidentified(h, 'ignored entries could not be measured')
  })
  test('a nested repository named like "No such file or directory" that cannot be listed is UNKNOWN, not vanished', guard(), async ($, on) => {
    const name = 'x: No such file or directory'
    const { w, h } = fixture(on)
    await begun($); w.embeddedRepos[`${name}/`] = []; w.watchedDenied = [`/work/example/${name}`]
    await stop($)
    unidentified(h, 'exists but could not be listed in full')
  })
  test('a tracked path whose name reads like "No such file or directory", but cannot be inspected, is UNKNOWN, not a deletion', guard(), async ($, on) => {
    const name = 'd/x: No such file or directory'
    const { w, h } = fixture(on); w.headBlobs[name] = blobOf('x'); w.watched[name] = 'x'
    await begun($); w.watchedDenied = [name]
    await stop($)
    unidentified(h, 'tracked files could not be inspected completely')
  })
  test('deleted tracked files cost one stat for the batch, not one each', guard(), async ($, on) => {
    const { w } = fixture(on)
    for (let i = 0; i < 60; i++) { w.headBlobs[`gone/f${i}.ts`] = blobOf('x'); w.watched[`gone/f${i}.ts`] = 'x' }
    await begun($)
    for (let i = 0; i < 60; i++) w.kinds[`gone/f${i}.ts`] = 'missing'
    const before = w.inspectCalls
    await stop($)
    expect(checks(w)).toBe(1)                                                        // 60 deletions: a change, measured
    expect(w.inspectCalls - before).toBeLessThan(20)
  })
  test('a linked worktree: Git\'s own files are where Git says, outside the work tree, and are checked there', guard(), async ($, on) => {
    const { w, h } = fixture(on); w.gitPathBase = '/work/main/.git/'
    await begun($)
    expect((await stop($)).block).toBeUndefined()                                 // measured, unchanged
    w.kinds['/work/main/.git/info/attributes'] = 'link'; w.followKinds['/work/main/.git/info/attributes'] = 'char'
    await prompt($, 'again'); w.tree['a.ts'] = 'changed'
    await stop($)
    unidentified(h, 'info/attributes is a character device')
  })
})

describe('a Git repository that cannot be measured is never accepted as protected', () => {
  const aligned = { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "cancel test 'frees the slot' passes in test/api.test.js (4 pass)" }] } }
  /** A goal-checked task with every gate recorded, ready for its goal check. */
  const ready = async ($: any) => {
    await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
  }
  const recordedUnknown = async ($: any, why: string, h: ReturnType<typeof hostState>) => {
    const reply = await progress($, aligned)
    expect(reply).toStartWith('error: ALIGNED not accepted')
    expect(reply).toContain('recorded as UNKNOWN, not ALIGNED')
    expect(reply).toContain(why)
    const status = await progress($, { action: 'status' })
    expect(status).toContain('alignment UNKNOWN (working tree UNKNOWN:')
    expect(status).not.toStartWith('DONE')
    expect(await progress($, { action: 'complete', milestone: 'm5' })).not.toStartWith('DONE')
    // a failed measurement is neither a clean tree nor a changed one
    expect(taskOf(h)?.alignment?.tree).toBeUndefined()
    expect(taskOf(h)?.edited).not.toBe(true)
    expect(reply).not.toContain('working tree changed')
  }
  test('a repository whose measurement always fails: UNKNOWN, never ALIGNED', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitHangs = 'diff'
    await ready($)
    await recordedUnknown($, 'git raised an error or timed out', h)
  })
  test('a repository with unsafe metadata: UNKNOWN, naming it', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitConfig['core.excludesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char'
    await ready($)
    await recordedUnknown($, 'core.excludesFile is a character device', h)
  })
  test('a repository with an oversized tracked file: UNKNOWN, naming it', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.headBlobs['data.bin'] = blobOf('d'); w.watched['data.bin'] = 'd'; w.sizes['data.bin'] = 2 * FINGERPRINT_FILE_BYTES
    await ready($)
    await recordedUnknown($, 'a tracked file is larger than 1 GiB', h)
  })
  test('a repository with no commit yet is a repository: UNKNOWN until its first commit', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.head = ''
    await ready($)
    await recordedUnknown($, 'no commit to measure against', h)
  })
  test('a damaged repository (Git says "not a git repository" but .git is there) is not taken for a project outside Git', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.dotGitPresent = true
    await ready($)
    await recordedUnknown($, 'a Git repository is here', h)
  })
  test('a project outside Git: ALIGNED as before, marked UNPROTECTED in the reply and the status, and DONE is reachable', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null
    await ready($)
    const reply = await progress($, aligned)
    expect(reply).toContain('alignment ALIGNED')
    expect(reply).toContain('UNPROTECTED: this project is not a Git repository, so no working-tree fingerprint protects this goal check')
    expect(taskOf(h)?.alignment?.protection).toEqual({ state: 'UNPROTECTED', why: 'this project is not a Git repository' })
    const done = await progress($, { action: 'complete', milestone: 'm5' })
    expect(done).toStartWith('DONE 100%')
    expect(done).toContain('alignment ALIGNED (UNPROTECTED: not a Git repository, no working-tree fingerprint)')
  })
  test('a repository that becomes measurable again is accepted as protected, and a later change withdraws it', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitConfig['core.excludesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char'
    await ready($)
    expect(await progress($, aligned)).toContain('recorded as UNKNOWN')
    delete w.gitConfig['core.excludesFile']
    const reply = await progress($, aligned)
    expect(reply).toContain('alignment ALIGNED')
    expect(reply).not.toContain('UNPROTECTED')
    expect(typeof taskOf(h)?.alignment?.tree).toBe('string')
    expect(taskOf(h)?.alignment?.protection).toBeUndefined()
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    w.tree['src/api.js'] = 'changed by a tool nothing watches'
    expect(await progress($, { action: 'status' })).not.toStartWith('DONE')
  })
  test('a task begun in a measured repository is not made UNPROTECTED by the repository going away', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await ready($)
    expect(typeof taskOf(h)?.startTree).toBe('string')                              // the baseline was measured in the repository
    w.gitStatus = null                                                               // .git removed: Git now says "not a git repository"
    expect(await progress($, aligned)).toStartWith('error: ALIGNED refused')         // checks were observed on the measured tree
    await passAllGates($, { align: false })
    await recordedUnknown($, 'this task began in a Git repository that is no longer there', h)
  })
  test('a task begun in a repository that could not be measured is not made UNPROTECTED by removing it either', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitConfig['core.excludesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char'
    await ready($)
    expect(taskOf(h)?.startTree).toBeNull()                                          // no baseline could be measured
    expect(taskOf(h)?.repoSeen).toBe(true)                                           // but a repository was seen
    delete w.gitConfig['core.excludesFile']; w.gitStatus = null                      // the repository is removed
    await recordedUnknown($, 'this task began in a Git repository that is no longer there', h)
  })
  test('a project outside Git whose first look failed is not marked as a repository: once Git answers, UNPROTECTED', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.gitHangs = 'rev-parse'
    await ready($)
    expect(taskOf(h)?.repoSeen).toBeUndefined()                                      // a failure is no evidence of a repository
    w.gitHangs = null
    expect(await progress($, aligned)).toContain('UNPROTECTED: this project is not a Git repository')
  })
  for (const [what, exit, stderr] of [
    ['the group timeout ended Git (124)', 124, ''],
    ['a signal ended Git', 137, ''],
    ['the address-space limit ended Git without its own message', 134, 'terminate called after throwing an instance of std::bad_alloc\n'],
  ] as const) {
    test(`outside Git, ${what} at the first look: no evidence of a repository, and UNPROTECTED once Git answers`, async ($, on) => {
      const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.notRepositoryExit = exit; w.notRepository = stderr
      await ready($)
      expect(taskOf(h)?.repoSeen).toBeUndefined()
      w.notRepositoryExit = 128; w.notRepository = 'fatal: not a git repository (or any of the parent directories): .git\n'
      expect(await progress($, aligned)).toContain('UNPROTECTED: this project is not a Git repository')
    })
  }
  test('with no Git installed, a project with no .git anywhere is outside Git: UNPROTECTED', async ($, on) => {
    const w = world(on); w.gitStatus = null; w.notRepositoryExit = 127; w.notRepository = 'cockpit-bounded: 1: exec: git: not found\n'
    await ready($)
    expect(await progress($, aligned)).toContain('UNPROTECTED: this project is not a Git repository')
  })
  test('with no Git installed, a .git in the directory makes it a repository that cannot be measured: UNKNOWN', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.dotGitPresent = true; w.notRepositoryExit = 127; w.notRepository = 'cockpit-bounded: 1: exec: git: not found\n'
    await ready($)
    await recordedUnknown($, 'a Git repository is here', h)
  })
  test('a fatal error of Git\'s with no .git anywhere (memory under the limit) is no evidence of a repository', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.notRepository = 'fatal: Out of memory, realloc failed\n'
    await ready($)
    expect(taskOf(h)?.repoSeen).toBeUndefined()
    await recordedUnknown($, 'Git could not say whether this is a Git repository', h)
  })
  test('the same error with a .git there (a linked worktree whose commondir hit the limit) is a repository', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.dotGitPresent = true; w.notRepository = 'fatal: Out of memory, realloc failed\n'
    await ready($)
    expect(taskOf(h)?.repoSeen).toBe(true)
    await recordedUnknown($, 'a Git repository is here', h)
  })
  test('a .git that cannot be inspected is not "missing": UNKNOWN, not outside Git', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.watchedDenied = ['/work/example/.git']
    await ready($)
    await recordedUnknown($, 'Git could not say whether this is a Git repository', h)
  })
  test('a session directory realpath cannot resolve is not called outside Git', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.realpathFails = true
    await ready($)
    await recordedUnknown($, 'Git could not say whether this is a Git repository', h)
  })
  test('outside Git, then `git init` in the same task: the UNPROTECTED goal check is pending again', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null
    await ready($)
    await progress($, aligned)
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    w.gitStatus = CLEAN_REPO                                                         // a repository appears where there was none
    expect(await progress($, { action: 'status' })).not.toStartWith('DONE')
    expect(taskOf(h)?.repoSeen).toBe(true)
    expect(taskOf(h)?.alignment?.state).not.toBe('ALIGNED')
    expect(taskOf(h)?.edited).not.toBe(true)                                       // a repository appearing is not an edit
  })
  test('outside Git, a later look that cannot answer is no evidence: the UNPROTECTED goal check stands', async ($, on) => {
    const w = world(on); w.gitStatus = null
    await ready($)
    await progress($, aligned)
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    w.notRepositoryExit = 124; w.notRepository = ''                                // the group timeout ended Git: no answer either way
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
  })
  test('control: outside Git and still outside, the UNPROTECTED goal check stands', async ($, on) => {
    const w = world(on); w.gitStatus = null
    await ready($)
    await progress($, aligned)
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
  })
  test('a session directory deeper than the walk is not called outside Git', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.cwd = `/${Array.from({ length: 300 }, (_, i) => `d${i}`).join('/')}`
    await ready($)
    // v0.6.6 Stage B: the clean start's own walk for a repository holding a measurement program has the same bound, and refuses
    // first, before any Git runs: UNKNOWN still, with that reason
    await recordedUnknown($, 'whether a measurement program lies inside the repository could not be checked', h)
  })
  for (const [what, set, why] of [
    ['a .git in a parent directory', (w: World) => { w.kinds['/work/.git'] = 'dir' }, 'a Git repository is here'],
    ['a .git that is a symbolic link', (w: World) => { w.kinds['.git'] = 'link' }, 'a Git repository is here'],
    ['a session directory named through a link, with a .git above its physical path', (w: World) => { w.cwd = '/link/proj'; w.links['/link'] = '/real'; w.kinds['/real/.git'] = 'dir' }, 'a Git repository is here'],
  ] as const) {
    test(`Git says "not a git repository", but ${what}: UNKNOWN, not outside Git`, async ($, on) => {
      const w = world(on); const h = hostState(on, {}); w.gitStatus = null; set(w)
      await ready($)
      await recordedUnknown($, why, h)
    })
  }
  test('Git\'s other wording outside a repository (a file-system boundary) is outside Git too: UNPROTECTED', async ($, on) => {
    const w = world(on); w.gitStatus = null
    w.notRepository = 'fatal: not a git repository (or any parent up to mount point /work)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n'
    await ready($)
    expect(await progress($, aligned)).toContain('UNPROTECTED: this project is not a Git repository')
  })
  test('a repository Git refuses (another owner), with its .git there: a repository, UNKNOWN', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.dotGitPresent = true
    w.notRepository = "fatal: detected dubious ownership in repository at '/work/example'\n"
    await ready($)
    expect(taskOf(h)?.repoSeen).toBe(true)
    await recordedUnknown($, 'a Git repository is here', h)
  })
  for (const [what, exit, stderr] of [
    ['another message of Git\'s', 128, "fatal: detected dubious ownership in repository at '/elsewhere'\n"],
    ['Git\'s "not a git repository" with a line more', 128, 'fatal: not a git repository (or any of the parent directories): .git\nhint: something else\n'],
    ['exit 128 without Git\'s fatal', 128, 'not a git repository\n'],
    ['exit 127 for another program (timeout missing)', 127, 'cockpit-bounded: 1: exec: timeout: not found\n'],
  ] as const) {
    test(`with no .git anywhere, ${what} is neither outside Git nor a repository: UNKNOWN, no mark`, async ($, on) => {
      const w = world(on); const h = hostState(on, {}); w.gitStatus = null; w.notRepositoryExit = exit; w.notRepository = stderr
      await ready($)
      expect(taskOf(h)?.repoSeen).toBeUndefined()
      await recordedUnknown($, 'Git could not say whether this is a Git repository', h)
    })
  }
  for (const outside of [true, false]) {
    test(`a goal check stored before v0.6.4 as ALIGNED without a fingerprint is ${outside ? 'kept outside Git, marked UNPROTECTED' : 'pending again in a repository that cannot be measured'}`, async ($, on) => {
      const w = world(on); const h = hostState(on, {}); w.gitStatus = null
      await ready($)
      await progress($, aligned)
      expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
      // as v0.6.3 stored it: ALIGNED, no tree, no protection note
      const held = h.get('task')!
      const { protection: _p, ...legacy } = (held.value as Task).alignment!
      h.set('task', { value: { ...(held.value as Task), alignment: legacy }, version: held.version + 1 })
      if (!outside) { w.gitStatus = CLEAN_REPO; w.gitConfig['core.excludesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }
      const status = await progress($, { action: 'status' })
      if (outside) {
        expect(status).toStartWith('DONE 100%')
        expect(taskOf(h)?.alignment?.protection?.state).toBe('UNPROTECTED')
      } else {
        expect(status).not.toStartWith('DONE')
        expect(taskOf(h)?.alignment?.state).not.toBe('ALIGNED')
      }
    })
  }
  test('measurements that fail by throwing give their slots back: later measurements run, and never more than two at once', guard(), async ($, on) => {
    const { w } = fixture(on); w.runDelayTicks = 10
    await start($); await enroll($)
    w.gitHangs = 'diff'
    await Promise.all(Array.from({ length: 5 }, (_, i) => prompt($, `hang ${i}`)))
    w.gitHangs = null
    const before = w.runs.length
    await stop($)                                                                    // a Stop measures the tree, here twice
    expect(w.runs.filter((r, i) => i >= before && r[0] === 'git').length).toBeGreaterThan(5)   // not stalled behind lost slots
    expect(w.peakRunning).toBeLessThanOrEqual(BOUND_SLOTS)
  })
  test('a claim other than ALIGNED is recorded as given, with no fingerprint to judge', async ($, on) => {
    const w = world(on); w.gitHangs = 'diff'
    await ready($)
    const reply = await progress($, { action: 'align', alignment: { state: 'PARTIAL', demonstrated: [], missing: ['UI not done'] } })
    expect(reply).not.toStartWith('error')
    expect(await progress($, { action: 'status' })).toContain('alignment PARTIAL')
  })
})

describe('ordinary repositories keep working', () => {
  const ordinary = (w: World) => {
    w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
    w.headBlobs['src/b.ts'] = blobOf('b'); w.watched['src/b.ts'] = 'b'
    w.headBlobs['docs/current'] = blobOf('v1.md'); w.headModes['docs/current'] = '120000'; w.kinds['docs/current'] = 'link'; w.linkTargets['docs/current'] = 'v1.md'
    w.untracked = ['scratch.md']; w.kinds['latest'] = 'link'
    w.ignoredEntries = ['.cache/x']
  }
  test('control: a repository with tracked, linked, untracked and ignored files measures the same twice', guard(), async ($, on) => {
    const { w } = fixture(on); ordinary(w)
    await begun($)
    expect((await stop($)).block).toBeUndefined()
    expect(checks(w)).toBe(0)
  })
  for (const [what, change] of [
    ['a modified tracked file', (w: World) => { w.watched['src/a.ts'] = 'changed' }],
    ['a deleted tracked file', (w: World) => { w.kinds['src/b.ts'] = 'missing' }],
    ['a new untracked file', (w: World) => { w.untracked.push('new.ts') }],
    ['a retargeted tracked link', (w: World) => { w.linkTargets['docs/current'] = 'v2.md' }],
    ['a new untracked link to a regular file', (w: World) => { w.untracked.push('latest') }],
  ] as const) {
    test(`${what} is a change, measured`, guard(), async ($, on) => {
      const { w, h } = fixture(on); ordinary(w)
      await begun($); change(w)
      await stop($)
      expect(checks(w)).toBe(1)
      expect(kept(h).at(-1)?.complete).toBe(true)
    })
  }
  test('a session in a subdirectory of the work tree measures the whole tree', guard(), async ($, on) => {
    const { w, h } = fixture(on); ordinary(w); w.cwd = '/work/example/src'; w.gitPrefix = 'src/'
    await begun($); w.watched['src/a.ts'] = 'changed'
    await stop($)
    expect(checks(w)).toBe(1)
    expect(kept(h).at(-1)?.complete).toBe(true)
  })
  test('a BSD stat answers the same inspection through -f', guard(), async ($, on) => {
    const { w, h } = fixture(on); ordinary(w); w.statFlavor = 'bsd'
    await begun($)
    expect((await stop($)).block).toBeUndefined()
    await prompt($, 'again'); w.watched['src/a.ts'] = 'changed'
    await stop($)
    expect(checks(w)).toBe(1)
    expect(kept(h).at(-1)?.complete).toBe(true)
  })
  for (const device of [false, true]) {
    test(`the HUD's status refresh ${device ? 'does not start while an attributes file is a device' : 'reads an ordinary repository (control)'}`, async ($, on) => {
      const w = world(on); w.gitStatus = CLEAN_REPO
      await start($); await prompt($, 'look around')
      if (device) { w.gitConfig['core.attributesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }
      const from = w.runs.length
      await bash($, 'ls')                                                          // a tool call schedules the refresh
      await w.clock.advance(1_000)
      await progress($, { action: 'status' })
      expect(gitSubcommands(w, from).filter(s => s === 'status')).toEqual(device ? [] : ['status'])
    })
  }
})

const PACKET = { action: 'consult', ground: 'release', objective: 'Release v0.6.4', architecture: 'Plugin hooks', locations: ['hooks/register.tsx'], risk: 'Candidate mismatch', question: 'Approve the release?' }
async function admit($: Parameters<typeof start>[0]): Promise<string> {
  await start($); await prompt($, 'Have Opus review the release candidate')
  await progress($, { action: 'plan', milestones: FIVE })
  for (const milestone of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone })
  for (const gate of GATE_NAMES) await progress($, { action: 'gate', gate, state: 'na', evidence: 'fixture' })
  return String((await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', ...PACKET } as never)).result)
}
