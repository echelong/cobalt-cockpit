// cockpit-cline: Cobalt Cockpit for Cline. Commands: doctor, models, route, run, status,
// watch, cancel, recover, replay, list, smoke.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ROLES } from './core/engine.ts'
import type { Role } from './core/engine.ts'
import { loadConfig, rolesOf } from './config.ts'
import type { Config } from './config.ts'
import { loadCatalog, providerAuth, resolveRole } from './catalog.ts'
import type { Catalog, Resolution } from './catalog.ts'
import { planReasoning } from './reasoning.ts'
import { routeTask, KINDS, RISKS } from './router.ts'
import type { TaskSpec } from './router.ts'
import { pricingFor, usd } from './cost.ts'
import { bwrapAvailable } from './sandbox.ts'
import { ALLOWED, BROKERED_PROVIDERS, CLINE_API_ORIGIN } from './broker.ts'
import { DEFAULT_CLINE_DATA, runWorker } from './worker.ts'
import { detectGates } from './gates.ts'
import type { GateSpec } from './gates.ts'
import { Mission, missionDir } from './supervisor.ts'
import type { Deps, Header, Live } from './supervisor.ts'
import { Ledger, listClaims, lostMissions, readJson, retireClaim, retireMarker, stateRoot, writeAtomic, listMarkers } from './store.ts'
import { census } from './proc.ts'
import { render } from './hud.ts'
import { repoInfo } from './git.ts'
import { validateTasks } from './planner.ts'
import { statusOf } from './status.ts'

type Args = { _: string[]; flags: Record<string, string | boolean>; multi: Record<string, string[]> }
/** A command-line mistake: printed with the usage, exit 2, and nothing has run. */
export class UsageError extends Error {}
const VALUE_FLAGS: readonly string[] = ['repo', 'plan', 'profile', 'gate', 'budget-usd', 'config', 'roles', 'max-usd', 'kind', 'risk', 'complexity', 'mode', 'title', 'prompt', 'owned', 'lost', 'share', 'state']
const SWITCHES: readonly string[] = ['no-strict', 'json', 'watch', 'single', 'swarm', 'no-review', 'allow-dirty', 'no-detect-gates', 'accept-config-change', 'new', 'yes', 'help']
/**
 * Strict: an unknown or misspelt flag, a missing or empty value, or a value given to a switch is
 * an error. A typo such as `--budget 0.5` must not quietly run under the default budget.
 */
export const parseArgs = (argv: string[]): Args => {
  const a: Args = { _: [], flags: {}, multi: {} }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--') { a._.push(...argv.slice(i + 1)); break }
    if (v.startsWith('--')) {
      const [k, inline] = v.slice(2).split(/=(.*)/s)
      let val: string | boolean
      if (VALUE_FLAGS.includes(k)) {
        const given = inline !== undefined ? inline : argv[++i]
        if (given === undefined || !given.trim() || (inline === undefined && given.startsWith('--'))) throw new UsageError(`--${k} needs a value`)
        val = given
      } else if (SWITCHES.includes(k)) {
        if (inline !== undefined) throw new UsageError(`--${k} takes no value (got --${k}=${inline})`)
        val = true
      } else throw new UsageError(`unknown option --${k}`)
      if (k === 'gate' || k === 'share') (a.multi[k] ??= []).push(String(val))
      else a.flags[k] = val
    } else a._.push(v)
  }
  return a
}
/** A positive, finite dollar amount from a flag, or a usage error. */
const dollars = (a: Args, k: string): number | undefined => {
  const s = str(a, k); if (s === undefined) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0 || !/^\s*\d*\.?\d+\s*$/.test(s)) throw new UsageError(`--${k} must be a dollar amount such as 0.25 (got ${s})`)
  return n
}
const str = (a: Args, k: string): string | undefined => typeof a.flags[k] === 'string' ? a.flags[k] as string : undefined
const print = (s: string): void => { process.stdout.write(`${s}\n`) }

