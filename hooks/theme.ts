// Cobalt Cockpit's design system: one palette, one state vocabulary, one
// label grammar. Every drawing reads its colours and its words from here, so
// the HUD, the operator badge and Mission Control cannot drift apart.
//
// The language: near-black surfaces, a lifted charcoal panel, vivid red as the
// single loud accent, silver as the quiet one, and cyan held back for glitch
// and scan states only. Amber is a question, red is a failure, green is a
// verified result; no state is allowed to be louder than another.

import type { GateState, MilestoneState } from '../types'

/** What the HUD is feeling. `glitch` is the only state that reaches for cyan. */
export type VisualState = 'idle' | 'glitch' | 'running' | 'needs_input' | 'error' | 'done'

export const PALETTE = {
  /** The page behind everything. */
  void: '#07080A',
  /** A lifted surface: the HUD bed, the badge ground. */
  panel: '#0D0F13',
  /** Thin framing lines and rules. */
  edge: '#1D222B',
  /** An unfilled track bed on a dark terminal. */
  rail: '#15181E',
  /** Quiet text and dimmed labels. */
  steel: '#7B8496',
  /** The secondary accent: readable metal, headings and microcopy. */
  silver: '#C6CBD6',
  /** Primary accent, and the fill the primary accent is graded against. */
  red: '#E01E41',
  /** Failure: deeper, so an error reads as heavier rather than merely different. */
  redDeep: '#B00020',
  /** The bright edge of the accent, for glows and particles. */
  redGlow: '#FF5C7A',
  /** Glitch and scan only. Never a status. */
  cyan: '#22E3F0',
  /** The cyan that a white-on-fill pill can carry. */
  cyanDeep: '#0B7C93',
  amber: '#AD6400',
  amberGlow: '#FFB020',
  green: '#18883A',
  greenGlow: '#3BE07F',
} as const

/**
 * One lightness per state, all of them at or above 4.5:1 against white so the
 * label riding the stage pill stays readable in every state. The differentiator
 * between running red and failure red is depth and treatment, not hue alone.
 */
export const STATE_COLOR: Record<VisualState, string> = {
  idle: '#646A7E',
  glitch: PALETTE.cyanDeep,
  running: PALETTE.red,
  needs_input: PALETTE.amber,
  error: PALETTE.redDeep,
  done: PALETTE.green,
}

/** The bright partner of `STATE_COLOR`, for glows, particles and eyes. */
export const STATE_GLOW: Record<VisualState, string> = {
  idle: '#8A90A2',
  glitch: PALETTE.cyan,
  running: PALETTE.redGlow,
  needs_input: PALETTE.amberGlow,
  error: '#FF3352',
  done: PALETTE.greenGlow,
}

/** One glyph per state: the micro badge, the strip, the compact fallback. */
export const STATE_GLYPH: Record<VisualState, string> = {
  idle: '·',
  glitch: '▒',
  running: '●',
  needs_input: '?',
  error: '╳',
  done: '✓',
}

/** The operator's word for a state, as a segmented label: `STATE / ACTIVE`. */
export const STATE_LABEL: Record<VisualState, string> = {
  idle: 'IDLE',
  glitch: 'SCAN',
  running: 'ACTIVE',
  needs_input: 'QUERY',
  error: 'FAULT',
  done: 'VERIFIED',
}

/** The stage the pill shows for a work phase. */
export const STAGE_LABEL: Record<string, string> = {
  RESEARCH: 'INSPECT',
  PLAN: 'PLAN',
  IMPLEMENT: 'IMPLEMENT',
  TEST: 'TEST',
  FIX: 'FIX',
  VERIFY: 'VERIFY',
  BLOCKED: 'INPUT',
  DONE: 'DONE',
}

/** What the pill carries when the track is too narrow for the full word. */
export const STAGE_SHORT: Record<string, string> = {
  INSPECT: 'INSP',
  IMPLEMENT: 'IMPL',
  VERIFY: 'VRFY',
  INPUT: 'ASK',
}

/** `✓ pass, ✗ fail, ◌ ran but unknown, · unset, – n/a`. Unchanged semantics. */
export const GATE_GLYPH: Record<GateState, string> = {
  pass: '✓',
  fail: '✗',
  pending: '◌',
  unset: '·',
  na: '–',
}

export const MILESTONE_GLYPH: Record<MilestoneState, string> = {
  done: '✓',
  active: '▶',
  pending: '·',
  failed: '✗',
  blocked: '■',
}

/** The glyph a colored segment of the secondary strip is drawn with. */
export const GATE_TONE: Record<GateState, string | undefined> = {
  pass: 'success',
  fail: 'error',
  pending: 'warning',
  unset: undefined,
  na: undefined,
}

/** `DETAIL / VALUE` microcopy, the one label grammar used across both views. */
export const label = (name: string, value?: string): string => (value === undefined ? name : `${name} / ${value}`)

/** The thin rule that opens a dossier section. */
export const RULE = '─'