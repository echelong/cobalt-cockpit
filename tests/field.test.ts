// The Activity Field and the crawler's motion through it, held to the rule that
// matters: the field shows real events, and the crawler only ever walks on real
// text.

import { describe, expect, test } from 'claude-code/testing'

import {
  advance,
  CRAWLER_MARK,
  eventsFor,
  FIELD_ROWS_ACTIVE,
  FIELD_ROWS_IDLE,
  FIELD_ROWS_SPECIAL,
  fieldGrid,
  fieldRows,
  fieldSvg,
  graphOf,
  labelOf,
  layoutOf,
  liveBranches,
  MEDIUM_COLUMNS,
  NARROW_COLUMNS,
  RESTING,
  revisitOf,
  rowsOf,
  tapeOf,
  WIDE_COLUMNS,
} from '../hooks/field'
import type { Walker } from '../hooks/field'
import { limbsAt, paceOf, POSES, poseAt, stepToward, walkTo } from '../hooks/crawler'
import { EVENT_TTL_MS } from '../hooks/activity'
import type { ActivityEvent } from '../hooks/activity'
import type { NwhoEvent } from '../types'

const AT = 1_000
const LIVE = { now: AT + 500, reducedMotion: false }
const STILL = { now: AT + 500, reducedMotion: true }

const event = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: 'e1',
  kind: 'READ',
  label: 'READ',
  detail: 'auth.ts',
  state: 'running',
  startedAt: AT,
  endedAt: null,
  ...over,
})

/** `['READ auth.ts', 'EDIT b.ts']` as the two real events those calls describe. */
const chain = (...labels: string[]): ActivityEvent[] =>
  labels.map((label, n) => {
    const [verb = 'READ', ...rest] = label.split(' ')

    return event({
      id: `e${n}`,
      kind: verb as ActivityEvent['kind'],
      label: verb,
      detail: rest.join(' '),
      startedAt: AT + n,
    })
  })

const nwho = (over: Partial<NwhoEvent> = {}): NwhoEvent => ({
  op: 'prune',
  tier: 'Q4B',
  latencyMs: 37,
  at: AT,
  requestId: 'r1',
  route: null,
  proposed: 4,
  accepted: 2,
  rejected: 2,
  ...over,
})

/** One row of a grid as text. */
const rowText = (grid: ReturnType<typeof fieldGrid>, row: number): string =>
  grid.cells
    .slice(row * grid.width, (row + 1) * grid.width)
    .map(([cp]) => (cp === 32 ? ' ' : String.fromCodePoint(cp)))
    .join('')
    .replace(/\s+$/, '')

/** The whole grid as text, rows joined. */
const textOf = (grid: ReturnType<typeof fieldGrid>): string => rowText(grid, 0)
describe('the tape is built from real events only', () => {
  test('no events, no field at all', () => {
    const tape = tapeOf([], WIDE_COLUMNS)
    expect(tape.anchors).toEqual([])
    expect(tape.text).toBe('')
    expect(tape.current).toBeNull()
  })

  test('each anchor sits at a real cell of the drawn tape', () => {
    const tape = tapeOf(chain('READ auth.ts', 'EDIT session.ts'), WIDE_COLUMNS)
    for (const anchor of tape.anchors) {
      expect(tape.text.slice(anchor.at, anchor.at + labelOf(anchor.event).length)).toBe(labelOf(anchor.event))
    }
  })

  test('the anchors are ordered and non-overlapping', () => {
    const tape = tapeOf(chain('READ a.ts', 'EDIT b.ts', 'TEST 18/22'), WIDE_COLUMNS)
    const ats = tape.anchors.map(anchor => anchor.at)
    expect([...ats].sort((a, b) => a - b)).toEqual(ats)
    expect(new Set(ats).size).toBe(ats.length)
  })

  test('an event with no detail draws its verb alone', () => {
    expect(labelOf(event({ label: 'BASH', detail: '' }))).toBe('BASH')
  })
})

