import { describe, expect, test } from 'claude-code/testing'
import { LCOV_LIMITS, isUtf8, parseLcov, reportReadVerdict } from '../hooks/diffcov-lcov'
import type { LcovLimits, ParsedLcov, ReportStat } from '../hooks/diffcov-lcov'
import { sfMatcher } from '../hooks/diffcov-paths'
import type { SfMatch } from '../hooks/diffcov-paths'
import { C8, JEST_BABEL, JEST_V8, NODE22, NODE22_PHASE0, VITEST_ISTANBUL, VITEST_V8 } from './diffcov-fixtures'

// Diff coverage, Phase 1: the LCOV parser. Every case here runs in the host's own runtime (no Buffer, no process), on
// the archived negative-test matrix (N1 to N15) with the bounds revised for the host's 4 MiB read limit.

const encode = (text: string) => new TextEncoder().encode(text)
const clock = (step = 0) => {
  let at = 0, pauses = 0
  return { now: () => (at += step), pause: async () => { pauses++ }, paused: () => pauses }
}
const lines100 = new Set(Array.from({ length: 100 }, (_, k) => k + 1))
const everything = (sf: string): SfMatch => ({ key: sf, wanted: lines100 })
const parse = (input: string | Uint8Array, match: (sf: string) => SfMatch = everything, limits?: LcovLimits) =>
  parseLcov(typeof input === 'string' ? encode(input) : input, match, clock(), limits)
const outcome = async (input: string | Uint8Array, limits?: LcovLimits): Promise<string> => {
  const r = await parse(input, everything, limits)

  return r.ok ? 'ACCEPTED' : r.code
}
const accepted = async (input: string | Uint8Array, match?: (sf: string) => SfMatch): Promise<ParsedLcov> => {
  const r = await parse(input, match)
  if (!r.ok) throw new Error(`refused: ${r.code} at ${r.line}: ${r.detail}`)

  return r
}
const record = (body: string, sf = 'src/a.ts') => `TN:\nSF:${sf}\n${body}end_of_record\n`
const cases = async (rows: readonly (readonly [string, string | Uint8Array, string])[]) => {
  for (const [name, input, want] of rows) expect([name, await outcome(input)]).toEqual([name, want])
}

describe('well-formed reports are accepted (N1, N2)', () => {
  test('every record form the tools write', () => cases([
    ['plain', record('DA:1,1\nDA:2,0\n'), 'ACCEPTED'],
    ['a byte-order mark at the very start', new Uint8Array([0xef, 0xbb, 0xbf, ...encode(record('DA:1,1\n'))]), 'ACCEPTED'],
    ['CRLF line ends', record('DA:1,1\n').replace(/\n/g, '\r\n'), 'ACCEPTED'],
    ['lcov 2 comments', `# lcov 2\n${record('DA:1,1\n')}`, 'ACCEPTED'],
    ['an unknown upper-case tag', record('ZZZ:anything\nDA:1,1\n'), 'ACCEPTED'],
    ['DA with a checksum', record('DA:1,1,abc+/=\n'), 'ACCEPTED'],
    ['a 20-digit count', record(`DA:1,${'9'.repeat(20)}\n`), 'ACCEPTED'],
    ['BRDA with a branch never reached', record('BRDA:1,0,0,-\nBRDA:1,0,1,3\nBRF:2\nBRH:1\nDA:1,1\n'), 'ACCEPTED'],
    ['lcov 2.2 FNL/FNA, index 0', record('FNL:0,1,3\nFNA:0,1,f\nFN:1,f\nFNDA:1,f\nFNF:1\nFNH:1\nDA:1,1\n'), 'ACCEPTED'],
    ['MCDC and VER', `VER:2.2\n${record('MCDC:1,0,t,1,1,x\nMCF:1\nMCH:0\nVER:x\nDA:1,1\n')}`, 'ACCEPTED'],
    ['empty lines between records', `\n\n${record('DA:1,1\n')}\n\n${record('DA:2,1\n', 'src/b.ts')}`, 'ACCEPTED'],
    ['a 4-byte UTF-8 path', record('DA:1,1\n', 'src/\u{1F600}.ts'), 'ACCEPTED'],
  ]))
  test('LF and LH that disagree with the entries are a diagnostic, never a refusal (Node counts its ignored lines)', async () => {
    const r = await accepted(record('DA:1,1\nDA:2,0\nLF:3\nLH:2\n'))
    expect(r.stats.totalsDisagree).toBe(1)
  })
})

