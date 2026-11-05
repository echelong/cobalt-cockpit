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
  test('a gate that writes a credential is caught after the gates', T, async () => {
    const e = env(); const secret = ['sk', 'ant', 'api03', 'R'.repeat(30) + '-' + 'y'.repeat(20)].join('-')
    const m = await mission(e, { tasks: [task('a')], gates: [{ name: 'leak', command: `echo 'KEY=${secret}' > src/a/leak.txt`, required: true }] })
    assert.notEqual((await m.run()).state, 'DONE')
    assert.match(byId(m, 'a').attempts[0].failureDetail ?? '', /SECURITY\(after gates\)/)
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
    await again.run()
    assert.equal(listClaims(join(e.repo, '.git')).claims.length, 0, 'recovery released the claim after re-checking')
    assert.ok([...again.ledger.entries()].some(x => x.kind === 'reconciled' && JSON.stringify(x.data).includes('interrupted after the worker ended')))
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
