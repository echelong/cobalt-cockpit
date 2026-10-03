// What the HUD and the Mission Control pane say, as rows of styled text
// sized to the columns they are given. Pure: register.tsx turns the rows into
// elements. Every number drawn here is read off the task, the repository or
// the session; nothing is estimated.

import type { Activity, Gate, GateName, GitState, Meter, Task } from '../types'
import { aheadBehindLabel, branchLabel, dirtyLabel, shaLabel } from './git'
import { GATES, settle } from './model'
import { GATE_GLYPH, GATE_TONE, MILESTONE_GLYPH, PALETTE, STAGE_LABEL, STAGE_SHORT, STATE_COLOR, STATE_LABEL, label as segLabel } from './theme'
import type { VisualState } from './theme'
import { MICRO, OPERATOR } from './mascot'

/**
 * The colours a `Text` may be given. A state resolves to a host colour where
 * the host has one (so a terminal's own success green is the success green),
 * and to the palette's own hex where it does not. The accent is the vivid red
 * the whole identity is built on.
 */
export const COLORS = {
  accent: PALETTE.red,
  cyan: PALETTE.cyan,
  steel: PALETTE.steel,
  silver: PALETTE.silver,
  ok: 'success',
  bad: 'error',
  warn: 'warning',
} as const

/** The accent as a Raster cell paints it (0x00RRGGBB). */
export const ACCENT_RGB = 0xe01e41
export const IDLE_RGB = 0x646a7e
/** A Raster cell's "terminal default" color. */
export const DEFAULT_RGB = 0x01000000

/** The colour a state draws in, as a `Text` colour. */
export const stateColor = (state: VisualState): string => {
  if (state === 'done') return COLORS.ok
  if (state === 'error') return COLORS.bad
  if (state === 'needs_input') return COLORS.warn
  if (state === 'glitch') return COLORS.cyan

  return state === 'idle' ? COLORS.steel : COLORS.accent
}

/** The same, as the raw hex the SVG and the cell grids paint with. */
export const stateHex = (state: VisualState): string => STATE_COLOR[state]

export type Segment = {
  text: string
  color?: string
  isDim?: boolean
  isBold?: boolean
  /** Marks the activity waveform: drawn as a Raster where the surface has one. */
  isWave?: boolean
}

export type Row = Segment[]

export type HudInput = {
  task: Task | null
  activity: Activity
  git: GitState | null
  meter: Meter
  /** The engine's own word on whether a turn is running. */
  isWorking: boolean
}

const WAVE_GLYPHS = '▁▂▃▄▅▆▇█'

/** The waveform's bar heights (0 to 7) at one frame: two beating sines, no noise. */
export const waveLevels = (frame: number, width: number): number[] =>
  Array.from({ length: width }, (_, column) => {
    const carrier = Math.sin(frame * 0.55 + column * 0.9)
    const envelope = 0.55 + 0.45 * Math.sin(frame * 0.21 + column * 1.7)

    return Math.max(0, Math.min(7, Math.round(3.5 + 3.5 * carrier * envelope)))
  })

export const waveText = (frame: number | null, width: number): string =>
  frame === null
    ? WAVE_GLYPHS.charAt(0).repeat(width)
    : waveLevels(frame, width)
        .map(level => WAVE_GLYPHS.charAt(level))
        .join('')

