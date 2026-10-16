import { describe, expect, test } from 'claude-code/testing'
import { CAPTURES_KEPT, bindEvidence, captureAfter, captureBefore, captureLabelOf, captureRecordOf, capturesOf, keepCapture } from '../hooks/diffcov-capture'
import type { CaptureRecord } from '../hooks/diffcov-capture'

// Diff coverage, Phase 1: which observed test runs may later stand as evidence, what a record of one holds, and when a
// report binds to it. Nothing here runs; the host fields below are the shapes measured on Claude Code 2.1.301.

const label = (command: string) => { const r = captureLabelOf(command); return 'label' in r ? r.label : r.skip }

describe('a command is recorded only when its raw text is one plain, listed test command (C1 to C4)', () => {
  test('the listed programs, each with its closed label; a script name never appears', () => {
    for (const [command, want] of [
      ['node --test', 'node --test'],
      ['node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info', 'node --test'],
      ['vitest run --coverage', 'vitest'],
      ['jest --coverage', 'jest'],
      ['deno test --coverage=cov', 'deno test'],
      ['bun test --coverage', 'bun test'],
      ['npx vitest run', 'npx vitest'],
      ['bunx jest', 'bunx jest'],
      ['pnpm exec vitest', 'pnpm exec vitest'],
      ['npm test', 'npm test'],
      ['yarn test', 'yarn test'],
      ['pnpm test', 'pnpm test'],
      ['npm run test:unit', 'npm run (a script)'],
      ['yarn run coverage', 'yarn run (a script)'],
    ] as const) expect([command, label(command)]).toEqual([command, want])
  })
  test('anything that could run a second command, or write the report itself, is not plain words (N53)', () => {
    for (const command of [
      'vitest; printf x > coverage/lcov.info', 'vitest && cp old.info coverage/lcov.info', 'vitest || true', 'vitest | tail',
      'vitest > out.txt', 'vitest &', '(vitest)', 'vitest $(echo x)', 'vitest `echo x`', 'vitest <<EOF', 'vitest\nrm x',
      'vitest\trun', 'vitest  run', 'vitest "run"', "vitest 'run'", 'vitest src/*.ts', 'vitest ~/x', ' vitest', 'vitest ', '',
      `vitest ${'a'.repeat(600)}`,
    ]) expect([command, label(command)]).toEqual([command, 'NOT_PLAIN_WORDS'])
  })
  test('a flag that makes the tool resolve paths elsewhere is refused, long or short, with or without a value (C4)', () => {
    for (const command of ['npm test --prefix=sub', 'vitest --root sub', 'vitest --dir=sub', 'jest --rootDir sub', 'jest -c jest.config.js', 'vitest -r sub',
      'pnpm test -Csub', 'npm test --workspaces', 'vitest --config x.ts', 'jest --projects a', 'npm test -w pkg']) expect([command, label(command)]).toEqual([command, 'MOVES_THE_TOOL_ROOT'])
    // placed before the subcommand, the same flags leave the command off the list altogether
    for (const command of ['npm --prefix sub test', 'pnpm -C sub test', 'pnpm --filter x test', 'yarn --cwd sub test']) expect([command, label(command)]).toEqual([command, 'NOT_A_LISTED_TEST_PROGRAM'])
  })
  test('an abbreviated root-moving flag is refused: npm ran `npm test --prefi=sub` in sub (measured, npm 10.9.9)', () => {
    for (const command of ['npm test --prefi=sub', 'npm test --pre=sub', 'vitest --roo sub', 'jest --proj a', 'vitest --worksp x', 'jest --rootdi src', 'vitest --confi=x']) expect([command, label(command)]).toEqual([command, 'MOVES_THE_TOOL_ROOT'])
    // a package manager's own options never pass, whatever they are; after `--` they belong to the script's runner
    for (const command of ['npm test --silent', 'yarn test --frozen', 'pnpm test -s']) expect([command, label(command)]).toEqual([command, 'MOVES_THE_TOOL_ROOT'])
    for (const [command, want] of [['npm test -- --coverage', 'npm test'], ['npm run test:unit -- --run', 'npm run (a script)'], ['npm test -- --prefix=sub', 'MOVES_THE_TOOL_ROOT'], ['vitest --run --reporter=dot', 'vitest'], ['vitest --re x', 'vitest']] as const) expect([command, label(command)]).toEqual([command, want])
  })
  test('programs off the list, including those the classifier does not read as TEST (measured: c8, nyc, bun run)', () => {
    for (const command of ['c8 node --test', 'nyc mocha', 'bun run x.ts', 'node x.js --test', 'npx c8 vitest', 'make test', 'pytest', 'mocha', 'npm t', 'npx', 'npm run', 'CI=1 npm test']) {
      expect([command, label(command)]).toEqual([command, 'NOT_A_LISTED_TEST_PROGRAM'])
    }
  })
  test('a listed manager running a script the classifier does not read as a test is not recorded (C1)', () => {
    expect(label('npm run build')).toBe('NOT_A_TEST_COMMAND')
    expect(label('yarn run lint')).toBe('NOT_A_TEST_COMMAND')
    expect(label('npm run touch-report')).toBe('NOT_A_TEST_COMMAND')
  })
})

