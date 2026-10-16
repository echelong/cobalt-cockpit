// Diff coverage (v0.7.0, Phase 1: not registered, nothing calls it yet). A coverage report is written by a command the
// repository controls, so every byte of it is untrusted: its size, its records, its numbers and above all its paths.
// This module reads it so that a hostile or damaged report can do no more than be refused whole, or leave some changed
// lines without evidence. It never opens, stats or resolves a path the report names (see diffcov-paths.ts), keeps only
// the changed lines it is asked about, and bounds time, memory, records and entries. A bound reached refuses the report;
// nothing returns a partial result, because a truncated record would turn lines that did not run into lines with no entry.
//
// The bytes come from the caller. `reportReadVerdict` states what the reader must have established first: an ordinary
// file, not reached through a link, read whole at the size its stat gave, unchanged by the read.

import type { SfMatch, SfRefusal } from './diffcov-paths'
import { utf8Length } from './diffcov-paths'

/**
 * The bounds. 4 MiB is the most `$.fs.read` returns (measured on Claude Code 2.1.301; anything larger is refused before
 * a byte is read), so the report cap is the host's own; the rest follow the archived design's measurements.
 */
export const LCOV_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  /** One physical line: a 4 KiB path and its tag. A report written with bare carriage returns becomes one long line. */
  maxLineBytes: 8 * 1024,
  maxPathBytes: 4096,
  maxRecords: 50_000,
  maxEntriesPerRecord: 1_000_000,
  /** A backstop only: the byte cap allows about 600,000 entries (7 bytes per `DA` line). */
  maxEntries: 8_000_000,
  maxLineNumber: 10_000_000,
  deadlineMs: 2_000,
  /** The parser hands the event loop back this often (the host has no `queueMicrotask`; the caller decides how to wait). */
  pauseEveryBytes: 1024 * 1024,
  checkEveryLines: 65_536,
})
export type LcovLimits = { readonly [K in keyof typeof LCOV_LIMITS]: number }

/** Why a whole report was refused. */
export type LcovRefusal =
  | 'REPORT_EMPTY'
  | 'REPORT_TOO_LARGE'
  | 'NO_RECORDS'
  | 'NOT_UTF8'
  | 'MALFORMED'
  | 'BAD_DA'
  | 'BAD_SF'
  | 'UNTERMINATED_RECORD'
  | 'STRAY_END'
  | 'LINE_TOO_LONG'
  | 'TOO_MANY_RECORDS'
  | 'TOO_MANY_DA'
  | 'DEADLINE'

/** What the report says about one changed path: its changed lines only, each run (true) or not run (false). */
export type FileEvidence = {
  /** The `SF:` text that first named the path (shown escaped, if ever). */
  spelling: string
  lines: Map<number, boolean>
  /** The highest line number any of its records gave, kept as a running maximum (never a spread over the lines). */
  maxLine: number
  /** Line entries across its records, changed or not. */
  entries: number
  records: number
  /** Records that name the path two ways, or only by different letter case: its lines are UNTRUSTED. */
  conflict: 'SF_CONFLICTING_IDENTITY' | 'SF_CASE_MISMATCH' | null
}

export type ParsedLcov = {
  ok: true
  files: Map<string, FileEvidence>
  /** Records refused by their path, counted by reason. */
  refused: Partial<Record<SfRefusal, number>>
  /** Records for files that did not change (or that the change does not name). */
  unmatched: number
  stats: { records: number; entries: number; keptLines: number; unknownTags: number; comments: number; totalsDisagree: number }
}
export type LcovRejection = { ok: false; code: LcovRefusal; line: number; detail: string }

/** The parser's clock and its way of giving the host's event loop a turn. Injected: this module touches no host API. */
export type ParseClock = { now: () => number; pause: () => Promise<void> }

