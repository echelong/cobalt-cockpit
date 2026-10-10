// The task model: milestones, verification gates and what follows from them.
// Pure functions over plain data; nothing here reads a clock, counts tool
// calls or touches `$`. Progress is completed milestones over all milestones,
// and 100% exists only once every required gate is `pass` or `na`.

import type {
  Gate,
  GateName,
  GateState,
  Milestone,
  Phase,
  Stamped,
  Task,
  TaskKind,
  TaskStatus,
  TouchedFile,
  WorkPhase,
} from '../types'
import { align, alignmentNote, decide, discover, discoverySummary, foldAliases, invalidateAlignment, isAlignmentSatisfied, withDiscovery } from './discovery'

export const GATES: readonly GateName[] = ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT']
export const WORK_PHASES: readonly WorkPhase[] = [
  'RESEARCH',
  'PLAN',
  'IMPLEMENT',
  'TEST',
  'FIX',
  'VERIFY',
]

/** The checkpoint cue plays at the first crossing of this percentage. */
export const CUE_PERCENT = 80
/** Falling to this or below after the cue re-arms it: a new lifecycle. */
export const REARM_PERCENT = 60
/** Shown when every milestone is done but a required gate is not satisfied. */
export const UNVERIFIED_CAP = 99

const READONLY_EVIDENCE = 'read-only task'
const MAX_MILESTONES = 12
const MAX_FAILURES = 8
const MAX_FILES = 200

export type Cue = 'checkpoint' | 'complete'

export type MilestoneInput = { title: string; phase?: string }

export type PlanInput = {
  goal?: string
  kind?: string
  milestones: readonly MilestoneInput[]
  /** Keep the state of milestones whose titles are kept: a refinement, not a new task. */
  isReplan?: boolean
}

/** What a change to the task came to: the task, and a refusal when one applies. */
export type Outcome = { task: Task; error?: string; note?: string }

const unsetGate = (isRequired: boolean): Gate => ({
  state: 'unset',
  isRequired,
  evidence: null,
  source: null,
  at: null,
})

const gatesFor = (isRequired: boolean): Record<GateName, Gate> => ({
  CODE: unsetGate(isRequired),
  TEST: unsetGate(isRequired),
  TYPE: unsetGate(isRequired),
  BUILD: unsetGate(isRequired),
  SECURITY: unsetGate(isRequired),
  GIT: unsetGate(isRequired),
})

export const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line
}

/** A task as a prompt starts it: no milestones, so no progress to claim. */
export const newTask = (id: number, goal: string, now: number, startSha: string | null): Task => ({
  id,
  lifecycle: 1,
  goal: oneLine(goal, 160),
  lastPrompt: oneLine(goal, 160),
  kind: 'unplanned',
  startedAt: now,
  updatedAt: now,
  startSha,
  milestones: [],
  gates: gatesFor(false),
  percent: 0,
  phase: 'RESEARCH',
  status: 'idle',
  blocker: null,
  hasCue80Fired: false,
  hasCue100Fired: false,
  hasInstructionFileRequest: false,
  files: [],
  failures: [],
  lastAction: null,
})

/** The phase a milestone's title implies, for a plan that names none. */
export const phaseOfTitle = (title: string): WorkPhase => {
  const text = title.toLowerCase()
  if (/\b(verif|valid|review|confirm|final|sign.?off|type.?check|lint)/.test(text)) return 'VERIFY'
  if (/\b(fix|repair|debug|resolve)/.test(text)) return 'FIX'
  if (/\b(inspect|research|explor|investigat|understand|survey|analy[sz]e)|\bread\b/.test(text)) {
    return 'RESEARCH'
  }
  if (/\b(plan|design|outline|decide|scope)/.test(text)) return 'PLAN'
  if (/\b(test|spec|coverage)|\bqa\b/.test(text)) return 'TEST'

  return 'IMPLEMENT'
}

const asWorkPhase = (phase: string | undefined, title: string): WorkPhase => {
  const named = (phase ?? '').toUpperCase()

  return (WORK_PHASES as readonly string[]).includes(named)
    ? (named as WorkPhase)
    : phaseOfTitle(title)
}

