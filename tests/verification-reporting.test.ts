// v0.6.6 P3: a completion label says what the record actually holds. These tests
// exercise the reporting classifiers and the existing consumers of their words.
// They change no gate, no percentage, no Stop verdict and no release decision.

import { describe, expect, test } from 'claude-code/testing'
import type { Consultation, EvidencePacket, Gate, GateName, ReleaseRecord, Swarm, SwarmTask, Task } from '../types'
import { command, hostState, planAndComplete, prompt, start, world } from './world'
import { checkpointOf, emptyLedger, ledgerLines } from '../hooks/ledger'
import { flowOf, flowText } from '../hooks/flow'
import type { Flow } from '../hooks/flow'
import { consultLine, consultVerdict, releaseEligible, revalidateRelease } from '../hooks/consult'
import { applyAction, GATES, isGuardRequired, markEdited, newTask, revokeTrustedCompletion, setGuardRequired, settle, summaryOf, uidOf } from '../hooks/model'
import { readinessOf, readyText } from '../hooks/readiness'
import { STATE_LABEL } from '../hooks/theme'
import {
  CLAIMABLE_STATES,
  RESERVED_SECURITY_ATTESTED,
  completionEvidenceOf,
  gateClaimText,
  gateEvidenceOf,
  guardEvidenceOf,
  verificationLine,
} from '../hooks/verification'
import type { ClaimedVerification } from '../hooks/verification'
import { statusWord } from '../hooks/view'
import { configOf, verdictOf } from '../hooks/stopguard'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = { options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT } }
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')!.value as Task
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<string> => {
  const shown = String((await command($, 'guard trust')).text)
  const sha = /sha-256  ([0-9a-f]{64})/.exec(shown)![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)

  return sha
}

const gate = (state: Gate['state'], source: Gate['source'], evidence: string | null = 'ev'): Gate => ({
  state, isRequired: true, evidence, source, at: 10,
})

const finished = (overrides: Partial<Task> = {}): Task => {
  let t = newTask(1, 'goal', 100, null)
  t = settle(applyAction(t, { action: 'plan', kind: 'coding', milestones: ['Inspect', 'Implement', 'Test'].map(title => ({ title })) } as never, 101, null).task).task
  t = {
    ...t,
    milestones: t.milestones.map(one => ({ ...one, state: 'done' as const })),
    gates: Object.fromEntries(GATES.map(name => [name, gate('pass', 'model', `${name} reported`)])) as Record<GateName, Gate>,
  }
  t = settle(t).task

  return settle({ ...t, ...overrides }).task
}

const allGate = (source: Gate['source']): Record<GateName, Gate> =>
  Object.fromEntries(GATES.map(name => [name, gate('pass', source, name === 'SECURITY' ? 'security audit (exit 0)' : `${name} check (exit 0)`)])) as Record<GateName, Gate>

const withGuard = (t: Task, outcome: 'verified' | 'unchanged'): Task => settle({
  ...t,
  guardDone: { uid: uidOf(t), tree: 'h:1@project', check: 'check.sh@10', outcome, at: 11 },
}).task

const withoutGuard = <T>(f: () => T): T => {
  const before = isGuardRequired()
  setGuardRequired(false)
  try { return f() } finally { setGuardRequired(before) }
}

const withGuardRequired = <T>(f: () => T): T => {
  const before = isGuardRequired()
  setGuardRequired(true)
  try { return f() } finally { setGuardRequired(before) }
}

