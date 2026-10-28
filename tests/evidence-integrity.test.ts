// v0.6.6 P2-A (AG-F6, AH1-N1): a command's exit 0 is an observation; a qualified pass is a separate conclusion that needs the
// tree it was observed on. Where a goal-checked task's tree (or the Stop guard's) cannot be identified, the exit is kept as an
// unqualified observation, never as a pass; and a later measurement cannot qualify a result that had no identity when it ran.
import { describe, expect, test } from 'claude-code/testing'
import { checkpointOf, emptyLedger } from '../hooks/ledger'
import { hasUnboundPass, newTask, setGate, settle, unqualifiedEvidence } from '../hooks/model'
import type { CheckRecord } from '../hooks/stopguard'
import type { GateName, ReviewRequirement, Task } from '../types'
import { GATE_NAMES, bash, command, hostState, planAndComplete, progress, prompt, start, world } from './world'
import type { World } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const ENFORCE = { options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 3 } }
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')?.value as Task
const kept = (h: ReturnType<typeof hostState>) => (((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? [])
const aligned = { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "fixture test 'acceptance' passes in fixture.test.ts (1 pass)" }] } }
const EXCLUDES_WHY = 'core.excludesFile is a character device'
const unmeasurable = (w: World) => { w.gitConfig['core.excludesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }
const measurable = (w: World) => { delete w.gitConfig['core.excludesFile'] }
/** A goal-checked task (DEEP prompt, one criterion, a plan with every milestone before VERIFY complete). */
const goalChecked = async ($: any) => {
  await start($)
  await prompt($, 'Add booking cancellation to the API and the UI')
  await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
  await planAndComplete($, 4)
}
/** The model reports every gate but TEST, which a test command decides. */
const reportOthers = async ($: any) => {
  for (const gate of GATE_NAMES.filter(g => g !== 'TEST')) await progress($, { action: 'gate', gate, state: 'pass', evidence: `${gate} verified` })
}

describe('a check that exits 0', () => {
  test('1: on an identified tree it is a qualified pass, bound to that tree, and the goal check can rest on it', async ($, on) => {
    world(on); const h = hostState(on, {})
    await goalChecked($)
    await bash($, 'npm test')
    expect(taskOf(h).gates.TEST).toMatchObject({ state: 'pass', source: 'auto', evidence: 'npm test (exit 0)' })
    expect(typeof taskOf(h).gateTree).toBe('string')
    await reportOthers($)
    expect(await progress($, aligned)).toContain('alignment ALIGNED')
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
  })
  test('2: on a tree that cannot be identified it is kept as an unqualified observation, never a pass', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await goalChecked($); unmeasurable(w)
    await bash($, 'npm test')
    const gate = taskOf(h).gates.TEST
    expect(gate.state).toBe('pending')
    expect(gate.source).toBe('auto')
    // the raw result is kept first, what ran and its exit, then why it is not a qualified pass
    expect(gate.evidence).toStartWith('unqualified: npm test (exit 0); the working tree could not be identified (')
    expect(gate.evidence).toContain(EXCLUDES_WHY)
    expect(taskOf(h).gateTree).toBeUndefined()
  })
  test('2b: the same in OBSERVE and in ENFORCE (the reading does not depend on the Stop guard policy)', ENFORCE, async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'; const h = hostState(on, {})
    await goalChecked($); unmeasurable(w)
    await bash($, 'npm test')
    expect(taskOf(h).gates.TEST.state).toBe('pending')
    expect(taskOf(h).gates.TEST.evidence).toStartWith('unqualified: npm test (exit 0); the working tree could not be identified (')
  })
  test('3: a failing check on an identified tree is a failure, as before', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await goalChecked($); w.failing = /npm test/
    await bash($, 'npm test')
    expect(taskOf(h).gates.TEST.state).toBe('fail')
  })
  test('3b: a failure is a failure whether or not the tree can be identified', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await goalChecked($); unmeasurable(w); w.failing = /npm test/
    await bash($, 'npm test')
    expect(taskOf(h).gates.TEST.state).toBe('fail')
  })
  test('control: outside every Git repository there is no tree to identify, and a pass stays a pass', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); w.gitStatus = null
    await goalChecked($)
    await bash($, 'npm test')
    expect(taskOf(h).gates.TEST).toMatchObject({ state: 'pass', evidence: 'npm test (exit 0)' })
  })
})