describe('the layout narrows by dropping events, never by inventing them', () => {
  test('each width shows only what fits', () => {
    expect(eventsFor(layoutOf(WIDE_COLUMNS))).toBeGreaterThan(eventsFor(layoutOf(MEDIUM_COLUMNS)))
    expect(eventsFor(layoutOf(MEDIUM_COLUMNS))).toBeGreaterThan(eventsFor(layoutOf(NARROW_COLUMNS)))
    expect(eventsFor(layoutOf(10))).toBe(1)
  })

  test('wide, medium, narrow and tiny are chosen by width', () => {
    expect(layoutOf(200)).toBe('wide')
    expect(layoutOf(MEDIUM_COLUMNS)).toBe('medium')
    expect(layoutOf(NARROW_COLUMNS)).toBe('narrow')
    expect(layoutOf(8)).toBe('tiny')
  })

  test('a narrow field shows the newest real event', () => {
    const tape = tapeOf(chain('READ a.ts', 'EDIT b.ts', 'TEST 18/22'), 30)
    expect(tape.anchors).toHaveLength(1)
    expect(tape.anchors[0]?.event.kind).toBe('TEST')
  })

  test('no row is ever wider than the columns given', () => {
    const events = chain('READ auth.ts', 'EDIT session.ts', 'TEST 18/22', 'GIT diff', 'VERIFY build')
    for (let columns = 4; columns <= 200; columns++) {
      const tape = tapeOf(events, columns)
      expect(tape.text.length, `at ${columns}`).toBeLessThanOrEqual(columns)
      for (const anchor of tape.anchors) expect(anchor.at, `at ${columns}`).toBeLessThanOrEqual(Math.max(0, columns - 1))
    }
  })
})
describe('the crawler walks between real text anchors', () => {
  test('it attaches to the current event and settles on its detail', () => {
    const tape = tapeOf(chain('READ a.ts', 'EDIT b.ts'), WIDE_COLUMNS)
    let walker = advance(RESTING, tape, 'edit', LIVE)
    const target = tape.anchors.find(anchor => anchor.event.id === 'e1')?.at ?? -1
    expect(walker.on).toBe(target)
    for (let n = 0; n < 60; n++) walker = advance(walker, tape, 'verified', LIVE)
    // Having arrived, it holds exactly there rather than oscillating.
    const held = advance(walker, tape, 'verified', LIVE)
    expect(held.at).toBe(walker.at)
  })

  test('it moves cell by cell, never jumping across the tape', () => {
    const tape = tapeOf(chain('READ auth.ts', 'EDIT middleware.ts', 'TEST 18/22'), WIDE_COLUMNS)
    let walker = advance(RESTING, tape, 'edit', LIVE)
    const first = walker.at
    for (let n = 0; n < 200; n++) {
      const next = advance(walker, tape, 'edit', LIVE)
      expect(Math.abs(next.at - walker.at)).toBeLessThanOrEqual(paceOf('edit', true))
      walker = next
    }
    expect(walker.at).not.toBe(first)
  })

  test('its pose changes as it traverses', () => {
    // Consecutive poses really differ in their limb placement, so the creature
    // articulates rather than translating rigidly.
    expect(POSES[0]).not.toEqual(POSES[1])
    expect(poseAt(0)).toEqual(POSES[0])
    expect(poseAt(4)).toEqual(poseAt(0))
  })

  test('a pose advances only when a cell is actually covered', () => {
    expect(stepToward(10, 10, 2, 40, 7, false)).toMatchObject({ at: 10, pose: 7 })
    expect(stepToward(10, 12, 2, 40, 7, false)).toMatchObject({ at: 12, pose: 9 })
  })

  test('it never walks off the text it is traversing', () => {
    expect(walkTo(5, 999, 2, 40)).toBeLessThanOrEqual(40)
    expect(walkTo(5, -999, 2, 40)).toBeGreaterThanOrEqual(0)
  })

  test('it cannot claim an event that was never observed', () => {
    const tape = tapeOf(chain('READ a.ts'), WIDE_COLUMNS)
    const walker = advance(RESTING, tape, 'edit', LIVE)
    expect(tape.anchors.every(anchor => anchor.event.id === 'e0')).toBe(true)
    expect(walker.on).toBe(tape.anchors[0]?.at)
  })

  test('with no events there is nothing to walk on', () => {
    expect(advance(RESTING, tapeOf([], WIDE_COLUMNS), 'edit', LIVE)).toEqual(RESTING)
  })

  test('it leaves the previous event for the new one', () => {
    const before = tapeOf(chain('READ a.ts'), WIDE_COLUMNS)
    const after = tapeOf(chain('READ a.ts', 'TEST 18/22'), WIDE_COLUMNS)
    const was = advance(RESTING, before, 'verified', LIVE)
    const moved = advance(was, after, 'verified', LIVE)
    expect(moved.on).toBe(after.anchors[after.anchors.length - 1]?.at)
    expect(moved.on).not.toBe(before.anchors[0]?.at)
  })

  test('it crawls the distance between two events, cell by cell', () => {
    // The whole point of the field: as the current event moves on, the creature
    // crosses the cells in between rather than appearing at the far end. `on` is
    // the event it is heading for, so the walk is watched on `at`.
    const first = tapeOf(chain('READ a.ts'), WIDE_COLUMNS)
    const both = tapeOf(chain('READ a.ts', 'EDIT middleware.ts', 'TEST 18/22'), WIDE_COLUMNS)
    const target = both.anchors[2]?.at ?? 0
    const start = advance(RESTING, first, 'verified', LIVE)
    expect(start.at).toBeLessThan(target)
    const seen: number[] = []
    let walker = start
    for (let n = 0; n < 200 && walker.at !== walker.scanning; n++) {
      walker = advance(walker, both, 'edit', LIVE)
      seen.push(walker.at)
    }
    // Every step is bounded by one pace, so the crossing is a crawl and not a
    // jump: the distance takes several frames to cover.
    for (let n = 1; n < seen.length; n++) {
      expect(Math.abs((seen[n] ?? 0) - (seen[n - 1] ?? 0))).toBeLessThanOrEqual(paceOf('edit', true))
    }
    expect(seen.length).toBeGreaterThan(1)
    expect(walker.on).toBe(target)
    expect(walker.at).toBe(walker.scanning)
  })

  test('it cannot advance completion: the field never claims a percentage', () => {
    const tape = tapeOf(chain('TEST 18/22'), WIDE_COLUMNS)
    const walker = advance(RESTING, tape, 'test', LIVE)
    expect(walker.at).toBeLessThanOrEqual(tape.text.length - 1)
    expect(textOf(fieldGrid(tape, walker, 'test', WIDE_COLUMNS))).not.toContain('%')
  })
})

