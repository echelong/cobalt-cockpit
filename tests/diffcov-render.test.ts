import { describe, expect, test } from 'claude-code/testing'
import { CLOSING, MAX_RANGES, PAGE_SIZE, TITLE, categoryOf, classifyChange, diffEvidenceOf, renderDiffEvidence, renderOff, sourceFactsOf, unavailableEvidenceOf } from '../hooks/diffcov-classify'
import type { ChangedFile, Classification, DiffEvidence, Evidence, LineReason } from '../hooks/diffcov-classify'
import { parseLcov } from '../hooks/diffcov-lcov'
import { charColumns, displayText, sfMatcher, textColumns } from '../hooks/diffcov-paths'
import { GOLDEN } from './diffcov-render-fixtures'
import { JEST_V8, SOURCES, VITEST_V8 } from './diffcov-fixtures'

// Diff coverage, Phase 1.5: the report as a person reads it. Golden renderings pin the layout of every state; the
// properties hold it in terminal columns at every width, for wide characters too; a file whose changed lines could not
// be read is never left out of the Uncounted line.

const encode = (text: string) => new TextEncoder().encode(text)
const classify = (...args: Parameters<typeof classifyChange>): Classification => {
  const c = classifyChange(...args)
  if ('refuse' in c) throw new Error(`refused: ${c.refuse}`)
  return c
}
const facts = (text: string) => {
  const f = sourceFactsOf(encode(text))
  if ('refuse' in f) throw new Error(f.refuse)
  return f
}
const file = (path: string, text: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path, status: 'untracked', kind: 'file', modeOnly: false, binaryPatch: false, added: [], modified: [], deletedLines: 0, generatedByAttribute: false, source: facts(text), ...over,
})
const changedLines = (f: ChangedFile): number[] => f.source === null || 'refuse' in f.source ? [] : f.status === 'untracked' ? Array.from({ length: f.source.lineCount }, (_, k) => k + 1) : [...f.added, ...f.modified]
const clock = { now: () => 0, pause: async () => {} }
const bound = async (report: string, files: readonly ChangedFile[], notes: Extract<Evidence, { state: 'BOUND' }>['notes'] = []): Promise<Evidence> => {
  const r = await parseLcov(encode(report), sfMatcher(new Map(files.map(f => [f.path, new Set(changedLines(f))])), { root: '/work/repo' }), clock)
  if (!r.ok) throw new Error(`refused: ${r.code}`)
  return { state: 'BOUND', report: r, notes }
}
const HEAD = '4f9a1c2e7b30'.padEnd(40, '0')
const BASE = 'b662021802ede55fe72f1c294db561e4011a5400'
const viewOf = (c: Classification, evidence: Evidence, over: Partial<DiffEvidence> = {}): DiffEvidence => ({
  ...diffEvidenceOf({
    source: { head: HEAD, identity: '9f2c41d08e5a7b13'.padEnd(64, 'a'), tracked: 3, untracked: 2 },
    base: { sha: BASE, how: 'task-start', ancestor: true },
    coverage: { path: 'coverage/lcov.info', sha256: 'd0c162d6c122a9f4'.padEnd(64, '0'), run: { at: Date.UTC(2026, 9, 16, 7, 0), label: 'npm test' } },
    evidence,
    classification: c,
  }),
  ...over,
})
const lines = (text: string) => text.split('\n')

// Latin-1 text: `\u{e9}` as the one byte E9, which is not UTF-8
const LATIN1 = new Uint8Array([0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a])
const latin1 = (over: Partial<ChangedFile> = {}): ChangedFile => ({ ...file('src/legacy.ts', ''), status: 'modified', modified: [1, 2], source: sourceFactsOf(LATIN1), ...over })
// CJK, fullwidth, a BMP emoji and an astral one: every character two columns
const WIDE_PATH = 'src/\u{4e2d}\u{6587}\u{76ee}\u{5f55}/\u{30c6}\u{30b9}\u{30c8}\u{2705}\u{ff21}\u{ff22}/\u{1F600}\u{1F680}.ts'

/** A state the golden renderings pin: its view (null for the layer switched off), the width and the page. */
type State = { view: DiffEvidence | null; columns: number; page?: number }
export const draw = (state: State, columns = state.columns): string => state.view === null ? renderOff(columns) : renderDiffEvidence(state.view, columns, state.page ?? 1)

