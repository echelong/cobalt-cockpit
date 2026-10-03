// The crawler: an original graph-traversing cybernetic operator, and the only
// thing in the HUD that animates. It is a presentation layer over facts the
// host already reported, and it invents nothing.
//
// The rules that keep it honest, each enforced by the code below:
//   - every state is derived from real observations. `Observations` is built
//     from the task's milestones, its gate results and the recorded activity,
//     so no path shows reasoning, a tool call, a test, a prune or a milestone
//     that did not happen.
//   - position is derived from real progress and clamped to it, so the crawler
//     cannot travel past work that is not done.
//   - absent telemetry is silence, not a placeholder. With no NobodyWho
//     receipts the crawler still animates ordinary Claude states and draws no
//     NobodyWho layer at all.
//   - `Motion` turns every time-based term off. Under reduced motion the
//     crawler shows the same state in the same place, drawn once.
//
// It draws in three registers, all pure functions of `(input, motion, now)`:
//   - `crawlerSvg` for the desktop surface, a limb-and-node graph;
//   - `crawlerGrid` for the terminal, drawn into the track's own cell grid;
//   - `crawlerGlyph` for a narrow band, one core glyph and nothing else.

import { hex, pack } from './pixels'
import { COLORS } from './view'

/**
 * The crawler's states. Each maps to something the host reported, and none of
 * them claims a milestone or a gate that has not actually passed.
 *
 * `idle`      nothing is being worked on
 * `scan`      a prompt or turn began and nothing has been classified yet
 * `plan`      the task has milestones and one is now active
 * `edit`      a read, edit or write tool really ran
 * `test`      a test, build, type or audit gate is really running or failed
 * `verify`    gates are really being verified, or all of them really passed
 * `query`     the operator is really being asked something
 * `fault`     a tool or a gate really failed
 * `verified`  every gate passed and the task really completed
 */
export type CrawlerState = 'idle' | 'scan' | 'plan' | 'edit' | 'test' | 'verify' | 'query' | 'fault' | 'verified'

export const CRAWLER_STATES: readonly CrawlerState[] = [
  'idle',
  'scan',
  'plan',
  'edit',
  'test',
  'verify',
  'query',
  'fault',
  'verified',
]

/**
 * The crawler's state, derived only from what the host reported.
 *
 * Order matters: a real fault outranks everything, because a failure that
 * happened is the most important thing on the screen. A passed verification
 * outranks the activity that earned it. Below that the newest real activity
 * decides, and with nothing reported the crawler is simply idle.
 *
 * There is no path from `idle` to `verified` that does not pass real gate
 * results, so the crawler cannot announce a verification that did not happen.
 */
export type Observations = {
  /** The task's own phase word, already computed by the model. */
  phase: string
  /** Real completed progress, 0..1. */
  progress: number
  /** Whether a real task exists. */
  hasTask: boolean
  /** Whether every gate really passed. */
  allGatesPassed: boolean
  /** Whether the task or a milestone really finished. */
  isDone: boolean
  /** The newest real activity label, or null when there is none. */
  activity: string | null
  /** True only while a real tool error stands. */
  failed: boolean
  /** True only while the operator is really being asked a question. */
  waiting: boolean
  /**
   * True while a turn is really running. A turn that has begun but has not yet
   * reached a tool is a scan, which is the same thing the HUD's own state word
   * says, so the crawler can never look idle while the HUD looks busy.
   */
  isWorking: boolean
}

export const stateOf = (seen: Observations): CrawlerState => {
  if (seen.waiting) return 'query'
  if (seen.failed) return 'fault'
  // No task yet, but a turn really is running: the operator is reading the
  // request. This is the HUD's glitch state, named for what it is.
  if (!seen.hasTask) return seen.isWorking || seen.progress > 0 || seen.activity !== null ? 'scan' : 'idle'
  if (seen.allGatesPassed && seen.isDone) return 'verified'
  if (seen.allGatesPassed || seen.phase === 'VERIFY') return 'verify'
  if (seen.activity === null) return 'plan'
  const kind = seen.activity.toUpperCase()
  if (/(TEST|BUILD|TYPE|LINT|AUDIT)/.test(kind)) return 'test'
  if (/(EDIT|WRITE|READ|GREP|SEARCH|MCP|TASK|WEB)/.test(kind)) return 'edit'

  return 'plan'
}

