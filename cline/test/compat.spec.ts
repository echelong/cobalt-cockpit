// Portable defaults and configuration compatibility of existing missions (Milestone D).
// A conversation may continue without the person's acceptance only when its configuration is unchanged, or when
// nothing but descriptive settings changed against the snapshot it provably started with.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG_FILE, loadConfig, mergedConfig, PACKAGE_DIR, validateConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { configDigest, DESCRIPTIVE_PATHS, diffConfig, readSnapshot, runtimeFingerprint, runtimeView, sameRuntime, SNAPSHOT_FILE, snapshotFor } from '../src/compat.ts'
import { createExclusive, migrationReport, recordSnapshot, reportText } from '../src/migrate.ts'
import type { Report } from '../src/migrate.ts'
import { Mission, missionDir } from '../src/supervisor.ts'
import { resolveRole } from '../src/catalog.ts'
import { tryLock, unlock, writeAtomic } from '../src/store.ts'
import { catalog, deps, env, resolutions, tmp } from './helpers.ts'
import type { Env } from './helpers.ts'

const T = { timeout: 60_000 }
const SHIPPED = (): Record<string, unknown> => JSON.parse(readFileSync(DEFAULT_CONFIG_FILE, 'utf8')) as Record<string, unknown>
const clone = <V>(v: V): V => JSON.parse(JSON.stringify(v)) as V
const writeJson = (f: string, v: unknown): string => { writeFileSync(f, JSON.stringify(v, null, 1)); return f }
/** Every leaf path of a configuration (a list is one leaf). */
const leaves = (v: unknown, p: string[] = []): string[][] => v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).flatMap(([k, x]) => leaves(x, [...p, k])) : [p]
const setPath = (o: Record<string, unknown>, p: string[], value: unknown): void => { let c = o; for (const k of p.slice(0, -1)) c = c[k] as Record<string, unknown>; c[p[p.length - 1]] = value }
const getPath = (o: unknown, p: string[]): unknown => p.reduce<unknown>((c, k) => (c as Record<string, unknown>)[k], o)
const mutate = (v: unknown): unknown => typeof v === 'number' ? v + 1 : typeof v === 'boolean' ? !v : typeof v === 'string' ? `${v}-x` : Array.isArray(v) ? [...v, 'extra'] : v === null ? 1 : 'x'

/** An earlier shipped defaults file: the personal hide entries and the old ClinePass wording this milestone removed. */
const OLD_EXTRA_HIDE = ['~/.claude-main', '~/.local/share/cobalt-cockpit-evidence', '~/.local/share/cobalt-cockpit-backup-key']
const oldDefaults = (dir: string): { file: string; hide: string[] } => {
  const d = SHIPPED() as { sandbox: { hide: string[] }; profiles: Record<string, { description: string }> }
  const hide = [...d.sandbox.hide.slice(0, 5), ...OLD_EXTRA_HIDE, ...d.sandbox.hide.slice(5)]
  d.sandbox.hide = hide
  d.profiles['cline-pass'].description = 'ClinePass subscription models. ... refused in strict mode until you opt in with allowUnpinned.'
  return { file: writeJson(join(dir, 'old-default.json'), d), hide }
}
const cfg = (defaultsFile: string, file: string | null): Config => validateConfig(mergedConfig({ defaultsFile, file, profile: 'cline', strict: true }))
const create = async (e: Env, c: Config, legacy = false, conversation = true): Promise<Mission> => {
  const m = await Mission.create({ stateRoot: e.root, repoDir: e.repo, goal: 'compat', config: c, resolutions: await resolutions(c), deps: deps(e), gates: [], clineVersion: 'fixture', ...(conversation ? { conversation: true, allowDirty: true } : { tasks: [] }) })
  // a mission made before snapshots existed has none
  if (legacy) rmSync(join(m.dir, SNAPSHOT_FILE))
  return m
}
const open = async (e: Env, m: Mission, c: Config, accept = false, clineVersion = 'fixture'): Promise<Mission> => Mission.open(e.root, m.header.id, c, await resolutions(c), deps(e), { acceptConfigChange: accept, clineVersion })
const kinds = (m: Mission): string[] => [...m.ledger.entries()].map(x => x.kind)
/** Every file under a directory with its size, mode, mtime and content digest: proof that nothing was written. */
const tree = (dir: string): string => {
  const out: string[] = []
  const walk = (d: string): void => { for (const n of readdirSync(d).sort()) { const p = join(d, n); const s = statSync(p); out.push(`${p} ${s.size} ${s.mode} ${s.mtimeMs}${s.isFile() ? ` ${createHash('sha256').update(readFileSync(p, 'utf8')).digest('hex')}` : ''}`); if (s.isDirectory()) walk(p) } }
  walk(dir); return out.join('\n')
}

