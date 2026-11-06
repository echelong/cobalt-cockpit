// The provider broker: the only way a worker reaches the network. It runs in the supervisor (host
// side, trusted) and serves HTTP on a unix socket that is mounted read-only into one worker's
// sandbox; inside, forward.mjs maps 127.0.0.1:8899 to it. The worker's Cline is given a fake,
// far-future token; the broker
//   - accepts only GET/POST requests for paths under /api/v1/ (never /api/v1/auth/*), in origin form;
//   - sends them to one fixed origin (the Cline API), never to a host the request names;
//   - replaces the fake token with the real one, read from the person's Cline settings on the host;
//   - refreshes an expiring token itself, under the same SQLite lock Cline uses, and writes it back
//     the way Cline does (a backup first), so the real credentials never enter a sandbox;
//   - records every request (path, status, model, reasoning effort) as host-side evidence.
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'

export const BROKER_PORT = 8899
export const CLINE_API_ORIGIN = 'https://api.cline.bot'
/** Providers whose requests the broker can carry: both are served by the Cline API with a Cline sign-in. */
export const BROKERED_PROVIDERS: readonly string[] = ['cline', 'cline-pass']
const MAX_BODY = 32 << 20
const REFRESH_BUFFER_MS = 5 * 60_000
/**
 * The only requests a worker's Cline may make, as observed from Cline 3.0.74 itself (a model turn, the
 * recommended-model list, the remote config it reads at start, the model list). Everything else, including
 * account management and the authentication endpoints, is refused.
 */
export const ALLOWED: readonly { method: 'GET' | 'POST'; path: string }[] = [
  { method: 'POST', path: '/api/v1/chat/completions' },
  { method: 'GET', path: '/api/v1/ai/cline/recommended-models' },
  { method: 'GET', path: '/api/v1/users/me/remote-config' },
  { method: 'GET', path: '/api/v1/models' },
]
const PATH_OK = /^\/api\/v1\/[A-Za-z0-9._~\-/]*$/
const QUERY_OK = /^[A-Za-z0-9._~\-=&%+,:]*$/
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'cookie', 'authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'])
const HOP_OUT = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'set-cookie', 'trailer', 'upgrade'])

export type BrokerRecord = { at: string; method: string; path: string; status: number; model: string | null; effort: string | null; bytesIn: number; refused?: string
  /** Usage the API reported in this response (filled in when the response ends). */ tokens?: number; usd?: number | null }
export type Broker = { socketPath: string; socketDir: string; fakeToken: string; records: BrokerRecord[]
  /** What this attempt used, as the API reported it to the broker: tokens, cost (usdKnown false when a response carried no cost), requests. */
  spent: { usd: number; tokens: number; requests: number; inflight: number; usdKnown: boolean }
  close: () => Promise<void> }

type ProvidersDoc = { providers?: Record<string, { settings?: { auth?: Record<string, unknown> & { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; metadata?: Record<string, unknown> } }; updatedAt?: string; tokenSource?: string }> }
const providersFile = (dataDir: string): string => join(dataDir, 'settings', 'providers.json')

/** A fake JWT-shaped token: unguessable, far-future expiry, so the sandboxed Cline never tries to refresh. */
const fakeJwt = (): string => {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'cockpit-broker', exp, jti: randomBytes(16).toString('hex') })}.${randomBytes(24).toString('base64url')}`
}

/** Runs fn holding Cline's own refresh lock for this provider (an SQLite file, BEGIN EXCLUSIVE), as Cline does. */
const withClineLock = async <T>(dataDir: string, provider: string, fn: () => Promise<T>): Promise<T> => {
  const lock = `${providersFile(dataDir)}.oauth-${createHash('sha256').update(provider).digest('hex')}.lock`
  const db = new DatabaseSync(lock)
  try {
    db.exec('PRAGMA busy_timeout = 0;')
    const until = Date.now() + 60_000
    for (;;) {
      try { db.exec('BEGIN EXCLUSIVE;'); break } catch (e) {
        if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked/.test((e as Error).message) || Date.now() > until) throw new Error(`Cline credential lock: ${(e as Error).message}`)
        await new Promise(r => setTimeout(r, 100))
      }
    }
    try { return await fn() } finally { try { db.exec('COMMIT;') } catch { /* nothing held */ } }
  } finally { db.close() }
}

const readAuth = (dataDir: string, provider: string): { doc: ProvidersDoc; auth: NonNullable<NonNullable<NonNullable<ProvidersDoc['providers']>[string]['settings']>['auth']> } => {
  const doc = JSON.parse(readFileSync(providersFile(dataDir), 'utf8')) as ProvidersDoc
  const auth = doc.providers?.[provider]?.settings?.auth
  if (!auth || typeof auth.accessToken !== 'string' || !auth.accessToken) throw new Error(`no Cline sign-in for provider "${provider}": run \`cline auth\` on the host`)
  return { doc, auth }
}
/** An expiry as Cline stores or returns it: epoch ms, epoch seconds or an ISO date; NaN when it is none of these. */
export const expiry = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? (v > 1e11 ? v : v * 1000) : typeof v === 'string' ? (/^\d+(?:\.\d+)?$/.test(v.trim()) ? expiry(Number(v)) : Date.parse(v)) : NaN
const live = (v: unknown, now: number): boolean => { const e = expiry(v); return Number.isFinite(e) && e - now > REFRESH_BUFFER_MS }