/** The waveform as a Raster's cells: `[codePoint, foreground, background]` per column. */
export const waveCells = (frame: number | null, width: number): string => {
  const levels = frame === null ? Array.from({ length: width }, () => 0) : waveLevels(frame, width)
  const bytes = new Uint8Array(width * 12)
  const view = new DataView(bytes.buffer)
  levels.forEach((level, column) => {
    view.setUint32(column * 12, 0x2581 + level, true)
    view.setUint32(column * 12 + 4, frame === null ? IDLE_RGB : ACCENT_RGB, true)
    view.setUint32(column * 12 + 8, DEFAULT_RGB, true)
  })
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

export const bar = (percent: number, width: number): { filled: string; empty: string } => {
  const cells = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return { filled: '█'.repeat(cells), empty: '░'.repeat(width - cells) }
}

const GATE_LETTER: Record<GateName, string> = {
  CODE: 'C',
  TEST: 'T',
  TYPE: 'Y',
  BUILD: 'B',
  SECURITY: 'S',
  GIT: 'G',
}

/** A gate reads in its host's own status colour, and dim when nothing is known. */
const gateColor = (gate: Gate): Pick<Segment, 'color' | 'isDim'> => {
  const color = GATE_TONE[gate.state]

  return color === undefined ? { isDim: true } : { color }
}

const unsetGate: Gate = { state: 'unset', isRequired: false, evidence: null, source: null, at: null }

const gateOf = (task: Task | null, name: GateName): Gate => task?.gates[name] ?? unsetGate

/** Cuts a row to `columns` cells, dropping what does not fit from the right. */
export const fit = (row: Row, columns: number): Row => {
  const kept: Row = []
  let left = Math.max(0, columns)
  for (const one of row) {
    const chars = [...one.text]
    if (left === 0) break
    if (chars.length <= left) {
      kept.push(one)
      left -= chars.length
    } else if (!one.isWave) {
      kept.push({ ...one, text: left > 1 ? `${chars.slice(0, left - 1).join('')}…` : chars.slice(0, left).join('') })
      left = 0
    } else {
      left = 0
    }
  }

  return kept
}

export const rowText = (row: Row): string => row.map(one => one.text).join('')

const SEP: Segment = { text: ' · ', isDim: true }

const joined = (parts: readonly Row[]): Row =>
  parts.filter(part => part.length > 0 && rowText(part) !== '').flatMap((part, index) => (index === 0 ? part : [SEP, ...part]))

/**
 * Which of the six states the whole plugin is in, derived from the task and the
 * engine's own word on the turn. Lives here rather than in progress-visual.ts
 * because both the HUD drawings and the text fallbacks need it, and this is the
 * module neither imports back.
 *
 * A failure and a verified result outrank everything, and a question outranks
 * both. Of what is left: no turn running is idle, a turn running with no tool
 * inside it is scanning, and a turn running a tool is working.
 */
export const visualStateOf = (input: HudInput, waiting = false): VisualState => {
  const task = input.task
  // Re-settled before it is believed: a stale or hot-reloaded DONE flag with a
  // gate still open cannot put the plugin in a verified state.
  const genuine = task === null ? null : settle(task).task
  const done = task?.status === 'done' && genuine?.status === 'done' && genuine.percent === 100
  const error =
    task?.milestones.some(m => m.state === 'failed') ||
    Object.values(task?.gates ?? {}).some(g => g.state === 'fail') ||
    ((task?.failures.length ?? 0) > 0 && task?.phase === 'FIX')
  const working = input.isWorking && input.activity.isWorking
  if (error) return 'error'
  if (waiting || task?.status === 'blocked') return 'needs_input'
  if (done) return 'done'
  // No turn running is idle, task or no task: the operator is at rest, whatever
  // the task's own status word says. Cyan is only for a live turn.
  if (!input.isWorking) return 'idle'

  return working && input.activity.kind !== 'THINK' ? 'running' : 'glitch'
}

/** What the task is doing, in a word or three. */
export const statusWord = (input: HudInput): string => {
  const { task, activity, isWorking } = input
  const agents = activity.agents.length
  const withAgents = (text: string) => (agents > 0 ? `${text} +${agents} agent${agents === 1 ? '' : 's'}` : text)
  const verdict =
    task?.status === 'unverified' ? 'UNVERIFIED' : task?.status === 'blocked' ? 'BLOCKED' : task?.status === 'done' ? 'DONE' : ''
  if (isWorking) {
    const doing = activity.kind === 'IDLE' ? 'THINK' : activity.kind
    const now = activity.detail !== '' ? `${doing} ${activity.detail}` : doing

    return withAgents(verdict !== '' && verdict !== 'DONE' ? `${verdict} · ${now}` : now)
  }
  if (verdict !== '') return withAgents(verdict)

  return withAgents(task !== null && task.status === 'active' ? 'PAUSED' : 'IDLE')
}

// At the narrow widths there is no room for a full stage word, and a cut one
// reads worse than a short one.
const stageWord = (stage: string): string => STAGE_SHORT[stage] ?? stage

const percentText = (task: Task | null): string =>
  task === null || task.milestones.length === 0 ? '--%' : `${task.percent}%`

const contextRow = (meter: Meter, barWidth: number): Row => {
  const { percent } = meter
  if (percent === null) return [{ text: 'CTX --', isDim: true }]
  const color = percent >= 85 ? COLORS.bad : percent >= 70 ? COLORS.warn : undefined
  const head: Row = [{ text: 'CTX ', isDim: true }]
  if (barWidth > 0) {
    const cells = bar(percent, barWidth)
    head.push({ text: cells.filled, ...(color ? { color } : {}) }, { text: `${cells.empty} `, isDim: true })
  }

  return [...head, { text: `${percent}%`, ...(color ? { color } : {}) }]
}

const gateRow = (task: Task | null, form: 'full' | 'letters' | 'glyphs'): Row =>
  GATES.flatMap((name, index): Row => {
    const gate = gateOf(task, name)
    const glyph: Segment = { text: GATE_GLYPH[gate.state], ...gateColor(gate) }
    if (form === 'glyphs') return [glyph]
    const gap: Row = index === 0 ? [] : [{ text: form === 'full' ? '  ' : ' ' }]
    const name_ = form === 'full' ? `${name} ` : GATE_LETTER[name]

    return [...gap, { text: name_, isDim: gate.state === 'unset' || gate.state === 'na' }, glyph]
  })

const modelLabel = (meter: Meter): string =>
  [meter.model?.replace(/^claude-/, '') ?? '', meter.effort ?? ''].filter(Boolean).join(' · ')

/**
 * The HUD as plain rows of text, for a surface with neither Raster nor Svg.
 * It carries the same information as the drawn band in the same order, and the
 * same grammar: the operator's state, the track, the stage, the percentage, the
 * gates, the context meter, the repository.
 *
 * Three rows wide, fewer and terser as the columns run out, never wider than
 * `columns` and never taller than `maxRows`.
 */
export const hudRows = (input: HudInput, columns: number, maxRows = 3): Row[] => {
  const { task, git, meter, isWorking } = input
  const state = visualStateOf(input)
  const color = stateColor(state)
  const phase = task?.phase ?? 'RESEARCH'
  const stage = STAGE_LABEL[phase] ?? phase
  const percent = task?.percent ?? 0
  const project = (git?.project ?? '').toUpperCase()
  const wave = (width: number): Segment => ({
    text: waveText(null, width),
    isWave: true,
    ...(isWorking ? { color } : { isDim: true }),
  })
  const progress = (width: number): Row => {
    const cells = bar(percent, width)

    return [{ text: cells.filled, color }, { text: cells.empty, isDim: true }, { text: ` ${percentText(task)}`, isBold: true }]
  }
  const badge = MICRO[state]

  // One row: the badge, the stage, the percentage, and the gates as bare glyphs.
  if (columns < 34 || maxRows < 2) {
    return [
      fit(
        [
          { text: badge, color },
          { text: ' ' },
          { text: stageWord(stage), color, isBold: true },
          { text: ` ${percentText(task)} `, isBold: true },
          ...gateRow(task, 'glyphs'),
          ...(meter.percent === null ? [] : [{ text: ` C${meter.percent}%`, isDim: true }]),
        ],
        columns,
      ),
    ]
  }

  // Two rows: the repository line, then the work.
  if (columns < 60 || maxRows < 3) {
    const dirty = git !== null && git.isRepo && git.dirty > 0 ? `±${git.dirty}` : ''

    return [
      fit(
        joined([
          [{ text: segLabel('REPO', project || 'COCKPIT'), color: COLORS.accent, isBold: true }],
          [{ text: branchLabel(git) }],
          [{ text: dirty, color: COLORS.warn }],
          [{ text: aheadBehindLabel(git), isDim: true }],
        ]),
        columns,
      ),
      fit(
        [
          { text: badge, color },
          { text: ' ' },
          { text: stageWord(stage), color, isBold: true },
          { text: ' ' },
          ...progress(columns < 46 ? 6 : 10),
          { text: ' ' },
          ...gateRow(task, 'glyphs'),
          { text: ' ' },
          ...contextRow(meter, 0),
        ],
        columns,
      ),
    ].slice(0, maxRows)
  }

  // Three rows: identity and repository, the track and what is happening, then
  // the technical strip: gates, context, model.
  const isWide = columns >= 96
  const dirty = dirtyLabel(git)
  const top: Row = [
    { text: badge, color, isBold: true },
    { text: ' ' },
    { text: segLabel('STATE', STATE_LABEL[state]), color, isBold: true },
    { text: '   ' },
    { text: OPERATOR, color: COLORS.steel, isBold: true },
    { text: '   ' },
    ...joined([
      [{ text: segLabel('REPO', project || 'COCKPIT'), isBold: true }],
      [{ text: branchLabel(git) }],
      isWide ? [{ text: shaLabel(task?.startSha ?? git?.startSha ?? null, git?.sha ?? null), isDim: true }] : [],
      [{ text: dirty, ...(git !== null && git.dirty > 0 ? { color: COLORS.warn } : { isDim: true }) }],
      [{ text: aheadBehindLabel(git) }],
    ]),
  ]
  const middle: Row = [
    { text: stage.padEnd(9), color, isBold: true },
    { text: '  ' },
    ...progress(isWide ? 20 : 14),
    { text: '  ' },
    wave(7),
    { text: '  ' },
    { text: statusWord(input), ...(isWorking ? {} : { isDim: true }) },
  ]
  const model = modelLabel(meter)
  const bottom: Row = [
    ...gateRow(task, columns >= 72 ? 'full' : 'letters'),
    { text: '   ' },
    ...contextRow(meter, isWide ? 8 : 0),
    ...(isWide && model !== '' ? [{ text: `  ${model}`, isDim: true }] : []),
  ]

  return [fit(top, columns), fit(middle, columns), fit(bottom, columns)]
}

export const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`

  return `${seconds}s`
}

const tokens = (count: number | null): string => {
  if (count === null) return '--'
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`

  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count)
}

