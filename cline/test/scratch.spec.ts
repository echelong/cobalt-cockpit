// The offline tests must not leave fixtures behind (they once filled /tmp's inodes). scratch.ts gives each test
// process one root, removed on exit and on SIGINT/SIGTERM/SIGHUP, and sweeps the roots of killed processes. These tests
// check what is removed, when, and that nothing else is ever touched: active roots, other names, links, other files.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_DIR } from '../src/config.ts'
import { startTimeOf } from '../src/proc.ts'
import { OWNER_FILE, sweep, sweepProblem } from './scratch.ts'
import { homeTmp, tmp } from './helpers.ts'

const T = { timeout: 60_000 }
const deadPid = (): number => { const r = spawnSync('true'); return r.pid as number }
/** A directory shaped like a root, with an owner record (which may name anything). */
const BOOT = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); const PIDNS = readlinkSync('/proc/self/ns/pid')
const fakeRoot = (base: string, name: string, owner: Record<string, unknown> | null, root = join(base, name)): string => {
  const p = join(base, name); mkdirSync(p); writeFileSync(join(p, 'data.txt'), 'fixture')
  if (owner) writeFileSync(join(p, OWNER_FILE), JSON.stringify({ v: 1, root, boot: BOOT, pidns: PIDNS, ...owner }))
  return p
}
const node = (args: string[], env: Record<string, string>): ReturnType<typeof spawn> => spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', join(PACKAGE_DIR, 'loader', 'register.mjs'), ...args], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
type Child = { pid: number; tmpRoot: string; homeRoot: string; osTmp: string; fixture: string }
/** Starts fixtures/scratch-child.ts with its bases pointed at fresh directories; resolves once it reported its roots. */
const child = (mode: string, bases: { tmp: string; home: string }): Promise<{ info: Child; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; kill: (s: NodeJS.Signals) => void }> => new Promise((resolve, reject) => {
  const c = node([join(PACKAGE_DIR, 'test', 'fixtures', 'scratch-child.ts'), mode], { COCKPIT_TEST_TMP: bases.tmp, HOME: bases.home })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => c.on('exit', (code, signal) => r({ code, signal })))
  let out = '', err = ''
  c.stderr?.on('data', d => { err += d })
  c.stdout?.on('data', d => { out += d; const l = out.split('\n')[0]; if (out.includes('\n')) resolve({ info: JSON.parse(l) as Child, exited, kill: s => c.kill(s) }) })
  void exited.then(x => { if (!out.includes('\n')) reject(new Error(`child ended (${x.code}/${x.signal}) before reporting: ${err}`)) })
})
const bases = (): { tmp: string; home: string } => ({ tmp: tmp('sweep-tmp'), home: homeTmp('sweep-home') })