describe('damaged reports are refused whole, with the line (N3 to N8)', () => {
  test('truncation, nesting and records out of place', () => cases([
    ['truncated before end_of_record', 'TN:\nSF:src/a.ts\nDA:1,1\n', 'UNTERMINATED_RECORD'],
    ['truncated inside a line', 'TN:\nSF:src/a.ts\nDA:1', 'BAD_DA'],
    ['SF before end_of_record', 'TN:\nSF:a\nSF:b\nend_of_record\n', 'UNTERMINATED_RECORD'],
    ['a stray end_of_record', 'TN:\nend_of_record\n', 'STRAY_END'],
    ['DA outside a record', 'TN:\nDA:1,1\n', 'MALFORMED'],
    ['TN inside a record', 'TN:\nSF:a\nTN:x\nend_of_record\n', 'MALFORMED'],
    ['a lower-case tag', record('da:1,1\n'), 'MALFORMED'],
    ['a line with no tag', record('nonsense\n'), 'MALFORMED'],
    ['LF twice', record('LF:1\nLF:1\n'), 'MALFORMED'],
    ['a count that is not a count', record('FNF:x\n'), 'MALFORMED'],
    ['a bad BRDA', record('BRDA:1,0,0,x\n'), 'MALFORMED'],
    ['a bad FNL', record('FNL:x,1\n'), 'MALFORMED'],
    ['a bad FN', record('FN:0,f\n'), 'MALFORMED'],
    ['a bad FNDA', record('FNDA:-1,f\n'), 'MALFORMED'],
    ['a report that names no file', 'TN:\n# nothing\n', 'NO_RECORDS'],
    ['an empty report', new Uint8Array(0), 'REPORT_EMPTY'],
  ]))
  test('every malformed DA (N5)', () => cases([
    ['negative count', record('DA:1,-1\n'), 'BAD_DA'],
    ['fractional count', record('DA:1,1.5\n'), 'BAD_DA'],
    ['line 0', record('DA:0,1\n'), 'BAD_DA'],
    ['leading zero line', record('DA:01,1\n'), 'BAD_DA'],
    ['leading zero count', record('DA:1,01\n'), 'BAD_DA'],
    ['line over 10,000,000', record('DA:10000001,1\n'), 'BAD_DA'],
    ['ten-digit line', record('DA:1000000000,1\n'), 'BAD_DA'],
    ['plus sign', record('DA:+1,1\n'), 'BAD_DA'],
    ['space after the tag', record('DA: 1,1\n'), 'BAD_DA'],
    ['21-digit count', record(`DA:1,${'9'.repeat(21)}\n`), 'BAD_DA'],
    ['no count', record('DA:1,\n'), 'BAD_DA'],
    ['a checksum with other bytes', record('DA:1,1,ab-c\n'), 'BAD_DA'],
    ['non-ASCII digits', record('DA:١,1\n'), 'BAD_DA'],
  ]))
  test('paths: NUL, empty, too long (N6)', () => cases([
    ['NUL in a path', record('DA:1,1\n', 'a\u0000b'), 'MALFORMED'],
    ['an empty path', record('DA:1,1\n', ''), 'BAD_SF'],
    ['a path over 4,096 bytes', record('DA:1,1\n', 'a'.repeat(4097)), 'BAD_SF'],
    ['a path of exactly 4,096 bytes', record('DA:1,1\n', 'a'.repeat(4096)), 'ACCEPTED'],
  ]))
  test('strict UTF-8, decided on the bytes, never by a replacing decoder (N7)', async () => {
    const sf = (bytes: number[]) => new Uint8Array([...encode('TN:\nSF:a'), ...bytes, ...encode('\nDA:1,1\nend_of_record\n')])
    await cases([
      ['an invalid byte', sf([0xff]), 'NOT_UTF8'],
      ['an overlong form', sf([0xc0, 0x80]), 'NOT_UTF8'],
      ['an overlong three-byte form', sf([0xe0, 0x80, 0xaf]), 'NOT_UTF8'],
      ['a surrogate', sf([0xed, 0xa0, 0x80]), 'NOT_UTF8'],
      ['above U+10FFFF', sf([0xf4, 0x90, 0x80, 0x80]), 'NOT_UTF8'],
      ['a cut sequence', sf([0xe2, 0x82]), 'NOT_UTF8'],
      ['a stray continuation byte', sf([0x80]), 'NOT_UTF8'],
      ['binary garbage', new Uint8Array([0x00, 0xff, 0xfe, 0x01, 0x80, 0x0a]), 'NOT_UTF8'],
      ['NUL bytes only', new Uint8Array([0x00, 0x00, 0x0a]), 'MALFORMED'],
      ['a valid three-byte character', sf([0xe2, 0x82, 0xac]), 'ACCEPTED'],
    ])
    expect(isUtf8(new Uint8Array([0xf0, 0x9f, 0x98, 0x80]), 0, 4)).toBe(true)
    expect(isUtf8(new Uint8Array([0xf0, 0x9f, 0x98]), 0, 3)).toBe(false)
  })
  test('a byte-order mark is allowed at the very start only: the host decoder would drop one at the start of any slice', async () => {
    const mark = [0xef, 0xbb, 0xbf]
    await cases([
      ['at the start of a later line', new Uint8Array([...encode('TN:\n'), ...mark, ...encode(record('DA:1,1\n').slice(4))]), 'MALFORMED'],
      ['inside an SF value', new Uint8Array([...encode('TN:\nSF:'), ...mark, ...encode('src/a.ts\nDA:1,1\nend_of_record\n')]), 'MALFORMED'],
      ['two at the start', new Uint8Array([...mark, ...mark, ...encode(record('DA:1,1\n'))]), 'MALFORMED'],
    ])
    const r = await parse(new Uint8Array([...encode('TN:\nSF:'), ...mark, ...encode('a\nDA:1,1\nend_of_record\n')]))
    expect(r.ok ? 0 : r.line).toBe(2)
  })
  test('bare carriage returns: a short report is refused, a long one exceeds the line bound (N8)', async () => {
    await cases([
      ['short', 'TN:\rSF:src/a.ts\rDA:1,1\rend_of_record\r', 'MALFORMED'],
      ['long', `TN:\rSF:src/a.ts\r${'DA:1,1\r'.repeat(2000)}end_of_record\r`, 'LINE_TOO_LONG'],
      ['a control character', record('DA:1,1\nFN:1,f\u0007\n'), 'MALFORMED'],
    ])
  })
})

