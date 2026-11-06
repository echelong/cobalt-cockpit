// Regression tests for the independent review's findings (one per finding where testable).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Mission } from '../src/supervisor.ts'
import { breakStaleLock, listClaims, tryLock } from '../src/store.ts'
import type { LockBody } from '../src/store.ts'
import { changesOf, gitLinkProblem } from '../src/git.ts'
import { runWorker } from '../src/worker.ts'
import { allTasks, byId, config, deps, env, git, mission, mkRepo, resolutions, task, tmp } from './helpers.ts'

const T = { timeout: 120_000 }

describe('review 1: command gates run worker code, so their effects are re-checked', () => {
  test('a gate that writes outside ownership is caught after the gates and nothing is integrated', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a')], gates: [{ name: 'sneaky', command: 'echo pwned > README.md', required: true }] })
    assert.notEqual((await m.run()).state, 'DONE')
    const a = byId(m, 'a').attempts[0]
    assert.equal(a.failure, 'policy_abort'); assert.match(a.failureDetail ?? '', /GIT\(after gates\)/)
    assert.equal(git(e.repo, 'show', `${m.live.integration.branch}:README.md`), '# fixture')
  })
  test('a gate that writes a credential into the worker\'s change is caught after the gates', T, async () => {
    const e = env(); const secret = ['sk', 'ant', 'api03', 'R'.repeat(30) + '-' + 'y'.repeat(20)].join('-')
    // src/a/out.txt is the worker's own new file; the gate appends to it
    const m = await mission(e, { tasks: [task('a')], gates: [{ name: 'leak', command: `echo 'KEY=${secret}' >> src/a/out.txt`, required: true }] })
    assert.notEqual((await m.run()).state, 'DONE')
    assert.match(byId(m, 'a').attempts[0].failureDetail ?? '', /SECURITY\(after gates\)/)
  })
  test('a credential in a new file a gate creates never reaches the mission branch', T, async () => {
    const e = env(); const secret = ['sk', 'ant', 'api03', 'S'.repeat(30) + '-' + 'w'.repeat(20)].join('-')
    const m = await mission(e, { tasks: [task('a')], gates: [{ name: 'leak', command: `echo 'KEY=${secret}' > src/a/leak.txt`, required: true }] })
    await m.run()
    assert.doesNotMatch(git(e.repo, 'ls-tree', '-r', '--name-only', m.live.integration.branch), /leak\.txt/)
    assert.ok([...m.ledger.entries()].some(x => x.kind === 'gate_artifacts_removed' && JSON.stringify(x.data).includes('leak.txt')))
  })
  test('a worker that edits the file its gate runs is UNVERIFIED, not DONE', T, async () => {
    const e = env()
    writeFileSync(join(e.repo, 'check.sh'), 'exit 1\n'); execFileSync('git', ['add', 'check.sh'], { cwd: e.repo }); execFileSync('git', ['commit', '-qm', 'gate'], { cwd: e.repo })
    const m = await mission(e, { tasks: [task('a', { owned: ['*'], prompt: '[[write:check.sh=exit 0]] [[write:src/a/x=1]]' })], gates: [{ name: 'check', command: 'sh check.sh', required: true }] })
    const v = await m.run()
    assert.equal(v.state, 'UNVERIFIED', v.reasons.join('; '))
    assert.ok(v.reasons.some(r => /check\.sh/.test(r) && /gates are defined by/.test(r)))
  })
})

