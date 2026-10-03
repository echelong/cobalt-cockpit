// Local Control: the optional NobodyWho telemetry.
//
// Every test here is about restraint. The adapter's job is to report what the
// router genuinely wrote and nothing else, so the tests are mostly about what it
// must refuse to do: invent a decision, replay history, leak a prompt, or fail
// the session over a bad line.

import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_CONTROL,
  controlLabel,
  controlRows,
  cursorAt,
  drain,
  eventOf,
  flashStrength,
  fold,
  liveFlash,
  seenAny,
  stripRows,
  stripText,
  tierOf,
} from '../hooks/nwho'
import type { LocalControl } from '../hooks/nwho'

const AT = '2026-10-03T07:39:10.565+00:00'

/** A receipt shaped like the ones the router really writes. */
const receipt = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts: AT,
    operation: 'prune',
    request_id: 'abc123',
    caller: 'claude',
    provider: 'nobodywho',
    model: 'Qwen_Qwen3-4B-Q4_K_M',
    tier: 1,
    original_chars: 34_914,
    result_chars: 114,
    kept_lines: 2,
    total_lines: 2,
    latency_ms: 518,
    compression_ratio: 0.0033,
    jev_used: false,
    attempts: [{ tier: 1, provider: 'nobodywho', outcome: 'accepted', latency_ms: 510, judged_blocks: 4, dropped_blocks: 2 }],
    success: true,
    ...over,
  })

const decision = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts: AT,
    operation: 'ask',
    request_id: 'dec999',
    caller: 'claude',
    provider: 'nobodywho',
    model: 'Qwen3-14B',
    tier: 1,
    choice: 'implement',
    latency_ms: 31,
    ...over,
  })

const text = (rows: { text: string }[][]): string => rows.flat().map(one => one.text).join(' ')

describe('a receipt becomes an event only when it is real', () => {
  test('a real prune receipt parses', () => {
    const event = eventOf(receipt())
    expect(event).not.toBeNull()
    expect(event?.op).toBe('prune')
    expect(event?.tier).toBe('Q4B')
    expect(event?.latencyMs).toBe(518)
    expect(event?.proposed).toBe(4)
    expect(event?.rejected).toBe(2)
    expect(event?.accepted).toBe(2)
    expect(event?.requestId).toBe('abc123')
  })

  test('the tier vocabulary is the router own, and JEV is never named', () => {
    expect(tierOf('prune', 0)).toBe('P0')
    expect(tierOf('prune', 1)).toBe('Q4B')
    expect(tierOf('prune', 2)).toBe('9B')
    expect(tierOf('decision', 1)).toBe('0.6B')
    expect(tierOf('decision', 2)).toBe('9B')
    // Tier 3 is the JEV fallback, which this architecture has disabled.
    expect(tierOf('prune', 3)).toBeNull()
    for (const tier of [tierOf('prune', 0), tierOf('prune', 1), tierOf('prune', 2)]) expect(tier).not.toContain('JEV')
  })

  test('another caller receipt is not this session business', () => {
    expect(eventOf(receipt({ caller: 'cline' }))).toBeNull()
    expect(eventOf(receipt({ caller: 'codex' }))).toBeNull()
    expect(eventOf(receipt({ caller: 'claude' }))).not.toBeNull()
  })

  test('a malformed or truncated line is skipped, never thrown on', () => {
    for (const bad of ['', '   ', 'not json', '{"broken":', '[]', 'null', '"a string"', '{"ts":1}']) {
      expect(eventOf(bad), bad).toBeNull()
    }
  })

  test('a receipt with no id, no latency or no time is not trusted', () => {
    expect(eventOf(receipt({ request_id: undefined }))).toBeNull()
    expect(eventOf(receipt({ latency_ms: undefined }))).toBeNull()
    expect(eventOf(receipt({ ts: 'not a date' }))).toBeNull()
    expect(eventOf(receipt({ latency_ms: 'fast' }))).toBeNull()
  })

  test('an operation it does not show is not drawn', () => {
    expect(eventOf(receipt({ operation: 'whatever' }))).toBeNull()
    expect(eventOf(receipt({ operation: undefined }))).toBeNull()
  })
})

