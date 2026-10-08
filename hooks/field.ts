import { tierOf } from './orchestra'
// The Activity Field: a bounded, in-place tape of real activity above the
// prompt, and the surface the crawler physically traverses.
//
// The field is drawn as text first. Real events are laid out left to right, each
// at a known cell, and those cells are the anchors the crawler walks between.
// Nothing here is a scrollback line: the field is re-rendered in place, one or
// two rows, with a third only while a real NobodyWho receipt needs a junction.
//
// The rules that keep it honest:
//   - It only ever draws events that exist. `tapeOf` is handed the real event
//     list; an empty list draws nothing at all, so a session with no activity has
//     no field rather than an empty placeholder.
//   - Narrowing drops whole events and never invents one. A very narrow terminal
//     shows the newest event alone, which is still true.
//   - Old events fade and collapse out of the layout; they are never appended.
//   - The NobodyWho graph exists only for a real receipt. `graphOf` returns null
//     for a prune or decision that was not observed, so no junction and no branch
//     is ever drawn from imagination.

import type { NwhoEvent } from '../types'
import { summarizeSwarm } from './swarm'
import type { Swarm } from './swarm'
import { currentOf, settledIds } from './activity'
import type { ActivityEvent } from './activity'
import { limbsAt, paceOf, poseAt, stepToward } from './crawler'
import type { Limbs, Step } from './crawler'
import { Grid, clamp, escapeXml, fitText, hex, mix, pack } from './pixels'
import { COLORS } from './view'
import type { Row, Segment } from './view'

/** How many rows the field may take at each activity level. */
export const FIELD_ROWS_IDLE = 1
export const FIELD_ROWS_ACTIVE = 2
export const FIELD_ROWS_SPECIAL = 3

/** Below this there is no room for a tape, and the newest event is shown alone. */
export const WIDE_COLUMNS = 72
export const MEDIUM_COLUMNS = 44
export const NARROW_COLUMNS = 22

/** How a field is laid out at a given width. */
export type FieldLayout = 'wide' | 'medium' | 'narrow' | 'tiny'

export const layoutOf = (columns: number): FieldLayout => {
  if (columns >= WIDE_COLUMNS) return 'wide'
  if (columns >= MEDIUM_COLUMNS) return 'medium'
  if (columns >= NARROW_COLUMNS) return 'narrow'

  return 'tiny'
}

/** How many events each layout shows. Fewer columns, fewer events, never faked. */
export const eventsFor = (layout: FieldLayout): number => (layout === 'wide' ? 5 : layout === 'medium' ? 3 : 1)

/**
 * One event placed on the tape: where its verb starts, and where its detail
 * sits. These are the anchors the crawler walks between, and they are real cell
 * offsets into the drawn row, not fractions of anything.
 */
export type Anchor = {
  event: ActivityEvent
  /** The cell the event's verb begins on. */
  at: number
  /** The cell the detail begins on, or the verb's own cell when there is none. */
  detailAt: number
}

export type Tape = {
  anchors: Anchor[]
  /** The whole tape as text, for the row and for measuring anchors. */
  text: string
  /** The newest event, which the crawler attaches to. */
  current: ActivityEvent | null
  /** True when an event is really running right now. */
  active: boolean
}

const SEPARATOR = ' ─╼─ '

/**
 * The event label: the verb, and the detail only when the event really carried
 * one. The detail is already a basename or hostname by the time it gets here.
 */
export const labelOf = (event: ActivityEvent): string => (event.detail === '' ? event.label : `${event.label} ${event.detail}`)

/**
 * The tape for a set of real events at a width.
 *
 * Events older than the window are dropped, so the field is a window on recent
 * activity rather than a log. When more events are shown than fit the columns,
 * the oldest shown ones give way rather than truncating mid-word, so every
 * anchor the crawler can reach is a cell that exists.
 */