const KNOWN = new Set(['TN', 'SF', 'VER', 'FN', 'FNDA', 'FNF', 'FNH', 'FNL', 'FNA', 'DA', 'LF', 'LH', 'BRDA', 'BRF', 'BRH', 'MCDC', 'MCF', 'MCH'])
const UINT = /^(?:0|[1-9][0-9]{0,19})$/
const LINENO = /^[1-9][0-9]{0,8}$/
const TAG = /^[A-Z][A-Z0-9_]{0,15}$/
// any control character but tab, inside a decoded line, is damage (a report with bare carriage returns would otherwise
// read as one `TN:` line and be accepted empty: measured)
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/
// a decoder the host declares; it is only ever given bytes `isUtf8` accepted and that hold no byte-order mark, so it
// can neither replace nor drop anything (the host's decoder drops a leading mark even when asked not to: measured)
const DECODER = new TextDecoder('utf-8')

/** Strict UTF-8 over bytes[from, to): no overlong form, no surrogate, nothing above U+10FFFF, no cut sequence. */
export const isUtf8 = (bytes: Uint8Array, from: number, to: number): boolean => {
  let i = from
  while (i < to) {
    const b = bytes[i]!
    if (b < 0x80) { i++; continue }
    let need: number, code: number, min: number
    if (b >= 0xc2 && b <= 0xdf) { need = 1; code = b & 0x1f; min = 0x80 }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; code = b & 0x0f; min = 0x800 }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; code = b & 0x07; min = 0x10000 }
    else return false
    if (i + need >= to) return false
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k]!
      if ((c & 0xc0) !== 0x80) return false
      code = (code << 6) | (c & 0x3f)
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false
    i += need + 1
  }

  return true
}

const reject = (code: LcovRefusal, detail: string, line: number): LcovRejection => ({ ok: false, code, detail, line })

/** The line a byte offset lies on (1-based), for a refusal found before the line-by-line pass. */
const lineAt = (bytes: Uint8Array, offset: number): number => {
  let line = 1
  for (let k = bytes.indexOf(0x0a); k !== -1 && k < offset; k = bytes.indexOf(0x0a, k + 1)) line++

  return line
}

/** Where a byte-order mark appears after the first three bytes, or -1. It is allowed at the very start only. */
const misplacedMark = (bytes: Uint8Array, from: number): number => {
  for (let k = bytes.indexOf(0xef, from); k !== -1; k = bytes.indexOf(0xef, k + 1)) if (bytes[k + 1] === 0xbb && bytes[k + 2] === 0xbf) return k

  return -1
}

/** The record being read: the changed path it speaks for (if any) and the lines of that path it may speak for. */
type OpenRecord = { file: FileEvidence | null; wanted: ReadonlySet<number> | null; entries: number; hit: number; lf: number | null; lh: number | null }

/**
 * Parses a report, keeping for each changed path that `match` names only the lines it wants. Rejects the whole report
 * on any damage or bound; see LcovRefusal. `match` is diffcov-paths' `sfMatcher`, and is given each `SF:` value once.
 */