describe('a prune is never reported as a decision', () => {
  test('a prune fills only the prune half', () => {
    const event = eventOf(receipt())
    expect(event?.op).toBe('prune')
    const control = fold(EMPTY_CONTROL, [event!])
    expect(control.lastPrune).not.toBeNull()
    // The decision half stays empty, because no decision happened.
    expect(control.lastDecision).toBeNull()
  })

  test('a prune-only session shows pruning and nothing else', () => {
    const control = fold(EMPTY_CONTROL, [eventOf(receipt())!])
    const rows = controlRows(control, 100, '#0ff')
    const whole = text(rows)
    expect(whole).toContain('PRUNING tier')
    expect(whole).toContain('Q4B')
    // The decision fields are present but honestly empty.
    expect(whole).toContain('DECISION tier')
    expect(whole).toContain('not observed')
    // And no route was invented for a prune.
    expect(whole).toContain('DECISION route')
    expect(whole).not.toContain('DECISION route  IMPLEMENT')
  })

  test('a real decision fills only the decision half', () => {
    const control = fold(EMPTY_CONTROL, [eventOf(decision())!])
    expect(control.lastDecision?.tier).toBe('0.6B')
    expect(control.lastDecision?.route).toBe('IMPLEMENT')
    expect(control.lastPrune).toBeNull()
    const whole = text(controlRows(control, 100, '#0ff'))
    // The pruning half is present and honest about having judged no blocks.
    expect(whole).toContain('PRUNING tier')
    expect(whole).toContain('proposed      not observed')
  })

  test('both halves fill when both really happen', () => {
    const control = fold(EMPTY_CONTROL, [eventOf(receipt())!, eventOf(decision())!])
    expect(control.lastPrune).not.toBeNull()
    expect(control.lastDecision).not.toBeNull()
    const whole = text(controlRows(control, 100, '#0ff'))
    expect(whole).toContain('Q4B')
    expect(whole).toContain('0.6B')
    expect(whole).toContain('IMPLEMENT')
  })

  test('an abstention reports no route rather than a guess', () => {
    const event = eventOf(decision({ abstain: true }))
    expect(event?.route).toBeNull()
    expect(text(controlRows(fold(EMPTY_CONTROL, [event!]), 100, '#0ff'))).toContain('abstain')
  })
})

describe('history is never replayed onto a live session', () => {
  const ledger = [receipt(), decision(), receipt({ request_id: 'zzz', ts: '2026-10-03T08:00:00.000+00:00' })].join('\n') + '\n'

  test('the first read emits nothing at all', () => {
    // Whatever is on disk, however much of it, the first read is silent. This is
    // what stops yesterday's receipts appearing on today's HUD.
    const first = drain(ledger, cursorAt(ledger.length))
    expect(first.events).toEqual([])
    expect(first.cursor.primed).toBe(true)
  })

  test('only what arrives after the cursor is read', () => {
    const first = drain(ledger, cursorAt(ledger.length))
    const grown = ledger + receipt({ request_id: 'new1' }) + '\n'
    const second = drain(grown, { ...first.cursor, size: ledger.length })
    expect(second.events).toHaveLength(1)
    expect(second.events[0]?.requestId).toBe('new1')
  })

  test('a repeated receipt is one event, however often it is re-read', () => {
    const first = drain(ledger, cursorAt(ledger.length))
    const once = ledger + receipt({ request_id: 'dup' }) + '\n'
    const twice = once + receipt({ request_id: 'dup' }) + '\n'
    const a = drain(once, { ...first.cursor, size: ledger.length })
    const b = drain(twice, { ...a.cursor, size: once.length })
    expect(a.events.map(one => one.requestId)).toEqual(['dup'])
    expect(b.events).toEqual([])
  })

  test('a receipt still being written is held back until its line closes', () => {
    const first = drain(ledger, cursorAt(ledger.length))
    const partial = ledger + '{"ts":"2026-10-03T09:00:00.000+00:00","operation":"pru'
    const held = drain(partial, { ...first.cursor, size: ledger.length })
    expect(held.events).toEqual([])
    // Once the line closes, it is read exactly once.
    const closed = partial + 'ne","request_id":"p1","caller":"claude","tier":1,"latency_ms":9}\n'
    const done = drain(closed, { ...held.cursor, size: partial.length })
    expect(done.events.map(one => one.requestId)).toEqual(['p1'])
  })

  test('a ledger that shrank is not read from a stale offset', () => {
    const first = drain(ledger, cursorAt(ledger.length))
    const rotated = receipt({ request_id: 'after-rotate' }) + '\n'
    const after = drain(rotated, first.cursor)
    // The replacement file primes silently, so nothing from it is replayed.
    expect(after.events).toEqual([])
  })
})

