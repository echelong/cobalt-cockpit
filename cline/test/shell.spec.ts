// Interactive acceptance: the real `cockpit-cline shell` in a pseudo-terminal, driven by keystrokes.
// Workers are the fake Cline inside the real sandbox; routing, gates and integration are real.
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { env, git } from './helpers.ts'
import { KEYS, killShells, lastConversation, openShell, testConfigFile, type } from './fixtures/pty.ts'
import { listClaims } from '../src/store.ts'

const T = { timeout: 180_000 }
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64')

describe('the integrated Cockpit shell', () => {
  afterEach(() => killShells())
  test('opens straight into the live HUD: all five roles, models, reasoning, READY', T, async () => {
    const e = env(); const p = openShell({ ...e })
    const f = await p.waitFor(/type a request to start/)
    for (const s of ['COBALT COCKPIT · CLINE', 'COMMANDER', 'Kimi K3.1 Pro', 'CODER', 'DeepSeek V4.1 Flash 1017', 'xhigh→', 'SPECIALIST', 'MiMo-V2.6-Pro', 'FRONTEND', 'Qwen3.8 Max 0902', 'UTILITY', 'GLM 5.3 Flash', 'AGENTS', 'PROGRESS', 'GATES', 'SPEND', 'GUARD', 'READY', 'cockpit ❯']) assert.ok(f.includes(s), `missing "${s}"\n${f}`)
    p.send(KEYS.ctrlD); assert.equal(await p.exited, 0)
  })

  test('a typed coding task runs on DeepSeek 1017 (xhigh→max confirmed), streams its answer, is gated and integrated; then a follow-up turn keeps the context', T, async () => {
    const e = env(); const p = openShell({ ...e, args: ['--gate', 'exists=test -f src/hello.txt'] })
    await p.waitFor(/type a request to start/)
    await type(p, '[[write:src/hello.txt=hi]] [[stream-delay:20]] add a hello file')
    let f = await p.waitFor(/t1 ✓ completed/)
    assert.match(f, /t1: asks for a change: implementation → coder deepseek\/deepseek-v4\.1-flash-1017/)
    assert.match(f, /Done\. All changes made/, 'the streamed answer is in the transcript')
    assert.match(f, /CODER\s+DeepSeek V4\.1 Flash 1017\s+xhigh→max✓/)
    assert.match(f, /FINISHED · VERIFIED/)
    assert.match(f, /GATES\s+last task: GIT ✓\s+SECURITY ✓\s+exists ✓/)
    assert.match(f, /branch: exists ✓/, 'the gate ran again on the integrated mission branch')
    const id = lastConversation(e.root) as string
    assert.equal(git(e.repo, 'show', `cockpit/${id}:src/hello.txt`), 'hi')
    await type(p, 'what does src/hello.txt contain?')
    f = await p.waitFor(/t2 ✓ completed/)
    assert.match(f, /t2: question about the code: read-only answer → coder/)
    const prompt = readFileSync(join(e.root, 'missions', id, 'runs', 't2', '1', 'ro', 'prompt.txt'), 'utf8')
    assert.match(prompt, /Conversation so far/); assert.match(prompt, /add a hello file/); assert.match(prompt, /Files changed in earlier turns: src\/hello\.txt/)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('each turn is routed to the configured specialist: Qwen for UI, MiMo for difficult debugging, GLM for scouting, Kimi for /swarm', T, async () => {
    const e = env(); const p = openShell({ ...e })
    await p.waitFor(/type a request to start/)
    await type(p, '[[write:src/ui/page.tsx=x]] build the responsive settings page component')
    await p.waitFor(/t1 ✓ completed .*frontend qwen\/qwen3\.8-max-0902/)
    await type(p, '[[write:src/flaky.txt=fixed]] the test is flaky, debug the root cause')
    await p.waitFor(/t2 ✓ completed .*specialist xiaomi\/mimo-v2\.6-pro/)
    await type(p, 'where are all the uses of base in the whole repo?')
    await p.waitFor(/t3 ✓ completed .*utility zai\/glm-5\.3-flash/)
    const plan = { design: 'Split core and CLI.', tasks: [{ id: 'core', title: 'core module', kind: 'implement', risk: 'medium', complexity: 3, mode: 'write', owned: ['src/core'], dependencies: [], prompt: '[[write:src/core/a.ts=x]]' }, { id: 'docs', title: 'readme', kind: 'docs', risk: 'low', complexity: 1, mode: 'write', owned: ['docs/README.md'], dependencies: ['core'], prompt: '[[write:docs/README.md=x]]' }] }
    await type(p, `/swarm [[plan-b64:${b64(plan)}]] restructure the project`)
    const f = await p.waitFor(/t4\.docs ✓ completed/, 60_000)
    assert.match(f, /t4\.plan ✓ completed .*commander moonshotai\/kimi-k3\.1-pro/)
    assert.match(f, /t4\.core ✓ completed .*coder deepseek/)
    assert.match(f, /t4\.docs ✓ completed .*utility zai\/glm-5\.3-flash/)
    p.send('/cockpit routing\r'); const r = await p.waitFor(/t4\.core#1 → coder/)
    assert.match(r, /t1#1 → frontend qwen\/qwen3\.8-max-0902 xhigh→xhigh/)
    p.send('/cockpit costs\r'); await p.waitFor(/session \$[0-9.]+ of \$3\.00/)
    p.send('/cockpit agents\r'); await p.waitFor(/#1 commander\s+cline\/moonshotai\/kimi-k3\.1-pro/)
    p.send('/cockpit ready\r'); await p.waitFor(/READY: all five roles resolve|NOT READY:/)
    p.send(KEYS.tab); await p.waitFor(/MISSION CONTROL · Tab or Esc returns/)
    p.send(KEYS.esc); await p.waitFor(/cockpit ❯/)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('Esc cancels a running turn; the sandbox is accounted for before ownership is released; the next turn works', T, async () => {
    const e = env(); const p = openShell({ ...e })
    await p.waitFor(/type a request to start/)
    await type(p, '[[hang]] [[write:src/never.txt=x]] change something slowly')
    await p.waitFor(/RUNNING ×1/)
    p.send(KEYS.esc)
    const f = await p.waitFor(/t1 ✗ cancelled/)
    assert.match(f, /cancelling t1/)
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 0)
    await type(p, '[[write:src/after.txt=x]] add another file')
    await p.waitFor(/t2 ✓ completed/)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('a transient provider failure shows RETRYING in the HUD and recovers on the same model', T, async () => {
    const e = env(); const p = openShell({ ...e })
    await p.waitFor(/type a request to start/)
    await type(p, '[[fail-times:1:503]] [[write:src/r.txt=x]] add a retried file')
    await p.waitFor(/RETRY \d+s|RETRYING/)
    const f = await p.waitFor(/t1 ✓ completed/)
    assert.match(f, /coder deepseek\/deepseek-v4\.1-flash-1017/)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('Ctrl+C clears typed input when idle, quits on an empty line, and cancels first when a turn runs', T, async () => {
    const e = env(); const p = openShell({ ...e })
    await p.waitFor(/type a request to start/)
    p.send('half typed'); await p.waitFor(/cockpit ❯ half typed/)
    p.send(KEYS.ctrlC); await p.waitFor(/cockpit ❯ +\n|cockpit ❯\s*$/m)
    await type(p, '[[hang]] slow change')
    await p.waitFor(/RUNNING ×1/)
    p.send(KEYS.ctrlC); await p.waitFor(/Ctrl-C again to stop and quit/)
    p.send(KEYS.ctrlC)
    assert.equal(await p.exited, 0)
    assert.match(p.raw(), /Cobalt Cockpit: conversation m-/)
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 0)
  })

  test('a crash mid-turn (SIGKILL) is recovered on restart: transcript restored, attempt reconciled by identity, the turn finished once', T, async () => {
    const e = env(); const cfg = testConfigFile()
    const p = openShell({ ...e, config: cfg })
    await p.waitFor(/type a request to start/)
    await type(p, '[[sleep:4000]] [[write:src/crash.txt=x]] add a file slowly')
    await p.waitFor(/RUNNING ×1/)
    const pid = p.pid(); assert.ok(pid)
    process.kill(pid as number, 'SIGKILL'); await p.exited
    const q = openShell({ ...e, config: cfg })
    const f = await q.waitFor(/t1 ✓ completed/, 60_000)
    assert.match(f, /resumed conversation/); assert.match(f, /❯ \[\[sleep:4000\]\]/)
    const id = lastConversation(e.root) as string
    assert.equal(git(e.repo, 'log', '--format=%s', `main..cockpit/${id}`).split('\n').length, 1, 'integrated exactly once')
    const ledger = readdirSync(join(e.root, 'missions', id, 'ledger')).filter(n => n.startsWith('seg-')).map(n => readFileSync(join(e.root, 'missions', id, 'ledger', n), 'utf8')).join('')
    assert.match(ledger, /"kind":"reconciled"/)
    q.send(KEYS.ctrlD); await q.exited
  })

  test('a second shell on the same conversation is refused while the first is open', T, async () => {
    const e = env(); const cfg = testConfigFile()
    const p = openShell({ ...e, config: cfg }); await p.waitFor(/type a request to start/)
    const q = openShell({ ...e, config: cfg })
    assert.notEqual(await q.exited, 0)
    assert.match(q.raw(), /is open in another cockpit-cline/)
    p.send(KEYS.ctrlD); await p.exited
  })

  test('a narrow, short terminal renders a compact HUD without overflowing lines', T, async () => {
    const e = env(); const p = openShell({ ...e, cols: 72, rows: 24 })
    const f = await p.waitFor(/cockpit ❯/)
    for (const line of f.split('\n')) assert.ok([...line].length <= 72, `line wider than 72: ${line}`)
    assert.match(f, /COBALT COCKPIT/); assert.match(f, /CODER|CODER?/); assert.match(f, /SPEND/)
    p.send(KEYS.ctrlD); await p.exited
  })
})