describe('scratch roots: what a sweep may remove', () => {
  test('only an abandoned root: right name, real directory, own record naming it, owner gone', T, async () => {
    const base = tmp('sweep-rules')
    const sleeper = spawn('sleep', ['30']); const live = sleeper.pid as number
    const dead = fakeRoot(base, 'ccl-run-AAAAAA', { pid: deadPid(), start: null })
    const hidden = fakeRoot(base, '.ccl-run-BBBBBB', { pid: deadPid(), start: null })
    const reused = fakeRoot(base, 'ccl-run-CCCCCC', { pid: live, start: 'another-start-time' })
    const active = fakeRoot(base, 'ccl-run-DDDDDD', { pid: live, start: startTimeOf(live) })
    const self = fakeRoot(base, 'ccl-run-EEEEEE', { pid: process.pid, start: startTimeOf(process.pid) })
    const noRecord = fakeRoot(base, 'ccl-run-FFFFFF', null)
    const elsewhere = fakeRoot(base, 'ccl-run-GGGGGG', { pid: deadPid(), start: null }, '/tmp/somewhere-else')
    const legacy = fakeRoot(base, 'ccl-state-HHHHHH', { pid: deadPid(), start: null })
    const longName = fakeRoot(base, 'ccl-run-IIIIIII', { pid: deadPid(), start: null })
    const userDir = fakeRoot(base, 'my-project', { pid: deadPid(), start: null })
    writeFileSync(join(base, 'evidence.log'), 'keep me'); writeFileSync(join(base, 'ccl-run-JJJJJJ'), 'a file, not a root')
    const target = fakeRoot(tmp('link-target'), 'ccl-run-KKKKKK', { pid: deadPid(), start: null })
    symlinkSync(target, join(base, 'ccl-run-LLLLLL'))
    // never provably gone, or not a root of ours: kept
    const otherBoot = fakeRoot(base, 'ccl-run-MMMMMM', { pid: deadPid(), start: null, boot: 'another-boot' })
    const otherNs = fakeRoot(base, 'ccl-run-NNNNNN', { pid: deadPid(), start: null, pidns: 'pid:[1]' })
    const noBoot = fakeRoot(base, 'ccl-run-OOOOOO', { pid: deadPid(), start: null, boot: null })
    const kept = fakeRoot(base, 'ccl-run-PPPPPP', { pid: deadPid(), start: null, keep: true })
    const malformed = ['ccl-run-QQQQQ0', 'ccl-run-QQQQQ1', 'ccl-run-QQQQQ2', 'ccl-run-QQQQQ3', 'ccl-run-QQQQQ4'].map((n, i) => fakeRoot(base, n, [{ pid: 0, start: 'x' }, { pid: -5, start: 'x' }, { pid: 1.5, start: null }, { pid: deadPid(), start: 42 }, { pid: '123', start: null }][i]))
    // more uncertainty: no pid namespace on either side, a live pid of another user (EPERM), records of the wrong shape
    const nsNull = fakeRoot(base, 'ccl-run-UUUUUU', { pid: deadPid(), start: null, pidns: null })
    // pid 2 is another user's (EPERM) on an ordinary host; elsewhere (a container, running as root) that case is skipped
    const epermHere = (() => { try { process.kill(2, 0); return false } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } })()
    const eperm = epermHere ? fakeRoot(base, 'ccl-run-VVVVVV', { pid: 2, start: 'x' }) : null
    const shapes = [['ccl-run-WWWWW0', [1, 2]], ['ccl-run-WWWWW1', 7], ['ccl-run-WWWWW2', { v: 1, pid: deadPid(), start: null }]].map(([n, rec]) => {
      const p = join(base, n as string); mkdirSync(p); writeFileSync(join(p, 'data.txt'), 'fixture')
      writeFileSync(join(p, OWNER_FILE), JSON.stringify(Array.isArray(rec) || typeof rec === 'number' ? rec : { ...(rec as object), root: p })); return p
    })
    const removed = sweep(base)
    for (const p of [nsNull, ...(eperm ? [eperm] : []), ...shapes]) assert.ok(existsSync(join(p, 'data.txt')), `${p} was swept`)
    if (eperm) assert.equal(sweepProblem(eperm, 'ccl-run-VVVVVV'), 'owner not provably gone')
    for (const p of shapes) assert.equal(sweepProblem(p, p.split('/').pop() as string), 'malformed owner record', p)
    // unknown on BOTH sides (equal nulls must not pass for a match): kept
    const bothNull = fakeRoot(base, 'ccl-run-YYYYY9', { pid: deadPid(), start: null, boot: null, pidns: null })
    assert.equal(sweepProblem(bothNull, 'ccl-run-YYYYY9', { startOf: startTimeOf, boot: () => null, pidns: () => null }), 'owner not provably gone')
    const probeNs = fakeRoot(base, 'ccl-run-XXXXX9', { pid: deadPid(), start: null })
    assert.equal(sweepProblem(probeNs, 'ccl-run-XXXXX9', { startOf: startTimeOf, boot: () => BOOT, pidns: () => null }), 'owner not provably gone')
    // a live owner whose start time cannot be read is kept, not taken for a reused pid
    const unreadable = fakeRoot(base, 'ccl-run-RRRRRR', { pid: live, start: startTimeOf(live) })
    assert.equal(sweepProblem(unreadable, 'ccl-run-RRRRRR', { startOf: () => null, boot: () => BOOT, pidns: () => PIDNS }), 'owner not provably gone')
    const oldStart = fakeRoot(base, 'ccl-run-SSSSSS', { pid: live, start: 'old' })
    assert.equal(sweepProblem(oldStart, 'ccl-run-SSSSSS', { startOf: () => null, boot: () => BOOT, pidns: () => PIDNS }), 'owner not provably gone', 'an unreadable start time is not a reused pid')
    const deadHere = fakeRoot(base, 'ccl-run-TTTTTT', { pid: deadPid(), start: null })
    assert.equal(sweepProblem(deadHere, 'ccl-run-TTTTTT', { startOf: startTimeOf, boot: () => null, pidns: () => PIDNS }), 'owner not provably gone', 'no readable boot id: kept')
    assert.equal(sweepProblem(deadHere, 'ccl-run-TTTTTT'), null, 'positive control: the same root is sweepable with a readable boot id')
    sleeper.kill()
    for (const p of [otherBoot, otherNs, noBoot, kept, unreadable, ...malformed]) assert.ok(existsSync(join(p, 'data.txt')), `${p} was swept`)
    assert.equal(sweepProblem(kept, 'ccl-run-PPPPPP'), 'kept for debugging (COCKPIT_TEST_KEEP)')
    for (const [i, p] of malformed.entries()) assert.equal(sweepProblem(p, `ccl-run-QQQQQ${i}`), 'malformed owner record', p)
    assert.deepEqual(removed.sort(), [dead, hidden, reused].sort())
    for (const p of [dead, hidden, reused]) assert.ok(!existsSync(p), p)
    for (const p of [active, self, noRecord, elsewhere, legacy, longName, userDir, target, join(base, 'ccl-run-LLLLLL')]) assert.ok(existsSync(join(p, 'data.txt')), `${p} was touched`)
    assert.equal(readFileSync(join(base, 'evidence.log'), 'utf8'), 'keep me'); assert.equal(readFileSync(join(base, 'ccl-run-JJJJJJ'), 'utf8'), 'a file, not a root')
    assert.equal(sweepProblem(active, 'ccl-run-DDDDDD'), 'owner not provably gone'); assert.equal(sweepProblem(noRecord, 'ccl-run-FFFFFF'), 'no owner record')
    assert.equal(sweepProblem(join(base, 'ccl-run-LLLLLL'), 'ccl-run-LLLLLL'), 'not a real directory')
  })
})

