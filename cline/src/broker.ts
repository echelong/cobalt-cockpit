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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  /** Usage the API reported in this response (filled in when the response ends). */ tokens?: number; usd?: number | null
  /** For a model turn: the reasoning.enabled it sent, or null when it sent none. */ reasoningEnabled?: boolean | null }
export type Broker = { socketPath: string; socketDir: string; fakeToken: string; records: BrokerRecord[]
  /** What this attempt used, as the API reported it to the broker: tokens, cost (usdKnown false when a response carried no cost), requests. */
  spent: BrokerSpent
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

type RefreshAnswer = { success?: boolean; data?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; expiresIn?: unknown; tokenType?: unknown; userInfo?: Record<string, unknown> } }
/** Refreshes that failed after the server had answered: no further refresh is tried with that (possibly spent) token. */
const LATCHED = new Map<string, string>()
const readJsonRetry = (f: string): ProvidersDoc => {
  // Cline may be writing the file: a torn read is retried briefly, never written over
  let last: unknown
  for (let i = 0; i < 5; i++) { try { return JSON.parse(readFileSync(f, 'utf8')) as ProvidersDoc } catch (e) { last = e; const until = Date.now() + 50; while (Date.now() < until) { /* brief wait */ } } }
  throw new Error(`providers.json unreadable: ${(last as Error).message}`)
}

/**
 * The real access token, refreshed on the host when it is within 5 minutes of expiry, the way Cline does it
 * (POST /api/v1/auth/refresh under Cline's own lock). The owner's sign-in must never be lost:
 *  - a recovery file left by an earlier failed save (`providers.json.cockpit-refresh`) is applied first;
 *  - the server's answer is saved to that recovery file (0600) before anything that can fail;
 *  - providers.json is read again immediately before the write: if the sign-in changed meanwhile (the person
 *    signed in again), the person's sign-in wins and nothing is written; otherwise only this provider's
 *    `auth` is replaced, keeping every other change;
 *  - the previous file is kept as `providers.json.cockpit-backup`; the write is atomic (temporary file, rename);
 *  - after a failure past the server's answer, this broker process never retries a refresh (a refresh token
 *    may be single-use); the error names what the person should do.
 */
