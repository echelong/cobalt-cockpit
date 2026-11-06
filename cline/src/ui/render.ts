// HUD 2.0 rendering: pure functions from the view model to screen lines. Every line is fitted to
// the width (one column short of the terminal, so nothing ever auto-wraps). The design language is
// the Claude Code Cockpit's: numbered dossier sections, `NAME / VALUE` labels, red for activity,
// amber for waiting, green for completed, deep red for failure, cyan only for scanning and checks.
import type { Paint, Token } from './term.ts'
import { bar, duration, fit, midcut, money, moneyOf, right, sanitize, shortName, spinner, spread, tokens, vlen, wave, wrap } from './term.ts'
import type { AgentState, AttemptView, CostRow, GateState, GateView, ReasoningView, RoleView, View } from './model.ts'
import { ROLE_LABEL } from './model.ts'
import type { TimelineEvent } from './timeline.ts'
import { glyphOf } from './timeline.ts'

export type Frame = { cols: number; rows: number; paint: Paint; motion: boolean; tick: number }
export type Tab = 'overview' | 'agents' | 'timeline' | 'routing' | 'gates' | 'costs' | 'keys'
export const TABS: { tab: Tab; key: string; label: string }[] = [
  { tab: 'overview', key: '1', label: 'OVERVIEW' }, { tab: 'agents', key: '2', label: 'AGENTS' }, { tab: 'timeline', key: '3', label: 'TIMELINE' },
  { tab: 'routing', key: '4', label: 'ROUTING' }, { tab: 'gates', key: '5', label: 'VERIFY' }, { tab: 'costs', key: '6', label: 'COSTS' }, { tab: 'keys', key: '?', label: 'KEYS' },
]
export type OverlayState = { tab: Tab; sel: number; expanded: boolean; filter: string | null }

// ----- vocabulary ------------------------------------------------------------------------------------
const STATE_TOKEN: Record<AgentState, Token> = { running: 'accent', verifying: 'scan', retrying: 'warn', waiting: 'warn', queued: 'label', blocked: 'fail', completed: 'ok', failed: 'fail', cancelled: 'warn', refused: 'warn', idle: 'label', unavailable: 'fail' }
const STATE_GLYPH: Record<AgentState, string> = { running: '●', verifying: '◆', retrying: '⟳', waiting: '…', queued: '◌', blocked: '■', completed: '✓', failed: '✗', cancelled: '⊘', refused: '⊘', idle: '·', unavailable: '!' }
const GATE_TOKEN: Record<GateState, Token> = { pass: 'ok', fail: 'fail', pending: 'scan', skipped: 'label', unverifiable: 'warn', unset: 'label' }
const GATE_GLYPH: Record<GateState, string> = { pass: '✓', fail: '✗', pending: '◌', skipped: '–', unverifiable: '?', unset: '·' }
const GATE_WORD: Record<GateState, string> = { pass: 'PASS', fail: 'FAIL', pending: 'PENDING', skipped: 'SKIPPED', unverifiable: 'UNVERIFIABLE', unset: 'NOT RUN' }
const REASON_MARK: Record<ReasoningView['status'], [string, Token]> = { confirmed: ['✓', 'ok'], mismatch: ['✗', 'fail'], unconfirmed: ['?', 'warn'], inferred: ['~', 'warn'], pending: ['◌', 'label'], unobserved: ['?', 'label'] }
const SHORT_ROLE: Record<string, string> = { COMMANDER: 'CMDR', CODER: 'CODER', SPECIALIST: 'SPEC', FRONTEND: 'FRONT', UTILITY: 'UTIL', COCKPIT: 'CKPT' }

const glyphFor = (s: AgentState, f: Frame): string => s === 'running' ? spinner(f.tick, f.motion) : STATE_GLYPH[s]
export const reasoningText = (r: ReasoningView, p: Paint): string => {
  // nothing sent yet: the requested level and an honest "?", no verdict mark
  if (r.status === 'unobserved') return `${p.fg('head', r.requested)}${p.dim('→?')}`
  const [m, t] = REASON_MARK[r.status]
  return `${p.fg('head', r.requested)}${p.dim('→')}${p.fg(t, `${r.effective} ${m}`)}`
}
/** A model's family from its id, for compact spend lists: moonshotai/kimi-k3.1-pro → kimi. */
const family = (model: string): string => (model.split('/').pop() ?? model).split(/[-_]/)[0]
const clock = (ms: number): string => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':') }
const costText = (usd: number | null, basis: string | null, p: Paint): string => basis === 'unmetered' && usd === null ? p.fg('warn', 'unmetered') : usd === null ? p.dim('—') : basis === 'estimate' ? p.fg('warn', `~${money(usd)}`) : p.fg('head', money(usd))
const tokText = (i: number | null, o: number | null, p: Paint): string => i === null ? p.dim('—') : `${p.fg('head', tokens(i))}${p.dim('/')}${p.fg('head', tokens(o))}`

