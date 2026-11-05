// The interactive Cobalt Cockpit for Cline: a full-screen terminal with a persistent HUD, a
// conversation transcript and an input line. Every message typed here becomes one supervised
// task in a long-lived conversation mission: routed by the router, run as a sandboxed `cline`
// worker, verified by the supervisor's gates and integrated on the mission branch. Nothing in
// the HUD is synthesised: every figure is read from the mission's live state.
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROLES } from './core/engine.ts'
import type { Role } from './core/engine.ts'
import type { Config } from './config.ts'
import type { Resolution } from './catalog.ts'
import { Mission, missionDir } from './supervisor.ts'
import type { AttemptRecord, Deps, Header, Live, TaskRecord } from './supervisor.ts'
import type { GateSpec } from './gates.ts'
import { breakStaleLock, listClaims, readJson, tryLock, unlock } from './store.ts'
import { render as missionControl, reasoningCell } from './hud.ts'
import { classifyTurn, turnPrompt } from './turn.ts'
import type { Entry } from './turn.ts'
import { routeTask } from './router.ts'
import { plannerPrompt } from './planner.ts'
import { usd } from './cost.ts'
import { repoInfo } from './git.ts'
import { statusOf } from './status.ts'

// ---------------------------------------------------------------------------
// Terminal primitives
const ESC = '\x1b['
const plain = !!process.env.NO_COLOR
const sgr = (code: string) => (s: string): string => plain ? s : `${ESC}${code}m${s}${ESC}0m`
const S = { bold: sgr('1'), dim: sgr('2'), cyan: sgr('36'), green: sgr('32'), yellow: sgr('33'), red: sgr('31'), magenta: sgr('35'), blue: sgr('34'), inv: sgr('7'), gray: sgr('90') }
// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const width = (s: string): number => [...stripAnsi(s)].length
/** Pads or cuts a styled string to exactly n visible columns. */
const fit = (s: string, n: number): string => {
  const w = width(s)
  if (w <= n) return s + ' '.repeat(n - w)
  let out = ''; let seen = 0; let i = 0
  while (i < s.length && seen < n - 1) {
    if (s[i] === '\x1b') { const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i)); if (m) { out += m[0]; i += m[0].length; continue } }
    const ch = String.fromCodePoint(s.codePointAt(i) as number); out += ch; i += ch.length; seen++
  }
  return `${out}…${plain ? '' : `${ESC}0m`}`
}
const wrap = (text: string, n: number): string[] => {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    let line = raw
    if (!line) { out.push(''); continue }
    while ([...line].length > n) {
      const chars = [...line]; let cut = chars.lastIndexOf(' ', n); if (cut < n / 3) cut = n
      out.push(chars.slice(0, cut).join('')); line = chars.slice(cut).join('').replace(/^ /, '')
    }
    out.push(line)
  }
  return out
}

// ---------------------------------------------------------------------------
// Conversation state
type Line = { text: string; style?: keyof typeof S }
type TurnView = { id: string; lines: Line[]; text: string; startedAt: number; endedAt: number | null }

export type ShellOptions = {
  stateRoot: string; repoDir: string; config: Config; resolutions: Record<Role, Resolution>; clineVersion: string
  deps: Deps; gates: GateSpec[]; allowDirty: boolean; fresh: boolean; acceptConfigChange: boolean
  input?: NodeJS.ReadStream; output?: NodeJS.WriteStream
}

const ROLE_LABEL: Record<Role, string> = { commander: 'COMMANDER', coder: 'CODER', specialist: 'SPECIALIST', frontend: 'FRONTEND', utility: 'UTILITY' }

export class Shell {
  mission!: Mission
  private transcript: Entry[] = []
  private view: Line[] = []
  private turn: TurnView | null = null
  private busy: Promise<unknown> | null = null
  private input = ''
  private cursor = 0
  private history: string[] = []
  private hist = -1
  private scroll = 0
  private overlay = false
  private quitting = false
  private ctrlC = 0
  private dirty = true
  private timer: NodeJS.Timeout | null = null
  private out: NodeJS.WriteStream
  private inp: NodeJS.ReadStream
  private shellLock = ''
  private notice: string | null = null
  /** The attempt whose text is being appended to the last transcript line. */
  private streaming: string | null = null

  constructor(readonly o: ShellOptions) {
    this.out = o.output ?? process.stdout
    this.inp = o.input ?? process.stdin
  }