const setup = async (a: Args): Promise<{ config: Config; catalog: Catalog; resolutions: Record<Role, Resolution> }> => {
  const budget = dollars(a, 'budget-usd')
  const config = loadConfig({ file: str(a, 'config'), profile: str(a, 'profile'), ...(a.flags['no-strict'] ? { strict: false } : {}), ...(budget !== undefined ? { overrides: { budgets: { sessionUsd: budget } } } : {}) })
  const catalog = await loadCatalog()
  const roles = rolesOf(config)
  const resolutions = Object.fromEntries(await Promise.all(ROLES.map(async r => [r, await resolveRole(catalog, r, roles[r], config.unpinnedAllowed)] as const))) as Record<Role, Resolution>
  return { config, catalog, resolutions }
}
const deps = (a: Args, repoRoot: string): Deps => ({
  clineBin: process.env.COCKPIT_CLINE_BIN ?? 'cline', clineDataDir: process.env.COCKPIT_CLINE_DATA ?? DEFAULT_CLINE_DATA, now: Date.now, runWorker,
  shareDirs: (a.multi.share ?? []).map(s => ({ from: resolve(repoRoot, s), to: s })),
  log: l => process.stderr.write(`${l}\n`),
})
const root = (a: Args): string => str(a, 'state') ?? stateRoot()
const latestMission = (r: string): string | null => { try { return readdirSync(join(r, 'missions')).sort().at(-1) ?? null } catch { return null } }

// ---------------------------------------------------------------------------
const doctor = async (a: Args): Promise<number> => {
  let bad = 0
  const { config, catalog, resolutions } = await setup(a)
  print(`Cline ${catalog.clineVersion} · @cline/llms ${catalog.sdkVersion} · catalog ${catalog.source}`)
  const bw = await bwrapAvailable(); print(`sandbox: ${bw.ok ? 'OK' : 'FAIL'} ${bw.detail}`); if (!bw.ok) bad++
  print(`network: workers reach only ${CLINE_API_ORIGIN} (${ALLOWED.map(x => `${x.method} ${x.path}`).join(', ')}) through the host-side broker; gates have none`)
  for (const r of ROLES) { const p = rolesOf(config)[r].provider; if (!BROKERED_PROVIDERS.includes(p)) { print(`  ${r.padEnd(10)} FAIL provider ${p} cannot be brokered (only ${BROKERED_PROVIDERS.join(', ')}): its workers would be refused`); bad++ } }
  print(`profile: ${config.profile} (${config.profiles[config.profile].description}) · strict ${config.strict}`)
  for (const p of [...new Set(ROLES.map(r => rolesOf(config)[r].provider))]) { const s = providerAuth(p, process.env.COCKPIT_CLINE_DATA ?? DEFAULT_CLINE_DATA); print(`auth ${p}: ${s.configured ? 'configured' : 'MISSING'} (${s.kind}; ${s.note})`); if (!s.configured) bad++ }
  for (const r of ROLES) {
    const res = resolutions[r]
    if (!res.ok) { print(`  ${r.padEnd(10)} FAIL ${res.provider}/${res.model}: ${res.reason}`); bad++; continue }
    const spec = rolesOf(config)[r]; const plan = planReasoning(spec.reasoning, res.reasoningValues, res.reasoningToggle); const price = pricingFor(config, res.model, res.info)
    print(`  ${r.padEnd(10)} ${plan.ok ? 'OK  ' : 'FAIL'} ${res.provider}/${res.model} "${res.info.name}" · reasoning ${spec.reasoning}${plan.ok ? ` → cli --thinking ${plan.cliFlag}, expected wire ${plan.expectedWire} (${plan.mapping})` : `: ${plan.reason}`} · catalog levels ${res.reasoningValues.join('|') || (res.reasoningToggle ? 'toggle' : 'none')} · $${price.pricing.input}/$${price.pricing.output} per 1M (${price.source})${res.notes.length ? ` · ${res.notes.join('; ')}` : ''}`)
    if (!plan.ok) bad++
  }
  try { const hub = execFileSync('bash', ['-c', 'pgrep -af -- "[-]-cline-hub-daemon" || true'], { encoding: 'utf8' }).trim(); if (hub) print(`note: a Cline hub daemon is running (${hub.split('\n').length}); workers cannot reach it (each has its own network namespace)`) } catch { /* pgrep missing */ }
  const repo = str(a, 'repo')
  if (repo) { try { const info = await repoInfo(repo); const lost = lostMissions(info.commonDir); print(`repo ${info.root}: ${lost.length ? `LOST STATE for ${lost.map(l => l.marker.missionId).join(', ')}` : 'no lost mission state'} · claims ${listClaims(info.commonDir).claims.length}`); if (lost.length) bad++ } catch (e) { print(`repo: ${(e as Error).message}`); bad++ } }
  print(`state: ${root(a)}`)
  print(bad ? `doctor: ${bad} problem(s)` : 'doctor: OK')
  return bad ? 1 : 0
}

