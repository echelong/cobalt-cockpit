// Shared offline test fixtures: temporary repos, a catalog that mirrors the installed
// Cline 3.0.74 entries for the five roles, and a mission factory using the fake Cline.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG_FILE, validateConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { resolveRole, staticCatalog } from '../src/catalog.ts'
import type { ModelInfo, Resolution } from '../src/catalog.ts'
import { ROLES } from '../src/core/engine.ts'
import type { Role } from '../src/core/engine.ts'
import { runWorker } from '../src/worker.ts'
import { Mission } from '../src/supervisor.ts'
import type { Deps, TaskRecord } from '../src/supervisor.ts'
import type { GateSpec } from '../src/gates.ts'
import type { TaskSpec } from '../src/router.ts'

export const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * A stand-in for the Cline API on loopback, used by every broker in this test process (and by shells it
 * starts): model turns get a small JSON answer with token usage and no cost, so the stream's own figures stay
 * the ones under test. Requests are kept for assertions.
 */
export const API_SEEN: { method: string; url: string; authorization: string | undefined; body: string }[] = []
const api = createServer((req, res) => { let body = ''; req.on('data', c => { body += c }); req.on('end', () => { if (API_SEEN.length < 5000) API_SEEN.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body: body.slice(0, 2000) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'standin', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })) }) })
api.listen(0, '127.0.0.1'); api.unref()
await new Promise<void>(r => api.once('listening', () => r()))
process.env.COCKPIT_BROKER_UPSTREAM = `http://127.0.0.1:${(api.address() as { port: number }).port}`
export const FAKE = join(HERE, 'fixtures', 'fake-cline.mjs')

export const tmp = (name: string): string => mkdtempSync(join(process.env.COCKPIT_TEST_TMP ?? tmpdir(), `ccl-${name}-`))

export const mkRepo = (dir = tmp('repo')): string => {
  const g = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'ignore' }) }
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@localhost'); g('config', 'commit.gpgsign', 'false')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# fixture\n'); writeFileSync(join(dir, 'src', 'base.txt'), 'base\n')
  g('add', '.'); g('commit', '-qm', 'init')
  return dir
}
export const git = (dir: string, ...a: string[]): string => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

const merge = (a: unknown, b: unknown): unknown => {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return b === undefined ? a : b
  const o: Record<string, unknown> = { ...(a as Record<string, unknown>) }
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) o[k] = merge((a as Record<string, unknown>)[k], v)
  return o
}
export const shippedConfig = (): Config => validateConfig(JSON.parse(readFileSync(DEFAULT_CONFIG_FILE, 'utf8')))
export const config = (over: unknown = {}): Config => validateConfig(merge(JSON.parse(readFileSync(DEFAULT_CONFIG_FILE, 'utf8')), merge({ sandbox: { hide: [] }, limits: { spawnsPerMinute: 10000, minFreeMemoryMB: 0, maxLoadPerCpu: 1000, workerTimeoutSeconds: 60 } }, over)))

/** Entries copied from the installed Cline 3.0.74 catalog (provider "cline" and "cline-pass"), 2026-11-05. */
export const CATALOG: Record<string, Record<string, ModelInfo>> = {
  cline: {
    'deepseek/deepseek-v4.1-flash-1017': { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', capabilities: ['images', 'tools', 'reasoning', 'structured_output', 'temperature', 'prompt-cache'], reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], pricing: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } },
    'deepseek/deepseek-v4.1-flash': { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', capabilities: ['tools', 'reasoning'], reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } },
    '~deepseek/deepseek-flash-latest': { id: '~deepseek/deepseek-flash-latest', name: 'DeepSeek Flash (latest)', capabilities: ['tools', 'reasoning'], reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], pricing: { input: 0.3, output: 1.2 } },
    'moonshotai/kimi-k3.1-pro': { id: 'moonshotai/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', capabilities: ['images', 'video', 'tools', 'reasoning', 'structured_output', 'prompt-cache'], reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 } },
    'xiaomi/mimo-v2.6-pro': { id: 'xiaomi/mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', capabilities: ['images', 'video', 'tools', 'reasoning', 'structured_output', 'temperature', 'prompt-cache'], reasoningOptions: [{ type: 'toggle' }], pricing: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 } },
    'qwen/qwen3.8-max-0902': { id: 'qwen/qwen3.8-max-0902', name: 'Qwen3.8 Max 0902', capabilities: ['images', 'video', 'tools', 'reasoning', 'structured_output', 'temperature', 'prompt-cache'], reasoningOptions: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }], pricing: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 0 } },
    'zai/glm-5.3-flash': { id: 'zai/glm-5.3-flash', name: 'GLM 5.3 Flash', capabilities: ['images', 'tools', 'reasoning', 'structured_output', 'temperature', 'prompt-cache'], reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }], pricing: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 } },
  },
  'cline-pass': {
    'cline-pass/deepseek-v4.1-flash-1017': { id: 'cline-pass/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', capabilities: ['tools', 'reasoning'], reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    'cline-pass/kimi-k3.1-pro': { id: 'cline-pass/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', capabilities: ['tools', 'reasoning'], reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    'cline-pass/mimo-v2.6-pro': { id: 'cline-pass/mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', capabilities: ['tools', 'reasoning'], reasoningOptions: [{ type: 'toggle' }], pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    'cline-pass/qwen3.8-max': { id: 'cline-pass/qwen3.8-max', name: 'Qwen 3.8 Max', capabilities: ['tools', 'reasoning'], reasoningOptions: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'xhigh'] }], pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    'cline-pass/glm-5.3-flash': { id: 'cline-pass/glm-5.3-flash', name: 'GLM-5.3-Flash', capabilities: ['tools', 'reasoning'], reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }], pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  },
}
export const catalog = staticCatalog(CATALOG, '3.0.74-fixture')