/** `01 SECTION / NAME ────` in the dossier grammar, with optional right-hand text. */
export const heading = (index: string, name: string, w: number, p: Paint, extra = ''): string => {
  const title = `${p.dim(index)} ${p.fg('head', name, true)}`
  const tail = extra ? ` ${extra}` : ''
  const rule = Math.max(0, w - vlen(title) - vlen(tail) - 2)
  return fit(`${title} ${p.fg('rule', '─'.repeat(rule))}${tail}`, w)
}
const field = (name: string, value: string, w: number, p: Paint, nameW = 10): string => fit(` ${p.dim(name.padEnd(nameW))}${value}`, w)

const statusPill = (v: View, p: Paint): string => {
  const st = v.mission.status
  const t: Token = st.lifecycle === 'RUNNING' ? 'accent' : st.lifecycle === 'VERIFYING' ? 'scanFill' : st.lifecycle === 'BLOCKED' ? 'failFill'
    : st.lifecycle === 'FINISHED' ? (st.outcome === 'VERIFIED' ? 'okFill' : st.outcome === 'FAILED' || st.outcome === 'BLOCKED' ? 'failFill' : 'warnFill')
    : st.lifecycle === 'READY' ? 'idleFill' : 'warnFill'
  return p.pill(t, st.label)
}

// ----- header ------------------------------------------------------------------------------------------
export const headerLines = (v: View, f: Frame, compact: boolean): string[] => {
  const p = f.paint; const w = f.cols - 1; const m = v.mission
  const brand = `${p.fg('accent', '◆', true)} ${p.fg('head', 'COBALT COCKPIT', true)} ${p.dim('/')} ${p.fg('accent', 'CLINE', true)}`
  const orch = m.orchestrating ? `  ${p.fg('accent', `◈ KIMI ORCHESTRATING ${m.orchestrating.task}`, true)}` : ''
  const spend = v.cost.unmetered ? p.fg('warn', 'UNMETERED') : `${p.fg('head', money(v.cost.spent))}${p.dim(` / $${v.cost.budget.toFixed(2)}`)}`
  const rightSide = `${p.dim(duration(v.now - m.startedAt))}  ${spend}`
  const line1 = spread(`${brand}  ${statusPill(v, p)}${orch}${w >= 110 ? `  ${p.dim(m.id)}` : ''}`, rightSide, w)
  if (compact) return [line1]
  const own = m.claims.length ? `${m.claims.length} claim(s) ${m.claims.slice(0, 3).flatMap(c => c.owned).join(', ')}` : 'none held'
  const line2 = fit(` ${p.dim('REPO')} ${p.fg('head', midcut(m.repo.replace(process.env.HOME ?? '\u0000', '~'), Math.max(16, Math.floor(w / 3))))}  ${p.dim('BRANCH')} ${p.fg('head', m.branch)}${p.dim('@')}${p.fg('head', m.head.slice(0, 8))}  ${p.dim('PROFILE')} ${p.fg('head', `${m.profile} · ${m.strict ? 'strict' : 'non-strict'}`)}  ${p.dim('CLINE')} ${p.fg('head', m.clineVersion)}  ${p.dim('OWNERSHIP')} ${p.fg('head', own)}`, w)
  return [line1, line2]
}