describe('scratch roots: removed however a test process ends', () => {
  test('normal exit and a failing process: both roots are gone, and os.tmpdir() pointed inside the root', T, async () => {
    for (const mode of ['ok', 'fail']) {
      const b = bases(); const c = await child(mode, b); const x = await c.exited
      assert.equal(x.code, mode === 'ok' ? 0 : 1)
      assert.ok(c.info.osTmp === c.info.tmpRoot && c.info.fixture.startsWith(`${c.info.tmpRoot}/`), JSON.stringify(c.info))
      assert.ok(c.info.homeRoot.startsWith(`${b.home}/.ccl-run-`))
      assert.ok(!existsSync(c.info.tmpRoot) && !existsSync(c.info.homeRoot), `${mode}: a root was left`)
      assert.deepEqual(readdirSync(b.tmp), []); assert.deepEqual(readdirSync(b.home), [])
    }
  })

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    test(`${sig} (cancellation or a runner ending a file): roots removed, and the process still ends by the signal`, T, async () => {
      const b = bases(); const c = await child('hang', b)
      assert.ok(existsSync(join(c.info.fixture, 'f.txt')), 'positive control: the fixture exists while it runs')
      c.kill(sig); const x = await c.exited
      assert.equal(x.signal, sig)
      assert.ok(!existsSync(c.info.tmpRoot) && !existsSync(c.info.homeRoot))
    })
  }

  test('SIGKILL leaves the root; the next test process sweeps it, and never an active one', T, async () => {
    const b = bases()
    const killed = await child('hang', b); killed.kill('SIGKILL'); await killed.exited
    assert.ok(existsSync(killed.info.tmpRoot) && existsSync(killed.info.homeRoot), 'nothing can run on SIGKILL')
    const active = await child('hang', b)
    // a third process starting meanwhile sweeps the killed root but not the active one
    const next = await child('ok', b); await next.exited
    assert.ok(!existsSync(killed.info.tmpRoot) && !existsSync(killed.info.homeRoot), 'the abandoned roots were swept')
    assert.ok(existsSync(join(active.info.fixture, 'f.txt')) && existsSync(active.info.homeRoot), 'an active root was swept')
    active.kill('SIGTERM'); await active.exited
    assert.deepEqual(readdirSync(b.tmp), []); assert.deepEqual(readdirSync(b.home), [])
  })

  test('COCKPIT_TEST_KEEP=1 keeps the roots for debugging, and a later run does not sweep them', T, async () => {
    const b = bases()
    const kept = await new Promise<Child>((resolve, reject) => {
      const c = node([join(PACKAGE_DIR, 'test', 'fixtures', 'scratch-child.ts'), 'ok'], { COCKPIT_TEST_TMP: b.tmp, HOME: b.home, COCKPIT_TEST_KEEP: '1' })
      let out = ''; c.stdout?.on('data', d => { out += d }); c.on('exit', () => { try { resolve(JSON.parse(out.split('\n')[0]) as Child) } catch (e) { reject(e) } })
    })
    assert.ok(existsSync(join(kept.fixture, 'f.txt')), 'kept after exit')
    const next = await child('ok', b); await next.exited
    assert.ok(existsSync(join(kept.fixture, 'f.txt')) && existsSync(kept.homeRoot), 'a kept root was swept by the next run')
  })

  test('a node:test file whose test times out still removes its root', T, async () => {
    const b = bases()
    const c = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', join(PACKAGE_DIR, 'loader', 'register.mjs'), '--test', '--test-timeout=500', join(PACKAGE_DIR, 'test', 'fixtures', 'scratch-timeout.fixture.ts')], { env: { PATH: process.env.PATH ?? '', COCKPIT_TEST_TMP: b.tmp, HOME: b.home }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; c.stdout?.on('data', d => { out += d })
    const code = await new Promise<number | null>(r => c.on('exit', x => r(x)))
    assert.notEqual(code, 0, 'the test timed out'); assert.match(out, /ROOT=/, out)
    assert.deepEqual(readdirSync(b.tmp), [], 'the timed-out file left a root')
  })
})
