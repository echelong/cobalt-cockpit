// Completion integrity (H1-b): a task never reads DONE while an applicable Stop guard check is unresolved, whatever the budget left,
// whatever the task was declared to be, and a person's release does not make verification optional.
import { describe, expect, test } from 'claude-code/testing'
import { emptyLedger } from '../hooks/ledger'
import { summaryOf } from '../hooks/model'
import { configOf, volatileOf, watchOf, type CheckRecord } from '../hooks/stopguard'
import { register } from '../hooks/register'
import { isGuardRequired, setGuardRequired, clearHold, holdTask, newTask, planTask, releaseHold, settle, touchFile } from '../hooks/model'
import type { Task } from '../types'
import { FIVE, blobOf, bash, command, hostState, passAllGates, planAndComplete, progress, prompt, start, world } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 3, ...extra } })
const stop = ($: any, message = SUMMARY) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: message }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')!.value as Task
const finishAll = async ($: any) => { for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await progress($, { action: 'complete', milestone: m }) }
const fixture = (on: any, script = 'fails') => { const w = world(on); w.files[SCRIPT] = script === 'fails' ? 'exit 1' : 'exit 0'; w.players[SCRIPT] = script as never; return { w, h: hostState(on, {}) } }
/** The state every projection reads: none of these may say finished while the task is unresolved. */
const notFinished = (t: Task) => {
  expect(t.status).not.toBe('done')
  expect(t.percent).toBeLessThan(100)
  expect(t.phase).not.toBe('DONE')
}

describe('H1-b: a read-only task whose files change afterwards', () => {
  const readonlyThenChange = async ($: any, w: any) => {
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/changed-later.ts'] = 'x'
  }
  test('the first failed check holds the task at once and it is not DONE', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await readonlyThenChange($, w); await finishAll($)
    const out = await stop($)
    expect(out.block).toBeDefined()
    notFinished(taskOf(h))
    expect(taskOf(h).stopHold).toBeDefined()
    expect(taskOf(h).gates.TEST.isRequired).toBe(true)
  })
  test('the change turns the read-only task into a coding task with required gates', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await readonlyThenChange($, w); await finishAll($); await stop($)
    const t = taskOf(h)
    expect(t.kind).toBe('coding')
    expect(t.edited).toBe(true)
    for (const g of Object.values(t.gates)) expect(g.isRequired).toBe(true)
  })
  test('declaring read-only again does not undo it', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await readonlyThenChange($, w); await finishAll($); await stop($)
    await progress($, { action: 'plan', replan: true, kind: 'readonly', milestones: FIVE })
    await finishAll($)
    expect(taskOf(h).kind).toBe('coding')
    notFinished(taskOf(h))
  })
  test('a person release keeps TEST required and does not restore DONE', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await readonlyThenChange($, w); await finishAll($); await stop($)
    await command($, 'guard release')
    const t = taskOf(h)
    expect(t.stopHold).toBeUndefined()
    expect(t.gates.TEST.isRequired).toBe(true)
    expect(t.gates.TEST.state).toBe('pending')
    notFinished(t)
  })
  test('a progress call cannot report TEST as passed after the first failure', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await readonlyThenChange($, w); await finishAll($); await stop($)
    await progress($, { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'I ran it' })
    await passAllGates($)
    notFinished(taskOf(h))
  })
  test('an edit seen by the hooks after the read-only plan converts it too', guard(), async ($, on) => {
    const { h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b' } as never)
    expect(taskOf(h).kind).toBe('coding')
    expect(taskOf(h).gates.TEST.isRequired).toBe(true)
  })
  test('negative control: an unchanged read-only task stays read-only, light and DONE', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    await stop($)
    expect(w.runs.filter((r: string[]) => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).kind).toBe('readonly')
    expect(taskOf(h).status).toBe('done')
  })
})

