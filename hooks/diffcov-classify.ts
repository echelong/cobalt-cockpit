// Diff coverage (v0.7.0, Phase 1: not registered, nothing calls it yet). Every changed line of a change gets exactly
// one category with one reason, and the result is rendered for a person to review. It is evidence of a limited kind:
// a coverage tool's claim about which lines ran, checked against what Cockpit observed, never against what the tests
// assert. It changes no gate, no DONE, no review and no release, and it says so.
//
// Line entries mean "the tool reported this line", not "this line is executable": the measured producers disagree
// (Node, c8 and Jest's v8 provider give every line an entry; Vitest and Jest's babel provider give statements only, and
// leave the continuation lines of a statement that never ran with no entry at all). So a missing entry is never read as
// "not executable": such a line is UNAVAILABLE, listed for review. Only a whitespace-only line is NON-EXECUTABLE, as a
// fact about the text.

import { isRecordTime } from './diffcov-capture'
import type { BindingNote, BindingRefusal, CaptureLabel } from './diffcov-capture'
import { isUtf8, LCOV_LIMITS } from './diffcov-lcov'
import type { LcovRefusal, ParsedLcov } from './diffcov-lcov'
import { displayText, isUnderPrefix } from './diffcov-paths'
import type { SfRefusal } from './diffcov-paths'

export const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'] as const

/**
 * The work a change may ask of classification. Lines cost far more than bytes (a 4 MiB file of line feeds holds
 * 4,194,304 lines; classifying it made 4.2 million verdicts and peaked at 1.27 GiB: measured), so each limit is on
 * lines or paths, checked before anything is allocated per line. Past any of them the work is refused, never cut short.
 */
export const CLASSIFY_LIMITS = Object.freeze({
  /** Lines of one changed file, by Git's numbering. */
  maxSourceLines: 100_000,
  /** Changed lines across the whole change, counted as added plus modified (all lines of an untracked file): the verdicts made. */
  maxChangedLines: 200_000,
  /** Changed and untracked paths. */
  maxFiles: 20_000,
})
export type ClassifyLimits = { readonly [K in keyof typeof CLASSIFY_LIMITS]: number }
/** A whole number with its thousands grouped by commas, the same in every locale. */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** One bit per line, line 1 first: a fact about lines costs an eighth of a byte a line, never an entry or a string. */
export type LineBits = Uint8Array
export const lineIn = (bits: LineBits, line: number): boolean => Number.isInteger(line) && line >= 1 && line <= bits.length * 8 && ((bits[(line - 1) >> 3] ?? 0) & (1 << ((line - 1) & 7))) !== 0
/** The lines a set holds, in order (for tests and display; classification only asks `lineIn`). */
export const linesIn = (bits: LineBits): number[] => {
  const out: number[] = []
  for (let k = 0; k < bits.length * 8; k++) if (((bits[k >> 3] ?? 0) & (1 << (k & 7))) !== 0) out.push(k + 1)

  return out
}
const mark = (bits: LineBits, line: number) => { bits[(line - 1) >> 3] = (bits[(line - 1) >> 3] ?? 0) | (1 << ((line - 1) & 7)) }

/** Lines by Git's numbering (line feeds, and one more for an unterminated last line), from the bytes alone; stops past `stopAfter`. */
export const lineCountOf = (bytes: Uint8Array, stopAfter = Infinity): number => {
  let n = 0
  for (let k = bytes.indexOf(0x0a); k !== -1 && n <= stopAfter; k = bytes.indexOf(0x0a, k + 1)) n++

  return n <= stopAfter && bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? n + 1 : n
}

/** Facts about a changed file's text, by Git's line numbering (`\n` ends a line). */
export type SourceFacts = {
  lineCount: number
  /** Lines that are whitespace only. */
  blank: LineBits
  /** Lines that hold a coverage-ignore comment. */
  pragma: LineBits
  /** The line of a generated-file marker among the first five, or null. */
  generatedLine: number | null
  /** A carriage return not followed by a line feed, U+2028 or U+2029: Git and JavaScript number lines differently. */
  lineTableAmbiguous: boolean
}

/** Why a changed file's text could not be used: Git reported a binary, the bounded reader refused it, or it has too many lines. */
export type SourceRefusal = 'BINARY' | 'SOURCE_IS_LINK' | 'SOURCE_NOT_A_REGULAR_FILE' | 'SOURCE_TOO_LARGE' | 'SOURCE_TOO_MANY_LINES' | 'SOURCE_UNREADABLE' | 'SOURCE_GREW' | 'SOURCE_MISSING'

// Comments that make a coverage tool leave lines out, matched in a bounded slice; one added by the change is listed
const PRAGMA = /(?:c8|v8|istanbul)\s+ignore|node:coverage\s+(?:ignore|disable)|deno-coverage-ignore/
const DECODER = new TextDecoder('utf-8')

/** Whitespace only, read off the bytes: space, tab, vertical tab, form feed, U+00A0 (C2 A0) and U+FEFF (EF BB BF). */
const isBlank = (bytes: Uint8Array, from: number, to: number): boolean => {
  for (let k = from; k < to;) {
    const b = bytes[k]!
    if (b === 0x20 || b === 0x09 || b === 0x0b || b === 0x0c) k++
    else if (b === 0xc2 && k + 1 < to && bytes[k + 1] === 0xa0) k += 2
    else if (b === 0xef && k + 2 < to && bytes[k + 1] === 0xbb && bytes[k + 2] === 0xbf) k += 3
    else return false
  }

  return true
}

/**
 * The facts of one changed file from its bytes (read through a bounded reader that refused links and anything not an
 * ordinary file). The lines are counted first, before anything is allocated per line, and a file with more than the
 * limit is refused. The facts are then read in one pass over the bytes: no line is copied into a string of its own, and
 * text checks decode at most a bounded slice of a line, so time and memory follow the bytes.
 */
