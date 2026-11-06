// The provider broker: the only way a worker reaches the network. It runs in the supervisor (host
// side, trusted) and serves HTTP on a unix socket that is mounted read-only into one worker's
// sandbox; inside, forward.mjs maps 127.0.0.1:8899 to it. The worker's Cline is given a fake,
// far-future token; the broker
//   - accepts only GET/POST requests for paths under /api/v1/ (never /api/v1/auth/*), in origin form;
//   - sends them to one fixed origin (the Cline API), never to a host the request names, and never follows or
//     relays a redirect; no environment variable, flag or configuration can change that origin (tests use the
//     loopback-only seam in seams.ts);
//   - refuses to run when Node is told to skip certificate checks, trust extra certificate authorities, log TLS
//     keys or send requests through a proxy taken from the environment: each would let a third party read the token;
//   - replaces the fake token with the real one, read from the person's Cline settings on the host;
//   - refreshes an expiring token itself, under the same SQLite lock Cline uses, and writes it back
//     the way Cline does (a backup first), so the real credentials never enter a sandbox;
//   - records every request (path, status, model, reasoning effort) as host-side evidence.
import { createHash, randomBytes } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { loopbackOriginProblem, testSeams } from './seams.ts'

export const BROKER_PORT = 8899
export const CLINE_API_ORIGIN = 'https://api.cline.bot'
/** Providers whose requests the broker can carry: both are served by the Cline API with a Cline sign-in. */
export const BROKERED_PROVIDERS: readonly string[] = ['cline', 'cline-pass']
const MAX_BODY = 32 << 20
const MAX_LOG_BYTES = 16 << 20
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
  /** The origin this broker sends requests (and the real token) to: always the Cline API outside tests. */ upstream: string
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

