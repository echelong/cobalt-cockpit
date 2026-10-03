// The crawler, held to the only rule that matters: it may only ever show what
// the host actually reported.

import { describe, expect, test } from 'claude-code/testing'

import {
  CRAWLER_GLYPH,
  cellOf,
  crawlerForm,
  crawlerGlyph,
  crawlerGrid,
  crawlerSvg,
  layerOf,
  positionOf,
  startupOf,
  stateOf,
  STARTUP_STEPS,
  NO_NWHO,
} from '../hooks/crawler'
import type { CellGrid, CrawlerInput, Motion, Observations } from '../hooks/crawler'

const LIVE: Motion = { now: 12_345, reducedMotion: false }
const STILL: Motion = { now: 12_345, reducedMotion: true }

const crawler = (over: Partial<CrawlerInput> = {}): CrawlerInput => ({
  state: 'edit',
  progress: 0.4,
  milestones: 4,
  activity: 'EDIT',
  nwhoTier: null,
  nwhoOp: null,
  nwhoStrength: 0,
  ...over,
})

const seen = (over: Partial<Observations> = {}): Observations => ({
  phase: 'RESEARCH',
  progress: 0,
  hasTask: false,
  allGatesPassed: false,
  isDone: false,
  activity: null,
  failed: false,
  waiting: false,
  isWorking: false,
  ...over,
})

/** A grid that remembers what was painted, so "did not overwrite" is checkable. */
const gridOf = (width: number, rows = 1, seed: { code: number; fg: number } | null = null): CellGrid & { cells: Map<string, { code: number; fg: number }> } => {
  const cells = new Map<string, { code: number; fg: number }>()
  if (seed !== null) for (let x = 0; x < width; x++) cells.set(`${x},0`, seed)

  return {
    width,
    height: rows,
    cells,
    at: (x, y) => cells.get(`${x},${y}`) ?? null,
    set: (x, y, code, fg) => cells.set(`${x},${y}`, { code, fg }),
  }
}

describe('the crawler only shows what happened', () => {
  test('nothing reported, nothing shown', () => {
    expect(stateOf(seen())).toBe('idle')
  })

  test('a turn that has begun is a scan, matching the HUD glitch word', () => {
    expect(stateOf(seen({ isWorking: true }))).toBe('scan')
    expect(stateOf(seen({ activity: 'THINK' }))).toBe('scan')
  })

  test('a real failure outranks everything else', () => {
    expect(stateOf(seen({ failed: true, isWorking: true, activity: 'EDIT' }))).toBe('fault')
    expect(stateOf(seen({ failed: true, waiting: true }))).toBe('query')
  })

  test('being asked a question is a query', () => {
    expect(stateOf(seen({ waiting: true }))).toBe('query')
  })

  test('verification needs real gates: a DONE flag alone is not verified', () => {
    // Every milestone claimed, nothing verified: not verified, and not done.
    expect(stateOf(seen({ hasTask: true, isDone: true, allGatesPassed: false, phase: 'VERIFY' }))).toBe('verify')
    // A stale done flag with nothing passed at all stays honest.
    expect(stateOf(seen({ hasTask: true, isDone: true, allGatesPassed: false, phase: 'RESEARCH' }))).toBe('plan')
  })

  test('verified needs every gate passed AND the task done', () => {
    expect(stateOf(seen({ hasTask: true, allGatesPassed: true, isDone: false }))).toBe('verify')
    expect(stateOf(seen({ hasTask: true, allGatesPassed: true, isDone: true }))).toBe('verified')
  })

  test('a real test activity is a test; a real edit is an edit', () => {
    expect(stateOf(seen({ hasTask: true, activity: 'TEST' }))).toBe('test')
    expect(stateOf(seen({ hasTask: true, activity: 'BUILD' }))).toBe('test')
    expect(stateOf(seen({ hasTask: true, activity: 'EDIT' }))).toBe('edit')
    expect(stateOf(seen({ hasTask: true, activity: 'READ' }))).toBe('edit')
    expect(stateOf(seen({ hasTask: true, activity: 'PLAN' }))).toBe('plan')
  })
})
describe('the crawler never travels past real progress', () => {
  test('it is bounded to 0..1 at every width of progress', () => {
    for (const progress of [-1, -0.5, 0, 0.5, 1, 1.5, 9]) {
      for (const state of ['idle', 'edit', 'test', 'verified', 'fault'] as const) {
        const at = positionOf(progress, state, LIVE)
        expect(at, `${progress} ${state}`).toBeGreaterThanOrEqual(0)
        expect(at, `${progress} ${state}`).toBeLessThanOrEqual(1)
      }
    }
  })

  test('it is never behind the work that is really done', () => {
    // The crawler may lead by its travel offset, but never trail real progress:
    // a crawler that lags would read as "less done" than the HUD says.
    for (const progress of [0, 0.2, 0.6, 0.95, 1]) {
      for (const state of ['scan', 'plan', 'edit', 'test', 'verify'] as const) {
        expect(positionOf(progress, state, LIVE), `${progress} ${state}`).toBeGreaterThanOrEqual(Math.min(1, Math.max(0, progress)))
      }
    }
  })

  test('reduced motion parks it exactly on the progress, with no travel', () => {
    expect(positionOf(0.4, 'edit', STILL)).toBe(0.4)
    expect(positionOf(0.4, 'edit', STILL)).toBe(positionOf(0.4, 'edit', { ...STILL, now: STILL.now + 9_000 }))
    // Finished work is stationary in every mode, because there is nothing left.
    expect(positionOf(1, 'verified', LIVE)).toBe(1)
    expect(positionOf(0, 'idle', LIVE)).toBe(0)
  })

  test('the cell it lands on is always inside the track', () => {
    for (const position of [-1, 0, 0.5, 1, 2]) {
      for (const width of [1, 2, 7, 40, 85]) {
        const at = cellOf(position, width)
        expect(at).toBeGreaterThanOrEqual(0)
        expect(at).toBeLessThanOrEqual(width - 1)
      }
    }
  })
})