describe('review 2: host git does not trust worker-writable git metadata', () => {
  test('the worktree .git link cannot be replaced from inside the sandbox', T, async () => {
    const e = env()
    const m = await mission(e, { tasks: [task('a', { prompt: `[[cmd:rm -f .git; printf 'gitdir: ${join(e.repo, '.git')}' > .git]] [[write:src/a/x=1]]` })] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    const a = byId(m, 'a').attempts[0]
    assert.equal(gitLinkProblem(a.worktree as string, a.adminDir ?? null), null)
    assert.equal(git(e.repo, 'log', '-1', '--format=%s', 'main'), 'init', 'nothing was committed to the person\'s branch')
  })
  test('a tampered link is reported', () => {
    const repo = mkRepo(); const wt = join(tmp('wtl'), 'w')
    execFileSync('git', ['worktree', 'add', '--detach', wt], { cwd: repo, stdio: 'ignore' })
    const admin = readFileSync(join(wt, '.git'), 'utf8').trim().slice('gitdir: '.length)
    assert.equal(gitLinkProblem(wt, admin), null)
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git')}\n`)
    assert.match(gitLinkProblem(wt, admin) ?? '', /now points to/)
  })
  test('a staged rename reports its source, so a deletion outside ownership is checked', async () => {
    const repo = mkRepo()
    execFileSync('git', ['mv', 'README.md', 'src/moved.md'], { cwd: repo })
    const c = await changesOf(repo)
    assert.ok(c.some(x => x.path === 'README.md'), JSON.stringify(c))
  })
})

describe('review 3 and 4: an interrupted verification keeps ownership, then recovery releases it', () => {
  test('an error after the worker ended holds the task (BLOCKED, claim kept); recovery releases the claim', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a')] })
    const append = m.ledger.append.bind(m.ledger); let thrown = false
    m.ledger.append = (kind, t, d) => { if (kind === 'integrated' && !thrown) { thrown = true; throw new Error('disk full (injected)') } return append(kind, t, d) }
    const v = await m.run()
    assert.equal(v.state, 'BLOCKED', v.reasons.join('; '))
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 1, 'the claim is kept while held')
    const c = config(); const again = Mission.open(e.root, m.header.id, c, await resolutions(c), deps(e))
    const v2 = await again.run()
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 0, 'recovery released the claim after re-checking')
    // round 2 (M2): the pick had landed before the error, so the task is finished, never redone
    assert.ok([...again.ledger.entries()].some(x => x.kind === 'reconciled' && JSON.stringify(x.data).includes('already integrated')))
    const a = byId(again, 'a')
    assert.equal(a.state, 'completed'); assert.equal(a.attempts.length, 1)
    assert.equal(git(e.repo, 'log', '--format=%s', `main..${again.live.integration.branch}`).split('\n').length, 1, 'integrated exactly once')
    assert.notEqual(v2.state, 'DONE', 'output of the interrupted run was not read: a person reviews it')
  })
})

