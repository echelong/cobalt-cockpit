// Diff coverage, Phase 1.6: a test-only composition of the pure modules, end to end. Nothing here is production code
// and nothing registers it: it stands in for the host, Git, the working tree, the report file and Cockpit's store with
// synthetic, in-memory data, and calls the existing pure functions in the order the later phases will:
//
//   captureBefore, captureAfter -> captureRecordOf -> keepCapture / capturesOf (through a JSON store)
//   -> reportReadVerdict -> bindEvidence -> parseLcov with sfMatcher -> sourceFactsOf -> classifyChange
//   -> diffEvidenceOf (or unavailableEvidenceOf) -> renderDiffEvidence
//
// No process is started, no file is read, no Git is run. Identities are SHA-256 of the synthetic bytes, so a source or
// report that changes really has a new identity, and a report binds only to the bytes a run left.

import { CAPTURE_LABELS, bindEvidence, captureAfter, captureBefore, captureRecordOf, capturesOf, keepCapture } from '../hooks/diffcov-capture'
import type { Binding, CaptureLabel, CaptureRecord, CaptureSkip, RecordSkip } from '../hooks/diffcov-capture'
import { CLASSIFY_LIMITS, CLOSING, TITLE, categoryOf, classifyChange, countsOf, diffEvidenceOf, renderDiffEvidence, sourceFactsOf, unavailableEvidenceOf } from '../hooks/diffcov-classify'
import type { ChangedFile, Classification, ClassifyLimits, DiffEvidence, Evidence, FileReason, LineReason, WorkloadRefusal } from '../hooks/diffcov-classify'
import { parseLcov, reportReadVerdict } from '../hooks/diffcov-lcov'
import type { ReportStat } from '../hooks/diffcov-lcov'
import { excludePrefixesOf, sfMatcher, textColumns } from '../hooks/diffcov-paths'

export const ROOT = '/work/repo'
export const PROJECT = 'c0ba17c0c0ba17c0c0ba17c0c0ba17c0'
export const HEAD = '4f9a1c2e7b30'.padEnd(40, '0')
export const BASE = 'b662021802ede55fe72f1c294db561e4011a5400'
export const REPORT_PATH = 'coverage/lcov.info'
/** The first run ends at 2026-10-16 09:00 UTC; each later call one minute after the one before. */
export const T0 = Date.UTC(2026, 9, 16, 9, 0)

// --- The host's answers to a Bash call, in the shapes measured on Claude Code 2.1.301 (tests/diffcov-capture.test.ts).