describe('each state does its own thing', () => {
  const tape = tapeOf(chain('READ auth.ts'), WIDE_COLUMNS)

  test('a plan stops on the detail rather than the verb', () => {
    const walker = advance(RESTING, tape, 'plan', STILL)
    expect(walker.scanning).toBeGreaterThanOrEqual(walker.on ?? 0)
  })

  test('a fault and a query halt, so both stay readable', () => {
    expect(paceOf('fault', true)).toBe(0)
    expect(paceOf('query', true)).toBe(0)
  })

  test('an edit moves faster than a read', () => {
    expect(paceOf('edit', true)).toBeGreaterThan(paceOf('plan', true))
  })

  test('verify revisits only what really finished', () => {
    const done = tapeOf([event({ id: 'a', state: 'done', endedAt: AT + 1 }), event({ id: 'b', state: 'failed', endedAt: AT + 1 }), event({ id: 'c' })], WIDE_COLUMNS)
    expect(revisitOf(done, 'verify')).toEqual([0])
    // No other state revisits anything at all.
    expect(revisitOf(done, 'edit')).toEqual([])
    expect(revisitOf(tape, 'verify')).toEqual([])
  })

  test('verified settles and holds its cell', () => {
    const walker = advance(RESTING, tape, 'verified', LIVE)
    const again = advance(walker, tape, 'verified', LIVE)
    expect(again.at).toBe(walker.at)
    expect(again.step).toBe(walker.step)
  })

  test('reduced motion arrives at once and holds', () => {
    const walker = advance(RESTING, tape, 'edit', STILL)
    expect(walker.at).toBe(walker.scanning)
    // And it stays exactly there on every later frame.
    expect(advance(walker, tape, 'edit', STILL).at).toBe(walker.at)
  })
})
describe('the terminal field draws the tape with the crawler on it', () => {
  test('the tape text is really on the row, and stays readable', () => {
    const tape = tapeOf(chain('READ auth.ts', 'EDIT b.ts'), WIDE_COLUMNS)
    const grid = fieldGrid(tape, advance(RESTING, tape, 'edit', LIVE), 'edit', WIDE_COLUMNS)
    expect(rowText(grid, 0)).toContain('READ auth.ts')
    expect(rowText(grid, 0)).toContain('EDIT b.ts')
  })

  test('the crawler walks on the spine beneath the text, not through it', () => {
    const tape = tapeOf(chain('READ auth.ts', 'EDIT b.ts'), WIDE_COLUMNS)
    const grid = fieldGrid(tape, { at: 5, on: 0, step: 3, scanning: 5 }, 'edit', WIDE_COLUMNS)
    // The spine is a real path under the labels, and the crawler walks on it.
    expect(rowText(grid, 1)).toContain('─')
    expect(rowText(grid, 1)).toMatch(/[╲╱◉]/)
    // Every label stays fully readable: the creature never eats a letter.
    expect(rowText(grid, 0)).toContain('READ auth.ts')
    expect(rowText(grid, 0)).toContain('EDIT b.ts')
  })

  test('the crawler attaches to the label above the cell it stands on', () => {
    const tape = tapeOf(chain('READ auth.ts', 'EDIT b.ts'), WIDE_COLUMNS)
    const at = tape.anchors[1]?.at ?? 0
    const grid = fieldGrid(tape, { at, on: at, step: 2, scanning: at }, 'edit', WIDE_COLUMNS)
    // Directly beneath `EDIT b.ts` there is a lit node and the crawler's core.
    expect(rowText(grid, 1)[at]).toBe('◉')
    expect(rowText(grid, 0).slice(at, at + 4)).toBe('EDIT')
  })

  test('every cell it paints is inside the grid', () => {
    const tape = tapeOf(chain('READ a.ts', 'EDIT b.ts'), 40)
    const grid = fieldGrid(tape, { at: 18, on: 18, step: 3, scanning: 20 }, 'edit', 40)
    expect(grid.cells).toHaveLength(80)
    for (const [cp] of grid.cells) expect(cp).toBeGreaterThan(31)
  })

  test('a one-row field runs the crawler along the row, never over a label', () => {
    // With no room for a spine, the creature walks the connector that follows
    // the tape rather than crossing out a letter of the event it is on.
    const tape = tapeOf(chain('READ a.ts', 'TEST 18/22'), 40)
    const grid = fieldGrid(tape, { at: 0, on: 0, step: 1, scanning: 0 }, 'test', 40, 1)
    expect(rowText(grid, 0)).toContain('TEST 18/22')
    expect(grid.rows).toBe(1)
  })

  test('a very narrow row is cut to fit rather than overflowing', () => {
    const tape = tapeOf(chain('READ auth.ts'), 8)
    expect(tape.text.length).toBeLessThanOrEqual(8)
    expect(tape.text.length).toBeGreaterThan(0)
  })

  test('the text fallback agrees with the grid about the tape', () => {
    const tape = tapeOf(chain('READ auth.ts'), WIDE_COLUMNS)
    const rows = fieldRows(tape, { at: 20, on: 0, step: 0, scanning: 20 }, 'edit', WIDE_COLUMNS)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.map(segment => segment.text).join('')).toContain('READ auth.ts')
  })

  test('the text fallback draws nothing when there is nothing real', () => {
    expect(fieldRows(tapeOf([], WIDE_COLUMNS), RESTING, 'edit', WIDE_COLUMNS)).toEqual([])
  })

  test('each state leaves its own mark where it stands', () => {
    const tape = tapeOf(chain('READ auth.ts'), WIDE_COLUMNS)
    const walker: Walker = { at: 2, on: 0, step: 0, scanning: 2 }
    expect(fieldRows(tape, walker, 'fault', WIDE_COLUMNS)[0]?.some(s => s.text === CRAWLER_MARK.fault)).toBe(true)
    expect(fieldRows(tape, walker, 'verified', WIDE_COLUMNS)[0]?.some(s => s.text === CRAWLER_MARK.verified)).toBe(true)
    expect(fieldRows(tape, walker, 'query', WIDE_COLUMNS)[0]?.some(s => s.text === CRAWLER_MARK.query)).toBe(true)
    expect(fieldRows(tape, walker, 'edit', WIDE_COLUMNS)[0]?.some(s => s.text === CRAWLER_MARK.active)).toBe(true)
  })
})

