// Adversarial isolation: each attack runs as a shell command INSIDE the real worker sandbox (the same spec
// runWorker builds, with the forwarder and a live broker) or inside a real gate, with no policy hook in the
// way, so only the operating system boundary (or the broker) can stop it.
//
// Non-vacuous by construction:
//   - every secret ("canary") lives in a temporary directory under the person's HOME on the host, which is
//     persistent storage that no sandbox mounts (not /tmp, /var/tmp or /run, which are private tmpfs inside),
//     and each test first checks on the host that the canary is really there;
//   - every denial is paired with a positive control: the same tool succeeding on an allowed target, so an
//     attack cannot "pass" because the tool is missing or broken inside the sandbox.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { connect as netConnect, createServer as netServer } from 'node:net'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { launch, mountProblem, strippedGitConfig } from '../src/sandbox.ts'
import { expiry, realToken, startBroker } from '../src/broker.ts'
import { classifyFailureText } from '../src/router.ts'
import type { Broker, BrokerLimits } from '../src/broker.ts'
import { attestWire, runWorker, viaBroker, workerSandbox } from '../src/worker.ts'
import { runCommandGate } from '../src/gates.ts'
import { readWireCaptures } from '../src/reasoning.ts'
import { PACKAGE_DIR } from '../src/config.ts'
import { shareDir, UsageError } from '../src/cli.ts'
import { allTasks, clineData, env, FAKE, git, mission, task, TEST_REAL_TOKEN, tmp } from './helpers.ts'

const T = { timeout: 120_000 }
const CANARY = mkdtempSync(join(homedir(), '.ccl-iso-'))
const SECRET = `SECRET-${Math.random().toString(16).slice(2)}`
const servers: Server[] = []
after(() => { for (const s of servers) s.close(); rmSync(CANARY, { recursive: true, force: true }) })
const plant = (rel: string, text = SECRET): string => { const p = join(CANARY, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); assert.equal(readFileSync(p, 'utf8'), text, 'the canary exists on the host'); return p }

/** A stand-in for the Cline API, reached only by the host-side broker; records what arrives. */
type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string }
const upstream = async (o: { refresh?: (seen: Seen) => Promise<unknown> | unknown; usage?: { prompt_tokens: number; completion_tokens: number; cost?: number } } = {}): Promise<{ url: string; seen: Seen[] }> => {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c }); req.on('end', () => { void (async () => {
      const s = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }; seen.push(s)
      if (req.url === '/api/v1/auth/refresh') {
        const answer = o.refresh ? await o.refresh(s) : { success: true, data: { accessToken: 'REFRESHED-ACCESS', refreshToken: 'REFRESHED-REFRESH', expiresAt: new Date(Date.now() + 3600_000).toISOString(), tokenType: 'Bearer', userInfo: { clineUserId: 'acct-test' } } }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer)); return
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, usage: o.usage ?? { prompt_tokens: 1, completion_tokens: 1 } }))
    })() })
  })
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen }
}