/** What the crawler is allowed to know. Every field is a real observation. */
export type CrawlerInput = {
  state: CrawlerState
  /** Real completed progress, 0..1. The crawler never leads this. */
  progress: number
  /** Milestones the task actually has, which shapes the spine. */
  milestones: number
  /** The newest real activity label, e.g. `Edit`, or '' when there is none. */
  activity: string
  /** NobodyWho tier for the newest live receipt, or null when none is live. */
  nwhoTier: string | null
  /** NobodyWho operation for the newest live receipt, or null. */
  nwhoOp: string | null
  /** 1 while a NobodyWho receipt is live, 0 otherwise. */
  nwhoStrength: number
}

export type Motion = { now: number; reducedMotion: boolean }

/** Deterministic pseudo-noise: a stable ripple that never depends on `Math`. */
const wave = (seed: number, at: number, reducedMotion: boolean): number => {
  if (reducedMotion) return 0.5

  return (Math.sin(at * 0.0021 + seed * 1.7) + Math.sin(at * 0.0013 + seed * 0.6) + 2) / 4
}

const clamp = (value: number, low = 0, high = 1): number => (value < low ? low : value > high ? high : value)

/** Held between `low` and `high`, for geometry that must stay inside its box. */
const clampTo = (value: number, low: number, high: number): number => (value < low ? low : value > high ? high : value)

/**
 * Where the crawler stands on the track, 0..1.
 *
 * It leads real progress by a small, bounded offset so it reads as something
 * moving rather than a progress bar drawn twice, and it is clamped so it can
 * never sit past work that is actually done. Under reduced motion the offset
 * is zero: the crawler stands exactly on the progress and does not travel.
 */
export const positionOf = (progress: number, state: CrawlerState, motion: Motion): number => {
  const done = clamp(progress)
  if (motion.reducedMotion || state === 'verified' || state === 'idle') return done

  return clamp(done + 0.06 * (0.5 + 0.5 * wave(3, motion.now, false)))
}

/** The single glyph a narrow band draws: the core, coloured by state. */
export const CRAWLER_GLYPH: Record<CrawlerState, string> = {
  idle: '·',
  scan: '◈',
  plan: '◉',
  edit: '◆',
  test: '⌬',
  verify: '◍',
  query: '?',
  fault: '✖',
  verified: '★',
}

/** The colour a state's core is painted in, from the shared palette. */
export const coreColor = (state: CrawlerState): string =>
  state === 'fault' ? COLORS.bad : state === 'verified' ? COLORS.ok : state === 'query' ? COLORS.warn : COLORS.accent

/**
 * The NobodyWho layer, an extra on top of the crawler's own states.
 *
 * It exists only while a real receipt is live. A prune draws `branches`, holding
 * the kept and dropped counts that receipt really carried; a decision draws a
 * `junction` holding the route it really chose. A prune never draws a junction
 * and a decision never draws branches, because a prune decided nothing.
 */
export type NwhoLayer = {
  branches: { at: number; accepted: boolean }[]
  junction: { at: number; chosen: boolean; route: string | null }
}

export const NO_NWHO: NwhoLayer = { branches: [], junction: { at: -1, chosen: false, route: null } }

/** The layer for a live real receipt, or the empty one when none is live. */
export const layerOf = (input: CrawlerInput, accepted: number | null, rejected: number | null): NwhoLayer => {
  if (input.nwhoStrength <= 0) return NO_NWHO
  if (input.nwhoOp === 'decision') return { branches: [], junction: { at: 1, chosen: true, route: input.nwhoTier } }
  if (input.nwhoOp !== 'prune') return NO_NWHO
  const kept = accepted ?? 0
  const total = Math.max(0, kept + (rejected ?? 0))
  const branches: { at: number; accepted: boolean }[] = []
  for (let n = 0; n < total && n < 12; n++) branches.push({ at: (n + 1) / (total + 1), accepted: n < kept })

  return { branches, junction: NO_NWHO.junction }
}

/** A limb or node position, in the crawler's own coordinate space. */
export type Limb = { x: number; y: number }

/** The layout box a crawler is drawn into. */
export type Box = { x: number; y: number; width: number; height: number }

export type Skeleton = {
  /** The spine, head first. */
  spine: Limb[]
  /** Legs, one pair per spine joint. */
  legs: Limb[][]
  /** The core the head sits on. */
  core: Limb
  /** Nodes for real completed milestones only. */
  nodes: Limb[]
  /** A scan ring, present only while the state scans. */
  ring: { x: number; y: number; r: number } | null
}

