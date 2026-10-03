// VECTOR: the operator Cockpit watches the task through.
//
// A hooded, masked silhouette in near-black with a visor that carries the
// state. Three forms, one identity, so the same operator is recognisable in
// every surface:
//
//   panel  a compact SVG portrait for the desktop HUD (26x22 CSS px)
//   badge  three cells of visor for a terminal Raster
//   micro  one glyph for a narrow band or a text-only surface
//
// The hood is never lit and never outlined in more than one colour: the visor
// does all the talking. Cyan appears here and nowhere else but glitch.

import { Grid, pack, hex } from './pixels'
import type { VisualState } from './theme'
import { PALETTE, STATE_COLOR, STATE_GLOW } from './theme'

/** The call sign the dossier prints beside the badge. */
export const OPERATOR = 'VECTOR'

export const PANEL_W = 26
export const PANEL_H = 22

// The cowl falls from a peak to a wide collar; the mask is a rounded slot
// across the face; below it only shadow, so the silhouette reads at 26px.
const COWL = 'M13 1.4c-4.9 0-8.9 3.7-9.4 8.5L3 20.6h20l-.6-10.7c-.5-4.8-4.5-8.5-9.4-8.5z'
const COWL_INNER = 'M13 3.6c-3.8 0-7.1 2.8-7.5 6.6l-.3 6.4h15.6l-.3-6.4c-.4-3.8-3.7-6.6-7.5-6.6z'
const MASK = 'M7.1 10.9h11.8a1.2 1.2 0 0 1 1.2 1.4l-.5 3.2a1.3 1.3 0 0 1-1.3 1.1H7.7a1.3 1.3 0 0 1-1.3-1.1l-.5-3.2a1.2 1.2 0 0 1 1.2-1.4z'

/** The eyes and the visor wash behind them, per state. */
const FACE: Record<VisualState, { eyes: string; wash: number }> = {
  // Level white slits: the resting face, saying nothing needs saying.
  idle: { eyes: '<rect x="9" y="13.1" width="2.6" height="1.2"/><rect x="14.4" y="13.1" width="2.6" height="1.2"/>', wash: 0.1 },
  // Narrowed and level: focused, not alarmed.
  running: { eyes: '<rect x="8.6" y="13.1" width="3.4" height="1.2"/><rect x="14" y="13.1" width="3.4" height="1.2"/>', wash: 0.26 },
  // Asymmetric bars: a face mid-transmission, not a face at rest.
  glitch: { eyes: '<rect x="8.4" y="12.4" width="3.6" height="1.1"/><rect x="14.2" y="14.1" width="3.2" height="1.1"/>', wash: 0.22 },
  // A hard cross-bred X: unmistakable at any size, and never funny.
  error: {
    eyes:
      '<path d="M9.1 12.7l1-1 1.5 1.5 1.5-1.5 1 1-1.5 1.5 1.5 1.5-1 1-1.5-1.5-1.5 1.5-1-1 1.5-1.5z"/>' +
      '<path d="M15.6 12.7l1-1 1.5 1.5 1.5-1.5 1 1-1.5 1.5 1.5 1.5-1 1-1.5-1.5-1.5 1.5-1-1 1.5-1.5z"/>',
    wash: 0.3,
  },
  // An unclosed slot: the mask asking the question it cannot finish.
  needs_input: { eyes: '<rect x="9" y="13.2" width="2.6" height="1.2"/><rect x="14.4" y="12.4" width="2.6" height="1.2"/>', wash: 0.24 },
  // One level bar across the slot: recorded, not celebrated.
  done: { eyes: '<rect x="8.8" y="13.2" width="8.4" height="1.3"/>', wash: 0.18 },
}

/** The three-cell visor chip: hood edge, lit visor, hood edge. */
export const BADGE: Record<VisualState, string> = {
  idle: '▐▒▌',
  glitch: '▐▓▌',
  running: '▐█▌',
  needs_input: '▐◣▌',
  error: '▐✗▌',
  done: '▐━▌',
}