export const ANSWERS = {
  ok: () => ({ ref: 'r', isReadOnly: false, text: 'ok', result: { stdout: '12 passed', stderr: '', interrupted: false } }),
  failed: () => ({ ref: 'r', isError: true, isReadOnly: false, text: 'Exit code 1', result: 'Error: Exit code 1' }),
  interrupted: () => ({ ref: 'r', isReadOnly: false, text: '', result: { stdout: '', stderr: '', interrupted: true } }),
  backgrounded: () => ({ ref: 'r', isReadOnly: false, text: '', result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg42' } }),
  timedOut: () => ({ ref: 'r', isReadOnly: false, text: '', result: { stdout: '', stderr: '', interrupted: false, timedOutAfterMs: 120_000 } }),
  refused: () => ({ ref: 'r', deny: 'the person declined' }),
  /** A field the host does not declare (an exit code) could mean failure: such an answer is not read. */
  unrecognised: () => ({ ref: 'r', isReadOnly: false, text: 'ok', result: { stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 } }),
} as const

// --- The synthetic world.

/** One changed path as Git will describe it, with the bytes the working tree holds for it now. */
export type TreeFile = {
  path: string
  status: ChangedFile['status']
  /** The working-tree text (UTF-8), or raw bytes; absent for a deleted path. */
  text?: string
  bytes?: Uint8Array
  kind?: ChangedFile['kind']
  added?: number[]
  modified?: number[]
  deletedLines?: number
  generatedByAttribute?: boolean
  binaryPatch?: boolean
  modeOnly?: boolean
}

/** One observed Bash call: what the model asked, where, what the host answered, and what the command left at the report path. */
export type Run = {
  command: string
  answer: unknown
  /** The call's own fields beside the command: `run_in_background`, `agentId`. */
  call?: Record<string, unknown>
  /** `$.session.cwd()` before the call; the repository root unless given. */
  cwd?: string
  /** The bytes the command wrote at the report path, or null when it wrote nothing there. */
  report?: string | Uint8Array | null
  /** A source file edited before this call, between runs. */
  editsBefore?: { path: string; text: string }
  /** A source file the command itself rewrote while it ran (its identity before and after then differ). */
  editsDuringRun?: { path: string; text: string }
}

/** What happens after the runs and before the report is asked for. */
export type After = {
  editSource?: { path: string; text: string }
  rewriteReport?: string
  /** The store as some other build left it: a change to the JSON value read back. */
  tamperStore?: (stored: { v: unknown; captures: Record<string, unknown>[] }) => unknown
  /** The source moved again while the report's reads were made (the second identity differs). */
  sourceMovesDuringReport?: boolean
  /** What a no-follow stat finds at the report path: an ordinary file unless given. */
  reportKind?: 'link' | 'hard-linked' | 'changes-while-read' | 'linked-parent'
}

export type Scenario = {
  name: string
  /** What the scenario shows, in a sentence: the fixture reads on its own. */
  about: string
  tree: TreeFile[]
  runs: Run[]
  after?: After
  /** The person's coverageDiffExclude text. */
  exclude?: string
  /** Classification limits lowered for this scenario: the production limits' own tests already reach the real values. */
  limits?: Partial<ClassifyLimits>
  columns?: number
  page?: number
}

/** Everything the lifecycle decided, step by step, for the tests to check. */
export type Outcome = {
  scenario: Scenario
  calls: { before: { label: CaptureLabel } | { skip: CaptureSkip }; after: { outcome: 'ok' } | { skip: CaptureSkip } | null; record: { record: CaptureRecord } | { skip: RecordSkip } | null }[]
  /** The store's JSON text after the runs, as a store would hold it. */
  storedJson: string
  kept: CaptureRecord[]
  reportBytes: Uint8Array | null
  reportSha: string | null
  read: { ok: true } | { refuse: string }
  identityNow: string
  identityAfterReads: string
  binding: Binding
  evidence: Evidence
  files: ChangedFile[]
  classification: Classification | { refuse: WorkloadRefusal } | null
  view: DiffEvidence
  columns: number
  page: number
  text: string
}

const encode = (text: string) => new TextEncoder().encode(text)
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('')
export const sha256 = async (bytes: Uint8Array): Promise<string> => hex(await crypto.subtle.digest('SHA-256', bytes))
const bytesOf = (file: TreeFile): Uint8Array | null => file.bytes ?? (file.text === undefined ? null : encode(file.text))

/** Deep-frozen, so a pure function that writes to its input throws instead of passing quietly. */
export const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value) && !ArrayBuffer.isView(value) && !(value instanceof Map)) {
    Object.freeze(value)
    for (const inner of Object.values(value as Record<string, unknown>)) freeze(inner)
  }
  return value
}

/** The source identity: SHA-256 over every changed path, its status and its bytes, in path order. */
const identityOf = async (tree: readonly TreeFile[]): Promise<string> => {
  const parts = [...tree].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(f => `${f.path}\u{0}${f.status}\u{0}${Array.from(bytesOf(f) ?? [], b => b.toString(16).padStart(2, '0')).join('')}\n`)
  return sha256(encode(parts.join('')))
}