export const isGateName = (name: unknown): name is GateName =>
  typeof name === 'string' && (GATES as readonly string[]).includes(name)

/** True when no required gate stands between the milestones and 100%. */
export const areGatesSatisfied = (task: Task): boolean =>
  GATES.every(name => {
    const gate = task.gates[name]

    return !gate.isRequired || gate.state === 'pass' || gate.state === 'na'
  })

export const unsatisfiedGates = (task: Task): GateName[] =>
  GATES.filter(name => {
    const gate = task.gates[name]

    return gate.isRequired && gate.state !== 'pass' && gate.state !== 'na'
  })

/** True when no Opus consultation the task requires is still outstanding (SONNET_LED). */
export const isReviewSatisfied = (task: Task): boolean => task.review === undefined || task.review.state === 'adjudicated'

/** True when nothing but the gates, the consultation and the goal check stand between the milestones and DONE. */
const isVerified = (task: Task): boolean => areGatesSatisfied(task) && isReviewSatisfied(task) && isAlignmentSatisfied(task)

const reviewNote = (task: Task): string =>
  task.review === undefined ? '' : `Opus consultation (${task.review.grounds.join(', ')}) ${task.review.state}`

const failingGates = (task: Task): GateName[] =>
  GATES.filter(name => task.gates[name].isRequired && task.gates[name].state === 'fail')

/** Completed milestones over all milestones; capped below 100 while unverified. */
export const percentOf = (task: Task): number => {
  const total = task.milestones.length
  if (total === 0) return 0
  const done = task.milestones.filter(one => one.state === 'done').length
  const percent = Math.floor((100 * done) / total)

  return percent === 100 && !isVerified(task) ? UNVERIFIED_CAP : percent
}

const statusOf = (task: Task, percent: number): TaskStatus => {
  if (task.milestones.length === 0) return 'idle'
  if (task.blocker !== null || task.milestones.some(one => one.state === 'blocked')) return 'blocked'
  if (percent === 100) return 'done'
  const open = task.milestones.filter(one => one.state !== 'done')
  const isOnlyVerifyLeft = open.every(one => one.phase === 'VERIFY')
  if (isOnlyVerifyLeft && !isVerified(task) && failingGates(task).length === 0) {
    return 'unverified'
  }

  return 'active'
}

const phaseOf = (task: Task, status: TaskStatus): Phase => {
  if (status === 'idle') return task.phase === 'DONE' || task.phase === 'BLOCKED' ? 'RESEARCH' : task.phase
  if (status === 'blocked') return 'BLOCKED'
  if (status === 'done') return 'DONE'
  const hasFailure =
    failingGates(task).length > 0 || task.milestones.some(one => one.state === 'failed')
  if (hasFailure) return 'FIX'
  const current =
    task.milestones.find(one => one.state === 'active') ??
    task.milestones.find(one => one.state === 'pending')

  return current?.phase ?? 'VERIFY'
}

/**
 * Recomputes what is derived (percent, status, phase) and settles the sound
 * cues: each fires once per lifecycle, and a fall to REARM_PERCENT or below
 * after the checkpoint starts a new lifecycle.
 */
export const settle = (task: Task): { task: Task; cues: Cue[] } => {
  const percent = percentOf(task)
  const status = statusOf(task, percent)
  const phase = phaseOf(task, status)
  const cues: Cue[] = []
  let { hasCue80Fired, hasCue100Fired, lifecycle } = task

  if (hasCue80Fired && percent <= REARM_PERCENT) {
    hasCue80Fired = false
    hasCue100Fired = false
    lifecycle += 1
  }
  if (!hasCue80Fired && percent >= CUE_PERCENT) {
    hasCue80Fired = true
    if (percent < 100) cues.push('checkpoint')
  }
  if (!hasCue100Fired && percent === 100) {
    hasCue100Fired = true
    cues.push('complete')
  }

  return {
    task: { ...task, percent, status, phase, hasCue80Fired, hasCue100Fired, lifecycle },
    cues,
  }
}

const withFailure = (failures: Stamped[], at: number, text: string): Stamped[] =>
  [...failures, { at, text: oneLine(text, 160) }].slice(-MAX_FAILURES)