describe('bounds: every one refuses the whole report, none returns a part (N9 to N13)', () => {
  test('the byte cap is the host read limit, refused before a byte is parsed (N10)', async () => {
    expect(LCOV_LIMITS.maxBytes).toBe(4 * 1024 * 1024)
    expect(await outcome(new Uint8Array(LCOV_LIMITS.maxBytes + 1))).toBe('REPORT_TOO_LARGE')
  })
  test('records, entries per record and entries in all (N9)', async () => {
    const many = 'TN:\n' + 'SF:a\nend_of_record\n'.repeat(LCOV_LIMITS.maxRecords + 1)
    const r = await parseLcov(encode(many), () => null, clock())
    expect(r.ok ? 'ACCEPTED' : r.code).toBe('TOO_MANY_RECORDS')
    // under the 4 MiB cap the entry bounds cannot be reached (a DA line is at least 7 bytes): they are a backstop, checked
    expect(Math.floor(LCOV_LIMITS.maxBytes / 7)).toBeLessThan(LCOV_LIMITS.maxEntriesPerRecord)
    const tight = { ...LCOV_LIMITS, maxEntriesPerRecord: 3, maxEntries: 5 }
    expect(await outcome(record('DA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\n'), tight)).toBe('TOO_MANY_DA')
    expect(await outcome(record('DA:1,1\nDA:2,1\nDA:3,1\n') + record('DA:1,1\nDA:2,1\nDA:3,1\n', 'src/b.ts'), tight)).toBe('TOO_MANY_DA')
  })
  test('the deadline, checked by lines and after every pause (N11)', async () => {
    const r = await parseLcov(encode(record('DA:1,1\nDA:2,1\nDA:3,1\n')), everything, clock(1000), { ...LCOV_LIMITS, checkEveryLines: 1 })
    expect(r.ok ? 'ACCEPTED' : r.code).toBe('DEADLINE')
  })
  test('the parser hands the event loop back every MiB (N13)', async () => {
    const big = 'TN:\n' + record('DA:1,1\n'.repeat(200_000)).slice(4)
    expect(big.length).toBeGreaterThan(1024 * 1024)
    const time = clock()
    const r = await parseLcov(encode(big), everything, time)
    expect(r.ok).toBe(true)
    expect(time.paused()).toBe(1)
    // with a smaller step the same report pauses in proportion, and still parses whole
    const often = clock()
    expect((await parseLcov(encode(big), everything, often, { ...LCOV_LIMITS, pauseEveryBytes: 64 * 1024 })).ok).toBe(true)
    expect(often.paused()).toBeGreaterThanOrEqual(Math.floor(big.length / (64 * 1024)) - 1)
  })
})