// ----- swarm ---------------------------------------------------------------------------------------------
/** Swarm column widths for a width: shared by the header and every row so they always line up. */
const swarmCols = (w: number): { name: number; via: number; reason: number; state: number; tail: boolean; act: number } => {
  if (w >= 120) {
    const name = w >= 150 ? 28 : 26; const via = w >= 150 ? 7 : 0
    const fixed = 2 + 11 + name + via + 16 + 12 + 1 + 28
    return { name, via, reason: 16, state: 12, tail: true, act: Math.max(10, w - fixed) }
  }
  if (w >= 80) return { name: w >= 96 ? 26 : 21, via: 0, reason: 15, state: 11, tail: false, act: Math.max(8, w - (2 + 11 + (w >= 96 ? 26 : 21) + 15 + 11 + 1 + 9)) }
  return { name: 17, via: 0, reason: 13, state: 10, tail: false, act: 0 }
}
export const roleRow = (r: RoleView, f: Frame, w: number): string => {
  const p = f.paint
  const tk = STATE_TOKEN[r.state]
  const c = swarmCols(w)
  const mark = p.fg(tk, glyphFor(r.state, f), r.state === 'running')
  const star = r.isDefault ? p.fg('accent', ' ★') : ''
  const name = p.fg('head', shortName(r.name, c.name - (r.isDefault ? 3 : 1)))
  const state = p.fg(tk, r.stateText, r.state === 'running' || r.state === 'blocked' || r.state === 'failed')
  const task = r.task ? `${p.fg('head', r.task)} ${p.dim('·')} ` : ''
  const live = r.state === 'running' && f.motion ? `${p.fg('accent', wave(f.tick, 5))} ` : ''
  const esc = r.escalatedFrom ? p.fg('accent', ` ⇧ from ${ROLE_LABEL[r.escalatedFrom].toLowerCase()}`) : ''
  const activity = `${live}${task}${p.dim(r.activity)}${esc}`
  if (w >= 80) {
    const via = c.via ? fit(p.dim(r.provider), c.via) : ''
    const head = `${mark} ${fit(p.fg('head', r.label, true), 11)}${fit(name + star, c.name)}${via}${fit(reasoningText(r.reasoning, p), c.reason)}${fit(state, c.state)}${fit(activity, c.act)} `
    const tail = c.tail ? `${right(tokText(r.tokensIn, r.tokensOut, p), 10)} ${right(costText(r.usd, r.basis, p), 9)} ${right(p.dim(r.elapsedMs === null ? '' : duration(r.elapsedMs)), 7)}` : right(costText(r.usd, r.basis, p), 9)
    return fit(head + tail, w)
  }
  // narrow: the essentials, then whatever activity fits
  const label = fit(p.fg('head', SHORT_ROLE[r.label] ?? r.label, true), 6)
  const base = `${mark} ${label}${fit(name + star, c.name)}${fit(reasoningText(r.reasoning, p), c.reason)}${fit(state, c.state)}`
  return fit(`${base}${w - vlen(base) > 8 ? ` ${p.dim(r.task ?? '')}` : ''}`, w)
}
export const swarmLines = (v: View, f: Frame, withHeading: boolean): string[] => {
  const p = f.paint; const w = f.cols - 1
  const running = v.roles.filter(r => r.state === 'running').length; const queued = v.roles.reduce((s, r) => s + r.queued, 0)
  const out: string[] = []
  if (withHeading) {
    out.push(heading('01', 'SWARM / FIVE MODELS', w, p, `${p.fg(running ? 'accent' : 'label', `${running} running`)}${p.dim(` · ${queued} queued · ${v.mission.counters.completed}/${v.mission.counters.created} done`)}`))
    const c = swarmCols(w)
    if (c.tail) out.push(fit(p.dim(`  ${'ROLE'.padEnd(11)}${'MODEL'.padEnd(c.name)}${c.via ? 'VIA'.padEnd(c.via) : ''}${'REASONING'.padEnd(c.reason)}${'STATE'.padEnd(c.state)}${'TASK / ACTIVITY'.padEnd(c.act)} ${'TOKENS'.padStart(10)} ${'COST'.padStart(9)} ${'TIME'.padStart(7)}`), w))
  }
  for (const r of v.roles) out.push(roleRow(r, f, w))
  return out
}

// ----- verification and spend ------------------------------------------------------------------------------
export const gateRow = (g: GateView, w: number, p: Paint): string => {
  const tk = GATE_TOKEN[g.state]
  return fit(` ${fit(p.fg('head', g.name, true), 9)}${p.fg(tk, `${GATE_GLYPH[g.state]} ${GATE_WORD[g.state].padEnd(13)}`, g.state === 'fail')}${p.dim(g.summary)}`, w)
}
const outcomeLine = (v: View, w: number, p: Paint): string => {
  const st = v.mission.status; const verdict = v.mission.verdict
  const word = st.lifecycle === 'FINISHED' ? st.label : `${st.lifecycle} · no verdict yet`
  const tk: Token = st.outcome === 'VERIFIED' ? 'ok' : st.outcome === 'FAILED' || st.outcome === 'BLOCKED' ? 'fail' : st.lifecycle === 'FINISHED' ? 'warn' : 'label'
  const why = verdict && st.lifecycle === 'FINISHED' ? (verdict.reasons[0] ?? '') : 'an ended run is not a verified task'
  return field('OUTCOME', `${p.fg(tk, word, true)} ${p.dim(why)}`, w, p, 9)
}
export const spendLines = (v: View, w: number, p: Paint): string[] => {
  const c = v.cost
  const frac = c.budget > 0 ? c.spent / c.budget : 0
  const b = bar(frac, Math.max(6, Math.min(20, w - 40)))
  const tk: Token = c.capReached ? 'fail' : frac >= 0.8 ? 'warn' : 'ok'
  const inflight = Math.max(0, c.committed - c.spent)
  // a model whose attempts reported nothing reads —, a partly reported one ≥: never an unknown read as $0
  const top = c.byModel.slice(0, 4).map(m => `${family(m.model)} ${m.known > 0 && m.estimated ? '~' : ''}${m.known === 0 && m.unmetered ? 'unmetered' : moneyOf(m.usd, m.known, m.attempts)}`).join(' · ') || 'no spend yet'
  return [
    field('SESSION', `${c.unmetered ? p.fg('warn', 'UNMETERED ') : ''}${p.fg('head', money(c.spent))} ${p.dim(`of $${c.budget.toFixed(2)}`)} ${p.fg(tk, '█'.repeat(b.filled))}${p.fg('rule', '░'.repeat(b.empty))} ${p.dim(`${Math.round(frac * 100)}%`)}`, w, p, 9),
    field('LEFT', `${p.fg('head', money(c.remaining))} ${p.dim(inflight > 0 ? `· ${money(inflight)} reserved for running workers` : '· nothing reserved')}`, w, p, 9),
    field('BASIS', `${c.reported === null || c.estimated === null
      ? `${p.dim('session total includes archived tasks ·')} ${c.estimatedAttempts ? p.fg('warn', `${c.estimatedAttempts} attempt(s) estimated`) : p.fg('head', 'all reported')}`
      : `${p.dim('reported')} ${p.fg('head', money(c.reported))} ${p.dim('· estimated')} ${p.fg(c.estimated > 0 ? 'warn' : 'head', money(c.estimated))}`} ${p.dim('· unmetered')} ${c.unmeteredTasks.length ? p.fg('warn', `${c.unmeteredTasks.length} task(s)`) : p.fg('head', 'none')}`, w, p, 9),
    field(c.coverage.shown < c.coverage.total ? 'RECENT' : 'BY MODEL', p.dim(`${top}${c.coverage.shown < c.coverage.total ? ` (last ${c.coverage.shown} of ${c.coverage.total} tasks)` : ''}`), w, p, 9),
    field('ALERTS', c.capReached ? p.fg('fail', 'SESSION CAP REACHED: admissions stopped', true) : c.alertsFired.length ? p.fg('warn', c.alertsFired.map(x => `${Math.round(x * 100)}% crossed`).join(' · ')) : p.dim('none'), w, p, 9),
  ]
}