const findMilestone = (task: Task, ref: unknown): Milestone | undefined => {
  if (typeof ref !== 'string' || ref.trim() === '') {
    return task.milestones.find(one => one.state === 'active')
  }
  const wanted = ref.trim().toLowerCase()

  return (
    task.milestones.find(one => one.id === wanted) ??
    task.milestones.find(one => one.title.toLowerCase() === wanted) ??
    task.milestones.find(one => one.title.toLowerCase().startsWith(wanted))
  )
}

const replaceMilestone = (task: Task, next: Milestone): Milestone[] =>
  task.milestones.map(one => (one.id === next.id ? next : one))

const unknownMilestone = (task: Task, ref: unknown): string =>
  task.milestones.length === 0
    ? 'no milestones are defined; call action "plan" first'
    : `no milestone matches ${JSON.stringify(ref ?? '')}; known: ${task.milestones
        .map(one => `${one.id} ${one.title}`)
        .join(', ')}`

/**
 * Defines the task's milestones, all pending. Only a plan that says it is a
 * re-plan carries state over, by title: a new task whose milestones happen to
 * be named like the last one's must not inherit its progress.
 */
export const planTask = (task: Task, input: PlanInput, now: number): Outcome => {
  const titles = input.milestones
    .map(one => ({ title: oneLine(String(one?.title ?? ''), 60), phase: one?.phase }))
    .filter(one => one.title !== '')
  if (titles.length === 0) return { task, error: 'a plan needs at least one milestone with a title' }
  if (titles.length > MAX_MILESTONES) {
    return { task, error: `a plan takes at most ${MAX_MILESTONES} milestones` }
  }
  const kind: TaskKind = input.kind === 'readonly' ? 'readonly' : 'coding'
  const isReplan = input.isReplan === true && task.milestones.length > 0
  const previous = isReplan ? task.milestones : []
  const milestones = titles.map((one, index): Milestone => {
    const kept = previous.find(old => old.title.toLowerCase() === one.title.toLowerCase())

    return {
      id: `m${index + 1}`,
      title: one.title,
      phase: asWorkPhase(one.phase, one.title),
      state: kept?.state ?? 'pending',
      note: kept?.note ?? null,
    }
  })
  const gates = { ...task.gates }
  for (const name of GATES) {
    const gate = gates[name]
    if (kind === 'readonly') {
      gates[name] = {
        state: 'na',
        isRequired: false,
        evidence: READONLY_EVIDENCE,
        source: 'model',
        at: now,
      }
    } else if (gate.state === 'na' && gate.evidence === READONLY_EVIDENCE) {
      gates[name] = unsetGate(true)
    } else {
      // evidence gathered before the plan (a test run while inspecting) stands
      gates[name] = { ...gate, isRequired: true }
    }
  }
  const planned: Task = {
    ...task,
    goal: input.goal !== undefined && input.goal.trim() !== '' ? oneLine(input.goal, 160) : task.goal,
    kind,
    milestones,
    gates,
    blocker: isReplan ? task.blocker : null,
    updatedAt: now,
  }
  // A goal check made before or across a plan checked a different plan: it starts over.
  const { alignment: _stale, ...unchecked } = planned

  return { task: withDiscovery(unchecked, null) }
}

export const startMilestone = (task: Task, ref: unknown, now: number): Outcome => {
  const found = findMilestone(task, ref)
  if (found === undefined) return { task, error: unknownMilestone(task, ref) }
  if (found.state === 'done') return { task, note: `${found.id} is already complete` }
  const milestones = task.milestones.map(one => {
    if (one.id === found.id) return { ...one, state: 'active' as const, note: null }

    // one milestone is in hand at a time
    return one.state === 'active' ? { ...one, state: 'pending' as const } : one
  })

  return { task: { ...task, milestones, blocker: null, updatedAt: now } }
}

/**
 * Completes a milestone. A VERIFY milestone is held `active` while a required
 * gate is unsatisfied: verification that did not happen is not complete.
 */