/** Runs fn holding an SQLite lock file (BEGIN EXCLUSIVE), the mechanism Cline uses for its refresh locks. */
const withSqliteLock = async <T>(lock: string, fn: () => Promise<T>): Promise<T> => {
  let db: DatabaseSync
  try { db = new DatabaseSync(lock) } catch (e) {
    // a settings directory the person cannot write is theirs to fix; anything else (descriptors, memory) is temporary
    let writable = true; try { accessSync(dirname(lock), constants.W_OK) } catch { writable = false }
    const why = `the Cline credential lock ${lock.split('/').pop()} cannot be opened (${(e as Error).message})`
    throw writable ? new Error(`${why}; temporary`) : new SignInError(`${why}: check that ~/.cline/data/settings is writable`)
  }
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
/** Cline's own refresh lock for this provider, as Cline takes it. */
const withClineLock = <T>(dataDir: string, provider: string, fn: () => Promise<T>): Promise<T> => withSqliteLock(`${providersFile(dataDir)}.oauth-${createHash('sha256').update(provider).digest('hex')}.lock`, fn)
/**
 * Cockpit's lock around its read-modify-write of providers.json: Cline's locks are per provider, so two supervisors
 * refreshing two providers at once would otherwise both rewrite the whole file and one would lose the other's token.
 */
export const writeLockFile = (dataDir: string): string => `${providersFile(dataDir)}.cockpit-write.lock`

/**
 * providers.json as an object. Cline (or an editor, a backup tool) may be replacing or writing it: a missing or torn
 * file is retried for about 1.5 s without blocking; one that stays missing or corrupt, is not an object, or cannot be
 * read for permission reasons is a sign-in problem the person must fix (a SignInError), never written over.
 */
const readJson = async (f: string, patienceMs = 1500): Promise<ProvidersDoc> => {
  const until = Date.now() + patienceMs
  let last = 'unreadable'
  for (;;) {
    try {
      const v = JSON.parse(readFileSync(f, 'utf8')) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as ProvidersDoc
      last = 'not an object'
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR') throw new SignInError(`no usable Cline settings (${code}): run \`cline auth\` on the host`)
      // never the parser's own message: V8 quotes the input around the error, which can be part of a token
      last = code === 'ENOENT' ? 'missing' : code ? `unreadable (${code})` : 'not valid JSON'
    }
    if (Date.now() >= until) throw new SignInError(`Cline's providers.json is ${last}: run \`cline auth\` on the host`)
    await new Promise(r => setTimeout(r, 50))
  }
}
const readAuth = async (dataDir: string, provider: string): Promise<{ doc: ProvidersDoc; auth: NonNullable<NonNullable<NonNullable<ProvidersDoc['providers']>[string]['settings']>['auth']> }> => {
  const doc = await readJson(providersFile(dataDir))
  const auth = doc.providers?.[provider]?.settings?.auth
  if (!auth || typeof auth.accessToken !== 'string' || !auth.accessToken) throw new SignInError(`no Cline sign-in for provider "${provider}": run \`cline auth\` on the host`)
  return { doc, auth }
}
/** The person's Cline sign-in cannot be used (missing, expired without refresh, refused by the server): the run is an authentication failure. */
export class SignInError extends Error {}
/** An expiry as Cline stores or returns it: epoch ms, epoch seconds or an ISO date; NaN when it is none of these. */
export const expiry = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? (v > 1e11 ? v : v * 1000) : typeof v === 'string' ? (/^\d+(?:\.\d+)?$/.test(v.trim()) ? expiry(Number(v)) : Date.parse(v)) : NaN
const live = (v: unknown, now: number): boolean => { const e = expiry(v); return Number.isFinite(e) && e - now > REFRESH_BUFFER_MS }

type RefreshAnswer = { success?: boolean; data?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; expiresIn?: unknown; tokenType?: unknown; userInfo?: Record<string, unknown> } }
type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number; tokenType: string | null; userInfo: Record<string, unknown> | null }
/** The tokens in a refresh answer received at `receivedAt`, or null when it carries no access token (it can never be applied). */
const tokensOf = (text: string, receivedAt: number): Tokens | null => {
  let b: RefreshAnswer | null = null
  try { b = JSON.parse(text) as RefreshAnswer } catch { return null }
  const d = b?.data
  if (!b?.success || !d || typeof d.accessToken !== 'string' || !d.accessToken) return null
  // a relative or missing expiry counts from when the answer was received, not from when it is applied
  let e = expiry(d.expiresAt)
  if (!Number.isFinite(e) && typeof d.expiresIn === 'number') e = receivedAt + d.expiresIn * 1000
  if (!Number.isFinite(e)) e = receivedAt + 15 * 60_000
  return { accessToken: d.accessToken, refreshToken: typeof d.refreshToken === 'string' && d.refreshToken ? d.refreshToken : null, expiresAt: e, tokenType: typeof d.tokenType === 'string' ? d.tokenType : null, userInfo: d.userInfo && typeof d.userInfo === 'object' ? d.userInfo : null }
}
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
/** A kept refresh answer, bound to the refresh token that produced it (by hash) and to when it was received. */
type Recovery = { v: 1; usedSha256: string; at: number; answer: string }
const RECOVERY_MAX_AGE_MS = 24 * 3600_000
/** Refreshes that failed after the server had answered, per sign-in: that refresh token is never tried again in this process. */
const LATCHED = new Map<string, { used: string; msg: string }>()
/** Where a provider's kept refresh answer lives (one per provider: Cline's locks are per provider). */
export const recoveryFile = (dataDir: string, provider: string): string => `${providersFile(dataDir)}.cockpit-refresh-${provider.replace(/[^A-Za-z0-9._-]/g, '_')}`

/**
 * The real access token, refreshed on the host when it is within 5 minutes of expiry, the way Cline does it
 * (POST /api/v1/auth/refresh under Cline's own lock). The person's sign-in must never be lost or overwritten:
 *  - the server's answer is saved first to `providers.json.cockpit-refresh-<provider>` (0600), bound to the hash of
 *    the refresh token it came from; it is applied later only for that same token and within 24 hours; a kept
 *    answer that does not apply, or has been saved, is moved aside under a time stamp (the newest three are kept);
 *  - providers.json is read again immediately before the write: if the sign-in changed meanwhile (the person
 *    signed in again), the person's sign-in wins and nothing is written; otherwise only this provider's `auth`
 *    is replaced, keeping every other change; the previous file is kept as `providers.json.cockpit-backup`;
 *  - after the server has answered, any failure latches: the same refresh token is never tried again in this
 *    process (a refresh token may be single-use); the next supervisor run applies the kept answer;
 *  - only a definite refusal (the refresh endpoint's 4xx, a missing or unusable sign-in) is a SignInError; a
 *    server error, a rate limit, a network failure or a lock timeout is a temporary failure and may be retried.
 */
