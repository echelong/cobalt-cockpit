// Release-candidate review (round 7): regression tests for every defect it found and that was fixed.
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePlan, parseRequest } from '../src/planner.ts'
import { main, parseArgs, UsageError } from '../src/cli.ts'
import { validateConfig, DEFAULT_CONFIG_FILE } from '../src/config.ts'
import { routeTask } from '../src/router.ts'
import { render, taskCost } from '../src/hud.ts'
import { costMeasured } from '../src/supervisor.ts'
import type { AttemptRecord } from '../src/supervisor.ts'
import { Ledger, listClaims } from '../src/store.ts'
import { alwaysHidden, bwrapArgs } from '../src/sandbox.ts'
import { runCommandGate } from '../src/gates.ts'
import { sanitize } from '../src/ui/term.ts'
import { allTasks, config, env, mission, resolutions, task, tmp } from './helpers.ts'
import { KEYS, killShells, openShell } from './fixtures/pty.ts'

const T = { timeout: 180_000 }
const fence = (o: unknown, marker = ''): string => `done\n${marker}\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``
const child = { id: 'c', title: 'child', kind: 'implement', risk: 'low', complexity: 2, mode: 'write', owned: ['src/p'], dependencies: [], prompt: 'x' }

describe('review 7: delegation cannot mint a planning task or steer its own route', () => {
  test('a requested child named "plan" is refused (it would become <parent>.plan and be read as a whole plan)', () => {
    const r = parseRequest(fence({ tasks: [{ ...child, id: 'plan', mode: 'read' }] }, 'COCKPIT_REQUEST'), task('impl'), 3, new Set())
    assert.ok(r && !r.ok && /reserved/.test(r.reason), JSON.stringify(r))
    // and no prefixed form of any reserved id passes either
    for (const id of ['final-review', 'task']) { const x = parseRequest(fence({ tasks: [{ ...child, id }] }, 'COCKPIT_REQUEST'), task('impl'), 3, new Set()); assert.ok(x && !x.ok) }
    // a commander plan in a conversation turn (prefix "t1.") cannot name a task "plan" either
    assert.equal(parsePlan(fence({ tasks: [{ ...child, id: 'plan' }] }), new Set(), 't1.').ok, false)
  })
  test('end to end: a worker asking for a "plan" child gets nothing admitted, and its would-be plan never runs', T, async () => {
    const e = env()
    const grab = { tasks: [{ id: 'grab', title: 'grab', kind: 'implement', risk: 'low', complexity: 1, mode: 'write', owned: ['*'], dependencies: [], prompt: '[[write:outside.txt=x]]' }] }
    const req = JSON.stringify({ tasks: [{ id: 'plan', title: 'plan more', kind: 'scout', risk: 'low', complexity: 1, mode: 'read', owned: ['src/a'], dependencies: [], prompt: `[[plan-b64:${Buffer.from(JSON.stringify(grab)).toString('base64')}]]` }] })
    const m = await mission(e, { tasks: [task('a', { prompt: `[[write:src/a/x=1]] [[request-b64:${Buffer.from(req).toString('base64')}]]` })] })
    const v = await m.run()
    const ids = allTasks(m).map(t => t.id)
    assert.ok(!ids.includes('a.plan') && !ids.includes('a.grab') && !ids.includes('grab'), ids.join(','))
    assert.notEqual(v.state, 'DONE')
    assert.ok(v.reasons.some(r => /delegation from a refused/.test(r) && /reserved/.test(r)), v.reasons.join('; '))
  })
  test('a worker may not request architecture work, more risk or complexity than its parent, or a long context', () => {
    const arch = parseRequest(fence({ tasks: [{ ...child, kind: 'architecture' }] }, 'COCKPIT_REQUEST'), task('p'), 3, new Set())
    assert.ok(arch && !arch.ok && /architecture/.test(arch.reason))
    const r = parseRequest(fence({ tasks: [{ ...child, risk: 'critical', complexity: 5, contextTokens: 999_999 }] }, 'COCKPIT_REQUEST'), task('p', { risk: 'medium', complexity: 3 }), 3, new Set())
    assert.ok(r && r.ok)
    assert.equal(r.tasks[0].risk, 'medium'); assert.equal(r.tasks[0].complexity, 3); assert.equal(r.tasks[0].contextTokens, undefined)
    // routed from what the parent was trusted with: not the commander, not the long-context role
    const c = config()
    const tasksRisk = r.tasks[0]
    return resolutions(c).then(res => { const d = routeTask({ task: tasksRisk, config: c, resolutions: res, health: {}, spentSessionUsd: 0, history: { attempts: 0, gateFailures: 0, escalated: false, lastFailure: null } }); assert.notEqual(d.role, 'commander'); assert.notEqual(d.role, 'frontend') })
  })
  test('owned paths and titles with control, escape or bidi characters are refused', () => {
    for (const bad of [{ owned: ['src/\x1b[8mx'] }, { owned: ['src/‮x'] }, { title: 'a\x1b]52;c;eA==\x07' }]) assert.equal(parsePlan(fence({ tasks: [{ ...child, ...bad }] })).ok, false, JSON.stringify(bad))
  })
})

describe('review 7: the command line is strict before anything is spent', () => {
  test('unknown or misspelt flags, missing values and values given to switches are usage errors', () => {
    assert.throws(() => parseArgs(['run', '--budget', '0.5', 'goal']), UsageError)
    assert.throws(() => parseArgs(['run', '--budget-usd']), UsageError)
    assert.throws(() => parseArgs(['run', '--budget-usd=', 'goal']), UsageError)
    assert.throws(() => parseArgs(['run', '--budget-usd', '--single', 'goal']), UsageError)
    assert.throws(() => parseArgs(['smoke', '--yes=false']), UsageError)
    assert.deepEqual(parseArgs(['run', '--budget-usd', '0.5', '--single', 'fix', 'it']).flags, { 'budget-usd': '0.5', single: true })
  })
  test('main exits 2 on a usage error, a bad amount or an unknown smoke role, before any paid call', async () => {
    const quiet = process.stderr.write.bind(process.stderr); (process.stderr as { write: unknown }).write = () => true
    try {
      assert.equal(await main(['run', '--budget', '0.5', 'goal']), 2)
      assert.equal(await main(['run', '--budget-usd', 'abc', 'goal']), 2)
      assert.equal(await main(['smoke', '--yes', '--roles', 'coder,typo']), 2)
      assert.equal(await main(['smoke', '--yes', '--max-usd', 'abc']), 2)
      assert.equal(await main(['smoke', '--yes', '--max-usd', '0']), 2)
    } finally { (process.stderr as { write: unknown }).write = quiet }
  })
})

describe('review 7: configuration mistakes fail closed', () => {
  const shipped = (): Record<string, any> => JSON.parse(readFileSync(DEFAULT_CONFIG_FILE, 'utf8')) // eslint-disable-line @typescript-eslint/no-explicit-any
  test('an empty or null version pin is an error, never a silent unpin', () => {
    for (const v of [null, '', '  ']) { const c = shipped(); c.profiles.cline.roles.coder.requireName = v; assert.throws(() => validateConfig(c), /requireName/) }
  })
  test('estimates and alert thresholds are validated (a typo cannot disable the pre-spawn budget check)', () => {
    { const c = shipped(); c.estimates.coder.input = '400k'; assert.throws(() => validateConfig(c), /estimates\.coder\.input/) }
    { const c = shipped(); delete c.estimates.utility; assert.throws(() => validateConfig(c), /estimates\.utility/) }
    { const c = shipped(); c.budgets.alertAt = [0.5, 2]; assert.throws(() => validateConfig(c), /alertAt/) }
    { const c = shipped(); c.budgets.allowUnmetered = 'no'; assert.throws(() => validateConfig(c), /allowUnmetered/) }
  })
  test('an opted-in unpinned model is named on every route decision that uses it', async () => {
    const c = config({ profile: 'cline-pass', unpinnedAllowed: ['cline-pass/cline-pass/qwen3.8-max'] })
    const d = routeTask({ task: task('ui', { kind: 'frontend' }), config: c, resolutions: await resolutions(c), health: {}, spentSessionUsd: 0, history: { attempts: 0, gateFailures: 0, escalated: false, lastFailure: null } })
    assert.equal(d.role, 'frontend'); assert.ok(d.signals.some(s => s.startsWith('UNPINNED')), d.signals.join('; '))
  })
})

describe('review 7: the legacy status screen is terminal-safe and never shows unknown cost as $0', () => {
  const att = (o: Partial<AttemptRecord>): AttemptRecord => ({ charge: { usd: null, basis: 'unmetered' }, usageEvents: 0, iterations: 1, identity: { initPid: 1 } as never, ...o } as AttemptRecord)
  test('task cost: unknown, a lower bound, or exact; a never-launched attempt spent nothing', () => {
    assert.equal(taskCost([att({})]), 'unknown')
    assert.equal(taskCost([att({ charge: { usd: 0.002, basis: 'reported' }, usageEvents: 2 }), att({})]), '≥$0.00200')
    assert.equal(taskCost([att({ charge: { usd: 0.002, basis: 'reported' }, usageEvents: 2 })]), '$0.00200')
    assert.equal(taskCost([att({ identity: null, iterations: 0 })]), '$0.00000')
    assert.equal(costMeasured(att({})), false); assert.equal(costMeasured(att({ identity: null, iterations: 0 })), true)
  })
  test('alerts, reasons, repository paths and owned paths cannot drive the terminal', T, async () => {
    const e = env()
    const m = await mission(e, { tasks: [task('a')] })
    await m.run()
    const evil = '\x1b]52;c;ZXZpbA==\x07\x1b[2J\x1b]0;title\x07‮evil'
    m.live.alerts.push(`gate said ${evil}`)
    m.live.verdict = { ...(m.live.verdict as NonNullable<typeof m.live.verdict>), reasons: [`because ${evil}`] }
    const out = render({ ...m.header, repoRoot: `/tmp/${evil}` }, m.live, listClaims(m.header.commonDir).claims)
    for (const bad of ['\x1b]', '\x1b[2J', '\x07', '‮']) assert.ok(!out.includes(bad), `escaped: ${JSON.stringify(bad)}`)
    assert.match(out, /gate said .*evil/); assert.match(out, /because .*evil/)
  })
  test('bidi overrides and isolates are removed by sanitize', () => assert.equal(sanitize('a‮b⁦c⁩d‪e'), 'abcde'))
})

describe('review 7: sandboxes, gates and the ledger', () => {
  test('every sandbox hides the user service manager, the buses and container sockets, whatever the config', () => {
    const uid = process.getuid?.() ?? 1000
    assert.ok(alwaysHidden(uid).includes(`/run/user/${uid}`))
    const args = bwrapArgs({ workdir: '/tmp', writable: false, gitCommonDir: null, gitAdminDir: null, readOnly: [], readWrite: [], hide: [], network: false, marker: 'm', env: {} })
    if (readdirSync('/run/user').includes(String(uid))) assert.ok(args.join(' ').includes(`--tmpfs /run/user/${uid}`), args.join(' '))
  })
  test('a gate (worker-authored code) cannot reach the user service manager socket', T, async t => {
    const uid = process.getuid?.() ?? 1000
    let host: string[] = []; try { host = readdirSync(`/run/user/${uid}`) } catch { /* none */ }
    if (!host.length) { t.skip('no /run/user on this host'); return }
    const wd = tmp('gate'); const out = tmp('gate-out')
    const r = await runCommandGate({ name: 'probe', command: `test -z "$(ls -A /run/user/${uid} 2>/dev/null)" && test ! -e /run/dbus/system_bus_socket`, required: true }, wd, out, { hide: [], shareDirs: [], timeoutSeconds: 30, gitCommonDir: null }, 'r7')
    assert.equal(r.state, 'pass', r.evidence); assert.equal(r.unaccounted, undefined)
  })
  test('a head left one entry behind by an interrupted write is rolled forward to the verified entry, and the repair is recorded', () => {
    const dir = join(tmp('ledger'), 'l'); mkdirSync(dir)
    const l = new Ledger(dir); l.append('one', null, {}); const afterOne = readFileSync(join(dir, 'head.json'), 'utf8'); l.append('two', null, {})
    writeFileSync(join(dir, 'head.json'), afterOne) // the crash: entry two is on disk, the head still names entry one
    assert.equal(new Ledger(dir).verify().ok, false)
    const again = new Ledger(dir); again.append('three', null, {})
    const v = again.verify(); assert.ok(v.ok, v.problem ?? '')
    assert.deepEqual([...again.entries()].map(x => x.kind), ['one', 'two', 'ledger_head_repaired', 'three'])
  })
  test('a torn or altered last line is not repaired: verification keeps failing (fail-closed)', () => {
    const dir = join(tmp('ledger'), 'l'); mkdirSync(dir)
    const l = new Ledger(dir); l.append('one', null, {})
    const seg = join(dir, readdirSync(dir).find(f => f.startsWith('seg-')) as string)
    writeFileSync(seg, `${readFileSync(seg, 'utf8')}{"seq":2,"torn`)
    const again = new Ledger(dir); again.append('two', null, {})
    assert.equal(again.verify().ok, false)
  })
})

