// The interactive Cobalt Cockpit for Cline: a full-screen terminal with a persistent HUD, a
// conversation transcript and an input line. Every message typed here becomes one supervised
// task in a long-lived conversation mission: routed by the router, run as a sandboxed `cline`
// worker, verified by the supervisor's gates and integrated on the mission branch. Nothing in
// the HUD is synthesised: every figure is read from the mission's live state.
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { join } from 'node:path'
import { ROLES } from './core/engine.ts'
import type { Role } from './core/engine.ts'
import type { Config } from './config.ts'
import type { Resolution } from './catalog.ts'
import { Mission, missionDir } from './supervisor.ts'
import type { AttemptRecord, Deps, Header, Live, TaskRecord } from './supervisor.ts'
import type { GateSpec } from './gates.ts'
import { breakStaleLock, listClaims, readJson, tryLock, unlock } from './store.ts'
import { classifyTurn, turnContext, turnRequest } from './turn.ts'
import type { Entry } from './turn.ts'
import { routeTask } from './router.ts'
import { plannerPrompt } from './planner.ts'
import { repoInfo } from './git.ts'
import { Paint, Screen, colorMode, fit, holdIncomplete, money, moneyOf, reducedMotion, sanitize, stripAnsi, vlen, wrap } from './ui/term.ts'
import type { Token } from './ui/term.ts'
import { LedgerTail, Timeline } from './ui/timeline.ts'
import { buildView, costKnown } from './ui/model.ts'
import type { View } from './ui/model.ts'
import { TABS, hudLines, missionControlLines } from './ui/render.ts'
import type { OverlayState, Tab } from './ui/render.ts'

export { stripAnsi }
const ESC = '\x1b['
/** A bracketed paste with no data for this long is over, even if its end marker was lost. */
const PASTE_IDLE_MS = 2000
/** A lone Esc is held this long in case it is the start of a key sequence or paste marker split across reads. */
const ESC_IDLE_MS = 200
/** A gap between screen ticks longer than this means the event loop was busy: input may be waiting unread. */
const LAG_MS = 500