export const parseLcov = async (bytes: Uint8Array, match: (sf: string) => SfMatch, clock: ParseClock, limits: LcovLimits = LCOV_LIMITS): Promise<ParsedLcov | LcovRejection> => {
  const started = clock.now()
  if (bytes.length === 0) return reject('REPORT_EMPTY', 'the report has no bytes', 0)
  if (bytes.length > limits.maxBytes) return reject('REPORT_TOO_LARGE', `over ${limits.maxBytes} bytes`, 0)
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  const mark = misplacedMark(bytes, start)
  if (mark !== -1) return reject('MALFORMED', 'a byte-order mark after the start of the report', lineAt(bytes, mark))

  const files = new Map<string, FileEvidence>()
  const refused: Partial<Record<SfRefusal, number>> = {}
  const stats = { records: 0, entries: 0, keptLines: 0, unknownTags: 0, comments: 0, totalsDisagree: 0 }
  let unmatched = 0
  let current: OpenRecord | null = null
  let lineNo = 0
  let nextPause = start + limits.pauseEveryBytes
  const n = bytes.length
  let i = start

  while (i < n) {
    let j = bytes.indexOf(0x0a, i)
    if (j === -1) j = n
    lineNo++
    let end = j
    if (end > i && bytes[end - 1] === 0x0d) end--
    const length = end - i
    if (length > limits.maxLineBytes) return reject('LINE_TOO_LONG', `a line over ${limits.maxLineBytes} bytes`, lineNo)
    if (i >= nextPause || lineNo % limits.checkEveryLines === 0) {
      if (i >= nextPause) {
        nextPause = i + limits.pauseEveryBytes
        await clock.pause()
      }
      if (clock.now() - started > limits.deadlineMs) return reject('DEADLINE', `over ${limits.deadlineMs} ms`, lineNo)
    }
    if (length === 0) { i = j + 1; continue }

    // DA:<line>,<count>[,<checksum>] in ASCII, read from the bytes: most of a report, and never decoded
    if (current !== null && length > 3 && bytes[i] === 0x44 && bytes[i + 1] === 0x41 && bytes[i + 2] === 0x3a) {
      let k = i + 3
      if (bytes[k] === 0x30) return reject('BAD_DA', 'line number 0 or a leading zero', lineNo)
      let line = 0, digits = 0
      while (k < end && bytes[k]! >= 0x30 && bytes[k]! <= 0x39 && digits <= 9) { line = line * 10 + (bytes[k]! - 0x30); k++; digits++ }
      if (digits === 0 || digits > 9 || bytes[k] !== 0x2c) return reject('BAD_DA', 'a malformed line number', lineNo)
      if (line > limits.maxLineNumber) return reject('BAD_DA', `a line number over ${limits.maxLineNumber}`, lineNo)
      k++
      const countStart = k
      let positive = false
      while (k < end && bytes[k]! >= 0x30 && bytes[k]! <= 0x39) { if (bytes[k] !== 0x30) positive = true; k++ }
      const countLength = k - countStart
      if (countLength === 0 || countLength > 20 || (countLength > 1 && bytes[countStart] === 0x30)) return reject('BAD_DA', 'a malformed count', lineNo)
      if (k < end) {
        if (bytes[k] !== 0x2c) return reject('BAD_DA', 'bytes after the count', lineNo)
        for (let m = k + 1; m < end; m++) {
          const c = bytes[m]!
          const isChecksum = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2b || c === 0x2f || c === 0x3d
          if (!isChecksum) return reject('BAD_DA', 'a checksum with other bytes', lineNo)
        }
      }
      stats.entries++
      current.entries++
      if (stats.entries > limits.maxEntries) return reject('TOO_MANY_DA', `over ${limits.maxEntries} line entries`, lineNo)
      if (current.entries > limits.maxEntriesPerRecord) return reject('TOO_MANY_DA', `a record over ${limits.maxEntriesPerRecord} line entries`, lineNo)
      if (positive) current.hit++
      const file = current.file
      if (file !== null && file.conflict === null) {
        if (line > file.maxLine) file.maxLine = line
        file.entries++
        // only the changed lines are kept, merged across records: memory follows the change, not the report
        if (current.wanted !== null && current.wanted.has(line)) file.lines.set(line, file.lines.get(line) === true || positive)
      }
      i = j + 1
      continue
    }

    if (!isUtf8(bytes, i, end)) return reject('NOT_UTF8', 'invalid UTF-8', lineNo)
    const text = DECODER.decode(bytes.subarray(i, end))
    i = j + 1
    if (CONTROL.test(text)) return reject('MALFORMED', 'a control character inside a line', lineNo)
    if (text.charCodeAt(0) === 0x23) { stats.comments++; continue }
    if (text === 'end_of_record') {
      if (current === null) return reject('STRAY_END', 'end_of_record outside a record', lineNo)
      // LF and LH are a diagnostic only: Node counts the lines its ignore comments removed (measured)
      if ((current.lf !== null && current.lf !== current.entries) || (current.lh !== null && current.lh !== current.hit)) stats.totalsDisagree++
      current = null
      continue
    }
    const colon = text.indexOf(':')
    if (colon <= 0) return reject('MALFORMED', 'a line with no record tag', lineNo)
    const tag = text.slice(0, colon)
    const value = text.slice(colon + 1)
    if (!TAG.test(tag)) return reject('MALFORMED', 'a malformed record tag', lineNo)
    if (!KNOWN.has(tag)) { stats.unknownTags++; continue }
    if (tag === 'TN') {
      if (current !== null) return reject('MALFORMED', 'TN inside a record', lineNo)
      continue
    }
    if (tag === 'SF') {
      if (current !== null) return reject('UNTERMINATED_RECORD', 'SF before end_of_record', lineNo)
      if (value.length === 0) return reject('BAD_SF', 'an empty path', lineNo)
      if (utf8Length(value) > limits.maxPathBytes) return reject('BAD_SF', `a path over ${limits.maxPathBytes} bytes`, lineNo)
      if (++stats.records > limits.maxRecords) return reject('TOO_MANY_RECORDS', `over ${limits.maxRecords} records`, lineNo)
      current = { file: null, wanted: null, entries: 0, hit: 0, lf: null, lh: null }
      const found = match(value)
      if (found === null) { unmatched++; continue }
      if ('refuse' in found) { refused[found.refuse] = (refused[found.refuse] ?? 0) + 1; continue }
      if ('caseOf' in found) {
        for (const key of found.caseOf) {
          const file = files.get(key) ?? newFile(value)
          file.conflict = 'SF_CASE_MISMATCH'
          file.lines.clear()
          files.set(key, file)
        }
        continue
      }
      let file = files.get(found.key)
      if (file === undefined) {
        file = newFile(value)
        files.set(found.key, file)
      } else if (file.conflict === null && file.spelling !== value) {
        file.conflict = 'SF_CONFLICTING_IDENTITY'
        file.lines.clear()
      }
      file.records++
      current.file = file
      current.wanted = found.wanted
      continue
    }
    if (current === null) {
      if (tag === 'VER') continue
      return reject('MALFORMED', `${tag} outside a record`, lineNo)
    }
    if (tag === 'DA') return reject('BAD_DA', 'a malformed DA line', lineNo)
    if (tag === 'LF' || tag === 'LH') {
      if (!UINT.test(value)) return reject('MALFORMED', `${tag} is not a count`, lineNo)
      const key = tag === 'LF' ? 'lf' : 'lh'
      if (current[key] !== null) return reject('MALFORMED', `${tag} twice in a record`, lineNo)
      current[key] = Number(value)
      continue
    }
    if (tag === 'MCDC' || tag === 'VER') continue
    if (tag === 'FNF' || tag === 'FNH' || tag === 'BRF' || tag === 'BRH' || tag === 'MCF' || tag === 'MCH') {
      if (!UINT.test(value)) return reject('MALFORMED', `${tag} is not a count`, lineNo)
      continue
    }
    const parts = value.split(',')
    if (tag === 'BRDA') {
      if (parts.length < 4 || !LINENO.test(parts[0]!) || !(UINT.test(parts[parts.length - 1]!) || parts[parts.length - 1] === '-')) return reject('MALFORMED', 'a malformed BRDA line', lineNo)
      continue
    }
    if (tag === 'FN') {
      if (parts.length < 2 || !LINENO.test(parts[0]!)) return reject('MALFORMED', 'a malformed FN line', lineNo)
      continue
    }
    if (tag === 'FNL') {
      // lcov 2.2: FNL:<index>,<start>[,<end>], and the index may be 0
      if (parts.length < 2 || parts.length > 3 || !UINT.test(parts[0]!) || !LINENO.test(parts[1]!) || (parts.length === 3 && !LINENO.test(parts[2]!))) return reject('MALFORMED', 'a malformed FNL line', lineNo)
      continue
    }
    // FNDA and FNA
    if (parts.length < 2 || !UINT.test(parts[0]!)) return reject('MALFORMED', `a malformed ${tag} line`, lineNo)
  }
  if (current !== null) return reject('UNTERMINATED_RECORD', 'the report ends inside a record', lineNo)
  if (stats.records === 0) return reject('NO_RECORDS', 'the report names no file', lineNo)
  for (const file of files.values()) stats.keptLines += file.lines.size

  return { ok: true, files, refused, unmatched, stats }
}

