// Adversarial isolation: each attack runs as a shell command INSIDE the real worker sandbox (the same spec
// runWorker builds, with the forwarder and a live broker) or inside a real gate, with no policy hook in the
// way, so only the operating system boundary can stop it. Every test asserts the attack was denied by the
// OS or the broker, never that a worker was told not to try.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { createServer as netServer } from 'node:net'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { launch } from '../src/sandbox.ts'
import { startBroker } from '../src/broker.ts'
import type { Broker } from '../src/broker.ts'
import { attestWire, runWorker, viaBroker, workerSandbox } from '../src/worker.ts'
import { runCommandGate } from '../src/gates.ts'
import { PACKAGE_DIR } from '../src/config.ts'
import { readWireCaptures } from '../src/reasoning.ts'
import { allTasks, clineData, env, FAKE, git, mission, task, TEST_REAL_TOKEN, tmp } from './helpers.ts'

const T = { timeout: 120_000 }
// outside /tmp on purpose: /tmp is private inside every sandbox, so a secret there would prove nothing
const VAR = mkdtempSync('/var/tmp/ccl-iso-')
const SECRET = `SECRET-${Math.random().toString(16).slice(2)}`

/** A stand-in for the Cline API, reached only by the host-side broker; records what arrives. */
type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string }
const upstream = async (): Promise<{ url: string; seen: Seen[]; server: Server }> => {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c }); req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      if (req.url === '/api/v1/auth/refresh') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data: { accessToken: 'REFRESHED-ACCESS', refreshToken: 'REFRESHED-REFRESH', expiresAt: new Date(Date.now() + 3600_000).toISOString(), tokenType: 'Bearer', userInfo: { clineUserId: 'acct-test', email: 'x@example.invalid' } } })); return }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: req.url }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address() as { port: number }
  return { url: `http://127.0.0.1:${a.port}`, seen, server }
}