export const realToken = async (dataDir: string, provider: string, upstream: string, now: () => number = Date.now): Promise<string> => {
  const key = `${dataDir}\0${provider}`
  const first = readAuth(dataDir, provider)
  if (live(first.auth.expiresAt, now())) return first.auth.accessToken as string
  const latched = LATCHED.get(key); if (latched) throw new Error(latched)
  return withClineLock(dataDir, provider, async () => {
    const file = providersFile(dataDir); const recovery = `${file}.cockpit-refresh`
    // another process (Cline itself, another broker) may have refreshed while we waited for the lock
    const { auth } = readAuth(dataDir, provider)
    if (live(auth.expiresAt, now())) return auth.accessToken as string
    if (typeof auth.refreshToken !== 'string' || !auth.refreshToken) throw new Error(`the Cline sign-in for "${provider}" has expired and has no refresh token: run \`cline auth\``)
    const used = auth.refreshToken
    let text: string | null = null
    // an answer kept from an earlier failed save is newer than what providers.json holds: use it, do not refresh again
    if (existsSync(recovery)) text = readFileSync(recovery, 'utf8')
    else {
      const r = await fetch(`${upstream}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: used, grantType: 'refresh_token' }), signal: AbortSignal.timeout(30_000), redirect: 'error' })
      const t = await r.text().catch(() => '')
      if (!r.ok) throw new Error(`Cline token refresh failed (${r.status}): run \`cline auth\` on the host`)
      writeFileSync(recovery, t, { mode: 0o600 }); text = t
    }
    const fail = (why: string): never => { const msg = `${why}; the server's answer is kept in ${recovery}: run \`cline auth\` on the host`; LATCHED.set(key, msg); throw new Error(msg) }
    let body: RefreshAnswer | null = null
    try { body = JSON.parse(text) as RefreshAnswer } catch { /* not JSON */ }
    const d = body?.data
    if (!body?.success || !d || typeof d.accessToken !== 'string' || !d.accessToken) fail('Cline token refresh returned no access token')
    const data = d as NonNullable<RefreshAnswer['data']> & { accessToken: string }
    let expiresAt = expiry(data.expiresAt)
    if (!Number.isFinite(expiresAt) && typeof data.expiresIn === 'number') expiresAt = now() + data.expiresIn * 1000
    if (!Number.isFinite(expiresAt)) expiresAt = now() + 15 * 60_000
    // read again right before writing; the auth that is replaced is the one read now, not the one read earlier
    let current: ProvidersDoc
    try { current = readJsonRetry(file) } catch (e) { return fail(`could not re-read providers.json (${(e as Error).message})`) }
    const entry = current.providers?.[provider]
    const cur = entry?.settings?.auth
    if (!entry?.settings || !cur) return fail(`the "${provider}" entry vanished from providers.json during the refresh`)
    if (cur.refreshToken !== used) {
      // the person (or Cline) signed in again meanwhile: their sign-in wins; ours is discarded, never written over it
      rmSync(recovery, { force: true })
      if (live(cur.expiresAt, now()) && typeof cur.accessToken === 'string') return cur.accessToken
      return fail('the sign-in changed during the refresh and is not current')
    }
    const userInfo = data.userInfo && typeof data.userInfo === 'object' ? data.userInfo : (cur.metadata?.userInfo as Record<string, unknown> | undefined)
    entry.settings.auth = { ...cur, accessToken: data.accessToken, refreshToken: typeof data.refreshToken === 'string' && data.refreshToken ? data.refreshToken : used, expiresAt, ...(typeof userInfo?.clineUserId === 'string' ? { accountId: userInfo.clineUserId } : {}), metadata: { ...(cur.metadata ?? {}), ...(typeof data.tokenType === 'string' ? { tokenType: data.tokenType } : {}), ...(userInfo ? { userInfo } : {}) } }
    entry.updatedAt = new Date().toISOString()
    const tmp = `${file}.cockpit-${process.pid}.tmp`
    try {
      writeFileSync(`${file}.cockpit-backup`, readFileSync(file, 'utf8'), { mode: 0o600 })
      writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 }); renameSync(tmp, file)
    } catch (e) { try { rmSync(tmp, { force: true }) } catch { /* none */ } return fail(`could not save the refreshed Cline sign-in (${(e as Error).message})`) }
    rmSync(recovery, { force: true })
    return data.accessToken
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

export type BrokerLimits = { budgetUsd?: number | null; budgetTokens?: number | null; maxRequests?: number; maxInflight?: number; allowUnmetered?: boolean }
/**
 * What a route may send as reasoning, enforced on every model turn:
 *  - { effort: 'max' }  an effort-level route: exactly this reasoning_effort, and thinking not switched off;
 *  - { effort: 'high', toggle: 'on' }  a toggle model asked to think: Cline sends this effort; thinking not off;
 *  - { none: true }  no reasoning: no reasoning_effort, and thinking not switched on.
 */
export type ReasoningRule = { effort?: string; toggle?: 'on'; none?: true }
/** Usage the Cline API reported in a response (OpenAI-compatible `usage`, with `cost` when the API includes it). */
const usageOf = (o: unknown): { tokens: number; usd: number | null } | null => {
  const u = (o as { usage?: Record<string, unknown> } | null)?.usage
  if (!u || typeof u !== 'object') return null
  const n = (k: string): number => typeof u[k] === 'number' && Number.isFinite(u[k] as number) ? u[k] as number : 0
  return { tokens: n('prompt_tokens') + n('completion_tokens'), usd: typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null }
}
export type BrokerSpent = {
  usd: number; tokens: number; requests: number; inflight: number
  /** Model turns passed on to the API (counted when sent, whatever happened after). */ carried: number
  /** Carried turns whose usage (or cost) the API did not report: the attempt's spend is then not measured. */ unmeasured: number
  usdKnown: boolean
}

/** Starts a broker for one worker. `upstream` is fixed by the host (tests point it at a local stand-in on loopback). */
export const startBroker = async (o: { dataDir: string; provider: string; upstream?: string; log?: (r: BrokerRecord) => void
  /** The routed model: a model turn for any other model is refused (a worker cannot spend on a model it was not given). */ model?: string
  /** What the route may send as reasoning (see ReasoningRule); absent: not checked. A string is shorthand for { effort }. */ effort?: string | null
  reasoning?: ReasoningRule
} & BrokerLimits): Promise<Broker> => {
  if (!BROKERED_PROVIDERS.includes(o.provider)) throw new Error(`provider "${o.provider}" cannot be brokered: only ${BROKERED_PROVIDERS.join(', ')} are supported, and workers have no other network`)
  readAuth(o.dataDir, o.provider) // fail before launch when there is no sign-in at all
  const upstream = o.upstream ?? process.env.COCKPIT_BROKER_UPSTREAM ?? CLINE_API_ORIGIN
  const bad = upstreamProblem(upstream); if (bad) throw new Error(`broker upstream ${upstream}: ${bad}`)
  const maxRequests = o.maxRequests ?? 600, maxInflight = o.maxInflight ?? 4
  const rule: ReasoningRule | null = o.reasoning ?? (o.effort ? { effort: o.effort } : null)
  const fakeToken = fakeJwt()
  // carried requests are always kept (bounded by maxRequests); refusals only up to a cap, so a flood of refused
  // requests can never push the record of a real model turn out
  const records: BrokerRecord[] = []; let refusedKept = 0
  const spent: BrokerSpent = { usd: 0, tokens: 0, requests: 0, inflight: 0, carried: 0, unmeasured: 0, usdKnown: true }
  const socketDir = mkdtempSync(join(tmpdir(), 'ccl-b-'))
  const socketPath = join(socketDir, 's')
  const log = (r: BrokerRecord): void => { try { o.log?.(r) } catch { /* the log is evidence, not control */ } }
  const refuse = (res: ServerResponse, req: IncomingMessage, status: number, why: string, model: string | null = null, effort: string | null = null, detail?: string): void => {
    const r: BrokerRecord = { at: new Date().toISOString(), method: req.method ?? '?', path: (req.url ?? '').slice(0, 200), status, model, effort, bytesIn: 0, refused: detail ? `${why}: ${detail}` : why }
    if (refusedKept < 1000) { records.push(r); refusedKept++ }
    log(r)
    // the worker is told why in general terms; host paths and details stay in the host-side record
    if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Cockpit broker: ${why}` } })) } else res.destroy()
  }
  const server = createServer({ maxHeaderSize: 32 << 10 }, (req, res) => { void handle(req, res).catch(e => refuse(res, req, 502, 'the broker could not complete the request', null, null, (e as Error).message)) })
  server.maxConnections = 32
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? ''
    if (req.method !== 'GET' && req.method !== 'POST') return refuse(res, req, 405, `method ${req.method} not allowed`)
    // origin form only: an absolute URL or authority form could name another host
    if (!url.startsWith('/') || url.startsWith('//')) return refuse(res, req, 400, 'only origin-form request targets are accepted')
    const q = url.indexOf('?'); const path = q < 0 ? url : url.slice(0, q); const query = q < 0 ? '' : url.slice(q + 1)
    if (!PATH_OK.test(path) || path.split('/').some(s => s === '..' || s === '.') || path.includes('//') || !QUERY_OK.test(query)) return refuse(res, req, 403, `path ${path.slice(0, 120)} is not a provider API path`)
    if (path.startsWith('/api/v1/auth/')) return refuse(res, req, 403, 'authentication endpoints are the host\'s')
    if (!ALLOWED.some(a => a.method === req.method && a.path === path)) return refuse(res, req, 403, `${req.method} ${path.slice(0, 120)} is not a request Cline needs`)
    // the attempt's spend, measured here from the API's own answers (not from what the worker prints); the
    // counters move before the first await, so concurrent requests cannot all pass the same check
    if (spent.requests >= maxRequests) return refuse(res, req, 429, `request limit ${maxRequests} for this attempt reached`)
    if (o.budgetTokens != null && spent.tokens >= o.budgetTokens) return refuse(res, req, 402, `token budget ${o.budgetTokens} for this attempt reached (${spent.tokens} used, measured by the broker)`)
    if (o.budgetUsd != null && spent.usd >= o.budgetUsd) return refuse(res, req, 402, `cost budget $${o.budgetUsd} for this attempt reached ($${spent.usd.toFixed(5)} reported by the API)`)
    if (spent.unmeasured > 0 && !o.allowUnmetered && path === '/api/v1/chat/completions') return refuse(res, req, 402, 'an earlier model turn reported no usage: the budget cannot be enforced')
    if (spent.inflight >= maxInflight) return refuse(res, req, 429, `${maxInflight} requests already in flight`)
    spent.requests++; spent.inflight++
    const ac = new AbortController()
    // a client that goes away cancels the upstream request (the response's close fires on disconnect or when done)
    res.on('close', () => { if (!res.writableFinished) ac.abort() })
    try {
      const chunks: Uint8Array[] = []; let size = 0
      for await (const c of req) { size += (c as Uint8Array).length; if (size > MAX_BODY) return refuse(res, req, 413, 'request body too large'); chunks.push(c as Uint8Array) }
      let body: Uint8Array | undefined = req.method === 'POST' ? new Uint8Array(Buffer.concat(chunks)) : undefined
      let model: string | null = null, effort: string | null = null, enabled: boolean | null = null
      const turn = path === '/api/v1/chat/completions'
      if (turn) {
        // the body that was checked is the body that is sent: parsed, validated, serialised again
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return refuse(res, req, 415, 'a model turn must be JSON')
        let j: Record<string, unknown>
        try { const v = JSON.parse(Buffer.from(body as Uint8Array).toString('utf8')) as unknown; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); j = v as Record<string, unknown> } catch (e) { return refuse(res, req, 400, `model turn body: ${(e as Error).message}`) }
        model = typeof j.model === 'string' ? j.model : null
        if (j.reasoning_effort !== undefined && typeof j.reasoning_effort !== 'string') return refuse(res, req, 403, 'reasoning_effort must be a string', model)
        effort = (j.reasoning_effort as string | undefined) ?? null
        const extra = Object.keys(j).find(k => !TURN_FIELDS.has(k))
        if (extra !== undefined) return refuse(res, req, 403, `field "${extra.slice(0, 40)}" is not part of a Cline model turn`, model, effort)
        const r = j.reasoning as Record<string, unknown> | undefined
        if (r !== undefined && (typeof r !== 'object' || r === null || Object.keys(r).some(k => k !== 'enabled') || typeof r.enabled !== 'boolean')) return refuse(res, req, 403, 'only reasoning.enabled may be set', model, effort)
        enabled = r ? r.enabled as boolean : null
        if (o.model !== undefined && model !== o.model) return refuse(res, req, 403, `model ${String(model).slice(0, 80)} is not the routed model ${o.model}`, model, effort)
        if (rule?.none) { if ((effort !== null && effort !== 'none') || enabled === true) return refuse(res, req, 403, `reasoning ${effort ?? 'on'} is not the routed none`, model, effort) }
        else if (rule) {
          if (rule.effort !== undefined && effort !== rule.effort) return refuse(res, req, 403, `reasoning effort ${effort ?? 'none'} is not the routed ${rule.effort}`, model, effort)
          if (enabled === false) return refuse(res, req, 403, 'thinking switched off is not the routed reasoning', model, effort)
        }
        if (j.stream_options !== undefined && (typeof j.stream_options !== 'object' || j.stream_options === null || Array.isArray(j.stream_options))) return refuse(res, req, 403, 'stream_options must be an object', model, effort)
        // the API must report usage for every streamed turn: the broker asks for it whatever the worker sent
        if (j.stream === true) j.stream_options = { ...(j.stream_options as Record<string, unknown> | undefined ?? {}), include_usage: true }
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
      // recorded and counted as carried BEFORE it is sent: whatever happens next, the provider may have billed it
      const rec: BrokerRecord = { at: new Date().toISOString(), method: req.method, path, status: 0, model, effort, bytesIn: body?.length ?? 0, ...(turn ? { reasoningEnabled: enabled } : {}) }
      records.push(rec)
      if (turn) spent.carried++
      let gotUsage = false
      const count = (o2: unknown): void => { const u = usageOf(o2); if (!u) return; gotUsage = true; spent.tokens += u.tokens; rec.tokens = (rec.tokens ?? 0) + u.tokens; if (u.usd === null) { spent.usdKnown = false; rec.usd = null } else { spent.usd += u.usd; rec.usd = (rec.usd ?? 0) + u.usd } }
      const finish = (): void => { if (turn && !gotUsage) { spent.unmeasured++; spent.usdKnown = false; rec.usd = null } log(rec) }
      let up: Response
      try { up = await fetch(`${upstream}${path}${query ? `?${query}` : ''}`, { method: req.method, headers, body, redirect: 'manual', signal: ac.signal }) } catch (e) { rec.status = 0; finish(); throw e }
      rec.status = up.status
      const out: Record<string, string> = {}
      up.headers.forEach((v, k) => { if (!HOP_OUT.has(k)) out[k] = v })
      res.writeHead(up.status, out)
      if (!up.body) { res.end(); finish(); return }
      // pass every byte through, and read the usage the API reports (SSE `data:` lines, or one JSON body)
      const dec = new TextDecoder(); let tail = ''; let whole = ''; let wholeOk = true
      const sse = (l: string): void => { if (l.startsWith('data:') && l.includes('"usage"')) { try { count(JSON.parse(l.slice(5).trim())) } catch { /* not JSON */ } } }
      await new Promise<void>((resolve) => {
        const s = Readable.fromWeb(up.body as never)
        s.on('data', (c: Uint8Array) => {
          res.write(c)
          const t = dec.decode(c, { stream: true })
          if (whole.length + t.length <= 4 << 20) whole += t; else wholeOk = false
          tail += t; const lines = tail.split('\n'); tail = lines.pop() ?? ''
          if (tail.length > 4 << 20) tail = ''
          for (const l of lines) sse(l)
        })
        s.on('end', () => { tail += dec.decode(); sse(tail); if (wholeOk && !/^\s*data:/m.test(whole)) { try { count(JSON.parse(whole)) } catch { /* not JSON */ } } res.end(); finish(); resolve() })
        s.on('error', () => { res.destroy(); finish(); resolve() })
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