export const tapeOf = (events: readonly ActivityEvent[], columns: number): Tape => {
  const width = Math.max(1, columns)
  const window = events.slice(-eventsFor(layoutOf(columns)))
  const anchors: Anchor[] = []
  const parts: string[] = []
  let column = 0
  for (const event of window) {
    const full = labelOf(event)
    // The first event is cut to the row rather than dropped, so even a terminal
    // too narrow for the whole label still shows what is really happening. Every
    // later event is either drawn whole or not at all, which is what keeps each
    // anchor on a cell that really holds that event's text.
    const label = column === 0 ? fitText(full, width) : full
    const needed = column === 0 ? label.length : SEPARATOR.length + label.length
    if (column !== 0 && column + needed > width) break
    if (column !== 0) {
      parts.push(SEPARATOR)
      column += SEPARATOR.length
    }
    anchors.push({ event, at: column, detailAt: column + event.label.length + (event.detail === '' ? 0 : 1) })
    parts.push(label)
    column += label.length
  }
  const text = parts.join('')

  return { anchors, text, current: currentOf(window), active: window.some(event => event.state === 'running') }
}
/**
 * Where the crawler is, and what it is doing.
 *
 * `at` is a real cell on the tape. `on` is the anchor it is travelling toward,
 * which is the real cell of a real event, or null when there is nothing to walk
 * to. `step` counts cells covered, so the limbs articulate with distance.
 */
export type Walker = {
  at: number
  on: number | null
  step: number
  /** The cell the crawler is inspecting right now, for a scan or a revisit. */
  scanning: number | null
}

export const RESTING: Walker = { at: 0, on: null, step: 0, scanning: null }

/** The glyph the crawler leaves where it stands, per state. */
export const CRAWLER_MARK = {
  active: '◉',
  query: '?',
  fault: '✖',
  verified: '★',
} as const

/**
 * One frame of the crawler moving through the tape.
 *
 * The target is only ever an anchor the tape actually has: `walkTo` clamps it
 * into the row, and `on` comes from a real anchor, so the crawler cannot claim
 * to be at an event that was never observed. Under reduced motion it arrives at
 * once and holds, which still shows the state honestly.
 */
export const advance = (walker: Walker, tape: Tape, state: string, motion: { now: number; reducedMotion: boolean }): Walker => {
  const anchors = tape.anchors
  if (anchors.length === 0) return { ...RESTING }
  const current = tape.current
  const found = current === null ? undefined : anchors.find(anchor => anchor.event.id === current.id)
  if (found === undefined) return { ...walker, on: null, scanning: null }
  // The crawler pauses at the detail rather than the verb: it is inspecting the
  // thing that happened, not the category it fell into.
  const reach = found.detailAt - found.at
  const inspect = found.at + Math.min(3, Math.max(0, reach))
  // A fault, a query and a verified task are all places the crawler holds
  // still: the first because the break must be readable, the second because it
  // is waiting for an answer, the third because the work is over.
  const settled = state === 'verified' || state === 'fault' || state === 'query'
  const last = Math.max(0, tape.text.length - 1)
  const from = walker.on === null ? found.at : walker.at
  const next: Step = stepToward(from, inspect, settled ? 0 : paceOf(state, true), last, walker.step, motion.reducedMotion)

  return { at: next.at, on: found.at, step: next.travel, scanning: inspect }
}

/**
 * Which anchors a state actually revisits.
 *
 * VERIFY walks back over events that really finished, and never over one that is
 * still running or that failed. Every other state revisits nothing, so the sweep
 * can only ever light up real completed work.
 */
export const revisitOf = (tape: Tape, state: string): number[] => {
  if (state !== 'verify') return []
  const settled = new Set(settledIds(tape.anchors.map(anchor => anchor.event)))

  return tape.anchors.filter(anchor => settled.has(anchor.event.id)).map(anchor => anchor.at)
}

/**
 * The terminal field: the tape with the crawler walking along the spine beneath
 * it.
 *
 * The two rows are the geometry the crawler actually reads: the text on top, and
 * the path under it. Its limbs land on the spine and its core rises onto the
 * label it is inspecting, so the creature genuinely occupies the text rather
 * than merely sitting next to it, while every event label stays readable. That
 * split is also what keeps a one-row field honest: with no room for a spine the
 * crawler degrades to a single mark inside the label it is on.
 *
 * `rows` is the budget `rowsOf` decided on, so an idle field really is one row
 * and a live graph really is three.
 */