describe('round 2 regressions', () => {
  test('M1: a provider error before any model turn keeps the session metered and gets its retry', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[repeat:0]] [[error]]' })] })
    await m.run()
    assert.equal(byId(m, 'a').attempts.length, 3, 'the bounded retries ran (one try, two backed-off retries)')
    assert.equal(m.live.session.unmetered, false)
  })
  test('S1: a slot held by an unaccounted worker ends the mission (BLOCKED) instead of polling', { timeout: 30_000 }, async () => {
    const e = env(); const c = config({ limits: { concurrency: { total: 1 } } })
    const unknown = async (spec: { model: string; attemptId: string }) => ({ identity: null, exitCode: 0, signal: null, stoppedBy: 'exit' as const, stopDetail: null, hookRefusals: [], observerError: null, census: { state: 'unknown' as const, pids: [], detail: 'uninspectable processes (test)' }, wire: { state: 'confirmed' as const, requests: 1, effective: 'max', models: [spec.model], detail: 'fake' }, facts: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: 0.0001 }, usageEvents: 1, toolCalls: {}, iterations: 1, finishReason: 'completed', aborted: null, resultText: 'ok', reportedModel: spec.model, reportedProvider: 'cline', agentErrors: 0, lines: 3, badLines: 0, sessionIds: [], firstEventAt: null, lastEventAt: null } })
    const m = await mission(e, { config: c, tasks: [task('a'), task('b')], deps: { runWorker: unknown as never } })
    const v = await m.run()
    assert.equal(v.state, 'BLOCKED')
    assert.match(byId(m, 'b').reason ?? '', /blocked: waiting: concurrency/)
  })
  test('S4: files the gates create are artifacts: removed, not committed, not blamed on the worker', T, async () => {
    const e = env()
    const m = await mission(e, { tasks: [task('a')], gates: [{ name: 'test', command: 'mkdir -p coverage && echo report > coverage/out.txt', required: true }] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    assert.doesNotMatch(git(e.repo, 'ls-tree', '-r', '--name-only', m.live.integration.branch), /coverage/)
    assert.ok([...m.ledger.entries()].some(x => x.kind === 'gate_artifacts_removed'))
  })
  test('S3: gate taint covers script bodies, test config and deleted tests, not ordinary test edits', async () => {
    const { gateTaint } = await import('../src/gates.ts')
    const gates = [{ name: 'test', command: 'npm run --silent test', required: true }]
    const scripts = { test: 'node tests/run.js && vitest run' }
    const t = (path: string, status = ' M') => gateTaint([{ path, status }], gates, scripts)
    assert.equal(t('tests/run.js').length, 1, 'a file the script body runs')
    assert.equal(t('vitest.config.ts').length, 1, 'test configuration')
    assert.equal(t('tsconfig.build.json').length, 1, 'type-check configuration')
    assert.equal(t('src/a.test.ts', 'D ').length, 1, 'a deleted test')
    assert.equal(t('src/a.test.ts', '??').length, 0, 'an added test is ordinary work')
    assert.equal(t('src/app.ts').length, 0)
    assert.equal(gateTaint([{ path: 'jest.config.js', status: ' M' }], [], {}).length, 0, 'no gates, nothing to weaken')
  })
  test('S5: a reported $0 for real tokens of a priced model is treated as missing, not free', async () => {
    const { chargeOf } = await import('../src/cost.ts')
    const { budgetVerdict } = await import('../src/worker.ts')
    const u = { inputTokens: 300_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reportedUsd: 0 }
    const p = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }
    assert.equal(chargeOf(u, { pricing: p, source: 'catalog' }).basis, 'estimate')
    assert.equal(chargeOf(u, { pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: 'catalog' }).basis, 'reported', 'a zero-priced (subscription) model may report $0')
    assert.equal(budgetVerdict({ usage: u, usageEvents: 1, iterations: 1 }, { budgetUsd: 0.05, budgetTokens: 1e9, pricing: p, allowUnmetered: false })?.stop, 'budget')
  })
  test('N1: a relative worktree link that resolves to the admin dir is not tampering', () => {
    const repo = mkRepo(); const wt = join(tmp('rel'), 'w')
    execFileSync('git', ['worktree', 'add', '--detach', wt], { cwd: repo, stdio: 'ignore' })
    const admin = readFileSync(join(wt, '.git'), 'utf8').trim().slice('gitdir: '.length)
    writeFileSync(join(wt, '.git'), `gitdir: ${join('..', '..', admin.split('/').slice(-5).join('/')).replace(/^/, '')}\n`)
    const rel = (execFileSync('realpath', ['--relative-to', wt, admin], { encoding: 'utf8' })).trim()
    writeFileSync(join(wt, '.git'), `gitdir: ${rel}\n`)
    assert.equal(gitLinkProblem(wt, admin), null)
  })
})

describe('review 5: a stop between admission and launch launches nothing', () => {
  test('stop requested right after admission: no worker starts, the attempt ends cancelled, claims released', T, async () => {
    const e = env(); let launches = 0
    const m = await mission(e, { tasks: [task('a', { prompt: '[[hang]]' })], deps: { runWorker: (async (...args: Parameters<typeof runWorker>) => { launches++; return runWorker(...args) }) as typeof runWorker } })
    const append = m.ledger.append.bind(m.ledger)
    m.ledger.append = (kind, t, d) => { const r = append(kind, t, d); if (kind === 'attempt_admitted') m.live.stopRequested = 'signal arrived during admission (test)'; return r }
    const v = await m.run()
    assert.equal(launches, 0); assert.equal(v.state, 'STOPPED')
    assert.ok([...m.ledger.entries()].some(x => x.kind === 'attempt_not_launched'))
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 0)
  })
})