describe('4: the Stop guard on a tree it cannot identify', () => {
  test('an exit 0 is kept in the Ledger and as a pending TEST gate; no completion, no qualified pass', ENFORCE, async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'; const h = hostState(on, {})
    await start($); await enroll($); await prompt($, 'tidy it')
    unmeasurable(w)
    await stop($)
    const last = kept(h).at(-1)!
    expect(last).toMatchObject({ outcome: 'pass', exit: 0, complete: false, tree: null })
    expect(last.summary).toContain('tree identity unknown')
    expect(taskOf(h).gates.TEST.state).toBe('pending')
    expect(taskOf(h).gates.TEST.evidence).toStartWith('unqualified: stop check check.sh pass (exit 0); the working tree could not be identified (')
    expect(taskOf(h).guardDone).toBeUndefined()
    expect(taskOf(h).status).not.toBe('done')
  })
  test('it makes passes observed on a measured tree stale: they cannot be shown to describe this one', ENFORCE, async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'; const h = hostState(on, {})
    await goalChecked($); await enroll($)
    await reportOthers($)
    expect(taskOf(h).gates.CODE.state).toBe('pass')
    unmeasurable(w)
    await stop($)
    expect(taskOf(h).gates.CODE.state).toBe('pending')
    expect(taskOf(h).gates.CODE.evidence).toStartWith('stale:')
    expect(taskOf(h).gateTree).toBeUndefined()
  })
  test('control: on an identified tree the guard records a qualified pass and its completion', ENFORCE, async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'; const h = hostState(on, {})
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/api.js'] = 'changed by the task'                    // a change, so the guard has something to check
    await stop($)
    expect(kept(h).at(-1)).toMatchObject({ outcome: 'pass', complete: true })
    expect(taskOf(h).gates.TEST).toMatchObject({ state: 'pass', evidence: 'stop check check.sh pass (exit 0)' })
    expect(taskOf(h).guardDone?.outcome).toBe('verified')
  })
})

describe('5: an older pass is not qualified by a later measurement', () => {
  test('passes recorded while the tree could not be measured: ALIGNED is refused once it can be, and they are pending again', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await goalChecked($); unmeasurable(w)
    for (const gate of GATE_NAMES) await progress($, { action: 'gate', gate, state: 'pass', evidence: `${gate} verified` })
    expect(hasUnboundPass(taskOf(h))).toBe(true)
    measurable(w)
    expect(await progress($, aligned)).toStartWith('error: ALIGNED refused: a passed check was not observed on a measured working tree')
    for (const gate of GATE_NAMES) expect(taskOf(h).gates[gate].state).toBe('pending')
    expect(taskOf(h).alignment?.state).not.toBe('ALIGNED')
  })
  test('the first check observed on a measured tree binds only itself: older unbound passes go back to pending', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await goalChecked($); unmeasurable(w)
    await reportOthers($)
    measurable(w)
    await bash($, 'npm test')
    expect(taskOf(h).gates.TEST.state).toBe('pass')
    expect(typeof taskOf(h).gateTree).toBe('string')
    for (const gate of GATE_NAMES.filter(g => g !== 'TEST')) {
      expect(taskOf(h).gates[gate].state).toBe('pending')
      expect(taskOf(h).gates[gate].evidence).toStartWith('stale: not on a measured tree (')
    }
  })
  test('the unqualified observation itself never turns into a pass when the tree becomes measurable', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await goalChecked($); unmeasurable(w)
    await bash($, 'npm test')
    measurable(w)
    await reportOthers($)
    expect(taskOf(h).gates.TEST.state).toBe('pending')
    expect(await progress($, aligned)).not.toContain('alignment ALIGNED')
    expect(await progress($, { action: 'complete', milestone: 'm5' })).not.toStartWith('DONE')
  })
})

