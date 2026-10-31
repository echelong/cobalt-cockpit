// v0.6.6 P2-B (AG-F7): a completion the Stop guard verified rests on the trust its check ran under. When that trust is no
// longer in force (withdrawn, enrolled again, a changed script or pin), the completion is not current evidence any more: the
// guard's record goes and its TEST pass is stale, while the Run Ledger keeps what ran. Other trust records are left alone.
import { describe, expect, test } from 'claude-code/testing'
import { revokeTrustedCompletion } from '../hooks/model'
import type { CheckRecord } from '../hooks/stopguard'
import type { Task } from '../types'
import { FIVE, command, hostState, passAllGates, progress, prompt, world } from './world'

const SCRIPT = '/work/check.sh'
const KEY = `/work/example\0${SCRIPT}`
const PIN = 'c22995adc29757a99bc9242926a5d5b5a8007ecc78f30943161cf072af42d9d2'                  // sha-256 of 'exit 0'
const OTHER_KEY = `/work/other\0/work/other/check.sh`
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 3, ...extra } })
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')!.value as Task
const kept = (h: ReturnType<typeof hostState>) => (((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? [])
const trusts = (w: any) => (w.store.get('stop-trust') ?? {}) as Record<string, { sha: string; at: number }>
const scriptRuns = (w: any) => w.runs.filter((r: string[]) => r[0] === SCRIPT).length
const edit = ($: any) => $.tool.call({ tool: 'Edit', tool_use_id: `e-${Math.random()}`, file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b' } as never)
const fixture = (on: any) => {
  const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
  on('session.id', () => ({ value: 's1' }))
  on('classic.SessionStart', () => ({}) as never)

  return { w, h: hostState(on, {}) }
}
/** A task the guard verified: enrolled, edited, every milestone and gate reported, and a passing Stop on an identified tree. */
const verified = async ($: any, h: ReturnType<typeof hostState>) => {
  await prompt($, 'fix the parser'); await enroll($)
  await edit($)
  await progress($, { action: 'plan', milestones: FIVE })
  for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
  await passAllGates($)
  await progress($, { action: 'complete', milestone: 'm5' })
  await stop($)
  expect(taskOf(h).guardDone?.outcome).toBe('verified')
  expect(taskOf(h).gates.TEST).toMatchObject({ state: 'pass', evidence: 'stop check check.sh pass (exit 0)' })
  expect(taskOf(h).status).toBe('done')
}
/** The durable record of every check that ran: what a resumed session reads back. */
const durable = (w: any) => ((w.store.get('stop-checks') as { checks?: CheckRecord[] } | undefined)?.checks ?? [])
/** The completion is gone as current evidence, and what ran is still in the Run Ledger's durable record. */
const revoked = (h: ReturnType<typeof hostState>, w: any, why: string) => {
  const t = taskOf(h)
  expect(t.guardDone).toBeUndefined()
  expect(t.gates.TEST.state).toBe('pending')
  expect(t.gates.TEST.evidence).toStartWith(`stale: ${why}`)
  expect(t.status).not.toBe('done')
  expect(durable(w).some(c => c.complete && c.outcome === 'pass')).toBe(true)
}

describe('withdrawing the trust a completion rests on', () => {
  // The host-backed verified completion, untrust and Stop sequence exceeded 5s under full-suite contention.
  test('untrust revokes the completion at once; the Ledger keeps the check; other trust records are untouched', { ...guard(), timeoutMs: 20000 }, async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    w.store.set('stop-trust', { ...trusts(w), [OTHER_KEY]: { sha: 'f'.repeat(64), at: 1 } })
    const reply = String((await command($, 'guard untrust')).text)
    expect(reply).toContain('no longer counts')
    revoked(h, w, 'the trust for check.sh was withdrawn')
    expect(taskOf(h).alignment?.state).not.toBe('ALIGNED')
    expect(Object.keys(trusts(w))).toEqual([OTHER_KEY])
    // the next Stop does not take the old record as nothing to ask: the script is no longer trusted, so the task is held
    const runs = scriptRuns(w)
    await stop($)
    expect(kept(h).at(-1)?.outcome).toBe('untrusted')
    expect(scriptRuns(w)).toBe(runs)
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('enrolling again after untrust does not restore the old completion; a new check is needed', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    const first = taskOf(h).guardDone?.check
    await command($, 'guard untrust')
    await w.clock.advance(60_000)
    await enroll($)
    expect(taskOf(h).guardDone).toBeUndefined()
    const runs = scriptRuns(w)
    w.tree['src/api.js'] = 'changed again'                          // a change, so the Stop has something to check
    await stop($)
    expect(scriptRuns(w)).toBe(runs + 1)
    expect(taskOf(h).guardDone?.outcome).toBe('verified')
    expect(taskOf(h).guardDone?.check).not.toBe(first)
  })
  test('enrolling again without untrust replaces the trust: the older completion is revoked at once', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    await w.clock.advance(60_000)
    await enroll($)
    revoked(h, w, 'the trust for check.sh was enrolled again')
  })
  test('another session enrolled the script again: the older completion is revoked when this session goes on', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    const later = { ...trusts(w)[KEY]!, at: (trusts(w)[KEY]!.at) + 60_000 }
    w.store.set('stop-trust', { ...trusts(w), [KEY]: later })
    await $.classic.SessionStart({ source: 'resume' })
    revoked(h, w, 'the trust it was checked under was withdrawn or enrolled again since')
  })
  test('another session withdrew the trust: the completion is revoked when this session goes on', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    const { [KEY]: _gone, ...rest } = trusts(w)
    w.store.set('stop-trust', rest)
    await $.classic.SessionStart({ source: 'resume' })
    revoked(h, w, 'the verification script is not enrolled')
  })
})

describe('a changed script or pin', () => {
  test('the script\'s bytes changed: the completion checked on the old bytes is revoked at the next prompt', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    w.files[SCRIPT] = 'exit 0 # edited after the check'
    await prompt($, 'anything else?')
    revoked(h, w, 'the verification script is changed since it was enrolled')
  })
  test('with a pin, a script that no longer matches it: the completion is revoked, naming the pin', guard({ verifyScriptSha256: PIN }), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    w.files[SCRIPT] = 'exit 0 # edited after the check'
    await prompt($, 'anything else?')
    revoked(h, w, 'the verification script does not match its pin')
  })
  test('the Stop guard does not take a record checked under a changed script as nothing to ask', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    w.files[SCRIPT] = 'exit 0 # edited after the check'
    await stop($)
    expect(taskOf(h).guardDone).toBeUndefined()
    expect(kept(h).at(-1)?.outcome).toBe('untrusted')
    expect(taskOf(h).stopHold).toBeDefined()
  })
})