describe('P3 classifiers use only recorded evidence', () => {
  test('OBSERVE: a self-reported DONE is SELF_REPORTED_UNCHECKED, never a check', () => {
    withoutGuard(() => {
      const t = finished()
      expect(t.status).toBe('done')
      expect(completionEvidenceOf(t, false)).toMatchObject({ state: 'SELF_REPORTED_UNCHECKED' })
      expect(summaryOf(t)).toContain('DONE')
      expect(summaryOf(t)).toContain('SELF_REPORTED_UNCHECKED')
      expect(statusWord({ task: t, isWorking: false, activity: { isWorking: false, kind: 'IDLE', detail: '', agents: [] }, git: null, meter: { percent: null, model: null, effort: null } } as never)).toContain('DONE · SELF_REPORTED_UNCHECKED')
      expect(flowText(flowOf({ task: t, isWorking: false, agents: [], mainTier: null }))).toContain('COMPLETION SELF_REPORTED_UNCHECKED')
      expect(STATE_LABEL.done).toBe('DONE')
    })
  })

  test('ENFORCE: an actual successful check is PROVISIONAL_CHECKED at its own evidence', () => {
    const t = withGuard(finished({ gates: allGate('auto') }), 'verified')
    expect(completionEvidenceOf(t, true).state).toBe('PROVISIONAL_CHECKED')
    expect(guardEvidenceOf(t)).toMatchObject({ state: 'PROVISIONAL_CHECKED' })
    expect(verificationLine(guardEvidenceOf(t)!)).toContain('the stored Stop-guard record reports a successful check at that time')
    const readOnly = withGuard(finished({ gates: Object.fromEntries(GATES.map(name => [name, gate('na', 'model', 'read-only task')])) as Record<GateName, Gate> }), 'verified')
    expect(completionEvidenceOf(readOnly, true).state).toBe('PROVISIONAL_CHECKED')
  })

  test('ENFORCE through the host: the Stop run writes the record the report reads', guard, async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = hostState(on, {})
    await start($); await prompt($, 'tidy the parser'); await planAndComplete($, 1); await enroll($)
    w.tree['src/api.js'] = 'changed by the task'
    expect((await stop($)).block).toBeUndefined()
    const t = taskOf(h)
    expect(t.guardDone?.outcome).toBe('verified')
    expect(guardEvidenceOf(t)).toMatchObject({ state: 'PROVISIONAL_CHECKED' })
    expect(String((await command($, 'ready')).text)).toContain('the Stop guard ran its check for this task and tree and recorded a pass')
  })

  test('ENFORCE with a failed check: the hold is UNKNOWN_INVALIDATED and the task is not DONE', guard, async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    await start($); await prompt($, 'tidy the parser'); await planAndComplete($, 1); await enroll($)
    await stop($)
    const t = taskOf(h)
    expect(t.stopHold).toBeDefined()
    expect(t.status).not.toBe('done')
    expect(guardEvidenceOf(t)).toBeNull()
    expect(completionEvidenceOf(t, true).state).toBe('UNKNOWN_INVALIDATED')
    expect(String((await command($, 'ready')).text)).toContain('STOP GUARD HOLD')
  })

  test('a no-change observation is UNCHANGED_UNCHECKED and says no check ran', () => {
    withGuardRequired(() => {
      const t = withGuard(finished({ gates: Object.fromEntries(GATES.map(name => [name, gate('na', 'model', 'read-only task')])) as Record<GateName, Gate> }), 'unchanged')
      expect(t.status).toBe('done')
      expect(completionEvidenceOf(t, true)).toMatchObject({ state: 'UNCHANGED_UNCHECKED' })
      expect(readinessOf(t, null).satisfied.join('\n')).toContain('no check was run')
      expect(readinessOf(t, null).satisfied.join('\n')).not.toContain('completed its check')
    })
  })

  test('missing guard evidence is UNKNOWN_INVALIDATED, not an unchecked pass', () => {
    withGuardRequired(() => {
      const t = finished({ gates: allGate('auto') })
      expect(t.status).not.toBe('done')
      expect(completionEvidenceOf(t, true).state).toBe('UNKNOWN_INVALIDATED')
      expect(readinessOf(t, null).open.join('\n')).toContain('has not yet completed its check')
    })
  })

  test('stale task evidence is UNKNOWN_INVALIDATED even when the state still reads pass', () => {
    withoutGuard(() => {
      const t = finished({ gates: { ...allGate('auto'), TEST: gate('pass', 'auto', 'stale: the working tree changed') } })
      expect(t.status).toBe('done')
      expect(gateEvidenceOf(t.gates.TEST)).toBe('UNKNOWN_INVALIDATED')
      expect(completionEvidenceOf(t, false).state).toBe('UNKNOWN_INVALIDATED')
      expect(readyText(t, null, 100)).toContain('UNKNOWN_INVALIDATED')
    })
  })

  test('a changed tree withdraws the completion and reports it as invalidated', () => {
    withGuardRequired(() => {
      const t = withGuard(finished({ gates: allGate('auto') }), 'verified')
      const moved = markEdited(t, 'the tree changed after the check')
      expect(moved.guardDone).toBeUndefined()
      expect(completionEvidenceOf(moved, true).state).toBe('UNKNOWN_INVALIDATED')
    })
  })

  test('a withdrawn or untrusted check cannot leave a provisional completion behind', () => {
    withGuardRequired(() => {
      const t = withGuard(finished({ gates: { ...allGate('auto'), TEST: gate('pass', 'auto', 'stop check check.sh pass (exit 0)') } }), 'verified')
      const revoked = revokeTrustedCompletion(t, 'the trust for check.sh was withdrawn')
      expect(revoked.guardDone).toBeUndefined()
      expect(revoked.gates.TEST.state).toBe('pending')
      expect(revoked.gates.TEST.evidence).toStartWith('stale:')
      expect(completionEvidenceOf(revoked, true).state).toBe('UNKNOWN_INVALIDATED')
    })
  })
})