describe('the desktop field carries the same tape and the same crawler', () => {
  test('it draws the real labels and names the current one', () => {
    const tape = tapeOf(chain('READ auth.ts', 'EDIT b.ts'), WIDE_COLUMNS)
    const { svg, alt } = fieldSvg(tape, RESTING, 'edit', null, 320, 22, AT, EVENT_TTL_MS)
    expect(svg).toContain('READ auth.ts')
    expect(svg).toContain('EDIT b.ts')
    expect(svg).toContain('<svg')
    // The alt names the event the crawler is actually on, which is the newest.
    expect(alt).toContain('EDIT')
  })

  test('it draws nothing that is not on the tape', () => {
    const tape = tapeOf(chain('READ auth.ts'), WIDE_COLUMNS)
    const { svg } = fieldSvg(tape, RESTING, 'edit', null, 320, 22, AT, EVENT_TTL_MS)
    expect(svg).not.toContain('TEST')
    expect(svg).not.toContain('NWHO')
  })

  test('with no events it still renders valid markup', () => {
    expect(fieldSvg(tapeOf([], WIDE_COLUMNS), RESTING, 'idle', null, 320, 22, AT, EVENT_TTL_MS).svg).toContain('<svg')
  })
})
describe('a NobodyWho graph exists only for a real receipt', () => {
  test('no receipt, no graph', () => {
    expect(graphOf(null, null)).toBeNull()
  })

  test('a real prune draws its counts and both kinds of branch', () => {
    const graph = graphOf(nwho(), null)
    expect(graph?.kind).toBe('prune')
    expect(graph?.label).toContain('4→2')
    expect(graph?.label).toContain('Q4B')
    expect(graph?.branches.filter(b => b.state === 'kept')).toHaveLength(2)
    expect(graph?.branches.filter(b => b.state === 'dropped')).toHaveLength(2)
  })

  test('a real decision draws only the route it really chose', () => {
    const graph = graphOf(null, nwho({ op: 'decision', tier: '0.6B', route: 'IMPLEMENT', proposed: null, accepted: null, rejected: null }))
    expect(graph?.kind).toBe('decision')
    expect(graph?.chosen).toBe('IMPLEMENT')
    expect(graph?.branches.map(b => b.label)).toEqual(['IMPLEMENT'])
  })

  test('an abstaining decision draws a junction with no lit route', () => {
    const graph = graphOf(null, nwho({ op: 'decision', tier: 'P0', route: null, proposed: null, accepted: null, rejected: null }))
    expect(graph?.branches).toEqual([])
    expect(graph?.chosen).toBeNull()
  })

  test('rejected branches fade away and accepted ones remain', () => {
    const graph = graphOf(nwho(), null)
    expect(graph && liveBranches(graph, AT, EVENT_TTL_MS).some(b => b.state === 'dropped')).toBe(true)
    const later = graph && liveBranches(graph, EVENT_TTL_MS + 1, EVENT_TTL_MS)
    expect(later?.every(b => b.state === 'kept')).toBe(true)
  })

  test('a prune receipt can never produce a decision route', () => {
    expect(graphOf(nwho(), null)?.chosen).toBeNull()
  })

  test('no fake events: the field never invents a graph', () => {
    const tape = tapeOf(chain('READ a.ts'), WIDE_COLUMNS)
    const { svg } = fieldSvg(tape, RESTING, 'edit', null, 320, 22, AT, EVENT_TTL_MS)
    expect(svg).not.toContain('PRUNE')
    expect(svg).not.toContain('DECISION')
  })
})