export const realToken = async (dataDir: string, provider: string, upstream: string, now: () => number = Date.now): Promise<string> => {
  const bad = upstreamProblem(upstream); if (bad) throw new Error(`Cline token refresh: upstream refused: ${bad}`)
  const origin = new URL(upstream).origin
  const key = `${dataDir}\0${provider}`
  const latch = (used: string): void => { const l = LATCHED.get(key); if (l && l.used === used) throw new SignInError(l.msg) }
  const first = await readAuth(dataDir, provider)
  if (live(first.auth.expiresAt, now())) return first.auth.accessToken as string
  if (typeof first.auth.refreshToken === 'string') latch(first.auth.refreshToken)
  return withClineLock(dataDir, provider, async () => {
    const file = providersFile(dataDir); const recovery = recoveryFile(dataDir, provider)
    // moved aside under its own time stamp (the newest three are kept), never silently replaced
    const aside = (): void => {
      try { renameSync(recovery, `${recovery}.stale-${now()}`) } catch { return }
      try { const dir = join(file, '..'); const base = `${recovery.split('/').pop()}.stale-`; const old = readdirSync(dir).filter(n => n.startsWith(base)).sort((x, y) => Number(y.slice(base.length)) - Number(x.slice(base.length))); for (const n of old.slice(3)) rmSync(join(dir, n), { force: true }) } catch { /* best effort */ }
    }
    for (let round = 0; round < 2; round++) {
      // another process (Cline itself, another broker) may have refreshed while we waited for the lock
      const { auth } = await readAuth(dataDir, provider)
      if (live(auth.expiresAt, now())) return auth.accessToken as string
      if (typeof auth.refreshToken !== 'string' || !auth.refreshToken) throw new SignInError(`the Cline sign-in for "${provider}" has expired and has no refresh token: run \`cline auth\` on the host`)
      const used = auth.refreshToken
      latch(used)
      // a kept answer counts only if it came from refreshing exactly this token, recently; anything else is moved aside
      let tokens: Tokens | null = null; let keptFailed = false
      if (existsSync(recovery)) {
        let rec: Recovery | null = null
        try { rec = JSON.parse(readFileSync(recovery, 'utf8')) as Recovery } catch { /* unreadable */ }
        tokens = rec && rec.v === 1 && rec.usedSha256 === sha256(used) && typeof rec.at === 'number' && now() - rec.at < RECOVERY_MAX_AGE_MS && typeof rec.answer === 'string' ? tokensOf(rec.answer, rec.at) : null
        if (!tokens) aside()
      }
      if (!tokens) {
        let r: Response
        const unsafe = transportProblem(); if (unsafe) throw new Error(`Cline token refresh refused: ${unsafe}`)
        try { r = await fetch(upstreamUrl(origin, '/api/v1/auth/refresh'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: used, grantType: 'refresh_token' }), signal: AbortSignal.timeout(30_000), redirect: 'error' }) }
        catch (e) { throw new Error(`Cline token refresh could not reach the server (${(e as Error).message}); temporary`) }
        const text = await r.text().catch(() => '')
        if (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408) { const msg = `Cline token refresh was refused (${r.status}): run \`cline auth\` on the host`; LATCHED.set(key, { used, msg }); throw new SignInError(msg) }
        if (!r.ok) throw new Error(`Cline token refresh failed (${r.status}); temporary`)
        tokens = tokensOf(text, now())
        if (!tokens) { const msg = 'Cline token refresh returned no access token: run `cline auth` on the host'; LATCHED.set(key, { used, msg }); throw new SignInError(msg) }
        // kept before anything that can fail, bound to the token that was just spent; if even that cannot be written,
        // the tokens are still saved below (they exist only in memory now), and nothing retries the spent token
        try { writeFileSync(recovery, JSON.stringify({ v: 1, usedSha256: sha256(used), at: now(), answer: text } satisfies Recovery), { mode: 0o600 }) } catch { keptFailed = true }
      }
      // read again right before writing, under Cockpit's write lock; the auth that is replaced is the one read now
      const fail = (why: string): never => { const msg = `${why}; ${keptFailed ? 'the server\'s answer could not be kept either' : 'the server\'s answer is kept beside providers.json and the next supervisor run applies it'}: if this persists, run \`cline auth\` on the host`; LATCHED.set(key, { used, msg }); throw new SignInError(msg) }
      const t = tokens
      let saved: 'saved' | 'superseded'
      // from here on the server's answer exists (and the refresh token may be spent): every failure latches
      try {
      saved = await withSqliteLock(writeLockFile(dataDir), async (): Promise<'saved' | 'superseded'> => {
        let current: ProvidersDoc
        try { current = await readJson(file) } catch (e) { return fail(`could not re-read providers.json (${(e as Error).message})`) }
        const entry = current.providers?.[provider]
        const cur = entry?.settings?.auth
        if (!entry?.settings || !cur) return fail(`the "${provider}" entry vanished from providers.json during the refresh`)
        // the person (or Cline) signed in again meanwhile: their sign-in wins; ours is set aside, never written over it
        if (cur.refreshToken !== used) return 'superseded'
        const userInfo = t.userInfo ?? (cur.metadata?.userInfo as Record<string, unknown> | undefined)
        entry.settings.auth = { ...cur, accessToken: t.accessToken, refreshToken: t.refreshToken ?? used, expiresAt: t.expiresAt, ...(typeof userInfo?.clineUserId === 'string' ? { accountId: userInfo.clineUserId } : {}), metadata: { ...(cur.metadata ?? {}), ...(t.tokenType ? { tokenType: t.tokenType } : {}), ...(userInfo ? { userInfo } : {}) } }
        entry.updatedAt = new Date().toISOString()
        const tmp = `${file}.cockpit-${provider.replace(/[^A-Za-z0-9._-]/g, '_')}-${process.pid}.tmp`
        try {
          writeFileSync(`${file}.cockpit-backup`, readFileSync(file, 'utf8'), { mode: 0o600 })
          writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 }); renameSync(tmp, file)
        } catch (e) { try { rmSync(tmp, { force: true }) } catch { /* none */ } return fail(`could not save the refreshed Cline sign-in (${(e as Error).message})`) }
        return 'saved'
      })
      } catch (e) { if (LATCHED.get(key)?.used === used) throw e; return fail(`could not save the refreshed Cline sign-in (${(e as Error).message})`) }
      if (saved === 'superseded') { aside(); continue }
      // the kept answer is removed only once the file is confirmed to hold the new sign-in (another writer, such as
      // Cline itself for another provider, could have replaced the file meanwhile)
      let confirmed = false
      try { const a = (await readJson(file, 0)).providers?.[provider]?.settings?.auth; confirmed = a?.accessToken === t.accessToken } catch { /* unconfirmed */ }
      // saved and confirmed: the kept answer is moved aside (a copy stays, in case another writer replaces the file later)
      if (confirmed) aside()
      // a kept answer can have expired since it was received: then refresh again from what was just saved
      if (live(tokens.expiresAt, now())) return tokens.accessToken
    }
    throw new SignInError('could not obtain a current Cline sign-in: run `cline auth` on the host')
  })
}