describe('P3 consumers report the classifier and nothing more', () => {
  test('the Run Ledger checkpoint does not turn a stored pass into a verified one', () => {
    const t = finished({ gates: { ...allGate('auto'), TEST: gate('pass', 'auto', 'npm test (exit 0)') } })
    const ledger = { ...emptyLedger('s1'), checkpoint: checkpointOf(emptyLedger('s1'), t, null, 10) }
    const text = ledgerLines(ledger, 10).join('\n')
    expect(text).toContain('TEST pass · provenance unknown (source not retained)')
    expect(text).not.toContain('SECURITY_ATTESTED')
  })

  test('a release consultation says the commander reported it, not that a check ran', () => {
    const c: Consultation = {
      id: 'opus-1-aaaaaa', ground: 'release', key: 'k', progressTask: null, isMandatory: true, requestedAt: 1,
      packet: { objective: 'o', architecture: '', files: [], alternatives: [], failures: [], risk: 'r', decision: 'd' },
    }
    const t = { id: c.id, state: 'completed', tier: 'OPUS', agentId: 'a1', endedAt: 2, verification: 'pass' } as unknown as SwarmTask
    const swarm = { tasks: [t] } as unknown as Swarm
    const line = consultLine(c, swarm)
    expect(line).toContain('commander report pass · SELF_REPORTED_UNCHECKED')
    expect(line).not.toContain('SECURITY_ATTESTED')
  })

  test('no reporting path claims SECURITY_ATTESTED, and the state stays reserved', () => {
    const t = finished({ gates: allGate('auto') })
    const outputs = [
      completionEvidenceOf(t, false).state,
      gateEvidenceOf(t.gates.SECURITY),
      verificationLine(completionEvidenceOf(t, false)),
      readyText(t, null, 100),
      summaryOf(t),
      ledgerLines({ ...emptyLedger('s1'), checkpoint: checkpointOf(emptyLedger('s1'), t, null, 10) }, 10).join('\n'),
    ]
    for (const out of outputs) expect(out).not.toContain(RESERVED_SECURITY_ATTESTED)
    expect(CLAIMABLE_STATES).not.toContain(RESERVED_SECURITY_ATTESTED)
    expect(CLAIMABLE_STATES.every(state => !state.includes('SECURITY_ATTESTED'))).toBe(true)
  })

  test('reporting changes no gate eligibility, count or DONE decision', () => {
    withoutGuard(() => {
      const t = finished()
      const before = JSON.stringify(t)
      const status = t.status
      const required = GATES.filter(name => t.gates[name].isRequired).length
      completionEvidenceOf(t, false); readinessOf(t, null); readyText(t, null, 100); summaryOf(t); flowText(flowOf({ task: t, isWorking: false, agents: [], mainTier: null }))
      expect(JSON.stringify(t)).toBe(before)
      expect(t.status).toBe(status)
      expect(GATES.filter(name => t.gates[name].isRequired)).toHaveLength(required)
    })
  })

  test('reporting changes no Stop authorization', () => {
    const cfg = configOf({ stopGuard: 'ENFORCE', verifyScript: SCRIPT }, null)
    const rec = (outcome: 'pass' | 'fail' | 'untrusted') => ({ taskId: 1, uid: '1@1', verifier: 'v', complete: false, name: 'check.sh', sha: 'abcd1234', at: 1, outcome, exit: outcome === 'pass' ? 0 : 1, ms: 1, tree: 'h:1@project', summary: '', hasSummary: true })
    expect(verdictOf({ cfg, spent: 0, run: rec('pass'), hasSummary: true })).toEqual({ action: 'allow', state: 'VERIFIED' })
    expect(verdictOf({ cfg, spent: 0, run: rec('fail'), hasSummary: true })).toMatchObject({ action: 'block' })
    expect(verdictOf({ cfg, spent: 0, run: rec('untrusted'), hasSummary: true })).toMatchObject({ action: 'allow', state: 'BLOCKED' })
  })

  test('P2 evidence integrity still governs what a pass can be', () => {
    const t = finished({ gates: { ...allGate('auto'), TEST: gate('pass', 'auto', 'unqualified: npm test (exit 0); the working tree could not be identified') } })
    expect(gateEvidenceOf(t.gates.TEST)).toBe('UNKNOWN_INVALIDATED')
    expect(completionEvidenceOf(t, false).state).toBe('UNKNOWN_INVALIDATED')
  })
})