const models = async (a: Args): Promise<number> => {
  const { config, resolutions } = await setup(a)
  for (const r of ROLES) { const res = resolutions[r]; const spec = rolesOf(config)[r]; print(`${r.padEnd(10)} ${spec.provider}/${spec.model} reasoning=${spec.reasoning} ${res.ok ? `· ${res.info.name}` : `· UNRESOLVED: ${res.reason}`}`) }
  return 0
}

const route = async (a: Args): Promise<number> => {
  const { config, resolutions } = await setup(a)
  const task: TaskSpec = { id: 'probe', title: str(a, 'title') ?? 'probe', kind: (str(a, 'kind') ?? 'implement') as TaskSpec['kind'], risk: (str(a, 'risk') ?? 'medium') as TaskSpec['risk'], complexity: Number(str(a, 'complexity') ?? 3), mode: (str(a, 'mode') ?? 'write') as 'read' | 'write', owned: (str(a, 'owned') ?? '*').split(','), dependencies: [], prompt: str(a, 'prompt') ?? a._.slice(1).join(' ') }
  if (!(KINDS as readonly string[]).includes(task.kind) || !(RISKS as readonly string[]).includes(task.risk) || !Number.isInteger(task.complexity) || task.complexity < 1 || task.complexity > 5 || (task.mode !== 'read' && task.mode !== 'write')) { print(`kind ${KINDS.join('|')}, risk ${RISKS.join('|')}, complexity 1-5, mode read|write`); return 2 }
  const d = routeTask({ task, history: { attempts: 0, gateFailures: 0, escalated: false, lastFailure: null }, config, resolutions, health: {}, spentSessionUsd: 0 })
  print(JSON.stringify(d, null, 1))
  return d.ok ? 0 : 1
}

const gatesOf = (a: Args, repoRoot: string): GateSpec[] => {
  const given = (a.multi.gate ?? []).map(g => { const i = g.indexOf('='); if (i < 1) throw new Error(`--gate name=command (got ${g})`); return { name: g.slice(0, i), command: g.slice(i + 1), required: true } })
  return given.length ? given : a.flags['no-detect-gates'] ? [] : detectGates(repoRoot)
}

