// Visual adapter for Cockpit's authoritative state. Particle/grid techniques
// adapted from zycck/claude-mods plan-progress (MIT); see THIRD_PARTY_NOTICES.
import type { AgentStrip, Task } from '../types'
import type { HudInput } from './view'
import { duration, statusWord, visualStateOf } from './view'
import { settle } from './model'
import { hasRole, roleStrip } from './orchestra'
import { branchLabel, dirtyLabel, shaLabel, aheadBehindLabel } from './git'
import { Grid, clamp, cellsOf, escapeXml, fitText, hash, hex, mix, pack, rasterText, rgb } from './pixels'
import { cellOf, coreColor, crawlerForm, crawlerGrid, NO_NWHO } from './crawler'
import type { CellGrid, CrawlerInput, Motion, NwhoLayer } from './crawler'
import { GATE_GLYPH, PALETTE, STATE_COLOR, STATE_GLOW, STATE_GLYPH, STAGE_LABEL, STAGE_SHORT } from './theme'
import type { VisualState } from './theme'

// One import for the drawing vocabulary: the pixels the grids are made of, the
// state palette they are painted in, and the label grammar.
export type { VisualState } from './theme'
export { PALETTE, STAGE_LABEL, STATE_COLOR, STATE_GLOW, STATE_GLYPH, STATE_LABEL } from './theme'
export { cellsOf, escapeXml, fitText, Grid, rasterText } from './pixels'

export const GLIDE_MS = 450
export const FOLD_MS = 5000
/** The track's height in CSS px; the badge is drawn to the same box. */
export const TRACK_H = 22
/** One terminal column, in CSS px. The track's width is measured in these. */
export const TRACK_W = 8

export type Visual = { state: VisualState; stage: string; percent: number; percentText: string; active: boolean }
export const visualOf = (input: HudInput, waiting = false): Visual => {
  const task = input.task
  // Re-settle defensively: a stale/hot-reloaded DONE flag cannot bypass gates.
  const genuine = task === null ? null : settle(task).task
  const done = task?.status === 'done' && genuine?.status === 'done' && genuine.percent === 100
  // The state's derivation lives in view.ts so the drawn HUD, the text fallbacks
  // and Mission Control can never disagree about what the plugin is doing.
  const state: VisualState = visualStateOf(input, waiting)
  const working = input.isWorking && input.activity.isWorking
  const percent = genuine?.percent ?? 0
  const phase = done ? 'DONE' : task?.phase === 'DONE' ? 'VERIFY' : task?.phase ?? 'RESEARCH'
  const stage = STAGE_LABEL[phase] ?? phase

  return { state, stage, percent, percentText: !task?.milestones.length ? '--%' : `${percent}%`, active: working && (state === 'running' || state === 'glitch') }
}
export type Glide = { from: number; to: number; at: number }
const ease = (x: number) => 1 - Math.pow(1 - clamp(x), 4)
export const positionAt = (g: Glide, now: number) => g.from + (g.to - g.from) * ease((now - g.at) / GLIDE_MS)
export const transition = (g: Glide | null, target: number, now: number, motion = true): Glide => {
  if (!g || !motion) return { from: target, to: target, at: now }
  if (Math.abs(g.to - target) < 0.00001) return g
  return { from: Math.min(target, positionAt(g, now)), to: target, at: now }
}
export type Marker = { fraction: number; kind: 'stage' | 'step'; title: string; complete: boolean }
export const markersOf = (task: Task | null): Marker[] => {
  const milestones = task?.milestones ?? []
  return milestones.flatMap((m, i) => i === 0 ? [] : [{ fraction: i / milestones.length, kind: milestones[i - 1]?.phase !== m.phase ? 'stage' as const : 'step' as const, title: milestones[i - 1]?.title ?? '', complete: milestones.slice(0, i).every(one => one.state === 'done') }])
}

/**
 * How the one row of the HUD is divided at a given width. Nothing here decides
 * colour or state; only where the badge, the track and the percentage sit. The
 * invariants a test can hold at every width: the track never falls below one
 * cell, the percentage is reserved before anything else claims room, and the
 * badge is the first thing to go when there is not enough for it.
 */