describe('P3-R1: absent provenance is not invalidation', () => {
  const checkpoint = (t: Task) => ({ ...emptyLedger('s1'), checkpoint: checkpointOf(emptyLedger('s1'), t, null, 10) })

  test('a source-less checkpoint pass says provenance unknown, and never invalidated', () => {
    const l = checkpoint(finished({ gates: { ...allGate('auto'), TEST: gate('pass', 'auto', 'npm test (exit 0)') } }))
    const text = ledgerLines(l, 10).join('\n')
    expect(text).toContain('TEST pass · provenance unknown (source not retained)')
    expect(text).not.toContain('provenance UNKNOWN_INVALIDATED')
    expect(text).not.toContain('UNKNOWN_INVALIDATED')
  })

  test('the original checkpoint record is preserved exactly as stored', () => {
    const t = finished({ gates: { ...allGate('auto'), TEST: gate('pass', 'auto', 'npm test (exit 0)') } })
    const l = checkpoint(t)
    const before = JSON.stringify(l.checkpoint)
    const stored = JSON.stringify(l.checkpoint!.gates)
    ledgerLines(l, 10)
    expect(JSON.stringify(l.checkpoint)).toBe(before)
    expect(JSON.stringify(l.checkpoint!.gates)).toBe(stored)
    expect(l.checkpoint!.gates.TEST).toBe('pass')
  })

  test('a genuinely stale or invalidated current gate is still UNKNOWN_INVALIDATED', () => {
    const stale = gate('pass', 'auto', 'stale: the working tree changed after npm test (exit 0)')
    expect(gateEvidenceOf(stale)).toBe('UNKNOWN_INVALIDATED')
    expect(gateClaimText('TEST', stale)).toContain('stale')
    expect(gateClaimText('TEST', stale)).not.toContain('provenance unknown')
    const unqualified = gate('pass', 'auto', 'unqualified: npm test (exit 0); the working tree could not be identified')
    expect(gateEvidenceOf(unqualified)).toBe('UNKNOWN_INVALIDATED')
  })
})