/**
 * The real access token, refreshed on the host when it is within 5 minutes of expiry, the way Cline does it
 * (POST /api/v1/auth/refresh under Cline's own lock). The owner's sign-in must never be lost:
 *  - the response is saved first (`providers.json.cockpit-refresh`, 0600), before anything that can fail;
 *  - providers.json is read again immediately before the write and only this provider's `auth` is replaced,
 *    so a change made meanwhile by Cline or `cline auth` elsewhere in the file is kept;
 *  - the previous file is kept as `providers.json.cockpit-backup`; the write is atomic (temporary file, rename);
 *  - an expiry in an unexpected form never discards the new tokens (they are stored with a conservative expiry).
 */
export const realToken = async (dataDir: string, provider: string, upstream: string, now: () => number = Date.now): Promise<string> => {
  const first = readAuth(dataDir, provider)
  if (live(first.auth.expiresAt, now())) return first.auth.accessToken as string
  return withClineLock(dataDir, provider, async () => {
    // another process (Cline itself, another broker) may have refreshed while we waited for the lock
    const { auth } = readAuth(dataDir, provider)
    if (live(auth.expiresAt, now())) return auth.accessToken as string
    if (typeof auth.refreshToken !== 'string' || !auth.refreshToken) throw new Error(`the Cline sign-in for "${provider}" has expired and has no refresh token: run \`cline auth\``)
    const file = providersFile(dataDir)
    const r = await fetch(`${upstream}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: auth.refreshToken, grantType: 'refresh_token' }), signal: AbortSignal.timeout(30_000), redirect: 'error' })
    const text = await r.text().catch(() => '')
    const recovery = `${file}.cockpit-refresh`
    // whatever the server answered is kept before it is interpreted: a rotated refresh token is never lost
    if (r.ok) writeFileSync(recovery, text, { mode: 0o600 })
    let body: { success?: boolean; data?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; expiresIn?: unknown; tokenType?: unknown; userInfo?: Record<string, unknown> } } | null = null
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    const d = body?.data
    if (!r.ok || !body?.success || !d || typeof d.accessToken !== 'string' || !d.accessToken) throw new Error(`Cline token refresh failed (${r.status}): run \`cline auth\` on the host${r.ok ? ` (the server's answer is kept in ${recovery})` : ''}`)
    let expiresAt = expiry(d.expiresAt)
    if (!Number.isFinite(expiresAt) && typeof d.expiresIn === 'number') expiresAt = now() + d.expiresIn * 1000
    if (!Number.isFinite(expiresAt)) expiresAt = now() + 15 * 60_000
    const userInfo = d.userInfo && typeof d.userInfo === 'object' ? d.userInfo : (auth.metadata?.userInfo as Record<string, unknown> | undefined)
    const next = { ...auth, accessToken: d.accessToken, refreshToken: typeof d.refreshToken === 'string' && d.refreshToken ? d.refreshToken : auth.refreshToken, expiresAt, ...(typeof userInfo?.clineUserId === 'string' ? { accountId: userInfo.clineUserId } : {}), metadata: { ...(auth.metadata ?? {}), ...(typeof d.tokenType === 'string' ? { tokenType: d.tokenType } : {}), ...(userInfo ? { userInfo } : {}) } }
    // read again right before writing: only this provider's auth changes, nothing else in the file
    const current = JSON.parse(readFileSync(file, 'utf8')) as ProvidersDoc
    const entry = current.providers?.[provider]
    if (!entry?.settings) throw new Error(`the "${provider}" entry vanished from ${file} during the refresh; the new sign-in is kept in ${recovery}`)
    entry.settings.auth = next; entry.updatedAt = new Date().toISOString()
    copyFileSync(file, `${file}.cockpit-backup`); chmodSync(`${file}.cockpit-backup`, 0o600)
    const tmp = `${file}.cockpit-${process.pid}.tmp`
    try { writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 }); renameSync(tmp, file) } catch (e) { try { rmSync(tmp, { force: true }) } catch { /* none */ } throw new Error(`could not save the refreshed Cline sign-in (${(e as Error).message}); it is kept in ${recovery}`) }
    rmSync(recovery, { force: true })
    return d.accessToken
  })
}