const run = async (a: Args): Promise<number> => {
  const goal = a._.slice(1).join(' ').trim()
  const planFile = str(a, 'plan')
  if (!goal && !planFile) { print('usage: cockpit-cline run [--repo DIR] [--plan tasks.json | --single | --swarm] [--gate name=cmd]... [--profile cline|cline-pass] [--budget-usd N] [--watch] "goal"'); return 2 }
  const { config, catalog, resolutions } = await setup(a)
  const repoDir = resolve(str(a, 'repo') ?? process.cwd())
  const info = await repoInfo(repoDir)
  let tasks: TaskSpec[] | undefined
  if (planFile) { const p = validateTasks(JSON.parse(readFileSync(planFile, 'utf8')), { max: 64, depth: 1, parent: null, existing: new Set() }); if (!p.ok) { print(`plan file rejected: ${p.reason}`); return 2 } tasks = p.tasks }
  const unresolved = ROLES.filter(r => !resolutions[r].ok)
  if (unresolved.length) print(`note: roles unavailable (tasks routed to them will be refused, not substituted): ${unresolved.map(r => `${r}: ${(resolutions[r] as { reason: string }).reason}`).join('; ')}`)
  const m = await Mission.create({ stateRoot: root(a), repoDir: info.root, goal: goal || `plan ${planFile}`, config, resolutions, deps: deps(a, info.root), gates: gatesOf(a, info.root), clineVersion: catalog.clineVersion, tasks, single: !!a.flags.single, swarm: !!a.flags.swarm, review: a.flags['no-review'] ? false : undefined, allowDirty: !!a.flags['allow-dirty'] })
  print(`mission ${m.header.id} · ${m.header.mode} (${m.header.modeReason}) · branch ${m.live.integration.branch} · state ${m.dir}`)
  let timer: NodeJS.Timeout | null = null
  if (a.flags.watch && process.stdout.isTTY) timer = setInterval(() => { process.stdout.write(`\x1b[H\x1b[2J${render(m.header, m.live, listClaims(m.header.commonDir).claims)}\n`) }, 1000)
  const v = await m.run()
  if (timer) clearInterval(timer)
  print(render(m.header, m.live, listClaims(m.header.commonDir).claims))
  print(`\nreport: ${join(m.dir, 'report.json')}`)
  return v.state === 'DONE' ? 0 : 1
}