/** Runs `script` with bash inside a worker sandbox exactly as runWorker builds it. */
const attack = async (script: string, o: { workdir?: string; gitCommonDir?: string | null; data?: string; up?: string } = {}): Promise<{ code: number | null; out: string; broker: Broker }> => {
  const run = tmp('iso-run'); const ro = join(run, 'ro'), rw = join(run, 'rw'), home = join(rw, 'home')
  for (const d of [ro, rw, home]) mkdirSync(d, { recursive: true })
  const workdir = o.workdir ?? tmp('iso-wd')
  const broker = await startBroker({ dataDir: o.data ?? clineData(), provider: 'cline', upstream: o.up ?? 'http://127.0.0.1:9' })
  const spec = workerSandbox({ workdir, writable: true, gitCommonDir: o.gitCommonDir ?? null, gitAdminDir: null, clineBin: FAKE, allowRead: [], hide: [], attemptId: `iso-${Date.now()}`, binds: [] }, { ro, rw, home }, broker.socketDir)
  const { child } = launch(spec, [...viaBroker(broker.socketPath), 'bash', '-c', script])
  let out = ''; child.stdout?.on('data', d => { out += d }); child.stderr?.on('data', d => { out += d })
  const code = await new Promise<number | null>(r => child.on('exit', c => r(c)))
  await broker.close()
  return { code, out, broker }
}
/** Each line "name=ok" or "name=FAIL…": an attack line is ok when it was denied. */
const verdicts = (out: string): Record<string, string> => Object.fromEntries(out.split('\n').filter(l => /^[a-z0-9_-]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const denied = (out: string, names: string[]): void => { const v = verdicts(out); for (const n of names) assert.equal(v[n], 'ok', `${n} was not denied\n${out}`) }
const deny = (name: string, cmd: string): string => `if ${cmd} >/dev/null 2>&1; then echo "${name}=FAIL"; else echo "${name}=ok"; fi`

const servers: Server[] = []
after(() => { for (const s of servers) s.close() })

describe('isolation: files outside the task are not there', () => {
  test('an unrelated repository and its secrets, outside /tmp, cannot be read or listed', T, async () => {
    const other = join(VAR, 'other-repo'); mkdirSync(join(other, '.git'), { recursive: true }); writeFileSync(join(other, 'secret.txt'), SECRET); writeFileSync(join(other, '.env'), `TOKEN=${SECRET}`)
    const r = await attack([deny('read_other', `cat ${other}/secret.txt`), deny('read_other_env', `cat ${other}/.env`), deny('list_var_tmp', `ls ${VAR}/other-repo`), deny('grep_var', `grep -r ${SECRET} /var /home /opt /srv /mnt`)].join('\n'))
    denied(r.out, ['read_other', 'read_other_env', 'list_var_tmp', 'grep_var']); assert.ok(!r.out.includes(SECRET))
  })
  test('the source checkout\'s untracked .env is absent from the worker\'s worktree and from its sandbox', T, async () => {
    const repo = join(VAR, 'proj'); mkdirSync(repo); execFileSync('git', ['init', '-q', '-b', 'main', repo]); writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a')
    writeFileSync(join(repo, '.env'), `API_KEY=${SECRET}`)
    const wt = join(VAR, 'proj-wt'); git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
    const r = await attack([deny('env_in_worktree', `cat ${wt}/.env`), deny('env_in_checkout', `cat ${repo}/.env`), deny('checkout_listing', `ls ${repo}/a.txt`), 'git -C . log --oneline -1 >/dev/null 2>&1 && echo git_works=ok || echo git_works=FAIL'].join('\n'), { workdir: wt, gitCommonDir: join(repo, '.git') })
    denied(r.out, ['env_in_worktree', 'env_in_checkout', 'checkout_listing']); assert.equal(verdicts(r.out).git_works, 'ok', r.out)
    assert.ok(!r.out.includes(SECRET))
  })
  test('the person\'s real home, keys and Cline settings are absent; HOME is a disposable directory', T, async () => {
    const h = homedir()
    // the Cockpit's own code is mounted read-only for the hook (its src, loader and engine): only those directories,
    // so bwrap's skeleton shows their parent names and nothing else; other projects, and the rest of this repository, are absent
    const others = (() => { try { return readdirSync(join(h, 'Projects')).filter(n => n !== 'cobalt-cockpit-cline').slice(0, 5) } catch { return [] } })()
    const repo = join(PACKAGE_DIR, '..')
    const r = await attack([deny('ssh', `ls ${h}/.ssh`), deny('real_cline', `cat ${h}/.cline/data/settings/providers.json`), deny('claude', `ls ${h}/.claude-main`),
      ...others.map((n, i) => deny(`other_project_${i}`, `ls ${join(h, 'Projects', n)}`)), deny('cockpit_repo_files', `cat ${repo}/README.md`), deny('cockpit_git_config', `cat ${repo}/.git/config`), deny('cockpit_tests', `ls ${repo}/tests`),
      deny('home_listing_has_files', `test -n "$(find ${h} -maxdepth 1 -type f)"`), `test "$HOME" != "${h}" && echo home_disposable=ok || echo home_disposable=FAIL`].join('\n'))
    denied(r.out, ['ssh', 'real_cline', 'claude', ...others.map((_, i) => `other_project_${i}`), 'cockpit_repo_files', 'cockpit_git_config', 'cockpit_tests', 'home_listing_has_files', 'home_disposable'])
  })
})

describe('isolation: Cline credentials and settings', () => {
  test('a real worker run never sees the real token or another provider\'s key, and cannot change the real Cline data', T, async () => {
    const e = env()
    const before = createHash('sha256').update(readFileSync(join(e.data, 'settings', 'providers.json'), 'utf8')).digest('hex')
    const probe = `printenv > env.txt; cat "$HOME"/../cline-data/settings/providers.json > seen.json 2>&1; ls ${e.data} > ls.txt 2>&1; true`
    const m = await mission(e, { tasks: [task('a', { owned: ['*'], prompt: `[[cmd:${probe}]] [[write:src/a/x=1]]` })] })
    await m.run()
    assert.equal(createHash('sha256').update(readFileSync(join(e.data, 'settings', 'providers.json'), 'utf8')).digest('hex'), before, 'the real Cline data is unchanged')
    // nothing the worker could read or write contains the real token or the other provider's key
    const runDir = join(m.dir, 'runs', 'a', '1')
    const files = execFileSync('find', [runDir, '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    for (const f of files) { const t = readFileSync(f, 'utf8'); assert.ok(!t.includes(TEST_REAL_TOKEN) && !t.includes('sk-ant-OTHER'), `${f} holds a real credential`) }
    const wtFiles = allTasks(m)[0].attempts[0].worktree as string
    for (const f of ['env.txt', 'seen.json', 'ls.txt'].map(n => join(wtFiles, n)).filter(existsSync)) { const t = readFileSync(f, 'utf8'); assert.ok(!t.includes(TEST_REAL_TOKEN) && !t.includes('sk-ant-OTHER'), `${f} leaked a credential`) }
    assert.match(readFileSync(join(wtFiles, 'ls.txt'), 'utf8'), /No such file/)
  })
})

describe('isolation: network', () => {
  test('host localhost services, abstract and filesystem unix sockets, and the internet are unreachable', T, async () => {
    const tcp = netServer(s => s.end('HOST-SERVICE')); await new Promise<void>(r => tcp.listen(0, '127.0.0.1', () => r()))
    const port = (tcp.address() as { port: number }).port
    const abstract = `ccl-iso-${process.pid}`; const abs = netServer(s => s.end('ABSTRACT')); await new Promise<void>(r => abs.listen(`\0${abstract}`, () => r()))
    const path = join(VAR, 'svc.sock'); const fsock = netServer(s => s.end('FSOCK')); await new Promise<void>(r => fsock.listen(path, () => r()))
    const node = (js: string): string => `node -e ${JSON.stringify(js)}`
    const conn = (target: string): string => node(`const s=require('net').connect(${target});s.on('data',d=>{process.stdout.write(String(d));process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000)`)
    const uid = userInfo().uid
    const r = await attack([
      deny('tcp_localhost', conn(`${port},'127.0.0.1'`)), deny('abstract_socket', conn(`{path:'\\0${abstract}'}`)), deny('fs_socket', conn(`{path:'${path}'}`)),
      deny('user_bus', `test -e /run/user/${uid}/bus`), deny('system_bus', 'test -e /run/dbus/system_bus_socket'),
      deny('internet_ip', conn("443,'1.1.1.1'")), deny('dns', 'getent hosts example.com'),
      `ip -o link 2>/dev/null | grep -v ' lo:' | grep -q . && echo only_loopback=FAIL || echo only_loopback=ok`,
    ].join('\n'))
    tcp.close(); abs.close(); fsock.close()
    denied(r.out, ['tcp_localhost', 'abstract_socket', 'fs_socket', 'user_bus', 'system_bus', 'internet_ip', 'dns', 'only_loopback'])
    assert.ok(!/HOST-SERVICE|ABSTRACT|FSOCK/.test(r.out), r.out)
  })
  test('through the broker only provider API paths reach the one fixed origin, with the real token; nothing else passes', T, async () => {
    const up = await upstream(); servers.push(up.server)
    const req = (method: string, path: string, auth = true): string => node(`const h=require('http');const r=h.request({host:'127.0.0.1',port:8899,method:'${method}',path:'${path}',headers:{'content-type':'application/json',${auth ? "authorization:'Bearer workos:'+process.env.FAKE" : ''}}},s=>{console.log('${method} ${path.replace(/'/g, '')} '+s.statusCode)});r.on('error',e=>console.log('ERR '+e.message));r.end('{\\"model\\":\\"deepseek/deepseek-v4.1-flash-1017\\",\\"reasoning_effort\\":\\"max\\"}')`)
    const node = (js: string): string => `node -e ${JSON.stringify(js)}`
    const data = clineData()
    const script = (tok: string): string => [`export FAKE='${tok}'`, req('POST', '/api/v1/chat/completions'), req('GET', '/api/v1/users/me'), req('POST', '/api/v1/users/me/api-keys'), req('GET', '/etc/passwd'), req('GET', '/api/v1/auth/refresh'), req('GET', '/api/v2/models'), req('GET', '/api/v1/../../admin'), req('DELETE', '/api/v1/x'), req('GET', 'http://evil.example/api/v1/x')].join('\n')
    // the script is handed the broker's fake token, as runWorker hands it to Cline through the worker's own Cline data
    const run = tmp('iso-run'); const ro = join(run, 'ro'), rw = join(run, 'rw'), home = join(rw, 'home'); for (const d of [ro, rw, home]) mkdirSync(d, { recursive: true })
    const broker = await startBroker({ dataDir: data, provider: 'cline', upstream: up.url, model: 'deepseek/deepseek-v4.1-flash-1017' })
    const spec = workerSandbox({ workdir: tmp('iso-wd'), writable: true, gitCommonDir: null, gitAdminDir: null, clineBin: FAKE, allowRead: [], hide: [], attemptId: 'iso-broker', binds: [] }, { ro, rw, home }, broker.socketDir)
    const { child } = launch(spec, [...viaBroker(broker.socketPath), 'bash', '-c', script(broker.fakeToken)])
    let out = ''; child.stdout?.on('data', d => { out += d }); child.stderr?.on('data', d => { out += d })
    await new Promise(r => child.on('exit', r)); await broker.close()
    assert.match(out, /POST \/api\/v1\/chat\/completions 200/, out)
    for (const bad of ['GET /api/v1/users/me', 'POST /api/v1/users/me/api-keys', 'GET /etc/passwd', 'GET /api/v1/auth/refresh', 'GET /api/v2/models', 'DELETE /api/v1/x']) assert.match(out, new RegExp(`${bad.replace(/[/.]/g, '\\$&')} 4\\d\\d`), `${bad} not refused\n${out}`)
    // the stand-in Cline API received exactly one request: the allowed one, carrying the REAL token and not the fake
    assert.deepEqual(up.seen.map(s => `${s.method} ${s.url}`), ['POST /api/v1/chat/completions'])
    assert.equal(up.seen[0].headers.authorization, `Bearer workos:${TEST_REAL_TOKEN}`)
    assert.ok(!JSON.stringify(up.seen).includes(broker.fakeToken))
    // and the broker recorded, host-side, the model and effort the request asked for
    assert.deepEqual(broker.records.filter(x => !x.refused).map(x => [x.path, x.model, x.effort]), [['/api/v1/chat/completions', 'deepseek/deepseek-v4.1-flash-1017', 'max']])
  })
  test('the broker refuses a model turn for any model other than the routed one', T, async () => {
    const up = await upstream(); servers.push(up.server)
    const broker = await startBroker({ dataDir: clineData(), provider: 'cline', upstream: up.url, model: 'deepseek/deepseek-v4.1-flash-1017' })
    const call = (model: string): Promise<number> => new Promise(res => { const r = request({ socketPath: broker.socketPath, path: '/api/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer workos:${broker.fakeToken}`, 'content-type': 'application/json' } }, s => { s.resume(); s.on('end', () => res(s.statusCode ?? 0)) }); r.end(JSON.stringify({ model })) })
    assert.deepEqual([await call('moonshotai/kimi-k3.1-pro'), await call('deepseek/deepseek-v4.1-flash-1017')], [403, 200])
    await broker.close()
    assert.deepEqual(up.seen.map(x => JSON.parse(x.body).model), ['deepseek/deepseek-v4.1-flash-1017'])
  })
  test('host-attested wire: another model or effort level is a mismatch; a toggle model is judged from captures', () => {
    const ok = { state: 'confirmed' as const, requests: 1, effective: 'max', models: ['m'], detail: 'captures' }
    const rec = (model: string, effort: string | null) => ({ at: '', method: 'POST', path: '/api/v1/chat/completions', status: 200, model, effort, bytesIn: 1 })
    assert.equal(attestWire(ok, [rec('m', 'max')], 'm', 'max').state, 'confirmed')
    assert.equal(attestWire(ok, [rec('other', 'max')], 'm', 'max').state, 'mismatch')
    assert.equal(attestWire(ok, [rec('m', 'high')], 'm', 'max').state, 'mismatch')
    assert.equal(attestWire(ok, [rec('m', 'high')], 'm', 'on').state, 'confirmed', 'MiMo: toggle on, effort high on the wire (seen live)')
    assert.equal(attestWire(ok, [{ ...rec('other', 'max'), refused: 'model' }], 'm', 'max').state, 'confirmed', 'a refused request never reached the provider')
  })
  test('the broker refreshes an expiring sign-in on the host under Cline\'s lock, once, keeping every other provider entry', T, async () => {
    const up = await upstream(); servers.push(up.server)
    const data = clineData()
    const f = join(data, 'settings', 'providers.json'); const doc = JSON.parse(readFileSync(f, 'utf8'))
    doc.providers.cline.settings.auth.expiresAt = Date.now() - 60_000; writeFileSync(f, JSON.stringify(doc))
    const broker = await startBroker({ dataDir: data, provider: 'cline', upstream: up.url })
    const call = (): Promise<number> => new Promise(res => { const r = request({ socketPath: broker.socketPath, path: '/api/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer workos:${broker.fakeToken}`, 'content-type': 'application/json' } }, s => { s.resume(); s.on('end', () => res(s.statusCode ?? 0)) }); r.end('{}') })
    const codes = await Promise.all([call(), call(), call()])
    await broker.close()
    assert.deepEqual(codes, [200, 200, 200])
    assert.equal(up.seen.filter(s => s.url === '/api/v1/auth/refresh').length, 1, 'one refresh for concurrent requests')
    assert.ok(up.seen.filter(s => s.url === '/api/v1/chat/completions').every(s => s.headers.authorization === 'Bearer workos:REFRESHED-ACCESS'))
    const now = JSON.parse(readFileSync(f, 'utf8'))
    assert.equal(now.providers.cline.settings.auth.accessToken, 'REFRESHED-ACCESS'); assert.equal(now.providers.cline.settings.auth.refreshToken, 'REFRESHED-REFRESH')
    assert.equal(now.providers.anthropic.settings.apiKey, 'sk-ant-OTHER-PROVIDER-KEY-must-never-enter', 'other providers untouched')
    assert.ok(existsSync(`${f}.cockpit-backup`)); assert.equal((execFileSync('stat', ['-c', '%a', f], { encoding: 'utf8' })).trim(), '600')
  })
})

describe('isolation: escapes', () => {
  test('symlinks, procfs, mounts and nested namespaces lead nowhere', T, async () => {
    const secret = join(VAR, 'link-target.txt'); writeFileSync(secret, SECRET)
    const wd = tmp('iso-wd'); symlinkSync(secret, join(wd, 'link')); symlinkSync('/', join(wd, 'root'))
    const r = await attack([
      deny('symlink_read', `cat ${wd}/link`), deny('symlink_root', `ls ${wd}/root${VAR}`),
      deny('traversal', `cat ../../../../../..${secret}`),
      deny('host_pids', `test "$(ls /proc | grep -c '^[0-9]')" -gt 20`), deny('host_proc', `test -e /proc/${process.pid}/environ`),
      deny('proc1_root', `ls /proc/1/root${VAR}`),
      deny('mount', 'mount -t tmpfs x /mnt'), deny('unshare_user', 'unshare -Ur true'), deny('unshare_mount', 'unshare -m true'),
      deny('nested_bwrap', 'bwrap --ro-bind / / true'), deny('block_devices', 'ls /dev/sda /dev/nvme0n1 /dev/mem'),
      deny('write_usr', 'touch /usr/ccl-escape'), deny('write_root', 'touch /ccl-escape'), deny('write_etc', 'touch /etc/ccl-escape'),
    ].join('\n'), { workdir: wd })
    denied(r.out, ['symlink_read', 'symlink_root', 'traversal', 'host_pids', 'host_proc', 'proc1_root', 'mount', 'unshare_user', 'unshare_mount', 'nested_bwrap', 'block_devices', 'write_usr', 'write_root', 'write_etc'])
    assert.ok(!r.out.includes(SECRET))
  })
  test('nothing persists outside the worktree and the attempt\'s own directory', T, async () => {
    const mark = `ccl-escape-${process.pid}-${Date.now()}`
    const r = await attack(`for p in /var/tmp /tmp "$HOME" ${homedir()} /run /dev/shm; do echo x > "$p/${mark}" 2>/dev/null; done; echo wrote=done`)
    assert.match(r.out, /wrote=done/)
    for (const p of ['/var/tmp', '/tmp', homedir(), '/run', '/dev/shm']) assert.ok(!existsSync(join(p, mark)), `${p}/${mark} persisted on the host`)
  })
  test('no privilege can be gained: no_new_privs, no capabilities, sudo and su refused', T, async () => {
    const r = await attack([
      "grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status && echo nnp=ok || echo nnp=FAIL",
      "grep -q '^CapEff:[[:space:]]*0000000000000000' /proc/self/status && echo no_caps=ok || echo no_caps=FAIL",
      deny('sudo', 'sudo -n true'), deny('su', 'su -c true root </dev/null'), deny('pkexec', 'pkexec true'),
    ].join('\n'))
    denied(r.out, ['nnp', 'no_caps', 'sudo', 'su', 'pkexec'])
  })
  test('the host never follows a link a worker planted where it reads worker output', () => {
    const cap = tmp('iso-cap'); writeFileSync(join(VAR, 'host-secret.json'), JSON.stringify({ timestamp: 'x', payload: { body: { model: SECRET } } }))
    symlinkSync(join(VAR, 'host-secret.json'), join(cap, 'cap_run_x.wire_request.1.provider-request.json'))
    // the planted link is never followed: the capture counts as unreadable (so the wire stays unconfirmed) and holds nothing of the target
    const caps = readWireCaptures(cap)
    assert.deepEqual(caps.map(c => [c.source, c.model]), [['unreadable', null]]); assert.ok(!JSON.stringify(caps).includes(SECRET))
    const dirLink = join(tmp('iso-cap2'), 'capture'); symlinkSync(VAR, dirLink)
    assert.deepEqual(readWireCaptures(dirLink), [])
  })
})

describe('isolation: gates run worker code under the same boundary, without any network', () => {
  test('a gate cannot read other repositories, the real home or Cline data, reach the network, or persist outside', T, async () => {
    const other = join(VAR, 'gate-other'); mkdirSync(other, { recursive: true }); writeFileSync(join(other, 'secret.txt'), SECRET)
    const mark = `ccl-gate-escape-${process.pid}`
    const cmd = [`! cat ${other}/secret.txt`, `! ls ${homedir()}/.ssh`, `! cat ${homedir()}/.cline/data/settings/providers.json`, `! getent hosts example.com`, "! node -e \"require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))\"", `test "$HOME" != "${homedir()}"`, `touch /var/tmp/${mark} 2>/dev/null; true`, "grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status", '! unshare -Ur true'].join(' && ')
    const g = await runCommandGate({ name: 'attack', command: cmd, required: true }, tmp('gate-wd'), tmp('gate-out'), { hide: [], shareDirs: [], timeoutSeconds: 60, gitCommonDir: null }, 'iso')
    assert.equal(g.state, 'pass', g.evidence)
    assert.ok(!existsSync(`/var/tmp/${mark}`))
  })
})

describe('isolation: a worker process cannot outlive its attempt', () => {
  test('a detached descendant started through the forwarder is gone when the attempt ends', T, async () => {
    const run = tmp('iso-live'); const wt = tmp('iso-live-wt'); mkdirSync(join(wt, 'src'), { recursive: true })
    const out = await runWorker({ attemptId: `iso-live-${Date.now()}`, runDir: run, workdir: wt, writable: true, gitCommonDir: null, gitAdminDir: null, provider: 'cline', model: 'deepseek/deepseek-v4.1-flash-1017', cliThinking: 'xhigh', expectedWire: 'max', prompt: '[[detach:300]] [[write:src/a.txt=x]]', policy: { workdir: wt, owned: ['*'], mode: 'write', allowedTools: ['editor', 'run_commands', 'read_files', 'search_codebase'] }, timeoutSeconds: 30, clineRetries: 1, hide: [], clineBin: FAKE, clineDataDir: clineData(), budgetUsd: 1, budgetTokens: 1e7, pricing: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, allowUnmetered: false })
    assert.equal(out.census.state, 'gone', out.census.detail)
    // no sleep of this attempt survives anywhere on the host
    const pid = Number(readFileSync(join(run, 'rw', 'detached-pid'), 'utf8'))
    assert.ok(pid > 0)
    // the pid the sandbox saw is in its own namespace: no 'sleep 300' of this attempt runs anywhere on the host
    const ps = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
    assert.ok(!ps.split('\n').some(l => l.trim() === 'sleep 300'), 'the detached sleep survived')
  })
})