export const completeMilestone = (task: Task, ref: unknown, note: string | null, now: number): Outcome => {
  const found = findMilestone(task, ref)
  if (found === undefined) return { task, error: unknownMilestone(task, ref) }
  const open = unsatisfiedGates(task)
  if (found.phase === 'VERIFY' && open.length > 0) {
    const held: Milestone = { ...found, state: 'active', note: `held: ${open.join(', ')} not verified` }

    return {
      task: { ...task, milestones: replaceMilestone(task, held), updatedAt: now },
      note: `${found.id} is HELD, not complete: gate${open.length === 1 ? '' : 's'} ${open.join(
        ', ',
      )} not satisfied. Run the checks and report each with action "gate" (pass/fail), or mark a gate "na" with the reason it does not apply.`,
    }
  }
  if (found.phase === 'VERIFY' && !isReviewSatisfied(task)) {
    const held: Milestone = { ...found, state: 'active', note: `held: ${reviewNote(task)}` }

    return {
      task: { ...task, milestones: replaceMilestone(task, held), updatedAt: now },
      note: `${found.id} is HELD, not complete: ${reviewNote(task)}, and this task cannot finish without it. Request it with swarm action "consult", run the architect it admits, then verify its advice with swarm action "verify" (pass or fail, with evidence).`,
    }
  }
  if (found.phase === 'VERIFY' && !isAlignmentSatisfied(task)) {
    const held: Milestone = { ...found, state: 'active', note: `held: ${alignmentNote(task)}` }

    return {
      task: { ...task, milestones: replaceMilestone(task, held), updatedAt: now },
      note: `${found.id} is HELD, not complete: ${alignmentNote(task)}. Compare the result with the original request and report it with action "align" (ALIGNED only with evidence for each acceptance criterion; otherwise PARTIAL, BLOCKED or UNKNOWN).`,
    }
  }
  const done: Milestone = { ...found, state: 'done', note }

  return { task: { ...task, milestones: replaceMilestone(task, done), updatedAt: now } }
}

export const failMilestone = (task: Task, ref: unknown, note: string | null, now: number): Outcome => {
  const found = findMilestone(task, ref)
  if (found === undefined) return { task, error: unknownMilestone(task, ref) }
  const failed: Milestone = { ...found, state: 'failed', note }

  return {
    task: {
      ...task,
      milestones: replaceMilestone(task, failed),
      failures: withFailure(task.failures, now, `${found.title} failed${note ? `: ${note}` : ''}`),
      updatedAt: now,
      ...(task.alignment === undefined ? {} : { alignment: invalidateAlignment(task, 'milestone failed').alignment! }),
    },
  }
}

export const blockMilestone = (task: Task, ref: unknown, note: string | null, now: number): Outcome => {
  const reason = note ?? 'blocked'
  const found = findMilestone(task, ref)
  if (found === undefined) {
    // a blocker with no milestone to pin it on still blocks the task
    return {
      task: {
        ...task,
        blocker: reason,
        failures: withFailure(task.failures, now, `blocked: ${reason}`),
        updatedAt: now,
      },
    }
  }
  const blocked: Milestone = { ...found, state: 'blocked', note: reason }

  return {
    task: {
      ...task,
      milestones: replaceMilestone(task, blocked),
      blocker: reason,
      failures: withFailure(task.failures, now, `${found.title} blocked: ${reason}`),
      updatedAt: now,
    },
  }
}

export const unblock = (task: Task, now: number): Outcome => ({
  task: {
    ...task,
    blocker: null,
    milestones: task.milestones.map(one =>
      one.state === 'blocked' ? { ...one, state: 'active' as const, note: null } : one,
    ),
    updatedAt: now,
  },
})

/** The milestone phases a failing gate reopens: work that is no longer true. */
const reopenedBy = (name: GateName): readonly WorkPhase[] =>
  name === 'TEST' ? ['TEST', 'FIX', 'VERIFY'] : ['FIX', 'VERIFY']

/**
 * Records a gate. A required gate that fails reopens the completed milestones
 * it invalidates, so progress regresses instead of standing on a broken check.
 */