describe('only the changed lines are kept, merged across records (N14, N15, N21 to N23)', () => {
  test('a record with 200,000 distinct lines for a changed 10-line file keeps its 3 changed lines and the highest line', async () => {
    const body = Array.from({ length: 200_000 }, (_, k) => `DA:${k + 1},${k % 2}\n`).join('')
    const r = await accepted(record(body), () => ({ key: 'src/a.ts', wanted: new Set([2, 3, 4]) }))
    const file = r.files.get('src/a.ts')!
    expect([...file.lines]).toEqual([[2, true], [3, false], [4, true]])
    expect(file.maxLine).toBe(200_000)
    expect(file.entries).toBe(200_000)
    expect(r.stats.keptLines).toBe(3)
  })
  test('one changed file named by three records of 100,000 lines keeps only what changed', async () => {
    const body = (from: number) => Array.from({ length: 100_000 }, (_, k) => `DA:${from + k},1\n`).join('')
    const report = record(body(1)) + record(body(100_001)) + record(body(200_001))
    expect(report.length).toBeLessThan(LCOV_LIMITS.maxBytes)
    const r = await accepted(report, () => ({ key: 'src/a.ts', wanted: new Set([5, 150_000, 299_999]) }))
    expect(r.files.get('src/a.ts')!.lines.size).toBe(3)
    expect(r.files.get('src/a.ts')!.records).toBe(3)
  })
  test('one path in two records with one spelling: a line is run if either says so', async () => {
    const r = await accepted(record('DA:1,0\nDA:2,0\n') + record('DA:1,3\n'))
    expect([...r.files.get('src/a.ts')!.lines]).toEqual([[1, true], [2, false]])
  })
  test('one path under two spellings, or a case-only match, marks it and keeps nothing for it', async () => {
    const changed = new Map([['src/a.ts', new Set([1])], ['src/b.ts', new Set([1])]])
    const match = sfMatcher(changed, { root: '/work/repo' })
    const r = await accepted(record('DA:1,1\n') + record('DA:1,0\n', '/work/repo/src/a.ts') + record('DA:1,1\n', 'src/B.ts'), match)
    expect(r.files.get('src/a.ts')!.conflict).toBe('SF_CONFLICTING_IDENTITY')
    expect(r.files.get('src/a.ts')!.lines.size).toBe(0)
    expect(r.files.get('src/b.ts')!.conflict).toBe('SF_CASE_MISMATCH')
    // an exact record after a case-only one does not clear the doubt
    const later = await accepted(record('DA:1,1\n', 'src/B.ts') + record('DA:1,1\n', 'src/b.ts'), match)
    expect(later.files.get('src/b.ts')!.conflict).toBe('SF_CASE_MISMATCH')
    expect(later.files.get('src/b.ts')!.lines.size).toBe(0)
  })
  test('refused and unmatched records are counted by reason, never kept', async () => {
    const match = sfMatcher(new Map([['src/a.ts', new Set([1])]]), { root: '/work/repo' })
    const r = await accepted(record('DA:1,1\n') + record('DA:1,1\n', '../../etc/passwd') + record('DA:1,1\n', 'webpack:///x') + record('DA:1,1\n', 'dist/a.js'), match)
    expect(r.refused).toEqual({ SF_OUTSIDE_REPOSITORY: 1, SF_SCHEME: 1 })
    expect(r.unmatched).toBe(1)
    expect([...r.files.keys()]).toEqual(['src/a.ts'])
  })
})