describe('what is left alone', () => {
  test('control: the trust unchanged, the completion stands and the Stop asks nothing again', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    await $.classic.SessionStart({ source: 'resume' })              // the session goes on: the completion is reconciled
    expect(taskOf(h).guardDone?.outcome).toBe('verified')
    const runs = scriptRuns(w)
    expect((await stop($))?.block).toBeUndefined()
    expect(scriptRuns(w)).toBe(runs)
  })
  test('a record that a read-only task left the tree unchanged ran no script and is not revoked by untrust', guard(), async ($, on) => {
    const { h } = fixture(on)
    await prompt($, 'what does the parser do?'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: [{ title: 'Read the parser', phase: 'RESEARCH' }] })
    await progress($, { action: 'complete', milestone: 'm1' })
    await stop($)
    expect(taskOf(h).guardDone?.outcome).toBe('unchanged')
    await command($, 'guard untrust')
    expect(taskOf(h).guardDone?.outcome).toBe('unchanged')
  })
  test('resuming after untrust replays nothing: the Ledger\'s completed check does not bring the completion back', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    await command($, 'guard untrust')
    await $.classic.SessionStart({ source: 'resume' })
    expect(taskOf(h).guardDone).toBeUndefined()
    // the durable record of what ran is kept
    expect(durable(w).some(c => c.complete && c.outcome === 'pass')).toBe(true)
  })
  test('untrust leaves a completion whose check record shows another verifier; the completion check still weighs it', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    const other = (c: CheckRecord) => (c.complete ? { ...c, verifier: 'another0verif' } : c)
    const l = h.get('run-ledger')!
    h.set('run-ledger', { value: { ...(l.value as object), stopChecks: kept(h).map(other) }, version: l.version + 1 })
    w.store.set('stop-checks', { v: 1, checks: durable(w).map(other) })
    const reply = String((await command($, 'guard untrust')).text)
    expect(reply).not.toContain('no longer counts')
    expect(taskOf(h).guardDone?.outcome).toBe('verified')                    // not revoked by untrusting another script
    await $.classic.SessionStart({ source: 'resume' })
    expect(taskOf(h).guardDone).toBeUndefined()                             // but not current evidence under the trust in force
  })
  test('a completion whose check is no longer in the Run Ledger cannot be shown trusted: revoked', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await verified($, h)
    const l = h.get('run-ledger')!
    h.set('run-ledger', { value: { ...(l.value as object), stopChecks: [] }, version: l.version + 1 })
    w.store.set('stop-checks', { v: 1, checks: [] })
    await $.classic.SessionStart({ source: 'resume' })
    expect(taskOf(h).guardDone).toBeUndefined()
    expect(taskOf(h).stopHold?.reason).toContain('the check it rests on is no longer in the Run Ledger')
  })
  test('the revocation itself is pure: only the guard\'s record and a TEST pass the guard wrote change', () => {
    const base = { gates: { TEST: { state: 'pass', isRequired: true, evidence: 'stop check check.sh pass (exit 0)', source: 'auto', at: 1 }, CODE: { state: 'pass', isRequired: true, evidence: 'CODE verified', source: 'model', at: 1 } }, guardDone: { uid: 'u', tree: 't', check: 'check.sh@1', outcome: 'verified', at: 1 } } as unknown as Task
    const out = revokeTrustedCompletion({ ...base, gates: { ...base.gates } } as Task, 'why')
    expect(out.guardDone).toBeUndefined()
    expect(out.gates.TEST.state).toBe('pending')
    expect(out.gates.CODE.state).toBe('pass')
    const modelTest = { ...base, gates: { ...base.gates, TEST: { ...base.gates.TEST, source: 'model' } } } as Task
    expect(revokeTrustedCompletion(modelTest, 'why').gates.TEST.state).toBe('pass')
  })
})
