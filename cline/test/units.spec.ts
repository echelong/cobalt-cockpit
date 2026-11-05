import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRole, loadCatalog } from '../src/catalog.ts'
import { judgeWire, readWireCaptures } from '../src/reasoning.ts'
import { decide } from '../src/hook/policy.ts'
import { assessCommand } from '../src/core/engine.ts'
import { Archive, Ledger, listClaims, lostMissions, tryLock, withLock, writeClaim, writeMarker, writeAtomic } from '../src/store.ts'
import { estimateUsd, chargeOf, checkBudget } from '../src/cost.ts'
import { parsePlan, parseRequest, needsCommander } from '../src/planner.ts'
import { foldLine } from '../src/worker.ts'
import { catalog, config, mkRepo, task, tmp } from './helpers.ts'

describe('model pinning', () => {
  const coder = { provider: 'cline', model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: 'xhigh' as const, requireName: '1017' }
  test('the pinned 1017 checkpoint resolves', async () => { const r = await resolveRole(catalog, 'coder', coder); assert.equal(r.ok, true) })
  test('an alias is refused even when the catalog lists it', async () => { const r = await resolveRole(catalog, 'coder', { ...coder, model: '~deepseek/deepseek-flash-latest', requireName: undefined }); assert.equal(r.ok, false) })
  test('another Flash checkpoint is refused by the version pin', async () => { const r = await resolveRole(catalog, 'coder', { ...coder, model: 'deepseek/deepseek-v4.1-flash' }); assert.ok(!r.ok && /required version "1017"/.test(r.reason)) })
  test('ClinePass Qwen without 0902 is refused unless explicitly opted in', async () => {
    const spec = { provider: 'cline-pass', model: 'cline-pass/qwen3.8-max', reasoning: 'xhigh' as const, requireName: '0902' }
    assert.equal((await resolveRole(catalog, 'frontend', spec)).ok, false)
    const opted = await resolveRole(catalog, 'frontend', spec, ['cline-pass/cline-pass/qwen3.8-max'])
    assert.ok(opted.ok && opted.notes.some(n => n.startsWith('UNPINNED')))
  })
  test('the INSTALLED Cline catalog still serves the pinned ids (skipped when Cline is absent)', async t => {
    let live; try { live = await loadCatalog() } catch { t.skip('cline not installed'); return }
    const c = config()
    for (const [role, spec] of Object.entries(c.profiles.cline.roles)) { const r = await resolveRole(live, role as never, spec); assert.equal(r.ok, true, `${role}: ${r.ok ? '' : r.reason}`) }
  })
})

describe('wire verification', () => {
  const dir = tmp('wire')
  const cap = (n: number, body: unknown) => writeFileSync(join(dir, `cap_run_x_${n}.wire_request.1.provider-request.json`), JSON.stringify({ timestamp: 't', captureStage: 'wire_request', payload: { url: 'u', method: 'POST', body: JSON.stringify(body) } }))
  test('captured bodies are read for model and effort only', () => {
    cap(1, { model: 'deepseek/deepseek-v4.1-flash-1017', reasoning_effort: 'max', messages: [{ role: 'user', content: 'secret code' }] })
    const r = readWireCaptures(dir)
    assert.deepEqual(r.map(x => [x.model, x.effort, x.thinking]), [['deepseek/deepseek-v4.1-flash-1017', 'max', 'on']])
    assert.equal(JSON.stringify(r).includes('secret code'), false)
  })
  test('all requests at max: confirmed; one at high: mismatch (downgrade detected)', () => {
    const ok = judgeWire([{ file: 'a', model: 'm', effort: 'max', thinking: 'on', at: null }], 'm', 'max')
    assert.equal(ok.state, 'confirmed')
    const bad = judgeWire([{ file: 'a', model: 'm', effort: 'max', thinking: 'on', at: null }, { file: 'b', model: 'm', effort: 'high', thinking: 'on', at: null }], 'm', 'max')
    assert.equal(bad.state, 'mismatch'); assert.match(bad.detail, /high instead of max/)
  })
  test('a different model on the wire is a mismatch', () => assert.equal(judgeWire([{ file: 'a', model: 'deepseek/deepseek-v4.1-flash', effort: 'max', thinking: 'on', at: null }], 'deepseek/deepseek-v4.1-flash-1017', 'max').state, 'mismatch'))
  test('no capture is unconfirmed, never confirmed', () => assert.equal(judgeWire([], 'm', 'max').state, 'unconfirmed'))
  test('toggle expectations read the thinking flag', () => {
    assert.equal(judgeWire([{ file: 'a', model: 'm', effort: null, thinking: 'on', at: null }], 'm', 'on').state, 'confirmed')
    assert.equal(judgeWire([{ file: 'a', model: 'm', effort: null, thinking: 'off', at: null }], 'm', 'on').state, 'mismatch')
    assert.equal(judgeWire([{ file: 'a', model: 'm', effort: null, thinking: null, at: null }], 'm', 'on').state, 'unconfirmed')
  })
})