describe('portable defaults', () => {
  test('the shipped defaults name no person, home directory or machine-specific location', () => {
    const text = readFileSync(DEFAULT_CONFIG_FILE, 'utf8')
    for (const bad of ['/home/', '/Users/', '/root', '.claude-main', 'cobalt-cockpit-evidence', 'backup-key', ...(userInfo().username.length >= 3 ? [`/${userInfo().username}`] : [])]) assert.ok(!text.includes(bad), `default.json mentions ${bad}`)
    const hide = (SHIPPED() as { sandbox: { hide: string[] } }).sandbox.hide
    assert.deepEqual(hide, ['~/.ssh', '~/.gnupg', '~/.aws', '~/.config/gcloud', '~/.claude', '~/.local/state/cobalt-cockpit-cline'])
    for (const h of hide) assert.match(h, /^~\/\.[a-z]/, `${h} is a home-relative dot path, the same on every machine`)
  })

  test('roles, reasoning, version pins, budgets, limits, tools and the rest of the sandbox are unchanged', () => {
    const c = validateConfig(SHIPPED())
    const roles = (p: string): string[] => Object.entries(c.profiles[p].roles).map(([r, s]) => `${r}=${s.provider}/${s.model}:${s.reasoning}${s.requireName ? `@${s.requireName}` : ''}`).sort()
    assert.deepEqual(roles('cline'), ['coder=cline/deepseek/deepseek-v4.1-flash-1017:xhigh@1017', 'commander=cline/moonshotai/kimi-k3.1-pro:high', 'frontend=cline/qwen/qwen3.8-max-0902:xhigh@0902', 'specialist=cline/xiaomi/mimo-v2.6-pro:high', 'utility=cline/zai/glm-5.3-flash:low'])
    assert.deepEqual(roles('cline-pass'), ['coder=cline-pass/cline-pass/deepseek-v4.1-flash-1017:xhigh@1017', 'commander=cline-pass/cline-pass/kimi-k3.1-pro:high', 'frontend=cline-pass/cline-pass/qwen3.8-max:xhigh@0902', 'specialist=cline-pass/cline-pass/mimo-v2.6-pro:high', 'utility=cline-pass/cline-pass/glm-5.3-flash:low'])
    assert.equal(c.profile, 'cline'); assert.equal(c.strict, true); assert.deepEqual(c.unpinnedAllowed, []); assert.deepEqual(c.sandbox.allowRead, [])
    assert.deepEqual(c.budgets, { sessionUsd: 3.0, sessionTokens: 40000000, taskUsd: { commander: 1.5, coder: 0.75, specialist: 0.75, frontend: 1.0, utility: 0.2 }, taskTokens: { commander: 3000000, coder: 4000000, specialist: 3000000, frontend: 3000000, utility: 1000000 }, alertAt: [0.5, 0.8, 1.0], allowUnmetered: false, onSessionCap: 'cancel' })
    assert.deepEqual(c.tools, { allowed: ['read_files', 'search_codebase', 'run_commands', 'editor'], readOnlyAllowed: ['read_files', 'search_codebase', 'run_commands'] })
    assert.deepEqual(c.escalation, { coder: 'commander', specialist: 'commander', frontend: 'commander', utility: 'coder', commander: null })
    assert.equal(c.limits.maxAttemptsPerTask, 4); assert.equal(c.limits.maxEscalationsPerTask, 1); assert.deepEqual(c.limits.concurrency, { total: 6, commander: 1, coder: 6, specialist: 2, frontend: 2, utility: 4 })
  })

  test('the ClinePass description says what the code does: the frontend role is refused, strict or not, until unpinnedAllowed opts in', async () => {
    const d = (SHIPPED() as { profiles: Record<string, { description: string }> }).profiles['cline-pass'].description
    assert.ok(!/allowUnpinned/.test(d)); assert.match(d, /"cline-pass\/cline-pass\/qwen3\.8-max" to unpinnedAllowed/)
    for (const strict of [true, false]) {
      const c = validateConfig(mergedConfig({ file: null, profile: 'cline-pass', strict }))
      const refused = await resolveRole(catalog, 'frontend', c.profiles['cline-pass'].roles.frontend, c.unpinnedAllowed)
      assert.equal(refused.ok, false, `strict ${strict}`)
      const allowed = await resolveRole(catalog, 'frontend', c.profiles['cline-pass'].roles.frontend, ['cline-pass/cline-pass/qwen3.8-max'])
      assert.equal(allowed.ok, true, `strict ${strict}`)
    }
  })

  test('a personal sandbox.hide in the user file replaces the default list (list replacement), and nothing else', () => {
    const dir = tmp('cfg'); const mine = ['~/.ssh', '~/.private-keys']
    const c = loadConfig({ file: writeJson(join(dir, 'u.json'), { sandbox: { hide: mine } }), profile: 'cline' })
    assert.deepEqual(c.sandbox.hide, mine)
    assert.deepEqual(c.sandbox.allowRead, []); assert.equal(c.budgets.sessionUsd, 3)
  })

  test('missing, malformed and invalid user configurations are errors, never a silent fallback', () => {
    const dir = tmp('cfg')
    assert.throws(() => loadConfig({ file: join(dir, 'absent.json') }), /ENOENT/)
    assert.throws(() => loadConfig({ file: (writeFileSync(join(dir, 'bad.json'), '{ "sandbox": '), join(dir, 'bad.json')) }))
    assert.throws(() => loadConfig({ file: writeJson(join(dir, 'h.json'), { sandbox: { hide: '~/.ssh' } }) }), /sandbox\.hide: array required/)
    assert.throws(() => loadConfig({ file: writeJson(join(dir, 'r.json'), { sandbox: { allowRead: ['~'] } }) }), /whole home directory/)
    assert.throws(() => loadConfig({ file: writeJson(join(dir, 'n.json'), { sandbox: { allowNetwork: true } }) }), /allowNetwork was removed/)
    assert.throws(() => loadConfig({ file: writeJson(join(dir, 'p.json'), { profiles: { cline: { roles: { coder: { requireName: '' } } } } }) }), /requireName/)
    // with no user file at all, the shipped defaults load as they are
    assert.equal(configDigest(mergedConfig({ file: null })), configDigest(SHIPPED()))
  })
})