export type Layout = { columns: number; badgeWidth: number; titleWidth: number; trackWidth: number; percentWidth: number }
export const layoutOf = (columns: number, percent = '100%'): Layout => {
  const n = Math.max(1, Math.min(512, Math.floor(columns)))
  const percentWidth = Math.min(percent.length, Math.max(0, n - 3))
  // The badge is three cells of visor on a terminal and a 26px panel on the
  // desktop; either way it wants three columns and a gap beside it.
  const badgeWidth = n >= 46 ? 3 : n >= 20 ? 1 : 0
  const titleWidth = n >= 76 ? Math.min(30, Math.floor(n * .2)) : 0
  const spent =
    (badgeWidth ? badgeWidth + 1 : 0) +
    (titleWidth ? titleWidth + 3 : 0) +
    (percentWidth ? percentWidth + 1 : 0)

  return { columns: n, badgeWidth, titleWidth, percentWidth, trackWidth: Math.max(1, n - spent) }
}

const GATE_STRIP = ['TEST', 'TYPE', 'BUILD', 'GIT'] as const

/**
 * The technical status strip under the bar: what is verified, how much context
 * is spent, what is happening, and in which repository. Everything gives way
 * from the right as the terminal narrows, so the gates and the context meter
 * outlive the model name, which outlives the git detail.
 */
export const secondaryText = (input: HudInput, columns: number): string => {
  if (columns < 44) return ''
  const settled = input.task ? settle(input.task).task : null
  const words: string[] = []
  if (columns >= 52) {
    const gates = GATE_STRIP.map(name => `${name} ${GATE_GLYPH[settled?.gates[name]?.state ?? 'unset']}`)
    words.push(columns >= 64 ? gates.join('  ') : gates.slice(0, 3).join('  '))
  }
  words.push(`CTX ${input.meter.percent === null ? '--' : `${input.meter.percent}%`}`)
  words.push(statusWord({ ...input, task: settled }))
  if (columns >= 100) {
    const model = [input.meter.model?.replace(/^claude-/, ''), input.meter.effort].filter(Boolean).join(' · ')
    if (model !== '') words.push(model)
  }
  if (columns >= 140 && input.git) words.push([branchLabel(input.git), shaLabel(input.task?.startSha ?? input.git.startSha, input.git.sha), dirtyLabel(input.git), aheadBehindLabel(input.git)].filter(Boolean).join(' · '))

  return fitText(words.filter(Boolean).join('   '), columns)
}

const BITS = [[1, 8], [2, 16], [4, 32], [64, 128]]
export const particleBits = (column: number, head: number): number => {
  const u = clamp((column + .5) / Math.max(1, head))
  const density = .22 + .78 * Math.pow(u, 1.5)
  let bits = 0
  for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) {
    const sx = column * 2 + c
    if (sx / 2 < head && hash(sx, r, 1) <= density * .6) bits |= BITS[r]?.[c] ?? 0
  }
  return bits
}
export type DrawOptions = { head: number; now: number; motion: boolean; light: boolean }

/**
 * The stage word the pill carries, given the cells it has to live in. The full
 * word while it fits, the short one when it does not, and a cut one only when
 * even that is too wide.
 */
export const stageLabel = (stage: string, cells: number): string => {
  if (cellsOf(stage) <= cells) return stage
  const short = STAGE_SHORT[stage] ?? stage
  return cellsOf(short) <= cells ? short : fitText(short, Math.max(1, cells))
}

const RAIL_CAP_LEFT = '\u2576'
const RAIL_CAP_RIGHT = '\u2574'

/**
 * The terminal track: one row of cells carrying the same picture the SVG does.
 * A near-black bed, a red-lit fill whose Braille particles thicken toward the
 * head, thin checkpoint capsules, and the stage pill gliding over it.
 */
