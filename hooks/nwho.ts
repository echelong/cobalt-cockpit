// Local Control: optional NobodyWho telemetry, read from the shared
// decision-router ledger.
//
// Cockpit does not depend on NobodyWho, never spawns it, and never writes to
// the ledger: the file is read-only telemetry. The router appends one JSON
// object per line to ($XDG_STATE_HOME/decision-router/ledger.jsonl); this module
// parses only the few enumerated and numeric fields below and drops the rest.
//
// What makes this safe to sit beside real work:
//   - only `operation`, `caller`, `request_id`, `tier`, `choice`, `abstain`,
//     `latency_ms`, the two block counts and `ts` are ever read. The question,
//     the cwd, the repo, the state, the details and all free text are never
//     read, so a prompt, a command or a secret cannot reach the HUD.
//   - only `caller: "claude"` receipts count, and only from the bytes that
//     arrived after the cursor: history on disk is not current activity.
//   - JEV is disabled in this architecture and is never named. A tier 3
//     receipt is dropped rather than relabelled.
//   - a missing file, a malformed line or a failed read is not an error. It
//     yields no events and never touches the host.
//
// Nothing here is inferred. Pruning is wired into Claude Code today and
// `decision ask` is not, so a Decision receipt appears only when the router
// genuinely wrote one. When that path is wired, this same reader already picks
// it up with no change.

import type { Cursor, LocalControl, NwhoEvent, NwhoFlash, NwhoOp, NwhoTier } from '../types'
import { secretText } from './replay'
import { fitText } from './pixels'
import { COLORS } from './view'
import type { Row } from './view'

export type { LocalControl, NwhoEvent, NwhoFlash, NwhoOp, NwhoTier } from '../types'

export const EMPTY_CONTROL: LocalControl = { lastDecision: null, lastPrune: null, history: [], lastAt: 0 }
export const HISTORY_MAX = 8
export const SEEN_MAX = 64

type Receipt = Record<string, unknown>

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * The tier a receipt names, from the router's own numbering, or null when the
 * receipt is one Cockpit does not draw. Tier 0 is the deterministic path and
 * tier 3 is the JEV fallback, which this architecture has disabled.
 */
export const tierOf = (op: NwhoOp, tier: unknown): NwhoTier | null => {
  if (tier === 0 || tier === 'native') return 'P0'
  // Pruning escalates 4B then 9B; a decision escalates the small specialist then 9B.
  if (tier === 1) return op === 'prune' ? 'Q4B' : '0.6B'
  if (tier === 2) return '9B'

  return null
}

/** An option id is shown as a word only if it is already a safe word. */
export const routeOf = (choice: unknown, abstain: unknown): string | null => {
  if (abstain === true) return null
  if (typeof choice !== 'string' || secretText(choice)) return null
  const word = choice.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 12)

  return word === '' ? null : word
}

/**
 * One ledger line into one event, or null for a line Cockpit does not draw:
 * another caller's receipt, an operation it does not show, a JEV tier, a line
 * with no id or no time, or a line that is not an object at all.
 *
 * Nothing is inferred from a prune: `operation: 'prune'` yields `op: 'prune'`
 * and nothing more, so a Decision can only ever come from an `ask` receipt.
 */
export const eventOf = (line: string, caller = 'claude'): NwhoEvent | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const row = parsed as Receipt
  // Only this caller's own work is the operator's business.
  if (caller !== '' && row['caller'] !== caller) return null
  const operation = row['operation']
  const op: NwhoOp | null = operation === 'prune' ? 'prune' : operation === 'ask' ? 'decision' : null
  if (op === null) return null
  const tier = tierOf(op, row['tier'])
  if (tier === null) return null
  const latency = num(row['latency_ms'])
  const at = Date.parse(String(row['ts'] ?? ''))
  const requestId = typeof row['request_id'] === 'string' ? row['request_id'] : ''
  if (latency === null || Number.isNaN(at) || requestId === '' || requestId.length > 160 || !/^[A-Za-z0-9_.:+-]+$/.test(requestId) || secretText(requestId)) return null
  // The block counts live on the attempt the router recorded.
  const attempts = Array.isArray(row['attempts']) ? (row['attempts'] as unknown[]) : []
  const judged = attempts.map(one => num((one as Receipt | null)?.['judged_blocks'])).find(one => one !== null) ?? null
  const dropped = attempts.map(one => num((one as Receipt | null)?.['dropped_blocks'])).find(one => one !== null) ?? null

  return {
    op,
    tier,
    ...(typeof row['abstain'] === 'boolean' ? { abstention: row['abstain'] } : {}),
    fallbackTier: tierOf(op, row['fallback_from']),
    latencyMs: latency,
    at,
    requestId,
    route: routeOf(row['choice'], row['abstain']),
    proposed: op === 'decision' && typeof row['accepted'] === 'boolean' ? 1 : judged,
    accepted: op === 'decision' && typeof row['accepted'] === 'boolean' ? (row['accepted'] ? 1 : 0) : judged === null || dropped === null ? null : Math.max(0, judged - dropped),
    rejected: op === 'decision' && typeof row['accepted'] === 'boolean' ? (row['accepted'] ? 0 : 1) : dropped,
  }
}