/** One cell, for a band too narrow for a visor. */
export const MICRO: Record<VisualState, string> = {
  idle: '·',
  glitch: '▒',
  running: '●',
  needs_input: '◣',
  error: '✗',
  done: '━',
}

const LIT = new Set(['█', '▓', '━', '◣'])

/** The badge as a Raster row: hood in near-black, visor lit in the state colour. */
export const mascotGrid = (state: VisualState): Grid => {
  const g = new Grid(BADGE[state].length)
  const hood = pack(hex(PALETTE.panel))
  const edge = pack(hex(PALETTE.steel))
  const visor = pack(hex(STATE_COLOR[state]))
  const lit = pack(hex(STATE_GLOW[state]))
  // The middle cell is the visor in every state: the state's colour behind it,
  // lit or dim. The outer two are the hood, so they stay near-black.
  ;[...BADGE[state]].forEach((ch, i) => {
    const at = i === 1
    g.set(i, 0, ch, at && LIT.has(ch) ? lit : edge, at ? visor : hood)
  })

  return g
}

/**
 * The panel portrait. `state` picks the expression; `motion` adds the scan
 * sweep and the glitch tear, the only animated parts. Both are dropped entirely
 * for `prefers-reduced-motion` and whenever `reducedMotion` is set, so nothing
 * moves that the person did not ask to move.
 */
export const mascotSvg = (state: VisualState, motion = false): string => {
  const acc = STATE_COLOR[state]
  const glow = STATE_GLOW[state]
  const face = FACE[state]
  const still = state === 'done' || state === 'idle'
  const animated = motion && !still
  const style = [
    '@keyframes vpulse{0%,100%{opacity:.85}50%{opacity:.35}}',
    '@keyframes vscan{0%{transform:translateX(0)}100%{transform:translateX(17px)}}',
    '@keyframes vtear{0%{transform:translateX(0);opacity:.45}33%{transform:translateX(2.5px);opacity:.12}66%{transform:translateX(-1.5px);opacity:.55}100%{transform:translateX(0);opacity:.45}}',
    // Keyframes are always declared so the markup is one string either way, but
    // only the rules that actually run are emitted.
    animated ? '.v{animation:vpulse 2.4s ease-in-out infinite}' : '',
    animated ? '.s{animation:vscan 2.6s linear infinite}' : '',
    animated ? '.t{animation:vtear 1.7s steps(4) infinite}' : '',
    '@media (prefers-reduced-motion:reduce){.v,.s,.t{animation:none!important}}',
  ].join('')
  // The scan sweeps the visor; the tear is a displaced band of the same height,
  // cut out of the mask, so the two together read as a signal breaking up.
  const band =
    state === 'glitch' && motion
      ? `<rect class="t" x="6.6" y="11.4" width="12.8" height="1.5" fill="${glow}" opacity=".45"/>`
      : animated
        ? `<rect class="v s" x="6.9" y="10.9" width="1.5" height="5.9" fill="${glow}" opacity=".2"/>`
        : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${PANEL_H}" viewBox="0 0 ${PANEL_W} ${PANEL_H}">
<defs><clipPath id="vmask"><path d="${MASK}"/></clipPath></defs>
<style>${style}</style>
<path d="${COWL}" fill="${PALETTE.panel}" stroke="${PALETTE.edge}" stroke-width="1"/>
<path d="${COWL_INNER}" fill="${PALETTE.void}"/>
<path d="${MASK}" fill="#05070A"/>
<g clip-path="url(#vmask)">
<rect x="5.4" y="14.8" width="15.2" height="2.6" fill="${glow}" opacity="${face.wash}"/>
${band}
<g fill="#fff">${face.eyes}</g>
</g>
<path d="${MASK}" fill="none" stroke="${acc}" stroke-opacity=".6" stroke-width="1"/>
<rect x="10.4" y="18.4" width="5.2" height=".9" rx=".45" fill="${acc}" opacity=".5"/>
</svg>`
}

/** What the badge says to a reader that cannot see it. */
export const mascotAlt = (state: VisualState): string => `${OPERATOR} / ${state}`