// Diff coverage (v0.7.0, Phase 1: not registered, nothing calls it yet). Which observed test runs may later stand as
// evidence, what a record of one may hold, and when a report is bound to it.
//
// The coverage tool is the repository's code and can write any report. What Cockpit can establish is narrower: that a
// test run it watched, from a closed list of test programs, finished in the foreground on the main session and
// succeeded, that the report changed during that run, and that the source was the same before the run, after it, and
// now. Evidence that passes is MATCHED, worded as such; everything else is NOT USED, with the reason.
//
// Every decision here is made from data the caller hands in: the raw command text, the host's own fields about the
// call and its result, and measurements made elsewhere. Nothing runs, reads or stores anything. In particular, no test
// is ever started to obtain coverage, and no command text, argument, environment, output or report content is kept.

import { readBash } from './classify'
import type { ReportReadRefusal } from './diffcov-lcov'
import { reportPathOf } from './diffcov-paths'

/** The closed set of labels a record can carry. A script's name is the repository's text, so it is never one. */
export const CAPTURE_LABELS = [
  'node --test', 'vitest', 'jest', 'deno test', 'bun test',
  'npx vitest', 'npx jest', 'bunx vitest', 'bunx jest', 'pnpm exec vitest', 'pnpm exec jest',
  'npm test', 'pnpm test', 'yarn test', 'npm run (a script)', 'pnpm run (a script)', 'yarn run (a script)',
] as const
export type CaptureLabel = (typeof CAPTURE_LABELS)[number]

/** Why a call is not recorded. A closed vocabulary: none of these carries any text of the call. */
export type CaptureSkip =
  | 'NOT_A_BASH_CALL'
  | 'NOT_PLAIN_WORDS'
  | 'NOT_A_LISTED_TEST_PROGRAM'
  | 'MOVES_THE_TOOL_ROOT'
  | 'NOT_A_TEST_COMMAND'
  | 'BACKGROUND'
  | 'HELPER_AGENT'
  | 'OUTSIDE_REPOSITORY_ROOT'
  | 'REFUSED'
  | 'DID_NOT_SUCCEED'
  | 'INTERRUPTED'
  | 'BACKGROUNDED'
  | 'TIMED_OUT'
  | 'RESULT_UNRECOGNISED'

// Plain words only: no quotes, `$`, backticks, `;`, `&`, `|`, `<`, `>`, parentheses, globs or `~`, so nothing but the
// one command can write the report. The plugin's shell parser reads `vitest &`, `(vitest)` and a heredoc all as a
// plain `vitest` (measured), so it is not the predicate.
const WORD = /^[A-Za-z0-9_./=:@+,-]+$/
// Flags that make a tool resolve paths against another directory, long forms with or without a value, short forms with
// or without an attached one (`-Csub`).
const MOVES_ROOT = /^(?:--prefix|--root|--rootDir|--root-dir|--dir|--cwd|--workspace|--workspaces|--filter|--config|--project|--projects|--recursive)(?:=.*)?$|^-[CwFcr]/
const ROOT_FLAGS = ['prefix', 'root', 'rootdir', 'root-dir', 'dir', 'cwd', 'workspace', 'workspaces', 'filter', 'config', 'project', 'projects', 'recursive']
/**
 * A long flag that may stand for a root-moving one: npm accepts any unambiguous abbreviation (`npm test --prefi=sub`
 * ran its script in `sub`: measured on npm 10.9.9), so a prefix of three letters or more of a listed flag is refused too.
 */
const movesRoot = (word: string): boolean => {
  if (MOVES_ROOT.test(word)) return true
  if (!word.startsWith('--')) return false
  const name = word.slice(2).split('=')[0]!.toLowerCase()

  return name.length >= 3 && ROOT_FLAGS.some(flag => flag.startsWith(name))
}
const RUNNERS = new Set(['vitest', 'jest'])
// `bun run` runs a file as readily as a script, so of bun only `bun test` is accepted
const MANAGERS = new Set(['npm', 'pnpm', 'yarn'])
const MAX_COMMAND = 512