/**
 * Where the reader is in the file, and what it has already handed to the HUD.
 *
 * `size` is the ledger's size when it was last read. A size that shrank means
 * the file was rotated or replaced, so the reader restarts at the end rather
 * than reading from a meaningless offset into a different file.
 */
export type { Cursor } from '../types'

/** The start of a read: at the end of the file, so history is never replayed. */
export const cursorAt = (size: number): Cursor => ({ offset: 0, size, seen: [], primed: false })

/**
 * New events in the ledger text, and the cursor to use next time.
 *
 * The first read is deliberately silent: it only records where the file ends,
 * which is what keeps yesterday's receipts off today's HUD and what makes a
 * hot reload resume rather than replay. After that, only lines past the cursor
 * are parsed, and a receipt still being appended (no trailing newline yet) is
 * left for the next read rather than half-parsed.
 *
 * Deduplication is by the router's own `request_id`, so a re-read of the same
 * range, a rewritten line, or a receipt the router repeats is one event.
 */
export const drain = (text: string, cursor: Cursor, caller = 'claude'): { events: NwhoEvent[]; cursor: Cursor } => {
  const trimmed = cursor.primed ? text.slice(cursor.offset) : text
  if (!cursor.primed) {
    const at = text.lastIndexOf('\n')

    return { events: [], cursor: { offset: at + 1, size: text.length, seen: [], primed: true } }
  }
  const boundary = trimmed.lastIndexOf('\n')
  // Hold back a trailing partial line until the rest of it has been written.
  const complete = boundary === -1 ? '' : trimmed.slice(0, boundary + 1)
  const events: NwhoEvent[] = []
  const seen = cursor.seen
  for (const line of complete.split('\n')) {
    const event = eventOf(line, caller)
    if (event === null) continue
    if (seen.includes(event.requestId)) continue
    seen.push(event.requestId)
    events.push(event)
  }

  return { events, cursor: { offset: cursor.offset + complete.length, size: text.length, seen: seen.slice(-SEEN_MAX), primed: true } }
}

/**
 * Folds real events into the control state. A prune updates only the prune
 * fields and a decision updates only the decision fields, so neither can
 * impersonate the other.
 *
 * `lastAt` is deliberately *not* taken from the receipt: a receipt's own
 * timestamp belongs to another process's clock, and one that is skewed or in
 * the future must not be allowed to reorder or blank this session's own record.
 * The caller passes the time at which it saw the event.
 */
// `seenAt` is the time the session saw the events. When a caller does not say,
// the events' own times are used, which is right for a pure unit test and for
// any host whose clock agrees with the router's.
export const fold = (control: LocalControl, events: readonly NwhoEvent[], seenAt?: number): LocalControl => {
  if (events.length === 0) return control
  const at = seenAt ?? Math.max(...events.map(one => one.at))
  let lastDecision = control.lastDecision
  let lastPrune = control.lastPrune
  const history = [...control.history]
  for (const event of events) {
    if (event.op === 'prune') lastPrune = event
    else lastDecision = event
    history.push({ at, op: event.op, text: stripText(event) })
  }

  return { lastDecision, lastPrune, history: history.slice(-HISTORY_MAX), lastAt: Math.max(control.lastAt, at) }
}

/** Whether this session has observed any NobodyWho work at all. */
export const seenAny = (control: LocalControl): boolean => control.lastAt > 0

const ms = (value: number): string => `${value}ms`

/**
 * `NWHO · PRUNE · Q4B · 4→2 · 37ms`, the whole disclosure: name, operation,
 * tier, the counts a prune receipt really carried, and the latency. Nothing
 * else from the receipt reaches the screen.
 */
export const stripText = (event: NwhoEvent): string => {
  const op = event.op === 'prune' ? 'PRUNE' : 'DECISION'
  const counts =
    event.op === 'prune' && event.proposed !== null && event.accepted !== null ? `${event.proposed}→${event.accepted}` : null
  const middle = [event.tier, ...(counts === null ? [] : [counts]), ...(event.route === null ? [] : [event.route])]

  return `NWHO · ${op} · ${middle.join(' · ')} · ${ms(event.latencyMs)}`
}

/**
 * A flash is the newest real receipt, held briefly and then gone.
 *
 * `at` is when it was observed, and the caller passes the clock so the age is
 * computed at draw time. Nothing else keeps it on screen: a single prune does
 * not get to park a permanent label on the HUD, and a session with no receipts
 * never has a flash to draw at all.
 */
export type Flash = NwhoFlash

export const FLASH_MS = 4000

/** How long a flash lives here: long enough to read, short enough to fade. */
const lifeOf = (reducedMotion: boolean): number => (reducedMotion ? FLASH_MS / 5 : FLASH_MS)