export const trackGrid = (input: HudInput, v: Visual, width: number, options: DrawOptions): Grid => {
  const g = new Grid(width)
  const head = Math.min(v.percent / 100 * width, clamp(options.head) * width)
  const back = options.light ? [252, 252, 253] : hex(PALETTE.rail)
  const acc = hex(STATE_COLOR[v.state])
  const glow = hex(STATE_GLOW[v.state])
  const light = mix(acc, [255, 255, 255], .35)
  const rail = mix(back, [128, 128, 128], options.light ? .2 : .22)
  const fill = mix(rail, acc, .28)
  const at = (x: number): number[] => (x + .5 <= head ? fill : rail)

  for (let x = 0; x < width; x++) {
    const filled = x + .5 <= head
    // The cell at the head carries a bright wall rather than particles: it is
    // the front of the work, and the eye follows it as it moves.
    const front = filled && x + 1 > head - 1.5
    const bits = front ? 0 : particleBits(x, head)
    const u = clamp((x + .5) / Math.max(1, head))
    const twinkle = options.motion && v.active ? 1 - .45 * (.5 + .5 * Math.sin(options.now / (350 + hash(x, 0, 2) * 180) + hash(x, 1, 2) * 6)) : 1
    const tone = mix(fill, mix(hex(PALETTE.steel), light, Math.pow(u, .9)), (.35 + .65 * u) * twinkle)
    const ink = bits ? tone : front ? mix(rail, glow, .9) : mix(rail, acc, filled ? .55 : .22)
    g.set(
      x,
      0,
      bits ? 0x2800 + bits : x === 0 ? RAIL_CAP_LEFT : x === width - 1 ? RAIL_CAP_RIGHT : filled ? '━' : '─',
      pack(ink),
      pack(at(x)),
    )
  }
  markersOf(input.task).forEach(m => {
    const x = Math.round(m.fraction * width)
    if (x > 0 && x < width - 1) g.set(x, 0, m.kind === 'stage' ? '\u2502' : '\u00b7', pack(m.complete ? light : mix(rail, options.light ? [0, 0, 0] : [255, 255, 255], .4)), pack(at(x)))
  })
  const label = rasterText(stageLabel(v.stage, width)).slice(0, Math.max(1, width - 2))
  const pillWidth = Math.min(width, label.length + 2)
  const left = Math.round(clamp(head - pillWidth / 2, 0, width - pillWidth))
  for (let x = left; x < left + pillWidth; x++) g.set(x, 0, ' ', 0xffffff, pack(acc))
  g.text(left + (pillWidth > 2 ? 1 : 0), 0, label, 0xffffff, pack(acc))

  return g
}

/**
 * Paints the crawler onto a finished track, in place.
 *
 * The crawler rides the track rather than replacing it, so the stage, the
 * percentage and the milestones stay exactly where they were. It only claims
 * cells it can own: the pill's own background is the crawler's home colour, so
 * the animation can cross the pill without eating the label. Every other
 * foreground it refuses to overwrite, which is what keeps the marker's ticks
 * and the rail legible underneath it.
 */
export const paintCrawler = (g: Grid, crawler: CrawlerInput, motion: Motion, layer: NwhoLayer = NO_NWHO): number => {
  // The track's own text is what must survive: the stage label's letters, the
  // milestone ticks, and the rail's end caps. A cell is claimable when it holds
  // none of those, which lets the crawler cross the rail and the pill's own
  // background while leaving every glyph the HUD put there readable.
  const protectedCells = new Set<number>()
  g.cells.forEach((cell, at) => {
    const code = cell[0]
    if (code !== 32 && code !== 0x2500 && code !== 0x2501 && code !== 0x2576 && code !== 0x2574) protectedCells.add(at)
  })
  const cells: CellGrid = {
    width: g.width,
    height: g.rows,
    at: (x, y) => {
      const cell = g.cells[y * g.width + x]

      return cell === undefined ? null : { code: cell[0], fg: cell[1] }
    },
    set: (x, y, code, fg) => {
      // Keep the cell's background: the crawler borrows the track, it does not repaint it.
      const cell = g.cells[y * g.width + x]
      g.set(x, y, code, fg, cell === undefined ? 0 : cell[2])
    },
    claims: (x, y) => !protectedCells.has(y * g.width + x),
  }

  return crawlerGrid(crawler, cells, motion, layer)
}

/** The crawler's form at a width: the full body, the glyph, or nothing. */
export const crawlerFormOf = (columns: number): 'none' | 'glyph' | 'body' => crawlerForm(columns)

/** The crawler's cell for a position on a track of `width` cells. */
export const crawlerCellOf = (position: number, width: number): number => cellOf(position, width)