const loadView = (a: Args, id: string | undefined): { header: Header; live: Live; dir: string } => {
  const r = root(a); const mid = id ?? latestMission(r)
  if (!mid) throw new Error('no mission found')
  const dir = missionDir(r, mid)
  return { header: readJson<Header>(join(dir, 'mission.json')), live: readJson<Live>(join(dir, 'live.json')), dir }
}
const status = (a: Args): number => {
  const v = loadView(a, a._[1])
  if (a.flags.json) print(JSON.stringify({ header: v.header, live: v.live }, null, 1))
  else print(render(v.header, v.live, listClaims(v.header.commonDir).claims))
  return 0
}
const watch = async (a: Args): Promise<number> => {
  const id = a._[1] ?? latestMission(root(a)) ?? undefined
  let confirm = false
  const draw = (): void => {
    try { const v = loadView(a, id); process.stdout.write(`\x1b[H\x1b[2J${render(v.header, v.live, listClaims(v.header.commonDir).claims)}\n\n\x1b[2mq quit · c cancel mission${confirm ? ' · press y to confirm cancel' : ''}\x1b[0m\n`) } catch (e) { process.stdout.write(`\x1b[H\x1b[2J${(e as Error).message}\n`) }
  }
  draw(); const t = setInterval(draw, 1000)
  if (!process.stdin.isTTY) { await new Promise(r => setTimeout(r, Number(process.env.COCKPIT_WATCH_MS ?? 1500))); clearInterval(t); return 0 }
  process.stdin.setRawMode(true); process.stdin.resume()
  await new Promise<void>(res => process.stdin.on('data', d => {
    const k = d.toString()
    if (k === 'q' || k === '\u0003') { clearInterval(t); process.stdin.setRawMode(false); res() }
    else if (k === 'c') { confirm = true; draw() }
    else if (k === 'y' && confirm) { const v = loadView(a, id); writeAtomic(join(v.dir, 'control.json'), JSON.stringify({ cancel: 'all' })); confirm = false; draw() }
    else { confirm = false }
  }))
  process.stdin.pause()
  return 0
}
const cancel = (a: Args): number => {
  const v = loadView(a, a._[1]); const ids = a._.slice(2)
  writeAtomic(join(v.dir, 'control.json'), JSON.stringify({ cancel: ids.length ? ids : 'all' }))
  print(`cancel requested for ${ids.length ? ids.join(', ') : 'the whole mission'}; the supervisor stops workers and confirms by process census`)
  return 0
}
const recover = async (a: Args): Promise<number> => {
  const lost = str(a, 'lost')
  if (lost) {
    const info = await repoInfo(resolve(str(a, 'repo') ?? process.cwd()))
    const marker = listMarkers(info.commonDir).find(m => m.missionId === lost)
    if (!marker) { print(`no marker for ${lost} in ${info.commonDir}`); return 2 }
    const claims = listClaims(info.commonDir).claims.filter(c => c.missionId === lost)
    let held = 0
    for (const c of claims) {
      const id = c.identity as { initPid?: number | null; initStart?: string | null; pidNs?: string | null; marker?: string | null; since?: number } | null
      // the claim's own marker when it has one: a hold on a gate's processes records the gate sandbox's marker
      const cen = census({ initPid: id?.initPid ?? null, initStart: id?.initStart ?? null, pidNs: id?.pidNs ?? null, marker: id?.marker ?? `COCKPIT_CLINE_ATTEMPT=${lost}.${c.taskId}.${c.attempt}`, since: id?.since ?? Date.parse(c.at) })
      print(`claim ${c.taskId}#${c.attempt} [${c.owned.join(',')}]: ${cen.state} (${cen.detail})`)
      if (cen.state === 'gone') retireClaim(info.commonDir, lost, c.taskId); else held++
    }
    if (held) { print(`${held} claim(s) kept: their processes are not accounted for`); return 1 }
    retireMarker(info.commonDir, lost)
    print(`mission ${lost}: lost state acknowledged; its claims are retired after a clean census. Its worktrees and branch ${'cockpit/' + lost} are kept for inspection.`)
    return 0
  }
  const v = loadView(a, a._[1])
  // resume under the mission's own profile and strictness unless the person overrides them
  if (!str(a, 'profile')) a.flags.profile = v.header.profile
  if (a.flags['no-strict'] === undefined && !v.header.strict) a.flags['no-strict'] = true
  const { config, catalog, resolutions } = await setup(a)
  const m = Mission.open(root(a), v.header.id, config, resolutions, deps(a, v.header.repoRoot), { acceptConfigChange: !!a.flags['accept-config-change'], clineVersion: catalog.clineVersion })
  m.live.stopRequested = null; m.live.verdict = null; m.live.state = 'running'
  const verdict = await m.run()
  print(render(m.header, m.live, listClaims(m.header.commonDir).claims))
  return verdict.state === 'DONE' ? 0 : 1
}
const replay = (a: Args): number => {
  const v = loadView(a, a._[1])
  const l = new Ledger(join(v.dir, 'ledger'))
  const check = l.verify()
  for (const e of l.entries()) print(`${String(e.seq).padStart(5)} ${e.at} ${e.kind.padEnd(20)} ${(e.task ?? '').padEnd(18)} ${JSON.stringify(e.data).slice(0, 160)}`)
  print(`ledger: ${check.ok ? 'chain intact' : `BROKEN: ${check.problem}`} · ${check.entries} entries`)
  return check.ok ? 0 : 1
}
const list = (a: Args): number => {
  const r = root(a)
  let ids: string[] = []; try { ids = readdirSync(join(r, 'missions')).sort() } catch { /* none */ }
  for (const id of ids) { try { const h = readJson<Header>(join(missionDir(r, id), 'mission.json')); const l = readJson<Live>(join(missionDir(r, id), 'live.json')); print(`${id}  ${statusOf(l).label.padEnd(22)} ${usd(l.session.unmetered ? null : l.session.spentUsd).padEnd(10)} ${h.repoRoot}  ${h.goal.split('\n')[0].slice(0, 60)}`) } catch { print(`${id}  unreadable`) } }
  return 0
}