const newFile = (spelling: string): FileEvidence => ({ spelling, lines: new Map(), maxLine: 0, entries: 0, records: 0, conflict: null })

/**
 * What a no-follow `stat` said about one path (the reader's GNU `%f %s %h %i %.9Y %.9Z` or BSD equivalent, in Phase 2):
 * its kind, size, hard-link count and an identity that moves when the file is replaced or rewritten.
 */
export type ReportStat = { kind: 'file' | 'link' | 'dir' | 'fifo' | 'socket' | 'char' | 'block' | 'missing'; size: number; links: number; identity: string }

/** Why a report could not be read safely. Shown in words; nothing about its content is known. */
export type ReportReadRefusal =
  | 'REPORT_MISSING'
  | 'REPORT_NOT_A_REGULAR_FILE'
  | 'REPORT_LINKED_DIRECTORY'
  | 'REPORT_HARD_LINKED'
  | 'REPORT_EMPTY'
  | 'REPORT_TOO_LARGE'
  | 'REPORT_UNREADABLE'
  | 'REPORT_CHANGED_WHILE_READ'

/**
 * Whether the bytes a reader got may be parsed. Before the read: every parent directory a directory (no link on the
 * way), the report itself an ordinary file (a link, FIFO, socket or device is refused, never followed: `$.fs.read`
 * follows links, returns nothing for a FIFO and reads a size-0 `/proc` file whole, all measured), with exactly one hard
 * link, not empty, at most the cap. After it: exactly as many bytes as that stat gave, and the same stat again, parents
 * included. Anything else is a refusal; there is no partial or repaired read.
 */
