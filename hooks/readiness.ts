// Verification readiness (v0.6.0): `/cockpit ready`. A read-only explanation of the records Cockpit already holds about whether
// the task may read DONE. It is not an approval mechanism: it applies the completion rules of model.ts and discovery.ts (the
// six gates, the Stop guard's own completion, the Opus review, the goal check) to the task as recorded and says which still
// stand in the way. It changes nothing, clears nothing, and does not turn a claim into evidence.
//
// A gate marked `model` was reported by Claude; one marked `auto` was read off a real command's result. The view says which, and
// never calls a reported claim verified. A pass whose evidence is marked stale is stale, whatever its state once was.

import { GATES, isGuardHeld, isGuardOwned, isGuardRequired, isReviewSatisfied } from './model'
import { alignmentNote, isAlignmentSatisfied, needsAlignment } from './discovery'
import { completionEvidenceOf, gateClaimText, verificationLine } from './verification'
import type { Swarm, Task } from '../types'

const clip = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, Math.max(0, n - 1))}…`)
const one = (text: string): string => text.replace(/\s+/g, ' ').trim()

export type Standing = 'PERMITS DONE' | 'DOES NOT PERMIT DONE' | 'NO TASK'
export type Readiness = {
  standing: Standing
  /** What still stands in the way, in the order the completion rules apply. Empty when DONE is permitted. */
  open: string[]
  /** What is satisfied, so the view is not only a list of faults. */
  satisfied: string[]
  /** Facts that are not conditions of DONE but that a person deciding would want: reported work not verified, pending escalations. */
  notes: string[]
}

const gateLine = (task: Task, name: (typeof GATES)[number]): { text: string; ok: boolean } => {
  const g = task.gates[name]
  const stale = typeof g.evidence === 'string' && g.evidence.startsWith('stale:')
  if (!g.isRequired) return { text: `${name} not required (${g.state})`, ok: true }
  if (g.state === 'pass') return { text: `${name} pass · ${gateClaimText(name, g)}${g.evidence === null && g.source !== 'auto' ? ' · no evidence line' : ''}`, ok: true }
  if (g.state === 'na') return { text: `${name} n/a · ${g.evidence === null ? 'no reason recorded' : clip(one(g.evidence), 60)}`, ok: true }
  if (g.state === 'fail') return { text: `${name} FAILED · ${g.evidence === null ? 'no evidence line' : clip(one(g.evidence), 70)}`, ok: false }
  return { text: `${name} ${stale ? 'STALE (it passed on something that has since changed)' : g.state === 'pending' ? 'pending (not run, or not recorded)' : g.state === 'unset' ? 'not reported yet' : g.state}${stale && g.evidence !== null ? ` · ${clip(one(g.evidence), 70)}` : ''}`, ok: false }
}

/** The recorded conditions for DONE, from the task and (for pending escalations) the swarm. Pure. */
export const readinessOf = (task: Task | null, swarm: Swarm | null): Readiness => {
  if (task === null) return { standing: 'NO TASK', open: [], satisfied: [], notes: [] }
  const open: string[] = []
  const satisfied: string[] = []
  const notes: string[] = []

  // milestones
  const total = task.milestones.length
  const done = task.milestones.filter(m => m.state === 'done').length
  if (total === 0) open.push('no milestones are defined: there is no plan to complete')
  else if (done < total) {
    const left = task.milestones.filter(m => m.state !== 'done')
    open.push(`milestones ${done} of ${total} done · open: ${left.slice(0, 3).map(m => `${m.id} ${clip(one(m.title), 30)} [${m.state}]`).join('; ')}${left.length > 3 ? ` +${left.length - 3}` : ''}`)
  } else satisfied.push(`milestones ${done} of ${total} done`)
  const blocked = task.milestones.filter(m => m.state === 'blocked')
  if (task.blocker !== null) open.push(`blocker: ${clip(one(task.blocker), 90)}`)
  else if (blocked.length > 0) open.push(`blocked milestone${blocked.length === 1 ? '' : 's'}: ${blocked.map(m => m.id).join(', ')}`)

  // the Stop guard: a hold is its own, and only its own check or a person's release lifts it
  if (isGuardHeld(task)) open.push(`STOP GUARD HOLD: ${clip(one(task.stopHold?.reason ?? ''), 90)} · only the guard's own check or your /cockpit guard release lifts it`)
  else if (isGuardRequired()) {
    if (isGuardOwned(task)) {
      if (task.guardDone?.outcome === 'unchanged') satisfied.push('the Stop guard observed this task\'s working tree unchanged; no check was run')
      else satisfied.push('the Stop guard ran its check for this task and tree and recorded a pass · the stored record is historical; this view does not revalidate current script trust or tree identity')
    } else open.push('the Stop guard has not yet completed its check for this task and tree')
  }

  // the gates
  const lines = GATES.map(name => ({ name, ...gateLine(task, name) }))
  for (const l of lines) (l.ok ? satisfied : open).push(l.text)

  // the Opus consultation
  if (task.review !== undefined) {
    if (isReviewSatisfied(task)) satisfied.push(`Opus consultation (${task.review.grounds.join(', ')}) adjudicated`)
    else open.push(`Opus consultation (${task.review.grounds.join(', ')}) is ${task.review.state}, not adjudicated${task.review.grounds.includes('release') ? ' · a release NO-GO or an uncleared release ground holds the task' : ''}`)
  }

  // the goal check
  if (needsAlignment(task)) {
    const criteria = task.discovery?.criteria ?? []
    const met = criteria.filter(c => c.status === 'met' && !!c.evidence).length
    const unknowns = (task.discovery?.unknowns ?? []).filter(u => u.state === 'open').length
    if (isAlignmentSatisfied(task)) satisfied.push(`goal check ALIGNED · acceptance criteria ${met} of ${criteria.length} met with evidence (evidence is as reported; its form is checked, not its truth)`)
    else open.push(`${alignmentNote(task)} · acceptance criteria ${met} of ${criteria.length} met with evidence${unknowns > 0 ? ` · ${unknowns} unknown${unknowns === 1 ? '' : 's'} still open` : ''}`)
  } else satisfied.push('goal check not required for this task')

  // swarm facts that are not themselves conditions but that an honest "ready" cannot hide
  if (swarm !== null) {
    const pending = swarm.tasks.filter(t => t.state === 'escalated' || (t.escalation !== null && t.state !== 'completed' && t.state !== 'failed' && t.state !== 'cancelled'))
    if (pending.length > 0) notes.push(`${pending.length} agent escalation${pending.length === 1 ? '' : 's'} pending the commander: ${pending.slice(0, 4).map(t => t.id).join(', ')}`)
    const unverified = swarm.tasks.filter(t => t.state === 'completed' && t.verification !== 'pass')
    // A fail is a recorded commander judgment, not a missing one: the note groups by what is absent (an approved PASS)
    // and keeps each recorded state beside its task.
    if (unverified.length > 0) notes.push(`${unverified.length} completed agent result${unverified.length === 1 ? '' : 's'} without a commander-approved PASS: ${unverified.slice(0, 4).map(t => `${t.id} (${t.verification})`).join(', ')}`)
    const waiting = swarm.tasks.filter(t => t.state === 'queued' || t.state === 'blocked' || t.state === 'stalled')
    if (waiting.length > 0) notes.push(`${waiting.length} agent task${waiting.length === 1 ? '' : 's'} waiting or stalled: ${waiting.slice(0, 4).map(t => `${t.id} ${t.state}`).join(', ')} · /cockpit agents explains why`)
    const running = swarm.tasks.filter(t => t.state === 'running' || t.state === 'reserved')
    if (running.length > 0) notes.push(`${running.length} agent task${running.length === 1 ? '' : 's'} still running: ${running.slice(0, 4).map(t => t.id).join(', ')}`)
  }

  // DONE is what the task says it is: the existing rules decide, and this view must not disagree with them
  const standing: Standing = task.status === 'done' ? 'PERMITS DONE' : 'DOES NOT PERMIT DONE'
  if (standing === 'PERMITS DONE' && open.length > 0) open.push('the recorded status reads DONE while a condition above is open: the status is recomputed from the records at the next progress report')
  if (standing === 'DOES NOT PERMIT DONE' && open.length === 0) open.push(`the recorded status is ${task.status.toUpperCase()}: ${task.status === 'idle' ? 'no plan has been reported' : 'the next progress report or the Stop guard settles it'}`)

  return { standing, open, satisfied, notes }
}