export const setGate = (
  task: Task,
  name: GateName,
  state: GateState,
  evidence: string | null,
  source: 'auto' | 'model',
  now: number,
): Task => {
  const before = task.gates[name]
  const gate: Gate = {
    ...before,
    state,
    evidence: evidence === null ? null : oneLine(evidence, 120),
    source,
    at: now,
  }
  let { milestones, failures } = task
  if (state === 'fail') {
    failures = withFailure(failures, now, `${name} failed${evidence ? `: ${evidence}` : ''}`)
    if (before.isRequired) {
      const phases = reopenedBy(name)
      milestones = milestones.map(one =>
        one.state === 'done' && phases.includes(one.phase)
          ? { ...one, state: 'pending' as const, note: `reopened: ${name} failed` }
          : one,
      )
    }
  }

  const next: Task = { ...task, gates: { ...task.gates, [name]: gate }, milestones, failures, updatedAt: now }

  return state === 'fail' && before.isRequired ? invalidateAlignment(next, `${name} failed`) : next
}

/** Adds one edit's line counts to the files the task has touched. */
export const touchFile = (task: Task, path: string, added: number, removed: number): Task => {
  const known = task.files.find(one => one.path === path)
  const files: TouchedFile[] =
    known !== undefined
      ? task.files.map(one =>
          one.path === path
            ? { path, added: one.added + added, removed: one.removed + removed }
            : one,
        )
      : [...task.files, { path, added, removed }].slice(-MAX_FILES)

  return invalidateAlignment({ ...task, files }, 'files changed')
}

/** Distinct files the main loop edits before a task without a plan is reminded of one. */
export const NUDGE_FILES = 2

/**
 * One reminder, from what the host observed: the main loop has edited
 * NUDGE_FILES distinct files and declared no milestones. It is said once per
 * task and moves nothing: no milestone, gate or percentage comes from it. A
 * single-file fix never sees it.
 */
export const progressNudge = (task: Task, tool: string): { task: Task; note: string } | null => {
  if (task.milestones.length > 0 || task.progressNudged === true || task.files.length < NUDGE_FILES) return null

  return {
    task: { ...task, progressNudged: true },
    note: `Cobalt Cockpit: ${task.files.length} files edited and no progress plan, so the user's HUD shows no milestones for this task. Call ${tool} with action "plan" now (3-7 milestones, the work done so far included), then start and complete them and report the verification gates.`,
  }
}

export const noteFailure = (task: Task, at: number, text: string): Task => ({
  ...task,
  failures: withFailure(task.failures, at, text),
})

/** One compact line of the task, as the tool and `/cockpit status` report it. */
export const summaryOf = (task: Task | null): string => {
  if (task === null) return 'No task yet.'
  const gates = GATES.map(name => `${name} ${task.gates[name].state}`).join(', ')
  if (task.milestones.length === 0) {
    return `No milestones defined (phase ${task.phase}). Gates: ${gates}.${discoverySummary(task)}`
  }
  const done = task.milestones.filter(one => one.state === 'done').length
  const list = task.milestones.map(one => `${one.id} ${one.title} [${one.state}]`).join('; ')
  const open = unsatisfiedGates(task)
  const verdict =
    task.status === 'done'
      ? 'DONE: every milestone complete and every required gate satisfied.'
      : task.status === 'unverified'
        ? open.length === 0
          ? !isReviewSatisfied(task)
            ? `UNVERIFIED: not done until the ${reviewNote(task)} is adjudicated.`
            : `UNVERIFIED: not done until ${alignmentNote(task)} is ALIGNED (action "align").`
          : `UNVERIFIED: not done until ${open.join(', ')} ${open.length === 1 ? 'is' : 'are'} pass or na.`
        : task.status === 'blocked'
          ? `BLOCKED: ${task.blocker ?? 'a milestone is blocked'}.`
          : open.length > 0
            ? `Open gates: ${open.join(', ')}.`
            : 'All required gates satisfied.'

  const review = task.review === undefined ? '' : ` Review: ${reviewNote(task)}.`

  return `${task.phase} ${task.percent}% (${done}/${task.milestones.length} milestones). ${verdict} Milestones: ${list}. Gates: ${gates}.${review}${discoverySummary(task)}`
}

/** The progress tool's input, as the model sends it. */
export type ProgressInput = {
  action?: unknown
  goal?: unknown
  kind?: unknown
  milestones?: unknown
  replan?: unknown
  milestone?: unknown
  gate?: unknown
  /** gate: several gates in one call, each `{ gate, state, evidence }`; all apply or none does. */
  gates?: unknown
  state?: unknown
  evidence?: unknown
  note?: unknown
  /** discover: the level to raise to, acceptance criteria, unknowns and relevant risk categories. */
  level?: unknown
  criteria?: unknown
  unknowns?: unknown
  risks?: unknown
  /** decide: one decision record. align: the original-goal check. */
  decision?: unknown
  alignment?: unknown
}