/** Live, opt-in, budget-bounded check of each role's real model id, reasoning on the wire and reported cost. */
const smoke = async (a: Args): Promise<number> => {
  if (a.flags.yes !== true) { print('smoke spends real Cline credits (a few cents). Re-run with --yes to confirm. Options: --roles coder,utility --max-usd 0.25'); return 2 }
  // every argument is checked before the first paid call
  const roles = (str(a, 'roles') ?? 'coder,commander,specialist,frontend,utility').split(',').map(r => r.trim()) as Role[]
  const badRole = roles.find(r => !(ROLES as readonly string[]).includes(r))
  if (badRole !== undefined) throw new UsageError(`--roles: unknown role "${badRole}" (roles: ${ROLES.join(', ')})`)
  const maxUsd = dollars(a, 'max-usd') ?? 0.25
  if (maxUsd <= 0) throw new UsageError('--max-usd must be above 0')
  const { config, resolutions } = await setup(a)
  const dir = join(root(a), 'smoke', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(join(dir, 'repo'), { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '-q', join(dir, 'repo')]); execFileSync('git', ['-C', join(dir, 'repo'), '-c', 'user.name=cockpit', '-c', 'user.email=cockpit@localhost', 'commit', '-q', '--allow-empty', '-m', 'smoke'])
  const results: unknown[] = []; let spent = 0; let failures = 0
  for (const role of roles) {
    const res = resolutions[role]
    if (!res.ok) { results.push({ role, ok: false, reason: res.reason }); print(`${role}: UNRESOLVED ${res.reason}`); failures++; continue }
    const spec = rolesOf(config)[role]; const plan = planReasoning(spec.reasoning, res.reasoningValues, res.reasoningToggle)
    if (!plan.ok) { results.push({ role, ok: false, reason: plan.reason }); print(`${role}: ${plan.reason}`); failures++; continue }
    if (spent >= maxUsd) { print(`${role}: skipped, smoke budget $${maxUsd} used`); results.push({ role, ok: false, reason: 'smoke budget used' }); failures++; continue }
    const out = await runWorker({ attemptId: `smoke-${role}-${Date.now()}`, runDir: join(dir, role), workdir: join(dir, 'repo'), writable: false, gitCommonDir: null, gitAdminDir: null, provider: res.provider, model: res.model, cliThinking: plan.cliFlag, expectedWire: plan.expectedWire, prompt: 'Reply with exactly the word OK and finish. Do not call any tool.', policy: { workdir: join(dir, 'repo'), owned: [], mode: 'read', allowedTools: config.tools.readOnlyAllowed }, timeoutSeconds: 120, clineRetries: 1, hide: config.sandbox.hide, allowRead: config.sandbox.allowRead, clineBin: process.env.COCKPIT_CLINE_BIN ?? 'cline', clineDataDir: process.env.COCKPIT_CLINE_DATA ?? DEFAULT_CLINE_DATA, budgetUsd: Math.min(0.1, maxUsd - spent), budgetTokens: 120_000, pricing: (() => { const p = pricingFor(config, res.model, res.info); return p.source === 'none' ? null : p.pricing })(), allowUnmetered: false })
    spent += out.facts.usage.reportedUsd ?? 0
    const ok = out.facts.finishReason === 'completed' && out.facts.reportedModel === res.model && out.wire.state === 'confirmed' && out.census.state === 'gone' && out.facts.usage.reportedUsd !== null
    if (!ok) failures++
    const row = { role, ok, provider: res.provider, model: res.model, name: res.info.name, reasoning: { requested: spec.reasoning, cli: plan.cliFlag, expectedWire: plan.expectedWire, mapping: plan.mapping, wire: out.wire }, reportedModel: out.facts.reportedModel, reportedProvider: out.facts.reportedProvider, finish: out.facts.finishReason, usage: out.facts.usage, census: out.census.state, text: (out.facts.resultText ?? '').slice(0, 80), broker: (out.broker ?? []).map(r => ({ method: r.method, path: r.path, status: r.status, model: r.model, effort: r.effort, refused: r.refused ?? null })) }
    results.push(row)
    // written after every paid role, so an interrupted smoke still leaves its evidence
    writeFileSync(join(dir, 'smoke.json'), JSON.stringify({ at: new Date().toISOString(), profile: config.profile, spentUsd: spent, complete: false, results }, null, 1))
    print(`${role.padEnd(10)} ${ok ? 'PASS' : 'FAIL'} ${res.provider}/${res.model} · reported ${out.facts.reportedModel ?? '—'} · reasoning ${spec.reasoning} → wire ${out.wire.effective ?? '—'} (${out.wire.state}: ${out.wire.detail}) · ${out.facts.usage.inputTokens}/${out.facts.usage.outputTokens} tok, cache ${out.facts.usage.cacheReadTokens} · ${usd(out.facts.usage.reportedUsd)} reported · census ${out.census.state}`)
  }
  writeFileSync(join(dir, 'smoke.json'), JSON.stringify({ at: new Date().toISOString(), profile: config.profile, spentUsd: spent, complete: true, results }, null, 1))
  print(`smoke: ${failures ? `${failures} failure(s)` : 'all PASS'} · spent ${usd(spent)} (reported by Cline) · evidence ${join(dir, 'smoke.json')}`)
  return failures ? 1 : 0
}

/** The interactive Cockpit: HUD, conversation and supervised turns in one terminal. */
const shell = async (a: Args): Promise<number> => {
  const { config, catalog, resolutions } = await setup(a)
  const info = await repoInfo(resolve(str(a, 'repo') ?? process.cwd()))
  const { Shell } = await import('./shell.ts')
  const s = new Shell({ stateRoot: root(a), repoDir: info.root, config, resolutions, clineVersion: catalog.clineVersion, deps: deps(a, info.root), gates: gatesOf(a, info.root), allowDirty: !!a.flags['allow-dirty'], fresh: !!a.flags.new, acceptConfigChange: !!a.flags['accept-config-change'] })
  await s.start()
  return new Promise<number>(() => { /* the shell exits the process itself */ })
}

const HELP = `cockpit-cline — Cobalt Cockpit for Cline
  (no command, in a terminal)    the interactive Cockpit: live HUD, conversation, every turn supervised
  shell [--repo DIR] [--new] [--gate name=cmd]... [--share node_modules] [--allow-dirty]
  doctor [--repo DIR]            installed Cline, sandbox, auth, model resolution and reasoning checks
  models                         configured role -> provider/model table
  route --kind K --risk R --complexity N --mode read|write [--prompt TEXT]   explain one routing decision
  run [--repo DIR] [--plan F | --single | --swarm] [--gate name=cmd]... [--share node_modules] [--watch] "goal"
  status [MISSION] [--json] · watch [MISSION] · cancel MISSION [TASK...] · list
  recover [MISSION] [--accept-config-change] | recover --lost MISSION --repo DIR
  replay [MISSION]               ledger timeline and hash-chain verification
  smoke --yes [--roles coder,utility] [--max-usd 0.25]   LIVE: spends real credits
Global: --profile cline|cline-pass · --config FILE · --no-strict · --budget-usd N · --state DIR`

export const main = async (argv: string[]): Promise<number> => {
  try {
    const a = parseArgs(argv)
    const cmd = a.flags.help ? 'help' : a._[0]
    switch (cmd) {
      case 'doctor': return await doctor(a)
      case 'models': return await models(a)
      case 'route': return await route(a)
      case 'run': return await run(a)
      case 'status': return status(a)
      case 'watch': return await watch(a)
      case 'cancel': return cancel(a)
      case 'recover': return await recover(a)
      case 'replay': return replay(a)
      case 'list': return list(a)
      case 'smoke': return await smoke(a)
      case 'shell': return await shell(a)
      case undefined: if (process.stdin.isTTY && process.stdout.isTTY) return await shell(a); print(HELP); return 0
      case 'help': case '--help': print(HELP); return 0
      default: print(HELP); return 2
    }
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`cockpit-cline: ${e.message}\n${HELP}\n`); return 2 }
    process.stderr.write(`cockpit-cline: ${(e as Error).message}\n`); return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main(process.argv.slice(2)).then(code => process.exit(code))
void existsSync
