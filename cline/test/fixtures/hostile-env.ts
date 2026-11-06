// Production code paths, run in a child process started with a HOSTILE inherited environment (the removed override
// variables, an attacker-first PATH, Node TLS/proxy settings). It never imports test/helpers.ts, so no test seam is
// set: every choice below is the production default. argv[2]: JSON { mode, data?, canary?, workdir?, home? }.
// The only credential anywhere is a synthetic test token; `fetch` is replaced by a recorder in this process, so no
// request leaves the machine and the Cline API is never contacted.
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
import { startBroker } from '../../src/broker.ts'
import { bwrapAvailable, launch, trustedBwrap } from '../../src/sandbox.ts'
import { loadCatalog, trustedCline } from '../../src/catalog.ts'

const o = JSON.parse(process.argv[2]) as { mode: 'broker' | 'launch' | 'transport'; data?: string; canary?: string; workdir?: string; home?: string }
const print = (v: unknown): void => { process.stdout.write(`${JSON.stringify(v)}\n`) }

if (o.mode === 'broker') {
  // where would the real (synthetic) token go? Every outbound request is recorded instead of sent.
  const calls: { url: string; auth: string | null; body: string }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const h = new Headers(init?.headers)
    calls.push({ url, auth: h.get('authorization'), body: typeof init?.body === 'string' ? init.body : '' })
    const json = url.endsWith('/api/v1/auth/refresh')
      ? { success: true, data: { accessToken: 'SYNTHETIC-REFRESHED', refreshToken: 'SYNTHETIC-R2', expiresAt: Date.now() + 3600_000 } }
      : { id: 'recorded', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const b = await startBroker({ dataDir: o.data as string, provider: 'cline', model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: { effort: 'max' } })
  // a model turn as a worker sends it, naming another host every way it can
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ socketPath: b.socketPath, path: '/api/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${b.fakeToken}`, host: 'evil.example', 'x-forwarded-host': 'evil.example', forwarded: 'host=evil.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', reject)
    req.end(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', messages: [], reasoning_effort: 'max' }))
  })
  await b.close()
  const catalog = await loadCatalog()
  print({ upstream: b.upstream, status, calls, bwrap: trustedBwrap(), cline: trustedCline().bin, catalogSource: catalog.source, sandbox: await bwrapAvailable() })
} else if (o.mode === 'launch') {
  // a real sandbox started the production way: which bubblewrap runs, and does the boundary hold?
  const spec = { workdir: o.workdir as string, writable: true, gitCommonDir: null, gitAdminDir: null, home: o.home as string, readOnly: [], readWrite: [], allowRead: [], hide: [], network: 'none' as const, marker: `hostile-${Date.now()}`, env: {} }
  const { child } = launch(spec, ['bash', '-c', `echo INSIDE; if cat ${JSON.stringify(o.canary)} 2>/dev/null; then echo CANARY-READ; fi`])
  let out = ''; child.stdout?.on('data', d => { out += d }); child.stderr?.on('data', d => { out += d })
  const code = await new Promise<number | null>(r => child.on('exit', c => r(c)))
  print({ code, out, bwrap: trustedBwrap() })
} else {
  // the broker must refuse to carry the token at all when Node's TLS or proxy settings are weakened
  const r = await startBroker({ dataDir: o.data as string, provider: 'cline', model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: { effort: 'max' } }).then(async b => { await b.close(); return { started: true, error: null } }, (e: Error) => ({ started: false, error: e.message }))
  print({ ...r, tokenInError: r.error ? r.error.includes(JSON.parse(readFileSync(`${o.data}/settings/providers.json`, 'utf8')).providers.cline.settings.auth.accessToken) : false })
}
process.exit(0)