describe('before the call: the main session, in the foreground, from the repository root (C5)', () => {
  const root = '/work/repo'
  const bash = (extra: Record<string, unknown> = {}) => ({ tool: 'Bash', command: 'npm test', ...extra })
  test('a plain call qualifies; each exclusion has its reason', () => {
    expect(captureBefore(bash(), { cwd: root, root })).toEqual({ label: 'npm test' })
    expect(captureBefore(bash({ run_in_background: false }), { cwd: root, root })).toEqual({ label: 'npm test' })
    expect(captureBefore({ tool: 'Read', command: 'npm test' }, { cwd: root, root })).toEqual({ skip: 'NOT_A_BASH_CALL' })
    expect(captureBefore({ tool: 'Bash', command: 7 }, { cwd: root, root })).toEqual({ skip: 'NOT_A_BASH_CALL' })
    expect(captureBefore(bash({ agentId: 'a42dd003a7e822719' }), { cwd: root, root })).toEqual({ skip: 'HELPER_AGENT' })
    expect(captureBefore(bash({ run_in_background: true }), { cwd: root, root })).toEqual({ skip: 'BACKGROUND' })
    expect(captureBefore(bash({ run_in_background: 'yes' }), { cwd: root, root })).toEqual({ skip: 'BACKGROUND' })
    // npm from a subdirectory writes paths relative to the package root (measured): such a run is never recorded
    expect(captureBefore(bash(), { cwd: `${root}/sub`, root })).toEqual({ skip: 'OUTSIDE_REPOSITORY_ROOT' })
    expect(captureBefore(bash(), { cwd: '/elsewhere', root })).toEqual({ skip: 'OUTSIDE_REPOSITORY_ROOT' })
    expect(captureBefore(bash(), { cwd: '', root: '' })).toEqual({ skip: 'OUTSIDE_REPOSITORY_ROOT' })
  })
})