/**
 * The label for a command text a record may come from, or why not: C2 (plain words, one space apart, at most 512
 * characters), C3 (a listed program), C4 (no root-moving flag), then C1 (the plugin's own classifier reads it as a
 * TEST check). `c8` and `nyc` are not listed: the classifier does not read them as TEST (measured).
 */
export const captureLabelOf = (command: string): { label: CaptureLabel } | { skip: CaptureSkip } => {
  if (command.length === 0 || command.length > MAX_COMMAND) return { skip: 'NOT_PLAIN_WORDS' }
  // splitting on one space and testing each word also refuses tabs, newlines and two spaces in a row
  const words = command.split(' ')
  if (words.some(word => !WORD.test(word))) return { skip: 'NOT_PLAIN_WORDS' }
  const [program, first, second] = words
  let label: CaptureLabel | null = null
  // `--test` first: the classifier also accepts `node x.js --test`, which runs a file of the repository's first
  if (program === 'node' && first === '--test') label = 'node --test'
  else if (program === 'vitest' || program === 'jest') label = program
  else if ((program === 'deno' || program === 'bun') && first === 'test') label = `${program} test`
  else if ((program === 'npx' || program === 'bunx') && first !== undefined && RUNNERS.has(first)) label = `${program} ${first}` as CaptureLabel
  else if (program === 'pnpm' && first === 'exec' && second !== undefined && RUNNERS.has(second)) label = `pnpm exec ${second}` as CaptureLabel
  else if (program !== undefined && MANAGERS.has(program) && first === 'test') label = `${program} test` as CaptureLabel
  else if (program !== undefined && MANAGERS.has(program) && first === 'run' && second !== undefined) label = `${program} run (a script)` as CaptureLabel
  if (label === null) return { skip: 'NOT_A_LISTED_TEST_PROGRAM' }
  if (words.slice(1).some(movesRoot)) return { skip: 'MOVES_THE_TOOL_ROOT' }
  // a package manager's own options come before `--`, and any of them could change where it runs: none is accepted
  if (program !== undefined && MANAGERS.has(program)) {
    const end = words.indexOf('--')
    if ((end === -1 ? words : words.slice(0, end)).slice(1).some(word => word.startsWith('-'))) return { skip: 'MOVES_THE_TOOL_ROOT' }
  }
  // read-only use of the gate classifier: nothing here records or changes a gate
  if (!readBash(command).gates.includes('TEST')) return { skip: 'NOT_A_TEST_COMMAND' }

  return { label }
}

/**
 * Before a call runs: whether it may be recorded. The call is the host's `tool.call` input; `cwd` is
 * `$.session.cwd()` read before the call (it follows the shell's `cd`, and is updated only after a call returns:
 * measured), and `root` the verified repository root. A helper's call (`agentId`) is never recorded in v0.7.0.
 */
export const captureBefore = (call: { tool?: unknown; command?: unknown; run_in_background?: unknown; agentId?: unknown }, place: { cwd: string; root: string }): { label: CaptureLabel } | { skip: CaptureSkip } => {
  if (call.tool !== 'Bash' || typeof call.command !== 'string') return { skip: 'NOT_A_BASH_CALL' }
  if (call.agentId !== undefined) return { skip: 'HELPER_AGENT' }
  if (call.run_in_background !== undefined && call.run_in_background !== false) return { skip: 'BACKGROUND' }
  if (place.root === '' || place.cwd !== place.root) return { skip: 'OUTSIDE_REPOSITORY_ROOT' }

  return captureLabelOf(call.command)
}

const isAbsent = (value: unknown): boolean => value === undefined || value === null || value === false || value === ''

/** What a tool answer may carry beside the result (`ToolCallResult`); anything else is a shape not recognised. */
const ANSWER_KEYS = new Set(['ref', 'result', 'text', 'isReadOnly', 'context', 'isError', 'deny'])
/** Every field the host declares for a Bash result (Claude Code 2.1.296's declarations; 2.1.301 sent a subset: measured). */
const RESULT_KEYS = new Set([
  'stdout', 'stderr', 'rawOutputPath', 'interrupted', 'isImage', 'backgroundTaskId', 'backgroundedByUser', 'backgroundedByTurnAbort',
  'backgroundedToDeliverMessage', 'timedOutAfterMs', 'backgroundCwdHint', 'backgroundEndsWithFinalResponse', 'dangerouslyDisableSandbox',
  'returnCodeInterpretation', 'noOutputExpected', 'structuredContent', 'persistedOutputPath', 'persistedOutputSize', 'staleReadFileStateHint',
  'ghRateLimitHint', 'gitOperation', 'bashEditDiff',
])