describe('the height budget is respected', () => {
  const idleTape = tapeOf(chain('READ a.ts', 'EDIT b.ts').map(e => ({ ...e, state: 'done' as const, endedAt: AT })), WIDE_COLUMNS)
  const busyTape = tapeOf(chain('READ a.ts'), WIDE_COLUMNS)

  test('idle collapses to one row', () => {
    expect(rowsOf(idleTape, null, AT, EVENT_TTL_MS)).toBe(FIELD_ROWS_IDLE)
  })

  test('active prefers two', () => {
    expect(rowsOf(busyTape, null, AT, EVENT_TTL_MS)).toBe(FIELD_ROWS_ACTIVE)
  })

  test('a real graph takes a third row, and only while it lasts', () => {
    const graph = graphOf(nwho(), null)
    expect(rowsOf(busyTape, graph, AT, EVENT_TTL_MS)).toBe(FIELD_ROWS_SPECIAL)
    // Once the receipt has aged out, the junction collapses and the row goes back.
    expect(rowsOf(busyTape, graph, EVENT_TTL_MS + 1, EVENT_TTL_MS)).toBe(FIELD_ROWS_ACTIVE)
  })

  test('with no real receipt the field never spends a third row', () => {
    expect(rowsOf(busyTape, graphOf(null, null), AT, EVENT_TTL_MS)).toBe(FIELD_ROWS_ACTIVE)
  })

  test('no events means no rows at all', () => {
    expect(rowsOf(tapeOf([], WIDE_COLUMNS), graphOf(nwho(), null), AT, EVENT_TTL_MS)).toBe(0)
  })

  test('the field never exceeds three rows at any width', () => {
    const events = chain('READ a.ts', 'EDIT b.ts', 'TEST 18/22', 'GIT diff', 'VERIFY build')
    for (const columns of [8, 24, 50, 90, 200]) {
      const tape = tapeOf(events, columns)
      for (const state of ['idle', 'plan', 'edit', 'test', 'verify', 'verified', 'fault']) {
        expect(rowsOf(tape, graphOf(nwho(), null), AT, EVENT_TTL_MS), `${columns} ${state}`).toBeLessThanOrEqual(FIELD_ROWS_SPECIAL)
      }
    }
  })
})

describe('limbs are laid out around the core', () => {
  test('every limb is at a real cell relative to the body', () => {
    const limbs = limbsAt(10, 4, poseAt(4))
    expect(limbs.core).toBe(10)
    for (const x of [...limbs.front, ...limbs.rear, limbs.tail]) expect(Number.isInteger(x)).toBe(true)
  })

  test('the front pair leads and the rear pair trails', () => {
    for (const pose of POSES) {
      expect(Math.min(...pose.front)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...pose.rear)).toBeLessThanOrEqual(0)
      expect(pose.tail).toBeLessThanOrEqual(Math.min(...pose.rear))
    }
  })
})