export const sourceFactsOf = (bytes: Uint8Array, limits: ClassifyLimits = CLASSIFY_LIMITS): SourceFacts | { refuse: SourceRefusal } => {
  if (bytes.length > LCOV_LIMITS.maxBytes) return { refuse: 'SOURCE_TOO_LARGE' }
  if (bytes.subarray(0, 8000).includes(0) || !isUtf8(bytes, 0, bytes.length)) return { refuse: 'BINARY' }
  const lineCount = lineCountOf(bytes, limits.maxSourceLines)
  if (lineCount > limits.maxSourceLines) return { refuse: 'SOURCE_TOO_MANY_LINES' }
  const blank: LineBits = new Uint8Array(Math.ceil(lineCount / 8))
  const pragma: LineBits = new Uint8Array(Math.ceil(lineCount / 8))
  let generatedLine: number | null = null
  // a carriage return not followed by a line feed (one at the very end of the file included), U+2028 (E2 80 A8), U+2029 (E2 80 A9)
  let lineTableAmbiguous = false
  for (let k = 0; k < bytes.length && !lineTableAmbiguous; k++) {
    const b = bytes[k]
    if ((b === 0x0d && bytes[k + 1] !== 0x0a) || (b === 0xe2 && bytes[k + 1] === 0x80 && (bytes[k + 2] === 0xa8 || bytes[k + 2] === 0xa9))) lineTableAmbiguous = true
  }
  let start = 0
  for (let line = 1; line <= lineCount; line++) {
    let end = bytes.indexOf(0x0a, start)
    if (end === -1) end = bytes.length
    // a carriage return just before the line feed is the line's end (CRLF), not part of it
    const stop = end < bytes.length && end > start && bytes[end - 1] === 0x0d ? end - 1 : end
    if (isBlank(bytes, start, stop)) mark(blank, line)
    // at most 2,048 bytes of a line are decoded for the 512 characters the pattern sees (a cut character only ends the slice)
    if (PRAGMA.test(DECODER.decode(bytes.subarray(start, Math.min(stop, start + 2048))).slice(0, 512))) mark(pragma, line)
    if (line <= 5 && generatedLine === null) {
      const head = DECODER.decode(bytes.subarray(start, Math.min(stop, start + 1024))).slice(0, 256)
      if (head.includes('@generated') || (head.includes('Code generated ') && head.includes('DO NOT EDIT'))) generatedLine = line
    }
    start = end + 1
  }

  return { lineCount, blank, pragma, generatedLine, lineTableAmbiguous }
}

/** One changed path as the Git selection (Phase 2) will describe it. */
export type ChangedFile = {
  /** Repository-relative, as Git listed it. */
  path: string
  status: 'added' | 'modified' | 'deleted' | 'type-changed' | 'untracked'
  /** What the path is now. */
  kind: 'file' | 'symlink' | 'submodule' | 'embedded-repository' | 'none'
  /** A mode change and nothing else. */
  modeOnly: boolean
  /** Git printed a binary patch for it. */
  binaryPatch: boolean
  /** New-side line numbers of added and modified lines (`-U0` hunks); an untracked file's lines are all added. */
  added: readonly number[]
  modified: readonly number[]
  /** Old-side lines removed. They have nothing to measure. */
  deletedLines: number
  /** `check-attr` reported `linguist-generated` set. */
  generatedByAttribute: boolean
  /** The text facts, the reader's refusal, or null where nothing was read (deleted, a link, a submodule). */
  source: SourceFacts | { refuse: SourceRefusal } | null
}

/** The report's standing for this change: bound to an observed run, not used (with why), or refused by the parser. */
export type Evidence =
  | { state: 'BOUND'; report: ParsedLcov; notes: readonly BindingNote[] }
  | { state: 'UNBOUND'; why: BindingRefusal }
  | { state: 'REJECTED'; code: LcovRefusal; line: number }

export type Category = 'COVERED' | 'UNCOVERED' | 'EXCLUDED' | 'NON_EXECUTABLE' | 'UNAVAILABLE' | 'UNTRUSTED'
export type FileReason =
  | 'CLASSIFIED' | 'DELETED' | 'EMBEDDED_REPOSITORY' | 'SUBMODULE' | 'SYMLINK' | 'MODE_ONLY' | 'BINARY_BY_ATTRIBUTE'
  | 'FILE_TYPE_OUT_OF_SCOPE' | 'CONFIGURED_EXCLUSION' | 'GENERATED_ATTRIBUTE' | 'GENERATED_MARKER' | 'LINE_TABLE_AMBIGUOUS'
  | 'CHANGE_OUTSIDE_FILE' | SourceRefusal
export type LineReason =
  | 'REPORTED_RUN' | 'REPORTED_NOT_RUN' | 'BLANK_LINE' | 'NO_LINE_ENTRY' | 'FILE_TYPE_OUT_OF_SCOPE' | 'CONFIGURED_EXCLUSION'
  | 'GENERATED_ATTRIBUTE' | 'GENERATED_MARKER' | 'LINE_TABLE_AMBIGUOUS' | 'FILE_NOT_IN_REPORT' | 'RECORD_EMPTY'
  | 'SF_CONFLICTING_IDENTITY' | 'SF_CASE_MISMATCH' | 'RECORD_BEYOND_END_OF_FILE' | 'REPORT_REJECTED' | BindingRefusal

export type LineVerdict = { path: string; line: number; kind: 'added' | 'modified'; category: Category; reason: LineReason }
export type FileRow = { path: string; reason: FileReason; generatedLine?: number }
/**
 * Facts listed for review without changing a category: an ignore comment the change adds (on a classified file), a
 * text file an attribute makes Git treat as binary, and a file excluded as generated, whose lines the report then
 * does not count (a marker in a hand-written file would otherwise hide all of it).
 */
export type ReviewNote =
  | { path: string; line: number; note: 'IGNORE_COMMENT_ADDED' | 'GENERATED_BY_MARKER' }
  | { path: string; note: 'BINARY_BY_ATTRIBUTE' | 'GENERATED_BY_ATTRIBUTE' }
export type Classification = { lines: LineVerdict[]; files: FileRow[]; deletedLines: number; notes: ReviewNote[]; blankWithEntry: boolean }

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')

  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Facts and change lists as `sourceFactsOf` and the Git selection make them: a line count within the limit, bit sets
 * that cover it, and dense arrays. Anything else (a hand-built value, a NaN count) is not classified, so it cannot
 * make the work's count wrong.
 */
const isWellFormed = (f: ChangedFile, facts: SourceFacts, limits: ClassifyLimits): boolean =>
  Number.isSafeInteger(facts.lineCount) && facts.lineCount >= 0 && facts.lineCount <= limits.maxSourceLines &&
  facts.blank instanceof Uint8Array && facts.pragma instanceof Uint8Array && facts.blank.length * 8 >= facts.lineCount && facts.pragma.length * 8 >= facts.lineCount &&
  Array.isArray(f.added) && Array.isArray(f.modified)