// ----- activity --------------------------------------------------------------------------------------------
/** The agent of an event: its attempt's role from the ledger, or the record in view; COCKPIT for mission events. */
const roleOfEvent = (e: TimelineEvent, v: View): string => {
  if (!e.attempt) return 'COCKPIT'
  const r = e.role ?? v.attempts.find(x => x.id === e.attempt)?.role
  return r && r in ROLE_LABEL ? ROLE_LABEL[r as keyof typeof ROLE_LABEL] : '—'
}
export const eventLine = (e: TimelineEvent, v: View, w: number, p: Paint, selected = false): string => {
  const who = roleOfEvent(e, v)
  const whoTk: Token = who === 'COCKPIT' ? 'label' : 'head'
  const task = e.task ? `${e.task}${e.attempt ? '' : ''}` : ''
  const body = `${p.dim(clock(e.at))} ${fit(p.fg(whoTk, w < 80 ? SHORT_ROLE[who] ?? who : who, who !== 'COCKPIT'), w < 80 ? 6 : 11)}${fit(p.dim(task), w < 80 ? 12 : 22)} ${p.fg(e.tone, `${glyphOf(e.kind)} ${e.text}`)}`
  return fit(selected ? `${p.fg('accent', '▸', true)}${body}` : ` ${body}`, w)
}

// ----- the main HUD ------------------------------------------------------------------------------------------
/** The HUD above the conversation, sized to the terminal. Returns its lines; the shell adds the body. */
export const hudLines = (v: View, events: readonly TimelineEvent[], f: Frame): string[] => {
  const p = f.paint; const w = f.cols - 1
  const tall = f.rows >= 40; const mid = f.rows >= 28
  const out: string[] = []
  out.push(...headerLines(v, f, !mid))
  out.push(...swarmLines(v, f, mid))
  if (tall && w >= 120) {
    // two columns: verification and spend side by side
    const half = Math.floor((w - 1) / 2)
    const left = [heading('02', 'VERIFY / GATES', half, p), ...v.gates.map(g => gateRow(g, half, p)), outcomeLine(v, half, p)]
    const rightCol = [heading('03', 'SPEND / BUDGET', w - half - 1, p), ...spendLines(v, w - half - 1, p)]
    for (let i = 0; i < Math.max(left.length, rightCol.length); i++) out.push(`${fit(left[i] ?? '', half)} ${fit(rightCol[i] ?? '', w - half - 1)}`)
  } else if (tall) {
    out.push(heading('02', 'VERIFY / GATES', w, p), ...v.gates.map(g => gateRow(g, w, p)), outcomeLine(v, w, p))
    out.push(heading('03', 'SPEND / BUDGET', w, p), ...spendLines(v, w, p).slice(0, 3))
  } else {
    // one line each: the five gates, and the spend
    const gates = v.gates.map(g => `${p.fg('head', w < 80 ? g.name.slice(0, 4) : g.name)} ${p.fg(GATE_TOKEN[g.state], GATE_GLYPH[g.state])}`).join('  ')
    out.push(fit(` ${p.dim('VERIFY')} ${gates}  ${p.dim('·')} ${(() => { const st = v.mission.status; return p.fg(st.outcome === 'VERIFIED' ? 'ok' : st.lifecycle === 'FINISHED' ? 'warn' : 'label', st.label) })()}`, w))
    const c = v.cost; const b = bar(c.budget ? c.spent / c.budget : 0, 10)
    out.push(fit(` ${p.dim('SPEND')}  ${c.unmetered ? p.fg('warn', 'UNMETERED') : p.fg('head', money(c.spent))} ${p.dim(`of $${c.budget.toFixed(2)}`)} ${p.fg(c.capReached ? 'fail' : 'ok', '█'.repeat(b.filled))}${p.fg('rule', '░'.repeat(b.empty))} ${p.dim(`left ${money(c.remaining)}`)}${(c.estimated ?? 0) > 0 || c.estimatedAttempts > 0 ? p.fg('warn', ' · part estimated') : ''}${c.capReached ? p.fg('fail', ' · CAP REACHED', true) : ''}`, w))
  }
  // the live activity strip: the latest real events
  const strip = tall ? 4 : mid ? 2 : 1
  const recent = events.slice(-strip)
  if (tall) out.push(heading('04', 'ACTIVITY / LIVE', w, p, p.dim(`${events.length} event(s) · Tab → 3 timeline`)))
  for (let i = 0; i < strip; i++) { const e = recent[i - (strip - recent.length)]; out.push(e ? eventLine(e, v, w, p) : fit(i === strip - 1 && !recent.length ? p.dim('  no activity yet') : '', w)) }
  if (v.mission.guard) out.push(fit(` ${p.fg('warn', '⚠ GUARD', true)} ${p.fg('warn', v.mission.guard)}`, w))
  out.push(fit(p.fg('rule', '━'.repeat(w)), w))
  return out
}