export const visibleAgents = (agents: AgentStrip[], now: number, budget = 3): { shown: AgentStrip[]; folded: number } => {
  const live = agents.filter(a => a.state !== 'done' || a.endedAt === null || now - a.endedAt < FOLD_MS)
  const shown = [...live].sort((a,b) => Number(a.state === 'done') - Number(b.state === 'done')).slice(0, budget)
  return { shown, folded: live.length - shown.length }
}
export const stripText = (a: AgentStrip, width: number, now: number): string => {
  // A strip the orchestration numbered is drawn in its grammar; one held from
  // before roles existed keeps the reading it always had.
  if (hasRole(a)) return roleStrip(a, width, now)
  const spec = width >= 80 ? ` (${[a.model?.replace(/^claude-/, ''), a.effort].filter(Boolean).join(' · ')})` : ''
  const tail = ` ${a.tool} ${duration((a.endedAt ?? now) - a.startedAt)}`
  return fitText(`↳ ${fitText(a.title + spec, Math.max(1, width - cellsOf(tail) - 2))}${tail}`, width)
}
export const stripGrid = (a: AgentStrip, width: number, now: number, light: boolean, motion = false): Grid => {
  const g = new Grid(width)
  const state = a.state === 'waiting' ? 'needs_input' : a.state
  const acc = hex(STATE_COLOR[state])
  const bg = pack(mix(light ? [252, 252, 253] : hex(PALETTE.rail), acc, .18))
  for (let x = 0; x < width; x++) g.set(x, 0, ' ', pack(acc), bg)
  const text = fitText(rasterText(stripText(a, width, now)), width)
  g.text(0, 0, text, light ? pack(hex(PALETTE.void)) : pack(hex(PALETTE.silver)), bg)
  if (motion && a.state === 'running') {
    // An orchestration row is set in columns, so its particles keep to the
    // empty run after the text: a gap between two columns is part of the row.
    for (let x = hasRole(a) ? cellsOf(text) + 1 : 0; x < width; x++) {
      if (g.cells[x]?.[0] !== 32 || hash(x, 1, 5) > .25) continue
      const glow = .4 + .3 * Math.sin(now / 450 + hash(x, 0, 2) * 6)
      g.set(x, 0, 0x2800 + particleBits(x, width), pack(mix(hex(STATE_COLOR.running), light ? [60, 60, 65] : hex(PALETTE.redGlow), glow)), bg)
    }
  }

  return g
}

export type SvgTrack = { base: string; overlay: string }

/** The technical face the pill and the strip labels are set in. */
const FACE = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"

/**
 * The desktop track. A near-black panel with a hairline frame, a fill that
 * runs from a wash of the state colour to a bright gradient at the head, a
 * particle field that thickens toward that head, checkpoint capsules, and the
 * stage pill gliding above it all.
 *
 * Drawn twice: `base` is a plain picture the desktop keeps steady whatever else
 * redraws, and `overlay` is a see-through layer carrying the hover targets for
 * the checkpoints, which need an interactive frame the base deliberately has not.
 */