/** The text facts of a file whose lines will be classified, or null for a file that only has a row. */
const linesFactsOf = (f: ChangedFile, limits: ClassifyLimits): SourceFacts | null => {
  if (f.status === 'deleted' || f.kind === 'embedded-repository' || f.kind === 'submodule' || f.kind === 'symlink' || f.modeOnly || f.binaryPatch) return null
  if (f.source === null || 'refuse' in f.source) return null
  return isWellFormed(f, f.source, limits) ? f.source : null
}

/** Why a change is too large to classify at all: past a limit, no part of it is reported. */
export type WorkloadRefusal = 'TOO_MANY_FILES' | 'TOO_MANY_LINES'

/**
 * Classifies every changed line. Before anything is allocated per line, the work is counted: more paths or more
 * changed lines than the limits refuse the whole change (no partial classification is ever returned). Then the file
 * rules (F1 to F5) apply to all changed lines of a file, and for a classified file the line rules in order, the first
 * that applies deciding: L1 blank, L2 not bound, L3 refused, L4 no record, L5 conflicting records, L6 entries past the
 * end, L7 an empty record, L8 run, L9 not run, and no entry: UNAVAILABLE.
 */
export const classifyChange = (files: readonly ChangedFile[], evidence: Evidence, exclude: readonly string[], limits: ClassifyLimits = CLASSIFY_LIMITS): Classification | { refuse: WorkloadRefusal } => {
  if (files.length > limits.maxFiles) return { refuse: 'TOO_MANY_FILES' }
  let planned = 0
  for (const f of files) {
    const facts = linesFactsOf(f, limits)
    if (facts === null) continue
    // an upper bound, counted from lengths alone: duplicates between added and modified are counted twice
    planned += f.status === 'untracked' ? facts.lineCount : f.added.length + f.modified.length
    if (planned > limits.maxChangedLines) return { refuse: 'TOO_MANY_LINES' }
  }
  const out: Classification = { lines: [], files: [], deletedLines: 0, notes: [], blankWithEntry: false }
  for (const f of files) {
    out.deletedLines += f.deletedLines
    const row = (reason: FileReason, generatedLine?: number) => out.files.push(generatedLine === undefined ? { path: f.path, reason } : { path: f.path, reason, generatedLine })
    // files without line evidence: each has its row, and none of its lines is counted
    if (f.status === 'deleted') { row('DELETED'); continue }
    if (f.kind === 'embedded-repository') { row('EMBEDDED_REPOSITORY'); continue }
    if (f.kind === 'submodule') { row('SUBMODULE'); continue }
    if (f.kind === 'symlink') { row('SYMLINK'); continue }
    if (f.modeOnly) { row('MODE_ONLY'); continue }
    const source = f.source
    if (f.binaryPatch && source !== null && !('refuse' in source)) {
      // text that an attribute makes Git treat as binary: its changed lines are hidden from this report, so it is shown
      row('BINARY_BY_ATTRIBUTE')
      out.notes.push({ path: f.path, note: 'BINARY_BY_ATTRIBUTE' })
      continue
    }
    if (f.binaryPatch) { row('BINARY'); continue }
    if (source === null) { row('SOURCE_UNREADABLE'); continue }
    if ('refuse' in source) { row(source.refuse); continue }
    if (!isWellFormed(f, source, limits)) { row('SOURCE_UNREADABLE'); continue }
    // changed lines Git named that the text read does not have: the file changed between the diff and the read (an
    // index loop, so a hole in an array is a line that does not fit, not one skipped)
    const fits = (lines: readonly number[]) => { for (let k = 0; k < lines.length; k++) { const n = lines[k]; if (!(Number.isInteger(n) && n! >= 1 && n! <= source.lineCount)) return false } return true }
    if (f.status !== 'untracked' && !(fits(f.added) && fits(f.modified))) { row('CHANGE_OUTSIDE_FILE'); continue }
    const changed = f.status === 'untracked' ? Array.from({ length: source.lineCount }, (_, k) => k + 1) : [...new Set([...f.added, ...f.modified])].sort((a, b) => a - b)
    const added = new Set(f.status === 'untracked' ? changed : f.added)
    const push = (line: number, category: Category, reason: LineReason) => out.lines.push({ path: f.path, line, kind: added.has(line) ? 'added' : 'modified', category, reason })
    const all = (category: Category, reason: LineReason) => { for (const line of changed) push(line, category, reason) }
    if (!(SOURCE_EXTENSIONS as readonly string[]).includes(extensionOf(f.path))) { row('FILE_TYPE_OUT_OF_SCOPE'); all('EXCLUDED', 'FILE_TYPE_OUT_OF_SCOPE'); continue }
    if (exclude.some(prefix => isUnderPrefix(f.path, prefix))) { row('CONFIGURED_EXCLUSION'); all('EXCLUDED', 'CONFIGURED_EXCLUSION'); continue }
    if (f.generatedByAttribute) {
      row('GENERATED_ATTRIBUTE')
      all('EXCLUDED', 'GENERATED_ATTRIBUTE')
      out.notes.push({ path: f.path, note: 'GENERATED_BY_ATTRIBUTE' })
      continue
    }
    if (source.generatedLine !== null) {
      row('GENERATED_MARKER', source.generatedLine)
      all('EXCLUDED', 'GENERATED_MARKER')
      out.notes.push({ path: f.path, line: source.generatedLine, note: 'GENERATED_BY_MARKER' })
      continue
    }
    if (source.lineTableAmbiguous) { row('LINE_TABLE_AMBIGUOUS'); all('UNAVAILABLE', 'LINE_TABLE_AMBIGUOUS'); continue }
    row('CLASSIFIED')
    for (const line of changed) if (lineIn(source.pragma, line)) out.notes.push({ path: f.path, line, note: 'IGNORE_COMMENT_ADDED' })
    const record = evidence.state === 'BOUND' ? evidence.report.files.get(f.path) : undefined
    for (const line of changed) {
      // L1 first: a fact about the text, whatever the report says (Node gives blank lines a count of 1)
      if (lineIn(source.blank, line)) {
        if (record !== undefined && record.lines.has(line)) out.blankWithEntry = true
        push(line, 'NON_EXECUTABLE', 'BLANK_LINE')
        continue
      }
      if (evidence.state === 'UNBOUND') { push(line, 'UNAVAILABLE', evidence.why); continue }
      if (evidence.state === 'REJECTED') { push(line, 'UNAVAILABLE', 'REPORT_REJECTED'); continue }
      if (record === undefined) { push(line, 'UNAVAILABLE', 'FILE_NOT_IN_REPORT'); continue }
      if (record.conflict !== null) { push(line, 'UNTRUSTED', record.conflict); continue }
      if (record.maxLine > source.lineCount) { push(line, 'UNTRUSTED', 'RECORD_BEYOND_END_OF_FILE'); continue }
      if (record.entries === 0) { push(line, 'UNAVAILABLE', 'RECORD_EMPTY'); continue }
      const run = record.lines.get(line)
      if (run === true) push(line, 'COVERED', 'REPORTED_RUN')
      else if (run === false) push(line, 'UNCOVERED', 'REPORTED_NOT_RUN')
      else push(line, 'UNAVAILABLE', 'NO_LINE_ENTRY')
    }
  }

  return out
}