describe('P3-R2: a returned response is a duplicate, not evidence of an applied GO', () => {
  const sha = 'a'.repeat(40)
  const packet = (): EvidencePacket => ({ objective: 'Approve the release', architecture: '', files: ['README.md'], alternatives: [], failures: [], risk: 'r', decision: 'release?' })
  const consultation = (): Consultation => ({ id: 'opus-1-aaaaaa', ground: 'release', key: 'k', progressTask: 1, isMandatory: true, requestedAt: 1, candidate: sha, packet: packet() })
  const swarmOf = (tasks: SwarmTask[] = []): Swarm => ({ tasks } as unknown as Swarm)
  const returnedTask = (id: string, verification: SwarmTask['verification']): SwarmTask => ({ id, state: 'completed', tier: 'OPUS', agentId: `a-${id}`, endedAt: 2, verification } as unknown as SwarmTask)
  const refusal = (over: { consults?: Consultation[]; swarm?: Swarm; history?: ReleaseRecord[] }): string => {
    const v = consultVerdict({ profile: 'SONNET_LED', ground: 'release', packet: packet(), facts: { prompt: 'Approve the release of v0.5.1', files: ['README.md'], milestones: 2, errorStreak: 0 }, consults: [], swarm: swarmOf(), progressTask: 1, candidate: sha, history: [], ...over })
    return v.ok ? '' : v.reason
  }
  // The exact sentence a returned response earns, whatever its adjudication turned out to be.
  const NEUTRAL = 'A consultation response for this commit has already been recorded; only a separately adjudicated qualifying GO may clear the release ground, and a NO-GO or an unadjudicated response is not approval.'

  test('a returned response with no adjudication is a duplicate, not an applied GO', () => {
    const c = consultation()
    const reason = refusal({ consults: [c], swarm: swarmOf([returnedTask(c.id, 'pending')]) })
    expect(reason).toContain('DUPLICATE')
    expect(reason).toContain(NEUTRAL)
    expect(reason).not.toContain('has already been applied')
    expect(reason).not.toContain('commander-adjudicated GO')
    expect(reason).not.toContain('verified')
  })

  test('a returned NO-GO is a duplicate, not an applied GO', () => {
    const record: ReleaseRecord = { candidate: sha, id: 'rel-nogo', at: 1, returned: true, verified: 'pass', outcome: 'no-go' }
    const reason = refusal({ history: [record] })
    expect(reason).toContain('DUPLICATE')
    expect(reason).toContain(NEUTRAL)
    expect(reason).not.toContain('has already been applied')
    expect(releaseEligible([record], sha)).toBeUndefined()
  })

  test('a returned response whose adjudication failed is a duplicate, not a missing judgment', () => {
    const c = consultation()
    const reason = refusal({ consults: [c], swarm: swarmOf([returnedTask(c.id, 'fail')]) })
    expect(reason).toContain('DUPLICATE')
    expect(reason).toContain(NEUTRAL)
    expect(reason).not.toContain('no commander adjudication')
    expect(reason).not.toContain('has already been applied')
  })

  test('a returned qualifying GO is still a duplicate, and the refusal does not claim it was applied', () => {
    const c = consultation()
    const record: ReleaseRecord = { candidate: sha, id: c.id, at: 1, returned: true, verified: 'pass', outcome: 'go' }
    const reason = refusal({ consults: [c], swarm: swarmOf([returnedTask(c.id, 'pass')]), history: [record] })
    expect(reason).toContain('DUPLICATE')
    expect(reason).toContain(NEUTRAL)
    expect(reason).not.toContain('has already been applied')
  })

  test('an existing valid GO is reused by the unchanged release rules', () => {
    const record: ReleaseRecord = { candidate: sha, id: 'rel-go', at: 1, returned: true, verified: 'pass', outcome: 'go' }
    expect(releaseEligible([record], sha)).toEqual(record)
    const applied = revalidateRelease({ grounds: ['release'], consult: null, state: 'required' }, { sha }, [record])
    expect(applied.state).toBe('adjudicated')
    expect(applied.cleared?.find(g => g.ground === 'release')).toMatchObject({ consult: 'rel-go', candidate: sha, reused: true })
  })
})

describe('P3-R2: readiness names what is missing, not what was judged', () => {
  const notesFor = (tasks: { id: string; state: string; verification: string }[]): string =>
    readinessOf(finished(), { tasks } as unknown as Swarm).notes.join('\n')

  test('pending, fail and unknown are grouped by the absent approved PASS, each state kept', () => {
    const notes = notesFor([
      { id: 'P', state: 'completed', verification: 'pending' },
      { id: 'F', state: 'completed', verification: 'fail' },
      { id: 'U', state: 'completed', verification: 'unknown' },
    ])
    expect(notes).toContain('3 completed agent results without a commander-approved PASS: P (pending), F (fail), U (unknown)')
    expect(notes).not.toContain('no commander adjudication')
    expect(notes).not.toContain('not verified')
  })

  test('a recorded failed adjudication is not described as an absent one', () => {
    const notes = notesFor([{ id: 'F', state: 'completed', verification: 'fail' }])
    expect(notes).toContain('1 completed agent result without a commander-approved PASS: F (fail)')
    expect(notes).not.toContain('commander adjudication')
    expect(notes).not.toContain('F (pending)')
    expect(notes).not.toContain('F (unknown)')
  })

  test('a commander-approved PASS is not listed as missing one', () => {
    const notes = notesFor([{ id: 'A', state: 'completed', verification: 'pass' }])
    expect(notes).not.toContain('without a commander-approved PASS')
  })
})