describe('worker tool policy (adversarial)', () => {
  const wd = '/w/task'
  const p = { workdir: wd, owned: ['/src'], mode: 'write' as const, allowedTools: ['read_files', 'search_codebase', 'run_commands', 'editor'] }
  const guard = (c: string) => assessCommand(c, { cwd: wd }).map(f => f.rule)
  const deny = (tool: string, params: Record<string, unknown>, re?: RegExp) => { const v = decide(p, tool, params, guard); assert.equal(v.allow, false, `${tool} ${JSON.stringify(params)} was allowed`); if (re) assert.match(v.reason, re) }
  const allow = (tool: string, params: Record<string, unknown>) => assert.equal(decide(p, tool, params, guard).allow, true)
  test('edits inside owned paths pass', () => { allow('editor', { path: `${wd}/src/a.ts` }); allow('editor', { path: 'src/deep/b.ts' }) })
  test('edits outside ownership, outside the worktree or into protected paths are refused', () => {
    deny('editor', { path: `${wd}/README.md` }, /ownership/)
    deny('editor', { path: '/etc/passwd' }, /outside the task worktree/)
    deny('editor', { path: `${wd}/src/../README.md` }, /ownership/)
    deny('editor', { path: '../../home/x/.bashrc' }, /outside/)
    deny('editor', { path: `${wd}/.git/hooks/pre-commit` })
    deny('editor', { path: `${wd}/.clinerules/hooks/PreToolUse.sh` })
    deny('editor', {}, /no path/)
  })
  test('recursive spawning is refused: native sub-agent tools and agent launchers', () => {
    for (const t of ['spawn_agent', 'team_spawn_teammate', 'team_run_task', 'composio_multi_execute_tool', 'web_search', 'ask_question']) deny(t, {}, /not allowed/)
    for (const c of ['cline "do more"', 'npx cline -y task', 'cd x && claude -p hi', 'codex exec fix', '$(cockpit-cline run more)']) deny('run_commands', { commands: [c] }, /agent/)
  })
  test('escapes from the sandbox and privilege tools are refused', () => {
    for (const c of ['systemd-run --user sleep 999', 'echo x | at now', 'crontab -l', 'sudo ls', 'bwrap --bind / / sh', 'nsenter -t 1 -a']) deny('run_commands', { commands: [c] })
  })
  test('Git history operations are the supervisor\'s', () => { for (const c of ['git commit -am x', 'git push origin main', 'git reset --hard', 'git -C . checkout main', 'git stash']) deny('run_commands', { commands: [c] }, /Git/) })
  test('the engine guard refuses destructive commands', () => deny('run_commands', { commands: ['rm -rf /'] }, /guard/))
  test('ordinary commands pass', () => { allow('run_commands', { commands: ['npm test', 'git status', 'git diff', 'ls -la src'] }); allow('read_files', { paths: ['/etc/hosts'] }) })
  test('read-only tasks cannot edit', () => assert.equal(decide({ ...p, mode: 'read' }, 'editor', { path: `${wd}/src/a` }, guard).allow, false))
})