export type Counts = { covered: number; uncovered: number; excluded: number; nonExecutable: number; unavailable: number; untrusted: number }

export const countsOf = (lines: readonly LineVerdict[]): Counts => {
  const c: Counts = { covered: 0, uncovered: 0, excluded: 0, nonExecutable: 0, unavailable: 0, untrusted: 0 }
  for (const v of lines) {
    if (v.category === 'COVERED') c.covered++
    else if (v.category === 'UNCOVERED') c.uncovered++
    else if (v.category === 'EXCLUDED') c.excluded++
    else if (v.category === 'NON_EXECUTABLE') c.nonExecutable++
    else if (v.category === 'UNAVAILABLE') c.unavailable++
    else c.untrusted++
  }

  return c
}

/** Line numbers collapsed into ranges, `7-8`, `10`. */
export const rangesOf = (lines: readonly number[]): string[] => {
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    out.push(sorted[i] === sorted[j] ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }

  return out
}

/** Why no change could be reported at all (Phase 2's Git selection and identity refusals, and the layer's own). */
export type ReportUnavailable =
  | 'LAYER_OFF' | 'REPORT_PATH_UNSET' | 'REPORT_PATH_REFUSED' | 'EXCLUDE_REFUSED' | 'MEMORY_LIMIT_NOT_ENFORCED' | 'PLATFORM_UNSUPPORTED'
  | 'NOT_A_VERIFIED_ROOT' | 'PATH_UNSAFE' | 'GIT_TOO_OLD' | 'PATH_NOT_UTF8' | 'FILTER_CONFIGURED' | 'PARTIAL_CLONE'
  | 'ATTRIBUTES_UNREADABLE' | 'CONFIG_UNREADABLE' | 'BASE_NOT_HEX' | 'BASE_UNRESOLVED' | 'BASE_AMBIGUOUS'
  | 'DIFF_FAILED' | 'DIFF_TIMEOUT' | 'DIFF_TOO_LARGE' | 'DIFF_MALFORMED' | 'DIFF_INCONSISTENT' | 'TOO_MANY_FILES' | 'TOO_MANY_LINES' | 'TOO_MUCH_CHANGED'

/** The value the report is rendered from, and that tests check. */
export type DiffEvidence = {
  v: 1
  state: 'REPORTED' | 'UNAVAILABLE'
  why?: ReportUnavailable
  source: { head: string; identity: string | null; tracked: number; untracked: number }
  base: { sha: string; how: 'given' | 'task-start'; given?: string; ancestor: boolean }
  coverage: null | { path: string; sha256: string | null; run: { at: number; label: CaptureLabel } | null }
  evidence: { state: 'MATCHED' | 'NOT_USED'; why?: BindingRefusal | 'REPORT_REJECTED'; parser?: { code: LcovRefusal; line: number }; notes: BindingNote[] }
  lines: { added: number; modified: number; deleted: number }
  counts: Counts
  /** Changed lines by reason, every category: the words beside each group's count. */
  byReason: Partial<Record<LineReason, number>>
  review: { path: string; ranges: string[]; category: 'UNCOVERED' | 'UNTRUSTED' | 'UNAVAILABLE' | 'NOTE'; reason: LineReason | ReviewNote['note'] }[]
  files: FileRow[]
  refusedRecords: Partial<Record<SfRefusal, number>>
  toolListsNonExecutable: boolean
}

const REVIEW_ORDER = ['UNCOVERED', 'UNTRUSTED', 'UNAVAILABLE', 'NOTE'] as const

/**
 * The data contract when no change could be reported: a workload past the limits, or a refusal before classification.
 * Every count is zero and no line, file or record is listed: the report says why and nothing else.
 */
export const unavailableEvidenceOf = (input: { source: DiffEvidence['source']; base: DiffEvidence['base']; coverage: DiffEvidence['coverage']; why: ReportUnavailable }): DiffEvidence => ({
  v: 1,
  state: 'UNAVAILABLE',
  why: input.why,
  source: input.source,
  base: input.base,
  coverage: input.coverage,
  evidence: { state: 'NOT_USED', notes: [] },
  lines: { added: 0, modified: 0, deleted: 0 },
  counts: { covered: 0, uncovered: 0, excluded: 0, nonExecutable: 0, unavailable: 0, untrusted: 0 },
  byReason: {},
  review: [],
  files: [],
  refusedRecords: {},
  toolListsNonExecutable: false,
})