describe('after the call: only an answer that shows a foreground success, field by field', () => {
  // the success shape measured on 2.1.301 (`echo spike-ok`): ref, result and text, the result an object
  const success = (over: Record<string, unknown> = {}) => ({ ref: 'r', isReadOnly: false, text: 'ok', result: { stdout: 'ok', stderr: '', interrupted: false, backgroundTaskId: undefined, backgroundedByUser: undefined, timedOutAfterMs: undefined, ...over } })
  test('a success is ok', () => expect(captureAfter(success())).toEqual({ outcome: 'ok' }))
  test('failure and a command ended by its own timeout come back alike, and neither is a success (measured)', () => {
    expect(captureAfter({ ref: 'r', isError: true, isReadOnly: false, text: 'Exit code 1', result: 'Error: Exit code 1' })).toEqual({ skip: 'DID_NOT_SUCCEED' })
    expect(captureAfter({ ref: 'r', isError: true, isReadOnly: false, text: '', result: '' })).toEqual({ skip: 'DID_NOT_SUCCEED' })
    expect(captureAfter({ ...success(), isError: false })).toEqual({ skip: 'DID_NOT_SUCCEED' })
  })
  test('refused, interrupted, backgrounded, timed out, or interpreted: never ok', () => {
    expect(captureAfter({ deny: 'no' })).toEqual({ skip: 'REFUSED' })
    expect(captureAfter(success({ interrupted: true }))).toEqual({ skip: 'INTERRUPTED' })
    expect(captureAfter(success({ backgroundTaskId: 'b10ux5jps' }))).toEqual({ skip: 'BACKGROUNDED' })
    for (const key of ['backgroundedByUser', 'backgroundedByTurnAbort', 'backgroundedToDeliverMessage', 'backgroundEndsWithFinalResponse']) expect(captureAfter(success({ [key]: true }))).toEqual({ skip: 'BACKGROUNDED' })
    expect(captureAfter(success({ timedOutAfterMs: 2000 }))).toEqual({ skip: 'TIMED_OUT' })
    expect(captureAfter(success({ returnCodeInterpretation: 'No matches found' }))).toEqual({ skip: 'DID_NOT_SUCCEED' })
  })
  test('the exact success shape measured on 2.1.301 is ok; any field the host does not declare is refused, not guessed at', () => {
    const measured = Object.fromEntries(['backgroundCwdHint', 'backgroundEndsWithFinalResponse', 'backgroundTaskId', 'backgroundedByTurnAbort', 'backgroundedByUser', 'backgroundedToDeliverMessage', 'bashEditDiff', 'dangerouslyDisableSandbox', 'ghRateLimitHint', 'gitOperation', 'interrupted', 'isImage', 'noOutputExpected', 'persistedOutputPath', 'persistedOutputSize', 'returnCodeInterpretation', 'staleReadFileStateHint', 'stderr', 'stdout', 'timedOutAfterMs'].map(k => [k, k === 'stdout' || k === 'stderr' ? '' : k === 'interrupted' ? false : undefined]))
    expect(captureAfter({ ref: 'r', isReadOnly: false, text: 'ok', result: measured })).toEqual({ outcome: 'ok' })
    expect(captureAfter(success({ exitCode: 1 }))).toEqual({ skip: 'RESULT_UNRECOGNISED' })
    expect(captureAfter({ ...success(), exitCode: 1 })).toEqual({ skip: 'RESULT_UNRECOGNISED' })
    expect(captureAfter({ ref: 'r', text: 'ok', result: ['ok'] })).toEqual({ skip: 'RESULT_UNRECOGNISED' })
  })
  test('any shape not recognised is refused', () => {
    for (const ran of [null, undefined, 7, 'ok', {}, { result: null }, { result: 'text' }, success({ interrupted: undefined }), success({ stdout: 1 }), { result: { stdout: '', interrupted: false } }]) expect(captureAfter(ran)).toEqual({ skip: 'RESULT_UNRECOGNISED' })
  })
})

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), H1 = '1'.repeat(64), H2 = '2'.repeat(64), H3 = '3'.repeat(64)
const PROJECT = 'f'.repeat(32), HEAD = 'e'.repeat(40)
const stamp = (n: number) => `81a4 ${100 + n} 1 ${7 + n} 1.5 ${n}.25`
const make = (over: { at?: number; identity?: string; sha?: string; shaBefore?: string; before?: string; after?: string; path?: string; project?: string } = {}): CaptureRecord => {
  const r = captureRecordOf({
    at: over.at ?? 1_792_134_000_000, label: 'npm test', project: over.project ?? PROJECT, head: HEAD, identityBefore: over.identity ?? A, identityAfter: over.identity ?? A,
    report: { path: over.path ?? 'coverage/lcov.info', sha256: over.sha ?? H1, size: 900, stampBefore: over.before ?? stamp(0), stampAfter: over.after ?? stamp(1), shaBefore: over.shaBefore ?? 'absent' },
  })
  if (!('record' in r)) throw new Error(r.skip)

  return r.record
}