describe('P3-R3: an automatic source marker is not itself a check', () => {
  test('an automatic pass with recorded evidence is PROVISIONAL_CHECKED', () => {
    const g = gate('pass', 'auto', 'npm test (exit 0)')
    expect(gateEvidenceOf(g)).toBe('PROVISIONAL_CHECKED')
    expect(gateClaimText('TEST', g)).toContain('read from a command')
  })

  test('an automatic pass with no evidence says the check details are unavailable', () => {
    const g = gate('pass', 'auto', null)
    expect(gateEvidenceOf(g)).toBe('PROVENANCE_UNKNOWN')
    const claim = gateClaimText('TEST', g)
    expect(claim).toContain('automatic source recorded; check details unavailable')
    expect(claim).not.toContain('read from a command')
    expect(claim).not.toContain('stale')
    expect(claim).not.toContain('invalidated')
  })

  test('an automatic pass with malformed or empty evidence is treated the same', () => {
    for (const evidence of ['', '   ', '\n\t', 42 as unknown as string, undefined as unknown as string]) {
      const g = { ...gate('pass', 'auto', null), evidence }
      expect(gateEvidenceOf(g)).toBe('PROVENANCE_UNKNOWN')
      expect(gateClaimText('TEST', g)).toContain('automatic source recorded; check details unavailable')
      expect(gateClaimText('TEST', g)).not.toContain('read from a command')
    }
  })

  test('a DONE claim resting on an undocumented automatic pass is PROVENANCE_UNKNOWN, not invalidated', () => {
    withoutGuard(() => {
      const t = finished({ gates: { ...allGate('auto'), TEST: gate('pass', 'auto', null) } })
      expect(t.status).toBe('done')
      expect(completionEvidenceOf(t, false).state).toBe('PROVENANCE_UNKNOWN')
      const line = readyText(t, null, 200)
      expect(line).toContain('PROVENANCE_UNKNOWN')
      expect(line).toContain('without the check details that would support it')
      expect(line).not.toContain('UNKNOWN_INVALIDATED')
    })
  })

  test('an agent-reported pass stays SELF_REPORTED_UNCHECKED', () => {
    const g = gate('pass', 'model', 'the tests pass')
    expect(gateEvidenceOf(g)).toBe('SELF_REPORTED_UNCHECKED')
    expect(gateClaimText('TEST', g)).toContain('reported by Claude, not read from a command')
  })

  test('previously invalidated evidence is not relabelled as provenance unknown', () => {
    expect(gateEvidenceOf(gate('pass', 'auto', 'stale: the tree changed'))).toBe('UNKNOWN_INVALIDATED')
    expect(gateEvidenceOf(gate('pass', 'auto', 'unqualified: npm test (exit 0)'))).toBe('UNKNOWN_INVALIDATED')
    expect(gateEvidenceOf(gate('fail', 'auto', 'npm test (exit 1)'))).toBe('UNKNOWN_INVALIDATED')
  })

  test('no automatic-pass path claims a security attestation', () => {
    for (const evidence of ['npm test (exit 0)', null, '', '   ', 'stale: x', 'unqualified: y']) {
      const g = gate('pass', 'auto', evidence)
      expect(gateClaimText('SECURITY', g)).toContain('not a security attestation')
      expect(gateClaimText('SECURITY', g)).not.toContain('SECURITY_ATTESTED')
    }
    expect(CLAIMABLE_STATES).not.toContain(RESERVED_SECURITY_ATTESTED)
  })
})

describe('P3-R4: a stored guard record is history, not a current attestation', () => {
  test('the display says the observation is historical and not revalidated here', () => {
    withGuardRequired(() => {
      const t = withGuard(finished({ gates: allGate('auto') }), 'verified')
      const guardLine = verificationLine(guardEvidenceOf(t)!)
      expect(guardLine).toContain('the stored Stop-guard record reports a successful check at that time')
      expect(guardLine).toContain('does not revalidate current script trust or tree identity')
      expect(verificationLine(completionEvidenceOf(t, true))).toContain('current script trust and tree identity are not revalidated here')
      const before = JSON.stringify(t)
      guardEvidenceOf(t); completionEvidenceOf(t, true); readyText(t, null, 200); flowText(flowOf({ task: t, isWorking: false, agents: [], mainTier: null }))
      expect(JSON.stringify(t)).toBe(before)
    })
  })
})

describe('P3-R5: the Flow completion field is a compatible presentation extension', () => {
  test('a Flow built without completion still renders, and claims nothing', () => {
    const flow = flowOf({ task: finished(), isWorking: false, agents: [], mainTier: null })
    expect(flow.completion).not.toBeNull()
    const { completion: _completion, ...older } = flow
    const text = flowText(older as Flow)
    expect(text).toContain('FLOW')
    expect(text).not.toContain('COMPLETION')
    expect(flowText(flow)).toContain('COMPLETION')
  })
})