/** The flash to draw at `now`, or null when it has faded or none happened. */
export const liveFlash = (flash: Flash | null, now: number, reducedMotion = false): Flash | null => {
  if (flash === null) return null
  const age = now - flash.at

  // The flash has a life, not a half-open interval: once it has lived out its
  // full span it is over, so no caller can hold a stale strip on screen by
  // asking for the exact boundary.
  return age >= 0 && age < lifeOf(reducedMotion) ? flash : null
}

/**
 * 1 at the moment of the receipt, easing to 0 as it fades: how strongly to
 * draw the crawler and the strip. Reduced motion shortens the fade rather than
 * removing the information.
 */
export const flashStrength = (flash: Flash | null, now: number, reducedMotion = false): number => {
  if (liveFlash(flash, now, reducedMotion) === null) return 0
  const age = (now - (flash?.at ?? 0)) / lifeOf(reducedMotion)

  return Math.max(0, Math.min(1, 1 - age * age))
}

/** A real timestamp as `14:03:22`, for the dossier's "most recent" line. */
export const clockOf = (at: number): string => {
  const when = new Date(at)

  return [when.getHours(), when.getMinutes(), when.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}

const field = (name: string, value: string, color?: string, dim = false): Row => [
  { text: ` ${name.padEnd(15)}`, isDim: true },
  { text: value, ...(color === undefined ? {} : { color }), ...(dim ? { isDim: true } : {}) },
]

const counted = (value: number | null | undefined): string => (value === null || value === undefined ? 'not observed' : `${value}`)

/**
 * The transient HUD strip: the live flash only, and nothing else.
 *
 * There is deliberately no "NOBODYWHO unavailable" line. A session with no
 * receipts gets an empty array, which draws no row at all, so the compact HUD
 * is identical to a machine that has never heard of the router. The strip is
 * also the only place a receipt is summarized, and only while it is live.
 */
export const stripRows = (flash: Flash | null, now: number, columns: number, reducedMotion = false): Row[] => {
  if (liveFlash(flash, now, reducedMotion) === null || flash === null || columns < 30) return []
  const strength = flashStrength(flash, now, reducedMotion)
  // The fade is the text dimming, not the row disappearing and reappearing.
  return [[{ text: flash.text, color: flash.op === 'prune' ? COLORS.silver : COLORS.accent, isDim: strength < 0.5 }]]
}

/**
 * Mission Control's LOCAL CONTROL section.
 *
 * Empty when the session observed no real receipt, so the dossier gains no
 * placeholder and no "unavailable" line: the section simply is not there.
 *
 * Within a section that does exist, a field Cockpit never observed prints
 * `not observed`. A prune-only session therefore shows the Decision half as
 * unobserved, which is the honest reading of a decision path that is not wired.
 */
export const controlRows = (control: LocalControl, columns: number, color: string): Row[] => {
  if (!seenAny(control)) return []
  const title = '09 LOCAL CONTROL'
  const rule = columns - title.length - 2
  const rows: Row[] = [[], [{ text: `${title} `, color, isBold: true }, ...(rule > 1 ? [{ text: '─'.repeat(rule), isDim: true }] : [])]]
  const decision = control.lastDecision
  const prune = control.lastPrune
  const none = (value: unknown): string => (value === null || value === undefined ? 'not observed' : `${value}`)
  rows.push(
    field('DECISION tier', decision === null ? 'not observed' : decision.tier, decision === null ? undefined : COLORS.accent, decision === null),
    field('DECISION route', decision === null ? 'not observed' : (decision.route ?? 'abstain'), COLORS.ok, decision === null),
    field('DECISION latency', decision === null ? 'not observed' : ms(decision.latencyMs), COLORS.silver, decision === null),
    field('PRUNING tier', prune === null ? 'not observed' : prune.tier, prune === null ? undefined : COLORS.accent, prune === null),
    field('PRUNING latency', prune === null ? 'not observed' : ms(prune.latencyMs), COLORS.silver, prune === null),
    field('  proposed', counted(prune?.proposed), COLORS.silver, prune?.proposed === null || prune === null),
    field('  accepted', counted(prune?.accepted), COLORS.ok, prune?.accepted === null || prune === null),
    field('  rejected', counted(prune?.rejected), COLORS.bad, prune?.rejected === null || prune === null),
    field('most recent', clockOf(control.lastAt), COLORS.steel),
  )
  const width = Math.max(4, columns - 18)
  for (const entry of [...control.history].slice(-3).reverse()) {
    rows.push([
      { text: ` ${clockOf(entry.at)}  `, isDim: true },
      { text: fitText(entry.text, width), color: entry.op === 'prune' ? COLORS.silver : COLORS.accent },
    ])
  }

  return rows
}

/** The dossier banner's tag: only ever `LINKED`, and only when it is true. */
export const controlLabel = (control: LocalControl): string => (seenAny(control) ? 'LOCAL CONTROL / LINKED' : '')