describe('real reports from every measured producer are accepted (N12)', () => {
  const root = { root: '/work/repo' }
  const everyLine = new Set(Array.from({ length: 30 }, (_, k) => k + 1))
  const changed = new Map(['src/math.ts', 'src/pragmas.ts', 'src/cr.ts', 'src/schema.gen.ts', 'src/unloaded.ts', 'src/multi.ts', 'test/all.test.ts'].map(p => [p, everyLine]))
  const read = async (report: string) => accepted(report, sfMatcher(changed, root))
  test('Node, c8, Jest (babel, v8) and Vitest (v8, istanbul)', async () => {
    for (const report of [NODE22_PHASE0, NODE22, C8, JEST_BABEL, JEST_V8, VITEST_V8, VITEST_ISTANBUL]) expect((await read(report)).files.has('src/math.ts')).toBe(true)
  })
  test('what each measured: line entries differ by producer, which is why a missing entry proves nothing', async () => {
    const math = async (report: string) => (await read(report)).files.get('src/math.ts')!.lines
    // a continuation line of a multi-line statement that ran: an entry under the v8 line tools, none under statement tools
    for (const report of [NODE22, C8, JEST_V8]) expect((await math(report)).get(16)).toBe(true)
    for (const report of [VITEST_V8, VITEST_ISTANBUL, JEST_BABEL]) expect((await math(report)).has(16)).toBe(false)
    // the return of a function that never ran is reported as not run by all of them
    for (const report of [NODE22, C8, JEST_V8, VITEST_V8, VITEST_ISTANBUL, JEST_BABEL]) expect((await math(report)).get(10)).toBe(false)
    const multi = async (report: string) => (await read(report)).files.get('src/multi.ts')!.lines
    // an unrun multi-line statement: statement tools give lines 1, 2, 4, 6, 7, 8 and 10 no entry at all
    for (const report of [VITEST_V8, VITEST_ISTANBUL, JEST_BABEL]) expect([...(await multi(report)).keys()].sort((a, b) => a - b)).toEqual([3, 5, 9])
    for (const report of [C8, JEST_V8]) expect([...(await multi(report)).values()].every(run => run === false)).toBe(true)
  })
  test('Node also names the test file and a file outside the project; the outside one and the preload are refused', async () => {
    const node = await read(NODE22)
    expect(node.files.has('test/all.test.ts')).toBe(true)
    expect(node.refused).toEqual({ SF_OUTSIDE_REPOSITORY: 1 })
    expect((await read(NODE22_PHASE0)).refused).toEqual({ SF_OUTSIDE_REPOSITORY: 1 })
  })
  test('no producer writes a revision, a hash or a time: the report carries no identity of its own', () => {
    for (const report of [NODE22, C8, JEST_BABEL, JEST_V8, VITEST_V8, VITEST_ISTANBUL]) {
      expect(report.split('\n').filter(l => l.startsWith('TN:')).every(l => l === 'TN:')).toBe(true)
      expect(/^VER:/m.test(report)).toBe(false)
      expect(/^DA:\d+,\d+,/m.test(report)).toBe(false)
    }
  })
})