describe('durable store', () => {
  test('ledger chain verifies, and tampering or truncation is detected', () => {
    const d = tmp('ledger'); const l = new Ledger(d)
    for (let i = 0; i < 20; i++) l.append('e', `t${i}`, { i, token: 'sk-ant-api03-' + 'x'.repeat(40) })
    assert.deepEqual([l.verify().ok, l.verify().entries], [true, 20])
    assert.equal(readFileSync(join(d, 'seg-000001.jsonl'), 'utf8').includes('sk-ant-api03-xxxx'), false, 'credentials are redacted before they are hashed')
    const seg = join(d, 'seg-000001.jsonl'); const text = readFileSync(seg, 'utf8')
    writeFileSync(seg, text.replace('"i":7', '"i":8')); assert.match(l.verify().problem ?? '', /altered|broken/)
    writeFileSync(seg, text.split('\n').slice(0, 10).join('\n') + '\n'); assert.match(l.verify().problem ?? '', /truncated|head/)
  })
  test('archive pages hold thousands of records with bounded index reads', () => {
    const d = tmp('archive'); const a = new Archive(d, 100)
    const t0 = Date.now()
    for (let i = 0; i < 3000; i++) a.put(`task-${i}`, { state: i % 7 ? 'completed' : 'failed' })
    const idx = a.index()
    assert.equal(idx.total, 3000); assert.equal(idx.pages.length, 30)
    assert.equal(a.stateOf('task-2999'), 'completed'); assert.equal(a.stateOf('task-7'), 'failed'); assert.equal(a.stateOf('missing'), null)
    assert.equal((a.get('task-1234') as { id: string }).id, 'task-1234')
    assert.ok(Date.now() - t0 < 30_000)
  })
  test('lock: a second holder is refused; a dead holder is stale', async () => {
    const d = tmp('lock'); const f = join(d, 'x.lock')
    assert.equal(tryLock(f, 'a').ok, true)
    const second = tryLock(f, 'b'); assert.ok(!second.ok && !second.stale)
    writeFileSync(f, JSON.stringify({ holder: { pid: 999999, start: '1', boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }, host: (await import('node:os')).hostname(), at: 'x', purpose: 'dead' }))
    const third = tryLock(f, 'c'); assert.ok(!third.ok && third.stale)
    let n = 0; await Promise.all(Array.from({ length: 20 }, () => withLock(join(d, 'cs.lock'), 'cs', async () => { const v = n; await new Promise(r => setTimeout(r, 1)); n = v + 1 })))
    assert.equal(n, 20, 'critical sections never interleave')
  })
  test('a deleted or replaced mission store is detected from the repository marker (C3)', () => {
    const repo = mkRepo(); const common = join(repo, '.git'); const state = tmp('lost')
    mkdirSync(join(state, 'm1'), { recursive: true }); writeAtomic(join(state, 'm1', 'mission.json'), JSON.stringify({ epoch: 'e1' })); writeAtomic(join(state, 'm1', 'live.json'), '{}')
    writeMarker(common, { missionId: 'm1', stateDir: join(state, 'm1'), epoch: 'e1', createdAt: 'now' })
    assert.equal(lostMissions(common).length, 0)
    writeAtomic(join(state, 'm1', 'mission.json'), JSON.stringify({ epoch: 'e2' }))
    assert.match(lostMissions(common)[0].why, /epoch/)
    rmSync(join(state, 'm1'), { recursive: true })
    assert.match(lostMissions(common)[0].why, /missing/)
  })
  test('an unreadable claim is reported, not skipped', () => {
    const repo = mkRepo(); const common = join(repo, '.git')
    writeClaim(common, { missionId: 'm', taskId: 't', attempt: 1, owned: ['/src'], mode: 'write', state: 'bound', identity: null, supervisor: { pid: 1, start: null, boot: null }, stateDir: 'x', at: 'now' })
    appendFileSync(join(common, 'cobalt-cockpit-cline', 'claims', 'm__broken.json'), '{not json')
    const r = listClaims(common); assert.equal(r.claims.length, 1); assert.equal(r.unreadable.length, 1)
  })
})