export const trackSvg = (input: HudInput, v: Visual, width: number, from: number, motion: boolean): SvgTrack => {
  const W = Math.max(8, width)
  const H = TRACK_H
  const fx = v.percent / 100 * W
  const previous = Math.min(fx, clamp(from) * W)
  const color = STATE_COLOR[v.state]
  const glow = STATE_GLOW[v.state]
  const acc = hex(color)
  const bright = mix(acc, [255, 255, 255], .32)
  // The particle field: a 3px grid, seven rows, denser and brighter toward the
  // head. Grouped by brightness and blink phase so one path serves a thousand
  // dots and the markup stays a fraction of its size.
  const paths = new Map<string, string>()
  for (let col = 0; col * 3 < fx; col++) {
    const u = clamp((col * 3 + 1.5) / Math.max(1, fx)), density = .22 + .78 * Math.pow(u, 1.5)
    for (let r = 0; r < 7; r++) {
      if (hash(col, r, 1) > density + .1) continue
      const bucket = Math.min(4, Math.floor(Math.pow(u, .9) * 4.99)), blink = Math.floor(hash(col, r, 2) * 4)
      const cls = `b${bucket} t${blink}`
      paths.set(cls, `${paths.get(cls) ?? ''}M${col * 3} ${1 + r * 3}h2v2h-2z`)
    }
  }
  const animate = motion && v.active
  // Glitch tears a few bright slices out of the fill, offset against the head.
  const tears =
    motion && v.state === 'glitch'
      ? Array.from({ length: Math.max(2, Math.floor(fx / 60)) }, (_, i) => {
          const x = Math.round(hash(i, 3, 9) * Math.max(1, fx - 20))
          const y = 3 + Math.round(hash(i, 4, 9) * 15)

          return `<rect class="tear" x="${x}" y="${y}" width="${8 + Math.round(hash(i, 5, 9) * 18)}" height="1.5" fill="${glow}" opacity=".5"/>`
        }).join('')
      : ''
  // The pill: a word on any track with room for one, and a lit dot carrying the
  // state's glyph where there is not. Both are the same width as the head, so a
  // narrow track never has its progress head pushed around.
  const room = Math.floor(W / TRACK_W)
  const showsWord = room >= 8
  // the pill takes at most half the track, less its own chrome; at 8.4px a
  // letter-spaced uppercase glyph is a fair guess and always has slack
  const label = stageLabel(v.stage, Math.min(room, Math.max(2, Math.floor((W * .5 - 24) / 8.4))))
  const kw = showsWord ? Math.min(W, Math.round(cellsOf(label) * 8.4) + 24) : H
  const kx = clamp(fx, kw / 2, W - kw / 2), kFrom = clamp(previous, kw / 2, W - kw / 2)
  const style = `<style>${[0, 1, 2, 3, 4].map(b => `.b${b}{fill:${rgb(mix(hex(PALETTE.steel), bright, b / 4))};fill-opacity:${(.4 + .6 * b / 4).toFixed(2)}}`).join('')}
${animate ? '.t0,.t1,.t2,.t3{animation:tw 2.2s ease-in-out infinite}.t1{animation-duration:2.8s;animation-delay:-.7s}.t2{animation-duration:1.9s;animation-delay:-1.3s}.t3{animation-duration:3.3s;animation-delay:-.4s}' : ''}
${tears ? '.tear{animation:tear 1.9s steps(5) infinite}@keyframes tear{0%{transform:translateX(0);opacity:.5}40%{transform:translateX(3px);opacity:.12}70%{transform:translateX(-2px);opacity:.45}}' : ''}
@keyframes tw{50%{opacity:.45}}
.g{animation:glide .45s cubic-bezier(.2,.8,.2,1) both}.fg{animation:fillglide .45s cubic-bezier(.2,.8,.2,1) both}
@keyframes glide{from{transform:translateX(${kFrom}px)}to{transform:translateX(${kx}px)}}
@keyframes fillglide{from{width:${previous}px}to{width:${fx}px}}
@media(prefers-reduced-motion:reduce){.t0,.t1,.t2,.t3,.tear,.g,.fg{animation:none!important}}
</style>`
  const glide = animate && Math.abs(previous - fx) > .5
  let marks = '', hits = ''
  markersOf(input.task).forEach(m => {
    const x = m.fraction * W, mark = m.complete ? rgb(bright) : PALETTE.silver
    marks += m.kind === 'stage' ? `<rect x="${(x - 1.5).toFixed(1)}" y="6" width="3" height="10" rx="1.5" fill="${mark}" opacity="${m.complete ? .95 : .5}"/>` : `<circle cx="${x.toFixed(1)}" cy="11" r="1.4" fill="${mark}" opacity="${m.complete ? .8 : .4}"/>`
    hits += `<rect x="${(x - 5).toFixed(1)}" width="10" height="${H}" fill="transparent"><title>${escapeXml(m.title)}</title></rect>`
  })
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  const defs = `<defs>
<clipPath id="round"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath>
<clipPath id="fill"><rect width="${fx.toFixed(1)}" height="${H}"${glide ? ' class="fg"' : ''}/></clipPath>
<linearGradient id="tint" x1="0" y1="0" x2="${fx.toFixed(1)}" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="${color}" stop-opacity=".08"/><stop offset=".62" stop-color="${color}" stop-opacity=".3"/><stop offset="1" stop-color="${glow}" stop-opacity=".55"/></linearGradient>
<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse"><stop stop-color="#fff" stop-opacity=".07"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`
  // The panel: a lifted near-black bed, a hairline edge, the fill clipped inside
  // it, then the particles and the tears, then the checkpoints.
  const panel = `<rect width="${W}" height="${H}" rx="${H / 2}" fill="${PALETTE.panel}"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="${(H - 1) / 2}" fill="none" stroke="${PALETTE.edge}" stroke-width="1"/>
<g clip-path="url(#round)"><g clip-path="url(#fill)">
<rect width="${fx.toFixed(1)}" height="${H}" fill="url(#tint)"/>
<rect width="${fx.toFixed(1)}" height="${H}" fill="url(#sheen)"/>
${[...paths].map(([cls, d]) => `<path class="${cls}" d="${d}"/>`).join('')}
${tears}
</g>${marks}</g>`
  // The head burns: a bright wall of the state's own light at the fill edge.
  const head =
    fx > 1
      ? `<rect x="${Math.max(0, fx - 2).toFixed(1)}" y="1" width="2" height="${H - 2}" fill="${glow}" opacity=".85"/>`
      : ''
  const pill = showsWord
    ? `<g transform="translate(${kx.toFixed(1)} 0)"${glide ? ' class="g"' : ''}>
<rect x="${-kw / 2}" width="${kw}" height="${H}" rx="${H / 2}" fill="${color}"/>
<rect x="${(-kw / 2 + .75).toFixed(1)}" y=".75" width="${(kw - 1.5).toFixed(1)}" height="${H - 1.5}" rx="${(H - 1.5) / 2}" fill="none" stroke="${glow}" stroke-opacity=".45" stroke-width="1.5"/>
<rect x="${(-kw / 2 + 7).toFixed(1)}" y="${(H / 2 - 1.5).toFixed(1)}" width="3" height="3" rx="1.5" fill="${glow}"/>
<text x="3" y="${H / 2 + 4.2}" text-anchor="middle" fill="#FFFFFF" font-family="${FACE}" font-size="11" font-weight="600" letter-spacing="1.1">${escapeXml(label)}</text></g>`
    : `<g transform="translate(${kx.toFixed(1)} 0)"${glide ? ' class="g"' : ''}>
<circle cx="0" cy="${H / 2}" r="${H / 2}" fill="${color}"/>
<text x="0" y="${H / 2 + 4}" text-anchor="middle" fill="#FFFFFF" font-family="${FACE}" font-size="11" font-weight="600">${escapeXml(STATE_GLYPH[v.state])}</text></g>`

  return { base: `${open}${style}${defs}${panel}${head}${pill}</svg>`, overlay: `${open}<style>:root,html,body{background:transparent!important;margin:0;overflow:hidden}</style>${hits}</svg>` }
}