  // ----- mission selection: resume the repository's open conversation, or start one -------------
  private async openMission(): Promise<void> {
    const repo = await repoInfo(this.o.repoDir)
    const deps: Deps = { ...this.o.deps, onEvent: (task, attempt, e) => this.onWorkerEvent(task, attempt, e) }
    let resumed: Mission | null = null
    if (!this.o.fresh) {
      let ids: string[] = []
      try { ids = readdirSync(join(this.o.stateRoot, 'missions')).sort().reverse() } catch { /* none yet */ }
      for (const id of ids) {
        let h: Header, l: Live & { closed?: boolean }
        try { h = readJson<Header>(join(missionDir(this.o.stateRoot, id), 'mission.json')); l = readJson<Live & { closed?: boolean }>(join(missionDir(this.o.stateRoot, id), 'live.json')) } catch { continue }
        if (h.mode !== 'conversation' || h.repoRoot !== repo.root || l.closed) continue
        // a resume that is refused (e.g. a different configuration) is reported, never silently replaced
        try { resumed = Mission.open(this.o.stateRoot, id, this.o.config, this.o.resolutions, deps, { acceptConfigChange: this.o.acceptConfigChange, clineVersion: this.o.clineVersion }) }
        catch (e) { throw new Error(`cannot resume conversation ${id}: ${(e as Error).message} (or start a new conversation with --new)`) }
        break
      }
    }
    this.mission = resumed ?? await Mission.create({ stateRoot: this.o.stateRoot, repoDir: repo.root, goal: 'interactive conversation', config: this.o.config, resolutions: this.o.resolutions, deps, gates: this.o.gates, clineVersion: this.o.clineVersion, conversation: true, allowDirty: this.o.allowDirty })
    // one interactive shell per conversation mission
    this.shellLock = join(this.mission.dir, 'shell.lock')
    const l = tryLock(this.shellLock, 'interactive shell')
    if (!l.ok) {
      if (!l.stale || !l.holder) throw new Error(`conversation ${this.mission.header.id} is open in another cockpit-cline (pid ${l.holder?.holder.pid ?? '?'}); close it, or start a separate one with --new`)
      if (!breakStaleLock(this.shellLock, l.holder) || !tryLock(this.shellLock, 'interactive shell').ok) throw new Error('could not take over the shell lock of an ended session; retry')
    }
    this.loadTranscript()
    if (resumed) {
      this.system(`resumed conversation ${this.mission.header.id} (${this.transcript.filter(e => e.role === 'user').length} earlier turn(s)); reconciling any work a previous session left open…`, 'cyan')
      this.render()
      // a turn the previous session never reported (it crashed or was killed mid-turn) is reported now
      const lastUser = [...this.transcript].reverse().find(e => e.role === 'user')
      const reported = lastUser ? this.transcript.slice(this.transcript.lastIndexOf(lastUser) + 1).some(e => e.role === 'system' && new RegExp(`^${lastUser.turn}(?:\\.\\S+)? [✓✗]`).test(e.text)) : true
      if (lastUser?.turn && !reported) this.turn = { id: lastUser.turn, lines: [], text: '', startedAt: Date.parse(lastUser.at), endedAt: null }
      await this.runMission()
      if (this.turn) this.finishTurn(this.turn.id)
      this.system('reconciled', 'dim')
    } else this.system(`new conversation ${this.mission.header.id} on ${repo.root} @ ${repo.head.slice(0, 10)}; work lands on ${this.mission.live.integration.branch}`, 'cyan')
  }

  private convoFile(): string { return join(this.mission.dir, 'conversation.jsonl') }
  private loadTranscript(): void {
    if (!existsSync(this.convoFile())) return
    for (const line of readFileSync(this.convoFile(), 'utf8').split('\n')) {
      if (!line) continue
      try { const e = JSON.parse(line) as Entry; this.transcript.push(e); this.view.push(...this.entryLines(e)) } catch { /* torn last line */ }
    }
  }
  private record(e: Entry): void { this.transcript.push(e); appendFileSync(this.convoFile(), `${JSON.stringify(e)}\n`, { mode: 0o600 }) }
  private entryLines(e: Entry): Line[] {
    if (e.role === 'user') return [{ text: '' }, { text: `❯ ${e.text}`, style: 'bold' }]
    if (e.role === 'assistant') return e.text.split('\n').map(t => ({ text: `  ${t}` }))
    return [{ text: `· ${e.text}`, style: 'dim' }]
  }
  private system(text: string, style: keyof typeof S = 'dim'): void {
    const e: Entry = { role: 'system', text, turn: this.turn?.id ?? null, at: new Date().toISOString() }
    if (this.mission) this.record(e)
    this.view.push({ text: `· ${text}`, style }); this.dirty = true
  }