describe('the crawler draws without erasing the HUD', () => {
  test('by default it never overwrites a cell it does not own', () => {
    // Seeded with the track's own ink: every one of those cells must survive.
    const grid = gridOf(40, 1, { code: '━'.codePointAt(0) ?? 0, fg: 0x334455 })
    const touched = crawlerGrid(crawler(), grid, LIVE)
    expect(touched).toBe(0)
    for (const cell of grid.cells.values()) expect(cell.fg).toBe(0x334455)
  })

  test('it claims only the cells the caller offers it', () => {
    const grid = gridOf(40, 1, { code: '━'.codePointAt(0) ?? 0, fg: 0x334455 })
    grid.claims = (_x, y) => y === 0
    expect(crawlerGrid(crawler(), grid, LIVE)).toBeGreaterThan(0)
  })

  test('it paints into empty cells and reports how many', () => {
    const grid = gridOf(40)
    expect(crawlerGrid(crawler(), grid, LIVE)).toBeGreaterThan(0)
    expect(grid.cells.size).toBeGreaterThan(0)
  })

  test('the stage label still survives a painted track', () => {
    // The pill's label sits on the crawler's own background, so the crawler is
    // welcome there; the label characters themselves must come through.
    const grid = gridOf(40)
    grid.set(20, 0, 'I'.codePointAt(0) ?? 0, 0xffffff)
    crawlerGrid(crawler(), grid, LIVE)
    expect(grid.at(20, 0)).toEqual({ code: 'I'.codePointAt(0), fg: 0xffffff })
  })

  test('reduced motion still lands the core on the progress', () => {
    const still = gridOf(60)
    crawlerGrid(crawler({ state: 'edit' }), still, STILL)
    expect(still.cells.size).toBeGreaterThan(0)
    // The same state, so the same core glyph, just not rippling.
    expect([...still.cells.values()].some(cell => cell.code === CRAWLER_GLYPH.edit.codePointAt(0))).toBe(true)
  })

  test('every cell it paints is inside the grid it was given', () => {
    for (const [width, rows] of [[1, 1], [3, 1], [12, 1], [40, 1], [60, 1], [85, 1]] as [number, number][]) {
      const grid = gridOf(width, rows)
      crawlerGrid(crawler(), grid, LIVE)
      for (const key of grid.cells.keys()) {
        const [x, y] = key.split(',').map(Number) as [number, number]
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThan(width)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThan(rows)
      }
    }
  })

  test('a narrow band degrades to the glyph, then to nothing', () => {
    expect(crawlerForm(8)).toBe('none')
    expect(crawlerForm(11)).toBe('none')
    expect(crawlerForm(12)).toBe('glyph')
    expect(crawlerForm(39)).toBe('glyph')
    expect(crawlerForm(40)).toBe('body')
    expect(crawlerForm(200)).toBe('body')
  })

  test('the glyph always names the real state', () => {
    for (const state of Object.keys(CRAWLER_GLYPH) as (keyof typeof CRAWLER_GLYPH)[]) {
      expect(crawlerGlyph(crawler({ state })).glyph).toBe(CRAWLER_GLYPH[state])
    }
  })
})