/**
 * A section opener in the dossier grammar: a numbered index, a `SECTION / NAME`
 * label, and a hairline rule that reaches to the edge of the body. It is the
 * only thing in the pane allowed to be loud.
 */
export const heading = (index: string, name: string, columns: number, color: string): Row[] => {
  const title = `${index} ${segLabel(name)}`
  const rule = columns - title.length - 2

  return [
    [],
    [
      { text: `${title} `, color, isBold: true },
      ...(rule > 1 ? [{ text: '─'.repeat(rule), isDim: true }] : []),
    ],
  ]
}

/** A `FIELD / value` line, indented one step under its section. */
const field = (name: string, value: Row, width = 13): Row => [{ text: ` ${name.padEnd(width)}`, isDim: true }, ...value]

/**
 * Mission Control: the tactical dossier. Readable first — a numbered section per
 * subject, a `FIELD / value` line per fact, dimmed evidence — and only then
 * dressed in the panel language.
 */
export const paneRows = (input: HudInput, columns: number, now: number, withBanner = true): Row[] => {
  const { task } = input
  const rows: Row[] = []
  const state = visualStateOf(input)
  const color = stateColor(state)
  const push = (...added: Row[]) => rows.push(...added.map(row => fit(row, columns)))
  // The dossier is numbered so a reader can say "06" and mean one thing. The
  // numbers are assigned before anything is printed, because FAULTS is only
  // there when there are faults.
  const section = { task: '01', progress: '02', milestones: '03', verification: '04', files: '05', faults: '06', repo: '07', session: '08' }

  // The banner: who is reporting, in what state, doing what. Surfaces that draw
  // pictures put the operator's portrait beside it instead and say nothing here.
  if (withBanner) {
    push(
      [
        { text: `${MICRO[state]} `, color, isBold: true },
        { text: OPERATOR, color, isBold: true },
        { text: `  ${segLabel('CONSOLE', 'MISSION')}`, isDim: true },
      ],
      [{ text: ` ${segLabel('STATE', STATE_LABEL[state])}`, color, isBold: true }, { text: `  ${statusWord(input)}`, ...(input.isWorking ? {} : { isDim: true }) }],
    )
  }

  if (task === null) {
    push(...heading(section.task, 'TASK', columns, color))
    push([{ text: '  No task yet. ', isDim: true }, { text: 'Send a prompt to start one.', isDim: true }])
    push(...repoSection(input, columns, color, section.repo, section.session))

    return rows
  }

  push(...heading(section.task, 'TASK', columns, color))
  push(field('Goal', [{ text: task.goal || '(no prompt text)' }]))
  push(field('Kind', [{ text: task.kind }, { text: task.milestones.length === 0 ? '  unplanned' : `  ${task.milestones.length} milestones`, isDim: true }]))
  push(field('Started', [{ text: `${duration(now - task.startedAt)} ago`, isDim: true }, { text: `  updated ${duration(now - task.updatedAt)} ago`, isDim: true }]))

  push(...heading(section.progress, 'PROGRESS', columns, color))
  const done = task.milestones.filter(one => one.state === 'done').length
  const cells = bar(task.percent, Math.max(8, Math.min(24, columns - 30)))
  push(
    field('Phase', [
      { text: STAGE_LABEL[task.phase] ?? task.phase, color, isBold: true },
      { text: '  ', isDim: true },
      { text: cells.filled, color },
      { text: cells.empty, isDim: true },
      { text: `  ${percentText(task)}`, isBold: true },
    ]),
    field('Milestones', [{ text: `${done}/${task.milestones.length}`, color: done === task.milestones.length ? COLORS.ok : undefined }, { text: `  ${task.status.toUpperCase()}`, color }]),
  )
  if (task.blocker !== null) push(field('Blocker', [{ text: task.blocker, color: COLORS.warn }]))
  push(field('Latest', [{ text: task.lastAction === null ? 'nothing yet' : `${duration(now - task.lastAction.at)} ago  ${task.lastAction.text}`, ...(task.lastAction === null ? { isDim: true } : {}) }]))

  push(...heading(section.milestones, 'MILESTONES', columns, color))
  if (task.milestones.length === 0) {
    push([{ text: '  none defined', isDim: true }])
  }
  for (const one of task.milestones) {
    const glyphColor = one.state === 'done' ? COLORS.ok : one.state === 'failed' ? COLORS.bad : one.state === 'active' ? color : undefined
    push([
      { text: `  ${MILESTONE_GLYPH[one.state]} `, ...(glyphColor ? { color: glyphColor } : { isDim: true }) },
      { text: `${one.id.padEnd(4)}${one.title}`, ...(one.state === 'pending' ? { isDim: true } : {}) },
      { text: `  ${STAGE_LABEL[one.phase] ?? one.phase}`, isDim: true },
      ...(one.note !== null ? [{ text: `  ${one.note}`, isDim: true }] : []),
    ])
  }

  push(...heading(section.verification, 'VERIFICATION', columns, color))
  for (const name of GATES) {
    const gate = task.gates[name]
    push([
      { text: `  ${GATE_GLYPH[gate.state]} `, ...gateColor(gate) },
      { text: `${name.padEnd(10)}`, ...(gate.state === 'unset' ? { isDim: true } : {}) },
      { text: `${(gate.state === 'na' ? 'n/a' : gate.state).padEnd(9)}`, ...gateColor(gate) },
      { text: gate.evidence ?? (gate.isRequired ? 'required, not yet verified' : ''), isDim: true },
    ])
  }

  const added = task.files.reduce((sum, one) => sum + one.added, 0)
  const removed = task.files.reduce((sum, one) => sum + one.removed, 0)
  push(...heading(section.files, 'FILES', columns, color))
  push([
    { text: `  ${task.files.length} touched`, isDim: true },
    ...(task.files.length > 0 ? [{ text: `   +${added}`, color: COLORS.ok }, { text: ` −${removed}`, color: COLORS.bad }] : []),
  ])
  const shown = task.files.slice(-8)
  if (task.files.length > shown.length) push([{ text: `  … ${task.files.length - shown.length} earlier`, isDim: true }])
  for (const file of shown) {
    const counts = ` +${file.added} −${file.removed}`
    const room = Math.max(8, columns - counts.length - 4)
    const path = file.path.length > room ? `…${file.path.slice(file.path.length - room + 1)}` : file.path
    push([{ text: `  ${path}` }, { text: counts, isDim: true }])
  }

  if (task.failures.length > 0) {
    push(...heading(section.faults, 'FAULTS', columns, color))
    for (const failure of task.failures.slice(-5)) push([{ text: `  ${duration(now - failure.at)} ago  `, isDim: true }, { text: failure.text, color: COLORS.bad }])
  }

  push(...repoSection(input, columns, color, section.repo, section.session))

  return rows
}