export const fieldGrid = (tape: Tape, walker: Walker, state: string, columns: number, rows = 2): Grid => {
  const width = Math.max(1, columns)
  const tall = rows > 1 && tape.anchors.length > 0
  const grid = new Grid(width, tall ? 2 : 1)
  const accent = pack(hex(COLORS.accent))
  const silver = pack(hex(COLORS.silver))
  const ok = pack(hex(COLORS.ok))
  const bad = pack(hex(COLORS.bad))
  const dim = pack(mix(hex(COLORS.silver), [0, 0, 0], 0.45))
  const ink = (x: number, y: number, cp: number, fg: number) => {
    if (x >= 0 && x < width) grid.set(x, y, cp, fg, 0x01000000)
  }
  // The spine: one path under the whole tape, so a run of events reads as a run.
  if (tall) for (let x = 0; x < width; x++) ink(x, 1, 0x2500, dim)
  for (const anchor of tape.anchors) {
    const fg = anchor.event.state === 'failed' ? bad : anchor.event.state === 'running' ? accent : anchor.event.state === 'done' ? ok : silver
    const shown = tape.text.slice(anchor.at)
    for (const [offset, ch] of [...shown].entries()) if (anchor.at + offset < width) ink(anchor.at + offset, 0, ch.codePointAt(0) ?? 32, fg)
    // The node each event makes on the path, and the event's own state colour.
    if (tall) ink(anchor.at, 1, anchor.event.state === 'done' ? 0x25cf : 0x25c6, fg)
  }
  // VERIFY sweeps the nodes that really completed; no other state lights them.
  if (state === 'verify' && tall) for (const at of revisitOf(tape, state)) ink(at, 1, 0x25c9, ok)
  // The crawler: a core, four limbs that alternate, and a cable tail.
  const limbs: Limbs = limbsAt(walker.at, walker.step, poseAt(walker.step))
  const core = state === 'fault' ? bad : state === 'verified' ? ok : state === 'query' ? pack(hex(COLORS.warn)) : accent
  if (tall) {
    for (const x of [limbs.rear[1], limbs.rear[0]]) ink(x, 1, 0x2572, silver)
    for (const x of [limbs.front[0], limbs.front[1]]) ink(x, 1, 0x256e, silver)
    ink(limbs.tail, 1, 0x2501, pack(mix(hex(COLORS.accent), [0, 0, 0], 0.3)))
    ink(limbs.core, 1, 0x25c9, core)
  } else {
    // One row and no spine: the creature cannot walk under the labels without
    // eating a letter, so it runs along the tail of the row instead, over the
    // connector that follows the tape. The label it is on stays fully readable,
    // which is the one thing the field must never trade away.
    const path = Math.min(width - 1, tape.text.length)
    for (let x = tape.text.length; x < width; x++) ink(x, 0, 0x2500, dim)
    const mark = state === 'fault' ? 0x2716 : state === 'verified' ? 0x2605 : state === 'query' ? 0x003f : 0x25c9
    if (path > tape.text.length) ink(path - 1, 0, 0x2501, pack(mix(hex(COLORS.accent), [0, 0, 0], 0.3)))
    ink(path, 0, mark, core)
  }

  return grid
}

/**
 * The field as one row of styled text, for a surface with neither Raster nor Svg.
 *
 * The same tape, the same anchors and the same crawler cell as the grid, so the
 * reading is identical everywhere and only the medium differs.
 */