describe('git change detection', () => {
  test('modified tracked files keep their full path (porcelain status column may be a space)', async () => {
    const { changesOf } = await import('../src/git.ts')
    const repo = mkRepo()
    writeFileSync(join(repo, 'src', 'base.txt'), 'changed\n'); writeFileSync(join(repo, 'new.txt'), 'n')
    const c = await changesOf(repo)
    assert.deepEqual(c.map(x => x.path).sort(), ['new.txt', 'src/base.txt'])
  })
})

describe('cost telemetry', () => {
  test('estimate: input includes cache reads (matches Cline\'s reported GLM figure within 1%)', () => {
    const est = estimateUsd({ inputTokens: 28417, outputTokens: 204, cacheReadTokens: 18688, cacheWriteTokens: 0 }, { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 })
    assert.ok(Math.abs(est - 0.0021344899) / 0.0021344899 < 0.01, String(est))
  })
  test('reported cost wins; missing usage is unmetered, not zero', () => {
    const p = { pricing: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }, source: 'catalog' as const }
    assert.deepEqual(chargeOf({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: 0.5 }, p), { usd: 0.5, basis: 'reported' })
    assert.equal(chargeOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: null }, p).basis, 'unmetered')
    assert.equal(checkBudget(null, 0, 1, 1, [0.5]).state, 'unmetered')
  })
  test('budget alerts fire once per threshold and exceed at 100%', () => {
    const a = checkBudget(0.6, 0, 1, 1e9, [0.5, 0.8, 1]); assert.deepEqual(a.crossed, [0.5])
    assert.deepEqual(checkBudget(0.9, 0, 1, 1e9, [0.5, 0.8, 1], [0.5]).crossed, [0.8])
    assert.equal(checkBudget(1.2, 0, 1, 1e9, [0.5, 0.8, 1], [0.5, 0.8]).state, 'exceeded')
  })
  test('stream folding keeps cumulative totals and the reported model', () => {
    const f = { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: null }, usageEvents: 0, toolCalls: {}, iterations: 0, finishReason: null, aborted: null, resultText: null, reportedModel: null, reportedProvider: null, agentErrors: 0, lines: 0, badLines: 0, sessionIds: [], firstEventAt: null, lastEventAt: null }
    foldLine(f, '{"type":"agent_event","event":{"type":"usage","inputTokens":9293,"outputTokens":65,"cost":0.00142645,"totalInputTokens":9293,"totalOutputTokens":65,"totalCost":0.00142645}}')
    foldLine(f, 'garbage')
    foldLine(f, '{"type":"run_result","finishReason":"completed","usage":{"inputTokens":28417,"outputTokens":204,"cacheReadTokens":18688,"cacheWriteTokens":0,"totalCost":0.00213449},"model":{"id":"zai/glm-5.3-flash","provider":"cline"}}')
    assert.equal(f.usage.inputTokens, 28417); assert.equal(f.usage.reportedUsd, 0.00213449); assert.equal(f.reportedModel, 'zai/glm-5.3-flash'); assert.equal(f.badLines, 1)
  })
})