/** A no-follow stat identity in the reader's shape: raw mode, size, links, inode, and the write time twice. */
const stampOf = (size: number, write: number) => `81a4 ${size} 1 ${4000 + write} ${1_792_134_000 + write}.000000000 ${1_792_134_000 + write}.000000000`
const directory: ReportStat = { kind: 'dir', size: 4096, links: 2, identity: '41ed 4096 2 3999 1792134000.000000000 1792134000.000000000' }

/** The changed lines Git names for a path: all lines of an untracked file, or the added and modified lists. */
const changedLinesOf = (file: ChangedFile): number[] =>
  file.status === 'untracked' ? (file.source !== null && !('refuse' in file.source) ? Array.from({ length: file.source.lineCount }, (_, k) => k + 1) : []) : [...file.added, ...file.modified]

/** Runs one scenario through every step. Deterministic: the same scenario always gives the same outcome. */
export const runLifecycle = async (scenario: Scenario): Promise<Outcome> => {
  const limits: ClassifyLimits = { ...CLASSIFY_LIMITS, ...scenario.limits }
  let tree = scenario.tree.map(f => ({ ...f }))
  // the report file: its bytes, its stat identity, and how many times it was written
  const disk: { report: { bytes: Uint8Array; stamp: string } | null; writes: number } = { report: null, writes: 0 }
  const write = (bytes: Uint8Array) => { disk.writes++; disk.report = { bytes, stamp: stampOf(bytes.length, disk.writes) } }
  let stored: unknown = null
  const calls: Outcome['calls'] = []

  for (const [k, run] of scenario.runs.entries()) {
    const at = T0 + k * 60_000
    if (run.editsBefore !== undefined) tree = tree.map(f => (f.path === run.editsBefore!.path ? { ...f, text: run.editsBefore!.text, bytes: undefined } : f))
    const before = captureBefore(freeze({ tool: 'Bash', command: run.command, ...run.call }), { cwd: run.cwd ?? ROOT, root: ROOT })
    const identityBefore = await identityOf(tree)
    const reportBefore = disk.report
    // the command runs whether or not it may be recorded: it can write the report and edit sources either way
    if (run.editsDuringRun !== undefined) tree = tree.map(f => (f.path === run.editsDuringRun!.path ? { ...f, text: run.editsDuringRun!.text, bytes: undefined } : f))
    if (run.report !== undefined && run.report !== null) write(typeof run.report === 'string' ? encode(run.report) : run.report)
    const identityAfter = await identityOf(tree)
    if ('skip' in before) { calls.push({ before, after: null, record: null }); continue }
    const after = captureAfter(freeze(run.answer))
    if ('skip' in after) { calls.push({ before, after, record: null }); continue }
    const now = disk.report
    const record = captureRecordOf(freeze({
      at, label: before.label, project: PROJECT, head: HEAD, identityBefore, identityAfter,
      report: {
        path: REPORT_PATH,
        sha256: now === null ? null : await sha256(now.bytes),
        size: now === null ? 0 : now.bytes.length,
        stampBefore: reportBefore === null ? 'absent' : reportBefore.stamp,
        stampAfter: now === null ? 'absent' : now.stamp,
        shaBefore: reportBefore === null ? 'absent' : await sha256(reportBefore.bytes),
      },
    }))
    calls.push({ before, after, record })
    // the store round trip: what was kept is read back through capturesOf, as from a store another build may have written
    if ('record' in record) stored = JSON.parse(JSON.stringify({ v: 1, captures: keepCapture(capturesOf(freeze(stored), PROJECT), record.record) }))
  }

  const after = scenario.after ?? {}
  if (after.editSource !== undefined) tree = tree.map(f => (f.path === after.editSource!.path ? { ...f, text: after.editSource!.text, bytes: undefined } : f))
  if (after.rewriteReport !== undefined) write(encode(after.rewriteReport))
  if (after.tamperStore !== undefined && stored !== null) stored = JSON.parse(JSON.stringify(after.tamperStore(JSON.parse(JSON.stringify(stored)))))
  const storedJson = JSON.stringify(stored)
  const kept = capturesOf(freeze(JSON.parse(storedJson)), PROJECT)

  // the reader: a no-follow stat before and after the read, and the bytes in between
  const final = disk.report
  const stat: ReportStat = final === null ? { kind: 'missing', size: 0, links: 0, identity: '' }
    : { kind: after.reportKind === 'link' ? 'link' : 'file', size: final.bytes.length, links: after.reportKind === 'hard-linked' ? 2 : 1, identity: final.stamp }
  const parents = [after.reportKind === 'linked-parent' ? { ...directory, kind: 'link' as const } : directory]
  const statAfter = after.reportKind === 'changes-while-read' ? { ...stat, identity: stampOf(stat.size, disk.writes + 1) } : stat
  const read = reportReadVerdict(freeze({ report: stat, parents }), final === null ? { failed: true } : { bytes: final.bytes.length }, freeze({ report: statAfter, parents }))
  const reportBytes = final === null ? null : final.bytes
  const reportSha = reportBytes === null ? null : await sha256(reportBytes)

  const identityNow = await identityOf(tree)
  const identityAfterReads = after.sourceMovesDuringReport === true ? await sha256(encode(`${identityNow} moved`)) : identityNow
  const binding = bindEvidence(freeze({
    project: PROJECT, reportPath: REPORT_PATH,
    report: 'refuse' in read ? { refuse: read.refuse } : { sha256: reportSha! },
    identityNow, identityAfterReads, captures: kept,
  }))

  // the change, as the Git selection will hand it over, with each file's facts read from its bytes
  const files: ChangedFile[] = tree.map(f => {
    const bytes = bytesOf(f)
    return {
      path: f.path, status: f.status, kind: f.kind ?? (f.status === 'deleted' ? 'none' : 'file'), modeOnly: f.modeOnly ?? false, binaryPatch: f.binaryPatch ?? false,
      added: f.added ?? [], modified: f.modified ?? [], deletedLines: f.deletedLines ?? 0, generatedByAttribute: f.generatedByAttribute ?? false,
      source: f.status === 'deleted' || bytes === null ? null : sourceFactsOf(bytes, limits),
    }
  })
  freeze(files)

  let evidence: Evidence
  if (binding.state === 'UNBOUND') evidence = { state: 'UNBOUND', why: binding.why }
  else {
    const changed = new Map(files.map(f => [f.path, new Set(changedLinesOf(f))]))
    const parsed = await parseLcov(reportBytes!, sfMatcher(changed, { root: ROOT }), { now: () => 0, pause: async () => {} })
    evidence = parsed.ok ? { state: 'BOUND', report: parsed, notes: binding.notes } : { state: 'REJECTED', code: parsed.code, line: parsed.line }
  }

  const source = { head: HEAD, identity: identityNow, tracked: tree.filter(f => f.status !== 'untracked').length, untracked: tree.filter(f => f.status === 'untracked').length }
  const base = { sha: BASE, how: 'task-start' as const, ancestor: true }
  const run = binding.capture === null ? null : { at: binding.capture.at, label: binding.capture.label }
  const coverage = { path: REPORT_PATH, sha256: 'refuse' in read ? null : reportSha, run }
  const exclude = excludePrefixesOf(scenario.exclude ?? '')
  let classification: Outcome['classification'] = null
  let view: DiffEvidence
  if ('refuse' in exclude) view = unavailableEvidenceOf({ source, base, coverage, why: 'EXCLUDE_REFUSED' })
  else {
    classification = classifyChange(files, evidence, freeze(exclude.prefixes), limits)
    view = 'refuse' in classification ? unavailableEvidenceOf({ source, base, coverage, why: classification.refuse }) : diffEvidenceOf({ source, base, coverage, evidence, classification })
  }
  const columns = scenario.columns ?? 80
  const page = scenario.page ?? 1

  return { scenario, calls, storedJson, kept, reportBytes, reportSha, read, identityNow, identityAfterReads, binding, evidence, files, classification, view, columns, page, text: renderDiffEvidence(view, columns, page) }
}