describe('review 7: terminal input in the real shell', () => {
  afterEach(() => killShells())
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
  test('a Ctrl+C or Ctrl+D byte inside pasted text is text: the paste stays a paste and its newlines submit nothing', T, async () => {
    const p = openShell({ ...env() }); await p.waitFor(/type a request to start/)
    p.send('\x1b[200~x\x03\nA\x04\nB\n\x1b[201~')
    await p.waitFor(/x↵A↵B↵/); await pause(600)
    assert.doesNotMatch(p.frame(), /t1 /)
    p.send(KEYS.ctrlC); await pause(150); p.send(KEYS.ctrlD); assert.equal(await p.exited, 0)
  })
  test('a paste start marker split right after its Esc is still a paste (no Esc key, no typed "[200~", no submit)', T, async () => {
    const p = openShell({ ...env() }); await p.waitFor(/type a request to start/)
    p.send('\x1b'); await pause(30); p.send('[200~hello\rworld\x1b[201~')
    await p.waitFor(/hello↵world/); await pause(600)
    const f = p.frame(); assert.doesNotMatch(f, /t1 /); assert.doesNotMatch(f, /\[200~/)
    // a lone Esc still works as a key once it is clearly alone
    p.send(KEYS.tab); await p.waitFor(/Mission Control · typing is paused/); p.send(KEYS.esc); await p.waitFor(/cockpit ❯ hello↵world/)
    p.send(KEYS.ctrlC); await pause(150); p.send(KEYS.ctrlD); assert.equal(await p.exited, 0)
  })
  test('a character split across two reads is decoded whole; F-keys type nothing', T, async () => {
    const p = openShell({ ...env() }); await p.waitFor(/type a request to start/)
    const ae = Buffer.from('ä€')
    p.child.stdin?.write(ae.subarray(0, 1)); await pause(60); p.child.stdin?.write(ae.subarray(1, 3)); await pause(60); p.child.stdin?.write(ae.subarray(3))
    p.send('\x1bOP'); p.send('z')
    await p.waitFor(/cockpit ❯ ä€z/); assert.doesNotMatch(p.frame(), /�|ä€Pz/)
    p.send(KEYS.ctrlC); await pause(150); p.send(KEYS.ctrlD); assert.equal(await p.exited, 0)
  })
  test('SIGINT from outside quits like Ctrl+D and gives the terminal back', T, async () => {
    const p = openShell({ ...env() }); await p.waitFor(/type a request to start/)
    const pid = p.pid(); assert.ok(pid)
    process.kill(pid as number, 'SIGINT')
    assert.equal(await p.exited, 0)
    assert.ok(p.raw().includes('\x1b[?1049l') && p.raw().includes('\x1b[?2004l'), 'alternate screen and bracketed paste are switched off')
  })
})