/**
 * After a call: `'ok'` only when the host's answer shows, field by field, a command that finished in the foreground
 * and succeeded. A failing command and one ended by its own timeout both come back as `isError` with a text result
 * (measured), so neither is ever read as a success; any shape not recognised is refused too.
 */
export const captureAfter = (ran: unknown): { outcome: 'ok' } | { skip: CaptureSkip } => {
  if (ran === null || typeof ran !== 'object') return { skip: 'RESULT_UNRECOGNISED' }
  const answer = ran as Record<string, unknown>
  if (answer['deny'] !== undefined) return { skip: 'REFUSED' }
  if (answer['isError'] !== undefined) return { skip: 'DID_NOT_SUCCEED' }
  // a field the host adds later (an exit code, say) could mean failure: an answer holding one is not read at all
  if (Object.keys(answer).some(key => !ANSWER_KEYS.has(key))) return { skip: 'RESULT_UNRECOGNISED' }
  const result = answer['result']
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return { skip: 'RESULT_UNRECOGNISED' }
  const r = result as Record<string, unknown>
  if (Object.keys(r).some(key => !RESULT_KEYS.has(key))) return { skip: 'RESULT_UNRECOGNISED' }
  if (typeof r['stdout'] !== 'string' || typeof r['stderr'] !== 'string' || r['interrupted'] === undefined) return { skip: 'RESULT_UNRECOGNISED' }
  if (r['interrupted'] !== false) return { skip: 'INTERRUPTED' }
  if (!isAbsent(r['timedOutAfterMs'])) return { skip: 'TIMED_OUT' }
  if (['backgroundTaskId', 'backgroundedByUser', 'backgroundedByTurnAbort', 'backgroundedToDeliverMessage', 'backgroundEndsWithFinalResponse'].some(k => !isAbsent(r[k]))) return { skip: 'BACKGROUNDED' }
  // a non-zero exit the host interprets as no error (`grep` finding nothing) is still not a success
  if (!isAbsent(r['returnCodeInterpretation'])) return { skip: 'DID_NOT_SUCCEED' }

  return { outcome: 'ok' }
}

/**
 * One observed run, sanitised: a closed label, the outcome, where it ran (the main session in the repository root of
 * this project), the source it measured and the report it changed. No command text, argument, environment, output,
 * report content or file name other than the person's configured report path.
 */
export type CaptureRecord = {
  v: 1
  /** When the run ended, by the host's clock, in milliseconds. */
  at: number
  label: CaptureLabel
  outcome: 'ok'
  provenance: 'main'
  /** The project's 128-bit identity, as Cockpit's store keys use it. */
  project: string
  /** The commit HEAD was on when the run ended (shown; binding is by content). */
  head: string
  /** The source identity measured before and after the run: equal, or there is no record. */
  identity: string
  report: {
    /** The configured report path, repository-relative. */
    path: string
    sha256: string
    size: number
    /** The report's no-follow stat identity before the run, or absent; and after it. */
    stampBefore: string | 'absent'
    stampAfter: string
    shaBefore: string | 'absent'
  }
}

/** Why an observed, successful run still leaves no record: revision evidence that is missing or stale. */
export type RecordSkip = 'RECORD_INVALID' | 'SOURCE_IDENTITY_UNKNOWN' | 'SOURCE_CHANGED_DURING_RUN' | 'REVISION_UNKNOWN' | 'REPORT_MISSING'

const HEX64 = /^[0-9a-f]{64}$/
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const PROJECT = /^[0-9a-f]{32}$/
// the identity a no-follow stat gives (raw mode in hex, then size, links or inode, and times), as diffcov-lcov's ReportStat
const STAMP = /^[0-9a-f]{1,8}(?: [0-9]{1,20}(?:\.[0-9]{1,9})?){3,5}$/

