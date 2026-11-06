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

export type BrokerRecord = { at: string; method: string; path: string; status: number; model: string | null; effort: string | null; bytesIn: number; refused?: string }
export type Broker = { socketPath: string; socketDir: string; fakeToken: string; records: BrokerRecord[]; close: () => Promise<void> }

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
const expiry = (v: unknown): number => typeof v === 'number' ? (v > 1e11 ? v : v * 1000) : typeof v === 'string' ? Date.parse(v) : 0

/**
 * The real access token, refreshed on the host when it is within 5 minutes of expiry. A refresh
 * writes the provider's auth back exactly where Cline keeps it (other entries untouched, a backup
 * of the previous file beside it, atomic rename, mode 0600).
 */
export const realToken = async (dataDir: string, provider: string, upstream: string, now: () => number = Date.now): Promise<string> => {
  const first = readAuth(dataDir, provider)
  if (expiry(first.auth.expiresAt) - now() > REFRESH_BUFFER_MS) return first.auth.accessToken as string
  return withClineLock(dataDir, provider, async () => {
    // another process (Cline itself, another broker) may have refreshed while we waited for the lock
    const { doc, auth } = readAuth(dataDir, provider)
    if (expiry(auth.expiresAt) - now() > REFRESH_BUFFER_MS) return auth.accessToken as string
    if (typeof auth.refreshToken !== 'string' || !auth.refreshToken) throw new Error(`the Cline sign-in for "${provider}" has expired and has no refresh token: run \`cline auth\``)
    const r = await fetch(`${upstream}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: auth.refreshToken, grantType: 'refresh_token' }), signal: AbortSignal.timeout(30_000), redirect: 'error' })
    const body = await r.json().catch(() => null) as { success?: boolean; data?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; tokenType?: unknown; userInfo?: Record<string, unknown> } } | null
    const d = body?.data
    if (!r.ok || !body?.success || !d || typeof d.accessToken !== 'string' || !d.accessToken) throw new Error(`Cline token refresh failed (${r.status}): run \`cline auth\` on the host`)
    const expiresAt = Date.parse(String(d.expiresAt))
    if (!Number.isFinite(expiresAt)) throw new Error('Cline token refresh returned no valid expiry')
    const file = providersFile(dataDir)
    copyFileSync(file, `${file}.cockpit-backup`); chmodSync(`${file}.cockpit-backup`, 0o600)
    const entry = doc.providers![provider]
    const userInfo = d.userInfo && typeof d.userInfo === 'object' ? d.userInfo : (auth.metadata?.userInfo as Record<string, unknown> | undefined)
    entry.settings!.auth = { ...auth, accessToken: d.accessToken, refreshToken: typeof d.refreshToken === 'string' && d.refreshToken ? d.refreshToken : auth.refreshToken, expiresAt, ...(typeof userInfo?.clineUserId === 'string' ? { accountId: userInfo.clineUserId } : {}), metadata: { ...(auth.metadata ?? {}), ...(typeof d.tokenType === 'string' ? { tokenType: d.tokenType } : {}), ...(userInfo ? { userInfo } : {}) } }
    entry.updatedAt = new Date().toISOString()
    const tmp = `${file}.cockpit-${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 }); renameSync(tmp, file)
    return d.accessToken
  })
}

/** Starts a broker for one worker. `upstream` is fixed by the host (tests point it at a local stand-in). */
export const startBroker = async (o: { dataDir: string; provider: string; upstream?: string; log?: (r: BrokerRecord) => void
  /** The routed model: a model turn for any other model is refused (a worker cannot spend on a model it was not given). */ model?: string }): Promise<Broker> => {
  if (!BROKERED_PROVIDERS.includes(o.provider)) throw new Error(`provider "${o.provider}" cannot be brokered: only ${BROKERED_PROVIDERS.join(', ')} are supported, and workers have no other network`)
  readAuth(o.dataDir, o.provider) // fail before launch when there is no sign-in at all
  const upstream = o.upstream ?? process.env.COCKPIT_BROKER_UPSTREAM ?? CLINE_API_ORIGIN
  const fakeToken = fakeJwt()
  const records: BrokerRecord[] = []
  const socketDir = mkdtempSync(join(tmpdir(), 'ccl-b-'))
  const socketPath = join(socketDir, 's')
  const note = (r: BrokerRecord): void => { records.push(r); try { o.log?.(r) } catch { /* the log is evidence, not control */ } }
  const refuse = (res: ServerResponse, req: IncomingMessage, status: number, why: string): void => {
    note({ at: new Date().toISOString(), method: req.method ?? '?', path: (req.url ?? '').slice(0, 200), status, model: null, effort: null, bytesIn: 0, refused: why })
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Cockpit broker: ${why}` } }))
  }
  const server = createServer((req, res) => { void handle(req, res).catch(e => { if (!res.headersSent) refuse(res, req, 502, `upstream error: ${(e as Error).message}`); else res.destroy() }) })
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? ''
    if (req.method !== 'GET' && req.method !== 'POST') return refuse(res, req, 405, `method ${req.method} not allowed`)
    // origin form only: an absolute URL or authority form could name another host
    if (!url.startsWith('/') || url.startsWith('//')) return refuse(res, req, 400, 'only origin-form request targets are accepted')
    const q = url.indexOf('?'); const path = q < 0 ? url : url.slice(0, q); const query = q < 0 ? '' : url.slice(q + 1)
    if (!PATH_OK.test(path) || path.split('/').some(s => s === '..' || s === '.') || path.includes('//') || !QUERY_OK.test(query)) return refuse(res, req, 403, `path ${path.slice(0, 120)} is not a provider API path`)
    if (path.startsWith('/api/v1/auth/')) return refuse(res, req, 403, 'authentication endpoints are the host\'s')
    if (!ALLOWED.some(a => a.method === req.method && a.path === path)) return refuse(res, req, 403, `${req.method} ${path.slice(0, 120)} is not a request Cline needs`)
    const chunks: Uint8Array[] = []; let size = 0
    for await (const c of req) { size += (c as Uint8Array).length; if (size > MAX_BODY) return refuse(res, req, 413, 'request body too large'); chunks.push(c as Uint8Array) }
    const body = Buffer.concat(chunks)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === 'string') headers[k] = v
    // the fake token is replaced in the same form Cline sent it ("Bearer <t>" or "Bearer workos:<t>");
    // any other credential a worker supplies is dropped
    const auth = req.headers.authorization
    if (typeof auth === 'string') {
      const m = /^Bearer (workos:)?(.+)$/.exec(auth)
      if (m && m[2] === fakeToken) headers.authorization = `Bearer ${m[1] ?? ''}${await realToken(o.dataDir, o.provider, upstream)}`
    }
    let model: string | null = null, effort: string | null = null
    if (req.method === 'POST' && /json/.test(req.headers['content-type'] ?? '')) {
      try { const j = JSON.parse(body.toString('utf8')) as { model?: unknown; reasoning_effort?: unknown; reasoning?: { effort?: unknown } }; model = typeof j.model === 'string' ? j.model : null; effort = typeof j.reasoning_effort === 'string' ? j.reasoning_effort : typeof j.reasoning?.effort === 'string' ? j.reasoning.effort : null } catch { /* not JSON */ }
    }
    if (path === '/api/v1/chat/completions' && o.model !== undefined && model !== o.model) return refuse(res, req, 403, `model ${String(model).slice(0, 80)} is not the routed model ${o.model}`)
    const ac = new AbortController(); req.on('close', () => { if (!res.writableEnded) ac.abort() })
    const up = await fetch(`${upstream}${path}${query ? `?${query}` : ''}`, { method: req.method, headers, body: req.method === 'POST' ? new Uint8Array(body) : undefined, redirect: 'manual', signal: ac.signal })
    note({ at: new Date().toISOString(), method: req.method, path, status: up.status, model, effort, bytesIn: body.length })
    const out: Record<string, string> = {}
    up.headers.forEach((v, k) => { if (!HOP_OUT.has(k)) out[k] = v })
    res.writeHead(up.status, out)
    if (up.body) Readable.fromWeb(up.body as never).on('error', () => res.destroy()).pipe(res)
    else res.end()
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()) })
  chmodSync(socketPath, 0o600)
  return {
    socketPath, socketDir, fakeToken, records,
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