/** Runs `script` with bash inside a worker sandbox exactly as runWorker builds it. */
const attack = async (script: string, o: { workdir?: string; gitCommonDir?: string | null; data?: string; up?: string; limits?: BrokerLimits } = {}): Promise<{ code: number | null; out: string; broker: Broker }> => {
  const run = tmp('iso-run'); const ro = join(run, 'ro'), rw = join(run, 'rw'), home = join(rw, 'home')
  for (const d of [ro, rw, home]) mkdirSync(d, { recursive: true })
  writeFileSync(join(ro, 'policy.json'), '{}')
  const workdir = o.workdir ?? tmp('iso-wd'); writeFileSync(join(workdir, 'own.txt'), 'OWN')
  const broker = await startBroker({ dataDir: o.data ?? clineData(), provider: 'cline', upstream: o.up ?? (await upstream()).url, model: 'deepseek/deepseek-v4.1-flash-1017', effort: 'max', ...o.limits })
  const spec = workerSandbox({ workdir, writable: true, gitCommonDir: o.gitCommonDir ?? null, gitAdminDir: null, clineBin: FAKE, allowRead: [], hide: [], attemptId: `iso-${Date.now()}`, binds: [] }, { ro, rw, home }, broker.socketDir)
  const { child } = launch(spec, [...viaBroker(broker.socketPath), 'bash', '-c', `export FAKE='${broker.fakeToken}'\n${script}`])
  let out = ''; child.stdout?.on('data', d => { out += d }); child.stderr?.on('data', d => { out += d })
  const code = await new Promise<number | null>(r => child.on('exit', c => r(c)))
  await broker.close()
  return { code, out, broker }
}
/** Lines "name=ok" / "name=FAIL": `deny` is ok when the command FAILED, `allow` when it SUCCEEDED (the positive control). */
const verdicts = (out: string): Record<string, string> => Object.fromEntries(out.split('\n').filter(l => /^[a-z0-9_-]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const ok = (out: string, names: string[]): void => { const v = verdicts(out); for (const n of names) assert.equal(v[n], 'ok', `${n}: expected ok\n${out}`) }
const deny = (name: string, cmd: string): string => `if ${cmd} >/dev/null 2>&1; then echo "${name}=FAIL"; else echo "${name}=ok"; fi`
const allow = (name: string, cmd: string): string => `if ${cmd} >/dev/null 2>&1; then echo "${name}=ok"; else echo "${name}=FAIL"; fi`
const node = (js: string): string => `node -e ${JSON.stringify(js)}`
const conn = (target: string): string => node(`const s=require('net').connect(${target});s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000)`)
const sha = (f: string): string => createHash('sha256').update(readFileSync(f, 'utf8')).digest('hex')

describe('isolation: files outside the task are not there', () => {
  test('an unrelated repository and its secrets cannot be read or listed (positive control: the worktree is readable)', T, async () => {
    const secret = plant('other-repo/secret.txt'); const env1 = plant('other-repo/.env', `TOKEN=${SECRET}`)
    const r = await attack([allow('own_file', 'cat own.txt'), allow('ls_works', 'ls /usr'), deny('read_other', `cat ${secret}`), deny('read_other_env', `cat ${env1}`), deny('list_other', `ls ${join(CANARY, 'other-repo')}`), allow('grep_works', 'grep -q OWN own.txt'), deny('grep_home', `grep -rq ${SECRET} ${homedir()}`)].join('\n'))
    ok(r.out, ['own_file', 'ls_works', 'read_other', 'read_other_env', 'list_other', 'grep_works', 'grep_home']); assert.ok(!r.out.includes(SECRET))
  })
  test('the source checkout\'s untracked .env is absent; the worktree and its git history work', T, async () => {
    const repo = join(CANARY, 'proj'); mkdirSync(repo); execFileSync('git', ['init', '-q', '-b', 'main', repo]); writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a')
    plant('proj/.env', `API_KEY=${SECRET}`)
    const wt = join(CANARY, 'proj-wt'); git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
    const r = await attack([allow('worktree_file', `cat ${wt}/a.txt`), allow('git_works', 'git -C . log --oneline -1'), deny('env_in_checkout', `cat ${repo}/.env`), deny('checkout_file', `cat ${repo}/a.txt`), deny('env_in_worktree', `cat ${wt}/.env`)].join('\n'), { workdir: wt, gitCommonDir: join(repo, '.git') })
    ok(r.out, ['worktree_file', 'git_works', 'env_in_checkout', 'checkout_file', 'env_in_worktree']); assert.ok(!r.out.includes(SECRET))
  })
  test('the real home, keys, Cline settings, other projects and the rest of the Cockpit repository are absent', T, async () => {
    const h = homedir(); const repo = join(PACKAGE_DIR, '..')
    const checks: [string, string][] = ([
      ['ssh', `${h}/.ssh`], ['real_cline', `${h}/.cline/data/settings/providers.json`], ['claude', `${h}/.claude-main`], ['cockpit_readme', `${repo}/README.md`], ['cockpit_tests', `${repo}/tests`], ['cockpit_git', `${repo}/.git`],
      ...(() => { try { return readdirSync(join(h, 'Projects')).filter(n => n !== 'cobalt-cockpit-cline').slice(0, 5).map((n, i) => [`other_project_${i}`, join(h, 'Projects', n)] as [string, string]) } catch { return [] } })(),
    ] as [string, string][]).filter(([, p]) => existsSync(p))
    assert.ok(checks.length >= 4, 'enough real host paths exist for the check to mean something')
    const r = await attack([allow('hook_code_visible', `test -r ${PACKAGE_DIR}/src/sandbox.ts`), ...checks.map(([n, p]) => deny(n, `ls -d ${p}`)), deny('home_files', `test -n "$(find ${h} -maxdepth 1 -type f 2>/dev/null)"`), `test "$HOME" != "${h}" && echo home_disposable=ok || echo home_disposable=FAIL`].join('\n'))
    ok(r.out, ['hook_code_visible', ...checks.map(([n]) => n), 'home_files', 'home_disposable'])
  })
  test('/etc is an allowlist: name service files are there, the rest of /etc is not', T, async () => {
    const hidden = ['fstab', 'sudoers.d', 'NetworkManager', 'ssh', 'environment', 'security'].filter(f => existsSync(`/etc/${f}`))
    assert.ok(hidden.length >= 2)
    const r = await attack([allow('passwd', 'getent passwd root'), allow('localhost', 'getent hosts localhost'), ...hidden.map((f, i) => deny(`etc_${i}`, `ls -d /etc/${f}`))].join('\n'))
    ok(r.out, ['passwd', 'localhost', ...hidden.map((_, i) => `etc_${i}`)])
  })
})

describe('isolation: the repository\'s git directory', () => {
  test('remote URLs with tokens, credential helpers and commands are stripped from the git config; the claim store and fsmonitor socket are covered', T, async () => {
    const repo = join(CANARY, 'gitrepo'); mkdirSync(repo); execFileSync('git', ['init', '-q', '-b', 'main', repo]); writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a')
    git(repo, 'remote', 'add', 'origin', `https://user:${SECRET}@example.invalid/x.git`); git(repo, 'config', 'credential.helper', 'store'); git(repo, 'config', 'core.sshCommand', `echo ${SECRET}`)
    assert.ok(readFileSync(join(repo, '.git', 'config'), 'utf8').includes(SECRET), 'the canary is in the host git config')
    plant('gitrepo/.git/cobalt-cockpit-cline/claims/m__t.json', JSON.stringify({ secret: SECRET }))
    const ipc = join(repo, '.git', 'fsmonitor--daemon.ipc'); const fsm = netServer(s => { s.on('error', () => {}); s.end('FSMONITOR') }); await new Promise<void>(r => fsm.listen(ipc, () => r()))
    const wt = join(CANARY, 'gitrepo-wt'); git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
    const r = await attack([allow('git_status', 'git -C . status --porcelain'), allow('format_kept', 'git -C . config core.repositoryformatversion'), deny('remote_url', `git -C . config --list | grep -q ${SECRET}`), deny('config_file', `grep -q ${SECRET} ${repo}/.git/config`), deny('claims', `ls ${repo}/.git/cobalt-cockpit-cline/claims/m__t.json`), deny('fsmonitor', conn(`{path:'${ipc}'}`))].join('\n'), { workdir: wt, gitCommonDir: join(repo, '.git') })
    fsm.close()
    ok(r.out, ['git_status', 'format_kept', 'remote_url', 'config_file', 'claims', 'fsmonitor']); assert.ok(!r.out.includes(SECRET))
  })
  test('strippedGitConfig keeps only format keys and extensions', () => {
    const out = strippedGitConfig('[core]\n\trepositoryformatversion = 1\n\tsshCommand = evil\n\thooksPath = /x\n[extensions]\n\tobjectformat = sha256\n[remote "origin"]\n\turl = https://u:t@h/x\n[credential]\n\thelper = store\n[include]\n\tpath = /etc/x\n')
    assert.equal(out, '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n')
  })
  test('the worktree\'s .git link cannot be removed, replaced or written; the admin dir and the attempt\'s policy are read-only', T, async () => {
    const repo = join(CANARY, 'linkrepo'); mkdirSync(repo); execFileSync('git', ['init', '-q', '-b', 'main', repo]); writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a')
    const wt = join(CANARY, 'linkrepo-wt'); git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
    const before = readFileSync(join(wt, '.git'), 'utf8')
    const r = await attack([allow('write_worktree', 'sh -c "echo x > new.txt"'), deny('rm_git', 'rm .git'), deny('mv_git', 'mv .git moved'), deny('write_git', 'sh -c "echo gitdir: /tmp > .git"'), deny('write_admin', `touch ${repo}/.git/worktrees/linkrepo-wt/HEAD`), deny('write_policy', 'sh -c "echo {} > \\"$COCKPIT_POLICY\\""')].join('\n'), { workdir: wt, gitCommonDir: join(repo, '.git') })
    ok(r.out, ['write_worktree', 'rm_git', 'mv_git', 'write_git', 'write_admin', 'write_policy'])
    assert.equal(readFileSync(join(wt, '.git'), 'utf8'), before)
  })
})

describe('isolation: Cline credentials and settings', () => {
  test('a real worker run never sees the real token or another provider\'s key, and cannot change the real Cline data', T, async () => {
    const e = env()
    const before = sha(join(e.data, 'settings', 'providers.json'))
    const probe = `printenv > env.txt; cat "$HOME"/../cline-data/settings/providers.json > seen.json 2>&1; ls ${e.data} > ls.txt 2>&1; true`
    const m = await mission(e, { tasks: [task('a', { owned: ['*'], prompt: `[[cmd:${probe}]] [[write:src/a/x=1]]` })] })
    await m.run()
    assert.equal(sha(join(e.data, 'settings', 'providers.json')), before, 'the real Cline data is unchanged')
    const runDir = join(m.dir, 'runs', 'a', '1')
    for (const f of execFileSync('find', [runDir, '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean)) { const t = readFileSync(f, 'utf8'); assert.ok(!t.includes(TEST_REAL_TOKEN) && !t.includes('OTHER-PROVIDER-KEY'), `${f} holds a real credential`) }
    const wt = allTasks(m)[0].attempts[0].worktree as string
    assert.match(readFileSync(join(wt, 'seen.json'), 'utf8'), /cockpit-broker/, 'positive control: the worker did read its own (fake) Cline data')
    for (const f of ['env.txt', 'seen.json', 'ls.txt']) { const t = readFileSync(join(wt, f), 'utf8'); assert.ok(!t.includes(TEST_REAL_TOKEN) && !t.includes('OTHER-PROVIDER-KEY'), `${f} leaked a credential`) }
    assert.match(readFileSync(join(wt, 'ls.txt'), 'utf8'), /No such file/)
  })
  test('writing the real Cline data from inside fails, and the host file is unchanged', T, async () => {
    const data = clineData(join(CANARY, 'cline-data')); const f = join(data, 'settings', 'providers.json'); const before = sha(f)
    const r = await attack([allow('write_home', 'sh -c "echo x > \\"$HOME/x\\""'), deny('append_real', `sh -c "echo pwn >> ${f}"`), deny('replace_real', `cp own.txt ${f}`)].join('\n'), { data })
    ok(r.out, ['write_home', 'append_real', 'replace_real']); assert.equal(sha(f), before)
  })
})

describe('isolation: network', () => {
  test('host localhost services, abstract and filesystem unix sockets, buses, DNS and the internet are unreachable (positive control: the broker port is)', T, async () => {
    const tcp = netServer(s => { s.on('error', () => {}); s.end('HOST-SERVICE') }); await new Promise<void>(r => tcp.listen(0, '127.0.0.1', () => r()))
    const port = (tcp.address() as { port: number }).port
    // positive control on the host: the service is really listening
    const probe = netConnect(port, '127.0.0.1'); await new Promise<void>((r, j) => { probe.once('connect', () => { probe.on('error', () => {}); probe.destroy(); r() }); probe.once('error', j) })
    const abstract = `ccl-iso-${process.pid}`; const abs = netServer(s => { s.on('error', () => {}); s.end('ABSTRACT') }); await new Promise<void>(r => abs.listen(`\0${abstract}`, () => r()))
    const path = join(CANARY, 'svc.sock'); const fsock = netServer(s => { s.on('error', () => {}); s.end('FSOCK') }); await new Promise<void>(r => fsock.listen(path, () => r()))
    const uid = userInfo().uid
    const r = await attack([
      allow('broker_port', conn("8899,'127.0.0.1'")), allow('resolver_works', 'getent hosts localhost'), allow('procnet', 'test -r /proc/net/dev'),
      deny('tcp_localhost', conn(`${port},'127.0.0.1'`)), deny('abstract_socket', conn(`{path:'\\0${abstract}'}`)), deny('fs_socket', conn(`{path:'${path}'}`)),
      deny('user_bus', `test -e /run/user/${uid}/bus`), deny('system_bus', 'test -e /run/dbus/system_bus_socket'),
      deny('internet_ip', conn("443,'1.1.1.1'")), deny('dns', 'getent hosts example.com'),
      deny('not_only_loopback', "awk 'NR>2{print $1}' /proc/net/dev | grep -v '^lo:' | grep -q ."),
    ].join('\n'))
    tcp.close(); abs.close(); fsock.close()
    ok(r.out, ['broker_port', 'resolver_works', 'procnet', 'tcp_localhost', 'abstract_socket', 'fs_socket', 'user_bus', 'system_bus', 'internet_ip', 'dns', 'not_only_loopback'])
  })
  test('through the broker only Cline\'s own requests reach the one fixed origin, with the real token; everything else is refused', T, async () => {
    const up = await upstream()
    const req = (method: string, path: string, body = '{"model":"deepseek/deepseek-v4.1-flash-1017","reasoning_effort":"max"}', ct = 'application/json'): string => node(`const h=require('http');const r=h.request({host:'127.0.0.1',port:8899,method:${JSON.stringify(method)},path:${JSON.stringify(path)},headers:{'content-type':${JSON.stringify(ct)},authorization:'Bearer workos:'+process.env.FAKE}},s=>{s.resume();s.on('end',()=>console.log('R '+s.statusCode))});r.on('error',e=>console.log('R ERR '+e.message));r.end(${method === 'GET' ? '' : JSON.stringify(body)})`)
    const turn = (body: string, ct?: string): string => req('POST', '/api/v1/chat/completions', body, ct)
    const cases: [string, boolean][] = [
      [req('POST', '/api/v1/chat/completions'), true], [req('GET', '/api/v1/ai/cline/recommended-models'), true],
      [req('GET', '/api/v1/users/me'), false], [req('POST', '/api/v1/users/me/api-keys'), false], [req('GET', '/etc/passwd'), false], [req('GET', '/api/v1/auth/refresh'), false],
      [req('GET', '/api/v2/models'), false], [req('GET', '/api/v1/../../admin'), false], [req('DELETE', '/api/v1/x'), false], [req('GET', 'http://evil.example/api/v1/models'), false],
      [req('GET', '/api/v1%2fmodels'), false], [req('GET', '/api/v1/models?x=<script>'), false],
      [turn('{"model":"moonshotai/kimi-k3.1-pro","reasoning_effort":"max"}'), false], [turn('{"model":"deepseek/deepseek-v4.1-flash-1017"}'), false], [turn('{"model":"deepseek/deepseek-v4.1-flash-1017","reasoning_effort":"high"}'), false],
      [turn('{"model":"deepseek/deepseek-v4.1-flash-1017","reasoning_effort":"max","models":["moonshotai/kimi-k3.1-pro"]}'), false], [turn('{"MODEL":"moonshotai/kimi-k3.1-pro","model":"deepseek/deepseek-v4.1-flash-1017","reasoning_effort":"max"}'), false],
      [turn('{"model":"deepseek/deepseek-v4.1-flash-1017","reasoning_effort":"max","reasoning":{"effort":"low"}}'), false], [turn('{"model":"deepseek/deepseek-v4.1-flash-1017","reasoning_effort":"max"}', 'text/plain'), false],
      [turn('{"model":"moonshotai/kimi-k3.1-pro","model":"deepseek/deepseek-v4.1-flash-1017","reasoning_effort":"max"}'), true],
    ]
    const r = await attack(cases.map(([c]) => c).join('\n'), { up: up.url })
    const codes = r.out.split('\n').filter(l => l.startsWith('R ')).map(l => l.slice(2))
    assert.equal(codes.length, cases.length, r.out)
    assert.deepEqual(codes.map(c => /^[23]\d\d$/.test(c)), cases.map(([, allowed]) => allowed), r.out)
    assert.ok(codes.every(c => /^\d{3}$/.test(c)), `every request got an HTTP answer: ${codes.join(' ')}`)
    // the stand-in Cline API received exactly the allowed requests, carrying the REAL token, never the fake
    assert.deepEqual(up.seen.map(x => `${x.method} ${x.url}`), ['POST /api/v1/chat/completions', 'GET /api/v1/ai/cline/recommended-models', 'POST /api/v1/chat/completions'])
    for (const x of up.seen) { assert.equal(x.headers.authorization, `Bearer workos:${TEST_REAL_TOKEN}`); assert.ok(!JSON.stringify(x).includes(r.broker.fakeToken)) }
    // what the broker checked is what it sent: the duplicate-key body arrives with one model key, the routed one
    assert.deepEqual(JSON.parse(up.seen[2].body), { model: 'deepseek/deepseek-v4.1-flash-1017', reasoning_effort: 'max' }); assert.equal((up.seen[2].body.match(/"model"/g) ?? []).length, 1)
  })
  test('the broker enforces the attempt\'s budget from the API\'s own usage figures, and caps requests', T, async () => {
    const up = await upstream({ usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.004 } })
    const turn = node(`const h=require('http');const r=h.request({host:'127.0.0.1',port:8899,method:'POST',path:'/api/v1/chat/completions',headers:{'content-type':'application/json',authorization:'Bearer workos:'+process.env.FAKE}},s=>{s.resume();s.on('end',()=>console.log('S '+s.statusCode))});r.end(JSON.stringify({model:'deepseek/deepseek-v4.1-flash-1017',reasoning_effort:'max'}))`)
    const r = await attack([turn, turn, turn, turn].join('\n'), { up: up.url, limits: { budgetUsd: 0.007 } })
    assert.deepEqual(r.out.split('\n').filter(l => l.startsWith('S ')), ['S 200', 'S 200', 'S 402', 'S 402'], r.out)
    assert.equal(up.seen.length, 2); assert.equal(r.broker.spent.usd, 0.008); assert.equal(r.broker.spent.tokens, 6)
    const t = await attack([turn, turn, turn].join('\n'), { up: up.url, limits: { maxRequests: 1 } })
    assert.deepEqual(t.out.split('\n').filter(l => l.startsWith('S ')), ['S 200', 'S 429', 'S 429'], t.out)
  })
  test('host-attested wire: another model, another or a missing effort, a broker refusal, or no carried turn at all are never "confirmed"', () => {
    const cap = { state: 'confirmed' as const, requests: 1, effective: 'max', models: ['m'], detail: 'captures (written inside the sandbox)' }
    const rec = (o: Partial<{ model: string | null; effort: string | null; refused: string }>) => ({ at: '', method: 'POST', path: '/api/v1/chat/completions', status: 200, model: 'm', effort: 'max', bytesIn: 1, ...o })
    assert.equal(attestWire(cap, [rec({})], 'm', 'max').state, 'confirmed')
    assert.equal(attestWire(cap, [rec({ model: 'other' })], 'm', 'max').state, 'mismatch')
    assert.equal(attestWire(cap, [rec({ effort: 'high' })], 'm', 'max').state, 'mismatch')
    assert.equal(attestWire(cap, [rec({ effort: null })], 'm', 'max').state, 'mismatch', 'a turn with no effort is not the routed max')
    assert.equal(attestWire(cap, [rec({ refused: 'reasoning effort high is not the routed max' })], 'm', 'max').state, 'mismatch')
    assert.equal(attestWire(cap, [], 'm', 'max', 3).state, 'unconfirmed', 'captures alone never confirm a run that took model turns')
    assert.equal(attestWire(cap, [rec({ effort: 'high' })], 'm', 'on').state, 'confirmed', 'MiMo: toggle on, effort high on the wire (seen live)')
  })
})

describe('isolation: the host-side refresh never loses the owner\'s sign-in', () => {
  const expired = (dir: string): string => { const f = join(dir, 'settings', 'providers.json'); const d = JSON.parse(readFileSync(f, 'utf8')); d.providers.cline.settings.auth.expiresAt = Date.now() - 60_000; writeFileSync(f, JSON.stringify(d)); return f }
  test('one refresh under Cline\'s lock for concurrent requests; only this provider\'s auth changes; a backup is kept', T, async () => {
    const up = await upstream(); const data = clineData(); const f = expired(data)
    const broker = await startBroker({ dataDir: data, provider: 'cline', upstream: up.url })
    const call = (): Promise<number> => new Promise(res => { const r = request({ socketPath: broker.socketPath, path: '/api/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer workos:${broker.fakeToken}`, 'content-type': 'application/json' } }, s => { s.resume(); s.on('end', () => res(s.statusCode ?? 0)) }); r.end('{}') })
    assert.deepEqual(await Promise.all([call(), call(), call()]), [200, 200, 200]); await broker.close()
    assert.equal(up.seen.filter(s => s.url === '/api/v1/auth/refresh').length, 1)
    assert.ok(up.seen.filter(s => s.url === '/api/v1/chat/completions').every(s => s.headers.authorization === 'Bearer workos:REFRESHED-ACCESS'))
    const now = JSON.parse(readFileSync(f, 'utf8'))
    assert.equal(now.providers.cline.settings.auth.accessToken, 'REFRESHED-ACCESS'); assert.equal(now.providers.cline.settings.auth.refreshToken, 'REFRESHED-REFRESH')
    assert.equal(now.providers.anthropic.settings.apiKey, 'OTHER-PROVIDER-KEY-must-never-enter-a-sandbox')
    assert.ok(existsSync(`${f}.cockpit-backup`)); assert.equal(execFileSync('stat', ['-c', '%a', f], { encoding: 'utf8' }).trim(), '600'); assert.ok(!existsSync(`${f}.cockpit-refresh`))
  })
  test('a change another process makes to providers.json during the refresh is kept', T, async () => {
    const data = clineData(); const f = expired(data)
    const up = await upstream({ refresh: () => { const d = JSON.parse(readFileSync(f, 'utf8')); d.providers.added = { settings: { provider: 'added', apiKey: 'NEW' } }; d.providers.cline.settings.model = 'changed-by-owner'; writeFileSync(f, JSON.stringify(d)); return { success: true, data: { accessToken: 'A2', refreshToken: 'R2', expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { clineUserId: 'acct-test' } } } } })
    assert.equal(await realToken(data, 'cline', up.url), 'A2')
    const now = JSON.parse(readFileSync(f, 'utf8'))
    assert.equal(now.providers.added.settings.apiKey, 'NEW'); assert.equal(now.providers.cline.settings.model, 'changed-by-owner'); assert.equal(now.providers.cline.settings.auth.refreshToken, 'R2')
  })
  test('an expiry given as epoch seconds, milliseconds or not at all never discards the new tokens', async () => {
    assert.equal(expiry(1_800_000_000), 1_800_000_000_000); assert.equal(expiry(1_800_000_000_000), 1_800_000_000_000); assert.equal(expiry('1800000000'), 1_800_000_000_000); assert.ok(Number.isNaN(expiry('soon')))
    for (const expiresAt of [Math.floor(Date.now() / 1000) + 3600, Date.now() + 3600_000, 'not-a-date']) {
      const data = clineData(); const f = expired(data)
      const up = await upstream({ refresh: () => ({ success: true, data: { accessToken: 'A3', refreshToken: 'R3', expiresAt, userInfo: { clineUserId: 'acct-test' } } }) })
      assert.equal(await realToken(data, 'cline', up.url), 'A3')
      const a = JSON.parse(readFileSync(f, 'utf8')).providers.cline.settings.auth
      assert.equal(a.refreshToken, 'R3'); assert.ok(a.expiresAt > Date.now(), String(expiresAt))
    }
  })
  test('if saving fails after the server answered, the answer (with any rotated token) is kept in a 0600 recovery file and providers.json is untouched', async () => {
    const data = clineData(); const f = expired(data); const before = sha(f)
    mkdirSync(`${f}.cockpit-${process.pid}.tmp`) // the temporary file cannot be created: the save fails
    const up = await upstream({ refresh: () => ({ success: true, data: { accessToken: 'A4', refreshToken: 'ROTATED', expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { clineUserId: 'acct-test' } } }) })
    await assert.rejects(realToken(data, 'cline', up.url), /kept in .*cockpit-refresh/)
    assert.equal(sha(f), before); assert.match(readFileSync(`${f}.cockpit-refresh`, 'utf8'), /ROTATED/); assert.equal(execFileSync('stat', ['-c', '%a', `${f}.cockpit-refresh`], { encoding: 'utf8' }).trim(), '600')
  })
})

describe('isolation: escapes', () => {
  test('symlinks, procfs, mounts and nested namespaces lead nowhere (positive controls for each tool)', T, async () => {
    const secret = plant('link-target.txt')
    const wd = tmp('iso-wd'); symlinkSync(secret, join(wd, 'link')); symlinkSync('/', join(wd, 'root')); symlinkSync('own.txt', join(wd, 'inner'))
    const r = await attack([
      allow('inner_link', 'cat inner'), deny('symlink_read', 'cat link'), deny('symlink_root', `ls root${CANARY}`), deny('traversal', `cat ../../../../../../..${secret}`),
      allow('proc_self', 'test -r /proc/self/status'), deny('host_pids', `test "$(ls /proc | grep -c '^[0-9]')" -gt 20`), deny('host_proc', `test -e /proc/${process.pid}/environ`), deny('proc1_root', `ls /proc/1/root${CANARY}`),
      allow('mount_present', 'command -v mount'), deny('mount', 'mount -t tmpfs x /tmp'), allow('unshare_present', 'command -v unshare'), deny('unshare_user', 'unshare -Ur true'), deny('unshare_mount', 'unshare -m true'),
      allow('bwrap_present', 'command -v bwrap'), deny('nested_bwrap', 'bwrap --ro-bind /usr /usr true'), deny('block_devices', 'ls /dev/sda /dev/nvme0n1 /dev/mem'),
      allow('touch_present', 'touch own.txt'), deny('write_usr', 'touch /usr/ccl-escape'), deny('write_root', 'touch /ccl-escape'), deny('write_etc', 'touch /etc/ccl-escape'),
    ].join('\n'), { workdir: wd })
    ok(r.out, ['inner_link', 'symlink_read', 'symlink_root', 'traversal', 'proc_self', 'host_pids', 'host_proc', 'proc1_root', 'mount_present', 'mount', 'unshare_present', 'unshare_user', 'unshare_mount', 'bwrap_present', 'nested_bwrap', 'block_devices', 'touch_present', 'write_usr', 'write_root', 'write_etc'])
    assert.ok(!r.out.includes(SECRET))
  })
  test('nothing persists outside the worktree: writes to host paths that are not mounted fail, and nothing appears on the host', T, async () => {
    const mark = `ccl-escape-${process.pid}-${Date.now()}`
    const targets = [CANARY, homedir(), join(homedir(), 'Projects')]
    const r = await attack([allow('write_worktree', `sh -c "echo x > ${mark}"`), ...targets.map((p, i) => deny(`write_${i}`, `sh -c "echo x > ${p}/${mark}"`))].join('\n'))
    ok(r.out, ['write_worktree', ...targets.map((_, i) => `write_${i}`)])
    for (const p of targets) assert.ok(!existsSync(join(p, mark)), `${p}/${mark} persisted on the host`)
  })
  test('no privilege can be gained: no_new_privs, no capabilities, a setuid binary does not run as root', T, async () => {
    const r = await attack([
      "grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status && echo nnp=ok || echo nnp=FAIL",
      "grep -q '^CapEff:[[:space:]]*0000000000000000' /proc/self/status && echo no_caps=ok || echo no_caps=FAIL",
      "grep -q '^CapPrm:[[:space:]]*0000000000000000' /proc/self/status && echo no_perm_caps=ok || echo no_perm_caps=FAIL",
      // sudo is setuid root: with no_new_privs the kernel ignores that bit, which sudo reports in so many words
      "if command -v sudo >/dev/null; then sudo -n true 2>&1 | grep -qiE 'no new privileges|effective uid is not 0' && echo setuid_ignored=ok || echo setuid_ignored=FAIL; else echo setuid_ignored=ok; fi",
    ].join('\n'))
    ok(r.out, ['nnp', 'no_caps', 'no_perm_caps', 'setuid_ignored'])
  })
  test('the host never follows a link a worker planted where it reads worker output', () => {
    const cap = tmp('iso-cap'); const target = plant('host-secret.json', JSON.stringify({ timestamp: 'x', payload: { body: { model: SECRET } } }))
    symlinkSync(target, join(cap, 'cap_run_x.wire_request.1.provider-request.json'))
    const caps = readWireCaptures(cap)
    assert.deepEqual(caps.map(c => [c.source, c.model]), [['unreadable', null]]); assert.ok(!JSON.stringify(caps).includes(SECRET))
    const dirLink = join(tmp('iso-cap2'), 'capture'); symlinkSync(CANARY, dirLink)
    assert.deepEqual(readWireCaptures(dirLink), [])
  })
})

describe('isolation: what may be mounted at all', () => {
  test('approved paths are judged on their real path: bypass spellings and symlinks to secrets are refused', () => {
    const h = homedir()
    for (const p of ['/', '/home', h, `${h}/`, `${h}/.`, `${h}/./.ssh`, `${h}//.ssh`, `${h}/.ssh/`, '~/.ssh', '~', '~/.cline/data', '~/.config/gh', '~/.local/share/keyrings', `${h}/x/../.ssh`, 'relative/path']) assert.ok(mountProblem(p), `${p} must be refused`)
    const link = join(CANARY, 'innocent'); symlinkSync(join(h, '.ssh'), link)
    assert.ok(mountProblem(link), 'a symlink to ~/.ssh is refused')
    const up = join(CANARY, 'up'); symlinkSync(h, up)
    assert.ok(mountProblem(up), 'a symlink to the home directory is refused')
    assert.equal(mountProblem('/opt'), null); assert.equal(mountProblem(join(h, '.nvm')), null)
  })
  test('--share must stay inside the repository on its real path', () => {
    const repo = tmp('share-repo'); mkdirSync(join(repo, 'node_modules')); symlinkSync(homedir(), join(repo, 'evil'))
    assert.equal(shareDir(repo, 'node_modules').to, 'node_modules')
    for (const s of ['../x', '/etc', '../../.ssh', 'evil', 'missing']) assert.throws(() => shareDir(repo, s), UsageError, s)
  })
})

describe('isolation: gates run worker code under the same boundary, without any network', () => {
  test('a gate cannot read other repositories, the real home or Cline data, reach the network, or persist outside', T, async () => {
    const other = plant('gate-other/secret.txt')
    const mark = `ccl-gate-escape-${process.pid}`
    const cmd = ['test -r /usr/bin/env', `! cat ${other}`, `! ls -d ${homedir()}/.cline`, '! getent hosts example.com', "! node -e \"require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))\"", `test "$HOME" != "${homedir()}"`, `! sh -c "echo x > ${CANARY}/${mark}"`, "grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status", '! unshare -Ur true', "! awk 'NR>2{print $1}' /proc/net/dev | grep -v '^lo:' | grep -q ."].join(' && ')
    const g = await runCommandGate({ name: 'attack', command: cmd, required: true }, tmp('gate-wd'), tmp('gate-out'), { hide: [], shareDirs: [], timeoutSeconds: 60, gitCommonDir: null }, 'iso')
    assert.equal(g.state, 'pass', g.evidence)
    assert.ok(!existsSync(join(CANARY, mark)))
    // positive control: the same gate machinery reports a real failure
    const bad = await runCommandGate({ name: 'control', command: 'false', required: true }, tmp('gate-wd'), tmp('gate-out'), { hide: [], shareDirs: [], timeoutSeconds: 60, gitCommonDir: null }, 'iso2')
    assert.equal(bad.state, 'fail')
  })
})

describe('isolation: a worker process cannot outlive its attempt', () => {
  test('a detached descendant started through the forwarder is gone when the attempt ends', T, async () => {
    const run = tmp('iso-live'); const wt = tmp('iso-live-wt'); mkdirSync(join(wt, 'src'), { recursive: true })
    const out = await runWorker({ attemptId: `iso-live-${Date.now()}`, runDir: run, workdir: wt, writable: true, gitCommonDir: null, gitAdminDir: null, provider: 'cline', model: 'deepseek/deepseek-v4.1-flash-1017', cliThinking: 'xhigh', expectedWire: 'max', prompt: '[[detach:300]] [[write:src/a.txt=x]]', policy: { workdir: wt, owned: ['*'], mode: 'write', allowedTools: ['editor', 'run_commands', 'read_files', 'search_codebase'] }, timeoutSeconds: 30, clineRetries: 1, hide: [], clineBin: FAKE, clineDataDir: clineData(), budgetUsd: 1, budgetTokens: 1e7, pricing: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, allowUnmetered: false })
    assert.equal(out.census.state, 'gone', out.census.detail)
    assert.ok(Number(readFileSync(join(run, 'rw', 'detached-pid'), 'utf8')) > 0, 'the descendant was started')
    const ps = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
    assert.ok(!ps.split('\n').some(l => l.trim() === 'sleep 300'), 'the detached sleep survived')
  })
})

describe('isolation (review 10): the broker as a hard bound', () => {
  const slowUp = async (o: { delayMs?: number; usage?: Record<string, number> | null } = {}): Promise<{ url: string; seen: Seen[] }> => {
    const seen: Seen[] = []
    const server = createServer((req, res) => { let body = ''; req.on('data', c => { body += c }); req.on('end', () => { seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }); setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...(o.usage === null ? {} : { usage: o.usage ?? { prompt_tokens: 1, completion_tokens: 1, cost: 0.004 } }) })) }, o.delayMs ?? 0) }) })
    servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen }
  }
  const call = (b: Broker, body: Record<string, unknown> = { model: 'deepseek/deepseek-v4.1-flash-1017', reasoning_effort: 'max' }, path = '/api/v1/chat/completions', method = 'POST'): Promise<number> => new Promise(res => { const r = request({ socketPath: b.socketPath, path, method, headers: { authorization: `Bearer workos:${b.fakeToken}`, 'content-type': 'application/json' } }, s => { s.resume(); s.on('end', () => res(s.statusCode ?? 0)) }); r.on('error', () => res(-1)); r.end(method === 'POST' ? JSON.stringify(body) : undefined) })
  const broker = (up: string, o: Partial<Parameters<typeof startBroker>[0]> = {}): Promise<Broker> => startBroker({ dataDir: clineData(), provider: 'cline', upstream: up, model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: { effort: 'max' }, ...o })
  test('many concurrent model turns cannot all pass the same budget check: at most maxInflight reach the API', T, async () => {
    const up = await slowUp({ delayMs: 300 })
    const b = await broker(up.url, { budgetUsd: 0.001, maxInflight: 4 })
    const codes = await Promise.all(Array.from({ length: 24 }, () => call(b)))
    await b.close()
    assert.ok(up.seen.length <= 4, `${up.seen.length} turns reached the API`)
    assert.equal(codes.filter(c => c === 200).length, up.seen.length); assert.ok(codes.every(c => c === 200 || c === 429 || c === 402), codes.join(','))
    assert.equal(b.spent.carried, up.seen.length)
  })
  test('the API is always asked for usage; a carried turn with no usage leaves the spend unmeasured and stops further turns', T, async () => {
    const up = await slowUp({ usage: null })
    const b = await broker(up.url)
    assert.equal(await call(b, { model: 'deepseek/deepseek-v4.1-flash-1017', reasoning_effort: 'max', stream: true, stream_options: { include_usage: false } }), 200)
    assert.deepEqual(JSON.parse(up.seen[0].body).stream_options, { include_usage: true }, 'include_usage is forced on')
    assert.equal(b.spent.unmeasured, 1); assert.equal(b.spent.usdKnown, false)
    assert.equal(await call(b), 402, 'no further turn once spend is unmeasured')
    await b.close()
    const allowed = await broker(up.url, { allowUnmetered: true }); assert.equal(await call(allowed), 200); assert.equal(await call(allowed), 200); await allowed.close()
  })
  test('a flood of refused requests cannot push a real model turn out of the record or the carried count', T, async () => {
    const up = await slowUp()
    const b = await broker(up.url)
    for (let i = 0; i < 1500; i++) await call(b, {}, '/api/v1/users/me', 'GET')
    assert.equal(await call(b), 200)
    await b.close()
    assert.equal(b.spent.carried, 1)
    assert.equal(b.records.filter(r => !r.refused && r.path === '/api/v1/chat/completions').length, 1)
    assert.equal(attestWire({ state: 'unconfirmed', requests: 0, effective: null, models: [], detail: '' }, b.records, 'deepseek/deepseek-v4.1-flash-1017', 'max').state, 'confirmed')
  })
  test('toggle and no-reasoning routes are enforced too: a worker cannot raise or switch the reasoning it was routed', T, async () => {
    const up = await slowUp()
    const toggle = await broker(up.url, { model: 'xiaomi/mimo-v2.6-pro', reasoning: { toggle: 'on', effort: 'high' } })
    assert.deepEqual([await call(toggle, { model: 'xiaomi/mimo-v2.6-pro', reasoning_effort: 'high' }), await call(toggle, { model: 'xiaomi/mimo-v2.6-pro', reasoning_effort: 'max' }), await call(toggle, { model: 'xiaomi/mimo-v2.6-pro', reasoning_effort: 'high', reasoning: { enabled: false } }), await call(toggle, { model: 'xiaomi/mimo-v2.6-pro', reasoning_effort: { x: 1 } })], [200, 403, 403, 403])
    await toggle.close()
    const none = await broker(up.url, { model: 'zai/glm-5.3-flash', reasoning: { none: true } })
    assert.deepEqual([await call(none, { model: 'zai/glm-5.3-flash' }), await call(none, { model: 'zai/glm-5.3-flash', reasoning_effort: 'max' }), await call(none, { model: 'zai/glm-5.3-flash', reasoning: { enabled: true } })], [200, 403, 403])
    await none.close()
    const effort = await broker(up.url)
    assert.equal(await call(effort, { model: 'deepseek/deepseek-v4.1-flash-1017', reasoning_effort: 'max', reasoning: { enabled: false } }), 403, 'max with thinking switched off is not the routed max')
    await effort.close()
    const rec = (o: Record<string, unknown>) => ({ at: '', method: 'POST', path: '/api/v1/chat/completions', status: 200, model: 'm', effort: 'high', bytesIn: 1, reasoningEnabled: null, ...o }) as never
    const w = { state: 'unconfirmed' as const, requests: 0, effective: null, models: [], detail: '' }
    assert.equal(attestWire(w, [rec({})], 'm', 'on').state, 'confirmed', 'toggle on is confirmed from the broker, not the captures')
    assert.equal(attestWire(w, [rec({ effort: null })], 'm', 'on').state, 'mismatch')
    assert.equal(attestWire(w, [rec({ reasoningEnabled: false })], 'm', 'on').state, 'mismatch')
    assert.equal(attestWire(w, [rec({ effort: null })], 'm', 'none').state, 'unconfirmed', 'leaving the field out does not prove reasoning is off')
    assert.equal(attestWire(w, [rec({ effort: 'none' })], 'm', 'none').state, 'confirmed')
    assert.equal(attestWire(w, [rec({ effort: null, reasoningEnabled: false })], 'm', 'off').state, 'confirmed')
    assert.equal(attestWire(w, [rec({ effort: 'max' })], 'm', 'none').state, 'mismatch')
  })
  test('a failed save latches: the old (possibly spent) refresh token is never tried again, and the kept answer is applied next time', T, async () => {
    const data = clineData(); const f = join(data, 'settings', 'providers.json'); const d = JSON.parse(readFileSync(f, 'utf8')); d.providers.cline.settings.auth.expiresAt = Date.now() - 60_000; writeFileSync(f, JSON.stringify(d))
    const block = `${f}.cockpit-${process.pid}.tmp`; mkdirSync(block)
    let refreshes = 0
    const up = await upstream({ refresh: () => { refreshes++; return { success: true, data: { accessToken: 'A5', refreshToken: 'R5', expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { clineUserId: 'acct-test' } } } } })
    await assert.rejects(realToken(data, 'cline', up.url), /cockpit-refresh/)
    await assert.rejects(realToken(data, 'cline', up.url), /cockpit-refresh/)
    assert.equal(refreshes, 1, 'no second refresh with the same token')
    rmSync(block, { recursive: true })
    // a later supervisor (a new process: simulated by another data-dir key would not share the latch, so apply directly)
    const fresh = await import(`../src/broker.ts?fresh=${Date.now()}`) as typeof import('../src/broker.ts')
    assert.equal(await fresh.realToken(data, 'cline', up.url), 'A5')
    assert.equal(refreshes, 1, 'the kept answer was applied, not a new refresh')
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).providers.cline.settings.auth.refreshToken, 'R5'); assert.ok(!existsSync(`${f}.cockpit-refresh`))
  })
  test('if the person signs in again during a refresh, their sign-in wins and is not overwritten', T, async () => {
    const data = clineData(); const f = join(data, 'settings', 'providers.json'); const d = JSON.parse(readFileSync(f, 'utf8')); d.providers.cline.settings.auth.expiresAt = Date.now() - 60_000; writeFileSync(f, JSON.stringify(d))
    const up = await upstream({ refresh: () => { const x = JSON.parse(readFileSync(f, 'utf8')); x.providers.cline.settings.auth = { accessToken: 'OWNER-NEW', refreshToken: 'OWNER-R', expiresAt: Date.now() + 3600_000 }; writeFileSync(f, JSON.stringify(x)); return { success: true, data: { accessToken: 'BROKER-A', refreshToken: 'BROKER-R', expiresAt: new Date(Date.now() + 3600_000).toISOString() } } } })
    assert.equal(await realToken(data, 'cline', up.url), 'OWNER-NEW')
    const a = JSON.parse(readFileSync(f, 'utf8')).providers.cline.settings.auth
    assert.equal(a.accessToken, 'OWNER-NEW'); assert.equal(a.refreshToken, 'OWNER-R')
  })
  test('a worker that replaces its hook log (to hide refusals) is itself refused', T, async () => {
    const e = env()
    const m = await mission(e, { tasks: [task('a', { owned: ['*'], prompt: '[[cmd:ln -sf /dev/null "$COCKPIT_HOOK_LOG"]] [[write:src/a/x=1]]' })] })
    const v = await m.run()
    assert.notEqual(v.state, 'DONE')
    const a = allTasks(m)[0].attempts[0]
    assert.equal(a.failure, 'policy_abort', JSON.stringify(a.failureDetail)); assert.match(a.failureDetail ?? '', /hook log was replaced/)
  })
})