/**
 * The record for a successful observed run, or why there is none. Every field is checked against its closed shape;
 * a run whose source identity is unknown or moved during the run, whose commit is unknown, or after which the report
 * is absent, is not recorded at all.
 */
export const captureRecordOf = (input: {
  at: number; label: CaptureLabel; project: string; head: string | null
  identityBefore: string | null; identityAfter: string | null
  report: { path: string; sha256: string | null; size: number; stampBefore: string | 'absent'; stampAfter: string | 'absent'; shaBefore: string | 'absent' }
}): { record: CaptureRecord } | { skip: RecordSkip } => {
  const { report } = input
  if (input.identityBefore === null || input.identityAfter === null) return { skip: 'SOURCE_IDENTITY_UNKNOWN' }
  if (!HEX64.test(input.identityBefore) || !HEX64.test(input.identityAfter)) return { skip: 'RECORD_INVALID' }
  if (input.identityBefore !== input.identityAfter) return { skip: 'SOURCE_CHANGED_DURING_RUN' }
  if (input.head === null) return { skip: 'REVISION_UNKNOWN' }
  if (report.sha256 === null || report.stampAfter === 'absent') return { skip: 'REPORT_MISSING' }
  const path = reportPathOf(report.path)
  const valid = Number.isSafeInteger(input.at) && input.at > 0 && (CAPTURE_LABELS as readonly string[]).includes(input.label) &&
    PROJECT.test(input.project) && COMMIT.test(input.head) && 'rel' in path && HEX64.test(report.sha256) &&
    Number.isSafeInteger(report.size) && report.size > 0 && STAMP.test(report.stampAfter) &&
    (report.stampBefore === 'absent' || STAMP.test(report.stampBefore)) && (report.shaBefore === 'absent' || HEX64.test(report.shaBefore))
  if (!valid) return { skip: 'RECORD_INVALID' }

  return {
    record: {
      v: 1, at: input.at, label: input.label, outcome: 'ok', provenance: 'main', project: input.project, head: input.head, identity: input.identityAfter,
      report: { path: report.path, sha256: report.sha256, size: report.size, stampBefore: report.stampBefore, stampAfter: report.stampAfter, shaBefore: report.shaBefore },
    },
  }
}

/** Records kept per project, newest first. A flood of runs pushes old ones out; binding then fails closed. */
export const CAPTURES_KEPT = 8

/** The kept list after one more record. */
export const keepCapture = (kept: readonly CaptureRecord[], record: CaptureRecord): CaptureRecord[] => [record, ...kept].slice(0, CAPTURES_KEPT)

/**
 * Stored records read back: only those that are exactly the shape `captureRecordOf` writes (a store can hold anything
 * an older or newer build left), for this project. A record that is not is dropped, never repaired.
 */