export const fieldRows = (tape: Tape, walker: Walker, state: string, columns: number): Row[] => {
  if (tape.anchors.length === 0) return []
  const segments: Segment[] = []
  let column = 0
  for (const anchor of tape.anchors) {
    const label = labelOf(anchor.event)
    if (anchor.at > column) {
      segments.push({ text: '─'.repeat(anchor.at - column), isDim: true })
      column = anchor.at
    }
    const color = anchor.event.state === 'failed' ? COLORS.bad : anchor.event.state === 'running' ? COLORS.accent : anchor.event.state === 'done' ? COLORS.ok : COLORS.silver
    segments.push({ text: label, color, isDim: anchor.event.state !== 'running' })
    column += label.length
  }
  const cell = clamp(Math.round(walker.at), 0, Math.max(0, columns - 1))
  const mark = state === 'verified' ? CRAWLER_MARK.verified : state === 'fault' ? CRAWLER_MARK.fault : state === 'query' ? CRAWLER_MARK.query : CRAWLER_MARK.active
  const markColor = state === 'fault' ? COLORS.bad : COLORS.accent
  const out: Segment[] = []
  let seen = 0
  for (const segment of segments) {
    const text = segment.text
    if (cell >= seen && cell < seen + text.length) {
      const offset = cell - seen

      return [[
        ...out,
        { text: text.slice(0, offset), color: segment.color, isDim: segment.isDim },
        { text: mark, color: markColor },
        { text: text.slice(offset + 1), color: segment.color, isDim: segment.isDim },
      ]]
    }
    out.push(segment)
    seen += text.length
  }

  return [out]
}
/**
 * The NobodyWho junction or branch set, drawn only for a receipt that really
 * arrived.
 *
 * `graphOf` returns null for anything but a real decision or a real prune, so a
 * session that has never seen a receipt draws no graph at all: no placeholder,
 * no dimmed "no branches" line, and no way for a branch or a route to appear from
 * anything but the ledger.
 *
 * What a branch carries is the enumerated and numeric telemetry the receipt
 * really had: the tier, the route it chose, and the proposed, accepted and
 * rejected counts. The question and the reasoning behind the choice were never
 * read out of the receipt, so they cannot be here.
 */
export type Branch = {
  /** `kept` paths survived the prune; `dropped` ones did not. */
  state: 'kept' | 'dropped'
  /** The safe word drawn on the branch, e.g. the route for a decision. */
  label: string
  /** The fraction along the spine where the branch leaves it, 0..1. */
  at: number
  /** How lit the branch is: a kept route is lit, a dropped one fades. */
  lit: number
}

export type Graph = {
  runId?: string
  kind: 'decision' | 'prune' | 'orchestration'
  /** The one line of safe telemetry, e.g. `NWHO · PRUNE · Q4B · 4→2 · 37ms`. */
  label: string
  branches: Branch[]
  /** The route the receipt really chose, for a decision. */
  chosen: string | null
}

const num = (value: number | null): number | null => (value === null || !Number.isFinite(value) ? null : value)

/** `proposed → accepted`, only when the receipt really carried both counts. */
const ratio = (event: NwhoEvent): string => {
  const proposed = num(event.proposed)
  const accepted = num(event.accepted)

  return proposed === null || accepted === null ? '' : `${proposed}→${accepted}`
}

/**
 * The graph a real receipt earns, or null when there is no real receipt.
 *
 * A prune draws one branch per accepted path and one per rejected path, bounded
 * so a receipt claiming hundreds cannot flood the field; the counts it really
 * carried are always on the label whatever is drawn. A decision draws the route
 * it really chose, and nothing else: the alternatives are not invented, because
 * the receipt named one route and Cockpit never saw the others.
 */
export const graphOf = (prune: NwhoEvent | null, decision: NwhoEvent | null): Graph | null => {
  if (prune !== null) {
    const accepted = num(prune.accepted)
    const rejected = num(prune.rejected)
    const parts = ['NWHO', 'PRUNE', prune.tier, ratio(prune)]
    if (prune.latencyMs > 0) parts.push(`${prune.latencyMs}ms`)
    const branches: Branch[] = []
    if (accepted !== null) for (let n = 0; n < Math.min(accepted, 3); n++) branches.push({ state: 'kept', label: 'ACCEPT', at: 0.42, lit: 1 })
    if (rejected !== null) for (let n = 0; n < Math.min(rejected, 3); n++) branches.push({ state: 'dropped', label: 'DROP', at: 0.68 + n * 0.09, lit: 0.25 })

    return { kind: 'prune', label: parts.filter(Boolean).join(' · '), branches, chosen: null }
  }
  if (decision !== null) {
    const chosen = decision.route
    const parts = ['NWHO', 'DECISION', decision.tier]
    if (chosen !== null) parts.push(chosen)
    if (decision.latencyMs > 0) parts.push(`${decision.latencyMs}ms`)

    return {
      kind: 'decision',
      label: parts.filter(Boolean).join(' · '),
      branches: chosen === null ? [] : [{ state: 'kept', label: chosen, at: 0.5, lit: 1 }],
      chosen,
    }
  }

  return null
}