/** Top-level fields of a model turn, as Cline 3.0.74 sends them; any other field (fallback models, routing, plugins) is refused. */
export const TURN_FIELDS: ReadonlySet<string> = new Set(['model', 'messages', 'tools', 'tool_choice', 'max_tokens', 'reasoning_effort', 'reasoning', 'stream', 'stream_options', 'cache_control', 'temperature', 'top_p', 'stop', 'parallel_tool_calls'])
/**
 * Why the broker may not send the real token to `u`, or null. Only the Cline API itself (https, port 443) is allowed,
 * or a test stand-in on loopback (an IP literal; see seams.ts). Judged on the parsed URL: a path, query, fragment,
 * user name, other port or other host is refused, whatever form the string takes.
 */
export const upstreamProblem = (u: string): string | null => {
  let url: URL; try { url = new URL(u) } catch { return 'not a URL' }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return 'an origin only (no credentials, path, query or fragment)'
  if (url.origin === CLINE_API_ORIGIN) return null
  return loopbackOriginProblem(u) ? `only ${CLINE_API_ORIGIN} (or a test stand-in on 127.0.0.1 or [::1])` : null
}
/** The URL for an API path on the checked upstream; refuses anything that would leave its origin. */
const upstreamUrl = (origin: string, pathAndQuery: string): string => {
  const url = new URL(pathAndQuery, origin)
  if (url.origin !== origin || !pathAndQuery.startsWith('/') || pathAndQuery.startsWith('//')) throw new Error('request target leaves the provider origin')
  return url.href
}
/** Upstream answers the broker never follows or passes on: a redirect could carry the request (and the token) elsewhere. */
const REDIRECT = new Set([300, 301, 302, 303, 305, 307, 308])
/** Node options that weaken TLS or route requests through a proxy, given on the command line or in NODE_OPTIONS. */
const UNSAFE_NODE_FLAG = /(?:^|\s)--(?:use-env-proxy|tls-keylog|openssl-config)\b/
/**
 * Why this process cannot carry the real token safely, or null. Node reads these from the environment, and each lets
 * a third party read requests to the Cline API: certificate checks turned off, extra or replaced certificate
 * authorities or OpenSSL configuration, TLS session keys written to a file, or requests sent through a proxy named
 * in the environment.
 * bin/cockpit-cline clears them before Node starts; any other way of starting Cockpit with them set is refused.
 */