export const capturesOf = (stored: unknown, project: string): CaptureRecord[] => {
  if (stored === null || typeof stored !== 'object' || (stored as { v?: unknown }).v !== 1 || !Array.isArray((stored as { captures?: unknown }).captures)) return []
  const out: CaptureRecord[] = []
  for (const item of (stored as { captures: unknown[] }).captures.slice(0, CAPTURES_KEPT)) {
    if (item === null || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const r = c['report'] as Record<string, unknown> | null | undefined
    if (r === null || typeof r !== 'object' || c['v'] !== 1 || c['outcome'] !== 'ok' || c['provenance'] !== 'main' || c['project'] !== project) continue
    if (Object.keys(c).sort().join() !== 'at,head,identity,label,outcome,project,provenance,report,v' || Object.keys(r).sort().join() !== 'path,sha256,shaBefore,size,stampAfter,stampBefore') continue
    const again = captureRecordOf({
      at: c['at'] as number, label: c['label'] as CaptureLabel, project, head: typeof c['head'] === 'string' ? c['head'] : null,
      identityBefore: typeof c['identity'] === 'string' ? c['identity'] : null, identityAfter: typeof c['identity'] === 'string' ? c['identity'] : null,
      report: { path: String(r['path']), sha256: typeof r['sha256'] === 'string' ? r['sha256'] : null, size: r['size'] as number, stampBefore: String(r['stampBefore']), stampAfter: String(r['stampAfter']), shaBefore: String(r['shaBefore']) },
    })
    if ('record' in again) out.push(again.record)
  }

  // binding takes the newest record that matches, so the order is Cockpit's own, not whatever the store held
  return out.sort((a, b) => b.at - a.at)
}

/** Why a report's figures are not used. The reader's refusals come first; then the binding conditions, in order. */
export type BindingRefusal =
  | ReportReadRefusal
  | 'RUN_NOT_OBSERVED'
  | 'REPORT_CHANGED_SINCE_RUN'
  | 'REPORT_NOT_REFRESHED_BY_RUN'
  | 'SOURCE_IDENTITY_UNKNOWN'
  | 'SOURCE_CHANGED_SINCE_RUN'
  | 'SOURCE_CHANGED_DURING_REPORT'

/** Facts shown beside MATCHED evidence, never as refusals: both describe genuine reruns as well as touches and copies. */
export type BindingNote = 'BYTES_UNCHANGED_BY_RUN' | 'BYTES_OF_ANOTHER_SOURCE'

export type Binding = { state: 'BOUND'; capture: CaptureRecord; notes: BindingNote[] } | { state: 'UNBOUND'; why: BindingRefusal; capture: CaptureRecord | null }

/**
 * Whether the report just read may be used. `report` is what the reader established (the SHA-256 of exactly the
 * bytes it read, or its refusal); `identityNow` the source identity measured for this report, and `identityAfterReads`
 * the same measured again after every read the report made (the diff, the changed files, the report). The first
 * condition that fails is the reason; changed or stale evidence is never used, and nothing here can make it used.
 */
export const bindEvidence = (input: {
  project: string
  reportPath: string
  report: { sha256: string } | { refuse: ReportReadRefusal }
  identityNow: string | null
  identityAfterReads: string | null
  captures: readonly CaptureRecord[]
}): Binding => {
  if ('refuse' in input.report) return { state: 'UNBOUND', why: input.report.refuse, capture: null }
  const sha = input.report.sha256
  const mine = input.captures.filter(c => c.project === input.project && c.report.path === input.reportPath)
  // B2: an observed run recorded for this report
  if (mine.length === 0) return { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED', capture: null }
  // B3: the newest record that left exactly these bytes
  const capture = mine.find(c => c.report.sha256 === sha)
  if (capture === undefined) return { state: 'UNBOUND', why: 'REPORT_CHANGED_SINCE_RUN', capture: mine[0]! }
  // B4: the report changed during that run
  if (capture.report.stampBefore === capture.report.stampAfter) return { state: 'UNBOUND', why: 'REPORT_NOT_REFRESHED_BY_RUN', capture }
  // B5 holds by construction (a record exists only when the identities before and after the run were known and equal);
  // B6: the source now is the source that run measured
  if (input.identityNow === null || !HEX64.test(input.identityNow)) return { state: 'UNBOUND', why: 'SOURCE_IDENTITY_UNKNOWN', capture }
  if (input.identityNow !== capture.identity) return { state: 'UNBOUND', why: 'SOURCE_CHANGED_SINCE_RUN', capture }
  // B8: and it did not move while the report was being made
  if (input.identityAfterReads === null || !HEX64.test(input.identityAfterReads)) return { state: 'UNBOUND', why: 'SOURCE_IDENTITY_UNKNOWN', capture }
  if (input.identityAfterReads !== input.identityNow) return { state: 'UNBOUND', why: 'SOURCE_CHANGED_DURING_REPORT', capture }
  const notes: BindingNote[] = []
  const others = mine.filter(c => c !== capture)
  // the run left the bytes as they were, and no kept record that wrote these bytes measured this source
  if (capture.report.shaBefore === sha && !others.some(c => c.report.sha256 === sha && c.report.shaBefore !== sha && c.identity === capture.identity)) notes.push('BYTES_UNCHANGED_BY_RUN')
  // the run wrote bytes a kept record had written after measuring a different source
  if (capture.report.shaBefore !== sha && others.some(c => c.report.sha256 === sha && c.identity !== capture.identity)) notes.push('BYTES_OF_ANOTHER_SOURCE')

  return { state: 'BOUND', capture, notes }
}