/**
 * The branches still on screen.
 *
 * A dropped branch is kept only while it is still dissolving. Once the receipt
 * has aged past the field's own TTL the whole junction collapses back into the
 * tape, kept paths included: the graph is a transient picture of one receipt,
 * not a second history that stays on screen for the rest of the session.
 */
export const liveBranches = (graph: Graph | null, now: number, ttlMs: number): Branch[] => {
  if (graph === null) return []
  if (now < ttlMs) return graph.branches

  return graph.branches.filter(branch => branch.state === 'kept')
}

/** Whether the graph is still a live picture, as opposed to a fading remnant. */
export const isFresh = (now: number, ttlMs: number): boolean => now < ttlMs

/**
 * How many rows the field takes right now.
 *
 * This is the height budget in one place: one row when idle, two while work is
 * really happening, and a third only while a real NobodyWho graph has something
 * to show. A session that is merely working therefore never grows the band, and
 * a graph that has finished fading takes its row straight back.
 */
export const rowsOf = (tape: Tape, graph: Graph | null, now: number, ttlMs: number): number => {
  if (tape.anchors.length === 0) return 0
  const base = tape.active ? FIELD_ROWS_ACTIVE : FIELD_ROWS_IDLE
  // The third row belongs to a graph that is still a live picture of a receipt.
  // Once the receipt has aged out, the junction collapses and the row goes back.
  const fresh = graph !== null && liveBranches(graph, now, ttlMs).length > 0 && isFresh(now, ttlMs)

  return fresh ? Math.max(base, FIELD_ROWS_SPECIAL) : base
}
/**
 * The desktop field: an SVG carrying the tape as real text and the crawler as
 * articulated limbs over it.
 *
 * The geometry is the same as the terminal's. An anchor's cell becomes an x in
 * the SVG's own user units, so the creature stands where it stands in the cell
 * grid, on the word it is inspecting, and the two surfaces cannot disagree about
 * what it is looking at. Nothing is drawn that is not on the tape.
 */
export const fieldSvg = (
  tape: Tape,
  walker: Walker,
  state: string,
  graph: Graph | null,
  width: number,
  height: number,
  now: number,
  ttlMs: number,
): { svg: string; alt: string } => {
  const cell = 8
  const across = Math.max(1, width)
  const baseline = height - 3
  const parts: string[] = []
  // The spine under the whole tape, so a run of events reads as one path.
  parts.push(`<path d="M0 ${baseline} L${across} ${baseline}" stroke="${COLORS.silver}" stroke-opacity="0.35" fill="none"/>`)
  for (const anchor of tape.anchors) {
    const x = anchor.at * cell
    const fill = anchor.event.state === 'failed' ? COLORS.bad : anchor.event.state === 'running' ? COLORS.accent : anchor.event.state === 'done' ? COLORS.ok : COLORS.silver
    parts.push(`<text x="${x}" y="${baseline - 5}" fill="${fill}" font-size="10" font-family="monospace">${escapeXml(labelOf(anchor.event))}</text>`)
    parts.push(`<circle cx="${x + 2}" cy="${baseline}" r="2.5" fill="${fill}" fill-opacity="${anchor.event.state === 'running' ? 1 : 0.45}"/>`)
  }
  if (state === 'verify') for (const at of revisitOf(tape, state)) parts.push(`<circle cx="${at * cell + 2}" cy="${baseline}" r="4" fill="none" stroke="${COLORS.ok}"/>`)
  // The crawler: a body with four limbs that alternate, so it reads as walking
  // rather than sliding. Each limb is a curve to its own cell on the spine.
  const pose = poseAt(walker.step)
  const limbs: Limbs = limbsAt(walker.at, walker.step, pose)
  const core = limbs.core * cell
  const limb = (offset: number, reach: number) =>
    `<path d="M${core} ${baseline} Q${core + offset * cell * 0.5} ${baseline + reach} ${(core + offset * cell) / 1} ${baseline}" stroke="${COLORS.silver}" fill="none"/>`
  for (const offset of pose.rear) parts.push(limb(offset, -8))
  for (const offset of pose.front) parts.push(limb(offset, 5))
  parts.push(`<path d="M${(core + pose.tail * cell) / 1} ${baseline} q-6 -6 -12 0" stroke="${COLORS.accent}" stroke-opacity="0.6" fill="none"/>`)
  const coreColor = state === 'fault' ? COLORS.bad : state === 'verified' ? COLORS.ok : state === 'query' ? COLORS.warn : COLORS.accent
  parts.push(`<circle cx="${core}" cy="${baseline}" r="3.5" fill="${coreColor}"/>`)
  // The graph, only while a real receipt still has branches to show.
  for (const branch of liveBranches(graph, now, ttlMs)) {
    const bx = branch.at * across
    const color = branch.state === 'kept' ? COLORS.ok : COLORS.bad
    const rise = branch.state === 'kept' ? -12 : 9
    parts.push(`<path d="M${bx} ${baseline} L${bx + 6} ${baseline + rise}" stroke="${color}" stroke-opacity="${branch.lit}" fill="none"/>`)
    parts.push(`<circle cx="${bx + 6}" cy="${baseline + rise}" r="2" fill="${color}" fill-opacity="${branch.lit}"/>`)
  }
  const topology = graph?.kind === 'orchestration' ? ` ${graph.label}: ${graph.branches.map(b => b.label).join(' | ')}` : ''
  const alt = tape.current === null ? 'activity field idle' : `${tape.current.kind} ${tape.current.detail} ${state}`

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${across} ${height}" width="${across}" height="${height}" role="img" aria-label="${escapeXml(alt)}">${parts.join('')}</svg>`,
    alt: alt + topology,
  }
}

