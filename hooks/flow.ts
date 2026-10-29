// COBALT NEURAL FLOW: INPUT → DISCOVERY → ROUTING → WORKERS → VERIFY → DONE.
//
// One row of the HUD. Every state in it is derived from state Cockpit really
// holds (the task's milestones and gates, its discovery and goal check, the
// agents the host reported running, the model the host reported), and it is
// derived again at every draw, so evidence that goes stale regresses the flow
// by itself: a gate that reverts to pending takes VERIFY back to active and
// DONE back to pending. Nothing here keeps a state of its own.
//
// Motion is only ever a ◆ travelling the edge into the node that is really
// active, and only while the host says work is live (a turn running, or an
// agent running). With several tiers of agents running, one ◆ per tier travels
// the WORKERS edge in that tier's colour. Idle, reduced motion and a narrow
// terminal each draw the same truth without movement. Nothing is called a model's
// work unless an agent of that tier was observed running.

import type { Gate, GateState, Task } from '../types'
import { isAlignmentSatisfied } from './discovery'
import { isGuardRequired } from './model'
import { Grid, hex, pack } from './pixels'
import type { Row } from './view'
import { completionEvidenceOf, verificationLine } from './verification'
import type { VerificationEvidence } from './verification'

export type FlowTier = 'HAIKU' | 'SONNET' | 'OPUS'
export type NodeId = 'input' | 'discovery' | 'routing' | 'workers' | 'verify' | 'done'
export type NodeState = 'pending' | 'active' | 'verified' | 'failed' | 'blocked'

export const NODES: readonly { id: NodeId; full: string; short: string }[] = [
  { id: 'input', full: 'INPUT', short: 'IN' },
  { id: 'discovery', full: 'DISCOVERY', short: 'DSC' },
  { id: 'routing', full: 'ROUTING', short: 'RTE' },
  { id: 'workers', full: 'WORKERS', short: 'WRK' },
  { id: 'verify', full: 'VERIFY', short: 'VFY' },
  { id: 'done', full: 'DONE', short: 'OK' },
]

export type FlowInput = {
  task: Task | null
  /** The host says a turn is running. */
  isWorking: boolean
  /** Agents the host reported, by tier, with whether each is running now. */
  agents: readonly { tier: FlowTier | null; running: boolean }[]
  /** The tier of the model the host reported for the main loop, when it did. */
  mainTier: FlowTier | null
}
export type Flow = {
  states: readonly NodeState[]
  /** Genuine activity right now: a turn is running or an observed agent is running. */
  live: boolean
  /** The tiers of the agents observed running, one entry each, in a fixed order. */
  running: readonly FlowTier[]
  mainTier: FlowTier | null
  /** The node the energy flows into: the first active one past INPUT, or -1. */
  head: number
  /**
   * What a recorded DONE claim rests on; null while the task claims no DONE. Optional so a consumer that builds or
   * destructures the shape from an earlier release keeps type-checking: this is a presentation extension only.
   */
  completion?: VerificationEvidence | null
}

const WORK = ['RESEARCH', 'PLAN', 'IMPLEMENT', 'FIX']
const CHECK = ['TEST', 'VERIFY']
const ORDER: readonly FlowTier[] = ['HAIKU', 'SONNET', 'OPUS']

const gatesOk = (task: Task): boolean => {
  const required = (Object.values(task.gates) as Gate[]).filter(g => g.isRequired)

  // no required gate is the task model's own rule too: such a task reads DONE once its milestones are
  return required.every(g => (['pass', 'na'] as GateState[]).includes(g.state))
}