describe('the read verdict: an ordinary file, read whole, unchanged by the read', () => {
  const file = (over: Partial<ReportStat> = {}): ReportStat => ({ kind: 'file', size: 100, links: 1, identity: '81a4 100 7 1.5 1.5', ...over })
  const dir: ReportStat = { kind: 'dir', size: 0, links: 2, identity: '41ed 0 3 1 1' }
  const verdict = (before: ReportStat, read: { bytes: number } | { failed: true }, after: ReportStat = before, parents: readonly ReportStat[] = [dir], afterParents: readonly ReportStat[] = parents) =>
    reportReadVerdict({ report: before, parents }, read, { report: after, parents: afterParents })
  test('each refusal, in order', () => {
    expect(verdict(file(), { bytes: 100 })).toEqual({ ok: true })
    expect(verdict(file(), { bytes: 100 }, file(), [{ ...dir, kind: 'link' }])).toEqual({ refuse: 'REPORT_LINKED_DIRECTORY' })
    expect(verdict(file({ kind: 'missing' }), { failed: true })).toEqual({ refuse: 'REPORT_MISSING' })
    for (const kind of ['link', 'fifo', 'socket', 'char', 'block', 'dir'] as const) expect(verdict(file({ kind }), { bytes: 0 })).toEqual({ refuse: 'REPORT_NOT_A_REGULAR_FILE' })
    expect(verdict(file({ links: 2 }), { bytes: 100 })).toEqual({ refuse: 'REPORT_HARD_LINKED' })
    expect(verdict(file({ size: 0 }), { bytes: 0 })).toEqual({ refuse: 'REPORT_EMPTY' })
    expect(verdict(file({ size: LCOV_LIMITS.maxBytes + 1 }), { bytes: 0 })).toEqual({ refuse: 'REPORT_TOO_LARGE' })
    expect(verdict(file(), { failed: true })).toEqual({ refuse: 'REPORT_UNREADABLE' })
  })
  test('anything that moved during the read refuses it: the length, the file, or a parent directory', () => {
    // fewer bytes: a FIFO or a link to /dev/null swapped in reads as empty; more: a /proc-style file, or growth
    expect(verdict(file(), { bytes: 0 })).toEqual({ refuse: 'REPORT_CHANGED_WHILE_READ' })
    expect(verdict(file(), { bytes: 101 })).toEqual({ refuse: 'REPORT_CHANGED_WHILE_READ' })
    expect(verdict(file(), { bytes: 100 }, file({ identity: '81a4 100 8 1.5 1.5' }))).toEqual({ refuse: 'REPORT_CHANGED_WHILE_READ' })
    expect(verdict(file(), { bytes: 100 }, file({ kind: 'link' }))).toEqual({ refuse: 'REPORT_CHANGED_WHILE_READ' })
    expect(verdict(file(), { bytes: 100 }, file(), [dir], [{ ...dir, identity: '41ed 0 4 1 1' }])).toEqual({ refuse: 'REPORT_CHANGED_WHILE_READ' })
    expect(verdict(file(), { bytes: 100 }, file(), [dir], [])).toEqual({ refuse: 'REPORT_CHANGED_WHILE_READ' })
  })
})