// ----- Mission Control --------------------------------------------------------------------------------------------
type Item = { line: (selected: boolean) => string; detail: string[] }
const tabBar = (active: Tab, w: number, p: Paint): string => fit(` ${TABS.map(t => t.tab === active ? p.pill('accent', `${t.key} ${t.label}`) : p.dim(` ${t.key} ${t.label} `)).join(p.fg('rule', '│'))}`, w)
const detailLines = (d: string[], w: number, p: Paint): string[] => d.flatMap(x => wrap(sanitize(x), Math.max(10, w - 6)).map((l, i) => fit(`    ${i === 0 ? p.fg('rule', '│ ') : '  '}${p.dim(l)}`, w)))

const attemptItem = (a: AttemptView, v: View, f: Frame, w: number): Item => {
  const p = f.paint; const tk = STATE_TOKEN[a.state]
  const act = a.activity
  const line = (sel: boolean): string => fit(`${sel ? p.fg('accent', '▸', true) : ' '}${p.fg(tk, glyphFor(a.state, f))} ${fit(p.fg('head', `${a.task}#${a.n}`), Math.min(26, Math.floor(w / 5)))} ${fit(p.fg('head', ROLE_LABEL[a.role], true), 11)}${fit(p.fg('head', midcut(a.model.split('/').pop() ?? a.model, 24)), 25)}${fit(reasoningText(a.reasoning, p), 16)}${fit(p.fg(tk, a.state.toUpperCase()), 11)}${right(tokText(a.tokensIn, a.tokensOut, p), 11)} ${right(costText(a.usd, a.basis, p), 10)} ${right(p.dim(duration(a.elapsedMs)), 7)}  ${p.dim(act?.last ?? (a.failure ? `${a.failure}` : ''))}`, w)
  const tools = Object.entries(a.tools).map(([k, n]) => `${k}×${n}`).join(', ') || 'none reported'
  const detail = [
    `task ${a.task} · ${a.kind}/${a.risk} · ${a.mode} · owns ${a.owned.join(', ')}`,
    `title: ${a.title}`,
    `model ${a.provider}/${a.model} · role ${a.role}`,
    `reasoning requested ${a.reasoning.requested} → effective ${a.reasoning.effective} (${a.reasoning.status}): ${a.reasoning.detail}`,
    `routing: ${a.rules.join('; ')}${a.signals.length ? ` · signals: ${a.signals.join(', ')}` : ''}`,
    `tokens: in ${tokens(a.tokensIn)} (cache read ${tokens(a.cacheRead)}) · out ${tokens(a.tokensOut)} · reasoning ${tokens(a.reasoningTokens)} · cost ${money(a.usd)} (${a.basis})${a.estimateUsd !== null ? ` · reserved estimate ${money(a.estimateUsd)}` : ''}`,
    `phase ${a.phase} · started ${clock(a.startedAt)}${a.endedAt ? ` · ended ${clock(a.endedAt)}` : ''} · ${duration(a.elapsedMs)} · iterations ${a.iterations} · tools ${tools}`,
    act ? `activity: ${act.tools} tool call(s), ${act.edits.size} file(s) edited, ${act.commands} command(s) incl. ${act.tests} test run(s) · last: ${act.last}` : 'activity: no stream events seen by this shell',
    a.changes.length ? `changes: ${a.changes.join(', ')}` : 'changes: none',
    a.gates.length ? `gates: ${a.gates.map(g => `${g.name} ${g.state}${g.exitCode != null ? ` (exit ${g.exitCode})` : ''}`).join(' · ')}` : 'gates: not run',
    a.commit ? `commit ${a.commit.slice(0, 12)}${a.integrated ? ' · integrated' : ' · not integrated'}` : '',
    a.failure ? `failure ${a.failure}: ${a.failureDetail ?? ''}` : '',
    `sandbox: init pid ${a.pid ?? '—'} · census ${a.census ?? 'pending'}${a.worktree ? ` · worktree ${a.worktree}` : ''}`,
    `verification: ${a.verification ?? 'not yet'} (task level; only a DONE verdict reads VERIFIED)`,
    `prompt: ${a.prompt.replace(/\s+/g, ' ').slice(0, 400)}`,
  ].filter(Boolean)
  void v
  return { line, detail }
}

const overviewLines = (v: View, w: number, p: Paint): string[] => {
  const m = v.mission; const c = m.counters; const st = m.status
  const out: string[] = []
  out.push(heading('01', 'MISSION', w, p))
  out.push(field('ID', p.fg('head', m.id), w, p), field('REPO', p.fg('head', m.repo), w, p), field('BRANCH', `${p.fg('head', m.branch)} ${p.dim(`@${m.head.slice(0, 12)} from ${m.base.slice(0, 12)}`)}`, w, p))
  out.push(field('PROFILE', p.fg('head', `${m.profile} · ${m.strict ? 'strict (wire must confirm reasoning)' : 'non-strict'} · Cline ${m.clineVersion}`), w, p))
  out.push(heading('02', 'STATUS', w, p))
  out.push(field('LIFECYCLE', p.fg('head', st.lifecycle, true), w, p), field('OUTCOME', st.outcome ? p.fg(st.outcome === 'VERIFIED' ? 'ok' : 'warn', st.outcome, true) : p.dim('none yet: work is not finished'), w, p))
  if (m.verdict) for (const r of m.verdict.reasons.slice(0, 6)) out.push(field('', p.dim(`· ${r}`), w, p))
  out.push(field('TASKS', `${p.fg('head', String(c.created))} ${p.dim('created ·')} ${p.fg('ok', String(c.completed))} ${p.dim('completed ·')} ${p.fg(c.failed ? 'fail' : 'head', String(c.failed))} ${p.dim('failed ·')} ${p.fg(c.refused ? 'warn' : 'head', String(c.refused))} ${p.dim('refused ·')} ${p.fg(c.cancelled ? 'warn' : 'head', String(c.cancelled))} ${p.dim('cancelled ·')} ${p.fg('head', String(c.attempts))} ${p.dim('attempts')}`, w, p))
  if (m.milestones.length) {
    out.push(heading('03', `TURN / ${m.turn ?? ''}`, w, p))
    for (const t of m.milestones) out.push(fit(`   ${p.fg(STATE_TOKEN[t.state], STATE_GLYPH[t.state])} ${p.fg('head', t.id.padEnd(24))} ${p.fg(STATE_TOKEN[t.state], t.state.toUpperCase().padEnd(11))} ${p.dim(t.title)}`, w))
  }
  out.push(heading('04', 'PROBLEMS / ALERTS', w, p))
  if (!m.problems.length && !m.alerts.length) out.push(field('', p.dim('none recorded'), w, p))
  for (const x of m.problems.slice(-6)) out.push(field('PROBLEM', p.fg('warn', x), w, p))
  for (const x of m.alerts.slice(-6)) out.push(field('ALERT', p.dim(x), w, p))
  out.push(heading('05', 'OWNERSHIP', w, p))
  if (!m.claims.length) out.push(field('', p.dim('no repository claims held'), w, p))
  for (const cl of m.claims.slice(0, 8)) out.push(field(cl.state.toUpperCase(), p.fg('head', `${cl.missionId === m.id ? '' : `${cl.missionId} `}${cl.taskId}#${cl.attempt} ${cl.mode} ${cl.owned.join(', ')}`), w, p))
  return out
}

const routingHead = (v: View, w: number, p: Paint): string[] => {
  const out = [heading('01', 'POLICY / FIXED RULES', w, p)]
  for (const r of v.roles) out.push(fit(`   ${fit(p.fg('head', r.label, true), 11)}${fit(p.fg('head', `${r.provider}/${r.model}`), 42)} ${p.dim('requests')} ${p.fg('head', r.reasoning.requested.padEnd(6))} ${p.dim(r.duty)}${r.isDefault ? p.fg('accent', '  ★ default coder: never replaced for cost') : ''}${r.unresolved ? p.fg('fail', `  UNRESOLVED ${r.unresolved}`) : ''}`, w))
  out.push(fit(`   ${p.dim('Cockpit routes each task on its own request by fixed rules; a refused or missing model is never substituted. Effective reasoning is ✓ only when the wire capture shows it.')}`, w))
  if (v.mission.orchestrating) out.push(fit(`   ${p.fg('accent', `◈ Kimi is orchestrating: ${v.mission.orchestrating.task} attempt ${v.mission.orchestrating.attempt} is planning; Cockpit routes every planned task itself.`, true)}`, w))
  out.push(heading('02', 'DECISIONS', w, p, p.dim('Enter: rules, signals, retries and escalations')))
  return out
}

const gatesHead = (v: View, w: number, p: Paint): string[] => [
  heading('01', 'VERIFY / FIVE GATES', w, p, p.dim('Enter: evidence')),
]
const gatesTail = (v: View, w: number, p: Paint): string[] => [
  heading('02', 'VERDICT', w, p), outcomeLine(v, w, p),
  ...(v.mission.verdict?.reasons.slice(1, 6).map(r => field('', p.dim(`· ${r}`), w, p, 9)) ?? []),
  fit(`   ${p.dim('DONE needs every task verified by the supervisor\'s own gates, the branch gates passing on the integrated head, metered costs and an intact ledger. A worker that ended is not a verified task; a worker\'s own claims are never accepted.')}`, w),
]

const costsHead = (v: View, w: number, p: Paint): string[] => [heading('01', 'SPEND / SESSION', w, p), ...spendLines(v, w, p), heading('02', 'BY MODEL / BY TASK', w, p, p.dim(`${v.cost.coverage.shown < v.cost.coverage.total ? `last ${v.cost.coverage.shown} of ${v.cost.coverage.total} tasks (older ones are archived) · ` : ''}Enter: tokens`))]

const keysLines = (w: number, p: Paint): string[] => {
  const k = (keys: string, what: string): string => fit(`   ${p.fg('head', keys.padEnd(26), true)}${p.dim(what)}`, w)
  return [
    heading('01', 'CONVERSATION', w, p),
    k('Enter', 'send the request as a supervised turn'), k('Alt+Enter', 'new line in the request'), k('↑ / ↓', 'input history'), k('Esc', 'cancel the running turn'),
    k('Ctrl+C', 'clear input · cancel turn · twice: stop and quit'), k('Ctrl+D  /quit', 'quit (a running turn is stopped first)'), k('PgUp / PgDn', 'scroll the conversation'),
    k('/swarm <goal>', 'Kimi plans; Cockpit routes every planned task'), k('/route <text>', 'explain a route without running it'), k('/cockpit <view>', 'open a view: agents, timeline, routing, gates, costs; ready, doctor print checks'),
    k('/models  /diff  /new', 'roles · branch diff · fresh conversation'),
    heading('02', 'MISSION CONTROL', w, p),
    k('Tab', 'open or close Mission Control'), k('← / →   1–6   ?', 'switch view'), k('↑ / ↓   j / k', 'select'), k('Enter / Space', 'expand or collapse details'),
    k('PgUp / PgDn  Home / End', 'page, first, last'), k('f', 'timeline: cycle the agent filter'), k('Esc', 'back to the conversation'),
    heading('03', 'LEGEND', w, p),
    fit(`   ${p.fg('accent', '● running')}  ${p.fg('scan', '◆ verifying')}  ${p.fg('warn', '⟳ retrying  … waiting')}  ${p.dim('◌ queued')}  ${p.fg('fail', '■ blocked  ✗ failed')}  ${p.fg('ok', '✓ done')}  ${p.fg('warn', '⊘ cancelled/refused')}  ${p.fg('accent', '★ default coder')}`, w),
    fit(`   ${p.dim('reasoning')} ${p.fg('ok', '✓ confirmed on the wire')}  ${p.fg('warn', '? unconfirmed  ~ inferred (toggle model)')}  ${p.fg('fail', '✗ mismatch')}  ${p.dim('◌ expected, not yet observed')}`, w),
    fit(`   ${p.dim('costs')} ${p.fg('head', '$ reported by Cline')}  ${p.fg('warn', '~$ estimated from configured pricing')}  ${p.dim('— not reported (never shown as zero)')}`, w),
    fit(`   ${p.dim('Set NO_COLOR=1 for no colour, COCKPIT_REDUCED_MOTION=1 for a static display.')}`, w),
  ]
}

/** Items of the selectable list for a tab, and the fixed lines above and below it. */
export const tabContent = (o: OverlayState, v: View, events: readonly TimelineEvent[], f: Frame): { head: string[]; items: Item[]; tail: string[] } => {
  const p = f.paint; const w = f.cols - 1
  switch (o.tab) {
    case 'overview': return { head: overviewLines(v, w, p), items: [], tail: [] }
    case 'keys': return { head: keysLines(w, p), items: [], tail: [] }
    case 'agents': return { head: [heading('01', 'AGENTS / EVERY ATTEMPT', w, p, p.dim(`${v.attempts.length} attempt(s) · Enter: details`))], items: [...v.attempts].reverse().map(a => attemptItem(a, v, f, w)), tail: [] }
    case 'timeline': {
      const evs = o.filter ? events.filter(e => roleOfEvent(e, v) === o.filter) : events
      return { head: [heading('01', 'TIMELINE / REAL EVENTS', w, p, p.dim(`${evs.length} of ${events.length} · filter ${o.filter ?? 'all'} (f) · Enter: details`))], items: evs.map(e => ({ line: (sel: boolean) => eventLine(e, v, w, p, sel), detail: e.detail.length ? e.detail : ['no further detail recorded'] })), tail: [] }
    }
    case 'routing': {
      const items = [...v.attempts].reverse().map(a => {
        const steps = events.filter(e => e.task === a.task && (e.kind === 'retry' || e.kind === 'correct' || e.kind === 'escalate' || e.kind === 'stop' || e.kind === 'waiting' || e.kind === 'refused'))
        return {
          line: (sel: boolean) => fit(`${sel ? p.fg('accent', '▸', true) : ' '} ${fit(p.fg('head', `${a.task}#${a.n}`), 24)} ${p.dim('→')} ${fit(p.fg('head', ROLE_LABEL[a.role], true), 11)}${fit(p.fg('head', midcut(a.model.split('/').pop() ?? a.model, 24)), 25)}${fit(reasoningText(a.reasoning, p), 16)}${p.dim(a.rules.at(-1) ?? '')}`, w),
          detail: [`rules: ${a.rules.join(' · ')}`, a.signals.length ? `signals read from the task's own request: ${a.signals.join(', ')}` : 'no wording signals', `reasoning: requested ${a.reasoning.requested}, expected ${a.reasoning.effective}: ${a.reasoning.detail}`, ...steps.map(s => `${clock(s.at)} ${s.text}`)],
        }
      })
      return { head: routingHead(v, w, p), items, tail: [] }
    }
    case 'gates': return { head: gatesHead(v, w, p), items: v.gates.map(g => ({ line: (sel: boolean) => `${sel ? p.fg('accent', '▸', true) : ''}${gateRow(g, sel ? w - 1 : w, p)}`, detail: g.evidence.length ? g.evidence : [g.summary] })), tail: gatesTail(v, w, p) }
    case 'costs': {
      // nothing reported → —; only some attempts reported → a lower bound (≥); never an unknown read as $0
      const row = (label: string, r: CostRow, sel: boolean): string => {
        const lower = r.known > 0 && r.known < r.attempts ? p.fg('warn', '≥') : ''
        const tok = r.known === 0 ? p.dim('—') : `${lower}${tokText(r.tokensIn, r.tokensOut, p)}`
        const usd = r.known === 0 ? (r.unmetered ? p.fg('warn', 'unmetered') : p.dim('—')) : `${lower}${costText(r.usd, r.estimated ? 'estimate' : 'reported', p)}`
        return fit(`${sel ? p.fg('accent', '▸', true) : ' '} ${fit(p.fg('head', label), Math.min(48, Math.floor(w / 2.6)))} ${right(p.dim(`${r.attempts} att`), 7)} ${right(tok, 13)} ${right(usd, 11)}${r.unmetered ? p.fg('warn', `  ${r.unmetered} unmetered`) : ''}${r.known < r.attempts && r.known > 0 ? p.dim(`  ${r.attempts - r.known} not reported`) : ''}`, w)
      }
      const items: Item[] = [
        ...v.cost.byModel.map(m => ({ line: (sel: boolean) => row(`${m.role ? ROLE_LABEL[m.role] : ''} ${m.model}`, m, sel), detail: [`input ${m.tokensIn} tokens (cache read ${m.cacheRead}) · output ${m.tokensOut} · ${m.estimated ? 'part estimated from configured pricing' : 'cost reported by Cline'}`] })),
        ...v.cost.byTask.map(t => ({ line: (sel: boolean) => row(`task ${t.key} · ${t.model}`, t, sel), detail: [`input ${t.tokensIn} tokens (cache read ${t.cacheRead}) · output ${t.tokensOut} · ${t.attempts} attempt(s)${t.estimated ? ' · part estimated' : ''}`] })),
      ]
      return { head: costsHead(v, w, p), items, tail: [] }
    }
  }
}

/** The full-screen Mission Control: header, tab bar, the tab's content windowed around the selection, key hints. */
export const missionControlLines = (o: OverlayState, v: View, events: readonly TimelineEvent[], f: Frame): { lines: string[]; count: number } => {
  const p = f.paint; const w = f.cols - 1
  const top = [...headerLines(v, f, true), tabBar(o.tab, w, p)]
  const hint = fit(p.dim(` ←/→ view · ↑/↓ select · Enter details · PgUp/PgDn · ${o.tab === 'timeline' ? 'f filter · ' : ''}Tab/Esc back to the conversation`), w)
  const room = Math.max(3, f.rows - top.length - 2)
  const { head, items, tail } = tabContent(o, v, events, f)
  const body: string[] = []
  if (!items.length) { body.push(...head.slice(0, room), ...tail); if (head.length > room) body[room - 1] = fit(p.dim(`  … ${head.length - room + 1} more line(s): enlarge the terminal`), w) }
  else {
    const sel = Math.max(0, Math.min(items.length - 1, o.sel))
    // a list longer than the room keeps one line for its position indicator
    const base = Math.max(1, room - head.length - tail.length)
    const avail = items.length > base ? Math.max(1, base - 1) : base
    const detail = o.expanded ? detailLines(items[sel].detail, w, p) : []
    // a window of items around the selection; the expanded detail sits under its item
    const listRoom = Math.max(1, avail - Math.min(detail.length, Math.max(0, avail - 3)))
    let start = Math.max(0, Math.min(sel - Math.floor(listRoom / 2), items.length - listRoom)); if (start < 0) start = 0
    const shown = items.slice(start, start + listRoom)
    const lines: string[] = []
    for (const [k, it] of shown.entries()) { lines.push(it.line(start + k === sel)); if (start + k === sel) lines.push(...detail.slice(0, Math.max(0, avail - shown.length))) }
    body.push(...head, ...lines.slice(0, avail), ...tail)
    if (items.length > listRoom) body.push(fit(p.dim(`  ${sel + 1} of ${items.length}`), w))
  }
  const lines = [...top, ...body.slice(0, room)]
  while (lines.length < f.rows - 1) lines.push(' '.repeat(w))
  lines[f.rows - 2] = hint
  return { lines: lines.slice(0, f.rows - 1), count: items.length }
}