const optionalText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? oneLine(value, 160) : null

const REPORTABLE: readonly GateState[] = ['pass', 'fail', 'na', 'pending']

/**
 * One call of the progress tool applied to the task. A plan over a task that
 * was already planned, unless it is a re-plan, begins the next task: its
 * milestones, gates, files and cue flags start over.
 */
export const applyAction = (task: Task, given: ProgressInput, now: number, sha: string | null): Outcome => {
  const input = foldAliases(given as Record<string, unknown>) as ProgressInput
  const note = optionalText(input.note)
  switch (input.action) {
    case 'plan': {
      const milestones = Array.isArray(input.milestones) ? (input.milestones as MilestoneInput[]) : []
      const isReplan = input.replan === true && task.milestones.length > 0
      const goal = optionalText(input.goal)
      const base: Task =
        task.kind !== 'unplanned' && !isReplan
          ? {
              ...newTask(task.id + 1, goal ?? task.lastPrompt, now, sha),
              lastPrompt: task.lastPrompt,
              hasInstructionFileRequest: task.hasInstructionFileRequest,
              // A review the person or the files made necessary is not planned away:
              // it follows the work into the next plan until Opus has answered it.
              ...(task.review === undefined ? {} : { review: task.review }),
              ...(task.promptGrounds === undefined ? {} : { promptGrounds: task.promptGrounds }),
              // The operator's pinned level outlives the task; any other is read again from the new one.
              // The level the evidence reached is a floor for the next plan: a restart cannot lower it. The rest starts over.
              ...(task.discovery === undefined ? {} : { discovery: { ...task.discovery, objective: null, criteria: [], unknowns: [], risks: [] } }),
            }
          : task

      return planTask(
        base,
        { milestones, isReplan, ...(goal !== null ? { goal } : {}), ...(typeof input.kind === 'string' ? { kind: input.kind } : {}) },
        now,
      )
    }
    case 'start':
      return startMilestone(task, input.milestone, now)
    case 'complete':
      return completeMilestone(task, input.milestone, note, now)
    case 'fail':
      return failMilestone(task, input.milestone, note, now)
    case 'block':
      return blockMilestone(task, input.milestone, note, now)
    case 'unblock':
      return unblock(task, now)
    case 'gate': {
      if (Array.isArray(input.gates) && input.gates.length > 0) {
        let held = task
        for (const one of input.gates.slice(0, GATES.length)) {
          const row = (one !== null && typeof one === 'object' ? one : {}) as ProgressInput
          const out = applyAction(held, { action: 'gate', gate: row.gate, state: row.state, evidence: row.evidence }, now, sha)
          if (out.error !== undefined) return { task, error: `${String(row.gate)}: ${out.error}; no gate was recorded` }
          held = out.task
        }

        return { task: held }
      }
      if (!isGateName(input.gate)) return { task, error: `"gate" must be one of ${GATES.join(', ')}` }
      const state = input.state as GateState
      if (!REPORTABLE.includes(state)) return { task, error: '"state" must be pass, fail, na or pending' }
      const evidence = optionalText(input.evidence) ?? note
      if (evidence === null && (state === 'pass' || state === 'na')) {
        return {
          task,
          error:
            state === 'pass'
              ? '"evidence" is required for pass: name the command you ran and its outcome'
              : '"evidence" is required for na: say why this gate does not apply',
        }
      }

      return { task: setGate(task, input.gate, state, evidence, 'model', now) }
    }
    case 'discover':
      return discover(task, input as Parameters<typeof discover>[1], now)
    case 'decide':
      return decide(task, input as Parameters<typeof decide>[1], now)
    case 'align':
      return align(task, input as Parameters<typeof align>[1], now, unsatisfiedGates(task))
    case 'status':
      return { task }
    default:
      return { task, error: '"action" must be plan, start, complete, fail, block, unblock, gate, discover, decide, align or status' }
  }
}