/** Top-level fields of a model turn, as Cline 3.0.74 sends them; any other field (fallback models, routing, plugins) is refused. */
export const TURN_FIELDS: ReadonlySet<string> = new Set(['model', 'messages', 'tools', 'tool_choice', 'max_tokens', 'reasoning_effort', 'reasoning', 'stream', 'stream_options', 'cache_control', 'temperature', 'top_p', 'stop', 'parallel_tool_calls'])
/** Where the broker may send the real token: the Cline API, or (tests) a stand-in on this machine's loopback. */
export const upstreamProblem = (u: string): string | null => {
  let url: URL; try { url = new URL(u) } catch { return 'not a URL' }
  if (url.pathname !== '/' || url.search || url.username || url.password) return 'an origin only (no path, query or credentials)'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null
  return 'https, or http on loopback for tests'
}

export type BrokerLimits = { budgetUsd?: number | null; budgetTokens?: number | null; maxRequests?: number; maxInflight?: number }
/** Usage the Cline API reported in a response (OpenAI-compatible `usage`, with `cost` when the API includes it). */
const usageOf = (o: unknown): { tokens: number; usd: number | null } | null => {
  const u = (o as { usage?: Record<string, unknown> } | null)?.usage
  if (!u || typeof u !== 'object') return null
  const n = (k: string): number => typeof u[k] === 'number' && Number.isFinite(u[k] as number) ? u[k] as number : 0
  return { tokens: n('prompt_tokens') + n('completion_tokens'), usd: typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null }
}