describe('every check outcome that does not complete the task holds it', () => {
  test('a first failure on a coding task, budget left: held, and TEST cannot be reported as passed', guard(), async ($, on) => {
    const { h } = fixture(on)
    await start($); await planAndComplete($, 1); await enroll($)
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).stopHold).toBeDefined()
    await progress($, { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'ran it' })
    notFinished(taskOf(h))
  })
  test('a pass without a change summary, budget left: held', guard(), async ($, on) => {
    const { h } = fixture(on, 'ok')
    await start($); await planAndComplete($, 1); await enroll($)
    expect((await stop($, 'ok')).block).toBeDefined()
    expect(taskOf(h).stopHold).toBeDefined()
    notFinished(taskOf(h))
  })
  test('the next stop with a summary and a passing check lifts the hold', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await start($); await planAndComplete($, 1); await enroll($)
    await stop($, 'ok')
    expect(taskOf(h).stopHold).toBeDefined()
    await stop($)
    expect(w.runs.length).toBeGreaterThan(0)
    expect(taskOf(h).stopHold).toBeUndefined()
  })
  test('the budget still ends the loop and the task stays blocked', guard({ stopMaxContinuations: 2 }), async ($, on) => {
    const { h } = fixture(on)
    await start($); await planAndComplete($, 1); await enroll($)
    expect((await stop($)).block).toBeDefined()
    expect((await stop($)).block).toBeUndefined()
    expect(taskOf(h).stopHold).toBeDefined()
    notFinished(taskOf(h))
  })
  test('an interrupted session: the next prompt does not replace the unresolved task', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/changed-later.ts'] = 'x'
    await finishAll($)
    await stop($)
    const before = taskOf(h)
    await prompt($, 'carry on')
    const after = taskOf(h)
    expect(after.stopHold).toBeDefined()
    expect(after.id).toBe(before.id)
    notFinished(after)
  })
})

describe('pure model: the completion rule and release', () => {
  const done = (): Task => {
    let t = newTask(1, 'g', 1, null)
    t = planTask(t, { milestones: [{ title: 'a' }], kind: 'coding' } as never, 2).task
    return t
  }
  test('releaseHold keeps TEST required, also for a task that was read-only', () => {
    const ro = planTask(newTask(1, 'g', 1, null), { milestones: [{ title: 'a' }], kind: 'readonly' } as never, 2).task
    expect(ro.gates.TEST.isRequired).toBe(false)
    const held = holdTask(ro, 'check failed', 1, 3)
    const out = releaseHold(held, 4)
    expect(out.gates.TEST.isRequired).toBe(true)
    expect(out.gates.TEST.state).toBe('pending')
  })
  test('touchFile on a read-only task converts it', () => {
    const ro = planTask(newTask(1, 'g', 1, null), { milestones: [{ title: 'a' }], kind: 'readonly' } as never, 2).task
    const t = touchFile(ro, 'a.ts', 1, 0)
    expect(t.kind).toBe('coding')
    expect(t.gates.CODE.isRequired).toBe(true)
  })
  test('a hold is never DONE however the milestones stand', () => {
    let t = holdTask(done(), 'x', 1, 3)
    t = { ...t, milestones: t.milestones.map(m => ({ ...m, state: 'done' as const })) }
    const s = settle(t).task
    expect(s.status).toBe('blocked')
    expect(s.percent).toBeLessThan(100)
    expect(settle(clearHold(s, 6)).task.status).not.toBe('blocked')
  })
})

describe('timeout, untrusted and unstable checks hold at once', () => {
  test('a check that cannot run holds the task and is not retried', guard(), async ($, on) => {
    const { h } = fixture(on, 'hangs')
    await start($); await planAndComplete($, 1); await enroll($)
    expect((await stop($)).block).toBeUndefined()
    expect(taskOf(h).stopHold).toBeDefined()
    notFinished(taskOf(h))
  })
  test('an untrusted verifier holds the task and runs nothing', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await start($); await planAndComplete($, 1)                                       // never enrolled
    await stop($)
    expect(w.runs.filter((r: string[]) => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).stopHold).toBeDefined()
    notFinished(taskOf(h))
  })
  test('a tree that moves while the check runs holds with budget left', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await start($); await planAndComplete($, 1); await enroll($)
    let n = 0
    w.duringRun = async (argv: readonly string[]) => { if (argv[0] === SCRIPT) w.tree[`src/moving-${n++}.ts`] = 'x' }
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).stopHold).toBeDefined()
    notFinished(taskOf(h))
  })
})