/** The states the golden renderings pin, named with their width. Built from fixed data only: the same text on every machine and every run. */
export const states = async (): Promise<Record<string, State>> => {
  const files = [...Object.entries(SOURCES).map(([path, text]) => file(path, text)), file('README.md', 'docs\n'), file('src/old.ts', '', { status: 'deleted', kind: 'none', source: null, deletedLines: 3 }), latin1()]
  const matched = await bound(`${VITEST_V8}TN:\nSF:/elsewhere/x.ts\nDA:1,1\nend_of_record\n`, files, ['BYTES_UNCHANGED_BY_RUN'])
  const unbound: Evidence = { state: 'UNBOUND', why: 'SOURCE_CHANGED_SINCE_RUN' }
  const rejected: Evidence = { state: 'REJECTED', code: 'UNTERMINATED_RECORD', line: 12 }
  const doubted = [file('src/a.ts', 'a\n\nb\n'), file('src/b.ts', 'x\ny\n')]
  const doubt = await bound('TN:\nSF:src/a.ts\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\nTN:\nSF:src/B.ts\nDA:1,1\nend_of_record\nTN:\nSF:src/b.ts\nDA:1,1\nDA:9,1\nend_of_record\n', doubted)
  const toolFiles = [file('src/math.ts', SOURCES['src/math.ts']!, { status: 'modified', modified: [3, 9, 10, 11], added: [23, 24] })]
  const toolLists = await bound(JEST_V8, toolFiles)
  const many = [...Array.from({ length: 3 }, (_, k) => file(`src/r${k}.ts`, 'x\n')), ...Array.from({ length: 45 }, (_, k) => file(`docs/d${String(k).padStart(2, '0')}.md`, 'x\n'))]
  const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
  const wide = [file(WIDE_PATH, 'x\n'.repeat(90), { status: 'modified', modified: Array.from({ length: 45 }, (_, k) => 2 * k + 1) }), file('docs/\u{1F4DD}\u30e1\u30e2.md', 'x\n')]
  const pages = viewOf(classify(many, notObserved, []), notObserved)

  return {
    'matched-80': { view: viewOf(classify(files, matched, []), matched), columns: 80 },
    'matched-50': { view: viewOf(classify(files, matched, []), matched), columns: 50 },
    'not-used-80': { view: viewOf(classify(files, unbound, []), unbound, { source: { head: HEAD, identity: null, tracked: 4, untracked: 3 }, base: { sha: BASE, how: 'given', given: 'b662021802ede55f', ancestor: false } }), columns: 80 },
    'refused-64': { view: viewOf(classify(files, rejected, []), rejected), columns: 64 },
    'untrusted-80': { view: viewOf(classify(doubted, doubt, []), doubt), columns: 80 },
    'tool-lists-blank-72': { view: viewOf(classify(toolFiles, toolLists, []), toolLists), columns: 72 },
    'page-2-72': { view: pages, columns: 72, page: 2 },
    'page-past-end-72': { view: pages, columns: 72, page: 9 },
    'wide-50': { view: viewOf(classify(wide, notObserved, []), notObserved), columns: 50 },
    'unavailable-80': { view: unavailableEvidenceOf({ source: { head: HEAD, identity: null, tracked: 0, untracked: 3 }, base: { sha: BASE, how: 'task-start', ancestor: true }, coverage: null, why: 'TOO_MANY_LINES' }), columns: 80 },
    'off-80': { view: null, columns: 80 },
  }
}

describe('golden renderings: the whole report, line for line, in every state', () => {
  test('each state renders exactly as pinned', async () => {
    const all = await states()
    expect(Object.keys(all).sort()).toEqual(Object.keys(GOLDEN).sort())
    for (const [name, state] of Object.entries(all)) {
      const want = lines(GOLDEN[name]!), got = lines(draw(state))
      for (let k = 0; k < Math.max(want.length, got.length); k++) expect([name, k + 1, got[k]]).toEqual([name, k + 1, want[k]])
    }
  })
  test('every pinned line is within its width in terminal columns, and the report ends with the closing lines', () => {
    for (const [name, text] of Object.entries(GOLDEN)) {
      const columns = Number(name.slice(name.lastIndexOf('-') + 1))
      expect([name, lines(text).filter(line => textColumns(line) > columns)]).toEqual([name, []])
      // below 76 columns the closing sentences wrap, word for word
      expect([name, lines(text)[0], text.replace(/\s+/g, ' ').endsWith(CLOSING.join(' '))]).toEqual([name, TITLE, true])
    }
  })
})