/** The data contract from a classification. Exactly one category per changed line of a classified file, every path a row. */
export const diffEvidenceOf = (input: {
  source: DiffEvidence['source']
  base: DiffEvidence['base']
  coverage: DiffEvidence['coverage']
  evidence: Evidence
  classification: Classification
}): DiffEvidence => {
  const { classification: c, evidence } = input
  const review: DiffEvidence['review'] = []
  type Group = { path: string; category: DiffEvidence['review'][number]['category']; reason: DiffEvidence['review'][number]['reason']; lines: number[] }
  // grouped per path, then by category and reason: no key is built from a path, and a run of lines with the same
  // verdict, the common case, reuses the group it is in
  const groups: Group[] = []
  const byPath = new Map<string, Map<string, Group>>()
  let last: Group | null = null
  const groupOf = (path: string, category: Group['category'], reason: Group['reason']): Group => {
    if (last !== null && last.path === path && last.category === category && last.reason === reason) return last
    let inner = byPath.get(path)
    if (inner === undefined) { inner = new Map(); byPath.set(path, inner) }
    const key = `${category}:${reason}`
    let g = inner.get(key)
    if (g === undefined) { g = { path, category, reason, lines: [] }; inner.set(key, g); groups.push(g) }
    last = g
    return g
  }
  const order = new Map(c.files.map((f, k) => [f.path, k]))
  for (const v of c.lines) if (v.category === 'UNCOVERED' || v.category === 'UNTRUSTED' || v.category === 'UNAVAILABLE') groupOf(v.path, v.category, v.reason).lines.push(v.line)
  for (const n of c.notes) {
    const g = groupOf(n.path, 'NOTE', n.note)
    if ('line' in n) g.lines.push(n.line)
  }
  const sorted = [...groups].sort((a, b) => REVIEW_ORDER.indexOf(a.category) - REVIEW_ORDER.indexOf(b.category) || (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || (String(a.reason) < String(b.reason) ? -1 : String(a.reason) > String(b.reason) ? 1 : 0))
  for (const g of sorted) review.push({ path: g.path, ranges: rangesOf(g.lines), category: g.category, reason: g.reason })
  const counts = countsOf(c.lines)
  const byReason: Partial<Record<LineReason, number>> = {}
  for (const v of c.lines) byReason[v.reason] = (byReason[v.reason] ?? 0) + 1

  return {
    v: 1,
    state: 'REPORTED',
    source: input.source,
    base: input.base,
    coverage: input.coverage,
    evidence: evidence.state === 'BOUND' ? { state: 'MATCHED', notes: [...evidence.notes] }
      : evidence.state === 'UNBOUND' ? { state: 'NOT_USED', why: evidence.why, notes: [] }
      : { state: 'NOT_USED', why: 'REPORT_REJECTED', parser: { code: evidence.code, line: evidence.line }, notes: [] },
    lines: { added: c.lines.filter(v => v.kind === 'added').length, modified: c.lines.filter(v => v.kind === 'modified').length, deleted: c.deletedLines },
    counts,
    byReason,
    review,
    files: c.files,
    refusedRecords: evidence.state === 'BOUND' ? { ...evidence.report.refused } : {},
    toolListsNonExecutable: evidence.state === 'BOUND' && c.blankWithEntry,
  }
}

// --- Words. Every code a report can show has its words here; the types make the tables complete.

const LINE_WORDS: Record<LineReason, string> = {
  REPORTED_RUN: 'reported as run',
  REPORTED_NOT_RUN: 'reported as not run',
  BLANK_LINE: 'blank',
  NO_LINE_ENTRY: 'the coverage tool gave this line no entry (a statement continued from another line, a declaration, a comment, or an excluded line)',
  FILE_TYPE_OUT_OF_SCOPE: 'not JS/TS',
  CONFIGURED_EXCLUSION: 'excluded by coverageDiffExclude',
  GENERATED_ATTRIBUTE: 'generated: attribute',
  GENERATED_MARKER: 'generated: marker',
  LINE_TABLE_AMBIGUOUS: 'line numbering differs between Git and JavaScript in this file',
  FILE_NOT_IN_REPORT: 'no record for this file in the report',
  RECORD_EMPTY: 'the report has no lines for this file',
  SF_CONFLICTING_IDENTITY: 'the report names this file two ways',
  SF_CASE_MISMATCH: 'the report names this file with different letter case',
  RECORD_BEYOND_END_OF_FILE: 'the report has lines this file does not have',
  REPORT_REJECTED: 'the report was refused',
  RUN_NOT_OBSERVED: 'no observed test run changed this report',
  REPORT_NOT_REFRESHED_BY_RUN: 'the latest observed run did not write this report',
  REPORT_CHANGED_SINCE_RUN: 'the report changed after the run',
  SOURCE_IDENTITY_UNKNOWN: 'the source could not be measured',
  SOURCE_CHANGED_SINCE_RUN: 'the source changed after the run',
  SOURCE_CHANGED_DURING_REPORT: 'the source changed while this report was made',
  REPORT_MISSING: 'there is no report at the configured path',
  REPORT_NOT_A_REGULAR_FILE: 'the report is a link or not an ordinary file',
  REPORT_LINKED_DIRECTORY: 'a directory on the way to the report is a link',
  REPORT_HARD_LINKED: 'the report has another hard link',
  REPORT_EMPTY: 'the report is empty',
  REPORT_TOO_LARGE: 'the report is over 4 MiB',
  REPORT_UNREADABLE: 'the report could not be read',
  REPORT_CHANGED_WHILE_READ: 'the report changed while it was read',
}

/** Shorter words beside a group's count, where the full words are a sentence (the review list keeps the full ones). */
const SHORT_WORDS: Partial<Record<LineReason, string>> = {
  GENERATED_ATTRIBUTE: 'generated (attribute)',
  GENERATED_MARKER: 'generated (marker)',
  NO_LINE_ENTRY: 'no line entry',
}

const WHAT_TO_DO: Partial<Record<BindingRefusal | 'REPORT_REJECTED', string>> = {
  RUN_NOT_OBSERVED: 'Run the tests in this session, from the repository root, to measure the current source.',
  REPORT_NOT_REFRESHED_BY_RUN: 'Run the tests with coverage written to the configured report path.',
  REPORT_CHANGED_SINCE_RUN: 'Run the tests again in this session to measure the current source.',
  SOURCE_CHANGED_SINCE_RUN: 'Run the tests again in this session to measure the current source.',
  SOURCE_CHANGED_DURING_REPORT: 'Ask for the report again when nothing is changing the files.',
  SOURCE_IDENTITY_UNKNOWN: 'Ask for the report again; if it stays unknown, the working tree cannot be measured here.',
  REPORT_MISSING: 'Check the coverageDiffReport path, or run the tests with coverage.',
  REPORT_TOO_LARGE: 'Reports over 4 MiB are not read.',
}

/** What to do about a refused report depends on why: a damaged one can be written again; one past a bound cannot be read at all. */
const PARSER_TO_DO: Record<LcovRefusal, string> = {
  REPORT_EMPTY: 'Run the tests with coverage written to the configured report path.',
  NO_RECORDS: 'Run the tests with coverage written to the configured report path.',
  REPORT_TOO_LARGE: 'Reports over 4 MiB are not read.',
  LINE_TOO_LONG: 'A report with a line over 8 KiB is not read (a report written with bare carriage returns reads as one line).',
  TOO_MANY_RECORDS: 'Reports with more than 50,000 records are not read.',
  TOO_MANY_DA: 'Reports with this many line entries are not read.',
  DEADLINE: 'Reports that take more than 2 s to read are not read.',
  NOT_UTF8: 'The report is not well-formed LCOV; run the tests again to write a new one.',
  MALFORMED: 'The report is not well-formed LCOV; run the tests again to write a new one.',
  BAD_DA: 'The report is not well-formed LCOV; run the tests again to write a new one.',
  BAD_SF: 'The report is not well-formed LCOV; run the tests again to write a new one.',
  UNTERMINATED_RECORD: 'The report ends inside a record (it may have been cut short); run the tests again to write a new one.',
  STRAY_END: 'The report is not well-formed LCOV; run the tests again to write a new one.',
}

const FILE_WORDS: Record<FileReason, string> = {
  CLASSIFIED: 'classified',
  DELETED: 'deleted',
  EMBEDDED_REPOSITORY: 'embedded repository',
  SUBMODULE: 'submodule',
  SYMLINK: 'link',
  MODE_ONLY: 'mode change only',
  BINARY_BY_ATTRIBUTE: 'Git treats this text file as binary (an attribute), so its changed lines are not shown',
  BINARY: 'binary',
  FILE_TYPE_OUT_OF_SCOPE: 'not JS/TS',
  CONFIGURED_EXCLUSION: 'excluded by coverageDiffExclude',
  GENERATED_ATTRIBUTE: 'generated: attribute',
  GENERATED_MARKER: 'generated: marker',
  LINE_TABLE_AMBIGUOUS: 'line numbering differs between Git and JavaScript',
  CHANGE_OUTSIDE_FILE: 'not classified: Git named changed lines this file\'s text does not have (it changed while read)',
  SOURCE_IS_LINK: 'not read: a link',
  SOURCE_NOT_A_REGULAR_FILE: 'not read: not an ordinary file',
  SOURCE_TOO_LARGE: 'not read: over 4 MiB',
  SOURCE_TOO_MANY_LINES: `not classified: over ${grouped(CLASSIFY_LIMITS.maxSourceLines)} lines`,
  SOURCE_UNREADABLE: 'not read: unreadable',
  SOURCE_GREW: 'not read: it changed while read',
  SOURCE_MISSING: 'not read: gone',
}

const PARSER_WORDS: Record<LcovRefusal, string> = {
  REPORT_EMPTY: 'it is empty',
  REPORT_TOO_LARGE: 'it is over 4 MiB',
  NO_RECORDS: 'it names no file',
  NOT_UTF8: 'it is not valid UTF-8',
  MALFORMED: 'a malformed line',
  BAD_DA: 'a malformed line entry',
  BAD_SF: 'a malformed file path',
  UNTERMINATED_RECORD: 'a record that does not end',
  STRAY_END: 'a record end with no record',
  LINE_TOO_LONG: 'a line over 8 KiB',
  TOO_MANY_RECORDS: 'over 50,000 records',
  TOO_MANY_DA: 'too many line entries',
  DEADLINE: 'it took over 2 s to read',
}

const RECORD_WORDS: Record<SfRefusal, string> = {
  SF_URL_NOT_LOCAL: 'a URL of another host',
  SF_URL_ENCODED_SEPARATOR: 'an encoded separator',
  SF_URL_MALFORMED: 'a malformed URL',
  SF_WINDOWS_PATH: 'a Windows or network path',
  SF_SCHEME: 'a URL scheme',
  SF_BACKSLASH: 'a backslash',
  SF_CONTROL_CHARACTER: 'a control character',
  SF_OUTSIDE_REPOSITORY: 'outside the repository',
  SF_IN_GIT_DIRECTORY: 'inside .git',
}

const UNAVAILABLE_WORDS: Record<ReportUnavailable, string> = {
  LAYER_OFF: 'the coverage layer is off',
  REPORT_PATH_UNSET: 'no report path is configured (coverageDiffReport)',
  REPORT_PATH_REFUSED: 'the configured report path is not a plain repository-relative path',
  EXCLUDE_REFUSED: 'coverageDiffExclude holds an entry that is not a plain repository-relative prefix',
  MEMORY_LIMIT_NOT_ENFORCED: 'this platform does not enforce the memory limit measurement needs',
  PLATFORM_UNSUPPORTED: 'this platform is not supported yet',
  NOT_A_VERIFIED_ROOT: 'the session is not in a verified Git repository',
  PATH_UNSAFE: 'PATH has an entry that is relative or inside the repository',
  GIT_TOO_OLD: 'Git is older than 2.32',
  PATH_NOT_UTF8: 'a file name is not valid UTF-8',
  FILTER_CONFIGURED: 'the repository configures a filter program',
  PARTIAL_CLONE: 'the repository is a partial clone',
  ATTRIBUTES_UNREADABLE: 'attributes could not be read',
  CONFIG_UNREADABLE: 'the repository configuration could not be read',
  BASE_NOT_HEX: 'give a commit id of 12 to 64 hex digits',
  BASE_UNRESOLVED: 'no such commit here',
  BASE_AMBIGUOUS: 'a branch has that name: give the full id',
  DIFF_FAILED: 'Git could not produce the change',
  DIFF_TIMEOUT: 'Git took too long',
  DIFF_TOO_LARGE: 'the change is too large to report',
  DIFF_MALFORMED: 'Git output could not be read',
  DIFF_INCONSISTENT: 'Git listings disagree',
  TOO_MANY_FILES: `over ${grouped(CLASSIFY_LIMITS.maxFiles)} changed paths`,
  TOO_MANY_LINES: `over ${grouped(CLASSIFY_LIMITS.maxChangedLines)} changed lines`,
  TOO_MUCH_CHANGED: 'over 64 MiB of changed files to read',
}

const NOTE_WORDS: Record<BindingNote, string> = {
  BYTES_UNCHANGED_BY_RUN: 'The run left the report\'s bytes as they were although the source changed since they were written: a rerun that measured the same counts, or a command that only touched the file.',
  BYTES_OF_ANOTHER_SOURCE: 'These bytes are identical to an earlier observed measurement of a different source: a rerun that measured the same counts, or a copy.',
}

const REVIEW_NOTE_WORDS: Record<ReviewNote['note'], string> = {
  IGNORE_COMMENT_ADDED: 'coverage-ignore comment added',
  BINARY_BY_ATTRIBUTE: FILE_WORDS.BINARY_BY_ATTRIBUTE,
  GENERATED_BY_MARKER: 'a generated-file marker on this line excludes every changed line of the file',
  GENERATED_BY_ATTRIBUTE: 'a generated attribute excludes every changed line of the file',
}

/** Every code's words, for a test that no reason is ever shown without them (W5). */
export const wordsOf = (code: string): string | undefined =>
  (LINE_WORDS as Record<string, string>)[code] ?? (FILE_WORDS as Record<string, string>)[code] ?? (UNAVAILABLE_WORDS as Record<string, string>)[code] ?? (RECORD_WORDS as Record<string, string>)[code] ?? (REVIEW_NOTE_WORDS as Record<string, string>)[code]

// --- Rendering. Counts, never percentages: a percentage invites a threshold, and a threshold is a gate.

/** 50 columns, the narrowest width rendered. */
export const TITLE = 'COBALT / COVERAGE DIFF  advisory: approves nothing'
/** The closing sentences, word for word in every state; each is one line from 76 columns, wrapped below that. */
export const CLOSING = ['ADVISORY ONLY. Execution coverage does not prove assertions or correctness.', 'Nothing here changes a gate, DONE, a review or a release.'] as const
export const PAGE_SIZE = 20
/** Ranges listed per review entry; the rest are counted. */
export const MAX_RANGES = 40
/** File rows whose changed lines exist but could not be classified. */
const NOT_COUNTED = new Set<FileReason>(['BINARY_BY_ATTRIBUTE', 'CHANGE_OUTSIDE_FILE', 'SOURCE_IS_LINK', 'SOURCE_NOT_A_REGULAR_FILE', 'SOURCE_TOO_LARGE', 'SOURCE_TOO_MANY_LINES', 'SOURCE_UNREADABLE', 'SOURCE_GREW', 'SOURCE_MISSING'])
const LABEL = 12

const width = (text: string) => Array.from(text).length
/** A width the report can be drawn at: 50 to 120, and 80 for anything that is not a finite number (no width, NaN). */
const columnsOf = (columns: number): number => Math.min(120, Math.max(50, Number.isFinite(columns) ? Math.floor(columns) : 80))

/**
 * Words wrapped to `limit` code points, the first line after `first`, the rest after `rest`. A word longer than a
 * line is cut; a first prefix too wide to hold a word stands alone. No line is ever wider than `limit`, and every
 * pass takes at least one code point, so it always ends.
 */
const wrap = (text: string, given: number, first: string, rest: string): string[] => {
  const limit = columnsOf(given)
  const out: string[] = []
  let line = first
  let empty = true
  const flush = () => { out.push(line); line = rest; empty = true }
  for (const whole of text.split(' ').filter(Boolean)) {
    let word = whole
    while (word !== '') {
      const gap = empty ? 0 : 1
      if (width(line) + gap + width(word) <= limit) { line += (empty ? '' : ' ') + word; empty = false; break }
      if (!empty) { flush(); continue }
      const room = limit - width(line)
      if (room < 8 && line !== rest) { flush(); continue }
      // a word longer than a line: split once into code points and taken by index, so a long word costs its length
      const points = Array.from(word)
      let at = 0
      let take = Math.max(1, room)
      while (points.length - at > take) {
        line += points.slice(at, at + take).join('')
        at += take
        empty = false
        flush()
        take = Math.max(1, limit - width(rest))
      }
      word = points.slice(at).join('')
    }
  }
  if (!empty || out.length === 0) out.push(line)

  return out
}

/** A path (or any text that must be shown exactly) cut into lines of at most `limit`, never split at its spaces. */
const cut = (text: string, given: number, first: string, rest: string): string[] => {
  const limit = columnsOf(given)
  const out: string[] = []
  // taken by index from one array of code points: linear in the text, however many lines it fills
  const points = Array.from(text)
  let at = 0
  let prefix = first
  do {
    const room = Math.max(1, limit - width(prefix))
    out.push(prefix + points.slice(at, at + room).join(''))
    at += room
    prefix = rest
  } while (at < points.length)

  return out
}

const field = (name: string) => `${name}:`.padEnd(LABEL)
const pad = ' '.repeat(LABEL)
/** A record's time in words; any value outside the window a record may hold reads as unknown, and nothing here can throw. */
const timeOf = (at: number): string => isRecordTime(at) ? `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time'

/** The report in words, `columns` wide (50 to 120), one page of the review list and the file rows. */
export const renderDiffEvidence = (view: DiffEvidence, columns: number, page = 1): string => {
  const limit = columnsOf(columns)
  const out: string[] = [TITLE, '']
  const say = (name: string, text: string) => out.push(...wrap(text, limit, field(name), pad))
  if (view.state === 'UNAVAILABLE') {
    say('Coverage', `UNAVAILABLE: ${UNAVAILABLE_WORDS[view.why ?? 'DIFF_FAILED']}.`)
    out.push('', ...closing(limit))

    return out.join('\n')
  }
  // every value in the header is escaped too: the contract's producer is meant to give hex and closed labels, and a
  // value that is not cannot add a line of its own
  const shown = (text: string, max = 64) => displayText(text, max)
  say('Source', `working tree on ${shown(view.source.head.slice(0, 12))} (HEAD), ${view.source.tracked} tracked changed, ${view.source.untracked} untracked`)
  if (view.source.identity !== null) out.push(...cut(`identity ${shown(view.source.identity.slice(0, 16))}`, limit, pad, pad))
  say('Diff base', `${shown(view.base.sha)} (${view.base.how === 'task-start' ? 'task start' : `given as ${shown(view.base.given ?? view.base.sha)}`})${view.base.ancestor ? '' : ', not an ancestor of HEAD'}`)
  const matched = view.evidence.state === 'MATCHED'
  if (view.coverage === null) say('Coverage', 'no report path configured')
  else {
    out.push(...cut(displayText(view.coverage.path, limit - LABEL), limit, field('Coverage'), pad))
    if (view.coverage.sha256 !== null) out.push(...cut(`sha256:${shown(view.coverage.sha256.slice(0, 16))}`, limit, pad, pad))
    const run = view.coverage.run
    if (run !== null) out.push(...wrap(`${matched ? 'changed during an observed run' : 'last observed run'} at ${timeOf(run.at)}: ${shown(run.label)} (ok)`, limit, pad, pad))
  }
  if (matched) {
    say('Evidence', 'MATCHED: the report changed during an observed test run on this source.')
    out.push(...wrap('Repository code wrote it; Cockpit checked when and on what source, not what it claims.', limit, pad, pad))
    for (const note of view.evidence.notes) out.push(...wrap(`Note: ${NOTE_WORDS[note]}`, limit, pad, pad))
  } else {
    const why = view.evidence.why ?? 'RUN_NOT_OBSERVED'
    const parser = view.evidence.parser
    say('Evidence', `NOT USED: ${why === 'REPORT_REJECTED' && parser !== undefined ? `the report was refused (${PARSER_WORDS[parser.code]}, line ${parser.line})` : LINE_WORDS[why]}`)
    const todo = why === 'REPORT_REJECTED' && parser !== undefined ? PARSER_TO_DO[parser.code] : WHAT_TO_DO[why]
    if (todo !== undefined) out.push(...wrap(todo, limit, pad, pad))
  }
  out.push('')
  say('Changed', `${view.lines.added} added, ${view.lines.modified} modified, ${view.lines.deleted} deleted (deleted lines have nothing to measure)`)
  // a file whose changed lines could not be classified is counted nowhere above: say so here, not only in its row
  const unread = view.files.filter(f => NOT_COUNTED.has(f.reason)).length
  if (unread > 0) say('Uncounted', `${unread} ${unread === 1 ? 'file' : 'files'} whose changed lines could not be classified (see Files)`)
  out.push('')

  // the four groups, each count with its reasons in words; the label and the count take the first 34 columns
  const reasons = (codes: readonly LineReason[]) => codes.filter(code => (view.byReason[code] ?? 0) > 0).map(code => `${SHORT_WORDS[code] ?? LINE_WORDS[code]} ${view.byReason[code]}`).join(' · ') || 'none'
  const group = (name: string, count: number, text: string) => out.push(...wrap(text, limit, `${name.padEnd(27)}${String(count).padStart(5)}  `, ' '.repeat(34)))
  const c = view.counts
  group('COVERED', c.covered, 'changed lines the coverage tool reported as run')
  group('UNCOVERED', c.uncovered, 'changed lines the coverage tool reported as not run')
  group('EXCLUDED / NON-EXECUTABLE', c.excluded + c.nonExecutable, reasons(['FILE_TYPE_OUT_OF_SCOPE', 'CONFIGURED_EXCLUSION', 'GENERATED_ATTRIBUTE', 'GENERATED_MARKER', 'BLANK_LINE']))
  group('UNAVAILABLE / UNTRUSTED', c.unavailable + c.untrusted, reasons((Object.keys(LINE_WORDS) as LineReason[]).filter(code => !['REPORTED_RUN', 'REPORTED_NOT_RUN', 'FILE_TYPE_OUT_OF_SCOPE', 'CONFIGURED_EXCLUSION', 'GENERATED_ATTRIBUTE', 'GENERATED_MARKER', 'BLANK_LINE'].includes(code))))

  // the two lists are paged together, each with its own count of pages; a page past the end of one says so
  const pagesOf = (n: number) => Math.max(1, Math.ceil(n / PAGE_SIZE))
  const at = Math.min(Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1), Math.max(pagesOf(view.review.length), pagesOf(view.files.length)))
  const slice = <T>(list: readonly T[]) => list.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE)
  const header = (name: string, n: number, one: string, many: string) => at <= pagesOf(n) ? `${name}: ${n} ${n === 1 ? one : many}, page ${at} of ${pagesOf(n)}` : `${name}: ${n} ${n === 1 ? one : many}, all on page${pagesOf(n) === 1 ? ' 1' : `s 1 to ${pagesOf(n)}`}; none on page ${at}`
  if (view.review.length > 0) {
    out.push('', ...wrap(header('REVIEW REQUIRED', view.review.length, 'entry', 'entries'), limit, '', '  '))
    for (const r of slice(view.review)) {
      // at most MAX_RANGES ranges per entry, and how many more there are: a change of every other line in a long file
      // would otherwise fill thousands of lines (the data contract keeps them all)
      const more = r.ranges.length - MAX_RANGES
      const ranges = r.ranges.slice(0, MAX_RANGES).join(',')
      const where = ranges === '' ? '' : `:${ranges}`
      out.push(...cut(`${displayText(r.path, Math.max(8, limit - 2 - Math.min(width(where), Math.floor(limit / 2))))}${where}`, limit, '  ', '    '))
      const words = r.category === 'NOTE' ? REVIEW_NOTE_WORDS[r.reason as ReviewNote['note']] : wordsOf(String(r.reason)) ?? String(r.reason)
      out.push(...wrap(more > 0 ? `${words} (and ${grouped(more)} more ${more === 1 ? 'range' : 'ranges'} of lines)` : words, limit, `    ${r.category.padEnd(12)}`, ' '.repeat(16)))
    }
  }
  out.push('', ...wrap(header('Files', view.files.length, 'file', 'files'), limit, '', '  '))
  for (const f of slice(view.files)) {
    const words = f.reason === 'GENERATED_MARKER' ? `generated: marker on line ${f.generatedLine ?? 1}` : FILE_WORDS[f.reason]
    out.push(...cut(displayText(f.path, limit - 4), limit, '  ', '    '), ...wrap(words, limit, '    ', '    '))
  }
  const refused = Object.entries(view.refusedRecords) as [SfRefusal, number][]
  if (refused.length > 0) out.push(...wrap(`Records not used: ${refused.map(([code, n]) => `${RECORD_WORDS[code]} ${n}`).join(' · ')}`, limit, '', '  '))
  if (view.toolListsNonExecutable) out.push(...wrap('Note: the tool lists lines that cannot execute (a blank changed line has an entry), so comments and declarations may appear as run.', limit, '', '      '))
  if (matched) out.push(...wrap('Line attribution, including any source mapping, is the coverage tool\'s.', limit, '', ''))
  out.push('', ...closing(limit))

  return out.join('\n')
}

/** The one line shown while the layer is off, with the closing lines (W1 holds in every state). */
export const renderOff = (columns = 80): string => {
  const limit = columnsOf(columns)

  return [TITLE, '', ...wrap('The coverage layer is off. A person turns it on with coverageDiff in /config.', limit, '', ''), '', ...closing(limit)].join('\n')
}

/** The closing sentences at a width. */
const closing = (limit: number): string[] => CLOSING.flatMap(sentence => wrap(sentence, limit, '', ''))