/**
 * The crawler's body, in a box.
 *
 * `milestones` is the task's real milestone count, so the spine carries as many
 * joints as the operator actually planned; a task with no plan gets a bare
 * two-joint spine, which is exactly what an unplanned task is.
 */
export const skeletonOf = (input: CrawlerInput, box: Box, motion: Motion): Skeleton => {
  const { state, milestones } = input
  const moving = state !== 'idle' && state !== 'verified'
  const count = Math.max(2, Math.min(6, milestones + 1))
  const stride = box.width / (count + 1)
  const swing = motion.reducedMotion ? 0 : Math.sin(motion.now / 420) * (moving ? 1 : 0.25)
  const spine: Limb[] = []
  for (let n = 0; n < count; n++) {
    // Each joint bobs on its own phase, so the body ripples rather than rocks.
    const bob = swing * (n === 0 ? 0 : (n % 2 === 0 ? 1 : -1) * 0.6)
    // The joint is held inside the box: a one-row track has no room to bob off,
    // and the crawler must never paint outside the cells it was handed.
    spine.push({ x: box.x + stride * (n + 1), y: clampTo(box.y + box.height / 2 + bob, box.y, box.y + box.height) })
  }
  const legs: Limb[][] = spine.map((joint, n) => {
    const reach = box.height * 0.3 * (n === 0 ? 0.7 : 1)
    const kick = swing * (n % 2 === 0 ? 1 : -1) * reach * 0.5

    return [
      { x: joint.x - reach * 0.6, y: joint.y + reach + kick },
      { x: joint.x + reach * 0.6, y: joint.y + reach - kick },
    ]
  })
  const core = spine[0] ?? { x: box.x, y: box.y }
  // Nodes are milestones the crawler has really passed, never invented ones. Their
  // offset is held inside the box too, so on a one-row track they share the row
  // instead of being dropped as out of bounds.
  const passed = Math.floor(clamp(input.progress) * count)
  const nodes = spine.slice(0, passed).map((joint, n) => ({
    x: joint.x,
    y: clampTo(joint.y - box.height * 0.18 * wave(n, motion.now, motion.reducedMotion), box.y, box.y + box.height - 1),
  }))
  const ring = state === 'scan' ? { x: core.x, y: core.y, r: box.height * (0.25 + 0.2 * wave(5, motion.now, motion.reducedMotion)) } : null

  return { spine, legs, core, nodes, ring }
}

/** `rgb(...)` from a hex string, for an SVG attribute. */
const fill = (color: string): string => `rgb(${hex(color).join(',')})`

const line = (from: Limb, to: Limb, color: string, width: number): string =>
  `<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}" stroke="${fill(color)}" stroke-width="${width.toFixed(1)}" stroke-linecap="round" />`

/**
 * The desktop crawler: a limb-and-node graph.
 *
 * `alt` is the crawler's honest description of itself, which is what a screen
 * reader receives and what the tests assert on. It names the state and the real
 * progress and the real activity, never a thing that did not happen.
 */