describe('terminal columns: a wide character takes two, and none counts less than one', () => {
  test('narrow, wide and astral characters', () => {
    const of = (text: string) => Array.from(text, char => charColumns(char.codePointAt(0)!))
    expect(of('aZ0 /.-_~')).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
    // Latin, Greek and Cyrillic letters, and the ambiguous-width dot and ellipsis, as most terminals draw them
    expect(of('\u{e9}\u{3b1}\u{436}\u{b7}\u{2026}')).toEqual([1, 1, 1, 1, 1])
    // CJK ideographs, kana, Hangul syllables and jamo, fullwidth forms, the ideographic space
    expect(of('\u{4e2d}\u{3042}\u{30c6}\u{ac00}\u{1100}\u{ff21}\u{ff01}\u{3000}')).toEqual([2, 2, 2, 2, 2, 2, 2, 2])
    // halfwidth katakana and halfwidth Hangul are narrow
    expect(of('\u{ff71}\u{ffa1}')).toEqual([1, 1])
    // emoji with a wide default presentation in the BMP, and every code point above it
    expect(of('\u{2705}\u{231a}\u{2b50}\u{26a1}\u{1F600}\u{1F680}\u{20000}\u{1D400}')).toEqual([2, 2, 2, 2, 2, 2, 2, 2])
    // a combining mark counts one, so a line within its width also holds no more code points than columns
    expect(of('e\u{301}')).toEqual([1, 1])
    expect(textColumns('src/\u{4e2d}\u{6587}.ts')).toBe(11)
    expect(textColumns('')).toBe(0)
  })
  test('agrees with the runtime\'s own Unicode data: every wide-presentation emoji and every CJK, kana and Hangul syllable counts two', () => {
    const wideByProperty = /^(?:\p{Emoji_Presentation}|\p{Script=Han}|\p{Script=Hiragana})$/u
    const katakana = /^\p{Script=Katakana}$/u
    const misses: string[] = []
    for (let code = 0; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      const char = String.fromCharCode(code)
      const wide = wideByProperty.test(char) || (katakana.test(char) && !(code >= 0xff61 && code <= 0xff9f)) || (code >= 0xac00 && code <= 0xd7a3)
      if (wide && charColumns(code) !== 2) misses.push(code.toString(16))
    }
    // the count and the first few, so a regression reports compactly
    expect([misses.length, misses.slice(0, 12)]).toEqual([0, []])
    // and nothing in printable ASCII or Latin-1 is counted wide
    for (let code = 0x20; code <= 0xff; code++) if (code < 0x7f || code > 0x9f) expect([code, charColumns(code)]).toEqual([code, 1])
  })
  test('displayText shortens by columns, so wide text is cut to the same width as narrow text, never by code points alone', () => {
    const cjk = '\u{4e2d}'.repeat(200)
    const short = displayText(cjk, 40)
    expect(textColumns(short)).toBeLessThanOrEqual(40)
    expect(short).toContain('\u{2026}')
    expect(displayText('\u{4e2d}'.repeat(20), 40)).toBe('\u{4e2d}'.repeat(20))
    expect(displayText('\u{4e2d}'.repeat(21), 40)).not.toBe('\u{4e2d}'.repeat(21))
    // a run of combining marks counts one column each: the result stays bounded in code points
    const marks = displayText(`a${'\u{301}'.repeat(100_000)}`, 60)
    expect(Array.from(marks).length).toBeLessThanOrEqual(60)
  })
})