// ---------------------------------------------------------------------------
// Conversation state
/** Transcript line styles, drawn with the Cobalt tokens. */
const STYLE: Record<string, Token | 'bold'> = { bold: 'bold', dim: 'label', gray: 'label', cyan: 'head', green: 'ok', yellow: 'warn', red: 'fail', magenta: 'accent', blue: 'accent' }
type Style = 'bold' | 'dim' | 'gray' | 'cyan' | 'green' | 'yellow' | 'red' | 'magenta' | 'blue'
type Line = { text: string; style?: Style }
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
  /** Per attempt: the start of an escape sequence its stream chunk ended in, until the next chunk completes it. */
  private escHold = new Map<string, { text: string; tag: string }>()
  /** Inside a bracketed paste that has not ended yet: later reads are pasted text until ESC [201~. */
  private pasting = false
  /** The start of a paste-end marker a read ended in, kept until the next read completes or refutes it. */
  private pasteHold = ''
  /** When the last stdin read arrived: a paste that has been quiet for PASTE_IDLE_MS is over. */
  private pasteAt = 0
  /** The last screen tick: idle time is counted only while ticks run on time (a blocked loop is not a quiet paste). */
  private lastPulse = 0
  /** Bytes to text across reads: a character split between two reads is decoded whole. */
  private decoder = new StringDecoder('utf8')
  // HUD 2.0: the real-event timeline, the ledger it tails, and the frame writer
  private timeline = new Timeline()
  private tail: LedgerTail | null = null
  private screen: Screen
  private paint: Paint
  private motion: boolean
  private tick = 0
  private lastSecond = 0
  private mc: OverlayState = { tab: 'overview', sel: 0, expanded: false, filter: null }
  private mcCount = 0
  private archiveCache: { key: string; recs: TaskRecord[] } = { key: '', recs: [] }

  constructor(readonly o: ShellOptions) {
    this.out = o.output ?? process.stdout
    this.inp = o.input ?? process.stdin
    this.paint = new Paint(colorMode(process.env, !!this.out.isTTY))
    this.motion = !reducedMotion(process.env)
    this.screen = new Screen(this.out)
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
    // the timeline starts from this mission's own ledger (a resumed conversation shows its history)
    this.timeline = new Timeline(); this.tail = new LedgerTail(join(this.mission.dir, 'ledger')); this.archiveCache = { key: '', recs: [] }
    this.pumpLedger()
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
  private system(text: string, style: Style = 'dim'): void {
    const e: Entry = { role: 'system', text, turn: this.turn?.id ?? null, at: new Date().toISOString() }
    if (this.mission) this.record(e)
    this.view.push({ text: `· ${text}`, style }); this.dirty = true
  }

  // ----- worker events: stream text and tool use into the transcript -----------------------------
  private onWorkerEvent(taskId: string, attemptId: string, e: Record<string, unknown>): void {
    // every worker's stream feeds the timeline and its activity, whether or not a turn is shown
    if (this.timeline.worker(taskId, attemptId, e)) this.dirty = true
    if (!this.turn) return
    const ev = (e.event ?? {}) as Record<string, unknown>
    const tag = taskId === this.turn.id ? '' : `[${taskId}] `
    if (e.type === 'agent_event' && ev.type === 'content_start' && ev.contentType === 'text' && typeof ev.text === 'string') {
      // model text never reaches the terminal raw: escape sequences and control characters are dropped
      // an escape sequence split across stream chunks is held until it is complete, then removed whole
      const [ready, pending] = holdIncomplete((this.escHold.get(attemptId)?.text ?? '') + ev.text)
      if (pending) this.escHold.set(attemptId, { text: pending, tag }); else this.escHold.delete(attemptId)
      this.appendText(attemptId, tag, sanitize(ready))
    } else if (e.type === 'agent_event' && ev.type === 'content_start' && ev.contentType === 'tool' && typeof ev.toolName === 'string') {
      const input = (ev.input ?? {}) as Record<string, unknown>
      const what = typeof input.path === 'string' ? input.path.replace(`${this.mission.live.integration.dir}/`, '') : Array.isArray(input.commands) ? String(input.commands[0]).slice(0, 80) : Array.isArray(input.paths) ? `${input.paths.length} file(s)` : ''
      this.view.push({ text: sanitize(`  ${tag}▸ ${ev.toolName} ${what}`.replace(/\/[^ ]*worktrees\/[^/]+\/[^/]+\//, '')), style: 'gray' })
      this.streaming = null
    } else if (e.type === 'run_aborted') {
      this.view.push({ text: sanitize(`  ${tag}■ run aborted: ${String(e.message ?? e.reason ?? '')}`), style: 'yellow' })
    }
    this.dirty = true
  }

  private appendText(attemptId: string, tag: string, clean: string): void {
    if (!this.turn || !clean) return
    this.turn.text += clean
    const last = this.view.at(-1)
    const parts = clean.split('\n')
    if (last && this.streaming === attemptId) { last.text += parts[0]; for (const p of parts.slice(1)) this.view.push({ text: `  ${tag}${p}` }) }
    else for (const [i, p] of parts.entries()) this.view.push({ text: `  ${i === 0 ? tag : ''}${p}` })
    this.streaming = attemptId
  }
  /** A stream that ended on an escape sequence that never completed: the text held behind it is shown, the escape dropped. */
  private flushHeld(): void {
    for (const [attemptId, h] of this.escHold) this.appendText(attemptId, h.tag, sanitize(h.text))
    this.escHold.clear()
  }

  // ----- turns --------------------------------------------------------------------------------------
  private nextTurnId(): string { return `t${this.transcript.filter(e => e.role === 'user').length + 1}` }
  private integratedFiles(): string[] {
    const files = new Set<string>()
    // live and archived tasks: a finished turn's changes count too, but only work that was accepted
    for (const [, t] of this.taskRecords()) if (t.state === 'completed') for (const a of t.attempts) if (a.commit && t.integratedHead) for (const f of a.changes) files.add(f)
    return [...files]
  }

  private async submit(text: string, swarm = false): Promise<void> {
    const id = this.nextTurnId()
    const user: Entry = { role: 'user', text, turn: id, at: new Date().toISOString() }
    // the conversation is background (context); only this turn's own request is routed
    const context = turnContext(this.transcript, this.integratedFiles())
    this.record(user); this.view.push(...this.entryLines(user))
    // text held from a previous turn's stream never flushes into this one
    this.escHold.clear()
    this.turn = { id, lines: [], text: '', startedAt: Date.now(), endedAt: null }
    if (swarm) {
      const r = this.mission.addTask({ id: `${id}.plan`, title: `Commander plan: ${text.slice(0, 80)}`, kind: 'architecture', risk: 'medium', complexity: 4, mode: 'read', owned: ['*'], dependencies: [], prompt: plannerPrompt(turnRequest(text), await this.mission.repoSummary()), ...(context ? { context } : {}), priority: 9, depth: 0, parent: null }, 'interactive /swarm')
      if (!r.ok) { this.system(`${id} refused: ${r.reason}`, 'red'); this.turn = null; this.dirty = true; return }
      this.system(`${id}: commander plans; Cockpit routes each planned task`, 'magenta')
    } else {
      const c = classifyTurn(text, id)
      const r = this.mission.addTask({ ...c.spec, prompt: turnRequest(text), ...(context ? { context } : {}) }, 'interactive')
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
    this.flushHeld()
    let text = this.turn.text.trim()
    if (!text) {
      // nothing was streamed (a provider that sends the answer only at the end): show the final answer
      const final = [...this.taskRecords()].find(([tid]) => tid === id)?.[1].attempts.at(-1)?.resultExcerpt?.trim() ?? ''
      if (final) { text = final; this.view.push(...final.split('\n').map(t => ({ text: `  ${t}` }))) }
    }
    const mine = [...this.taskRecords()].filter(([tid]) => tid === id || tid.startsWith(`${id}.`))
    // an answer whose turn produced nothing accepted is marked, so later turns do not build on it
    const rejected = mine.length > 0 && !mine.some(([, t]) => t.state === 'completed')
    if (text) this.record({ role: 'assistant', text, turn: id, at: new Date().toISOString(), ...(rejected ? { rejected: true } : {}) })
    // a turn the previous session recorded but never handed to the supervisor (it ended first)
    if (!mine.length) this.system(`${id} ✗ not started: the session ended before this turn reached the supervisor; send it again if it is still wanted`, 'yellow')
    for (const [tid, t] of mine) {
      const a = t.attempts.at(-1)
      const gates = (a?.gates ?? []).map(g => `${g.name} ${g.state}`).join(' · ')
      // a cost nobody reported is unknown (—), a partly reported one a lower bound (≥), never $0
      const known = t.attempts.filter(costKnown)
      const cost = known.reduce((s, x) => s + x.charge.usd!, 0)
      const basis = known.some(x => x.charge.basis === 'estimate') ? ' est.' : t.attempts.some(x => !costKnown(x)) ? ' unmetered' : ''
      const ok = t.state === 'completed'
      const integrated = ok && a?.commit && t.integratedHead
      // a completed write turn without changes is reported plainly, not as delivered work
      const noChange = ok && !integrated && t.spec.mode === 'write'
      const changed = integrated ? `integrated ${a.commit?.slice(0, 8)} (${a.changes.length} file(s))` : t.spec.mode === 'read' ? 'read-only' : noChange ? 'NO CHANGES' : 'nothing integrated'
      this.system(`${tid} ${ok ? '✓' : '✗'} ${t.state}${t.reason && !ok ? `: ${t.reason}` : ''} · ${a ? `${a.role} ${a.model}` : 'not started'} · ${changed}${gates ? ` · ${gates}` : ''} · ${moneyOf(cost, known.length, t.attempts.length)}${basis}`, !ok ? 'red' : noChange ? 'cyan' : 'green')
    }
    const v = this.mission.live.verdict
    if (v && v.state !== 'DONE' && v.state !== 'UNVERIFIED') for (const r of v.reasons.slice(0, 3)) this.system(`verdict ${v.state}: ${r}`, 'yellow')
    this.turn.endedAt = Date.now(); this.turn = null
    this.dirty = true
  }

  private *taskRecords(): Generator<[string, TaskRecord]> {
    for (const [id, t] of Object.entries(this.mission.live.tasks)) yield [id, t]
    const seen = new Set(Object.keys(this.mission.live.tasks))
    for (const r of this.archived()) if (!seen.has(r.spec.id)) yield [r.spec.id, r]
  }
  /** The last two archive pages, re-read only when the supervisor archives more tasks (never per frame). */
  private archived(): TaskRecord[] {
    const key = `${this.mission.header.id}:${this.mission.live.counters.archived}`
    if (this.archiveCache.key !== key) {
      const recs: TaskRecord[] = []
      for (const p of this.mission.archive.index().pages.slice(-2)) recs.push(...(this.mission.archive.page(p.n) as TaskRecord[]))
      this.archiveCache = { key, recs }
    }
    return this.archiveCache.recs
  }
  /** New ledger entries become timeline events. */
  private pumpLedger(): boolean {
    const entries = this.tail?.poll() ?? []
    for (const e of entries) this.timeline.ledger(e)
    return entries.length > 0
  }
  private viewModel(): View {
    const lastTurn = this.turn?.id ?? this.transcript.filter(e => e.role === 'user').at(-1)?.turn ?? null
    return buildView({
      header: this.mission.header, live: this.mission.live, records: [...this.taskRecords()].map(([, t]) => t), claims: this.claimsCache.claims,
      config: this.mission.config, resolutions: this.mission.resolutions, committedUsd: this.mission.committedUsd(), activity: this.timeline.activity, turn: lastTurn, now: Date.now(),
      // queued work is shown on the role the router will give it (routing is a pure function of the task)
      predictRole: t => { try { return this.mission.route(t).role ?? null } catch { return null } },
    })
  }

  // ----- commands ------------------------------------------------------------------------------------
  private async command(line: string): Promise<void> {
    const [cmd, ...rest] = line.slice(1).split(' '); const arg = rest.join(' ').trim()
    switch (cmd) {
      case 'cockpit': case 'mc': if (arg) await this.cockpit(arg); else this.overlay = !this.overlay; break
      case 'keys': this.openTab('keys'); break
      case 'help': this.system('Tab Mission Control · /cockpit overview|agents|timeline|routing|gates|costs opens a view · /cockpit ready|doctor checks · /swarm <goal> commander plans · /route <text> explain routing · /models · /keys · /cancel (Esc) · /diff · /new · /quit (Ctrl-D) · PgUp/PgDn scroll', 'cyan'); break
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
        // the old conversation is closed only once it holds nothing; the new one is opened before
        // the old shell lock is released, so a failure leaves the current conversation usable
        const old = { mission: this.mission, lock: this.shellLock, view: this.view, transcript: this.transcript }
        const held = Object.values(old.mission.live.tasks).filter(t => t.state === 'held' || t.attempts.some(a => a.phase !== 'ended'))
        if (held.length) { this.system(`cannot start a new conversation: ${held.length} task(s) still hold ownership (${held.map(t => t.spec.id).join(', ')}); run \`cockpit-cline recover\` first`, 'red'); break }
        this.view = []; this.transcript = []
        try { await this.openMissionFresh() } catch (e) {
          this.mission = old.mission; this.shellLock = old.lock; this.view = old.view; this.transcript = old.transcript
          this.system(`could not start a new conversation: ${(e as Error).message}`, 'red'); break
        }
        const closed = old.mission.closeConversation()
        if (!closed.ok) this.system(`previous conversation ${old.mission.header.id} left open: ${closed.reason}`, 'yellow')
        unlock(old.lock)
        break
      }
      case 'quit': case 'exit': await this.quit(); break
      default: this.system(`unknown command /${cmd}; /help lists them`, 'yellow')
    }
    this.dirty = true
  }
  private openTab(tab: Tab): void {
    this.overlay = true
    if (this.mc.tab !== tab) this.mc = { tab, sel: tab === 'timeline' ? Number.MAX_SAFE_INTEGER : 0, expanded: false, filter: null }
    this.dirty = true
  }
  /** `/cockpit <view>`: opens that Mission Control view; `ready` and `doctor` print their checks. */
  private async cockpit(sub: string): Promise<void> {
    const name = sub.split(' ')[0]
    const alias: Record<string, Tab> = { overview: 'overview', agents: 'agents', timeline: 'timeline', activity: 'timeline', history: 'timeline', routing: 'routing', gates: 'gates', verify: 'gates', verification: 'gates', costs: 'costs', cost: 'costs', keys: 'keys', help: 'keys' }
    if (alias[name]) { this.openTab(alias[name]); return }
    switch (name) {
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
      default: this.system(`unknown /cockpit view "${sub}"; use overview, agents, timeline, routing, gates, costs, keys, ready or doctor`, 'yellow')
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
    if (this.quitting) { this.notice = 'still stopping the running turn: ownership is released only once its sandbox is confirmed gone (a forced kill leaves it for cockpit-cline recover)'; this.dirty = true; return }
    this.quitting = true
    // before the conversation has opened there is no mission to stop or summarise; the exit still happens
    const m = this.mission as Mission | undefined
    try {
      if (this.busy && m) { this.system('stopping the running turn before exit…', 'yellow'); m.requestStop('shell exit'); this.render(); await this.busy }
      unlock(this.shellLock)
      this.teardown()
      this.out.write(m ? `Cobalt Cockpit: conversation ${m.header.id} · branch ${m.live.integration.branch} · ${m.live.session.unmetered ? `≥${money(m.live.session.spentUsd)} (unmetered: the true cost is not known)` : `${money(m.live.session.spentUsd)}${(m.live.session.estimatedTasks ?? []).length ? ' (partly estimated)' : ''}`} spent\n` : 'Cobalt Cockpit: closed before the conversation opened\n')
    } finally { process.exit(0) }
  }

  // ----- keyboard ----------------------------------------------------------------------------------
  private onKey(buf: Buffer): void {
    const chunk = this.decoder.write(buf)
    // a real Ctrl+C or Ctrl+D keypress arrives as a read of its own; the same byte inside pasted text is text
    const lone = chunk === '\x03' || chunk === '\x04'
    let s = this.pasteHold + chunk; this.pasteHold = ''
    this.pasteAt = Date.now()
    const START = '\x1b[200~', END = '\x1b[201~'
    while (s.length) {
      // a paste is text for the request until its end marker, however many reads it spans: its newlines never
      // submit and its escape and control bytes are dropped; it returns to the conversation. A paste whose end
      // marker never comes is ended by a Ctrl+C or Ctrl+D keypress (a read of that byte alone) or by a pause of
      // PASTE_IDLE_MS, so the keyboard can never be lost to it.
      if (this.pasting) {
        const end = s.indexOf(END)
        const ctl = lone ? 0 : -1
        const stop = ctl >= 0 && (end < 0 || ctl < end) ? ctl : end
        let body = stop < 0 ? s : s.slice(0, stop)
        if (stop < 0) { for (let n = Math.min(END.length - 1, body.length); n > 0; n--) if (END.startsWith(body.slice(-n))) { this.pasteHold = body.slice(-n); body = body.slice(0, -n); break } }
        if (body) { this.overlay = false; this.insert(body.replace(/\r\n?/g, '\n')) }
        if (stop < 0) return
        this.pasting = false; s = s.slice(stop === end ? end + END.length : stop); continue
      }
      if (s.startsWith(START)) { this.pasting = true; s = s.slice(START.length); continue }
      // a read that ends inside an escape sequence (a lone Esc, or ESC [ and parameters, which includes a split
      // paste start marker) is kept until the next read completes it, or a pause decides it was a key
      if (/^\x1b(?:\[[0-9;]*)?$/.test(s)) { this.pasteHold = s; return }
      s = this.keys(s, true)
    }
  }
  /** Plain keys. With `one`, dispatches a single key and returns the rest. */
  private keys(s: string, one = false): string {
    while (s.length) {
      // Esc followed by a control key in the same read is two keys (Esc, then e.g. Ctrl-D), never an Alt chord;
      // only Alt+Enter and Alt+printable are chords
      // SS3 keys (F1-F4, some arrows) and Esc+CSI (Alt+arrow on some terminals) are whole sequences, never an Esc key plus text
      const seq = /^(\x1b\x1b\[[0-9;]*[A-Za-z~]|\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b\r|\x1b[\x20-\x7e]|.)/su.exec(s)?.[0] ?? s[0]
      s = s.slice(seq.length)
      this.key(seq)
      if (one) return s
    }
    return s
  }
  /** A paste (or a held start marker) that has gone quiet: what is held is resolved, and the keyboard returns. */
  private settlePaste(now: number): void {
    // after a stall of the event loop, unread input may be waiting: the quiet period starts again
    if (this.lastPulse && now - this.lastPulse > LAG_MS) this.pasteAt = now
    this.lastPulse = now
    const wait = !this.pasting && this.pasteHold === '\x1b' ? ESC_IDLE_MS : PASTE_IDLE_MS
    if ((!this.pasting && !this.pasteHold) || now - this.pasteAt < wait) return
    const held = this.pasteHold; this.pasteHold = ''
    if (this.pasting) { this.pasting = false; if (held) this.insert(held) } else this.keys(held)
    this.dirty = true
  }
  /** UTF-16 units of the character before / after the cursor: an emoji is one character, never half of one. */
  private unitsBefore(): number { const c = this.input.charCodeAt(this.cursor - 1); return this.cursor >= 2 && c >= 0xdc00 && c <= 0xdfff && (this.input.charCodeAt(this.cursor - 2) & 0xfc00) === 0xd800 ? 2 : 1 }
  private unitsAfter(): number { const c = this.input.charCodeAt(this.cursor); return (c & 0xfc00) === 0xd800 && (this.input.charCodeAt(this.cursor + 1) & 0xfc00) === 0xdc00 ? 2 : 1 }
  private insert(raw: string): void { const t = sanitize(raw); this.input = this.input.slice(0, this.cursor) + t + this.input.slice(this.cursor); this.cursor += t.length; this.dirty = true }
  /** Mission Control navigation. Returns false for keys it leaves to the conversation (Ctrl+C, Ctrl+D). */
  private overlayKey(k: string): boolean {
    const tabs = TABS.map(t => t.tab)
    const at = tabs.indexOf(this.mc.tab)
    const go = (tab: Tab): void => { this.mc = { tab, sel: tab === 'timeline' ? Number.MAX_SAFE_INTEGER : 0, expanded: false, filter: null } }
    const last = Math.max(0, this.mcCount - 1)
    const sel = Math.min(this.mc.sel, last)
    switch (k) {
      case '\t': case '\x1b': case 'q': this.overlay = false; return true
      case '\x1b[C': case 'l': go(tabs[(at + 1) % tabs.length]); return true
      case '\x1b[D': case 'h': go(tabs[(at - 1 + tabs.length) % tabs.length]); return true
      case '\x1b[A': case 'k': this.mc.sel = Math.max(0, sel - 1); return true
      case '\x1b[B': case 'j': this.mc.sel = Math.min(last, sel + 1); return true
      case '\x1b[5~': this.mc.sel = Math.max(0, sel - 10); return true
      case '\x1b[6~': this.mc.sel = Math.min(last, sel + 10); return true
      case '\x1b[H': case '\x1b[1~': case 'g': this.mc.sel = 0; return true
      case '\x1b[F': case '\x1b[4~': case 'G': this.mc.sel = last; return true
      case '\r': case '\n': case ' ': this.mc.sel = sel; this.mc.expanded = !this.mc.expanded; return true
      case 'f': if (this.mc.tab === 'timeline') { const order = [null, 'COMMANDER', 'CODER', 'SPECIALIST', 'FRONTEND', 'UTILITY', 'COCKPIT']; this.mc.filter = order[(order.indexOf(this.mc.filter) + 1) % order.length]; this.mc.sel = Number.MAX_SAFE_INTEGER; this.mc.expanded = false } return true
      case '\x03': case '\x04': return false
      default: { const t = TABS.find(x => x.key === k); if (t) go(t.tab); return true }
    }
  }
  private key(k: string): void {
    this.dirty = true
    if (k !== '\x03') this.ctrlC = 0
    if (this.overlay && this.overlayKey(k)) return
    switch (k) {
      case '\r': case '\n': { const line = this.input.trim(); this.input = ''; this.cursor = 0; this.hist = -1; if (line) { this.history.push(line); void this.enter(line) } return }
      case '\x1b\r': this.insert('\n'); return
      case '\x7f': case '\b': if (this.cursor > 0) { const n = this.unitsBefore(); this.input = this.input.slice(0, this.cursor - n) + this.input.slice(this.cursor); this.cursor -= n } return
      case '\x1b[3~': this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + this.unitsAfter()); return
      case '\x1b[D': this.cursor = Math.max(0, this.cursor - this.unitsBefore()); return
      case '\x1b[C': this.cursor = Math.min(this.input.length, this.cursor + this.unitsAfter()); return
      case '\x1b[H': case '\x1b[1~': case '\x01': this.cursor = 0; return
      case '\x1b[F': case '\x1b[4~': case '\x05': this.cursor = this.input.length; return
      case '\x1b[A': if (this.history.length) { this.hist = this.hist < 0 ? this.history.length - 1 : Math.max(0, this.hist - 1); this.input = this.history[this.hist]; this.cursor = this.input.length } return
      case '\x1b[B': if (this.hist >= 0) { this.hist++; if (this.hist >= this.history.length) { this.hist = -1; this.input = '' } else this.input = this.history[this.hist]; this.cursor = this.input.length } return
      case '\x1b[5~': this.scroll += 10; return
      case '\x1b[6~': this.scroll = Math.max(0, this.scroll - 10); return
      case '\x15': this.input = this.input.slice(this.cursor); this.cursor = 0; return
      case '\x0c': this.screen.invalidate(); this.out.write(`${ESC}2J`); return
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
    // an error in one command or turn is reported in the transcript; it never takes the shell down
    try {
      if (line.startsWith('/')) { await this.command(line); return }
      if (this.busy) { this.system('a turn is running; wait for it, or press Esc to cancel it', 'yellow'); return }
      this.scroll = 0
      await this.submit(line)
    } catch (e) {
      if (this.turn && !this.busy) this.turn = null
      this.system(`error: ${(e as Error).message ?? String(e)}`, 'red')
    }
  }

  // ----- rendering -----------------------------------------------------------------------------------
  private bodyCache: { view: Line[] | null; w: number; n: number; lines: string[] } = { view: null, w: 0, n: 0, lines: [] }
  private claimsCache: { at: number; claims: ReturnType<typeof listClaims>['claims'] } = { at: 0, claims: [] }
  private claimsKey = ''
  private styled(l: Line, w: number): string[] {
    const t = l.style ? STYLE[l.style] : undefined
    // transcript text includes model answers, tool paths and replayed history: sanitized before wrapping
    return wrap(sanitize(l.text), w).map(x => fit(t === 'bold' ? this.paint.bold(x) : t ? this.paint.fg(t, x) : x, w))
  }
  /** The transcript wrapped to the width; settled lines are wrapped once, only the streaming tail per frame. */
  private bodyLines(w: number): string[] {
    const c = this.bodyCache
    const stable = Math.max(0, this.view.length - 8)
    if (c.view !== this.view || c.w !== w || c.n > stable) { c.view = this.view; c.w = w; c.n = 0; c.lines = [] }
    for (; c.n < stable; c.n++) c.lines.push(...this.styled(this.view[c.n], w))
    const tail: string[] = []
    for (let i = stable; i < this.view.length; i++) tail.push(...this.styled(this.view[i], w))
    return c.lines.length ? c.lines.concat(tail) : tail
  }
  /** The input line, scrolled so the cursor stays visible; returns the line and the cursor column. */
  private inputLine(w: number): { line: string; col: number } {
    const prompt = `${this.paint.fg('accent', ' cockpit', true)} ${this.paint.fg('head', '❯', true)} `
    const pw = 11
    const shown = this.input.replace(/\n/g, '↵')
    const room = Math.max(4, w - pw - 1)
    const before = vlen(shown.slice(0, this.cursor))
    const offset = before > room - 1 ? before - (room - 1) : 0
    let visible = ''; let seen = 0
    for (const ch of shown) { if (seen >= offset) visible += ch; seen += vlen(ch); if (vlen(visible) >= room) break }
    return { line: fit(`${prompt}${offset ? this.paint.dim('…') : ''}${visible}`, w), col: pw + 1 + before - offset + (offset ? 1 : 0) }
  }

  /** Draws a frame; if building it fails, a minimal frame says so, so the screen never freezes on a stale image. */
  render(): void {
    try { this.renderFrame() } catch (e) {
      const cols = Math.max(1, this.out.columns ?? 80); const rows = Math.max(1, this.out.rows ?? 24); const w = Math.max(1, cols - 1)
      const lines = [fit(this.paint.fg('fail', ` display error: ${sanitize((e as Error)?.message ?? String(e))}`), w), fit(this.paint.dim(' the supervisor keeps running · Ctrl-D quits'), w)]
      while (lines.length < rows) lines.push(' '.repeat(w))
      this.screen.draw(lines.slice(0, rows), cols, rows, { row: rows, col: 1 })
      this.dirty = false
    }
  }
  private renderFrame(): void {
    const cols = Math.max(1, this.out.columns ?? 120); const rows = Math.max(1, this.out.rows ?? 40)
    const w = Math.max(1, cols - 1)
    const input = this.overlay
      ? { line: fit(this.paint.dim(' Mission Control · typing is paused · Tab or Esc returns to the conversation'), w), col: 1 }
      : this.inputLine(w)
    let frame: string[]
    if (!this.mission || cols < 40 || rows < 12) {
      // opening, or too small for any HUD: say so and keep the conversation readable
      const msg = !this.mission ? ' opening the conversation…' : ` Cobalt Cockpit needs 40×12; this terminal is ${cols}×${rows}`
      frame = rows <= 1 ? [] : [fit(this.paint.fg('warn', msg), w), ...(this.mission ? this.bodyLines(w).slice(-Math.max(0, rows - 3)) : []), fit(this.paint.dim(' Ctrl-D quits'), w)].slice(-(rows - 1))
      while (frame.length < rows - 1) frame.unshift(' '.repeat(w))
    } else {
      if (this.claimsCache.at < Date.now() - 1000) this.claimsCache = { at: Date.now(), claims: listClaims(this.mission.header.commonDir).claims }
      const view = this.viewModel()
      const f = { cols, rows, paint: this.paint, motion: this.motion, tick: this.tick }
      if (this.overlay) {
        const mc = missionControlLines(this.mc, view, this.timeline.events, f)
        this.mcCount = mc.count
        frame = mc.lines
      } else {
        let hud = hudLines(view, this.timeline.events, f)
        if (hud.length > rows - 6) hud = [...hud.slice(0, rows - 7), hud.at(-1) as string]
        const bodyRows = rows - hud.length - 2
        const body = this.bodyLines(w)
        this.scroll = Math.min(this.scroll, Math.max(0, body.length - bodyRows))
        const end = Math.max(0, body.length - this.scroll); const start = Math.max(0, end - bodyRows)
        const shown = body.slice(start, end)
        while (shown.length < bodyRows) shown.unshift(' '.repeat(w))
        const hint = this.notice ?? (this.busy ? 'Esc cancels the turn · Tab mission control · /keys' : 'Enter sends · Tab mission control · /keys · Ctrl-D quits')
        frame = [...hud, ...shown, fit(this.paint.dim(` ${hint}${this.scroll ? ` · scrolled ${this.scroll} (PgDn)` : ''}`), w)]
      }
    }
    frame.push(input.line)
    while (frame.length < rows) frame.push(' '.repeat(w))
    this.screen.draw(frame, cols, rows, { row: rows, col: input.col })
    // test and evidence capture only: the frame as text, and (separately) with its styling
    if (process.env.COCKPIT_SHELL_FRAME) { const fl = process.env.COCKPIT_SHELL_FRAME; writeFileSync(`${fl}.tmp`, frame.slice(0, rows).map(stripAnsi).join('\n')); renameSync(`${fl}.tmp`, fl) }
    if (process.env.COCKPIT_SHELL_FRAME_ANSI) { const fl = process.env.COCKPIT_SHELL_FRAME_ANSI; writeFileSync(`${fl}.tmp`, frame.slice(0, rows).join('\n')); renameSync(`${fl}.tmp`, fl) }
    this.dirty = false
  }
  /** One timer drives the screen: new ledger entries, the spinner (unless reduced motion) and the clocks. */
  private pulse(): void {
    this.settlePaste(Date.now())
    if (!this.mission) return
    if (this.pumpLedger()) this.dirty = true
    // ownership changes outside the ledger's rhythm (a claim retired after the last event): re-read each
    // second and repaint when it changed, so an idle screen never shows a claim that no longer exists
    if (this.claimsCache.at < Date.now() - 1000) {
      const claims = listClaims(this.mission.header.commonDir).claims
      const key = claims.map(c => `${c.missionId}/${c.taskId}#${c.attempt}:${c.state}`).join(',')
      if (key !== this.claimsKey) { this.claimsKey = key; this.dirty = true }
      this.claimsCache = { at: Date.now(), claims }
    }
    const running = Object.values(this.mission.live.tasks).some(t => t.attempts.some(a => a.phase !== 'ended'))
    if (this.motion && (running || this.busy)) { this.tick++; this.dirty = true }
    const sec = Math.floor(Date.now() / 1000)
    if (sec !== this.lastSecond) { this.lastSecond = sec; if (this.busy || running) this.dirty = true }
    if (this.dirty) this.render()
  }

  private torn = false
  /** Gives the terminal back exactly as it was: main screen, cursor, autowrap, no paste mode. Safe to call twice. */
  private teardown(): void {
    if (this.timer) clearInterval(this.timer)
    try { this.inp.setRawMode?.(false) } catch { /* not a tty */ }
    if (this.torn) return
    this.torn = true
    try { this.out.write(`${ESC}?2026l${ESC}?7h${ESC}?2004l${ESC}?1049l${ESC}?25h`) } catch { /* terminal gone */ }
  }

  async start(): Promise<void> {
    if (!this.inp.isTTY || !this.out.isTTY) throw new Error('the interactive shell needs a terminal; use `cockpit-cline run` for scripts')
    // alternate screen, bracketed paste, and no autowrap: a miscounted wide character can never wrap a row
    this.out.write(`${ESC}?1049h${ESC}2J${ESC}?2004h${ESC}?7l`)
    try { this.inp.setRawMode?.(true) } catch (e) { this.teardown(); throw e }
    this.inp.resume()
    this.inp.on('data', (b: Buffer) => this.onKey(b))
    // a resize repaints the whole screen once (the writer clears on a size change); before the
    // conversation is open render() draws only an "opening" line, and it never throws
    this.out.on('resize', () => { this.screen.invalidate(); this.dirty = true; this.render() })
    process.on('SIGTERM', () => { void this.quit() })
    process.on('SIGINT', () => { void this.quit() })
    process.on('SIGQUIT', () => { void this.quit() })
    // a crash leaves the alternate screen first, so its message is visible; sandboxes die with this process
    // and any ownership they held stays recorded for cockpit-cline recover
    process.on('uncaughtException', e => { this.teardown(); try { process.stderr.write(`cockpit-cline: internal error: ${sanitize((e as Error)?.stack ?? String(e))}\n`) } finally { process.exit(1) } })
    // a closed terminal stops the running turn the same way /quit does
    process.on('SIGHUP', () => { void this.quit() })
    process.on('unhandledRejection', e => { this.system(`internal error: ${(e as Error)?.message ?? String(e)}`, 'red') })
    // however the process ends, the terminal is restored
    process.on('exit', () => this.teardown())
    this.timer = setInterval(() => { try { this.pulse() } catch (e) { this.notice = `render error: ${(e as Error).message}` } }, 120)
    try { await this.openMission() } catch (e) { this.teardown(); throw e }
    this.system('type a request to start, or /help', 'dim')
    this.render()
  }
}