describe('review 6: a mission that cannot progress ends instead of polling', () => {
  test('a role with concurrency 0 ends the mission with the task refused', { timeout: 30_000 }, async () => {
    const e = env(); const c = config({ limits: { concurrency: { coder: 0 } } })
    const m = await mission(e, { config: c, tasks: [task('a')] })
    const v = await m.run()
    assert.equal(v.state, 'FAILED'); assert.match(byId(m, 'a').reason ?? '', /blocked: waiting: concurrency: 0 coder worker\(s\) of 0/)
  })
})

describe('review 9: a mission resumes only under its own configuration', () => {
  test('a different config is refused on reopen unless explicitly accepted, and acceptance is recorded', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a')] }); await m.run()
    const changed = config({ budgets: { sessionUsd: 99 } })
    assert.throws(() => Mission.open(e.root, m.header.id, changed, m.resolutions, deps(e)), /was created with config/)
    const ok = Mission.open(e.root, m.header.id, changed, m.resolutions, deps(e), { acceptConfigChange: true })
    assert.ok([...ok.ledger.entries()].some(x => x.kind === 'config_changed'))
    assert.ok((ok.live.problems ?? []).some(p => /different configuration/.test(p)))
  })
})

describe('review 10c: in-flight spend is reserved at admission', () => {
  test('with headroom for one estimate, a second worker waits until the first is charged', T, async () => {
    const e = env(); const c = config({ budgets: { sessionUsd: 0.1 }, limits: { concurrency: { total: 3 } } })
    const m = await mission(e, { config: c, tasks: ['a', 'b'].map(id => task(id, { prompt: `[[delay:400]] [[write:src/${id}/x=1]]` })) })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    const [a, b] = ['a', 'b'].map(id => byId(m, id).attempts[0])
    const overlap = Date.parse(b.startedAt) < Date.parse(a.endedAt as string) && Date.parse(a.startedAt) < Date.parse(b.endedAt as string)
    assert.equal(overlap, false, 'the second estimate did not fit beside the first')
  })
})

describe('review 12 and nits', () => {
  test('stale-lock takeover cannot delete a lock another contender just took', () => {
    const d = tmp('toctou'); const f = join(d, 'x.lock')
    const stale: LockBody = { holder: { pid: 999999, start: '1', boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }, host: (globalThis as { process: NodeJS.Process }).process.env.HOSTNAME ?? '', at: 'then', purpose: 'dead' }
    stale.host = execFileSync('hostname', { encoding: 'utf8' }).trim()
    writeFileSync(f, JSON.stringify(stale))
    assert.equal(breakStaleLock(f, stale), true)           // contender A removes the stale lock
    assert.equal(tryLock(f, 'A').ok, true)                 // and takes it
    assert.equal(breakStaleLock(f, stale), false)          // contender B, acting on the old view, must not remove A's lock
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).purpose, 'A')
    assert.equal(readdirSync(d).filter(n => n.includes('.stale-')).length, 0)
  })
  test('a deleted ledger makes the verdict BLOCKED, not DONE', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a')] }); await m.run()
    rmSync(join(m.dir, 'ledger'), { recursive: true }); assert.equal(existsSync(join(m.dir, 'ledger')), false)
    assert.equal(m.verdict().state, 'BLOCKED')
  })
  test('the repository marker is retired when a mission ends with no claims', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a')] }); await m.run()
    assert.equal(existsSync(join(e.repo, '.git', 'cobalt-cockpit-cline', 'missions', `${m.header.id}.json`)), false)
  })
  void allTasks
})