describe('a record holds only sanitised fields', () => {
  test('exactly the allowed fields: no command, argument, environment, output or report content', () => {
    const r = make()
    expect(Object.keys(r).sort()).toEqual(['at', 'head', 'identity', 'label', 'outcome', 'project', 'provenance', 'report', 'v'])
    expect(Object.keys(r.report).sort()).toEqual(['path', 'sha256', 'shaBefore', 'size', 'stampAfter', 'stampBefore'])
    expect(r.outcome).toBe('ok')
    expect(r.provenance).toBe('main')
  })
  test('missing or stale revision evidence leaves no record', () => {
    const base = { at: 1, label: 'npm test' as const, project: PROJECT, head: HEAD, identityBefore: A, identityAfter: A, report: { path: 'coverage/lcov.info', sha256: H1, size: 9, stampBefore: 'absent', stampAfter: stamp(1), shaBefore: 'absent' } }
    expect(captureRecordOf({ ...base, identityBefore: null })).toEqual({ skip: 'SOURCE_IDENTITY_UNKNOWN' })
    expect(captureRecordOf({ ...base, identityAfter: null })).toEqual({ skip: 'SOURCE_IDENTITY_UNKNOWN' })
    expect(captureRecordOf({ ...base, identityAfter: B })).toEqual({ skip: 'SOURCE_CHANGED_DURING_RUN' })
    expect(captureRecordOf({ ...base, head: null })).toEqual({ skip: 'REVISION_UNKNOWN' })
    expect(captureRecordOf({ ...base, report: { ...base.report, sha256: null } })).toEqual({ skip: 'REPORT_MISSING' })
    expect(captureRecordOf({ ...base, report: { ...base.report, stampAfter: 'absent' } })).toEqual({ skip: 'REPORT_MISSING' })
  })
  test('every field is checked against its closed shape', () => {
    const base = { at: 1, label: 'npm test' as const, project: PROJECT, head: HEAD, identityBefore: A, identityAfter: A, report: { path: 'coverage/lcov.info', sha256: H1, size: 9, stampBefore: 'absent', stampAfter: stamp(1), shaBefore: 'absent' } }
    for (const bad of [
      { ...base, at: 0 }, { ...base, at: 1.5 }, { ...base, label: 'npm run build' as never }, { ...base, project: 'short' }, { ...base, head: 'HEAD' },
      { ...base, identityBefore: 'x', identityAfter: 'x' }, { ...base, report: { ...base.report, path: '../x' } }, { ...base, report: { ...base.report, path: '' } },
      { ...base, report: { ...base.report, sha256: 'z'.repeat(64) } }, { ...base, report: { ...base.report, size: 0 } }, { ...base, report: { ...base.report, stampAfter: 'rm -rf /' } },
      { ...base, report: { ...base.report, stampBefore: 'x' } }, { ...base, report: { ...base.report, shaBefore: 'x' } },
    ]) expect(captureRecordOf(bad)).toEqual({ skip: 'RECORD_INVALID' })
  })
  test('the store keeps eight, newest first, and reads back only what it wrote, for this project', () => {
    let kept: CaptureRecord[] = []
    for (let k = 0; k < 10; k++) kept = keepCapture(kept, make({ at: 1000 + k }))
    expect(kept.length).toBe(CAPTURES_KEPT)
    expect(kept[0]!.at).toBe(1009)
    expect(capturesOf({ v: 1, captures: kept }, PROJECT)).toEqual(kept)
    expect(capturesOf({ v: 1, captures: kept }, '0'.repeat(32))).toEqual([])
    expect(capturesOf({ v: 2, captures: kept }, PROJECT)).toEqual([])
    expect(capturesOf(null, PROJECT)).toEqual([])
    expect(capturesOf({ v: 1, captures: [{ ...make(), command: 'npm test --token=x' }] }, PROJECT)).toEqual([])
    expect(capturesOf({ v: 1, captures: [{ ...make(), report: { ...make().report, content: 'TN:' } }] }, PROJECT)).toEqual([])
    expect(capturesOf({ v: 1, captures: [{ ...make(), label: 'npm run deploy' }] }, PROJECT)).toEqual([])
    expect(capturesOf({ v: 1, captures: [...Array.from({ length: 12 }, (_, k) => make({ at: 2000 + k }))] }, PROJECT).length).toBe(CAPTURES_KEPT)
    // the order is Cockpit's own, newest first, whatever order the store held
    expect(capturesOf({ v: 1, captures: [...kept].reverse() }, PROJECT).map(c => c.at)).toEqual(kept.map(c => c.at))
  })
})