export const flowOf = (i: FlowInput): Flow => {
  const task = i.task
  const running = ORDER.flatMap(t => i.agents.filter(a => a.running && a.tier === t).map(() => t))
  const live = i.isWorking || i.agents.some(a => a.running)
  const states: NodeState[] = ['pending', 'pending', 'pending', 'pending', 'pending', 'pending']
  if (task !== null) {
    const hasPlan = task.milestones.length > 0
    states[0] = 'verified'
    const level = task.discovery?.level
    const discovered = hasPlan || level === undefined || level === 'LIGHT' || (task.discovery?.criteria.length ?? 0) > 0
    states[1] = discovered ? 'verified' : 'active'
    if (hasPlan) states[2] = 'verified'
    else states[2] = discovered ? 'active' : 'pending'
    if (hasPlan) {
      const work = task.milestones.filter(m => WORK.includes(m.phase))
      const checks = task.milestones.filter(m => CHECK.includes(m.phase))
      const workDone = work.every(m => m.state === 'done')
      states[3] = work.some(m => m.state === 'failed') ? 'failed' : work.some(m => m.state === 'blocked') ? 'blocked' : workDone ? 'verified' : 'active'
      const anyGateFailed = (Object.values(task.gates) as Gate[]).some(g => g.state === 'fail')
      const verified = workDone && checks.every(m => m.state === 'done') && gatesOk(task) && isAlignmentSatisfied(task)
      states[4] = anyGateFailed || checks.some(m => m.state === 'failed') ? 'failed' : checks.some(m => m.state === 'blocked') ? 'blocked' : verified ? 'verified' : workDone ? 'active' : 'pending'
      const finished = task.status === 'done' && task.percent === 100
      const owed = task.review !== undefined && task.review.state !== 'adjudicated'
      states[5] = finished ? 'verified' : states[4] === 'verified' ? (owed || task.status === 'blocked' ? 'blocked' : 'active') : 'pending'
      // a blocker held on the task marks the stage it is stopping
      if (task.status === 'blocked' && !states.includes('blocked')) { const at = states.findIndex(s => s === 'active'); if (at >= 0) states[at] = 'blocked' }
    }
  }
  const head = states.findIndex((s, n) => n > 0 && s === 'active')
  const completion = task?.status === 'done' ? completionEvidenceOf(task, isGuardRequired()) : null

  return { states, live, running, mainTier: i.mainTier, head, completion }
}

// ---------------------------------------------------------------------------
// Colour. Amber is Haiku, cyan Sonnet, violet Opus, green a verified result.
// Dark and light variants; state is also carried by the glyph, never colour alone.
// ---------------------------------------------------------------------------

type Tone = { dark: string; light: string }
const TONES = {
  HAIKU: { dark: '#FFB020', light: '#AD6400' },
  SONNET: { dark: '#22E3F0', light: '#0B7C93' },
  OPUS: { dark: '#B18CFF', light: '#6B3FD4' },
  verified: { dark: '#3BE07F', light: '#18883A' },
  failed: { dark: '#FF5C7A', light: '#B00020' },
  pending: { dark: '#7B8496', light: '#646A7E' },
  blocked: { dark: '#E6E9F0', light: '#2B3040' },
  neutral: { dark: '#C6CBD6', light: '#3A4152' },
} as const satisfies Record<string, Tone>
const toneOf = (name: keyof typeof TONES, light: boolean): string => TONES[name][light ? 'light' : 'dark']

export const GLYPH: Record<NodeState, string> = { pending: '○', active: '◉', verified: '●', failed: '✕', blocked: '⊘' }
const EDGE = { pending: '⠤', done: '⠶', trail2: '⣤', trail1: '⣶', head: '◆' } as const

export type FlowCell = { ch: string; tone: keyof typeof TONES }
export type Layout = { mode: 'full' | 'short' | 'glyph'; edges: number[] }

/** How the row divides at a width: full labels, short codes, or glyphs only; null when even the glyphs do not fit. */
export const layoutOf = (width: number): Layout | null => {
  for (const [mode, minEdge] of [['full', 3], ['short', 2], ['glyph', 1]] as const) {
    const nodes = NODES.reduce((n, node) => n + (mode === 'full' ? node.full.length + 2 : mode === 'short' ? node.short.length + 2 : 1), 0)
    // each of the five edges has a space on either side
    const room = width - nodes - 10
    if (room >= minEdge * 5) {
      const each = Math.floor(room / 5)
      const extra = room - each * 5

      return { mode, edges: Array.from({ length: 5 }, (_, i) => each + (i < extra ? 1 : 0)) }
    }
  }

  return null
}

export type Draw = { now: number; motion: boolean }
const MARKER_MS = 90