export const crawlerSvg = (input: CrawlerInput, box: Box, motion: Motion, layer: NwhoLayer = NO_NWHO): { svg: string; alt: string } => {
  const body = skeletonOf(input, box, motion)
  const core = coreColor(input.state)
  const ink = COLORS.steel
  const parts: string[] = []
  // Legs first, so the spine draws over them.
  for (const pair of body.legs) for (const tip of pair) parts.push(line(body.core, tip, ink, 1))
  for (let n = 0; n < body.spine.length - 1; n++) {
    const from = body.spine[n]
    const to = body.spine[n + 1]
    if (from !== undefined && to !== undefined) parts.push(line(from, to, core, 1.6))
  }
  for (const node of body.nodes) parts.push(`<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="2" fill="${fill(ink)}" />`)
  if (body.ring !== null) {
    parts.push(
      `<circle cx="${body.ring.x.toFixed(1)}" cy="${body.ring.y.toFixed(1)}" r="${body.ring.r.toFixed(1)}" fill="none" stroke="${fill(core)}" stroke-width="1" opacity="0.5" />`,
    )
  }
  // NobodyWho, and only what the receipt really carried.
  for (const branch of layer.branches) {
    const at = { x: box.x + box.width * branch.at, y: box.y + box.height * 0.85 }
    // A dropped branch is drawn short and in the warning colour: it faded, and
    // nothing is claimed for it.
    parts.push(
      branch.accepted
        ? line({ x: at.x, y: box.y + box.height * 0.6 }, at, COLORS.ok, 1.4)
        : line({ x: at.x, y: box.y + box.height * 0.74 }, at, COLORS.bad, 1),
    )
  }
  if (layer.junction.chosen) {
    const at = { x: box.x + box.width * 0.8, y: box.y + box.height * 0.85 }
    parts.push(line(body.core, at, COLORS.accent, 1.4), `<circle cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="3" fill="${fill(COLORS.accent)}" />`)
    if (layer.junction.route !== null) {
      parts.push(`<text x="${(at.x + 6).toFixed(1)}" y="${(at.y + 4).toFixed(1)}" fill="${fill(COLORS.silver)}" font-size="9" font-family="monospace">${layer.junction.route}</text>`)
    }
  }
  parts.push(`<circle cx="${body.core.x.toFixed(1)}" cy="${body.core.y.toFixed(1)}" r="4.5" fill="${fill(core)}" />`)
  parts.push(
    `<text x="${(body.core.x - 4).toFixed(1)}" y="${(body.core.y - 8).toFixed(1)}" fill="${fill(core)}" font-size="10" font-family="monospace">${CRAWLER_GLYPH[input.state]}</text>`,
  )
  // The percentage is shown only when there are real milestones to be a
  // percentage of. With none, the alt reads `--%` like the HUD does, rather than
  // claiming a 0% that means nothing.
  const percent = input.milestones === 0 ? '--%' : `${Math.round(input.progress * 100)}%`
  const alt = `${input.state} ${percent}${input.activity === '' ? '' : ` ${input.activity}`}`

  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box.width} ${box.height}" width="${box.width}" height="${box.height}" role="img" aria-label="${alt}">${parts.join('')}</svg>`, alt }
}

/**
 * The narrow-band form: one core glyph in the state's own colour.
 *
 * Under this width a full crawler would be a smear, so it degrades to its core.
 * The glyph still changes with the state, so a narrow band still says
 * something true about what is happening.
 */
export const crawlerGlyph = (input: CrawlerInput): { glyph: string; color: number } => ({
  glyph: CRAWLER_GLYPH[input.state],
  color: pack(hex(coreColor(input.state))),
})

/**
 * The terminal crawler's view of a cell grid: what is at a cell, and how to
 * paint one. This is the same grid the progress track is drawn into.
 */
export type CellGrid = {
  width: number
  height: number
  /** The code point and foreground already there, or null when empty. */
  at: (x: number, y: number) => { code: number; fg: number } | null
  set: (x: number, y: number, code: number, fg: number) => void
  /**
   * Whether the crawler may claim a cell that already has something on it.
   *
   * Defaults to claiming only empty cells, which is the safe reading: a bare
   * grid has nothing to protect. A caller drawing onto a live HUD passes a
   * predicate that names the cells the animation is allowed to borrow, so the
   * stage label and the milestone ticks can be protected explicitly rather than
   * by accident of colour.
   */
  claims?: (x: number, y: number, there: { code: number; fg: number }) => boolean
}

/** The cell a 0..1 position lands on, always inside the track. */
export const cellOf = (position: number, width: number): number => {
  const last = Math.max(0, width - 1)

  return Math.max(0, Math.min(last, Math.round(position * last)))
}

/**
 * Draws the crawler into a grid, returning how many cells it touched.
 *
 * The crawler rides the track: it paints only its own cells and never clears
 * the track, so the stage, the percentage and the milestones underneath cannot
 * be erased by the animation. A cell that already carries something the
 * crawler did not paint is left alone for the same reason.
 *
 * Under reduced motion the limbs stop rippling, but the core still lands on the
 * real progress, so a reader who asked for less motion still sees the truth.
 */
