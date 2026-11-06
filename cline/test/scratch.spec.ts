// The offline tests must not leave fixtures behind (they once filled /tmp's inodes). scratch.ts gives each test
// process one root, removed on exit and on SIGINT/SIGTERM/SIGHUP, and sweeps the roots of killed processes. These tests
// check what is removed, when, and that nothing else is ever touched: active roots, other names, links, other files.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_DIR } from '../src/config.ts'
import { startTimeOf } from '../src/proc.ts'
import { OWNER_FILE, sweep, sweepProblem } from './scratch.ts'
import { homeTmp, tmp } from './helpers.ts'

const T = { timeout: 60_000 }
const deadPid = (): number => { const r = spawnSync('true'); return r.pid as number }
/** A directory shaped like a root, with an owner record (which may name anything). */
const fakeRoot = (base: string, name: string, owner: Record<string, unknown> | null, root = join(base, name)): string => {
  const p = join(base, name); mkdirSync(p); writeFileSync(join(p, 'data.txt'), 'fixture')
  if (owner) writeFileSync(join(p, OWNER_FILE), JSON.stringify({ v: 1, root, ...owner }))
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
    const removed = sweep(base)
    sleeper.kill()
    assert.deepEqual(removed.sort(), [dead, hidden, reused].sort())
    for (const p of [dead, hidden, reused]) assert.ok(!existsSync(p), p)
    for (const p of [active, self, noRecord, elsewhere, legacy, longName, userDir, target, join(base, 'ccl-run-LLLLLL')]) assert.ok(existsSync(join(p, 'data.txt')), `${p} was touched`)
    assert.equal(readFileSync(join(base, 'evidence.log'), 'utf8'), 'keep me'); assert.equal(readFileSync(join(base, 'ccl-run-JJJJJJ'), 'utf8'), 'a file, not a root')
    assert.equal(sweepProblem(active, 'ccl-run-DDDDDD'), 'owner still running'); assert.equal(sweepProblem(noRecord, 'ccl-run-FFFFFF'), 'no owner record')
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

  test('a node:test file whose test times out still removes its root', T, async () => {
    const b = bases()
    const c = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', join(PACKAGE_DIR, 'loader', 'register.mjs'), '--test', '--test-timeout=500', join(PACKAGE_DIR, 'test', 'fixtures', 'scratch-timeout.fixture.ts')], { env: { PATH: process.env.PATH ?? '', COCKPIT_TEST_TMP: b.tmp, HOME: b.home }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; c.stdout?.on('data', d => { out += d })
    const code = await new Promise<number | null>(r => c.on('exit', x => r(x)))
    assert.notEqual(code, 0, 'the test timed out'); assert.match(out, /ROOT=/, out)
    assert.deepEqual(readdirSync(b.tmp), [], 'the timed-out file left a root')
  })
})