describe('the runtime view leaves out descriptive settings and nothing else', () => {
  test('changing any one setting of the shipped configuration changes the runtime view, except a profile description', () => {
    const base = SHIPPED(); let descriptive = 0
    for (const p of leaves(base)) {
      const changed = clone(base); setPath(changed, p, mutate(getPath(base, p)))
      const desc = p.length === 3 && p[0] === 'profiles' && p[2] === 'description'
      if (desc) descriptive++
      assert.equal(sameRuntime(base, changed), desc, p.join('.'))
      assert.notEqual(configDigest(base), configDigest(changed), `${p.join('.')} still changes the full digest`)
    }
    assert.equal(descriptive, 2)
    assert.deepEqual(DESCRIPTIVE_PATHS, [['profiles', '*', 'description']])
  })

  test('an unknown key, a reordered or repeated list entry and a removed setting are runtime changes', () => {
    const base = SHIPPED()
    const extra = clone(base); (extra as Record<string, unknown>).newSetting = true
    const reordered = clone(base) as { sandbox: { hide: string[] } }; reordered.sandbox.hide.reverse()
    const repeated = clone(base) as { sandbox: { hide: string[] } }; repeated.sandbox.hide.push('~/.ssh')
    const removed = clone(base) as { limits: Record<string, unknown> }; delete removed.limits.maxQueue
    const describedRole = clone(base) as { profiles: { cline: { roles: { coder: Record<string, unknown> } } } }; describedRole.profiles.cline.roles.coder.description = 'a description inside a role is not a profile description'
    for (const c of [extra, reordered, repeated, removed, describedRole]) assert.equal(sameRuntime(base, c), false)
    assert.notEqual(runtimeFingerprint(base), runtimeFingerprint(extra))
    assert.match(runtimeFingerprint(base), /^r1:[0-9a-f]{32}$/)
  })

  test('the header digest is the same function as before (missions made by earlier versions still match)', () => {
    // fixed values: a change to the digest would silently strand every existing mission
    assert.equal(configDigest({ b: 1, a: [2, 1], c: { z: null, y: 'v' } }), configDigest({ c: { y: 'v', z: null }, a: [2, 1], b: 1 }))
    assert.equal(configDigest({ b: 1, a: [2, 1] }), '96cdeb5c78442219')
  })

  test('a profile description is read only by doctor, for display', () => {
    const src = join(PACKAGE_DIR, 'src')
    const uses: string[] = []
    const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|mjs)$/.test(n) && n !== 'compat.ts') readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/\bdescription\b/.test(l)) uses.push(`${p.slice(src.length + 1)}:${l.trim()}`) }) } }
    walk(src)
    // the type declaration and doctor's one line; any other mention (a read, a destructuring) fails here
    assert.equal(uses.length, 2, uses.join('\n'))
    assert.ok(uses.some(u => u.startsWith('config.ts:profiles: Record<string, { description: string;')), uses.join('\n'))
    assert.ok(uses.some(u => /^cli\.ts:print\(`profile: \$\{config\.profile\} \(\$\{config\.profiles\[config\.profile\]\.description\}\)/.test(u)), uses.join('\n'))
  })

  test('the change classification marks every non-descriptive change as runtime and notes loosening', () => {
    const base = SHIPPED() as { sandbox: { hide: string[]; allowRead: string[] }; budgets: { sessionUsd: number }; strict: boolean }
    const after = clone(base); after.sandbox.hide = after.sandbox.hide.slice(1); after.sandbox.allowRead = ['/opt/sdk']; after.budgets.sessionUsd = 50; after.strict = false
    const d = diffConfig(base, after)
    const by = (p: string) => d.find(c => c.path === p)
    assert.equal(by('sandbox.hide')?.securityRelevant, true); assert.match(by('sandbox.hide')?.note ?? '', /removed "~\/\.ssh" \(less protection\)/)
    assert.match(by('sandbox.allowRead')?.note ?? '', /added "\/opt\/sdk" \(less protection\)/)
    assert.equal(by('budgets.sessionUsd')?.note, 'raised'); assert.match(by('strict')?.note ?? '', /less protection/)
    assert.equal(diffConfig(base, clone(base)).length, 0)
  })
})

describe('reopening a mission across configuration changes', () => {
  test('a snapshot whose recorded digest differs from the header is invalid even when its configuration hashes right', T, async () => {
    const e = env(); const c = cfg(DEFAULT_CONFIG_FILE, null)
    const m = await create(e, c)
    writeAtomic(join(m.dir, SNAPSHOT_FILE), JSON.stringify({ ...JSON.parse(readFileSync(join(m.dir, SNAPSHOT_FILE), 'utf8')), configDigest: '0000000000000000' }))
    assert.equal(readSnapshot(m.dir, m.header).state, 'invalid')
  })

  test('a key named __proto__ is refused in configuration files and stays an ordinary key in the runtime view', () => {
    const dir = tmp('cfg')
    const f = join(dir, 'proto.json'); writeFileSync(f, '{ "sandbox": { "__proto__": { "hide": [] } } }')
    assert.throws(() => loadConfig({ file: f }), /key "__proto__" is not allowed \(at sandbox\)/)
    const forged = JSON.parse('{ "a": 1, "__proto__": { "hide": [] } }') as Record<string, unknown>
    const view = runtimeView(forged) as Record<string, unknown>
    assert.ok(Object.prototype.hasOwnProperty.call(view, '__proto__')); assert.equal(Object.getPrototypeOf(view), Object.prototype)
    assert.equal(sameRuntime(forged, { a: 1 }), false)
  })

  test('an old conversation (no snapshot) under its original configuration resumes as before', T, async () => {
    const e = env(); const c = cfg(DEFAULT_CONFIG_FILE, null)
    const m = await create(e, c, true)
    const again = await open(e, m, c)
    assert.ok(!kinds(again).includes('config_changed')); assert.deepEqual(again.live.problems ?? [], [])
  })

  test('an old conversation (no snapshot) is still refused when only a description changed: nothing proves the rest is equal', T, async () => {
    const e = env(); const c = cfg(DEFAULT_CONFIG_FILE, null)
    const m = await create(e, c, true)
    const worded = validateConfig(mergedConfig({ file: writeJson(join(tmp('cfg'), 'u.json'), { profiles: { cline: { description: 'new words' } } }), profile: 'cline', strict: true }))
    await assert.rejects(async () => open(e, m, worded), /no snapshot/)
  })

  test('a new conversation records its snapshot and continues across a description change, with no acceptance and no problem', T, async () => {
    const e = env(); const c = cfg(DEFAULT_CONFIG_FILE, null)
    const m = await create(e, c)
    const s = readSnapshot(m.dir, m.header); assert.equal(s.state, 'valid')
    assert.equal(statSync(join(m.dir, SNAPSHOT_FILE)).mode & 0o777, 0o600)
    const worded = validateConfig(mergedConfig({ file: writeJson(join(tmp('cfg'), 'u.json'), { profiles: { cline: { description: 'new words' }, 'cline-pass': { description: 'more new words' } } }), profile: 'cline', strict: true }))
    const again = await open(e, m, worded)
    // recorded only once this process supervises the mission
    assert.ok(!kinds(again).includes('config_equivalent'))
    again.acquire(); again.release()
    const eq = [...again.ledger.entries()].find(x => x.kind === 'config_equivalent')
    assert.ok(eq); assert.deepEqual((eq.data as { descriptive: string[] }).descriptive, ['profiles.cline.description', 'profiles.cline-pass.description'])
    assert.ok(!kinds(again).includes('config_changed')); assert.deepEqual(again.live.problems ?? [], [])
  })

  test('every security-relevant change is refused without acceptance, also changes that look stronger', T, async () => {
    const e = env(); const c = cfg(DEFAULT_CONFIG_FILE, null)
    const m = await create(e, c)
    const variants: [string, unknown][] = [
      ['a hide entry removed', { sandbox: { hide: c.sandbox.hide.slice(1) } }],
      ['a hide entry added', { sandbox: { hide: [...c.sandbox.hide, '~/.kube'] } }],
      ['a read-only path approved', { sandbox: { allowRead: ['/opt'] } }],
      ['the session budget raised', { budgets: { sessionUsd: 30 } }],
      ['the session budget lowered', { budgets: { sessionUsd: 1 } }],
      ['unmetered work allowed', { budgets: { allowUnmetered: true } }],
      ['a tool added', { tools: { readOnlyAllowed: [...c.tools.readOnlyAllowed, 'editor'] } }],
      ['strict turned off', { strict: false }],
      ['an unpinned model allowed', { unpinnedAllowed: ['cline/qwen/qwen3.8-max-0902'] }],
      ['a model changed', { profiles: { cline: { roles: { utility: { model: 'deepseek/deepseek-v4.1-flash-1017' } } } } }],
      ['reasoning changed', { profiles: { cline: { roles: { coder: { reasoning: 'high' } } } } }],
      ['a limit changed', { limits: { maxAttemptsPerTask: 8 } }],
      ['pricing overridden', { pricingOverrides: { 'zai/glm-5.3-flash': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }],
      ['an unknown key', { newSetting: 1 }],
    ]
    for (const [what, over] of variants) {
      const changed = validateConfig(mergedConfig({ file: writeJson(join(tmp('cfg'), 'u.json'), over), profile: 'cline', strict: (over as { strict?: boolean }).strict ?? true }))
      await assert.rejects(async () => open(e, m, changed), /was created with config .*runtime/, what)
    }
    // the removed requireName pin: a role spec without it (a user file cannot delete a key, so build it directly)
    const unpinned = clone(c); delete (unpinned.profiles.cline.roles.coder as { requireName?: string }).requireName
    await assert.rejects(async () => open(e, m, validateConfig(unpinned)), /requireName.*version pin removed/)
    // accepted explicitly: recorded with the changed settings, and the mission carries the problem as before
    const ok = await open(e, m, validateConfig(mergedConfig({ file: writeJson(join(tmp('cfg'), 'u.json'), { sandbox: { hide: [] } }), profile: 'cline', strict: true })), true)
    const ch = [...ok.ledger.entries()].find(x => x.kind === 'config_changed')
    assert.ok(ch); assert.match(JSON.stringify((ch.data as { changes: string[] }).changes), /sandbox\.hide \[sandbox, runtime\]: removed/)
    assert.ok((ok.live.problems ?? []).some(p => /different configuration/.test(p)))
  })

  test('opening writes nothing to the ledger; the equivalence is recorded only under the supervisor lock', T, async () => {
    const e = env(); const c = cfg(DEFAULT_CONFIG_FILE, null)
    const m = await create(e, c)
    const worded = validateConfig(mergedConfig({ file: writeJson(join(tmp('cfg'), 'u.json'), { profiles: { cline: { description: 'x' } } }), profile: 'cline', strict: true }))
    const before = tree(join(m.dir, 'ledger'))
    // a running supervisor (this process stands in for it) holds the mission; recover opens it meanwhile
    assert.ok(tryLock(join(m.dir, 'supervisor.lock'), 'supervise').ok)
    const second = await open(e, m, worded)
    assert.equal(tree(join(m.dir, 'ledger')), before)
    unlock(join(m.dir, 'supervisor.lock'))
    second.acquire(); second.release()
    assert.equal(kinds(second).filter(k => k === 'config_equivalent').length, 1)
    assert.ok(second.ledger.verify().ok)
  })

  test('a description change does not excuse a different Cline version', T, async () => {
    const e = env(); const c = cfg(DEFAULT_CONFIG_FILE, null)
    const m = await create(e, c)
    const worded = validateConfig(mergedConfig({ file: writeJson(join(tmp('cfg'), 'u.json'), { profiles: { cline: { description: 'x' } } }), profile: 'cline', strict: true }))
    await assert.rejects(async () => open(e, m, worded, false, 'fixture-2'), /on Cline fixture-2/)
  })

  test('a snapshot that does not match the mission digest, names another mission or is corrupt proves nothing', T, async () => {
    const e = env(); const c = cfg(DEFAULT_CONFIG_FILE, null)
    const worded = validateConfig(mergedConfig({ file: writeJson(join(tmp('cfg'), 'u.json'), { profiles: { cline: { description: 'x' } } }), profile: 'cline', strict: true }))
    const f = (m: Mission): string => join(m.dir, SNAPSHOT_FILE)
    // a forged snapshot claiming the mission's digest for a weaker configuration
    const m1 = await create(e, c)
    const weaker = clone(c) as unknown as { sandbox: { hide: string[] } }; weaker.sandbox.hide = []
    writeAtomic(f(m1), JSON.stringify({ ...JSON.parse(readFileSync(f(m1), 'utf8')), config: weaker }))
    assert.equal(readSnapshot(m1.dir, m1.header).state, 'invalid')
    await assert.rejects(async () => open(e, m1, worded), /does not match the configuration digest/)
    const m2 = await create(e, c)
    writeAtomic(f(m2), JSON.stringify({ ...JSON.parse(readFileSync(f(m2), 'utf8')), missionId: 'm-other' }))
    await assert.rejects(async () => open(e, m2, worded), /names mission m-other/)
    const m3 = await create(e, c)
    writeFileSync(f(m3), '{"v":1,"config":')
    await assert.rejects(async () => open(e, m3, worded), /not readable JSON/)
    // the unchanged configuration still opens: the digest alone proves it
    await open(e, m3, c)
    assert.throws(() => snapshotFor('m-x', configDigest(c), weaker, 'migrated'), /does not match/)
  })
})

/** The report rows for the given missions, in their order (ids made in the same second do not sort by time). */
const inOrder = (r: Report, ms: Mission[]): Report['missions'] => ms.map(m => { const x = r.missions.find(y => y.id === m.header.id); assert.ok(x, m.header.id); return x })

/** A state root with conversations made under the earlier defaults, before snapshots existed. */
const legacyWorld = async (): Promise<{ e: Env; old: { file: string; hide: string[] }; dir: string; personal: string; missions: Mission[] }> => {
  const e = env(); const dir = tmp('migrate'); const old = oldDefaults(dir)
  const original = cfg(old.file, null)
  const missions = [await create(e, original, true), await create(e, original, true)]
  // one made under some other configuration nobody can reproduce
  missions.push(await create(e, validateConfig(mergedConfig({ defaultsFile: old.file, file: writeJson(join(dir, 'gone.json'), { budgets: { sessionUsd: 7 } }), profile: 'cline', strict: true })), true))
  const personal = writeJson(join(dir, 'personal.json'), { sandbox: { hide: old.hide } })
  return { e, old, dir, personal, missions }
}

describe('migrate-config', () => {
  test('the dry run reports fingerprints, outcomes and security relevance, and writes nothing', T, async () => {
    const { e, old, personal, missions } = await legacyWorld()
    const before = tree(e.root)
    // portable defaults with the personal hide list kept in the person's own file: a descriptive change only
    const r = migrationReport({ stateRoot: e.root, userFile: null, proposedFile: personal, previousDefaults: [old.file] })
    assert.equal(r.current.runtime, r.proposed.runtime); assert.notEqual(r.current.digest, r.proposed.digest)
    assert.deepEqual(r.differences.map(c => c.path), ['profiles.cline-pass.description'])
    const out = (id: string) => r.missions.find(m => m.id === id)
    assert.equal(out(missions[0].header.id)?.outcome, 'continues-after-apply'); assert.equal(out(missions[0].header.id)?.original, 'reconstructed')
    assert.equal(out(missions[2].header.id)?.outcome, 'requires-acceptance'); assert.equal(out(missions[2].header.id)?.original, 'unproven')
    assert.match(reportText(r, false), /security-relevant settings change: no/)
    assert.match(reportText(r, false), /judged as reopened with --profile cline · original reconstructed/)
    assert.match(reportText(r, false), /the interactive shell uses the current --profile and --no-strict/)
    assert.match(reportText(r, false), /3 mission\(s\): 0 unchanged, 0 continue, 2 continue after --apply, 1 need --accept-config-change/)
    // portable defaults alone (no personal file): the personal hide entries disappear, a security-relevant change
    const bare = migrationReport({ stateRoot: e.root, userFile: null, proposedFile: undefined, previousDefaults: [old.file] })
    const m0 = bare.missions.find(m => m.id === missions[0].header.id)
    assert.equal(m0?.applied, null)
    assert.equal(m0?.outcome, 'requires-acceptance')
    assert.match((m0?.changes ?? []).map(c => `${c.path} ${c.note}`).join(';'), /sandbox\.hide removed "~\/\.claude-main", "~\/\.local\/share\/cobalt-cockpit-evidence", "~\/\.local\/share\/cobalt-cockpit-backup-key" \(less protection\)/)
    assert.match(reportText(bare, false), /security-relevant settings change: YES \(sandbox\.hide\)/)
    assert.equal(tree(e.root), before, 'the dry run changed the state root')
  })

  test('the newest open conversation of each repository is the one the shell would resume', T, async () => {
    const { e, old, personal, missions } = await legacyWorld()
    const r = migrationReport({ stateRoot: e.root, userFile: null, proposedFile: personal, previousDefaults: [old.file] })
    const newest = [...missions].sort((a, b) => b.header.id.localeCompare(a.header.id))[0]
    assert.deepEqual(r.missions.filter(m => m.shellResumes).map(m => m.id), newest.header.mode === 'conversation' ? [newest.header.id] : [])
  })

  test('--apply records snapshots only where they let a conversation continue; the header and everything else stay', T, async () => {
    const { e, old, personal, missions } = await legacyWorld()
    const headers = missions.map(m => readFileSync(join(m.dir, 'mission.json'), 'utf8'))
    const unproven = tree(missions[2].dir)
    const r = migrationReport({ stateRoot: e.root, userFile: null, proposedFile: personal, previousDefaults: [old.file], apply: true })
    assert.deepEqual(inOrder(r, missions).map(m => m.applied), ['recorded', 'recorded', null])
    missions.forEach((m, i) => assert.equal(readFileSync(join(m.dir, 'mission.json'), 'utf8'), headers[i]))
    assert.equal(tree(missions[2].dir), unproven, 'a mission needing acceptance was touched')
    // reopened under the portable defaults plus the personal file: continues, recorded as equivalent, no problem
    const proposed = cfg(DEFAULT_CONFIG_FILE, personal)
    const again = Mission.open(e.root, missions[0].header.id, proposed, await resolutions(proposed), deps(e), { clineVersion: 'fixture' })
    again.acquire(); again.release()
    // --apply wrote no ledger record; the first open records the equivalence with how the snapshot was made
    assert.deepEqual(kinds(again).filter(k => k.startsWith('config')), ['config_equivalent'])
    const eq = [...again.ledger.entries()].find(x => x.kind === 'config_equivalent')?.data as { snapshot: { method: string; by: string; source: string } }
    assert.equal(eq.snapshot.method, 'migrated'); assert.equal(eq.snapshot.by, 'cockpit-cline migrate-config --apply'); assert.match(eq.snapshot.source, /old-default\.json/)
    assert.deepEqual(again.live.problems ?? [], [])
    // without the personal file the same conversation still needs acceptance (the hide entries would be lost)
    await assert.rejects(async () => open(e, missions[0], cfg(DEFAULT_CONFIG_FILE, null)), /sandbox\.hide \[sandbox, runtime\]: removed/)
    // the mission nobody can prove is refused exactly as before
    await assert.rejects(async () => open(e, missions[2], proposed), /no snapshot/)
  })

  test('--apply is idempotent and writes nothing but the snapshot files', T, async () => {
    const { e, old, personal, missions } = await legacyWorld()
    const args = { stateRoot: e.root, userFile: null, proposedFile: personal, previousDefaults: [old.file], apply: true }
    const ledgers = missions.map(m => tree(join(m.dir, 'ledger')))
    const others = missions.map(m => readdirSync(m.dir).filter(n => n !== SNAPSHOT_FILE).sort())
    migrationReport(args)
    const second = migrationReport(args)
    // recorded conversations now continue by their snapshot; nothing more is done to them
    assert.deepEqual(inOrder(second, missions).map(m => m.outcome), ['continues', 'continues', 'requires-acceptance'])
    assert.deepEqual(inOrder(second, missions).map(m => m.applied), [null, null, null])
    missions.forEach((m, i) => { assert.equal(tree(join(m.dir, 'ledger')), ledgers[i]); assert.deepEqual(readdirSync(m.dir).filter(n => n !== SNAPSHOT_FILE).sort(), others[i]) })
    assert.equal(recordSnapshot(missions[0].dir, missions[0].header.id, cfg(old.file, null), 'test'), 'already recorded')
    // a configuration that does not match the digest is never recorded
    const fresh = await create(e, cfg(old.file, null), true)
    assert.equal(recordSnapshot(fresh.dir, fresh.header.id, cfg(DEFAULT_CONFIG_FILE, null), 'test'), 'skipped: the configuration no longer matches the mission digest')
    assert.equal(readSnapshot(fresh.dir, fresh.header).state, 'absent')
  })

  test('only open conversations get a snapshot: a closed conversation and a finished mission are left as they are', T, async () => {
    const { e, old, personal } = await legacyWorld()
    const original = cfg(old.file, null)
    const closed = await create(e, original, true)
    assert.ok(closed.closeConversation().ok)
    const planned = await create(e, original, true, false)
    const before = [tree(closed.dir), tree(planned.dir)]
    const r = migrationReport({ stateRoot: e.root, userFile: null, proposedFile: personal, previousDefaults: [old.file], apply: true })
    const [c, p] = inOrder(r, [closed, planned])
    assert.equal(c.outcome, 'requires-acceptance'); assert.match(c.why, /only for open conversations \(this is a closed conversation\)/); assert.equal(c.applied, null)
    assert.equal(p.outcome, 'requires-acceptance'); assert.match(p.why, /this is a plan-file mission/); assert.equal(p.applied, null)
    assert.deepEqual([tree(closed.dir), tree(planned.dir)], before)
  })

  test('an interrupted write leaves no snapshot (a temporary file is ignored), and an invalid snapshot is never overwritten', T, async () => {
    const { e, old, personal, missions } = await legacyWorld()
    writeFileSync(join(missions[0].dir, `${SNAPSHOT_FILE}.tmp-99999-abcd1234`), '{"v":1,"con')
    writeFileSync(join(missions[1].dir, SNAPSHOT_FILE), '{"v":1,"con')
    const r = migrationReport({ stateRoot: e.root, userFile: null, proposedFile: personal, previousDefaults: [old.file], apply: true })
    const [a, b] = inOrder(r, missions)
    assert.equal(a.applied, 'recorded'); assert.equal(readSnapshot(missions[0].dir, missions[0].header).state, 'valid')
    assert.equal(b.snapshot, 'invalid'); assert.equal(b.outcome, 'requires-acceptance'); assert.equal(b.applied, null)
    assert.equal(readFileSync(join(missions[1].dir, SNAPSHOT_FILE), 'utf8'), '{"v":1,"con')
  })

  test('--apply leaves a mission alone while a live, unreadable or foreign lock holds it, and never touches a stale lock', T, async () => {
    const { old, missions } = await legacyWorld()
    const dirOf = missions[0].dir, id = missions[0].header.id
    const original = cfg(old.file, null)
    const os = await import('node:os')
    const lockBody = (pid: number, host = os.hostname()): string => JSON.stringify({ holder: { pid, start: '1', boot: 'x' }, host, at: new Date().toISOString(), purpose: 'test' })
    for (const f of ['shell.lock', 'supervisor.lock']) {
      // a live holder (this process stands in for the shell or the supervisor)
      assert.ok(tryLock(join(dirOf, f), 'interactive shell').ok)
      assert.match(recordSnapshot(dirOf, id, original, 'test'), new RegExp(`skipped: the mission is held by pid ${process.pid} .*\\(${f.replace('.', '\\.')}\\)`))
      unlock(join(dirOf, f))
      // a lock being written (unreadable) and a lock from another host
      writeFileSync(join(dirOf, f), '')
      assert.match(recordSnapshot(dirOf, id, original, 'test'), /skipped: the mission is held by an unreadable lock holder/)
      for (const junk of ['null', '{}', `{"host":"${os.hostname()}"}`]) { writeFileSync(join(dirOf, f), junk); assert.match(recordSnapshot(dirOf, id, original, 'test'), /unreadable lock holder/, junk) }
      writeFileSync(join(dirOf, f), lockBody(2 ** 22 + 7, 'another-host'))
      assert.match(recordSnapshot(dirOf, id, original, 'test'), /on another-host/)
      rmSync(join(dirOf, f))
    }
    assert.equal(readSnapshot(dirOf, missions[0].header).state, 'absent')
    // a supervisor that died holding its lock: recorded, and the stale lock is left exactly as it was (recover handles it)
    const stale = lockBody(2 ** 22 + 7)
    writeFileSync(join(dirOf, 'supervisor.lock'), stale)
    assert.equal(recordSnapshot(dirOf, id, original, 'test'), 'recorded')
    assert.equal(readFileSync(join(dirOf, 'supervisor.lock'), 'utf8'), stale)
  })

  test('the snapshot is created only if absent, complete, private, and leaves no temporary file', () => {
    const dir = tmp('excl'); const f = join(dir, SNAPSHOT_FILE)
    assert.equal(createExclusive(f, 'first'), true)
    assert.equal(createExclusive(f, 'second'), false)
    assert.equal(readFileSync(f, 'utf8'), 'first'); assert.equal(statSync(f).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(dir), [SNAPSHOT_FILE])
  })

  test('concurrent --apply runs record each snapshot once', T, async () => {
    const { e, old, personal, missions } = await legacyWorld()
    const child = (): Promise<{ code: number | null; out: string }> => new Promise(res => {
      const c = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', join(PACKAGE_DIR, 'loader', 'register.mjs'), join(PACKAGE_DIR, 'test', 'fixtures', 'migrate-child.ts'), e.root, '-', personal, old.file], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', TMPDIR: process.env.TMPDIR ?? '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''; c.stdout.on('data', d => { out += d }); c.stderr.on('data', d => { out += d }); c.on('close', code => res({ code, out }))
    })
    const runs = await Promise.all([child(), child(), child(), child()])
    for (const r of runs) assert.equal(r.code, 0, r.out)
    for (const m of missions.slice(0, 2)) {
      assert.equal(readSnapshot(m.dir, m.header).state, 'valid')
      assert.equal([...m.ledger.entries()].filter(x => x.kind.startsWith('config')).length, 0)
      assert.ok(m.ledger.verify().ok)
    }
    const applied = runs.flatMap(r => (JSON.parse(r.out) as { id: string; applied: string | null }[]).filter(x => x.id === missions[0].header.id).map(x => x.applied))
    assert.equal(applied.filter(a => a === 'recorded').length, 1, applied.join(' | '))
    assert.ok(applied.every(a => a === null || a === 'recorded' || a === 'already recorded'), applied.join(' | '))
  })

  test('malformed or invalid files fail the report closed, without echoing their contents', () => {
    const dir = tmp('migrate'); const root = tmp('state')
    const secretish = 'TOPSECRET-should-not-be-echoed'
    const bad = join(dir, 'bad.json'); writeFileSync(bad, `{ "sandbox": ${secretish}`)
    assert.throws(() => migrationReport({ stateRoot: root, userFile: null, proposedFile: bad }), (e: Error) => /proposed configuration .*: not valid JSON/.test(e.message) && !e.message.includes(secretish))
    assert.throws(() => migrationReport({ stateRoot: root, userFile: bad }), /configuration .*: not valid JSON/)
    assert.throws(() => migrationReport({ stateRoot: root, userFile: null, proposedFile: join(dir, 'absent.json') }), /ENOENT/)
    assert.throws(() => migrationReport({ stateRoot: root, userFile: null, proposedFile: writeJson(join(dir, 'inv.json'), { sandbox: { hide: 'x' } }) }), /sandbox\.hide: array required/)
    // an unreadable mission is listed without quoting its contents
    const st = tmp('state'); const md = join(st, 'missions', 'm-broken'); mkdirSync(md, { recursive: true })
    writeFileSync(join(md, 'mission.json'), `{ "goal": "${secretish}`)
    const r = migrationReport({ stateRoot: st, userFile: null })
    assert.deepEqual(r.unreadable, [{ id: 'm-broken', why: 'mission.json or live.json is not valid JSON' }])
    // no state at all: an empty report, not an error
    assert.equal(migrationReport({ stateRoot: join(dir, 'none'), userFile: null }).missions.length, 0)
  })
})
