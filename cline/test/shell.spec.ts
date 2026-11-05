// Interactive acceptance: the real `cockpit-cline shell` in a pseudo-terminal, driven by keystrokes.
// Workers are the fake Cline inside the real sandbox; routing, gates and integration are real.
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { env, git } from './helpers.ts'
import { KEYS, killShells, lastConversation, openShell, testConfigFile, type } from './fixtures/pty.ts'
import { listClaims } from '../src/store.ts'
import { stripAnsi } from '../src/ui/term.ts'

const T = { timeout: 180_000 }
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64')
const row = (f: string, label: string): string => f.split('\n').find(l => new RegExp(`^. ${label}\\b`).test(l)) ?? ''
const widest = (f: string): number => Math.max(...f.split('\n').map(l => [...l].length))

describe('the integrated Cockpit shell', () => {
  afterEach(() => killShells())
  test('idle: opens straight into the HUD with all five roles, honest unobserved reasoning, the five gates and the budget', T, async () => {
    const e = env(); const p = openShell({ ...e })
    const f = await p.waitFor(/type a request to start/)
    for (const s of ['COBALT COCKPIT / CLINE', 'READY', '01 SWARM / FIVE MODELS', 'COMMANDER', 'Kimi K3.1 Pro', 'CODER', 'DeepSeek V4.1 Flash 1017 ★', 'SPECIALIST', 'MiMo-V2.6-Pro', 'FRONTEND', 'Qwen3.8 Max 0902', 'UTILITY', 'GLM 5.3 Flash',
      '02 VERIFY / GATES', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT', '03 SPEND / BUDGET', '04 ACTIVITY / LIVE', 'cockpit ❯']) assert.ok(f.includes(s), `missing "${s}"\n${f}`)
    // nothing has been sent: the effective reasoning is unknown, never shown as verified
    assert.match(row(f, 'CODER'), /xhigh→\?\s/); assert.doesNotMatch(row(f, 'CODER'), /✓/)
    assert.match(f, /TYPE\s+– SKIPPED\s+no gate configured/)
    assert.match(f, /SESSION\s+\$0 of \$3\.00/)
    assert.ok(widest(f) <= 159, 'no line reaches the last column')
    p.send(KEYS.ctrlD); assert.equal(await p.exited, 0)
  })

  test('a typed coding task runs on DeepSeek 1017 (xhigh→max confirmed), streams, is gated and integrated; the HUD shows its real events; a follow-up keeps the context', T, async () => {
    const e = env(); const p = openShell({ ...e, args: ['--gate', 'exists=test -f src/hello.txt'] })
    await p.waitFor(/type a request to start/)
    await type(p, '[[write:src/hello.txt=hi]] [[stream-delay:20]] add a hello file')
    let f = await p.waitFor(/t1 ✓ completed/)
    assert.match(f, /t1: asks for a change: implementation → coder deepseek\/deepseek-v4\.1-flash-1017/)
    assert.match(f, /Done\. All changes made/, 'the streamed answer is in the transcript')
    assert.match(row(f, 'CODER'), /DeepSeek V4\.1 Flash 1017 ★\s+cline\s+xhigh→max ✓\s+DONE\s+t1 · integrated [0-9a-f]{8} · 1 file\(s\)/)
    assert.match(row(f, 'CODER'), /\$0\.\d+/, 'a real (fake-reported) cost, not a dash')
    assert.match(f, /FINISHED · VERIFIED/)
    assert.match(f, /TEST\s+✓ PASS\s+exists pass on branch @[0-9a-f]{8}/, 'the gate ran on the integrated branch')
    assert.match(f, /SECURITY\s+✓ PASS/); assert.match(f, /GIT\s+✓ PASS/)
    assert.match(f, /OUTCOME\s+FINISHED · VERIFIED/)
    assert.match(f, /◉ verdict DONE/, 'the activity strip shows the ledger verdict')
    // the full timeline has the worker's own edit and the supervisor's gates and integration
    p.send(KEYS.tab); p.send('3'); const tl = await p.waitFor(/01 TIMELINE \/ REAL EVENTS/)
    assert.match(tl, /CODER\s+t1\s+✎ editor src\/hello\.txt/); assert.match(tl, /◆ #1 gates GIT ✓ SECURITY ✓ exists ✓/); assert.match(tl, /⇢ #1 integrated/)
    p.send(KEYS.esc); await p.waitFor(/Enter sends · Tab mission control/)
    const id = lastConversation(e.root) as string
    assert.equal(git(e.repo, 'show', `cockpit/${id}:src/hello.txt`), 'hi')
    await type(p, 'what does src/hello.txt contain?')
    f = await p.waitFor(/t2 ✓ completed/)
    assert.match(f, /t2: question about the code: read-only answer → coder/)
    const prompt = readFileSync(join(e.root, 'missions', id, 'runs', 't2', '1', 'ro', 'prompt.txt'), 'utf8')
    assert.match(prompt, /Conversation so far/); assert.match(prompt, /add a hello file/); assert.match(prompt, /Files changed in earlier turns: src\/hello\.txt/)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('multi-model: Qwen for UI, MiMo for debugging, GLM for scouting, Kimi orchestrating a /swarm; Mission Control explains every route and cost', T, async () => {
    const e = env(); const p = openShell({ ...e })
    await p.waitFor(/type a request to start/)
    await type(p, '[[write:src/ui/page.tsx=x]] build the responsive settings page component')
    await p.waitFor(/t1 ✓ completed .*frontend qwen\/qwen3\.8-max-0902/)
    await type(p, '[[write:src/flaky.txt=fixed]] the test is flaky, debug the root cause')
    await p.waitFor(/t2 ✓ completed .*specialist xiaomi\/mimo-v2\.6-pro/)
    await type(p, 'where are all the uses of base in the whole repo?')
    await p.waitFor(/t3 ✓ completed .*utility zai\/glm-5\.3-flash/)
    const plan = { design: 'Split core and CLI.', tasks: [{ id: 'core', title: 'core module', kind: 'implement', risk: 'medium', complexity: 3, mode: 'write', owned: ['src/core'], dependencies: [], prompt: '[[write:src/core/a.ts=x]]' }, { id: 'docs', title: 'readme', kind: 'docs', risk: 'low', complexity: 1, mode: 'write', owned: ['docs/README.md'], dependencies: ['core'], prompt: '[[write:docs/README.md=x]]' }] }
    await type(p, `/swarm [[sleep:2500]] [[plan-b64:${b64(plan)}]] restructure the project`)
    const orch = await p.waitFor(/◈ KIMI ORCHESTRATING t4\.plan/)
    assert.match(row(orch, 'COMMANDER'), /RUNNING/)
    const f = await p.waitFor(/t4\.docs ✓ completed/, 60_000)
    assert.match(f, /t4\.plan ✓ completed .*commander moonshotai\/kimi-k3\.1-pro/)
    assert.match(f, /t4\.core ✓ completed .*coder deepseek/)
    assert.match(f, /t4\.docs ✓ completed .*utility zai\/glm-5\.3-flash/)
    assert.doesNotMatch(f, /KIMI ORCHESTRATING/, 'orchestration is shown only while the plan runs')
    // routing view: the planned implementation task went to the default coder by rule D
    p.send('/cockpit routing\r'); const r = await p.waitFor(/01 POLICY \/ FIXED RULES/)
    assert.match(r, /★ default coder: never replaced for cost/)
    assert.match(r, /t4\.core#1\s+→ CODER\s+deepseek-v4\.1-flash-1017\s+xhigh→max ✓\s+D default implementation work/)
    assert.match(r, /t1#1\s+→ FRONTEND\s+qwen3\.8-max-0902\s+xhigh→xhigh ✓/)
    // Enter expands the selected decision with its rules and the signals read from the request
    p.send(KEYS.enter); await p.waitFor(/│ rules: /)
    p.send('6'); const c = await p.waitFor(/01 SPEND \/ SESSION/)
    assert.match(c, /COMMANDER moonshotai\/kimi-k3\.1-pro\s+1 att/); assert.match(c, /SESSION\s+\$[0-9.]+ of \$3\.00/)
    p.send('2'); const ag = await p.waitFor(/01 AGENTS \/ EVERY ATTEMPT/)
    assert.match(ag, /t4\.plan#1\s+COMMANDER\s+kimi-k3\.1-pro/)
    // the input line is visible in Mission Control too: wait for the conversation's own hint line
    p.send(KEYS.esc); await p.waitFor(/Enter sends · Tab mission control/)
    p.send('/cockpit ready\r'); await p.waitFor(/READY: all five roles resolve|NOT READY:/)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('Esc cancels a running turn; the sandbox is accounted for before ownership is released; the next turn works', T, async () => {
    const e = env(); const p = openShell({ ...e })
    await p.waitFor(/type a request to start/)
    await type(p, '[[hang]] [[write:src/never.txt=x]] change something slowly')
    // "slowly" and "hang" are debugging words: the specialist runs it; the row says so with RUNNING
    const run = await p.waitFor(/1 running/)
    assert.match(run, /^. SPECIALIST .*RUNNING\s+(?:[▁▂▃▄▅▆▇█]{5} )?t1 · /m)
    p.send(KEYS.esc)
    const f = await p.waitFor(/t1 ✗ cancelled/)
    assert.match(f, /cancelling t1/)
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 0)
    await type(p, '[[write:src/after.txt=x]] add another file')
    await p.waitFor(/t2 ✓ completed/)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('failed and retried worker: RETRY in the swarm, the retry and its reason in the timeline, recovery on the same model', T, async () => {
    const e = env(); const p = openShell({ ...e })
    await p.waitFor(/type a request to start/)
    await type(p, '[[fail-times:1:503]] [[write:src/r.txt=x]] add a retried file')
    // the RETRY row lasts only the jittered backoff (it can be shorter than a frame): the unit tests
    // check its rendering; here the retry is proven from what is always recorded
    const f = await p.waitFor(/t1 ✓ completed/)
    assert.match(f, /coder deepseek\/deepseek-v4\.1-flash-1017/)
    p.send(KEYS.tab); p.send('2'); const ag = await p.waitFor(/01 AGENTS \/ EVERY ATTEMPT/)
    assert.match(ag, /✓ t1#2\s+CODER\s+deepseek-v4\.1-flash-1017.*COMPLETED/); assert.match(ag, /✗ t1#1\s+CODER\s+deepseek-v4\.1-flash-1017.*FAILED/)
    p.send('3'); const tl = await p.waitFor(/01 TIMELINE/)
    assert.match(tl, /✗ #1 failed · provider_error/); assert.match(tl, /⟳ retry on the same model/); assert.match(tl, /→ #2 routed → coder deepseek/)
    p.send(KEYS.esc); p.send(KEYS.ctrlD); await p.exited
  })

  test('blocked admission: with one worker slot, the second planned task waits and the HUD says why', T, async () => {
    const e = env(); const cfg = testConfigFile({ limits: { retryBaseMs: 1500, retryMaxMs: 3000, minFreeMemoryMB: 0, maxLoadPerCpu: 1000, workerTimeoutSeconds: 60, spawnsPerMinute: 10000, concurrency: { total: 1 } } })
    const p = openShell({ ...e, config: cfg })
    await p.waitFor(/type a request to start/)
    const plan = { design: 'two independent parts', tasks: [{ id: 'core', title: 'core', kind: 'implement', risk: 'medium', complexity: 3, mode: 'write', owned: ['src/core'], dependencies: [], priority: 9, prompt: '[[sleep:3000]] [[write:src/core/a.ts=x]]' }, { id: 'docs', title: 'docs', kind: 'docs', risk: 'low', complexity: 1, mode: 'write', owned: ['docs'], dependencies: [], priority: 1, prompt: '[[write:docs/a.md=x]]' }] }
    await type(p, `/swarm [[plan-b64:${b64(plan)}]] two parts`)
    const w = await p.waitFor(/^. UTILITY .*(?:WAITING|QUEUED)/m, 60_000)
    assert.match(row(w, 'CODER'), /RUNNING/)
    assert.match(row(w, 'UTILITY'), /concurrency|next t1\.docs/)
    await p.waitFor(/t1\.docs ✓ completed/, 60_000)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('completed then partially completed: a failing turn turns the outcome PARTIAL and the failing gate shows its evidence', T, async () => {
    const e = env(); const p = openShell({ ...e, args: ['--gate', 'test=test ! -f src/bad.txt'] })
    await p.waitFor(/type a request to start/)
    await type(p, '[[write:src/good.txt=x]] add a good file')
    let f = await p.waitFor(/t1 ✓ completed/)
    assert.match(f, /FINISHED · VERIFIED/)
    await type(p, '[[write:src/bad.txt=x]] add a bad file')
    f = await p.waitFor(/t2 ✗ failed/, 120_000)
    assert.match(f, /FINISHED · PARTIAL/)
    assert.doesNotMatch(f, /FINISHED · VERIFIED/)
    assert.match(f, /TEST\s+✗ FAIL\s+t2#\d: test fail/)
    p.send('/cockpit gates\r'); await p.waitFor(/01 VERIFY \/ FIVE GATES/)
    p.send(KEYS.enter); const g = await p.waitFor(/│ t2#\d: test fail/)
    assert.match(g, /DONE needs every task verified/)
    p.send(KEYS.esc); p.send(KEYS.ctrlD); await p.exited
  })

  test('Ctrl+C clears typed input when idle, quits on an empty line, and cancels first when a turn runs', T, async () => {
    const e = env(); const p = openShell({ ...e })
    await p.waitFor(/type a request to start/)
    p.send('half typed'); await p.waitFor(/cockpit ❯ half typed/)
    p.send(KEYS.ctrlC); await p.waitFor(/cockpit ❯ +\n|cockpit ❯\s*$/m)
    await type(p, '[[hang]] slow change')
    await p.waitFor(/1 running/)
    p.send(KEYS.ctrlC); await p.waitFor(/Ctrl-C again to stop and quit/)
    p.send(KEYS.ctrlC)
    assert.equal(await p.exited, 0)
    assert.match(p.raw(), /Cobalt Cockpit: conversation m-/)
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 0)
  })

  test('a crash mid-turn (SIGKILL) is recovered on restart: transcript and timeline restored, attempt reconciled by identity, the turn finished once', T, async () => {
    const e = env(); const cfg = testConfigFile()
    const p = openShell({ ...e, config: cfg })
    await p.waitFor(/type a request to start/)
    await type(p, '[[sleep:4000]] [[write:src/crash.txt=x]] add a file slowly')
    await p.waitFor(/1 running/)
    const pid = p.pid(); assert.ok(pid)
    process.kill(pid as number, 'SIGKILL'); await p.exited
    const q = openShell({ ...e, config: cfg })
    const f = await q.waitFor(/t1 ✓ completed/, 60_000)
    assert.match(f, /resumed conversation/); assert.match(f, /❯ \[\[sleep:4000\]\]/)
    const id = lastConversation(e.root) as string
    assert.equal(git(e.repo, 'log', '--format=%s', `main..cockpit/${id}`).split('\n').length, 1, 'integrated exactly once')
    const ledger = readdirSync(join(e.root, 'missions', id, 'ledger')).filter(n => n.startsWith('seg-')).map(n => readFileSync(join(e.root, 'missions', id, 'ledger', n), 'utf8')).join('')
    assert.match(ledger, /"kind":"reconciled"/)
    // the timeline is rebuilt from the ledger, including the first session's routing
    q.send(KEYS.tab); q.send('3'); const tl = await q.waitFor(/01 TIMELINE/)
    assert.match(tl, /→ #1 routed → coder/); assert.match(tl, /reconciled/)
    q.send(KEYS.esc); q.send(KEYS.ctrlD); await q.exited
  })

  test('a second shell on the same conversation is refused while the first is open', T, async () => {
    const e = env(); const cfg = testConfigFile()
    const p = openShell({ ...e, config: cfg }); await p.waitFor(/type a request to start/)
    const q = openShell({ ...e, config: cfg })
    assert.notEqual(await q.exited, 0)
    assert.match(q.raw(), /is open in another cockpit-cline/)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('narrow and wide terminals: compact at 72×24, minimal at 50×16, full at 200×60; no line ever reaches the last column', T, async () => {
    for (const [cols, rows] of [[72, 24], [50, 16], [200, 60]] as const) {
      const e = env(); const p = openShell({ ...e, cols, rows })
      const f = await p.waitFor(/cockpit ❯/)
      assert.ok(widest(f) <= cols - 1, `${cols}×${rows}: a line is ${widest(f)} wide`)
      assert.equal(f.split('\n').length, rows)
      assert.match(f, /COBALT COCKPIT/); assert.match(f, /CODER/); assert.match(f, /SPEND|SESSION/)
      if (cols === 200) { assert.match(f, /TOKENS\s+COST\s+TIME/); assert.match(f, /02 VERIFY \/ GATES.*03 SPEND \/ BUDGET/) }
      if (cols <= 72) assert.match(f, /CODER DeepSeek 1017 ★/, 'narrow keeps the checkpoint id visible')
      p.send(KEYS.ctrlD); await p.exited
    }
  })

  test('resize: the HUD re-lays itself out at the new size with a clean full redraw', T, async () => {
    const e = env(); const p = openShell({ ...e, cols: 160, rows: 46 })
    let f = await p.waitFor(/type a request to start/)
    assert.match(f, /02 VERIFY \/ GATES.*03 SPEND \/ BUDGET/)
    p.resize(80, 26)
    f = await p.waitFor(/^ VERIFY TEST/m)
    assert.equal(f.split('\n').length, 26); assert.ok(widest(f) <= 79)
    const raw = p.raw(); assert.match(stripAnsi(raw.slice(raw.lastIndexOf('\x1b[2J'))), /VERIFY TEST/, 'the size change cleared and repainted the whole screen')
    p.resize(170, 50)
    f = await p.waitFor(/02 VERIFY \/ GATES.*03 SPEND \/ BUDGET/)
    assert.equal(f.split('\n').length, 50)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('long activity logs: dozens of real tool events scroll in the timeline, with selection, details and the agent filter', T, async () => {
    const e = env(); const p = openShell({ ...e })
    await p.waitFor(/type a request to start/)
    const cmds = Array.from({ length: 40 }, (_, i) => `[[cmd:echo step-${i}]]`).join(' ')
    await type(p, `${cmds} [[write:src/long.txt=x]] run the steps`)
    await p.waitFor(/t1 ✓ completed/, 60_000)
    p.send(KEYS.tab); p.send('3')
    let tl = await p.waitFor(/01 TIMELINE \/ REAL EVENTS/)
    const total = Number(/(\d+) of (\d+) · filter all/.exec(tl)?.[2]); assert.ok(total >= 45, `only ${total} events`)
    assert.match(tl, /\d+ of \d+\s*$/m, 'a position indicator for a list longer than the screen')
    for (let i = 0; i < 30; i++) p.send(KEYS.up)
    tl = await p.waitFor(/\$ echo step-1\d/)
    p.send(KEYS.enter); tl = await p.waitFor(/│ echo step-\d+/)
    // a 40-step request is long, so the router gives it to the specialist; filter to that agent
    p.send('f'); tl = await p.waitFor(/filter COMMANDER/)
    p.send('f'); tl = await p.waitFor(/filter CODER/)
    p.send('f'); tl = await p.waitFor(/filter SPECIALIST/)
    assert.match(tl, /SPECIALIST\s+t1\s+\$ echo step-/); assert.doesNotMatch(tl, /COCKPIT\s+t1\s+\+ queued/)
    p.send(KEYS.esc); p.send(KEYS.ctrlD); await p.exited
  })

  test('colour modes and reduced motion: NO_COLOR draws no colour codes; truecolor uses the Cobalt palette; reduced motion never animates', T, async () => {
    const e1 = env(); const plain = openShell({ ...e1, env: { NO_COLOR: '1' } })
    await plain.waitFor(/type a request to start/)
    assert.doesNotMatch(plain.raw(), /\x1b\[(?:[0-9;]*;)?(?:3[0-9]|9[0-7]|38;[25])(?:;[0-9]+)*m/, 'no foreground colour codes')
    assert.match(plain.raw(), /\[READY\]/, 'the status pill keeps its shape without colour')
    plain.send(KEYS.ctrlD); await plain.exited
    const e2 = env(); const tc = openShell({ ...e2, env: { COCKPIT_COLOR: 'truecolor', COCKPIT_REDUCED_MOTION: '1' } })
    await tc.waitFor(/type a request to start/)
    assert.match(tc.raw(), /38;2;224;30;65/, 'the Cobalt accent #E01E41')
    await type(tc, '[[sleep:2500]] [[write:src/m.txt=x]] slow change')
    await tc.waitFor(/1 running/)
    await new Promise(r => setTimeout(r, 1200))
    assert.doesNotMatch(tc.raw(), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|[▂▃▄▅▆▇]/, 'no spinner or waveform with reduced motion')
    await tc.waitFor(/t1 ✓ completed/)
    tc.send(KEYS.ctrlD); await tc.exited
  })

  test('keyboard help and Mission Control navigation: /keys, ←/→ and digits switch views, Esc returns, input and history still work', T, async () => {
    const e = env(); const p = openShell({ ...e })
    await p.waitFor(/type a request to start/)
    p.send('/keys\r'); await p.waitFor(/01 CONVERSATION[\s\S]*02 MISSION CONTROL[\s\S]*03 LEGEND/)
    p.send(KEYS.right); await p.waitFor(/01 MISSION\b/)
    p.send(KEYS.right); await p.waitFor(/01 AGENTS \/ EVERY ATTEMPT/)
    p.send('5'); await p.waitFor(/01 VERIFY \/ FIVE GATES/)
    p.send(KEYS.tab); await p.waitFor(/Enter sends · Tab mission control/)
    // typed text and history are untouched by the overlay
    p.send('first line'); p.send('\x1b\r'); p.send('second'); await p.waitFor(/cockpit ❯ first line↵second/)
    p.send(KEYS.ctrlC); await p.waitFor(/cockpit ❯\s*$/m)
    p.send(KEYS.ctrlD); await p.exited
  })
})