describe('the desktop crawler describes itself honestly', () => {
  const box = { x: 0, y: 0, width: 320, height: 22 }

  test('its alt names the state, the real progress and the real activity', () => {
    expect(crawlerSvg(crawler({ state: 'edit', progress: 0.4, activity: 'EDIT' }), box, LIVE).alt).toBe('edit 40% EDIT')
  })

  test('with no milestones it reads --%, never a 0% that means nothing', () => {
    expect(crawlerSvg(crawler({ milestones: 0, progress: 0 }), box, LIVE).alt).toBe('edit --% EDIT')
  })

  test('it is well-formed SVG carrying that alt', () => {
    const { svg, alt } = crawlerSvg(crawler(), box, LIVE)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain(`aria-label="${alt}"`)
    expect(svg).toContain('role="img"')
  })

  test('a scan ring exists only while scanning', () => {
    // A scan ring is the one unfilled circle the crawler draws.
    expect(crawlerSvg(crawler({ state: 'scan' }), box, LIVE).svg).toContain('fill="none"')
    expect(crawlerSvg(crawler({ state: 'edit' }), box, LIVE).svg).not.toContain('fill="none"')
  })

  test('reduced motion still draws a crawler in the same place', () => {
    const still = crawlerSvg(crawler({ state: 'idle', progress: 0.6 }), box, STILL)
    const live = crawlerSvg(crawler({ state: 'idle', progress: 0.6 }), box, LIVE)
    expect(still.alt).toBe(live.alt)
    expect(still.svg).toContain('<circle')
  })

  test('a prune receipt draws dropped branches and no junction', () => {
    const layer = layerOf(crawler({ nwhoStrength: 1, nwhoOp: 'prune', nwhoTier: 'Q4B' }), 3, 1)
    const drawn = crawlerSvg(crawler({ nwhoStrength: 1, nwhoOp: 'prune' }), box, LIVE, layer)
    // The route word belongs to a decision, so a prune never prints one.
    expect(drawn.svg).not.toContain('Q4B')
    expect(drawn.svg).toContain('stroke-linecap="round"')
  })
})

describe('the NobodyWho layer needs a real receipt', () => {
  test('no live receipt draws no layer at all', () => {
    expect(layerOf(crawler({ nwhoStrength: 0, nwhoOp: 'prune' }), 2, 1)).toBe(NO_NWHO)
    expect(layerOf(crawler({ nwhoStrength: 0, nwhoOp: 'decision' }), null, null)).toBe(NO_NWHO)
  })

  test('an operation Cockpit has no receipt for draws nothing', () => {
    expect(layerOf(crawler({ nwhoStrength: 1, nwhoOp: null, nwhoTier: 'Q4B' }), 1, 1)).toBe(NO_NWHO)
  })

  test('a real prune draws exactly the branches the receipt carried', () => {
    const layer = layerOf(crawler({ nwhoStrength: 1, nwhoOp: 'prune' }), 3, 1)
    expect(layer.branches).toHaveLength(4)
    // Kept blocks stay lit; the dropped one is drawn, but not accepted.
    expect(layer.branches.filter(one => one.accepted)).toHaveLength(3)
    expect(layer.branches.filter(one => !one.accepted)).toHaveLength(1)
    // A prune decided nothing, so it lights no junction.
    expect(layer.junction.chosen).toBe(false)
  })

  test('a real decision lights a junction and never draws branches', () => {
    const layer = layerOf(crawler({ nwhoStrength: 1, nwhoOp: 'decision', nwhoTier: '0.6B' }), null, null)
    expect(layer.junction.chosen).toBe(true)
    expect(layer.junction.route).toBe('0.6B')
    expect(layer.branches).toEqual([])
  })

  test('counts the receipt did not carry draw no branches', () => {
    expect(layerOf(crawler({ nwhoStrength: 1, nwhoOp: 'prune' }), null, null).branches).toEqual([])
  })
})

describe('the startup line cannot claim a step that did not run', () => {
  test('nothing done is not active', () => {
    expect(startupOf([], false).active).toBe(false)
  })

  test('a partial sequence is active and reports the real fraction', () => {
    const startup = startupOf(['graph', 'palette'], false)
    expect(startup.active).toBe(true)
    expect(startup.progress).toBe(2 / STARTUP_STEPS.length)
    expect(startup.line).toContain('2/4')
  })

  test('a finished sequence is no longer active', () => {
    expect(startupOf([...STARTUP_STEPS], false).active).toBe(false)
    expect(startupOf([...STARTUP_STEPS], false).progress).toBe(1)
  })

  test('the first real prompt dismisses it', () => {
    expect(startupOf(['graph', 'palette', 'operator'], true).active).toBe(false)
  })

  test('a step it never ran is not counted', () => {
    expect(startupOf(['graph', 'teleport'], false).progress).toBe(1 / STARTUP_STEPS.length)
    expect(startupOf(['teleport'], false).line).not.toContain('teleport')
  })
})