/** Starts a broker for one worker. `upstream` is fixed by the host (tests point it at a local stand-in on loopback). */
export const startBroker = async (o: { dataDir: string; provider: string; upstream?: string; log?: (r: BrokerRecord) => void
  /** The routed model: a model turn for any other model is refused (a worker cannot spend on a model it was not given). */ model?: string
  /** The reasoning effort the route sends on the wire; a model turn with another (or none) is refused. Null: not checked (toggle models). */ effort?: string | null
} & BrokerLimits): Promise<Broker> => {
  if (!BROKERED_PROVIDERS.includes(o.provider)) throw new Error(`provider "${o.provider}" cannot be brokered: only ${BROKERED_PROVIDERS.join(', ')} are supported, and workers have no other network`)
  readAuth(o.dataDir, o.provider) // fail before launch when there is no sign-in at all
  const upstream = o.upstream ?? process.env.COCKPIT_BROKER_UPSTREAM ?? CLINE_API_ORIGIN
  const bad = upstreamProblem(upstream); if (bad) throw new Error(`broker upstream ${upstream}: ${bad}`)
  const maxRequests = o.maxRequests ?? 600, maxInflight = o.maxInflight ?? 4
  const fakeToken = fakeJwt()
  const records: BrokerRecord[] = []
  const spent = { usd: 0, tokens: 0, requests: 0, inflight: 0, usdKnown: true }
  const socketDir = mkdtempSync(join(tmpdir(), 'ccl-b-'))
  const socketPath = join(socketDir, 's')
  const note = (r: BrokerRecord): void => { if (records.length < 10_000) records.push(r); try { o.log?.(r) } catch { /* the log is evidence, not control */ } }
  const refuse = (res: ServerResponse, req: IncomingMessage, status: number, why: string, model: string | null = null, effort: string | null = null): void => {
    note({ at: new Date().toISOString(), method: req.method ?? '?', path: (req.url ?? '').slice(0, 200), status, model, effort, bytesIn: 0, refused: why })
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Cockpit broker: ${why}` } }))
  }
  const server = createServer({ maxHeaderSize: 32 << 10 }, (req, res) => { void handle(req, res).catch(e => { if (!res.headersSent) refuse(res, req, 502, `upstream error: ${(e as Error).message}`); else res.destroy() }) })
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? ''
    if (req.method !== 'GET' && req.method !== 'POST') return refuse(res, req, 405, `method ${req.method} not allowed`)
    // origin form only: an absolute URL or authority form could name another host
    if (!url.startsWith('/') || url.startsWith('//')) return refuse(res, req, 400, 'only origin-form request targets are accepted')
    const q = url.indexOf('?'); const path = q < 0 ? url : url.slice(0, q); const query = q < 0 ? '' : url.slice(q + 1)
    if (!PATH_OK.test(path) || path.split('/').some(s => s === '..' || s === '.') || path.includes('//') || !QUERY_OK.test(query)) return refuse(res, req, 403, `path ${path.slice(0, 120)} is not a provider API path`)
    if (path.startsWith('/api/v1/auth/')) return refuse(res, req, 403, 'authentication endpoints are the host\'s')
    if (!ALLOWED.some(a => a.method === req.method && a.path === path)) return refuse(res, req, 403, `${req.method} ${path.slice(0, 120)} is not a request Cline needs`)
    // the attempt's spend, measured here from the API's own answers (not from what the worker prints)
    if (spent.requests >= maxRequests) return refuse(res, req, 429, `request limit ${maxRequests} for this attempt reached`)
    if (o.budgetTokens != null && spent.tokens >= o.budgetTokens) return refuse(res, req, 402, `token budget ${o.budgetTokens} for this attempt reached (${spent.tokens} used, measured by the broker)`)
    if (o.budgetUsd != null && spent.usd >= o.budgetUsd) return refuse(res, req, 402, `cost budget $${o.budgetUsd} for this attempt reached ($${spent.usd.toFixed(5)} reported by the API)`)
    if (spent.inflight >= maxInflight) return refuse(res, req, 429, `${maxInflight} requests already in flight`)
    const chunks: Uint8Array[] = []; let size = 0
    for await (const c of req) { size += (c as Uint8Array).length; if (size > MAX_BODY) return refuse(res, req, 413, 'request body too large'); chunks.push(c as Uint8Array) }
    let body: Uint8Array | undefined = req.method === 'POST' ? new Uint8Array(Buffer.concat(chunks)) : undefined
    let model: string | null = null, effort: string | null = null
    if (path === '/api/v1/chat/completions') {
      // the body that was checked is the body that is sent: parsed, validated, serialised again
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return refuse(res, req, 415, 'a model turn must be JSON')
      let j: Record<string, unknown>
      try { const v = JSON.parse(Buffer.from(body as Uint8Array).toString('utf8')) as unknown; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); j = v as Record<string, unknown> } catch (e) { return refuse(res, req, 400, `model turn body: ${(e as Error).message}`) }
      model = typeof j.model === 'string' ? j.model : null
      effort = typeof j.reasoning_effort === 'string' ? j.reasoning_effort : null
      const extra = Object.keys(j).find(k => !TURN_FIELDS.has(k))
      if (extra !== undefined) return refuse(res, req, 403, `field "${extra.slice(0, 40)}" is not part of a Cline model turn`, model, effort)
      const r = j.reasoning as Record<string, unknown> | undefined
      if (r !== undefined && (typeof r !== 'object' || r === null || Object.keys(r).some(k => k !== 'enabled') || typeof r.enabled !== 'boolean')) return refuse(res, req, 403, 'only reasoning.enabled may be set', model, effort)
      if (o.model !== undefined && model !== o.model) return refuse(res, req, 403, `model ${String(model).slice(0, 80)} is not the routed model ${o.model}`, model, effort)
      if (o.effort != null && effort !== o.effort) return refuse(res, req, 403, `reasoning effort ${effort ?? 'none'} is not the routed ${o.effort}`, model, effort)
      body = new Uint8Array(Buffer.from(JSON.stringify(j)))
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === 'string') headers[k] = v
    // the fake token is replaced in the same form Cline sent it ("Bearer <t>" or "Bearer workos:<t>");
    // any other credential a worker supplies is dropped
    const auth = req.headers.authorization
    if (typeof auth === 'string') {
      const m = /^Bearer (workos:)?(.+)$/.exec(auth)
      if (m && m[2] === fakeToken) headers.authorization = `Bearer ${m[1] ?? ''}${await realToken(o.dataDir, o.provider, upstream)}`
    }
    spent.requests++; spent.inflight++
    try {
      const ac = new AbortController(); req.on('close', () => { if (!res.writableEnded) ac.abort() })
      const up = await fetch(`${upstream}${path}${query ? `?${query}` : ''}`, { method: req.method, headers, body, redirect: 'manual', signal: ac.signal })
      const rec: BrokerRecord = { at: new Date().toISOString(), method: req.method, path, status: up.status, model, effort, bytesIn: body?.length ?? 0 }
      note(rec)
      const out: Record<string, string> = {}
      up.headers.forEach((v, k) => { if (!HOP_OUT.has(k)) out[k] = v })
      res.writeHead(up.status, out)
      if (!up.body) { res.end(); return }
      // pass every byte through, and read the usage the API reports (SSE `data:` lines, or one JSON body)
      const dec = new TextDecoder(); let tail = ''; let whole = ''
      const count = (o2: unknown): void => { const u = usageOf(o2); if (!u) return; spent.tokens += u.tokens; rec.tokens = (rec.tokens ?? 0) + u.tokens; if (u.usd === null) { spent.usdKnown = false; rec.usd ??= null } else { spent.usd += u.usd; rec.usd = (rec.usd ?? 0) + u.usd } }
      await new Promise<void>((resolve) => {
        const s = Readable.fromWeb(up.body as never)
        s.on('data', (c: Uint8Array) => {
          res.write(c)
          const t = dec.decode(c, { stream: true })
          if (whole.length < 1 << 20) whole += t
          tail += t; const lines = tail.split('\n'); tail = lines.pop() ?? ''
          for (const l of lines) if (l.startsWith('data:') && l.includes('"usage"')) { try { count(JSON.parse(l.slice(5).trim())) } catch { /* not JSON */ } }
        })
        s.on('end', () => { if (!/^\s*data:/m.test(whole)) { try { count(JSON.parse(whole)) } catch { /* not JSON */ } } res.end(); resolve() })
        s.on('error', () => { res.destroy(); resolve() })
      })
    } finally { spent.inflight-- }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()) })
  chmodSync(socketPath, 0o600)
  return {
    socketPath, socketDir, fakeToken, records, spent,
    close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => { try { rmSync(socketDir, { recursive: true, force: true }) } catch { /* gone */ } r() }) }),
  }
}

/**
 * The Cline data directory a worker gets: disposable, inside its own writable run directory, holding
 * only the routed provider with the broker's fake token and the broker's address. No real credential,
 * no other provider's key and none of the person's settings, sessions or plugins enter the sandbox.
 */
export const prepareClineData = (dir: string, provider: string, model: string, fakeToken: string): void => {
  const settings = join(dir, 'settings')
  mkdirSync(settings, { recursive: true, mode: 0o700 })
  const exp = Date.now() + 30 * 86400_000
  const doc = { version: 1, lastUsedProvider: provider, modes: {}, providers: { [provider]: { settings: { provider, auth: { accessToken: fakeToken, refreshToken: 'cockpit-broker', expiresAt: exp, accountId: 'cockpit-broker', metadata: { provider: 'cline', tokenType: 'Bearer' } }, model, baseUrl: `http://127.0.0.1:${BROKER_PORT}/api/v1` }, updatedAt: new Date().toISOString(), tokenSource: 'oauth' } } }
  writeFileSync(join(settings, 'providers.json'), JSON.stringify(doc, null, 2), { mode: 0o600 })
  writeFileSync(join(settings, 'global-settings.json'), JSON.stringify({ autoUpdateEnabled: false, telemetryOptOut: true }, null, 2), { mode: 0o600 })
}