// --- The properties every outcome must hold, whatever the scenario. Each returns the violations it finds.

/** File rows whose changed lines are classified (and so counted); every other row has no verdict at all. */
const LINE_ROWS = new Set<FileReason>(['CLASSIFIED', 'FILE_TYPE_OUT_OF_SCOPE', 'CONFIGURED_EXCLUSION', 'GENERATED_ATTRIBUTE', 'GENERATED_MARKER', 'LINE_TABLE_AMBIGUOUS'])
const VERDICT_WORDS = /\b(?:tested|verified|correct|correctness|safe|proven|passes|passed|assert|assertions|quality|approved)\b/gi
const GATE_WORDS = /\b(?:CODE|TEST|TYPE|BUILD|SECURITY|GIT|DONE|gate|release)\b/g
const lines = (text: string) => text.split('\n')

export const violations = async (o: Outcome): Promise<string[]> => {
  const found: string[] = []
  const fail = (rule: string, detail: unknown = '') => found.push(`${rule}${detail === '' ? '' : `: ${JSON.stringify(detail)}`}`)
  const c = o.classification !== null && !('refuse' in o.classification) ? o.classification : null

  // P1: every classified changed line has exactly one category, and exactly the changed lines of a classified file have one
  if (c !== null) {
    const keys = c.lines.map(v => `${v.path}:${v.line}`)
    if (new Set(keys).size !== keys.length) fail('P1 a line has two verdicts')
    for (const row of c.files) {
      const file = o.files.find(f => f.path === row.path)!
      const got = c.lines.filter(v => v.path === row.path).map(v => v.line).sort((a, b) => a - b)
      const want = LINE_ROWS.has(row.reason) ? [...new Set(changedLinesOf(file))].sort((a, b) => a - b) : []
      if (JSON.stringify(got) !== JSON.stringify(want)) fail('P1 verdicts differ from the changed lines', { path: row.path, reason: row.reason, got, want })
    }
    if (c.files.length !== o.files.length) fail('P1 a changed path has no row')
  }
  // P2: the counts are the classified lines, by category and by reason
  if (c !== null) {
    if (JSON.stringify(o.view.counts) !== JSON.stringify(countsOf(c.lines))) fail('P2 counts differ from the verdicts')
    const byReason = Object.entries(o.view.byReason) as [LineReason, number][]
    if (byReason.reduce((a, [, n]) => a + n, 0) !== c.lines.length) fail('P2 reasons do not add up to the lines')
    for (const v of c.lines) if (categoryOf(v.reason) !== v.category) fail('P2 a reason under another category', v)
    if (o.view.lines.added + o.view.lines.modified !== c.lines.length) fail('P2 added and modified differ from the lines')
  } else if (Object.values(o.view.counts).some(n => n !== 0) || o.view.review.length > 0 || o.view.files.length > 0) fail('P2 a report that could not be made counts or lists something')
  // P3: a file-level refusal is never counted as run, nor as anything else
  if (c !== null) for (const row of c.files) if (!LINE_ROWS.has(row.reason) && c.lines.some(v => v.path === row.path)) fail('P3 a refused file has verdicts', row)
  if (c !== null) for (const v of c.lines) if ((v.category === 'COVERED' || v.category === 'UNCOVERED') && c.files.find(f => f.path === v.path)!.reason !== 'CLASSIFIED') fail('P3 a measured line in a file that was not classified', v)
  // P4: evidence that is not bound, refused or in doubt never gives a measured line
  if (o.evidence.state !== 'BOUND' && (o.view.counts.covered !== 0 || o.view.counts.uncovered !== 0)) fail('P4 measured lines without bound evidence')
  if (o.evidence.state !== 'BOUND' && o.view.state === 'REPORTED' && o.view.evidence.state !== 'NOT_USED') fail('P4 evidence shown as used')
  if (c !== null) for (const v of c.lines) if (v.category === 'UNTRUSTED' && (v.reason === 'REPORTED_RUN' || v.reason === 'REPORTED_NOT_RUN')) fail('P4 an untrusted line with a figure', v)
  if (o.binding.state !== 'BOUND' && /MATCHED/.test(o.text)) fail('P4 MATCHED shown for unbound evidence')
  // P5: missing evidence reads as not measured, never as zero
  if (o.view.state === 'REPORTED') {
    const notMeasured = /^COVERED +- {2}not measured$/m.test(o.text) && /^UNCOVERED +- {2}not measured$/m.test(o.text)
    const measured = /^COVERED +[\d,]+ {2}reported as run$/m.test(o.text) && /^UNCOVERED +[\d,]+/m.test(o.text)
    if (o.view.evidence.state === 'MATCHED' ? !measured || notMeasured : !notMeasured || measured) fail('P5 measured and not measured confused')
  }
  // P6: no call that was refused, failed, cut short or sent to the background leaves a record
  for (const [k, call] of o.calls.entries()) {
    const ok = 'label' in call.before && call.after !== null && 'outcome' in call.after
    if (!ok && call.record !== null) fail('P6 a record from a call that was not a successful foreground test run', k)
    if (!ok && o.kept.some(r => r.at === T0 + k * 60_000)) fail('P6 a kept record from a failed call', k)
  }
  // P7: bound evidence is the bytes the run left, on the source it measured
  if (o.binding.state === 'BOUND') {
    const capture = o.binding.capture
    if (capture.report.sha256 !== o.reportSha || capture.report.sha256 !== await sha256(o.reportBytes!)) fail('P7 bound to bytes the run did not leave')
    if (capture.identity !== o.identityNow || o.identityAfterReads !== o.identityNow) fail('P7 bound to another source')
    if (capture.project !== PROJECT || capture.report.path !== REPORT_PATH) fail('P7 bound to another project or report')
    if (capture.report.stampBefore === capture.report.stampAfter) fail('P7 bound to a run that did not write the report')
  }
  // the record is sanitised: no command text, output or report content ever reaches the store
  for (const run of o.scenario.runs) {
    // every word of the command but those the closed labels themselves hold (a label is stored, and is not the command)
    const words = run.command.split(' ').filter(w => w.length > 3 && w !== REPORT_PATH && !CAPTURE_LABELS.some(label => label.split(' ').includes(w)))
    for (const word of words) if (o.storedJson.includes(word)) fail('P7 the store holds command text', word)
    if (o.storedJson.includes('12 passed') || o.storedJson.includes('SF:') || o.storedJson.includes('DA:')) fail('P7 the store holds output or report content')
  }
  // P8 and P9: no verdict or gate word in Cockpit's own text, and the advisory lines first and last
  // Cockpit's own text: everything before the closing sentences, which wrap below 76 columns, so they are cut by their words
  const folded = o.text.replace(/\s+/g, ' ')
  const closing = CLOSING.join(' ')
  if (lines(o.text)[0] !== TITLE || !folded.endsWith(closing)) fail('P9 the advisory title or closing lines are missing')
  const own = folded.slice(0, folded.length - closing.length)
  if (own.match(VERDICT_WORDS) !== null || own.match(GATE_WORDS) !== null || own.includes('%')) fail('P8 a claim or a gate word', [own.match(VERDICT_WORDS), own.match(GATE_WORDS)])
  // P10: within the width in terminal columns and in code points, at this width and at the narrowest and widest
  for (const columns of [o.columns, 50, 120]) {
    const text = columns === o.columns ? o.text : renderDiffEvidence(o.view, columns, o.page)
    const over = lines(text).filter(line => textColumns(line) > columns || Array.from(line).length > columns)
    if (over.length > 0) fail('P10 a line wider than the width', { columns, over })
  }

  return found
}