export const reportReadVerdict = (
  before: { report: ReportStat; parents: readonly ReportStat[] },
  read: { bytes: number } | { failed: true },
  after: { report: ReportStat; parents: readonly ReportStat[] },
  maxBytes: number = LCOV_LIMITS.maxBytes,
): { ok: true } | { refuse: ReportReadRefusal } => {
  const { report } = before
  if (before.parents.some(p => p.kind !== 'dir')) return { refuse: 'REPORT_LINKED_DIRECTORY' }
  if (report.kind === 'missing') return { refuse: 'REPORT_MISSING' }
  if (report.kind !== 'file') return { refuse: 'REPORT_NOT_A_REGULAR_FILE' }
  if (report.links !== 1) return { refuse: 'REPORT_HARD_LINKED' }
  if (report.size === 0) return { refuse: 'REPORT_EMPTY' }
  if (report.size > maxBytes) return { refuse: 'REPORT_TOO_LARGE' }
  if ('failed' in read) return { refuse: 'REPORT_UNREADABLE' }
  const same = (a: ReportStat, b: ReportStat) => a.kind === b.kind && a.size === b.size && a.links === b.links && a.identity === b.identity
  if (read.bytes !== report.size || !same(report, after.report) || after.parents.length !== before.parents.length || before.parents.some((p, k) => !same(p, after.parents[k]!))) return { refuse: 'REPORT_CHANGED_WHILE_READ' }

  return { ok: true }
}