// Real spawned branches share the existing Activity Field/crawler geometry.
// Parent and origin are facts retained by the Run Ledger, never task guesses.
export const orchestrationGraph = (ledger: import('./ledger').Ledger, now = 0): Graph | null => {
  if (ledger.swarm?.tasks.length) return swarmGraph(ledger.swarm, ledger.currentRun ?? undefined, tierOf(ledger.runs.find(r=>r.id===ledger.currentRun)?.model) ?? 'MAIN / MODEL unknown')

  const known = ledger.agents.filter(a => a.runId !== 'unknown' && ledger.runs.some(r => r.id === a.runId))
  const focus = known.some(a => a.runId === ledger.currentRun && a.status === 'running') ? ledger.currentRun : known.find(a => a.status === 'running')?.runId ?? (known.some(a => a.runId === ledger.currentRun) ? ledger.currentRun : undefined)
  const agents = known.filter(a => a.runId === focus)
  if (!agents.length) return null
  const running = agents.filter(a => a.status === 'running')
  const run = ledger.runs.find(r => r.id === focus)
  const verified = focus === ledger.currentRun && ledger.checkpoint !== null && ['TEST', 'TYPE', 'BUILD'].some(k => ledger.checkpoint?.gates[k] === 'pass') && run?.status === 'success'
  const main = run?.model.includes('opus') ? 'OPUS' : run?.model.includes('sonnet') ? 'SONNET' : 'MAIN'
  const label = running.length ? main === 'MAIN' ? 'MAIN · MODEL unknown' : `${main} MAIN` : verified ? `${main} / VERIFY` : `${main} / INTEGRATE`
  return { kind: 'orchestration', runId: focus, label, chosen: null, branches: agents.filter(a => a.status === 'running' || a.end === 'unknown' || now - a.end < 5000).slice(-3).map((a, i) => ({ state: a.status === 'error' || a.status === 'refusal' ? 'dropped' : 'kept', label: `${a.role} ${a.id}`, at: (i + 1) / 4, lit: a.status === 'running' ? 1 : 0.5 })) }
}
export const orchestrationTape = (ledger: import('./ledger').Ledger, columns: number, now = 0): Tape | null => {
  const graph = orchestrationGraph(ledger, now)
  if (!graph) return null
  if (ledger.swarm?.tasks.length) return swarmTape(ledger.swarm, columns, tierOf(ledger.runs.find(r=>r.id===ledger.currentRun)?.model) ?? 'MAIN / MODEL unknown')
  const run = ledger.runs.find(r => r.id === graph.runId)
  const agents = ledger.agents.filter(a => a.runId === graph.runId && (a.status === 'running' || a.end === 'unknown' || now - a.end < 5000)).slice(-3)
  const events: ActivityEvent[] = [{ id: run?.id ?? ledger.sessionId, kind: 'AGENT', label: graph.label, detail: '', state: agents.some(a => a.status === 'running') ? 'running' : 'done', startedAt: run?.start ?? 0, endedAt: run?.end === 'unknown' ? null : run?.end ?? null }, ...agents.map(a => ({ id: a.id, kind: 'AGENT' as const, label: a.role, detail: a.parentAgent === 'unknown' ? '' : `←${a.parentAgent}`, state: a.status === 'running' ? 'running' as const : a.status === 'success' ? 'done' as const : 'failed' as const, startedAt: a.start === 'unknown' ? 0 : a.start, endedAt: a.end === 'unknown' ? null : a.end }))]
  const tape = tapeOf(events, columns)
  // Replace spine separators with branch junctions at the same cell positions.
  tape.text = tape.text.replace(/ ─╼─ /g, agents.some(a => a.status === 'running') ? ' ┬── ' : ' ┴── ')
  return tape
}