describe('projections agree on one state', () => {
  test('status, percent, phase, gates, the saved Ledger record and the summary line all say unresolved', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/x.ts'] = 'x'
    await finishAll($); await stop($)
    const t = taskOf(h)
    notFinished(t)
    expect(t.status).toBe('blocked')
    expect(t.gates.TEST.isRequired).toBe(true)
    const kept = ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? []
    expect(kept.at(-1)?.outcome).toBe('fail')
    expect(kept.at(-1)?.complete).toBe(false)
    expect(summaryOf(t)).not.toMatch(/\bDONE\b/)
  })
  test('plan and replan cannot restore a read-only exemption on a changed task', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/x.ts'] = 'x'
    await finishAll($); await stop($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await progress($, { action: 'plan', replan: true, kind: 'readonly', milestones: FIVE })
    for (const g of Object.values(taskOf(h).gates)) expect(g.isRequired).toBe(true)
    notFinished(taskOf(h))
  })
})

describe('git index flags and exclude sources', () => {
  const quietRepo = async ($: any, on: any) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('readonly')
    return { w, h }
  }
  test('a file hidden with assume-unchanged is still seen as a change', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    w.indexFlags = 'h src/hidden.ts\0'
    w.tree['src/hidden.ts'] = 'one'
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/hidden.ts'] = 'two'                                                   // the index says unchanged; the disk does not
    await finishAll($)
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).kind).toBe('coding')
  })
  test('a file hidden with skip-worktree is still seen as a change', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    w.indexFlags = 'S src/skipped.ts\0'
    w.tree['src/skipped.ts'] = 'one'
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/skipped.ts'] = 'two'
    await finishAll($)
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).kind).toBe('coding')
  })
  test('adding to .git/info/exclude is itself a change', guard(), async ($, on) => {
    const { w, h } = await quietRepo($, on)
    w.excludes = 'src/secret-new-file.ts\n'
    await finishAll($)
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).kind).toBe('coding')
  })
  test('negative control: flagged paths that did not change do not force a check', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    w.indexFlags = 'h src/hidden.ts\0S src/skipped.ts\0'
    w.tree['src/hidden.ts'] = 'one'; w.tree['src/skipped.ts'] = 'one'
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($); await stop($)
    expect(w.runs.filter((r: string[]) => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
})

describe('L-1: a repository cannot talk the fingerprint out of seeing a change', () => {
  const gitCalls = (w: any) => w.runs.filter((r: string[]) => r[0] === 'git')
  const scriptRuns = (w: any) => w.runs.filter((r: string[]) => r[0] === SCRIPT).length
  const roTask = async ($: any, on: any, setup: (w: any) => void = () => {}) => {
    const { w, h } = fixture(on)
    setup(w)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    return { w, h }
  }
  // v0.6.6: submodules are ignored, never examined: a repository that records one is refused before any of these calls
  test('every git call ignores replace refs, fsmonitor, submodules and the untracked cache', guard(), async ($, on) => {
    const { w } = await roTask($, on)
    await stop($)
    const calls = gitCalls(w)
    expect(calls.length).toBeGreaterThan(8)
    for (const call of calls) {
      expect(call).toContain('--no-replace-objects')
      expect(call).toContain('core.fsmonitor=false')
      expect(call).toContain('core.untrackedCache=false')
      expect(call).toContain('diff.ignoreSubmodules=all')
      expect(call).toContain('submodule.recurse=false')
      expect(call).not.toContain('diff.ignoreSubmodules=none')
    }
    for (const call of calls.filter((c: string[]) => c.includes('diff'))) expect(call).toContain('--ignore-submodules=all')
  })
  test('a new file hidden by a self-ignoring .gitignore (or any exclude source) moves into the ignored list: CHANGED', guard(), async ($, on) => {
    const { w, h } = await roTask($, on)
    w.ignoredEntries.push('src/.gitignore', 'src/new-secret.ts')                      // untracked list stays empty, as git reports it
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).kind).toBe('coding')
    notFinished(taskOf(h))
  })
  test('negative control: ignored entries that were there at the start are not a change', guard(), async ($, on) => {
    const { w, h } = await roTask($, on, w => { w.ignoredEntries = ['node_modules/x/index.js', 'dist/bundle.js'] })
    await stop($)
    expect(scriptRuns(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
  test('too many ignored entries is UNKNOWN with that reason, never a match', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.ignoredEntries = Array.from({ length: 100_001 }, (_, i) => `out/f${i}`)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    await stop($)
    expect(scriptRuns(w)).toBe(1)
    const kept = ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? []
    expect(kept.at(-1)?.summary).toContain('more than 100000 ignored files')
  })
})

describe('ignored files: relevance, volatility and coverage', () => {
  const scriptRuns = (w: any) => w.runs.filter((r: string[]) => r[0] === SCRIPT).length
  const gitRuns = (w: any) => w.runs.filter((r: string[]) => r[0] === 'git').length
  const roTask = async ($: any, on: any, setup: (w: any) => void = () => {}) => {
    const { w, h } = fixture(on)
    setup(w)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    return { w, h }
  }
  const SEEN = { ignoredEntries: ['.cache/index.db', 'logs/app.log'] }
  test('a new ignored cache file is a change (names)', guard(), async ($, on) => {
    const { w, h } = await roTask($, on, w => { w.ignoredEntries = [...SEEN.ignoredEntries] })
    w.ignoredEntries.push('.cache/new.db')
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
  })
  test('an existing ignored file rewritten is a change (size/mtime), though its name is the same', guard(), async ($, on) => {
    const { w, h } = await roTask($, on, w => { w.ignoredEntries = [...SEEN.ignoredEntries] })
    w.ignoredMeta['.cache/index.db'] = '4096 99'
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
    expect(scriptRuns(w)).toBeGreaterThan(0)
  })
  test('the verifier script is watched by content, even where git cannot see it', guard(), async ($, on) => {
    const { w, h } = await roTask($, on, w => { w.watched[SCRIPT] = 'exit 1' })
    w.watched[SCRIPT] = 'exit 0'                                                       // the check itself was rewritten
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
  })
  test('an operator-listed watch path (an ignored config) is watched by content', guard({ stopWatch: 'config/local.json' }), async ($, on) => {
    const { w, h } = await roTask($, on, w => { w.watched['/work/example/config/local.json'] = 'a' })
    w.watched['/work/example/config/local.json'] = 'b'
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
  })
  test('operator-authorized volatile directories: churn inside them is neither a change nor a cost', guard({ stopVolatile: 'node_modules/,dist/' }), async ($, on) => {
    const { w, h } = await roTask($, on, w => { w.ignoredEntries = ['node_modules/', ...Array.from({ length: 30_000 }, (_, i) => `dist/chunk-${i}.js`)] })
    w.ignoredEntries.push('dist/new-chunk.js'); w.ignoredMeta['node_modules/'] = '4096 99'
    const before = gitRuns(w)
    await stop($)
    expect(scriptRuns(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
    expect(w.statCalls).toBeLessThanOrEqual(2)                                        // 30000 volatile entries were never stat'ed
    // Root identity and effective-filter preflight add bounded reads independent of cache size; v0.6.6 adds the repository-state
    // check before the measurement and again after it (configuration and the index's stage entries each time, and where the packs
    // are: five Git calls), and the filter check reads its drivers from that configuration instead of two calls of its own
    expect(gitRuns(w) - before).toBeLessThanOrEqual(23)
  })
  test('volatile does not exclude an untracked file, whatever the prefix', guard({ stopVolatile: 'dist/' }), async ($, on) => {
    const { w, h } = await roTask($, on)
    w.untracked.push('dist/hand-written.ts')
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
  })
  test('volatile does not exclude a tracked change, whatever the prefix', guard({ stopVolatile: 'dist/' }), async ($, on) => {
    const { w, h } = await roTask($, on)
    w.tree['dist/also-tracked.ts'] = 'x'
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
  })
  test('without the option the same churn IS a change: the exclusion is the operator\'s, never default', guard(), async ($, on) => {
    const { w, h } = await roTask($, on, w => { w.ignoredEntries = ['dist/a.js'] })
    w.ignoredEntries.push('dist/b.js')
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
  })
  test('an exclude rule added mid-task is a change, whatever it hides', guard({ stopVolatile: 'dist/' }), async ($, on) => {
    const { w, h } = await roTask($, on)
    w.excludes = 'src/\n'
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
  })
  test('ignored entries that cannot be measured are UNKNOWN: checked, never a match', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.ignoredEntries = ['.cache/index.db']
    w.players['stat'] = 'fails'
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    await stop($)
    expect(scriptRuns(w)).toBe(1)
    expect(taskOf(h).guardDone).toBeUndefined()
  })
  test('config: volatile prefixes are validated and cannot cover the verifier or a watched path', () => {
    expect(volatileOf('dist/, node_modules/ ,../etc/,/abs/,.git/,a/../b/,src,')).toEqual(['dist/', 'node_modules/'])
    expect(configOf({ stopGuard: 'ENFORCE', verifyScript: '/work/tools/check.sh', stopVolatile: 'tools/,dist/', stopWatch: 'dist/x.json' }, null).volatile).toEqual([])
    expect(configOf({ stopGuard: 'ENFORCE', verifyScript: '/work/check.sh', stopVolatile: 'dist/' }, null).volatile).toEqual(['dist/'])
    expect(watchOf('a/b.json,../x,/abs/f')).toEqual(['a/b.json', '/abs/f'])
  })
})

describe('M-2: a clean filter or an attributes file cannot hide a modified tracked file', () => {
  const scriptRuns = (w: any) => w.runs.filter((r: string[]) => r[0] === SCRIPT).length
  const roTask = async ($: any, on: any, setup: (w: any) => void = () => {}) => {
    const { w, h } = fixture(on)
    setup(w)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    return { w, h }
  }
  test('diff says unchanged (a clean filter), the file differs from its base blob: CHANGED', guard(), async ($, on) => {
    const { w, h } = await roTask($, on, w => { w.statDirty = ['src/a.ts']; w.headBlobs['src/a.ts'] = blobOf('original'); w.watched['src/a.ts'] = 'original' })
    w.watched['src/a.ts'] = 'MALICIOUS CHANGE'                                       // `git diff HEAD` still lists nothing: w.tree is untouched
    expect(Object.keys(w.tree)).toEqual([])
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
    expect(scriptRuns(w)).toBeGreaterThan(0)
    notFinished(taskOf(h))
  })
  test('negative control: a file merely touched during the task (stat-dirty, same content as the base blob) is not a change', guard(), async ($, on) => {
    const { w, h } = await roTask($, on, w => { w.headBlobs['src/a.ts'] = blobOf('original'); w.watched['src/a.ts'] = 'original' })
    w.statDirty = ['src/a.ts']                                                           // became stat-dirty after the task began; content is the base blob
    await stop($)
    expect(scriptRuns(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
  test('raw tracked bytes change while status, diff and the cached dirty listing remain empty: CHANGED', guard(), async ($, on) => {
    const { w, h } = await roTask($, on, w => { w.headBlobs['src/a.ts'] = blobOf('original'); w.watched['src/a.ts'] = 'original'; w.indexFlags = 'H src/a.ts\0' })
    w.watched['src/a.ts'] = 'changed bytes'
    w.statDirty = []; w.uncommitted = false
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
    expect(scriptRuns(w)).toBeGreaterThan(0)
    notFinished(taskOf(h))
  })
  test('an attributes line added mid-task is a change in itself', guard(), async ($, on) => {
    const { w, h } = await roTask($, on)
    w.attributes = 'src/a.ts filter=h\n'
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
  })
  test('the fingerprint pins checkStat and trustctime', guard(), async ($, on) => {
    const { w } = await roTask($, on)
    await stop($)
    for (const call of w.runs.filter((r: string[]) => r[0] === 'git')) { expect(call).toContain('core.checkStat=default'); expect(call).toContain('core.trustctime=true') }
  })
})

describe('Medium M-1 / L-2 / L-3 of the guard-owned completion review', () => {
  test('a write after the guard recorded a completion withdraws it at once, on every projection', guard(), async ($, on) => {
    const { h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b' } as never)
    for (const m of ['m1', 'm2', 'm3', 'm4']) { /* planned below */ void m }
    await progress($, { action: 'plan', milestones: FIVE })
    for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
    await passAllGates($); await progress($, { action: 'complete', milestone: 'm5' })
    await stop($)
    expect(taskOf(h).status).toBe('done')
    await bash($, "python3 -c \"open('src/x.ts','a').write('x')\"")                  // a write with no edit diff
    expect(taskOf(h).guardDone).toBeUndefined()
    notFinished(taskOf(h))
  })
  test('a read does not withdraw it', guard(), async ($, on) => {
    const { h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b' } as never)
    await progress($, { action: 'plan', milestones: FIVE })
    for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
    await passAllGates($); await progress($, { action: 'complete', milestone: 'm5' })
    await stop($)
    await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/example/a.ts' } as never)
    expect(taskOf(h).guardDone).toBeDefined()
    expect(taskOf(h).status).toBe('done')
  })
  test('L-2: a pass whose first fingerprint was unknown is not a completion', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b' } as never)
    await progress($, { action: 'plan', milestones: FIVE })
    for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
    await passAllGates($); await progress($, { action: 'complete', milestone: 'm5' })
    w.gitHangs = 'diff'
    w.duringRun = async (argv: readonly string[]) => { if (argv[0] === SCRIPT) w.gitHangs = null }   // git answers again after the check began
    await stop($)
    expect(taskOf(h).guardDone).toBeUndefined()
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('L-3: ENFORCE with a script named is enforcing at registration, before any settings read, even for ~/…', () => {
    const sink: any = new Proxy(function () {}, { get: () => sink, apply: () => sink })
    setGuardRequired(false)
    register(sink, { stopGuard: 'ENFORCE', verifyScript: '~/check.sh' })
    expect(isGuardRequired()).toBe(true)
    register(sink, { stopGuard: 'OBSERVE', verifyScript: '~/check.sh' })
    expect(isGuardRequired()).toBe(false)
    register(sink, { stopGuard: 'ENFORCE' })
    expect(isGuardRequired()).toBe(true)                                               // F4: ENFORCE without a script is not OBSERVE; completion stays the guard's
    setGuardRequired(false)
  })
})

describe('Lows: legacy adoption at a prompt, and /clear', () => {
  test('a prompt adopts a legacy held task before it can be replaced', guard(), async ($, on) => {
    world(on)
    on('session.id', () => ({ value: 's1' }))
    const legacyTask = { ...newTask(1, 'g', 1, null), guardSchema: undefined, blocker: 'STOP GUARD: check exit 1 after 3 attempts' } as unknown as Task
    const h = hostState(on, { task: legacyTask, 'run-ledger': { ...emptyLedger('s1'), stopChecks: [{ taskId: 1, uid: '1@1', verifier: 'v', complete: false, name: 'c', sha: 'abcd1234', at: 1, outcome: 'fail', exit: 1, ms: 1, tree: null, summary: 'x', hasSummary: true }] } })
    await start($)
    await prompt($, 'carry on')
    expect(taskOf(h).id).toBe(1)
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('/clear records a held task as abandoned, not as passed or done', guard(), async ($, on) => {
    const { h } = fixture(on)
    await start($); await planAndComplete($, 1); await enroll($)
    await stop($)
    expect(taskOf(h).stopHold).toBeDefined()
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(h.get('task')?.value ?? null).toBeNull()
    const kept = (((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? []).at(-1)
    expect(kept?.outcome).toBe('released')
    expect(kept?.name).toBe('clear')
    expect(kept?.summary).toContain('abandoned')
  })
})

// ---------------------------------------------------------------------------
// Change detection is UNCHANGED, CHANGED or UNKNOWN. Unknown is not proof of no change, and it is not proof of one either.
// ---------------------------------------------------------------------------
describe('change detection: UNCHANGED, CHANGED, UNKNOWN', () => {
  const gitRuns = (w: any) => w.runs.filter((r: string[]) => r[0] === 'git').length
  const scriptRuns = (w: any) => w.runs.filter((r: string[]) => r[0] === SCRIPT).length
  const readonlyTask = async ($: any, on: any, setup: (w: any) => void = () => {}, script = 'fails') => {
    const { w, h } = fixture(on, script)
    setup(w)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    return { w, h }
  }
  test('1 small clean repository: UNCHANGED, no check, a handful of git calls', guard(), async ($, on) => {
    const { w, h } = await readonlyTask($, on)
    await finishAll($)
    const before = gitRuns(w)
    await stop($)
    expect(gitRuns(w) - before).toBeLessThanOrEqual(23)                               // v0.6.6: +5 for the repository-state check and its repeat, -2 for the filter check
    expect(scriptRuns(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
  test('2 large clean repository (50000 index entries, 3000 flagged-clean): UNCHANGED at a constant number of git calls', guard(), async ($, on) => {
    const { w, h } = await readonlyTask($, on, w => { w.indexFlags = Array.from({ length: 50_000 }, (_, i) => `H src/f${i}.ts`).join('\0') + '\0' })
    await finishAll($)
    const before = gitRuns(w)
    await stop($)
    expect(gitRuns(w) - before).toBeLessThanOrEqual(23)                               // v0.6.6: +5 for the repository-state check and its repeat, -2 for the filter check
    expect(scriptRuns(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
  test('3 large repository with real modifications: CHANGED, converted, checked, held', guard(), async ($, on) => {
    const { w, h } = await readonlyTask($, on, w => { w.indexFlags = Array.from({ length: 50_000 }, (_, i) => `H src/f${i}.ts`).join('\0') + '\0' })
    w.tree['src/f7.ts'] = 'edited'
    await finishAll($)
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).kind).toBe('coding')
    expect(taskOf(h).stopHold).toBeDefined()
  })
  // 4 and 4b measure 5000 untracked files; a shared CI runner has taken over 7 s for 4b, past the kit's 5 s default
  test('4 many untracked files: 5000 are measured in a bounded number of git calls, and still UNCHANGED', { ...guard(), timeoutMs: 20000 }, async ($, on) => {
    const { w, h } = await readonlyTask($, on, w => { w.untracked = Array.from({ length: 5000 }, (_, i) => `gen/u${i}.txt`) })
    expect(taskOf(h).startTree).toEqual(expect.any(String))
    await finishAll($)
    const before = gitRuns(w)
    await stop($)
    expect(gitRuns(w) - before).toBeLessThanOrEqual(35) // includes authoritative commit-tree enumeration; v0.6.6: +5 for the repository-state check and its repeat, -2 for the filter check
    expect(scriptRuns(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
  test('4b one more untracked file among 5000 is CHANGED', { ...guard(), timeoutMs: 20000 }, async ($, on) => {
    const { w, h } = await readonlyTask($, on, w => { w.untracked = Array.from({ length: 5000 }, (_, i) => `gen/u${i}.txt`) })
    w.untracked.push('gen/new.txt')
    await finishAll($)
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
    expect(scriptRuns(w)).toBeGreaterThan(0)
  })
  test('4c beyond the cap the tree is UNKNOWN: the check runs, the task is not called coding, the reason is recorded', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.untracked = Array.from({ length: 20_001 }, (_, i) => `gen/u${i}.txt`)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('coding')                                              // no known baseline: the claim is not accepted
    await finishAll($)
    const out = await stop($)
    expect(scriptRuns(w)).toBe(1)
    expect(out.block).toBeDefined()
    const kept = ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? []
    expect(kept.at(-1)?.summary).toContain('change detection unknown')
    expect(kept.at(-1)?.summary).toContain('more than 20000')
    notFinished(taskOf(h))
  })
  test('5 a git timeout is UNKNOWN: checked, bounded, never a manufactured pass', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('readonly')
    await finishAll($)
    w.gitHangs = 'diff'
    const first = await stop($)
    expect(first.block).toBeDefined()
    expect(scriptRuns(w)).toBe(1)
    expect(taskOf(h).kind).toBe('readonly')                                           // unknown is not evidence of a change
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
    notFinished(taskOf(h))
    await stop($); const last = await stop($)
    expect(last.block).toBeUndefined()                                                // bounded: the loop ends
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('5b a git timeout with a passing check is not a completion: held, no record, reason kept', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    w.gitHangs = 'diff'
    await stop($)
    expect(scriptRuns(w)).toBe(1)
    expect(taskOf(h).stopHold).toBeDefined()
    expect(taskOf(h).guardDone).toBeUndefined()
    notFinished(taskOf(h))
  })
  test('7 a non-git workspace: UNKNOWN, checked once on a failing script, held, bounded', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.gitStatus = null
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    const out = await stop($)
    expect(out.block).toBeDefined()
    expect(taskOf(h).stopHold).toBeDefined()
    const kept = ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? []
    expect(kept.at(-1)?.summary).toContain('this project is not a Git repository')                  // v0.6.4 wording: outside Git, said so
    notFinished(taskOf(h))
  })
  test('8 modification before a late read-only declaration is not accepted', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    w.tree['src/changed-first.ts'] = 'x'
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('coding')
    await finishAll($); await stop($)
    expect(scriptRuns(w)).toBeGreaterThan(0)
    notFinished(taskOf(h))
  })
  test('9 modification after a valid read-only declaration is CHANGED at the next stop', guard(), async ($, on) => {
    const { w, h } = await readonlyTask($, on)
    w.tree['src/changed-after.ts'] = 'x'
    await finishAll($); await stop($)
    expect(taskOf(h).kind).toBe('coding')
    notFinished(taskOf(h))
  })
  test('10 unknown fingerprint under ENFORCE never reads VERIFIED DONE without the check', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.gitStatus = null
    await prompt($, 'explain'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    await stop($)
    expect(scriptRuns(w)).toBeGreaterThan(0)
    notFinished(taskOf(h))
  })
})

describe('F3: a background change after the guard completed a task', () => {
  const finished = async ($: any, on: any) => {
    const fx = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b' } as never)
    await progress($, { action: 'plan', milestones: FIVE })
    for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
    await passAllGates($); await progress($, { action: 'complete', milestone: 'm5' })
    await stop($)
    expect(taskOf(fx.h).status).toBe('done')

    return fx
  }
  test('the next stop re-checks instead of trusting the old record', guard(), async ($, on) => {
    const { w, h } = await finished($, on)
    const before = w.runs.filter(r => r[0] === SCRIPT).length
    w.tree['src/bg.ts'] = 'changed by a background process'
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(before + 1)
    expect(taskOf(h).guardDone?.tree).toBeDefined()
  })
  test('the next prompt does not carry DONE over a changed tree', guard(), async ($, on) => {
    const { w, h } = await finished($, on)
    w.tree['src/bg.ts'] = 'changed by a background process'
    await prompt($, 'now something else entirely please')
    expect(taskOf(h).guardDone).toBeUndefined()
  })
  test('a progress status read after the change does not report DONE', guard(), async ($, on) => {
    const { w, h } = await finished($, on)
    w.tree['src/bg.ts'] = 'changed by a background process'
    const text = await progress($, { action: 'status' })
    expect(text).not.toMatch(/\bDONE\b|100%/)
    notFinished(taskOf(h))
  })
})

describe('active clean-filter refreshed-index protection', () => {
  test('a filter-normalized index cannot make an edited readonly task complete without a check', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE }); await finishAll($)
    w.gitFilterConfig = 'filter.hide.clean\nprintf original\0'; w.gitFilterAttributes = 'a\0filter\0hide\0'; w.indexFlags = 'H a\0'
    w.uncommitted = false; w.statDirty = []; w.watched.a = 'MALICIOUS CHANGE'
    await stop($)
    expect(w.runs.filter(argv => argv[0] === SCRIPT).length).toBeGreaterThan(0)
    notFinished(taskOf(h))
  })
})
