// VECTOR, the operator: three forms of one identity, and the rule that cyan
// belongs to glitch alone.

import { describe, expect, test } from 'claude-code/testing'

import { cellsOf, hex, pack } from '../hooks/pixels'
import { BADGE, MICRO, OPERATOR, PANEL_H, PANEL_W, mascotAlt, mascotGrid, mascotSvg } from '../hooks/mascot'
import { GATE_GLYPH, MILESTONE_GLYPH, PALETTE, STAGE_LABEL, STAGE_SHORT, STATE_COLOR, STATE_GLOW, STATE_GLYPH, STATE_LABEL, label } from '../hooks/theme'
import type { VisualState } from '../hooks/theme'

const STATES: VisualState[] = ['idle', 'glitch', 'running', 'needs_input', 'error', 'done']

/** The contrast ratio of white on a fill, to one decimal place. */
const contrast = (rgb: number[]): number => {
  const luminance = rgb
    .map(v => {
      const c = v / 255

      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    })
    .reduce((sum, channel, at) => sum + channel * [0.2126, 0.7152, 0.0722][at]!, 0)

  return Math.round((1.05 / (luminance + 0.05)) * 10) / 10
}

describe('the design system', () => {
  test('every state has a colour, a glyph and a word, and none of them collides', () => {
    for (const state of STATES) {
      expect(STATE_COLOR[state]).toMatch(/^#[0-9A-F]{6}$/i)
      expect(STATE_GLYPH[state]).toHaveLength(1)
      expect(STATE_LABEL[state]).toMatch(/^[A-Z]+$/)
    }
    expect(new Set(STATES.map(s => STATE_COLOR[s])).size).toBe(STATES.length)
    expect(new Set(STATES.map(s => STATE_LABEL[s])).size).toBe(STATES.length)
  })

  test('white on every state fill clears 4.5:1, so the pill label never goes unreadable', () => {
    for (const state of STATES) expect(contrast(hex(STATE_COLOR[state]))).toBeGreaterThanOrEqual(4.5)
  })

  test('the six state glyphs are BMP width one, so a Raster will take them', () => {
    for (const state of STATES) {
      expect(STATE_GLYPH[state].codePointAt(0)).toBeLessThan(0x10000)
      expect(cellsOf(STATE_GLYPH[state])).toBe(1)
      expect(cellsOf(MICRO[state])).toBe(1)
    }
  })

  test('the palette is near-black, one red, and one cyan held for glitch', () => {
    expect(PALETTE.void).toBe('#07080A')
    expect(PALETTE.panel).toBe('#0D0F13')
    expect(STATE_COLOR.running).toBe(PALETTE.red)
    expect(STATE_COLOR.error).not.toBe(STATE_COLOR.running)
    expect(STATE_COLOR.done).toBe(PALETTE.green)
    expect(STATE_COLOR.needs_input).toBe(PALETTE.amber)
    // cyan belongs to glitch alone, and to nothing else in the system
    expect(STATE_GLOW.glitch).toBe(PALETTE.cyan)
    expect(STATES.filter(s => STATE_GLOW[s] === PALETTE.cyan)).toEqual(['glitch'])
  })

  test('the label grammar is one slash between two words', () => {
    expect(label('DETAIL', 'FOOTWEAR')).toBe('DETAIL / FOOTWEAR')
    expect(label('STATE')).toBe('STATE')
  })

  test('stages are named for what happens, and shortened only when narrow', () => {
    expect(STAGE_LABEL.RESEARCH).toBe('INSPECT')
    expect(STAGE_LABEL.BLOCKED).toBe('INPUT')
    expect(STAGE_LABEL.DONE).toBe('DONE')
    for (const short of Object.values(STAGE_SHORT)) expect(short.length).toBeLessThanOrEqual(5)
  })

  test('gate and milestone glyphs keep their meanings', () => {
    expect(GATE_GLYPH).toEqual({ pass: '✓', fail: '✗', pending: '◌', unset: '·', na: '–' })
    expect(MILESTONE_GLYPH.done).toBe('✓')
    expect(MILESTONE_GLYPH.active).toBe('▶')
    expect(MILESTONE_GLYPH.failed).toBe('✗')
  })
})

describe('VECTOR, the operator', () => {
  test('has one call sign and one name for itself', () => {
    expect(OPERATOR).toBe('VECTOR')
    for (const state of STATES) expect(mascotAlt(state)).toBe(`VECTOR / ${state}`)
  })

  test('every state draws a distinct portrait, in its own colour', () => {
    expect(new Set(STATES.map(state => mascotSvg(state))).size).toBe(STATES.length)
    for (const state of STATES) {
      const svg = mascotSvg(state)
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="26" height="22"/)
      expect(svg).toContain(STATE_COLOR[state])
      expect(svg.endsWith('</svg>')).toBe(true)
    }
  })

  test('the hood is drawn in near-black and never lit from outside', () => {
    const svg = mascotSvg('running')
    expect(svg).toContain(PALETTE.panel)
    expect(svg).toContain(PALETTE.void)
    // two cowl paths and nothing else: the silhouette never shows a profile
    expect((svg.match(/<path d="M13 /g) ?? []).length).toBe(2)
  })

  test('motion is off by default, and a resting operator is never animated', () => {
    for (const state of STATES) expect(mascotSvg(state)).toContain('@media (prefers-reduced-motion:reduce)')
    // the reduced-motion guard is always present; no keyframe ever runs unless asked
    expect(mascotSvg('running')).not.toContain('animation:v')
    expect(mascotSvg('done', true)).not.toContain('animation:v')
    expect(mascotSvg('idle', true)).not.toContain('animation:v')
    expect(mascotSvg('running', true)).toContain('animation:vscan')
    expect(mascotSvg('glitch', true)).toContain('animation:vtear')
  })

  test('the terminal badge is three cells of visor, hood at the edges', () => {
    for (const state of STATES) {
      expect(cellsOf(BADGE[state])).toBe(3)
      const grid = mascotGrid(state)
      expect(grid.cells).toHaveLength(3)
      expect(grid.cells[0]?.[2]).toBe(pack(hex(PALETTE.panel)))
      expect(grid.cells[2]?.[2]).toBe(pack(hex(PALETTE.panel)))
      expect(grid.cells[1]?.[2]).toBe(pack(hex(STATE_COLOR[state])))
      expect(grid.cells[1]?.[0]).toBeGreaterThan(0x2000)
      for (const cell of grid.cells) {
        const cp = cell?.[0] ?? 0
        expect(cp).toBeGreaterThanOrEqual(0x20)
        expect(cp).toBeLessThan(0x10000)
      }
      expect(grid.encode()).toBe(mascotGrid(state).encode())
    }
  })

  test('the micro form is one cell and still names the state', () => {
    expect(new Set(STATES.map(s => MICRO[s])).size).toBe(STATES.length)
    for (const state of STATES) expect(cellsOf(MICRO[state])).toBe(1)
  })

  test('the failure face is unmistakably not any other face', () => {
    expect(mascotSvg('error')).toContain('M9.1 12.7')
    expect(mascotSvg('error')).not.toBe(mascotSvg('running'))
    expect(hex(STATE_COLOR.error)).not.toEqual(hex(STATE_COLOR.running))
  })

  test('the operator is the same height as the track it sits beside', () => {
    expect(PANEL_W).toBe(26)
    expect(PANEL_H).toBe(22)
  })
})