describe('isolation (review 10): git internals, /etc and what may be mounted', () => {
  test('submodule configs and a linked worktree\'s fsmonitor socket are covered; /etc/gitconfig is not shown', T, async () => {
    const repo = join(CANARY, 'subrepo'); mkdirSync(repo); execFileSync('git', ['init', '-q', '-b', 'main', repo]); writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a')
    plant('subrepo/.git/modules/lib/config', `[remote "origin"]\n\turl = https://u:${SECRET}@example.invalid/lib.git\n`)
    const wt = join(CANARY, 'subrepo-wt'); git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
    const admin = join(repo, '.git', 'worktrees', 'subrepo-wt'); assert.ok(existsSync(admin))
    const ipc = join(admin, 'fsmonitor--daemon.ipc'); const fsm = netServer(s => { s.on('error', () => {}); s.end('FSMON') }); await new Promise<void>(r => fsm.listen(ipc, () => r()))
    const r = await attack([allow('git_status', 'git -C . status --porcelain'), deny('submodule_config', `grep -q ${SECRET} ${repo}/.git/modules/lib/config`), deny('worktree_fsmonitor', conn(`{path:'${ipc}'}`)), deny('etc_gitconfig', 'test -s /etc/gitconfig')].join('\n'), { workdir: wt, gitCommonDir: join(repo, '.git') })
    fsm.close()
    ok(r.out, ['git_status', 'submodule_config', 'worktree_fsmonitor', 'etc_gitconfig']); assert.ok(!r.out.includes(SECRET))
  })
  test('system trees, $HOME and the account home, shell histories and dotfiles are never mountable; --share refuses .git, .env and files', () => {
    for (const p of ['/proc', '/proc/1', '/sys', '/dev', '/run', '/run/user/1000', '/var/run', '/boot', '~/.bash_history', '~/.gitconfig', '~/.cargo/credentials.toml', '~/.npm', `${userInfo().homedir}/.ssh`]) assert.ok(mountProblem(p), `${p} must be refused`)
    const repo = tmp('share-repo2'); mkdirSync(join(repo, '.git')); writeFileSync(join(repo, '.env'), 'X'); writeFileSync(join(repo, 'file.txt'), 'x'); mkdirSync(join(repo, '.env.d'))
    for (const s of ['.git', '.env', '.env.d', 'file.txt']) assert.throws(() => shareDir(repo, s), UsageError, s)
  })
})