  // ----- worker events: stream text and tool use into the transcript -----------------------------
  private onWorkerEvent(taskId: string, attemptId: string, e: Record<string, unknown>): void {
    if (!this.turn) return
    const ev = (e.event ?? {}) as Record<string, unknown>
    const tag = taskId === this.turn.id ? '' : `[${taskId}] `
    if (e.type === 'agent_event' && ev.type === 'content_start' && ev.contentType === 'text' && typeof ev.text === 'string') {
      this.turn.text += ev.text
      const last = this.view.at(-1)
      const parts = ev.text.split('\n')
      if (last && this.streaming === attemptId) { last.text += parts[0]; for (const p of parts.slice(1)) this.view.push({ text: `  ${tag}${p}` }) }
      else for (const [i, p] of parts.entries()) this.view.push({ text: `  ${i === 0 ? tag : ''}${p}` })
      this.streaming = attemptId
    } else if (e.type === 'agent_event' && ev.type === 'content_start' && ev.contentType === 'tool' && typeof ev.toolName === 'string') {
      const input = (ev.input ?? {}) as Record<string, unknown>
      const what = typeof input.path === 'string' ? input.path.replace(`${this.mission.live.integration.dir}/`, '') : Array.isArray(input.commands) ? String(input.commands[0]).slice(0, 80) : Array.isArray(input.paths) ? `${input.paths.length} file(s)` : ''
      this.view.push({ text: `  ${tag}▸ ${ev.toolName} ${what}`.replace(/\/[^ ]*worktrees\/[^/]+\/[^/]+\//, ''), style: 'gray' })
      this.streaming = null
    } else if (e.type === 'run_aborted') {
      this.view.push({ text: `  ${tag}■ run aborted: ${String(e.message ?? e.reason ?? '')}`, style: 'yellow' })
    }
    this.dirty = true
  }

  // ----- turns --------------------------------------------------------------------------------------
  private nextTurnId(): string { return `t${this.transcript.filter(e => e.role === 'user').length + 1}` }
  private integratedFiles(): string[] {
    const files = new Set<string>()
    // live and archived tasks: a finished turn's changes count too
    for (const [, t] of this.taskRecords()) for (const a of t.attempts) if (a.commit) for (const f of a.changes) files.add(f)
    return [...files]
  }

  private async submit(text: string, swarm = false): Promise<void> {
    const id = this.nextTurnId()
    const user: Entry = { role: 'user', text, turn: id, at: new Date().toISOString() }
    const prompt = turnPrompt(text, this.transcript, this.integratedFiles())
    this.record(user); this.view.push(...this.entryLines(user))
    this.turn = { id, lines: [], text: '', startedAt: Date.now(), endedAt: null }
    if (swarm) {
      this.mission.addTask({ id: `${id}.plan`, title: `Commander plan: ${text.slice(0, 80)}`, kind: 'architecture', risk: 'medium', complexity: 4, mode: 'read', owned: ['*'], dependencies: [], prompt: plannerPrompt(prompt, await this.mission.repoSummary()), priority: 9, depth: 0, parent: null }, 'interactive /swarm')
      this.system(`${id}: commander plans; Cockpit routes each planned task`, 'magenta')
    } else {
      const c = classifyTurn(text, id)
      const r = this.mission.addTask({ ...c.spec, prompt }, 'interactive')
      if (!r.ok) { this.system(`${id} refused: ${r.reason}`, 'red'); this.turn = null; this.dirty = true; return }
      const preview = this.mission.route(this.mission.live.tasks[id] as TaskRecord)
      this.system(`${id}: ${c.reason} → ${preview.ok ? `${preview.role} ${preview.model} (${preview.rules.at(-1)})` : `refused: ${preview.refusal}`}`, preview.ok ? 'cyan' : 'red')
    }
    this.dirty = true
    await this.runMission()
    this.finishTurn(id)
  }

  private runMission(): Promise<unknown> {
    this.busy = this.mission.run().catch(e => { this.system(`supervisor error: ${(e as Error).message}`, 'red') }).finally(() => { this.busy = null; this.dirty = true })
    return this.busy
  }

  private finishTurn(id: string): void {
    if (!this.turn) return
    let text = this.turn.text.trim()
    if (!text) {
      // nothing was streamed (a provider that sends the answer only at the end): show the final answer
      const final = [...this.taskRecords()].find(([tid]) => tid === id)?.[1].attempts.at(-1)?.resultExcerpt?.trim() ?? ''
      if (final) { text = final; this.view.push(...final.split('\n').map(t => ({ text: `  ${t}` }))) }
    }
    if (text) this.record({ role: 'assistant', text, turn: id, at: new Date().toISOString() })
    for (const [tid, t] of this.taskRecords()) {
      if (tid !== id && !tid.startsWith(`${id}.`)) continue
      const a = t.attempts.at(-1)
      const gates = (a?.gates ?? []).map(g => `${g.name} ${g.state}`).join(' · ')
      const cost = t.attempts.reduce((s, x) => s + (x.charge.usd ?? 0), 0)
      const basis = t.attempts.some(x => x.charge.basis === 'estimate') ? ' est.' : t.attempts.some(x => x.charge.basis === 'unmetered') ? ' unmetered' : ''
      const ok = t.state === 'completed'
      const changed = a?.commit ? `integrated ${a.commit.slice(0, 8)} (${a.changes.length} file(s))` : t.spec.mode === 'read' ? 'read-only' : 'no changes'
      this.system(`${tid} ${ok ? '✓' : '✗'} ${t.state}${t.reason && !ok ? `: ${t.reason}` : ''} · ${a ? `${a.role} ${a.model}` : 'not started'} · ${changed}${gates ? ` · ${gates}` : ''} · ${usd(cost)}${basis}`, ok ? 'green' : 'red')
    }
    const v = this.mission.live.verdict
    if (v && v.state !== 'DONE' && v.state !== 'UNVERIFIED') for (const r of v.reasons.slice(0, 3)) this.system(`verdict ${v.state}: ${r}`, 'yellow')
    this.turn.endedAt = Date.now(); this.turn = null
    this.dirty = true
  }

  private *taskRecords(): Generator<[string, TaskRecord]> {
    for (const [id, t] of Object.entries(this.mission.live.tasks)) yield [id, t]
    const seen = new Set(Object.keys(this.mission.live.tasks))
    for (const p of this.mission.archive.index().pages.slice(-2)) for (const r of this.mission.archive.page(p.n) as (TaskRecord & { id: string })[]) if (!seen.has(r.id)) yield [r.id, r]
  }

  // ----- commands ------------------------------------------------------------------------------------
  private async command(line: string): Promise<void> {
    const [cmd, ...rest] = line.slice(1).split(' '); const arg = rest.join(' ').trim()
    switch (cmd) {
      case 'cockpit': case 'mc': if (arg) await this.cockpit(arg); else this.overlay = !this.overlay; break
      case 'help': this.system('/cockpit (Tab) mission control · /cockpit agents|routing|costs|ready|doctor · /swarm <goal> commander plans · /route <text> explain routing · /models · /cancel (Esc) · /diff · /new · /quit (Ctrl-D) · PgUp/PgDn scroll', 'cyan'); break
      case 'models': for (const r of ROLES) { const res = this.mission.resolutions[r]; const spec = this.mission.config.profiles[this.mission.config.profile].roles[r]; this.system(`${ROLE_LABEL[r].padEnd(10)} ${spec.provider}/${spec.model} reasoning ${spec.reasoning}${res.ok ? '' : ` UNRESOLVED: ${res.reason}`}`, res.ok ? 'cyan' : 'red') } break
      case 'route': {
        if (!arg) { this.system('usage: /route <message>', 'yellow'); break }
        const c = classifyTurn(arg, 'probe')
        const r = routeTask({ task: c.spec, history: { attempts: 0, gateFailures: 0, escalated: false, lastFailure: null }, config: this.mission.config, resolutions: this.mission.resolutions, health: this.mission.live.health, spentSessionUsd: this.mission.committedUsd() })
        this.system(`${c.reason} → ${r.ok ? `${r.role} ${r.provider}/${r.model} ${r.requestedReasoning}→${r.expectedWireEffort}` : `refused: ${r.refusal}`} · rules: ${r.rules.join('; ')}`, r.ok ? 'cyan' : 'red')
        break
      }
      case 'swarm': if (!arg) { this.system('usage: /swarm <goal>', 'yellow'); break } if (this.busy) { this.system('a turn is running (Esc cancels it)', 'yellow'); break } await this.submit(arg, true); break
      case 'cancel': this.cancelTurn(); break
      case 'diff': {
        const { git } = await import('./git.ts')
        const r = await git(['diff', '--stat', `${this.mission.live.integration.base}..${this.mission.live.integration.head}`], { cwd: this.mission.live.integration.dir, allowFail: true })
        this.system(`${this.mission.live.integration.branch}: ${r.stdout.trim().split('\n').at(-1) || 'no changes yet'}`, 'cyan'); break
      }
      case 'new': {
        if (this.busy) { this.system('a turn is running (Esc cancels it)', 'yellow'); break }
        ;(this.mission.live as Live & { closed?: boolean }).closed = true; this.mission.persist(true); unlock(this.shellLock)
        this.view = []; this.transcript = []
        await this.openMissionFresh(); break
      }
      case 'quit': case 'exit': await this.quit(); break
      default: this.system(`unknown command /${cmd}; /help lists them`, 'yellow')
    }
    this.dirty = true
  }
  /** `/cockpit <view>`: real supervisor and system state, printed into the transcript. */
  private async cockpit(sub: string): Promise<void> {
    const recs = [...this.taskRecords()].map(([, t]) => t).sort((x, y) => x.createdAt - y.createdAt)
    switch (sub.split(' ')[0]) {
      case 'agents': {
        if (!recs.length) { this.system('no agents yet', 'dim'); return }
        for (const t of recs.slice(-20)) {
          const retry = (t.retryAt ?? 0) > Date.now() ? ` retry in ${Math.ceil(((t.retryAt ?? 0) - Date.now()) / 1000)}s` : ''
          this.system(`${t.spec.id.padEnd(18)} ${t.state.padEnd(9)}${retry} ${t.spec.kind}/${t.spec.risk} owns ${t.spec.owned.join(',')}${t.reason ? ` · ${t.reason.slice(0, 120)}` : ''}`, t.state === 'completed' ? 'green' : t.state === 'failed' || t.state === 'held' ? 'red' : 'cyan')
          for (const a of t.attempts) this.system(`   #${a.n} ${a.role.padEnd(10)} ${a.provider}/${a.model} ${reasoningCell(a)} ${a.phase} ${a.usageEvents ? `${a.usage.inputTokens}/${a.usage.outputTokens} tok` : 'no usage'} ${usd(a.charge.usd)}${a.charge.basis === 'estimate' ? ' est.' : ''}${a.failure ? ` ✗ ${a.failure}: ${(a.failureDetail ?? '').slice(0, 100)}` : ''}`, 'dim')
        }
        return
      }
      case 'routing': {
        const atts = recs.flatMap(t => t.attempts.map(a => ({ t, a }))).slice(-12)
        if (!atts.length) { this.system('no routing decisions yet', 'dim'); return }
        for (const { t, a } of atts) this.system(`${t.spec.id}#${a.n} → ${a.role} ${a.model} ${a.requestedReasoning}→${a.expectedWire} · ${a.route.rules.join('; ')}${a.route.signals.length ? ` · signals: ${a.route.signals.join(', ')}` : ''}`, 'cyan')
        return
      }
      case 'costs': {
        const by = new Map<string, { usd: number; inTok: number; outTok: number; cache: number; est: boolean; n: number }>()
        for (const t of recs) for (const a of t.attempts) { const k = `${a.role} ${a.model}`; const x = by.get(k) ?? { usd: 0, inTok: 0, outTok: 0, cache: 0, est: false, n: 0 }; x.usd += a.charge.usd ?? 0; x.inTok += a.usage.inputTokens; x.outTok += a.usage.outputTokens; x.cache += a.usage.cacheReadTokens; x.est ||= a.charge.basis === 'estimate'; x.n++; by.set(k, x) }
        for (const [k, x] of by) this.system(`${k.padEnd(48)} ${x.n} attempt(s) · in ${x.inTok} (cache ${x.cache}) · out ${x.outTok} · ${usd(x.usd)}${x.est ? ' (part estimated)' : ' (Cline-reported)'}`, 'cyan')
        const s = this.mission.live.session
        this.system(`session ${s.unmetered ? 'UNMETERED' : usd(s.spentUsd)} of $${this.mission.config.budgets.sessionUsd.toFixed(2)} · committed incl. in-flight ${usd(this.mission.committedUsd())}${s.capReached ? ' · CAP REACHED' : ''}`, s.capReached || s.unmetered ? 'red' : 'cyan')
        return
      }
      case 'ready': case 'doctor': {
        const { providerAuth } = await import('./catalog.ts')
        const { bwrapAvailable } = await import('./sandbox.ts')
        const { lostMissions } = await import('./store.ts')
        const problems: string[] = []
        const roles = this.mission.config.profiles[this.mission.config.profile].roles
        for (const r of ROLES) { const res = this.mission.resolutions[r]; if (!res.ok) problems.push(`${r}: ${res.reason}`) }
        for (const p of [...new Set(ROLES.map(r => roles[r].provider))]) { const a = providerAuth(p, this.mission.deps.clineDataDir); if (!a.configured) problems.push(`provider ${p}: ${a.note}`) }
        const bw = await bwrapAvailable(); if (!bw.ok) problems.push(`sandbox: ${bw.detail}`)
        const held = Object.values(this.mission.live.tasks).filter(t => t.state === 'held'); if (held.length) problems.push(`${held.length} task(s) hold ownership: ${held.map(t => t.spec.id).join(', ')}`)
        const lost = lostMissions(this.mission.header.commonDir); if (lost.length) problems.push(`lost mission state: ${lost.map(l => l.marker.missionId).join(', ')}`)
        if (this.mission.live.session.capReached) problems.push('session budget reached')
        if (this.mission.live.session.unmetered) problems.push('session usage unmetered')
        if (sub.startsWith('doctor')) {
          this.system(`Cline ${this.mission.header.clineVersion} · profile ${this.mission.config.profile} · ${this.mission.config.strict ? 'strict' : 'non-strict'} · sandbox ${bw.detail}`, 'cyan')
          for (const r of ROLES) { const res = this.mission.resolutions[r]; this.system(`${ROLE_LABEL[r].padEnd(10)} ${roles[r].provider}/${roles[r].model} reasoning ${roles[r].reasoning}${res.ok ? ` · catalog levels ${res.reasoningValues.join('|') || (res.reasoningToggle ? 'toggle' : 'none')}` : ` · UNRESOLVED ${res.reason}`}`, res.ok ? 'dim' : 'red') }
        }
        this.system(problems.length ? `NOT READY: ${problems.join(' · ')}` : 'READY: all five roles resolve, providers signed in, sandbox works, no held ownership, budget available', problems.length ? 'red' : 'green')
        return
      }
      default: this.system(`unknown /cockpit view "${sub}"; use agents, routing, costs, ready or doctor`, 'yellow')
    }
  }

  private async openMissionFresh(): Promise<void> { const fresh = this.o.fresh; (this.o as { fresh: boolean }).fresh = true; try { await this.openMission() } finally { (this.o as { fresh: boolean }).fresh = fresh } }

  private cancelTurn(): void {
    if (!this.turn || !this.busy) { this.system('nothing is running', 'dim'); return }
    let n = 0
    for (const [id] of this.taskRecords()) if ((id === this.turn.id || id.startsWith(`${this.turn.id}.`)) && this.mission.cancelTask(id, 'cancelled from the shell')) n++
    this.system(`cancelling ${this.turn.id} (${n} task(s)); ownership is released only after the sandbox is confirmed gone`, 'yellow')
  }

  private async quit(): Promise<void> {
    if (this.quitting) return
    this.quitting = true
    if (this.busy) { this.system('stopping the running turn before exit…', 'yellow'); this.mission.requestStop('shell exit'); this.render(); await this.busy }
    unlock(this.shellLock)
    this.teardown()
    this.out.write(`Cobalt Cockpit: conversation ${this.mission.header.id} · branch ${this.mission.live.integration.branch} · ${usd(this.mission.live.session.unmetered ? null : this.mission.live.session.spentUsd)} spent\n`)
    process.exit(0)
  }

  // ----- keyboard ----------------------------------------------------------------------------------
  private onKey(buf: Buffer): void {
    let s = buf.toString('utf8')
    if (s.includes('\x1b[200~')) { const body = s.replace('\x1b[200~', '').replace('\x1b[201~', ''); this.insert(body.replace(/\r\n?/g, '\n')); return }
    while (s.length) {
      const seq = /^(\x1b\[[0-9;]*[A-Za-z~]|\x1b\r|\x1b.|.)/su.exec(s)?.[0] ?? s[0]
      s = s.slice(seq.length)
      this.key(seq)
    }
  }
  private insert(t: string): void { this.input = this.input.slice(0, this.cursor) + t + this.input.slice(this.cursor); this.cursor += t.length; this.dirty = true }
  private key(k: string): void {
    this.dirty = true
    if (k !== '\x03') this.ctrlC = 0
    switch (k) {
      case '\r': case '\n': { const line = this.input.trim(); this.input = ''; this.cursor = 0; this.hist = -1; if (line) { this.history.push(line); void this.enter(line) } return }
      case '\x1b\r': this.insert('\n'); return
      case '\x7f': case '\b': if (this.cursor > 0) { this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor); this.cursor-- } return
      case '\x1b[3~': this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1); return
      case '\x1b[D': this.cursor = Math.max(0, this.cursor - 1); return
      case '\x1b[C': this.cursor = Math.min(this.input.length, this.cursor + 1); return
      case '\x1b[H': case '\x1b[1~': case '\x01': this.cursor = 0; return
      case '\x1b[F': case '\x1b[4~': case '\x05': this.cursor = this.input.length; return
      case '\x1b[A': if (this.history.length) { this.hist = this.hist < 0 ? this.history.length - 1 : Math.max(0, this.hist - 1); this.input = this.history[this.hist]; this.cursor = this.input.length } return
      case '\x1b[B': if (this.hist >= 0) { this.hist++; if (this.hist >= this.history.length) { this.hist = -1; this.input = '' } else this.input = this.history[this.hist]; this.cursor = this.input.length } return
      case '\x1b[5~': this.scroll += 10; return
      case '\x1b[6~': this.scroll = Math.max(0, this.scroll - 10); return
      case '\x15': this.input = this.input.slice(this.cursor); this.cursor = 0; return
      case '\x0c': this.out.write(`${ESC}2J`); return
      case '\t': this.overlay = !this.overlay; return
      case '\x1b': if (this.overlay) this.overlay = false; else if (this.busy) this.cancelTurn(); return
      case '\x04': void this.quit(); return
      case '\x03':
        if (this.busy && this.ctrlC === 0) { this.ctrlC++; this.cancelTurn(); this.notice = 'Ctrl-C again to stop and quit'; return }
        if (!this.busy && this.input) { this.input = ''; this.cursor = 0; return }
        void this.quit(); return
      default: if (k.length >= 1 && !k.startsWith('\x1b') && k >= ' ') this.insert(k)
    }
  }
  private async enter(line: string): Promise<void> {
    this.notice = null
    if (line.startsWith('/')) { await this.command(line); return }
    if (this.busy) { this.system('a turn is running; wait for it, or press Esc to cancel it', 'yellow'); return }
    this.scroll = 0
    await this.submit(line)
  }

  // ----- rendering -----------------------------------------------------------------------------------
  /** One crew row: the role's model, requested→effective reasoning and what it is doing now, all from live records. */
  private roleRow(r: Role, records: readonly TaskRecord[], queuedFor: ReadonlyMap<Role, TaskRecord[]>, cols: number): string {
    const spec = this.mission.config.profiles[this.mission.config.profile].roles[r]
    const res = this.mission.resolutions[r]
    const atts: { t: TaskRecord; a: AttemptRecord }[] = []
    for (const t of records) for (const a of t.attempts) if (a.role === r) atts.push({ t, a })
    const running = atts.filter(x => x.a.phase !== 'ended' && x.a.phase !== 'held')
    const held = atts.filter(x => x.a.phase === 'held')
    const last = atts.at(-1)
    const queued = queuedFor.get(r) ?? []
    const retrying = queued.filter(t => (t.retryAt ?? 0) > Date.now())
    const state = !res.ok ? S.red('UNAVAILABLE')
      : held.length ? S.red(`BLOCKED ×${held.length}`)
      : running.length ? S.green(`RUNNING ×${running.length}`)
      : retrying.length ? S.yellow(`RETRY ${Math.ceil(((retrying[0].retryAt ?? 0) - Date.now()) / 1000)}s`)
      : queued.length ? S.cyan(`QUEUED ×${queued.length}`)
      : last ? (last.t.state === 'completed' ? S.green('✓ done') : last.t.state === 'failed' ? S.red('✗ failed') : S.gray(last.t.state)) : S.gray('idle')
    const reasoning = last ? reasoningCell(last.a) : `${spec.reasoning}→${S.gray('?')}`
    const cur = running[0] ?? held[0]
    const job = cur ? `${cur.t.spec.id}#${cur.a.n} it${cur.a.iterations || 0} ${Object.values(cur.a.toolCalls).reduce((x, y) => x + y, 0)} tools ${cur.a.usageEvents ? `${Math.round((cur.a.usage.inputTokens + cur.a.usage.outputTokens) / 100) / 10}k tok` : ''}` : queued[0] ? `next ${queued[0].spec.id}` : ''
    const spent = atts.reduce((s, x) => s + (x.a.charge.usd ?? 0), 0)
    const name = res.ok ? res.info.name ?? spec.model : spec.model
    const narrow = cols < 100
    return narrow
      ? fit(` ${S.bold(ROLE_LABEL[r].slice(0, 5).padEnd(5))} ${fit(S.cyan(name ?? ''), 18)} ${fit(reasoning, 14)} ${fit(state, 11)} ${atts.length ? usd(spent) : ''}`, cols)
      : fit(` ${S.bold(ROLE_LABEL[r].padEnd(10))} ${fit(S.cyan(name ?? ''), 26)} ${fit(reasoning, 18)} ${fit(state, 13)} ${fit(job, 32)} ${atts.length ? usd(spent) : ''}`, cols)
  }

  private hudLines(cols: number): string[] {
    const m = this.mission; const live = m.live; const c = live.counters
    const turns = this.transcript.filter(e => e.role === 'user').length
    const turnLive = this.turn ? live.tasks[this.turn.id] ?? null : null
    const phase = this.turn ? (turnLive ? `${this.turn.id} ${turnLive.state}${turnLive.attempts.at(-1) ? ` · attempt ${turnLive.attempts.at(-1)?.n} ${turnLive.attempts.at(-1)?.phase}` : ''}` : `${this.turn.id} finishing`) : 'ready'
    const elapsed = this.turn ? ` ${Math.round((Date.now() - this.turn.startedAt) / 1000)}s` : ''
    const bar = (done: number, total: number, n = 18): string => { const f = total ? Math.round((done / total) * n) : 0; return S.green('█'.repeat(f)) + S.gray('░'.repeat(n - f)) }
    // live tasks plus the most recent archive pages: finished work keeps its confirmed figures
    const records = [...this.taskRecords()].map(([, t]) => t).sort((x, y) => x.createdAt - y.createdAt)
    const lastTask = records.filter(t => t.attempts.length).at(-1)
    const gates = lastTask?.attempts.at(-1)?.gates ?? []
    const gateText = gates.length ? gates.map(g => `${g.name} ${g.state === 'pass' ? S.green('✓') : S.red('✗')}`).join('  ') : S.gray('no gates run yet')
    const mainGates = live.finalGates.length ? live.finalGates.map(g => `${g.name} ${g.state === 'pass' ? S.green('✓') : S.red('✗')}`).join(' ') : S.gray('—')
    const sess = live.session; const budget = m.config.budgets.sessionUsd
    const spend = sess.unmetered ? S.red('UNMETERED') : `${usd(sess.spentUsd)}${(sess.estimatedTasks ?? []).length ? S.yellow(' (part estimated)') : ''}`
    const guard = [...live.alerts].reverse().find(a => /HELD|refused|policy|budget|unmetered|tampered|outside|not allowed|gates are defined/i.test(a))
    const claims = listClaims(m.header.commonDir).claims
    // queued work, by the role the router will give it (the route is a pure function of the task)
    const queuedFor = new Map<Role, TaskRecord[]>()
    for (const t of Object.values(live.tasks)) if (t.state === 'queued') { const r = m.route(t); if (r.role) queuedFor.set(r.role, [...(queuedFor.get(r.role) ?? []), t]) }
    const st = statusOf(live)
    const stText = st.outcome === 'VERIFIED' ? S.green(st.label) : st.lifecycle === 'BLOCKED' || st.outcome === 'FAILED' || st.outcome === 'BLOCKED' ? S.red(st.label) : st.lifecycle === 'FINISHED' ? S.yellow(st.label) : st.lifecycle === 'READY' ? S.gray(st.label) : S.green(st.label)
    const title = ` ${S.bold(S.blue('◆ COBALT COCKPIT'))} ${S.bold('· CLINE')}  ${S.gray(m.header.id)}  ${S.gray(`${m.header.profile} · ${m.header.strict ? 'strict' : 'non-strict'} · Cline ${m.header.clineVersion}`)}`
    const status = `${stText}${this.busy ? S.gray(`  ${phase}${elapsed}`) : ''}`
    // milestones of the current (or last) turn: its tasks in order, with their real states
    const turnId = this.turn?.id ?? (this.transcript.filter(e => e.role === 'user').at(-1)?.turn ?? null)
    const glyph = (t: TaskRecord): string => t.state === 'completed' ? S.green('✓') : t.state === 'failed' ? S.red('✗') : t.state === 'held' ? S.red('■') : t.state === 'refused' || t.state === 'cancelled' ? S.yellow('⊘') : (t.retryAt ?? 0) > Date.now() ? S.yellow('⟳') : t.attempts.some(a => a.phase !== 'ended') ? S.green('●') : S.gray('○')
    const milestones = turnId ? records.filter(t => t.spec.id === turnId || t.spec.id.startsWith(`${turnId}.`)).map(t => `${glyph(t)} ${t.spec.id}`) : []
    const all = records
    const agents = { running: st.counts.running, queued: all.filter(t => t.state === 'queued').length, retrying: st.counts.retrying, blocked: st.counts.held, completed: c.completed, failed: c.failed, refused: c.refused }
    const owned = Object.values(live.tasks).filter(t => t.attempts.some(a => a.phase !== 'ended')).flatMap(t => t.spec.mode === 'write' ? t.spec.owned : []).slice(0, 4)
    const rule = (ch: string): string => fit(S.gray(` ${ch.repeat(Math.max(0, cols - 2))}`), cols)
    const rows = this.out.rows ?? 40
    const compact = rows < 30
    const lines = [
      fit(`${title}   ${status}`, cols),
      ...(compact ? [] : [fit(` ${S.gray('repo')} ${m.header.repoRoot}  ${S.gray('branch')} ${live.integration.branch} @ ${live.integration.head.slice(0, 8)}  ${S.gray('ownership')} ${claims.length} claim(s)${owned.length ? ` ${owned.join(', ')}` : ''}`, cols), rule('─')]),
      ...ROLES.map(r => this.roleRow(r, records, queuedFor, cols)),
      rule('─'),
      fit(` ${S.bold('AGENTS')}   running ${agents.running} · queued ${agents.queued} · retrying ${agents.retrying} · blocked ${agents.blocked} · completed ${agents.completed} · failed ${agents.failed} · refused ${agents.refused}`, cols),
      fit(` ${S.bold('PROGRESS')} ${bar(c.completed, c.created)} ${c.completed}/${c.created} verified+integrated · ${turns} turn(s)${milestones.length ? `  ${milestones.slice(-8).join('  ')}` : ''}`, cols),
      fit(` ${S.bold('GATES')}    last task: ${gateText}   ${S.gray('branch:')} ${mainGates}`, cols),
      fit(` ${S.bold('SPEND')}    ${spend} of $${budget.toFixed(2)} ${bar(sess.spentUsd, budget, 12)} · ${Math.round(sess.tokens / 100) / 10}k tokens${sess.capReached ? S.red(' · CAP REACHED') : ''}`, cols),
      fit(` ${S.bold('GUARD')}    ${guard ? S.yellow(guard) : S.gray('no alerts')}`, cols),
      rule('═'),
    ]
    return lines
  }

  render(): void {
    const cols = Math.max(60, this.out.columns ?? 120); const rows = Math.max(20, this.out.rows ?? 40)
    let frame: string[]
    if (this.overlay) {
      const mc = missionControl(this.mission.header, this.mission.live, listClaims(this.mission.header.commonDir).claims, Date.now(), cols).split('\n')
      frame = [...mc.slice(0, rows - 2).map(l => fit(l, cols))]
      while (frame.length < rows - 2) frame.push(' '.repeat(cols))
      frame.push(fit(S.inv(' MISSION CONTROL · Tab or Esc returns to the conversation '), cols))
    } else {
      const hud = this.hudLines(cols)
      const bodyRows = rows - hud.length - 3
      const body: string[] = []
      for (const l of this.view) for (const w of wrap(l.text, cols - 1)) body.push(fit(l.style ? S[l.style](w) : w, cols))
      const end = Math.max(0, body.length - this.scroll); const start = Math.max(0, end - bodyRows)
      const shown = body.slice(start, end)
      while (shown.length < bodyRows) shown.unshift(' '.repeat(cols))
      const hint = this.notice ?? (this.busy ? 'Esc cancels the turn · Tab mission control · /help' : 'Enter sends · Tab mission control · /help · Ctrl-D quits')
      frame = [...hud, ...shown, fit(S.gray(` ${hint}${this.scroll ? ` · scrolled ${this.scroll}` : ''}`), cols)]
    }
    const inputRow = `${S.bold(S.blue(' cockpit ❯ '))}${this.input.replace(/\n/g, '↵')}`
    frame.push(fit(inputRow, cols))
    while (frame.length < rows) frame.push(' '.repeat(cols))
    this.out.write(`${ESC}?25l${ESC}H${frame.slice(0, rows).map(l => `${l}${ESC}K`).join('\r\n')}${ESC}${rows};${Math.min(cols, 12 + this.cursor)}H${ESC}?25h`)
    if (process.env.COCKPIT_SHELL_FRAME) { const f = process.env.COCKPIT_SHELL_FRAME; writeFileSync(`${f}.tmp`, frame.map(stripAnsi).join('\n')); renameSync(`${f}.tmp`, f) }
    this.dirty = false
  }

  private teardown(): void {
    if (this.timer) clearInterval(this.timer)
    try { this.inp.setRawMode?.(false) } catch { /* not a tty */ }
    this.out.write(`${ESC}?2004l${ESC}?1049l${ESC}?25h`)
  }

  async start(): Promise<void> {
    if (!this.inp.isTTY || !this.out.isTTY) throw new Error('the interactive shell needs a terminal; use `cockpit-cline run` for scripts')
    this.out.write(`${ESC}?1049h${ESC}2J${ESC}?2004h`)
    this.inp.setRawMode?.(true); this.inp.resume()
    this.inp.on('data', (b: Buffer) => this.onKey(b))
    this.out.on('resize', () => { this.dirty = true })
    process.on('SIGTERM', () => { void this.quit() })
    process.on('exit', () => { try { this.inp.setRawMode?.(false) } catch { /* ignore */ } })
    this.timer = setInterval(() => { if (this.dirty || this.busy || this.overlay) this.render() }, 120)
    try { await this.openMission() } catch (e) { this.teardown(); throw e }
    this.system('type a request to start, or /help', 'dim')
    this.render()
  }
}