/**
 * A subagent's strip on a surface with pictures: a tinted panel, a lit state
 * dot, and the name, tool and elapsed time. The same information `stripGrid`
 * packs into cells, drawn where cells do not exist.
 */
export const stripSvg = (a: AgentStrip, width: number, now: number, light: boolean, motion = false): string => {
  const state = a.state === 'waiting' ? 'needs_input' : a.state
  const color = STATE_COLOR[state]
  const glow = STATE_GLOW[state]
  const text = stripText(a, Math.floor(width / 7), now)
  const particles =
    a.state === 'running' && motion
      ? Array.from(
          { length: Math.floor(width / 9) },
          (_, x) => (hash(x, 1, 5) < .35 ? `<rect class="tw" x="${x * 9}" y="${2 + hash(x, 2, 5) * 10}" width="2" height="2" fill="${glow}" opacity=".25"/>` : ''),
        ).join('')
      : ''
  const style = particles
    ? '<style>.tw{animation:tw 2.2s ease-in-out infinite}@keyframes tw{50%{opacity:.08}}@media(prefers-reduced-motion:reduce){.tw{animation:none}}</style>'
    : ''
  const ink = light ? PALETTE.void : PALETTE.silver

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="18"><style/>${style}<rect x=".5" y=".5" width="${width - 1}" height="15" rx="7.5" fill="${color}" fill-opacity="${light ? '.12' : '.16'}" stroke="${color}" stroke-opacity=".22"/><rect x=".5" y=".5" width="${width - 1}" height="15" rx="7.5" fill="none" stroke="${PALETTE.edge}" stroke-width="1"/>${particles}<circle cx="9" cy="8" r="3" fill="${color}"/><circle cx="9" cy="8" r="3" fill="none" stroke="${glow}" stroke-opacity=".5"/><text x="19" y="12" font-family="${FACE}" font-size="11" fill="${ink}">${escapeXml(text)}</text></svg>`
}