/** The row as cells, left to right. `draw.motion` false: the ◆ rests beside the node it feeds. */
export const flowCells = (flow: Flow, width: number, draw: Draw): FlowCell[] | null => {
  const layout = layoutOf(width)
  if (layout === null) return null
  const cells: FlowCell[] = []
  const lane = (n: number): keyof typeof TONES => (n === 3 && flow.running.length > 0 ? flow.running[0]! : flow.mainTier ?? 'neutral')
  const push = (text: string, tone: keyof typeof TONES) => { for (const ch of text) cells.push({ ch, tone }) }
  const breathe = draw.motion && flow.live && Math.floor(draw.now / 450) % 2 === 1
  NODES.forEach((node, n) => {
    const state = flow.states[n]!
    const tone: keyof typeof TONES = state === 'active' ? lane(n) : state === 'verified' ? 'verified' : state === 'failed' ? 'failed' : state === 'blocked' ? 'blocked' : 'pending'
    push(state === 'active' && breathe ? '◎' : GLYPH[state], tone)
    if (layout.mode !== 'glyph') push(` ${layout.mode === 'full' ? node.full : node.short}`, tone)
    if (n === NODES.length - 1) return
    const length = layout.edges[n]!
    const into = n + 1
    const feeding = into === flow.head
    const behind = flow.states[n] === 'verified' && flow.states[into] !== 'pending' && !feeding
    const base: keyof typeof TONES = feeding ? lane(into) : behind ? 'verified' : flow.states[into] === 'failed' ? 'failed' : 'pending'
    const edge: FlowCell[] = Array.from({ length }, () => ({ ch: feeding || behind ? EDGE.done : EDGE.pending, tone: base }))
    if (feeding && flow.live) {
      // one ◆ per running tier on the WORKERS edge, otherwise one in the lane's colour
      const tiers: FlowTier[] = into === 3 && flow.running.length > 0 ? [...new Set(flow.running)] : []
      const markers: (keyof typeof TONES)[] = tiers.length > 0 ? tiers : [lane(into)]
      markers.forEach((tone, k) => {
        const at = draw.motion ? (Math.floor(draw.now / MARKER_MS) + Math.floor((k * length) / markers.length)) % length : length - 1 - (k % length)
        edge[at] = { ch: EDGE.head, tone }
        if (draw.motion) {
          const t1 = (at - 1 + length) % length
          const t2 = (at - 2 + length) % length
          if (t1 !== at && edge[t1]!.ch !== EDGE.head) edge[t1] = { ch: EDGE.trail1, tone }
          if (t2 !== at && edge[t2]!.ch !== EDGE.head) edge[t2] = { ch: EDGE.trail2, tone }
        }
      })
    }
    cells.push({ ch: ' ', tone: 'pending' }, ...edge, { ch: ' ', tone: 'pending' })
  })

  return cells.slice(0, width)
}

/** The row for a surface with a Raster. */
export const flowGrid = (flow: Flow, width: number, draw: Draw & { light: boolean }): Grid | null => {
  const cells = flowCells(flow, width, draw)
  if (cells === null) return null
  const grid = new Grid(width, 1)
  cells.forEach((c, x) => grid.set(x, 0, c.ch, pack(hex(toneOf(c.tone, draw.light))), 0x01000000))

  return grid
}

/** The row for a surface with text only: runs of one colour, so it cuts cleanly. */
export const flowRow = (flow: Flow, width: number, draw: Draw & { light: boolean }): Row | null => {
  const cells = flowCells(flow, width, draw)
  if (cells === null) return null
  const row: Row = []
  for (const c of cells) {
    const color = toneOf(c.tone, draw.light)
    const last = row[row.length - 1]
    if (last !== undefined && last.color === color) last.text += c.ch
    else row.push({ text: c.ch, color })
  }

  return row
}

/** Plain, uncoloured, unanimated: what a non-interactive command prints. Every state is spelled in words as well as drawn. */
export const flowText = (flow: Flow): string => {
  const line = NODES.map((n, i) => `${GLYPH[flow.states[i]!]} ${n.full}`).join(' → ')
  const by = (s: NodeState) => NODES.filter((_, i) => flow.states[i] === s).map(n => n.full)
  // `verified` is an internal node state. In words it means the stage is complete, not that a check ran.
  const words = (['verified', 'active', 'blocked', 'failed', 'pending'] as NodeState[]).map(s => (by(s).length === 0 ? null : `${s === 'verified' ? 'complete' : s} ${by(s).join(', ')}`)).filter(Boolean).join(' · ')
  const counts = ORDER.map(t => [t, flow.running.filter(r => r === t).length] as const).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`)
  const work = flow.running.length === 0 ? 'no agent observed running' : `observed running: ${counts.join(' · ')}`
  const completion = flow.completion == null ? [] : [`COMPLETION ${verificationLine(flow.completion)}`]

  return [`FLOW  ${line}`, words, `${work} · ${flow.live ? 'work is live' : 'idle'} · main model ${flow.mainTier ?? 'UNKNOWN'}`, ...completion].join('\n')
}
