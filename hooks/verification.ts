// v0.6.6 P3: what a completion claim actually rests on, in words, from evidence
// the task already holds. This module reports; it changes no gate, no percent,
// no Stop verdict and no release decision. It reads no clock, no process and no
// filesystem, and it keeps no state of its own.
//
// SECURITY_ATTESTED is part of the vocabulary and is deliberately reserved: no
// classifier here returns it, and no other code path may claim it. A check's
// exit 0, a reviewed gate and a person's approval are none of them a security
// attestation.

import type { Gate, GateName, Task } from '../types'

export type VerificationState =
  | 'SELF_REPORTED_UNCHECKED'
  | 'PROVISIONAL_CHECKED'
  | 'UNCHANGED_UNCHECKED'
  | 'UNKNOWN_INVALIDATED'
  | 'PROVENANCE_UNKNOWN'
  | 'SECURITY_ATTESTED'

/** Every state this build may actually claim. SECURITY_ATTESTED is excluded by the type. */
export type ClaimedVerification = Exclude<VerificationState, 'SECURITY_ATTESTED'>

export const VERIFICATION_STATES: readonly VerificationState[] = [
  'SELF_REPORTED_UNCHECKED',
  'PROVISIONAL_CHECKED',
  'UNCHANGED_UNCHECKED',
  'UNKNOWN_INVALIDATED',
  'PROVENANCE_UNKNOWN',
  'SECURITY_ATTESTED',
]

export const CLAIMABLE_STATES: readonly ClaimedVerification[] = [
  'SELF_REPORTED_UNCHECKED',
  'PROVISIONAL_CHECKED',
  'UNCHANGED_UNCHECKED',
  'UNKNOWN_INVALIDATED',
  'PROVENANCE_UNKNOWN',
]

/** Reserved, never produced by this build. Exported so the reservation is testable. */
export const RESERVED_SECURITY_ATTESTED: VerificationState = 'SECURITY_ATTESTED'
export const NOT_SECURITY_ATTESTED = 'not a security attestation'

/** One plain-language sentence per state. `SECURITY_ATTESTED` says it is reserved, not that it was claimed. */
export const STATE_MEANING: Readonly<Record<VerificationState, string>> = {
  SELF_REPORTED_UNCHECKED: 'the agent reported it; no independent applicable check is recorded',
  PROVISIONAL_CHECKED: 'an applicable check ran and its result was observed; subject to the existing verification limits',
  UNCHANGED_UNCHECKED: 'a read-only observation found no change; no new check ran',
  UNKNOWN_INVALIDATED: 'the evidence is missing, stale, mismatched or otherwise insufficient',
  PROVENANCE_UNKNOWN: 'a source is recorded, but the evidence that would support it is unavailable',
  SECURITY_ATTESTED: 'reserved; this build claims no security attestation and no code path may produce this state',
}

/**
 * P3-R1: a historical checkpoint keeps a gate state, not the source that produced it. A stored pass with no retained
 * source is provenance unknown; it is not evidence that the pass was revoked, and this display must not say it was.
 */
export const HISTORICAL_PROVENANCE_UNKNOWN = 'provenance unknown (source not retained)'

/**
 * P3-R4: a stored guard completion is history. Re-reading the enrolled script, its pin or the tree is the P2
 * revalidation's job, not this display's, and saying otherwise would claim a check that was not run here.
 */
export const GUARD_RECORD_IS_HISTORICAL = 'the stored Stop-guard record reports a successful check at that time; this display does not revalidate current script trust or tree identity'

/** The same caveat, short enough for a completion line. */
export const TRUST_NOT_REVALIDATED_HERE = 'current script trust and tree identity are not revalidated here'

export type VerificationEvidence = {
  state: ClaimedVerification
  why: string
}

/** A pass whose evidence is stale or was never qualified describes something that no longer holds. */
const isStale = (gate: Gate): boolean => typeof gate.evidence === 'string' && gate.evidence.startsWith('stale:')
const isUnqualified = (gate: Gate): boolean => typeof gate.evidence === 'string' && gate.evidence.startsWith('unqualified:')
/** P3-R3: what the record actually carries. A source marker is not itself a check detail. */
const hasRecordedEvidence = (gate: Gate): boolean => typeof gate.evidence === 'string' && gate.evidence.trim().length > 0