/** Tier/state aggregation shares crawler geometry, with bounded nodes even for
 * large utility pools. Every count comes from recorded task ownership state. */
export const swarmGraph = (swarm: Swarm, runId?: string, commander = 'MAIN / MODEL unknown'): Graph | null => {
  if (!swarm.tasks.length) return null
  const summary = summarizeSwarm(swarm)
  const branches: Branch[] = []
  for (const tier of ['SONNET', 'HAIKU', 'OPUS'] as const) {
    const tasks = swarm.tasks.filter(t => t.tier === tier)
    if (!tasks.length) continue
    const count = (states: string[]) => tasks.filter(t => states.includes(t.state)).length
    const escalated = tasks.filter(t => t.escalation !== null).length
    const review = tasks.filter(t => t.wave === 'REVIEW').length
    const verification = tasks.filter(t => t.wave === 'VERIFICATION').length
    const label = `${tier} ${tasks.length} · active ${count(['reserved', 'running'])} · queue ${count(['queued'])} · blocked ${count(['blocked', 'stalled'])} · done ${count(['completed'])} · failed ${count(['failed'])}${escalated ? ` · ↑${escalated}` : ''}${review ? ` · review ${review}` : ''}${verification ? ` · verify ${verification}` : ''}`
    branches.push({ state: count(['failed']) === tasks.length ? 'dropped' : 'kept', label, at: 0, lit: count(['reserved', 'running']) ? 1 : 0.5 })
  }
  branches.forEach((b, i) => { b.at = (i + 1) / (branches.length + 1) })
  return { kind: 'orchestration', runId, chosen: null, label: `${commander} · ${summary.wave} · parallel ${summary.parallelism} · queue ${summary.queue} · blocked ${summary.blocked}`, branches }
}
export const swarmTape = (swarm: Swarm, columns: number, commander = 'MAIN / MODEL unknown'): Tape | null => {
  const graph = swarmGraph(swarm,undefined,commander)
  if (!graph) return null
  const events: ActivityEvent[] = [{ id: 'swarm:commander', kind: 'AGENT', label: `${commander} ${swarm.wave}`, detail: '', state: summarizeSwarm(swarm).parallelism ? 'running' : 'done', startedAt: 0, endedAt: null }]
  for (const b of graph.branches) {
    const tier = b.label.split(' ')[0]!
    const tasks = swarm.tasks.filter(t => t.tier === tier)
    const live = tasks.filter(t => t.state === 'running' || t.state === 'reserved').length
    const blocked = tasks.filter(t => t.state === 'blocked' || t.state === 'stalled').length
    const escalated = tasks.filter(t => t.escalation !== null).length
    events.push({ id: `swarm:${tier}`, kind: 'AGENT', label: `${tier} ×${tasks.length}`, detail: `${live} active${blocked ? ` !${blocked}` : ''}${escalated ? ` ↑${escalated}` : ''} ${tasks.filter(t => t.state === 'queued').length} queued ${tasks.filter(t => t.state === 'completed').length} done`, state: live ? 'running' : b.state === 'dropped' ? 'failed' : tasks.every(t => t.state === 'completed') ? 'done' : 'waiting', startedAt: Math.min(...tasks.map(t => t.createdAt)), endedAt: null })
  }
  return tapeOf(events, columns)
}