describe('isolation (review 11): the owner\'s sign-in, error answers and the log', () => {
  const expire = (data: string): string => { const f = join(data, 'settings', 'providers.json'); const d = JSON.parse(readFileSync(f, 'utf8')); d.providers.cline.settings.auth.expiresAt = Date.now() - 60_000; writeFileSync(f, JSON.stringify(d)); return f }
  const answer = (a: string, r: string) => ({ success: true, data: { accessToken: a, refreshToken: r, expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { clineUserId: 'acct-test' } } })
  test('a kept answer from an older sign-in is never applied over a newer one; it is discarded and the current token is refreshed', T, async () => {
    const data = clineData(); const f = expire(data)
    // left by a failed save of an OLD sign-in (refresh token "old-r"), then the person signed in again ("test-refresh")
    writeFileSync(`${f}.cockpit-refresh`, JSON.stringify({ v: 1, usedSha256: createHash('sha256').update('old-r').digest('hex'), at: Date.now(), answer: JSON.stringify(answer('STALE-A', 'STALE-R')) }), { mode: 0o600 })
    const up = await upstream({ refresh: s2 => { assert.equal(JSON.parse(s2.body).refreshToken, 'test-refresh'); return answer('FRESH-A', 'FRESH-R') } })
    assert.equal(await realToken(data, 'cline', up.url), 'FRESH-A')
    const a = JSON.parse(readFileSync(f, 'utf8')).providers.cline.settings.auth
    assert.equal(a.accessToken, 'FRESH-A'); assert.ok(!JSON.stringify(a).includes('STALE')); assert.ok(!existsSync(`${f}.cockpit-refresh`))
  })
  test('an unusable kept answer (no access token, unreadable, too old) is deleted, never applied, and does not wedge later refreshes', T, async () => {
    for (const content of ['not json', JSON.stringify({ v: 1, usedSha256: createHash('sha256').update('test-refresh').digest('hex'), at: Date.now(), answer: '{"success":false}' }), JSON.stringify({ v: 1, usedSha256: createHash('sha256').update('test-refresh').digest('hex'), at: Date.now() - 48 * 3600_000, answer: JSON.stringify(answer('OLD-A', 'OLD-R')) })]) {
      const data = clineData(); const f = expire(data); writeFileSync(`${f}.cockpit-refresh`, content, { mode: 0o600 })
      const up = await upstream({ refresh: () => answer('NEW-A', 'NEW-R') })
      assert.equal(await realToken(data, 'cline', up.url), 'NEW-A'); assert.ok(!existsSync(`${f}.cockpit-refresh`))
    }
  })
  test('a latch is for one refresh token: after the person signs in again, refreshes work again in the same process', T, async () => {
    const data = clineData(); const f = expire(data)
    const block = `${f}.cockpit-${process.pid}.tmp`; mkdirSync(block)
    const up = await upstream({ refresh: () => answer('L-A', 'L-R') })
    await assert.rejects(realToken(data, 'cline', up.url))
    rmSync(block, { recursive: true }); rmSync(`${f}.cockpit-refresh`, { force: true })
    // the person runs `cline auth`: a new sign-in (new refresh token), expired again later
    const d = JSON.parse(readFileSync(f, 'utf8')); d.providers.cline.settings.auth = { ...d.providers.cline.settings.auth, refreshToken: 'after-login', expiresAt: Date.now() - 1 }; writeFileSync(f, JSON.stringify(d))
    assert.equal(await realToken(data, 'cline', up.url), 'L-A')
  })
  test('an error answer from the API (429, 5xx) is not spend: the attempt stays measured and the next turn is carried', T, async () => {
    let n = 0
    const server = createServer((req, res) => { req.resume(); req.on('end', () => { n++; if (n === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"overloaded"}') } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.001}}') } }) })
    servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const b = await startBroker({ dataDir: clineData(), provider: 'cline', upstream: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: { effort: 'max' } })
    const call = (): Promise<number> => new Promise(res => { const r = request({ socketPath: b.socketPath, path: '/api/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer workos:${b.fakeToken}`, 'content-type': 'application/json' } }, s2 => { s2.resume(); s2.on('end', () => res(s2.statusCode ?? 0)) }); r.end(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', reasoning_effort: 'max' })) })
    assert.deepEqual([await call(), await call()], [503, 200])
    await b.close()
    assert.equal(b.spent.unmeasured, 0); assert.equal(b.spent.billed, 1); assert.equal(b.spent.carried, 2); assert.equal(b.spent.stop, null)
  })
  test('a sign-in that cannot be used reaches the worker as an authentication failure (401, classified auth_error), without host paths', T, async () => {
    const data = clineData(); expire(data)
    const up = await upstream({ refresh: () => ({ success: false }) })
    const server = createServer((req, res) => { res.writeHead(500); res.end() }); servers.push(server)
    const b = await startBroker({ dataDir: data, provider: 'cline', upstream: up.url, model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: { effort: 'max' } })
    const out = await new Promise<{ status: number; body: string }>(res => { const r = request({ socketPath: b.socketPath, path: '/api/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer workos:${b.fakeToken}`, 'content-type': 'application/json' } }, s2 => { let t = ''; s2.on('data', c => { t += c }); s2.on('end', () => res({ status: s2.statusCode ?? 0, body: t })) }); r.end(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', reasoning_effort: 'max' })) })
    await b.close()
    assert.equal(out.status, 401); assert.ok(!out.body.includes(data) && !out.body.includes('/home/'), out.body)
    assert.equal(classifyFailureText(`Provider error: 401 ${out.body}`), 'auth_error')
  })
  test('refusals cannot fill the host disk through the broker log, and a model-turn refusal is kept whatever came before', T, async () => {
    const lines: string[] = []
    const up = await upstream()
    const b = await startBroker({ dataDir: clineData(), provider: 'cline', upstream: up.url, model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: { effort: 'max' }, maxLogBytes: 100_000, log: r => { lines.push(JSON.stringify(r)) } })
    const call = (path: string, body?: unknown): Promise<number> => new Promise(res => { const r = request({ socketPath: b.socketPath, path, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer workos:${b.fakeToken}`, 'content-type': 'application/json' } }, s2 => { s2.resume(); s2.on('end', () => res(s2.statusCode ?? 0)) }); r.end(body ? JSON.stringify(body) : undefined) })
    const long = `/api/v1/${'x'.repeat(8000)}`
    for (let i = 0; i < 1500; i++) await call(long)
    assert.equal(await call('/api/v1/chat/completions', { model: 'moonshotai/kimi-k3.1-pro', reasoning_effort: 'max' }), 403)
    await b.close()
    const bytes = lines.reduce((x, l) => x + l.length, 0)
    assert.ok(bytes < 101_000, `${bytes} bytes logged`); assert.ok(lines.some(l => /further refusals are not logged/.test(l)))
    assert.ok(b.records.some(r => r.path === '/api/v1/chat/completions' && /routed/.test(r.refused ?? '')), 'the model-turn refusal is kept after the flood')
  })
})