describe('the identity a pass rests on', () => {
  test('6: the tree changes after a pass: ALIGNED is refused and the pass is stale', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await goalChecked($)
    await bash($, 'npm test'); await reportOthers($)
    w.tree['src/api.js'] = 'changed by a tool nothing watches'
    expect(await progress($, aligned)).toStartWith('error: ALIGNED refused: the working tree changed after the checks were last observed')
    expect(taskOf(h).gates.TEST.state).toBe('pending')
  })
  test('7: a new task starts over: the previous task\'s pass and its tree are not carried', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await goalChecked($)
    await bash($, 'npm test')
    const before = taskOf(h)
    expect(before.gates.TEST.state).toBe('pass')
    await command($, 'reset')
    await w.clock.advance(60_000)                                   // a later task begins at a later time
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'plan', milestones: [{ title: 'Implement' }, { title: 'Verify' }] })
    const after = taskOf(h)
    expect(after.id === before.id && after.startedAt === before.startedAt).toBe(false)
    expect(after.gates.TEST.state).toBe('unset')
    expect(after.gateTree).toBeUndefined()
  })
  test('8: a new check after the tree is measurable again is a qualified pass, and the goal check can rest on it', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await goalChecked($); unmeasurable(w)
    await bash($, 'npm test')
    expect(taskOf(h).gates.TEST.state).toBe('pending')
    measurable(w)
    await bash($, 'npm test')
    expect(taskOf(h).gates.TEST).toMatchObject({ state: 'pass', evidence: 'npm test (exit 0)' })
    await reportOthers($)
    expect(await progress($, aligned)).toContain('alignment ALIGNED')
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
  })
})

describe('9: stored history grants nothing', () => {
  test('a stale Ledger checkpoint and a completed check from an earlier session are reloaded: no pass and no completion follow', ENFORCE, async ($, on) => {
    const stale = setGate(newTask(1, 'an earlier task', 1, null), 'TEST', 'pass', 'npm test (exit 0)', 'auto', 2)
    const record: CheckRecord = { taskId: 1, uid: '1@1', verifier: 'v', complete: true, name: 'check.sh', sha: 'aaaaaaaa', at: 3, outcome: 'pass', exit: 0, ms: 1, tree: 'T', summary: 'ok', hasSummary: true }
    const ledger = { ...emptyLedger('s1'), checkpoint: checkpointOf(emptyLedger('s1'), stale, null, 4), stopChecks: [record] }
    expect(ledger.checkpoint.gates['TEST']).toBe('pass')
    const w = world(on, {}, { 'ledger:s1': ledger }); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    on('session.id', () => ({ value: 's1' }))
    const h = hostState(on, {})
    await goalChecked($); await enroll($)
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
    await stop($)
    expect(taskOf(h).guardDone).toBeUndefined()
    expect(taskOf(h).gates.TEST.state).toBe('fail')
    expect(taskOf(h).status).not.toBe('done')
  })
})

describe('10: UNKNOWN cannot support ALIGNED', () => {
  test('a goal check on a tree that cannot be measured is UNKNOWN, and the passes before it do not carry it later', async ($, on) => {
    const w = world(on); const h = hostState(on, {})
    await goalChecked($); unmeasurable(w)
    for (const gate of GATE_NAMES) await progress($, { action: 'gate', gate, state: 'pass', evidence: `${gate} verified` })
    expect(await progress($, aligned)).toContain('recorded as UNKNOWN')
    expect(taskOf(h).alignment?.state).toBe('UNKNOWN')
    expect(await progress($, { action: 'complete', milestone: 'm5' })).not.toStartWith('DONE')
    measurable(w)
    expect(await progress($, aligned)).toStartWith('error: ALIGNED refused')
    expect(await progress($, { action: 'status' })).not.toStartWith('DONE')
  })
})

describe('11: the release consultation is unchanged and independent of this rule', () => {
  /** A goal-checked task that reached DONE with qualified checks, as stored. */
  const done = async ($: any, h: ReturnType<typeof hostState>): Promise<Task> => {
    await goalChecked($)
    await bash($, 'npm test'); await reportOthers($)
    await progress($, aligned)
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')

    return taskOf(h)
  }
  const RELEASE = (state: 'required' | 'adjudicated'): ReviewRequirement =>
    ({ grounds: ['release'], consult: state === 'adjudicated' ? 'c1' : null, state, cleared: state === 'adjudicated' ? [{ ground: 'release', consult: 'c1' }] : [] })
  test('a required release consultation holds DONE; adjudicated, the qualified checks complete it', async ($, on) => {
    world(on); const h = hostState(on, {})
    const t = await done($, h)
    expect(settle({ ...t, review: RELEASE('required') }).task.status).not.toBe('done')
    expect(settle({ ...t, review: RELEASE('adjudicated') }).task.status).toBe('done')
  })
  test('an adjudicated release consultation does not make an unqualified TEST observation count', async ($, on) => {
    world(on); const h = hostState(on, {})
    const t = await done($, h)
    const unqualified = setGate(t, 'TEST' as GateName, 'pending', unqualifiedEvidence('npm test (exit 0)', EXCLUDES_WHY), 'auto', t.updatedAt)
    expect(settle({ ...unqualified, review: RELEASE('adjudicated') }).task.status).not.toBe('done')
  })
})