export const transportProblem = (env: NodeJS.ProcessEnv = process.env, execArgv: readonly string[] = process.execArgv): string | null => {
  const set = (k: string): boolean => env[k] !== undefined && env[k] !== ''
  if (env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && env.NODE_TLS_REJECT_UNAUTHORIZED !== '1') return 'NODE_TLS_REJECT_UNAUTHORIZED is set (it can turn off certificate checks)'
  for (const k of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SSLKEYLOGFILE', 'NODE_USE_ENV_PROXY', 'OPENSSL_CONF']) if (set(k)) return `${k} is set (it changes which servers Node trusts or where its requests go)`
  const opts = `${execArgv.join(' ')} ${env.NODE_OPTIONS ?? ''}`
  const m = UNSAFE_NODE_FLAG.exec(opts)
  if (m) return `Node runs with ${m[0].trim()} (it changes which servers Node trusts or where its requests go)`
  return null
}

export type BrokerLimits = { budgetUsd?: number | null; budgetTokens?: number | null; maxRequests?: number; maxInflight?: number; allowUnmetered?: boolean; maxLogBytes?: number }
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
  /** Carried turns the API may have billed: accepted (2xx) or never answered; an error answer generated nothing. */ billed: number
  /** Why the broker stopped carrying turns for this attempt (budget, unmeasured), or null: the worker stops with that class. */ stop: { cls: 'budget' | 'unmetered'; detail: string } | null
  usdKnown: boolean
}

/**
 * Starts a broker for one worker. Production never passes `upstream`: requests go to the Cline API. Tests pass a
 * stand-in on loopback here, or set it through the test seam (seams.ts); anything else is refused.
 */