/** `/cockpit ready`. Compact: the verdict first, what stands in the way next, then what holds, then notes; each line within the width. */
export const readyText = (task: Task | null, swarm: Swarm | null, columns: number): string => {
  const r = readinessOf(task, swarm)
  if (r.standing === 'NO TASK') return 'READY · no task is recorded in this session, so there is nothing to explain. Plan one with the progress tool.'
  const lines = [clip(`READY · ${r.standing} · ${task!.percent}% · status ${task!.status.toUpperCase()}`, columns)]
  // P3: the completion claim carries what it rests on, on its own line, before the conditions.
  lines.push(clip(`COMPLETION · ${verificationLine(completionEvidenceOf(task, isGuardRequired()))}`, Math.max(columns, 20)))
  if (r.open.length > 0) {
    lines.push('STANDING IN THE WAY')
    for (const l of r.open) lines.push(clip(`  ✗ ${l}`, Math.max(columns, 20)))
  }
  if (r.satisfied.length > 0) {
    lines.push('HOLDS')
    for (const l of r.satisfied) lines.push(clip(`  ✓ ${l}`, Math.max(columns, 20)))
  }
  if (r.notes.length > 0) {
    lines.push('ALSO')
    for (const l of r.notes) lines.push(clip(`  · ${l}`, Math.max(columns, 20)))
  }
  lines.push(clip('Read-only: approves nothing, clears nothing; a reported result is not a verified one.', Math.max(columns, 20)))

  return lines.join('\n')
}