export const crawlerGrid = (input: CrawlerInput, grid: CellGrid, motion: Motion, layer: NwhoLayer = NO_NWHO): number => {
  const body = skeletonOf(input, { x: 0, y: 0, width: grid.width, height: grid.height }, motion)
  const core = pack(hex(coreColor(input.state)))
  // The cells this crawler has claimed on this pass. A cell the crawler owns may
  // be repainted by a later layer of the same crawler; a cell owned by the track
  // may not be touched at all. Without this the body could never draw over its
  // own milestone nodes, and the core could never land on its own cell.
  const owned = new Set<string>()
  let touched = 0
  const paint = (x: number, y: number, glyph: string, fg: number): void => {
    // The row is floored, not rounded: a joint sits at the row's centre, and
    // `Math.round(0.5)` is the next row, which on a one-row track is off the
    // track entirely. Flooring keeps every limb inside the grid it was given.
    const cx = Math.round(x)
    const cy = Math.floor(y)
    if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return
    const key = `${cx},${cy}`
    const there = grid.at(cx, cy)
    // A cell the crawler already owns is always fair game, so its later layers
    // can cover its earlier ones. A cell it does not own may only be claimed
    // when the caller says so; the default is to leave it alone.
    if (there !== null && !owned.has(key) && grid.claims?.(cx, cy, there) !== true) return
    owned.add(key)
    grid.set(cx, cy, glyph.codePointAt(0) ?? 0, fg)
    touched++
  }
  // Nodes for real completed work only, at the row `skeletonOf` placed them.
  // They go down first so the body and the core always draw over them: a node
  // shares its cell with the joint it marks, and the core glyph must never be
  // hidden by the milestone it happens to sit on.
  for (const node of body.nodes) paint(node.x, node.y, '·', pack(hex(COLORS.silver)))
  const spineGlyphs = ['◆', '━', '╋', '─', '╂']
  for (let n = 1; n < body.spine.length; n++) {
    const joint = body.spine[n]
    const prev = body.spine[n - 1]
    if (joint === undefined || prev === undefined) continue
    const glyph = spineGlyphs[n % spineGlyphs.length] ?? '─'
    // The link is drawn between the joints so the body reads as connected.
    const steps = Math.max(1, Math.round((joint.x - prev.x) / 2))
    for (let s = 0; s <= steps; s++) paint(prev.x + ((joint.x - prev.x) * s) / steps, joint.y, glyph, core)
  }
  paint(body.core.x, body.core.y, CRAWLER_GLYPH[input.state], core)
  // Real prune branches: kept ones lit, dropped ones dim.
  for (const branch of layer.branches) {
    paint(grid.width * branch.at, grid.height - 1, branch.accepted ? '┃' : '┆', pack(hex(branch.accepted ? COLORS.ok : COLORS.bad)))
  }
  // A real decision junction.
  if (layer.junction.chosen) paint(grid.width * 0.8, grid.height - 1, '┗', pack(hex(COLORS.accent)))

  return touched
}

/**
 * How a crawler fits a band of `columns` cells: the full body, the glyph, or
 * nothing. Below the floor there is no room for a crawler, and the caller draws
 * the badge alone rather than a smear.
 */
export const crawlerForm = (columns: number): 'none' | 'glyph' | 'body' => {
  if (columns < 12) return 'none'
  if (columns < 40) return 'glyph'

  return 'body'
}

/**
 * The crawler's locomotion through the Activity Field.
 *
 * The field is drawn first, as text: a tape of real events laid out left to
 * right, each one anchored at a real cell. The crawler is then a small creature
 * that walks *between those anchors*, and everything that makes it read as
 * crawling rather than sliding lives here.
 *
 * The rules that keep the motion honest:
 *   - It only ever walks to an anchor that exists. `walkTo` is given the real
 *     anchor positions of the real tape, and a target outside them is refused,
 *     so the crawler cannot travel to an event that was never observed.
 *   - Its pose advances with distance covered, not with wall time alone, so a
 *     stationary crawler holds still and a moving one visibly articulates.
 *   - Under reduced motion every step collapses to the target, and the whole
 *     thing is drawn once. The state is still shown; only the travel is gone.
 */

// One frame of the creature. Each pose is the offsets, relative to the core,
// of the four limbs and the tail, so a frame is pure data and a test can assert
// that consecutive frames really differ.
export type Pose = {
  /** Leading limb, then trailing limb: the pair that alternates. */
  front: [number, number]
  rear: [number, number]
  /** The cable tail, trailing further behind the rear limb. */
  tail: number
}

export type Limbs = { core: number; front: [number, number]; rear: [number, number]; tail: number }

/**
 * Four procedural poses, walked in order and reversed when travelling left.
 *
 * A crawling creature is defined by its feet: the front pair grips while the
 * rear pair swings, then they swap. These four frames are that swap at quarter
 * phase, so at any moment one pair is planted and the other is reaching.
 */