describe('planner and delegation parsing (untrusted model output)', () => {
  const plan = (tasks: unknown) => `here\n\`\`\`json\n${JSON.stringify({ tasks })}\n\`\`\``
  const good = { id: 'a', title: 'A', kind: 'implement', risk: 'low', complexity: 2, mode: 'write', owned: ['src/a'], dependencies: [], prompt: 'do a' }
  test('a valid plan parses; owned paths are normalised to engine form', () => { const p = parsePlan(plan([good])); assert.ok(p.ok); assert.deepEqual(p.tasks[0].owned, ['/src/a']) })
  for (const [name, bad] of [['absolute path', { owned: ['/etc'] }], ['parent escape', { owned: ['../x'] }], ['unknown kind', { kind: 'deploy' }], ['bad complexity', { complexity: 9 }], ['missing prompt', { prompt: '' }], ['bad id', { id: 'Has Spaces' }]] as const) test(`plan rejected: ${name}`, () => assert.equal(parsePlan(plan([{ ...good, ...bad }])).ok, false))
  test('cycles and unknown dependencies are rejected', () => {
    assert.equal(parsePlan(plan([{ ...good, id: 'a', dependencies: ['b'] }, { ...good, id: 'b', dependencies: ['a'] }])).ok, false)
    assert.equal(parsePlan(plan([{ ...good, dependencies: ['zz'] }])).ok, false)
  })
  test('more than 12 tasks is rejected', () => assert.equal(parsePlan(plan(Array.from({ length: 13 }, (_, i) => ({ ...good, id: `t${i}` })))).ok, false))
  test('a worker request is one level deeper and prefixed by its parent', () => {
    const r = parseRequest(`done\nCOCKPIT_REQUEST\n\`\`\`json\n${JSON.stringify({ tasks: [good] })}\n\`\`\``, task('p', { depth: 1 }), 3, new Set())
    assert.ok(r && r.ok); assert.equal(r.tasks[0].id, 'p.a'); assert.equal(r.tasks[0].depth, 2); assert.equal(r.tasks[0].parent, 'p')
  })
  test('a worker request above maxChildren is rejected whole', () => { const r = parseRequest(`COCKPIT_REQUEST\n\`\`\`json\n${JSON.stringify({ tasks: [good, { ...good, id: 'b' }] })}\n\`\`\``, task('p'), 1, new Set()); assert.ok(r && !r.ok) })
  test('small goals bypass the commander; substantial ones use it', () => {
    assert.equal(needsCommander('fix the off-by-one in src/a.ts', {}).commander, false)
    assert.equal(needsCommander('Redesign the module architecture for plugins', {}).commander, true)
    assert.equal(needsCommander('Do these:\n- a\n- b\n- c', {}).commander, true)
  })
})

describe('mission control renders only measured state', () => {
  test('a running attempt without usage shows unknown cost and "—" tokens, never an estimate; held work and claims are shown', async () => {
    process.env.NO_COLOR = '1'
    const { render } = await import('../src/hud.ts')
    const header = { id: 'm-x', repoRoot: '/r', commonDir: '/r/.git', base: 'b'.repeat(40), createdAt: 'now', profile: 'cline', strict: true, goal: 'g', epoch: 'e', configDigest: 'd', gates: [{ name: 'test', command: 'npm test', required: true }], clineVersion: '3.0.74', mode: 'single' as const, modeReason: 'bounded goal', review: false, requireGates: true }
    const attempt = { n: 1, id: 'm-x.a.1', role: 'coder', provider: 'cline', model: 'deepseek/deepseek-v4.1-flash-1017', requestedReasoning: 'xhigh', cliThinking: 'xhigh', expectedWire: 'max', mapping: 'xhigh->max', phase: 'running', startedAt: new Date().toISOString(), endedAt: null, identity: { initPid: 42, pidNs: 'pid:[123]' }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: null }, usageEvents: 0, toolCalls: {}, iterations: 0, charge: { usd: null, basis: 'unmetered' }, wire: null, gates: [] }
    const live = { state: 'running', counters: { created: 2, completed: 0, failed: 0, refused: 0, cancelled: 0, attempts: 1, archived: 0 }, session: { spentUsd: 0, tokens: 0, unmetered: false, capReached: false, unmeteredTasks: [] }, integration: { branch: 'cockpit/m-x', head: 'h'.repeat(40), base: 'b', dir: '/i' }, tasks: { a: { spec: task('a'), state: 'running', attempts: [attempt], reason: null }, b: { spec: task('b'), state: 'held', attempts: [], reason: 'worker processes not accounted for' } }, recent: [], finalGates: [], alerts: ['b: HELD'], verdict: null, updatedAt: new Date().toISOString() }
    const out = render(header as never, live as never, [{ missionId: 'other', taskId: 't', attempt: 1, owned: ['/src'], state: 'bound' } as never])
    assert.match(out, /0\/2 tasks completed/)
    assert.match(out, /cline\/deepseek\/deepseek-v4\.1-flash-1017\s+xhigh→max\?/)
    assert.match(out, /a#1.*running.*42\/123.*—.*unknown/)
    assert.match(out, /held\s+b.*not accounted for/)
    assert.match(out, /other\/t#1:bound\[\/src\]/)
    assert.doesNotMatch(out, /\d+%/, 'no percentage is invented for a running worker')
  })
})