describe('binding: the report is used only when every condition holds (B1 to B8, the archived scenarios)', () => {
  const now = (over: Partial<Parameters<typeof bindEvidence>[0]> = {}) => bindEvidence({
    project: PROJECT, reportPath: 'coverage/lcov.info', report: { sha256: H1 }, identityNow: A, identityAfterReads: A, captures: [make()], ...over,
  })
  test('1: an observed run, nothing changed: MATCHED', () => expect(now()).toEqual({ state: 'BOUND', capture: make(), notes: [] }))
  test('B1: the reader refused the report', () => expect(now({ report: { refuse: 'REPORT_CHANGED_WHILE_READ' } })).toMatchObject({ state: 'UNBOUND', why: 'REPORT_CHANGED_WHILE_READ' }))
  test('6: no observed run (B2), and records for another project or another report path do not count', () => {
    expect(now({ captures: [] })).toMatchObject({ state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' })
    expect(now({ captures: [make({ project: '0'.repeat(32) })] })).toMatchObject({ why: 'RUN_NOT_OBSERVED' })
    expect(now({ captures: [make({ path: 'other/lcov.info' })] })).toMatchObject({ why: 'RUN_NOT_OBSERVED' })
  })
  test('2: the report changed after the run (B3)', () => expect(now({ report: { sha256: H2 } })).toMatchObject({ state: 'UNBOUND', why: 'REPORT_CHANGED_SINCE_RUN' }))
  test('7: the latest observed run did not write the report (B4)', () => {
    expect(now({ captures: [make({ at: 2, before: stamp(1), after: stamp(1), shaBefore: H1 }), make({ at: 1 })] })).toMatchObject({ state: 'UNBOUND', why: 'REPORT_NOT_REFRESHED_BY_RUN' })
  })
  test('4: the source changed after the run (B6), or cannot be measured now', () => {
    expect(now({ identityNow: B, identityAfterReads: B })).toMatchObject({ state: 'UNBOUND', why: 'SOURCE_CHANGED_SINCE_RUN' })
    expect(now({ identityNow: null })).toMatchObject({ why: 'SOURCE_IDENTITY_UNKNOWN' })
    expect(now({ identityNow: 'not-hex' })).toMatchObject({ why: 'SOURCE_IDENTITY_UNKNOWN' })
  })
  test('the source changed while the report was made (B8), or could not be measured again', () => {
    expect(now({ identityAfterReads: B })).toMatchObject({ state: 'UNBOUND', why: 'SOURCE_CHANGED_DURING_REPORT' })
    expect(now({ identityAfterReads: null })).toMatchObject({ why: 'SOURCE_IDENTITY_UNKNOWN' })
  })
  test('a run that changed the source while it ran has no record at all, so it cannot bind', () => {
    expect(captureRecordOf({ at: 1, label: 'npm test', project: PROJECT, head: HEAD, identityBefore: A, identityAfter: B, report: { path: 'coverage/lcov.info', sha256: H1, size: 9, stampBefore: 'absent', stampAfter: stamp(1), shaBefore: 'absent' } })).toEqual({ skip: 'SOURCE_CHANGED_DURING_RUN' })
  })
  test('8: a rerun that left identical bytes after an edit no test reaches is MATCHED with a note', () => {
    const rerun = make({ at: 2, identity: B, before: stamp(1), after: stamp(2), shaBefore: H1 })
    expect(now({ identityNow: B, identityAfterReads: B, captures: [rerun, make({ at: 1 })] })).toEqual({ state: 'BOUND', capture: rerun, notes: ['BYTES_UNCHANGED_BY_RUN'] })
  })
  test('47: a second run on the same source writing the same bytes is MATCHED with no note', () => {
    const second = make({ at: 2, before: stamp(1), after: stamp(2), shaBefore: H1 })
    expect(now({ captures: [second, make({ at: 1 })] })).toEqual({ state: 'BOUND', capture: second, notes: [] })
  })
  test('12: a run that wrote bytes an earlier run wrote for a different source is MATCHED with a note', () => {
    const copy = make({ at: 3, identity: C, sha: H1, shaBefore: H2, before: stamp(5), after: stamp(6) })
    const other = make({ at: 2, identity: B, sha: H2, shaBefore: H1, before: stamp(3), after: stamp(4) })
    expect(now({ identityNow: C, identityAfterReads: C, captures: [copy, other, make({ at: 1 })] })).toEqual({ state: 'BOUND', capture: copy, notes: ['BYTES_OF_ANOTHER_SOURCE'] })
  })
  test('23: a flood of newer runs pushes the matching record out, and binding fails closed', () => {
    let kept: CaptureRecord[] = [make({ at: 1 })]
    for (let k = 0; k < CAPTURES_KEPT; k++) kept = keepCapture(kept, make({ at: 10 + k, sha: H3, before: stamp(10 + k), after: stamp(11 + k) }))
    expect(now({ captures: kept })).toMatchObject({ state: 'UNBOUND', why: 'REPORT_CHANGED_SINCE_RUN' })
  })
})