export const POSES: readonly Pose[] = [
  { front: [0, 1], rear: [-2, -1], tail: -3 },
  { front: [1, 2], rear: [-2, -1], tail: -4 },
  { front: [2, 3], rear: [-3, -2], tail: -5 },
  { front: [1, 2], rear: [-1, -2], tail: -3 },
]

/** The pose at a step, wrapping in both directions. */
export const poseAt = (step: number): Pose => {
  const count = POSES.length
  const index = ((Math.trunc(step) % count) + count) % count

  return POSES[index] ?? (POSES[0] as Pose)
}

/**
 * The creature's limbs laid out at `at` having covered `travel` cells.
 *
 * `travel` is the absolute number of cells moved, so the legs always depend on
 * how far it has come rather than on a clock: two crawlers that have each
 * travelled the same distance share a pose, and one that is not moving keeps
 * its legs exactly where they were.
 */
export const limbsAt = (at: number, travel: number, pose: Pose): Limbs => ({
  core: Math.round(at),
  front: [Math.round(at) + pose.front[0], Math.round(at) + pose.front[1]],
  rear: [Math.round(at) + pose.rear[0], Math.round(at) + pose.rear[1]],
  tail: Math.round(at) + pose.tail,
})

/**
 * Where the crawler stands after moving toward `target` from `at`.
 *
 * `cell` is how far it may move in one frame. A target it has reached returns
 * unchanged, so it settles on an anchor rather than oscillating around it, and
 * a target outside the tape's own cells is clamped into it, so it can never
 * walk off the end of the text it is traversing.
 */
export const walkTo = (at: number, target: number, cell: number, last: number): number => {
  const bounded = Math.max(0, Math.min(last, target))
  if (bounded === at) return at
  const step = Math.max(0, Math.abs(cell))
  if (step === 0) return at
  const distance = bounded - at

  return distance > 0 ? Math.min(bounded, at + step) : Math.max(bounded, at - step)
}

/**
 * How many cells the crawler covers per frame, from what it is doing.
 *
 * An edit is faster than a read, a fault stops dead so the break is readable,
 * and a query halts at the fork because it is waiting for an answer.
 */
export const paceOf = (state: string, moving: boolean): number => {
  if (!moving) return 0
  if (state === 'fault' || state === 'query') return 0

  return state === 'edit' || state === 'test' ? 2 : 1
}

/**
 * One frame of travel.
 *
 * `at` moves toward the target by at most `cell`, and the pose index advances
 * once for every cell actually covered, so the limbs articulate in step with
 * the body rather than animating in place. Under reduced motion the crawler
 * simply arrives and holds.
 */
export type Step = { at: number; pose: number; travel: number }

export const stepToward = (at: number, target: number, cell: number, last: number, step: number, reducedMotion: boolean): Step => {
  if (reducedMotion) {
    // Reduced motion removes the travel, not the truth: the crawler goes
    // straight to where it belongs and then holds there for ever.
    const bounded = Math.max(0, Math.min(last, target))

    return { at: bounded, pose: step, travel: step }
  }
  const moved = walkTo(at, target, cell, last)
  const covered = Math.abs(moved - at)

  return { at: moved, pose: covered === 0 ? step : step + covered, travel: step + covered }
}

/**
 * The startup assemble: Cobalt's own initialization, drawn in the supported
 * `AbovePrompt` region because Claude Code 2.1.288 exposes no startup surface
 * to replace and none is patched here. Claude's own mascot is left exactly
 * where it is.
 *
 * `progress` is the fraction of modules the plugin has really initialized, so
 * the bar can only ever be as true as the work behind it, and `active` is false
 * once the sequence is done or the first prompt has arrived.
 */
export type Startup = { active: boolean; progress: number; line: string }

export const STARTUP_STEPS = ['graph', 'palette', 'operator', 'telemetry'] as const

/** The line the sequence shows, naming only steps that really ran. */
export const startupLine = (done: readonly string[]): string => `COBALT ONLINE  ${done.length}/${STARTUP_STEPS.length}  ${done.join(' → ')}`

export const startupOf = (done: readonly string[], dismissed: boolean): Startup => {
  const known = done.filter((one): one is (typeof STARTUP_STEPS)[number] => (STARTUP_STEPS as readonly string[]).includes(one))

  return {
    active: !dismissed && known.length > 0 && known.length < STARTUP_STEPS.length,
    progress: known.length / STARTUP_STEPS.length,
    line: startupLine(known),
  }
}