/** The strongest claim the applicable passes support: the weakest of them decides, and no pass is stronger than a check. */
const weakest = (states: readonly ClaimedVerification[]): ClaimedVerification => {
  if (states.includes('UNKNOWN_INVALIDATED')) return 'UNKNOWN_INVALIDATED'
  if (states.includes('PROVENANCE_UNKNOWN')) return 'PROVENANCE_UNKNOWN'
  if (states.includes('SELF_REPORTED_UNCHECKED') || states.length === 0) return 'SELF_REPORTED_UNCHECKED'

  return 'PROVISIONAL_CHECKED'
}

/**
 * What one gate's recorded state proves. Only a pass is a claim; a pending,
 * unset or failed gate is not evidence of completion and is reported as such by
 * the caller. A pass with no recorded source cannot be attributed reliably.
 */
export const gateEvidenceOf = (gate: Gate): ClaimedVerification => {
  if (gate.state !== 'pass') return 'UNKNOWN_INVALIDATED'
  if (isStale(gate) || isUnqualified(gate)) return 'UNKNOWN_INVALIDATED'
  // P3-R3: an automatic source marker alone does not document an applicable check. Without a recorded result the
  // provenance is unknown, not invalidated: nothing here shows the result was revoked or went stale.
  if (gate.source === 'auto') return hasRecordedEvidence(gate) ? 'PROVISIONAL_CHECKED' : 'PROVENANCE_UNKNOWN'
  if (gate.source === 'model') return 'SELF_REPORTED_UNCHECKED'

  return 'UNKNOWN_INVALIDATED'
}

/** The qualifier a human-readable gate line carries after `NAME pass`. */
export const gateClaimText = (name: GateName, gate: Gate): string => {
  if (gate.state !== 'pass') return ''
  const state = gateEvidenceOf(gate)
  const note = state === 'SELF_REPORTED_UNCHECKED'
    ? 'reported by Claude, not read from a command'
    : state === 'PROVISIONAL_CHECKED'
      ? 'read from a command'
      : state === 'PROVENANCE_UNKNOWN'
        ? 'automatic source recorded; check details unavailable'
        : isStale(gate)
          ? 'stale: the evidence once passed on something that has since changed'
          : isUnqualified(gate)
            ? 'unqualified: the result was observed without a tree identity'
            : 'no usable source is recorded'

  return `${state} · ${note}${name === 'SECURITY' ? ` · ${NOT_SECURITY_ATTESTED}` : ''}`
}

/**
 * The Stop guard's own completion record, as the task holds it. `unchanged` is
 * not a check: the guard measured the tree and no script ran. `verified` is a
 * completed run of the enrolled script; whether that trust is still in force is
 * the P2 revalidation's question, not this display's.
 */
export const guardEvidenceOf = (task: Task | null): VerificationEvidence | null => {
  if (task === null || task.guardDone === undefined) return null
  if (task.guardDone.uid !== (task.lineage ?? `${task.id}@${task.startedAt}`)) {
    return { state: 'UNKNOWN_INVALIDATED', why: 'the recorded guard completion belongs to another task' }
  }
  if (task.stopHold !== undefined) {
    return { state: 'UNKNOWN_INVALIDATED', why: 'the Stop guard holds this task, so its recorded completion is not current' }
  }
  if (task.guardDone.outcome === 'unchanged') {
    return { state: 'UNCHANGED_UNCHECKED', why: "the working tree matched this task's start; no check was run" }
  }
  if (task.guardDone.outcome === 'verified') {
    return { state: 'PROVISIONAL_CHECKED', why: GUARD_RECORD_IS_HISTORICAL }
  }

  return { state: 'UNKNOWN_INVALIDATED', why: 'the guard completion has no recognised outcome' }
}

/**
 * What a recorded DONE claim rests on, using only what the task already holds.
 * The weakest applicable evidence decides: one self-reported required gate is
 * enough to keep the whole claim self-reported, and one stale or unattributable
 * gate makes it unknown. A guard completion can raise, but never lower, the
 * evidence its gates carry.
 */