export const startBroker = async (o: { dataDir: string; provider: string; upstream?: string; log?: (r: BrokerRecord) => void
  /** The routed model: a model turn for any other model is refused (a worker cannot spend on a model it was not given). */ model?: string
  /** What the route may send as reasoning (see ReasoningRule); absent: not checked. A string is shorthand for { effort }. */ effort?: string | null
  reasoning?: ReasoningRule
  /** Called once when the broker stops carrying turns (budget, unmeasured, request flood): the worker stops at once. */ onStop?: (stop: { cls: 'budget' | 'unmetered'; detail: string }) => void
} & BrokerLimits): Promise<Broker> => {
  if (!BROKERED_PROVIDERS.includes(o.provider)) throw new Error(`provider "${o.provider}" cannot be brokered: only ${BROKERED_PROVIDERS.join(', ')} are supported, and workers have no other network`)
  const unsafe = transportProblem(); if (unsafe) throw new Error(`the credential broker will not run: ${unsafe}; unset it, or start Cockpit with bin/cockpit-cline, which clears it`)
  await readAuth(o.dataDir, o.provider) // fail before launch when there is no sign-in at all
  const asked = o.upstream ?? testSeams().brokerUpstream ?? CLINE_API_ORIGIN
  const bad = upstreamProblem(asked); if (bad) throw new Error(`broker upstream ${asked}: ${bad}`)
  const upstream = new URL(asked).origin
  const maxRequests = o.maxRequests ?? 600, maxInflight = o.maxInflight ?? 4
  const rule: ReasoningRule | null = o.reasoning ?? (o.effort ? { effort: o.effort } : null)
  const fakeToken = fakeJwt()
  // carried requests are always kept (bounded by maxRequests); refusals only up to a cap, so a flood of refused
  // requests can never push the record of a real model turn out
  const records: BrokerRecord[] = []; let refusedKept = 0, turnRefusalsKept = 0, refusals = 0
  const stopAll = (cls: 'budget' | 'unmetered', detail: string): void => { if (spent.stop) return; spent.stop = { cls, detail }; try { o.onStop?.(spent.stop) } catch { /* the worker's own stop */ } }
  const spent: BrokerSpent = { usd: 0, tokens: 0, requests: 0, inflight: 0, carried: 0, unmeasured: 0, billed: 0, usdKnown: true, stop: null }
  const socketDir = mkdtempSync(join(tmpdir(), 'ccl-b-'))
  const socketPath = join(socketDir, 's')
  // the log is bounded: carried requests are always logged (they are bounded by maxRequests); refusals only up to a size
  let logged = 0; let suppressed = 0
  const log = (r: BrokerRecord): void => {
    const size = JSON.stringify(r).length
    const cap = o.maxLogBytes ?? MAX_LOG_BYTES
    if (r.refused && logged + size > cap) { if (suppressed++ === 0) { try { o.log?.({ ...r, refused: `further refusals are not logged (log above ${cap} bytes)` }) } catch { /* evidence only */ } } return }
    logged += size
    try { o.log?.(r) } catch { /* the log is evidence, not control */ }
  }
  const refuse = (res: ServerResponse, req: IncomingMessage, status: number, why: string, model: string | null = null, effort: string | null = null, detail?: string): void => {
    // worker-chosen strings are cut short: a refusal record is small whatever the worker sent
    const r: BrokerRecord = { at: new Date().toISOString(), method: (req.method ?? '?').slice(0, 10), path: (req.url ?? '').slice(0, 200), status, model: model === null ? null : model.slice(0, 100), effort: effort === null ? null : effort.slice(0, 40), bytesIn: 0, refused: (detail ? `${why}: ${detail}` : why).slice(0, 600) }
    // model-turn refusals (evidence of a model or reasoning mismatch) and other refusals are kept up to separate caps,
    // so a flood of one kind never hides the other, and memory stays bounded
    if (r.path.startsWith('/api/v1/chat/completions')) { if (turnRefusalsKept < 1000) { records.push(r); turnRefusalsKept++ } }
    else if (refusedKept < 1000) { records.push(r); refusedKept++ }
    log(r)
    // a worker that keeps knocking on a closed door is stopped, not served refusals until its timeout
    if (++refusals > 5000) stopAll('budget', `more than 5000 refused requests to the broker`)
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
    // a stop is decided only by a model turn (a refused GET after a finished run does not turn it into a budget stop)
    const isTurn = path === '/api/v1/chat/completions'
    const stopWith = (cls: 'budget' | 'unmetered', why: string): void => { if (isTurn) stopAll(cls, why); refuse(res, req, 402, why) }
    if (spent.requests >= maxRequests) { if (isTurn) stopAll('budget', `request limit ${maxRequests} for this attempt reached`); return refuse(res, req, 429, `request limit ${maxRequests} for this attempt reached`) }
    if (o.budgetTokens != null && spent.tokens >= o.budgetTokens) return stopWith('budget', `token budget ${o.budgetTokens} for this attempt reached (${spent.tokens} used, measured by the broker)`)
    if (o.budgetUsd != null && spent.usd >= o.budgetUsd) return stopWith('budget', `cost budget $${o.budgetUsd} for this attempt reached ($${spent.usd.toFixed(5)} reported by the API)`)
    if (spent.unmeasured > 0 && !o.allowUnmetered && path === '/api/v1/chat/completions') return stopWith('unmetered', 'an earlier model turn the API accepted reported no usage: the budget cannot be enforced')
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
        if (j.reasoning_effort !== undefined && (typeof j.reasoning_effort !== 'string' || j.reasoning_effort.length > 40)) return refuse(res, req, 403, 'reasoning_effort must be a short string', model)
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
        if (m && m[2] === fakeToken) {
          // a sign-in that cannot be used is an authentication failure for the worker (it stops, with the remedy), never a retry
          let token: string
          try { token = await realToken(o.dataDir, o.provider, upstream) } catch (e) {
            // a definite refusal of the sign-in is an authentication failure (the run stops with the remedy); anything
            // else (a server error, a timeout, the lock) is temporary and the worker may retry
            if (e instanceof SignInError) return refuse(res, req, 401, 'the Cline sign-in on the host could not be used (authentication failed): run `cline auth` on the host', model, effort, (e as Error).message)
            return refuse(res, req, 503, 'the Cline sign-in could not be refreshed just now (temporary, service unavailable)', model, effort, (e as Error).message)
          }
          headers.authorization = `Bearer ${m[1] ?? ''}${token}`
        }
      }
      // recorded and counted as carried BEFORE it is sent: whatever happens next, the provider may have billed it
      const rec: BrokerRecord = { at: new Date().toISOString(), method: req.method, path, status: 0, model, effort, bytesIn: body?.length ?? 0, ...(turn ? { reasoningEnabled: enabled } : {}) }
      records.push(rec)
      if (turn) spent.carried++
      let gotUsage = false
      const count = (o2: unknown): void => { const u = usageOf(o2); if (!u) return; gotUsage = true; spent.tokens += u.tokens; rec.tokens = (rec.tokens ?? 0) + u.tokens; if (u.usd === null) { spent.usdKnown = false; rec.usd = null } else { spent.usd += u.usd; rec.usd = (rec.usd ?? 0) + u.usd } }
      // unmeasured: the API accepted the turn (2xx) but reported no usage, or the answer never fully arrived; an error
      // answer (4xx/5xx) generated nothing and is not spend
      // gateway answers (timeouts, bad gateway, Cloudflare 52x) can arrive after the provider generated and billed
      let cut = false; let finished = false
      const finish = (): void => {
        if (finished) return; finished = true
        const s2 = rec.status
        const mayBill = turn && (s2 === 0 || (s2 >= 200 && s2 < 300) || cut || [408, 499, 502, 504].includes(s2) || (s2 >= 520 && s2 <= 527))
        if (mayBill) spent.billed++
        if (mayBill && !gotUsage) { spent.unmeasured++; spent.usdKnown = false; rec.usd = null }
        log(rec)
      }
      let up: Response
      try { up = await fetch(upstreamUrl(upstream, `${path}${query ? `?${query}` : ''}`), { method: req.method, headers, body, redirect: 'manual', signal: ac.signal }) } catch (e) { rec.status = 0; finish(); throw e }
      rec.status = up.status
      try {
      // a redirect is neither followed nor passed on (its Location could name another host): the worker gets an error
      if (REDIRECT.has(up.status) || up.type === 'opaqueredirect') {
        rec.refused = `the provider answered ${up.status} (a redirect); never followed or relayed`
        try { await up.body?.cancel() } catch { /* nothing to read */ }
        res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Cockpit broker: the provider answered with a redirect, which is never followed' } }))
        finish(); return
      }
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
        s.on('error', () => { cut = rec.status >= 200 && rec.status < 300; res.destroy(); finish(); resolve() })
      })
      } finally { if (!finished) { cut = rec.status >= 200 && rec.status < 300; finish() } }
    } finally { spent.inflight-- }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()) })
  chmodSync(socketPath, 0o600)
  return {
    socketPath, socketDir, fakeToken, records, spent, upstream,
    // the counters are final only when no request is still being handled: wait briefly for those first
    close: async () => { const until = Date.now() + 2000; while (spent.inflight > 0 && Date.now() < until) await new Promise(r => setTimeout(r, 20)); await new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => { try { rmSync(socketDir, { recursive: true, force: true }) } catch { /* gone */ } r() }) }) },
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