describe('no telemetry means no telemetry', () => {
  test('a session with no receipt draws nothing at all', () => {
    expect(seenAny(EMPTY_CONTROL)).toBe(false)
    // Not a row, not a placeholder, not an "unavailable" line.
    expect(controlRows(EMPTY_CONTROL, 100, '#0ff')).toEqual([])
    expect(controlLabel(EMPTY_CONTROL)).toBe('')
    expect(stripRows(null, 1_000_000, 120)).toEqual([])
  })

  test('a machine with no NobodyWho at all is indistinguishable from a quiet one', () => {
    const emptyLedger = drain('', cursorAt(0))
    expect(fold(EMPTY_CONTROL, emptyLedger.events)).toEqual(EMPTY_CONTROL)
    expect(seenAny(fold(EMPTY_CONTROL, emptyLedger.events))).toBe(false)
  })

  test('once a receipt is seen, the dossier gains the section', () => {
    const control = fold(EMPTY_CONTROL, [eventOf(receipt())!])
    expect(seenAny(control)).toBe(true)
    expect(controlRows(control, 100, '#0ff').length).toBeGreaterThan(0)
    expect(controlLabel(control)).toBe('LOCAL CONTROL / LINKED')
  })
})

describe('the HUD shows NobodyWho only briefly', () => {
  const flash = { text: stripText(eventOf(receipt())!), op: 'prune' as const, at: 1_000 }

  test('a fresh receipt shows', () => {
    expect(liveFlash(flash, 1_000)).not.toBeNull()
    expect(flashStrength(flash, 1_000)).toBe(1)
    expect(stripRows(flash, 1_000, 120).length).toBe(1)
  })

  test('it fades, then it is gone', () => {
    expect(flashStrength(flash, 1_000 + 2_000)).toBeLessThan(1)
    expect(flashStrength(flash, 1_000 + 3_999)).toBeGreaterThanOrEqual(0)
    expect(liveFlash(flash, 1_000 + 4_000)).toBeNull()
    expect(flashStrength(flash, 1_000 + 4_001)).toBe(0)
    // And no row at all once it has gone: no permanent label.
    expect(stripRows(flash, 1_000 + 5_000, 120)).toEqual([])
  })

  test('reduced motion shortens the fade rather than hiding the information', () => {
    expect(liveFlash(flash, 1_000 + 500, true)).not.toBeNull()
    expect(liveFlash(flash, 1_000 + 900, true)).toBeNull()
  })

  test('a flash from the future is not drawn', () => {
    expect(liveFlash(flash, 999)).toBeNull()
    expect(stripRows(flash, 999, 120)).toEqual([])
  })

  test('a narrow band simply has no room for it', () => {
    expect(stripRows(flash, 1_000, 29)).toEqual([])
    expect(stripRows(flash, 1_000, 30).length).toBe(1)
  })

  test('the strip carries only the safe structured fields', () => {
    expect(stripText(eventOf(receipt())!)).toBe('NWHO · PRUNE · Q4B · 4→2 · 518ms')
    expect(stripText(eventOf(decision())!)).toBe('NWHO · DECISION · 0.6B · IMPLEMENT · 31ms')
    // A prune whose receipt carried no counts does not invent them.
    expect(stripText(eventOf(receipt({ attempts: [] }))!)).toBe('NWHO · PRUNE · Q4B · 518ms')
  })
})