/** The last two sections of the dossier: the repository, then the session. */
const repoSection = (input: HudInput, columns: number, color: string, repo: string, session: string): Row[] => {
  const { task, activity, git, meter } = input
  const rows: Row[] = []
  const push = (...added: Row[]) => rows.push(...added.map(row => fit(row, columns)))

  push(...heading(repo, 'REPOSITORY', columns, color))
  if (git === null || !git.isRepo) {
    push([{ text: `  ${git === null ? 'not read yet' : `${git.project}: not a git repository`}`, isDim: true }])
  } else {
    push(
      field('Branch', [{ text: branchLabel(git), isBold: true }, { text: `  ${git.project}`, isDim: true }]),
      field('HEAD', [{ text: shaLabel(task?.startSha ?? git.startSha, git.sha) }, { text: '  start → current', isDim: true }]),
      field('Tree', [
        { text: dirtyLabel(git), ...(git.dirty > 0 ? { color: COLORS.warn } : {}) },
        {
          text: aheadBehindLabel(git) === '' ? (git.ahead === null ? '  no upstream' : '  level with upstream') : `  ${aheadBehindLabel(git)}`,
          isDim: true,
        },
      ]),
    )
  }

  push(...heading(session, 'SESSION', columns, color))
  push(
    field(
      'Context',
      meter.percent === null
        ? [{ text: 'no reading yet', isDim: true }, ...(meter.window === null ? [] : [{ text: `  window ${tokens(meter.window)} tokens`, isDim: true }])]
        : [
            ...contextRow(meter, Math.max(0, Math.min(16, columns - 44))).slice(1),
            { text: `  ${tokens(meter.tokens)} / ${tokens(meter.window)} tokens`, isDim: true },
          ],
    ),
    field('Model', [{ text: modelLabel(meter) || 'unknown' }]),
  )
  if (activity.agents.length > 0) {
    push(field('Agents', [{ text: `${activity.agents.length} subagent${activity.agents.length === 1 ? '' : 's'} working`, isDim: true }, { text: '  counted apart from the task', isDim: true }]))
  }

  return rows
}