export const resolutions = async (c: Config): Promise<Record<Role, Resolution>> => {
  const roles = c.profiles[c.profile].roles
  return Object.fromEntries(await Promise.all(ROLES.map(async r => [r, await resolveRole(catalog, r, roles[r], c.unpinnedAllowed)] as const))) as Record<Role, Resolution>
}

export type Env = { root: string; repo: string; data: string }
/** A real secret-shaped token planted in the test sign-in: tests assert it never reaches a sandbox. */
export const TEST_REAL_TOKEN = 'REAL-TEST-TOKEN-must-never-enter-a-sandbox-7f3a9c'
/** A Cline data directory with a (test) sign-in for both brokered providers, as `cline auth` leaves it. */
export const clineData = (dir: string = tmp('cline-data')): string => {
  mkdirSync(join(dir, 'settings'), { recursive: true })
  const auth = { accessToken: TEST_REAL_TOKEN, refreshToken: 'test-refresh', expiresAt: Date.now() + 86400_000, accountId: 'acct-test', metadata: { provider: 'cline', tokenType: 'Bearer' } }
  writeFileSync(join(dir, 'settings', 'providers.json'), JSON.stringify({ version: 1, lastUsedProvider: 'cline', modes: {}, providers: { cline: { settings: { provider: 'cline', auth }, tokenSource: 'oauth' }, 'cline-pass': { settings: { provider: 'cline-pass', auth }, tokenSource: 'manual' }, anthropic: { settings: { provider: 'anthropic', apiKey: 'OTHER-PROVIDER-KEY-must-never-enter-a-sandbox' }, tokenSource: 'manual' } } }, null, 2))
  return dir
}
export const env = (): Env => { const root = tmp('state'); const data = clineData(join(root, 'cline-data')); return { root, repo: mkRepo(), data } }

export const deps = (e: Env, over: Partial<Deps> = {}): Deps => ({ clineBin: FAKE, clineDataDir: e.data, now: Date.now, runWorker, shareDirs: [], log: () => undefined, ...over })

export const task = (id: string, over: Partial<TaskSpec> = {}): TaskSpec => ({ id, title: `task ${id}`, kind: 'implement', risk: 'medium', complexity: 3, mode: 'write', owned: [`/src/${id}`], dependencies: [], prompt: `[[write:src/${id}/out.txt=${id}]]`, priority: 5, depth: 1, parent: null, ...over })

export const mission = async (e: Env, o: { tasks?: TaskSpec[]; goal?: string; config?: Config; gates?: GateSpec[]; deps?: Partial<Deps>; single?: boolean; swarm?: boolean; review?: boolean }): Promise<Mission> => {
  const c = o.config ?? config()
  return Mission.create({ stateRoot: e.root, repoDir: e.repo, goal: o.goal ?? 'test mission', config: c, resolutions: await resolutions(c), deps: deps(e, o.deps), gates: o.gates ?? [{ name: 'sanity', command: 'true', required: true }], clineVersion: 'fixture', tasks: o.tasks, single: o.single, swarm: o.swarm, review: o.review ?? false })
}

export type Row = TaskRecord & { id: string }
export const allTasks = (m: Mission): Row[] => {
  const rows: Row[] = Object.entries(m.live.tasks).map(([id, t]) => ({ id, ...t }))
  for (const p of m.archive.index().pages) rows.push(...(m.archive.page(p.n) as Row[]))
  return rows
}
export const byId = (m: Mission, id: string): Row => { const t = allTasks(m).find(x => x.id === id); if (!t) throw new Error(`no task ${id}`); return t }