/** A seeded generator (mulberry32), so a failure names its seed and can be replayed. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const PIECES = ['a', 'src', '/', '-', '.', '\u{4e2d}', '\u{6587}', '\u{30c6}', '\u{ac00}', '\u{ff21}', '\u{2705}', '\u{2b50}', '\u{1F600}', '\u{20000}', 'e\u{301}', '\u{e9}', '\u{436}', ' ', '\u{b7}']
const randomPath = (r: () => number, length: number) => `${Array.from({ length }, () => PIECES[Math.floor(r() * PIECES.length)]!).join('')}.ts`

describe('bounded in terminal columns at every width, with wide text anywhere', () => {
  // The bounded state/seed sweep across all 71 widths exceeded 5s under full-suite contention.
  test('from 50 to 120 columns no line is wider than the width in columns, nor longer in code points', { timeoutMs: 20000 }, async () => {
    // each pinned state again at every width, then seeded changes with wide, combining and narrow text in their paths
    for (const [name, state] of Object.entries(await states())) {
      for (let columns = 50; columns <= 120; columns++) {
        expect([name, columns, lines(draw(state, columns)).filter(line => textColumns(line) > columns || Array.from(line).length > columns)]).toEqual([name, columns, []])
      }
    }
    const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 7919)
      const files = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, k) => file(`${randomPath(r, 1 + Math.floor(r() * 80))}${k}`, 'x\n'.repeat(60), { status: 'modified', modified: Array.from({ length: 30 }, (_, i) => 2 * i + 1) }))
      const view = viewOf(classify(files, notObserved, []), notObserved, { coverage: { path: randomPath(r, 90), sha256: null, run: { at: 0, label: 'vitest' } } })
      for (let columns = 50; columns <= 120; columns++) {
        const text = renderDiffEvidence(view, columns)
        expect([seed, columns, lines(text).filter(line => textColumns(line) > columns || Array.from(line).length > columns)]).toEqual([seed, columns, []])
      }
    }
  })
  test('long unbroken values are split by columns, a wide character never straddling the edge', () => {
    // hand-built header values: the producer gives hex and closed labels, but whatever it gives is drawn within the width
    const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
    const plain = viewOf(classify([file('src/a.ts', 'x\n')], notObserved, []), notObserved)
    for (const [k, unit] of ['a\u{4e2d}', '\u{4e2d}', 'ab\u{1F600}', '\u{ff21}x'].entries()) {
      const view: DiffEvidence = { ...plain, source: { ...plain.source, identity: unit.repeat(40) }, coverage: { path: unit.repeat(80), sha256: unit.repeat(40), run: { at: 0, label: unit.repeat(60) as never } } }
      for (let columns = 50; columns <= 120; columns++) {
        const over = lines(renderDiffEvidence(view, columns)).filter(line => textColumns(line) > columns)
        expect([k, columns, over]).toEqual([k, columns, []])
      }
    }
  })
  test('a 20,000-character wide path is shortened by columns and drawn in milliseconds', () => {
    const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
    const view = viewOf(classify([file(`src/${'\u{4e2d}'.repeat(20_000)}.ts`, 'x\n')], notObserved, []), notObserved)
    const start = Date.now()
    const text = renderDiffEvidence(view, 50)
    expect(Date.now() - start).toBeLessThan(1000)
    expect(lines(text).filter(line => textColumns(line) > 50)).toEqual([])
  })
  test('the glue that keeps a count with its word never reaches the text', async () => {
    for (const [name, state] of Object.entries(await states())) for (const columns of [50, 64, 80, 120]) expect([name, columns, draw(state, columns).includes('\u{a0}')]).toEqual([name, columns, false])
  })
})

describe('Uncounted names every file whose changed lines exist but were not classified', () => {
  const unbound: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
  const NUL = new Uint8Array([0x78, 0x00, 0x0a, 0x79, 0x0a])
  const nul = (over: Partial<ChangedFile>): ChangedFile => ({ ...file('src/nul.ts', ''), source: sourceFactsOf(NUL), ...over })
  const reasonOf = (f: ChangedFile) => classify([f], unbound, []).files[0]!.reason
  test('text in another encoding is not called binary: its row says why, and the header counts it', () => {
    expect(sourceFactsOf(LATIN1)).toEqual({ refuse: 'SOURCE_NOT_UTF8' })
    const c = classify([latin1(), file('src/ok.ts', 'x\n')], unbound, [])
    expect(c.files.map(f => f.reason)).toEqual(['SOURCE_NOT_UTF8', 'CLASSIFIED'])
    expect(c.lines.filter(v => v.path === 'src/legacy.ts')).toEqual([])
    const text = renderDiffEvidence(viewOf(c, unbound), 80)
    expect(text).toContain('Uncounted:  1 file whose changed lines could not be classified (see Files)')
    expect(text).toContain('     NOT COUNTED  not read: not UTF-8 text (another encoding, or damaged)')
    expect(text).not.toMatch(/^ +binary$/m)
    // untracked, every line of it is a changed line
    expect(reasonOf(latin1({ status: 'untracked', modified: [] }))).toBe('SOURCE_NOT_UTF8')
  })
  test('a NUL byte in a file Git compared as text, in which it named changed lines, is counted too; a binary file with no such line is not', () => {
    expect(reasonOf(nul({ status: 'modified', modified: [1] }))).toBe('SOURCE_HAS_NUL')
    expect(reasonOf(nul({ status: 'added', added: [1, 2] }))).toBe('SOURCE_HAS_NUL')
    expect(reasonOf(nul({ status: 'untracked' }))).toBe('BINARY')
    expect(reasonOf(nul({ status: 'modified', deletedLines: 2 }))).toBe('BINARY')
    expect(reasonOf(nul({ status: 'modified', binaryPatch: true, modified: [1] }))).toBe('BINARY')
    const text = renderDiffEvidence(viewOf(classify([nul({ status: 'modified', modified: [1] }), nul({ path: 'img/a.png', status: 'untracked' })], unbound, []), unbound), 80)
    expect(text).toContain('Uncounted:  1 file whose changed lines could not be classified (see Files)')
    expect(text).toContain('NOT COUNTED  not read: it holds a NUL byte, though Git compared it as text')
    expect(text).toMatch(/^ {5}binary$/m)
  })
  test('over seeded changes: a file with changed lines and no verdict is always NOT COUNTED, and the header counts exactly those rows', () => {
    const sources = [() => facts('x\ny\nz\n'), () => sourceFactsOf(LATIN1), () => sourceFactsOf(NUL), () => ({ refuse: 'SOURCE_TOO_LARGE' as const }), () => ({ refuse: 'SOURCE_GREW' as const }), () => null]
    const marked = (text: string): string[] => {
      const ls = lines(text)
      return ls.flatMap((line, k) => { const m = /^ +\d+\. (\S+)$/.exec(line); return m !== null && /^ +NOT COUNTED {2}/.test(ls[k + 1] ?? '') ? [m[1]!] : [] })
    }
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 104729)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)]!
      const files: ChangedFile[] = Array.from({ length: 1 + Math.floor(r() * 12) }, (_, k) => {
        const status = pick(['untracked', 'modified', 'added', 'deleted', 'type-changed'] as const)
        if (status === 'deleted') return file(`src/f${k}.ts`, '', { status, kind: 'none', source: null, deletedLines: 1 })
        const changed = [1, 2, 3, 7].filter(() => r() < 0.4)
        return file(`src/f${k}.ts`, '', { status, kind: r() < 0.1 ? 'symlink' : 'file', modeOnly: r() < 0.05, binaryPatch: r() < 0.15, added: changed.filter(() => r() < 0.5), modified: changed, source: pick(sources)() })
      })
      const c = classify(files, unbound, [])
      const text = renderDiffEvidence(viewOf(c, unbound), 120)
      const verdicts = new Set(c.lines.map(v => v.path))
      const notCounted = new Set(marked(text))
      for (const f of files) {
        const text = f.source !== null && !('refuse' in f.source)
        const linesExist = f.status !== 'deleted' && f.kind === 'file' && !f.modeOnly && (f.binaryPatch ? text
          : f.status === 'untracked' ? f.source !== null && !('refuse' in f.source && f.source.refuse === 'BINARY') : f.added.length + f.modified.length > 0)
        if (linesExist && !verdicts.has(f.path)) expect([seed, f.path, notCounted.has(f.path)]).toEqual([seed, f.path, true])
        if (notCounted.has(f.path)) expect([seed, f.path, verdicts.has(f.path)]).toEqual([seed, f.path, false])
      }
      const header = /^Uncounted: {2}(\d+) files? /m.exec(text)
      expect([seed, header === null ? 0 : Number(header[1])]).toEqual([seed, notCounted.size])
    }
  })
})

describe('the categories as drawn: each group the sum of its parts, each part the sum of its reasons', () => {
  test('in every pinned state, at the widest and the narrowest width', async () => {
    const countOf = (text: string, label: string): number => {
      const m = new RegExp(`^${label} +([\\d,]+)(?: .*)?$`, 'm').exec(text)
      return m === null ? Number.NaN : Number(m[1]!.replace(/,/g, ''))
    }
    for (const [name, state] of Object.entries(await states())) {
      if (state.view === null || state.view.state !== 'REPORTED') continue
      const view = state.view
      const sum = (category: string) => (Object.entries(view.byReason) as [LineReason, number][]).filter(([code]) => categoryOf(code) === category).reduce((a, [, n]) => a + n, 0)
      for (const columns of [50, 120]) {
        const text = draw(state, columns)
        const parts = { excluded: countOf(text, ' {2}excluded'), nonExecutable: countOf(text, ' {2}non-executable'), unavailable: countOf(text, ' {2}unavailable'), untrusted: countOf(text, ' {2}untrusted') }
        expect([name, columns, parts]).toEqual([name, columns, { excluded: sum('EXCLUDED'), nonExecutable: sum('NON_EXECUTABLE'), unavailable: sum('UNAVAILABLE'), untrusted: sum('UNTRUSTED') }])
        expect([name, columns, countOf(text, 'EXCLUDED / NON-EXECUTABLE'), countOf(text, 'UNAVAILABLE / UNTRUSTED')]).toEqual([name, columns, parts.excluded + parts.nonExecutable, parts.unavailable + parts.untrusted])
        // every reason with a count has a line of its own beginning with that count
        for (const [code, n] of Object.entries(view.byReason) as [LineReason, number][]) {
          if (code === 'REPORTED_RUN' || code === 'REPORTED_NOT_RUN') continue
          expect([name, columns, code, new RegExp(`^ {4} *${n.toLocaleString('en-US')} {2}\\S`, 'm').test(text)]).toEqual([name, columns, code, true])
        }
        const matched = view.evidence.state === 'MATCHED'
        expect([name, columns, countOf(text, 'COVERED'), countOf(text, 'UNCOVERED')]).toEqual([name, columns, matched ? view.counts.covered : Number.NaN, matched ? view.counts.uncovered : Number.NaN])
      }
    }
  })
})

describe('six-figure counts keep their column, with a space before them', () => {
  test('a group, a part and a reason at the 200,000-line limit are aligned and never touch their name', () => {
    const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
    const plain = viewOf(classify([file('src/a.ts', 'x\n')], notObserved, []), notObserved)
    const big: DiffEvidence = { ...plain, counts: { covered: 0, uncovered: 0, excluded: 150_000, nonExecutable: 50_000, unavailable: 0, untrusted: 0 }, byReason: { FILE_TYPE_OUT_OF_SCOPE: 150_000, BLANK_LINE: 50_000 } }
    for (const columns of [50, 80]) {
      const text = renderDiffEvidence(big, columns)
      expect(text).toContain('\nEXCLUDED / NON-EXECUTABLE 200,000\n  excluded                150,000\n    150,000  not JS/TS\n  non-executable           50,000\n    50,000  blank\n')
      // every group and part row ends its count in the same column
      const rows = lines(text).filter(line => /^(?:[A-Z][A-Z /-]+|  [a-z-]+) +(?:[\d,]+|-)(?: {2}\S.*)?$/.test(line))
      expect([columns, rows.length, new Set(rows.map(line => /^(?:[A-Z][A-Z /-]+|  [a-z-]+) +(?:[\d,]+|-)/.exec(line)![0].length)).size]).toEqual([columns, 8, 1])
    }
  })
})

describe('pagination: one page count, entries numbered across pages, every list saying where it stands', () => {
  const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
  const view = (ts: number, md: number) => viewOf(classify([...Array.from({ length: ts }, (_, k) => file(`src/r${String(k).padStart(2, '0')}.ts`, 'x\n')), ...Array.from({ length: md }, (_, k) => file(`docs/d${String(k).padStart(2, '0')}.md`, 'x\n'))], notObserved, []), notObserved)
  test('numbers continue from page to page, and only a page before the last says it continues', () => {
    const v = view(45, 0)
    const two = renderDiffEvidence(v, 80, 2)
    expect(two).toContain('Page 2 of 3')
    expect(two).toContain('REVIEW REQUIRED: 45 entries; 21 to 40 on this page')
    expect(two).toContain('  21. src/r20.ts:1')
    expect(two).toContain('  40. src/r39.ts:1')
    expect(two).not.toContain('src/r19.ts')
    expect(two).toContain('Continued on page 3 of 3.')
    const three = renderDiffEvidence(v, 80, 3)
    expect(three).toContain('REVIEW REQUIRED: 45 entries; 41 to 45 on this page')
    expect(three).not.toContain('Continued on page')
    expect(renderDiffEvidence(v, 80, 1)).toContain('   1. src/r00.ts:1')
  })
  test('an empty review list says none and shows no legend; one page is still a page', () => {
    const text = renderDiffEvidence(view(0, 3), 80)
    expect(text).toContain('Page 1 of 1')
    expect(text).toContain('REVIEW REQUIRED: none')
    expect(text).not.toMatch(/^ {2}(?:UNCOVERED|UNTRUSTED|UNAVAILABLE|NOTE) {2,}/m)
    expect(text).toContain('Files: 3 files\n')
  })
  test('the legend names the categories on this page only, in the list\'s order', async () => {
    const all = await states()
    const legend = (text: string) => lines(text).filter(line => /^ {2}(?:UNCOVERED|UNTRUSTED|UNAVAILABLE|NOTE) {2,}\S/.test(line)).map(line => line.trim().split(' ')[0])
    expect(legend(draw(all['matched-80']!))).toEqual(['UNCOVERED', 'UNAVAILABLE', 'NOTE'])
    expect(legend(draw(all['untrusted-80']!))).toEqual(['UNCOVERED', 'UNTRUSTED'])
    expect(legend(draw(all['page-2-72']!))).toEqual([])
  })
  test('a page past the end is drawn as the last page and says which page was asked for', () => {
    const v = view(3, 45)
    expect(renderDiffEvidence(v, 80, 9)).toBe(renderDiffEvidence(v, 80, 3).replace('Page 3 of 3', 'Page 3 of 3 (page 9 was asked for)'))
    expect(renderDiffEvidence(v, 80, 3)).toContain('REVIEW REQUIRED: 3 entries, all on page 1')
    // a page too large for digits is still a page past the end; Infinity is not a finite number, so it is page 1
    expect(renderDiffEvidence(v, 80, 1e308)).toBe(renderDiffEvidence(v, 80, 3).replace('Page 3 of 3', 'Page 3 of 3 (a later page was asked for)'))
    expect(renderDiffEvidence(v, 80, Infinity)).toBe(renderDiffEvidence(v, 80, 1))
  })
})

describe('review entries: ranges break only after a comma, and the count of lines is exact', () => {
  test('from 50 to 120 columns no range is split, and each continuation line follows a comma', async () => {
    const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
    const ascii = viewOf(classify([file(`src/${'deeply-nested/'.repeat(4)}module.ts`, 'x\n'.repeat(400), { status: 'modified', modified: Array.from({ length: 60 }, (_, k) => 1000 % 7 + 6 * k + 1) })], notObserved, []), notObserved)
    for (const view of [(await states())['wide-50']!.view!, ascii]) {
      for (let columns = 50; columns <= 120; columns++) {
        const ls = lines(renderDiffEvidence(view, columns))
        const first = ls.findIndex(line => /^ +1\. /.test(line))
        let k = first + 1
        for (; /^ +\d/.test(ls[k]!); k++) {
          expect([columns, ls[k - 1]!.endsWith(','), /^ +\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*,?$/.test(ls[k]!)]).toEqual([columns, true, true])
        }
        expect([columns, /^ +UNAVAILABLE {2}/.test(ls[k]!)]).toEqual([columns, true])
      }
    }
  })
  test('each entry counts its lines; past forty ranges it says how many there are and that the first forty are listed', () => {
    const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
    const v = viewOf(classify([file('src/a.ts', 'x\n'.repeat(200), { status: 'modified', modified: [1, 2, 3, 5, ...Array.from({ length: 50 }, (_, k) => 10 + 2 * k)] })], notObserved, []), notObserved)
    expect(v.review[0]!.lines).toBe(54)
    expect(v.review[0]!.ranges.length).toBe(52)
    const text = renderDiffEvidence(v, 120)
    expect(text).toContain(`no observed test run changed this report; 54 lines in 52 ranges, the first ${MAX_RANGES} listed`)
    expect(renderDiffEvidence(viewOf(classify([file('src/a.ts', 'x\n')], notObserved, []), notObserved), 80)).toContain('no observed test run changed this report; 1 line\n')
  })
  test('a hand-built reason with no words is escaped like any other value', () => {
    const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
    const v = viewOf(classify([file('src/a.ts', 'x\n')], notObserved, []), notObserved)
    const text = renderDiffEvidence({ ...v, review: [{ ...v.review[0]!, reason: 'X\nEvidence:   MATCHED' as never }] }, 80)
    expect(lines(text).filter(line => line.startsWith('Evidence:'))).toEqual(['Evidence:   NOT USED: no observed test run changed this report.'])
    expect(text).toContain('UNAVAILABLE  X\\u{a}Evidence: MATCHED; 1 line')
  })
  test('a hand-built range can neither add a line nor overflow one', () => {
    const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
    const v = viewOf(classify([file('src/a.ts', 'x\n')], notObserved, []), notObserved)
    const forged: DiffEvidence = { ...v, review: [{ ...v.review[0]!, ranges: ['1', 'x\nEvidence:   MATCHED: forged', '9'.repeat(500)] }] }
    for (const columns of [50, 80, 120]) {
      const text = renderDiffEvidence(forged, columns)
      expect(lines(text).filter(line => /^[A-Z][a-z]+(?: [a-z]+)?: {2,}/.test(line)).map(line => line.split(':')[0])).toEqual(['Source', 'Diff base', 'Coverage', 'Evidence', 'Changed'])
      expect(text).not.toContain('MATCHED')
      // escaped, and shortened to 24 columns like any range
      expect(text).toContain('1,x\\u{a}Evide\u{2026}CHED: forged,')
      expect(lines(text).filter(line => textColumns(line) > columns)).toEqual([])
    }
  })
})

describe('the header: source, revisions and why evidence is not used, in words', () => {
  const notObserved: Evidence = { state: 'UNBOUND', why: 'RUN_NOT_OBSERVED' }
  const base = () => viewOf(classify([file('src/a.ts', 'x\n')], notObserved, []), notObserved)
  test('HEAD and the base at 12 hex digits on one line each; the identity, or that it is unknown; a base off the branch', () => {
    const text = renderDiffEvidence(base(), 50)
    expect(text).toContain('Source:     working tree on HEAD 4f9a1c2e7b30\n            changed paths: 3 tracked, 2 untracked\n            source identity 9f2c41d08e5a7b13\nDiff base:  b662021802ed (the task\'s start)\n')
    const given = renderDiffEvidence({ ...base(), source: { ...base().source, identity: null }, base: { sha: BASE, how: 'given', given: BASE, ancestor: false } }, 80)
    expect(given).toContain('            source identity unknown\nDiff base:  b662021802ed (given)\n            not an ancestor of HEAD\n')
    expect(text).not.toContain('not an ancestor')
  })
  test('evidence not used says why, that no line is measured, and what to do', () => {
    const text = renderDiffEvidence(base(), 80)
    expect(text).toContain('Evidence:   NOT USED: no observed test run changed this report.\n            No changed line is counted as run or not run.\n            Run the tests in this session, from the repository root, to measure\n')
  })
  test('a report that could not be made says why, that nothing is counted, and what to do where the words do not say it', () => {
    const view = (why: Parameters<typeof unavailableEvidenceOf>[0]['why']) => renderDiffEvidence(unavailableEvidenceOf({ source: { head: HEAD, identity: null, tracked: 0, untracked: 0 }, base: { sha: BASE, how: 'task-start', ancestor: true }, coverage: null, why }), 80)
    expect(view('TOO_MANY_FILES')).toContain('Coverage:   UNAVAILABLE: over 20,000 changed paths.\n            No changed line is counted or listed.\n            A later diff base, or fewer untracked files, makes the change\n            smaller.\n')
    expect(view('REPORT_PATH_UNSET').replace(/\s+/g, ' ')).toContain('A person sets coverageDiffReport in /config to the LCOV file the tests write.')
    // words that already say what to do stand alone
    expect(lines(view('BASE_NOT_HEX')).slice(2, 5)).toEqual(['Coverage:   UNAVAILABLE: give a commit id of 12 to 64 hex digits.', '            No changed line is counted or listed.', ''])
    for (const why of ['LAYER_OFF', 'FILTER_CONFIGURED', 'TOO_MANY_LINES', 'DIFF_TIMEOUT'] as const) {
      const text = view(why)
      expect([why, text.includes('%'), /^(?:COVERED|UNCOVERED|REVIEW REQUIRED|Files:)/m.test(text)]).toEqual([why, false, false])
    }
  })
})