describe('nothing sensitive can reach the screen', () => {
  // A receipt carrying every field a careless adapter might echo back: the
  // question that was asked, the working directory, the raw command, the full
  // model path and the state of the world.
  const leaky = receipt({
    question: 'what is my AWS access key in ~/.aws/credentials?',
    cwd: '/home/someone/secret-project',
    repo: '/home/someone/secret-project/.git',
    command_name: 'cat ~/.ssh/id_rsa',
    details: { prompt: 'the whole prompt text', argv: ['env'], env: { AWS_SECRET_ACCESS_KEY: 'super-secret' } },
    state: 'running',
    model: '/opt/models/private/Qwen_Qwen3-4B-Q4_K_M.gguf',
    state_detail: 'the caller was told everything',
  })

  test('the sensitive fields are never read into the event', () => {
    const event = eventOf(leaky)
    expect(event).not.toBeNull()
    const held = JSON.stringify(event)
    for (const secret of ['AWS', 'super-secret', 'id_rsa', 'credentials', 'secret-project', 'whole prompt text', 'gguf']) {
      expect(held, secret).not.toContain(secret)
    }
  })

  test('the HUD strip leaks none of them', () => {
    const shown = stripText(eventOf(leaky)!)
    for (const secret of ['AWS', 'super-secret', 'id_rsa', 'credentials', 'secret-project', 'whole prompt text', 'gguf', 'env']) {
      expect(shown, secret).not.toContain(secret)
    }
  })

  test('the dossier section leaks none of them either', () => {
    const control = fold(EMPTY_CONTROL, [eventOf(leaky)!])
    const shown = text(controlRows(control, 100, '#0ff')) + controlLabel(control) + text(controlRows(control, 100, '#0ff'))
    for (const secret of ['AWS', 'super-secret', 'id_rsa', 'credentials', 'secret-project', 'whole prompt text', 'gguf']) {
      expect(shown, secret).not.toContain(secret)
    }
  })

  test('the whole strip is exactly the five safe fields', () => {
    // Name, operation, tier, the counts, and the latency. Five things, no more.
    expect(stripText(eventOf(receipt())!)).toBe('NWHO · PRUNE · Q4B · 4→2 · 518ms')
  })

  test('a route is shown only when it is already a safe word', () => {
    expect(eventOf(decision({ choice: 'implement' }))?.route).toBe('IMPLEMENT')
    // Anything with punctuation or a space in it is not a label, so it is dropped.
    expect(eventOf(decision({ choice: 'rm -rf /' }))?.route).toBe('RMRF')
    expect(eventOf(decision({ choice: '   ' }))?.route).toBeNull()
    expect(eventOf(decision({ choice: '<script>alert(1)</script>' }))?.route).toBe('SCRIPTALERT1')
    // The raw value never survives.
    expect(JSON.stringify(eventOf(decision({ choice: '<script>alert(1)</script>' })))).not.toContain('<')
  })

  test('a very long route is bounded', () => {
    expect(eventOf(decision({ choice: 'x'.repeat(400) }))?.route).toHaveLength(12)
  })

  test('a history line carries no more than the safe strip', () => {
    const control = fold(EMPTY_CONTROL, [eventOf(leaky)!])
    for (const entry of control.history) expect(entry.text).toBe('NWHO · PRUNE · Q4B · 4→2 · 518ms')
  })
})

describe('the crawler layer draws only what the receipt carried', () => {
  test('a prune layer carries no route, and a decision layer no counts', () => {
    const prune = eventOf(receipt())!
    expect(prune.route).toBeNull()
    expect(prune.accepted).toBe(2)
    const decisionEvent = eventOf(decision())!
    expect(decisionEvent.proposed).toBeNull()
    expect(decisionEvent.rejected).toBeNull()
  })

  test('folding keeps the history bounded', () => {
    let control: LocalControl = EMPTY_CONTROL
    for (let n = 0; n < 50; n++) control = fold(control, [eventOf(receipt({ request_id: `r${n}`, ts: new Date(1_000_000 + n * 1000).toISOString() }))!])
    expect(control.history.length).toBeLessThanOrEqual(8)
    expect(control.lastAt).toBe(1_000_000 + 49 * 1000)
  })
})