export const completionEvidenceOf = (task: Task | null, guardRequired: boolean): VerificationEvidence => {
  if (task === null) return { state: 'UNKNOWN_INVALIDATED', why: 'no task is recorded' }
  if (task.stopHold !== undefined) {
    return { state: 'UNKNOWN_INVALIDATED', why: 'the Stop guard holds this task; no completion claim is supported' }
  }
  if (task.status !== 'done' || task.percent !== 100) {
    return { state: 'UNKNOWN_INVALIDATED', why: 'DONE is not claimed by the recorded task' }
  }
  if (task.milestones.length === 0 || task.milestones.some(one => one.state !== 'done')) {
    return { state: 'UNKNOWN_INVALIDATED', why: 'the milestone record does not support the DONE claim' }
  }

  const required = Object.entries(task.gates) as [GateName, Gate][]
  const claimed = required.filter(([, gate]) => gate.isRequired)
  if (claimed.some(([, gate]) => gate.state !== 'pass' && gate.state !== 'na')) {
    return { state: 'UNKNOWN_INVALIDATED', why: 'a required gate is not settled, so the DONE claim is unsupported' }
  }
  const passes = claimed.filter(([, gate]) => gate.state === 'pass')
  const gateStates = passes.map(([, gate]) => gateEvidenceOf(gate))
  if (gateStates.includes('UNKNOWN_INVALIDATED')) {
    return { state: 'UNKNOWN_INVALIDATED', why: 'a required pass is stale, unqualified or otherwise invalid' }
  }
  if (gateStates.includes('PROVENANCE_UNKNOWN')) {
    return { state: 'PROVENANCE_UNKNOWN', why: 'a required pass records an automatic source without the check details that would support it' }
  }
  const gateState: ClaimedVerification = weakest(gateStates)
  const guard = guardEvidenceOf(task)
  if (!guardRequired) {
    if (gateState === 'PROVISIONAL_CHECKED') {
      return { state: 'PROVISIONAL_CHECKED', why: 'every required pass is read from a command; the milestones themselves are reports' }
    }

    return { state: 'SELF_REPORTED_UNCHECKED', why: passes.length === 0 ? 'the DONE claim rests on milestones and n/a gates, with no applicable check' : 'at least one required pass was reported, not read from a command' }
  }
  if (guard === null) {
    return { state: 'UNKNOWN_INVALIDATED', why: 'the Stop guard is required and no completed guard record is present for this task' }
  }
  if (guard.state === 'UNKNOWN_INVALIDATED') return guard
  if (guard.state === 'UNCHANGED_UNCHECKED') {
    if (gateState === 'PROVISIONAL_CHECKED') return { state: 'PROVISIONAL_CHECKED', why: `${guard.why}; the required gates that passed were read from commands` }

    return { state: 'UNCHANGED_UNCHECKED', why: guard.why }
  }
  if (passes.length === 0) {
    return { state: 'PROVISIONAL_CHECKED', why: `the stored Stop-guard record reports a successful check; no required gate pass needed checking; ${TRUST_NOT_REVALIDATED_HERE}` }
  }
  if (gateState === 'PROVENANCE_UNKNOWN') {
    return { state: 'PROVENANCE_UNKNOWN', why: `the stored Stop-guard record reports a successful check, but a required pass records an automatic source without check details; ${TRUST_NOT_REVALIDATED_HERE}` }
  }
  if (gateState === 'SELF_REPORTED_UNCHECKED') {
    return { state: 'SELF_REPORTED_UNCHECKED', why: 'the stored Stop-guard record reports a successful check, but at least one required pass was only reported' }
  }

  return { state: 'PROVISIONAL_CHECKED', why: `the stored Stop-guard record reports a successful check and every required pass was read from a command; ${TRUST_NOT_REVALIDATED_HERE}` }
}

/** `/cockpit ready` and the HUD: `STATE · why · not a security attestation`. */
export const verificationLine = (evidence: VerificationEvidence): string =>
  `${evidence.state} · ${evidence.why} · ${NOT_SECURITY_ATTESTED}`

