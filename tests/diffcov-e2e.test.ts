import { describe, expect, test } from 'claude-code/testing'
import { CAPTURES_KEPT } from '../hooks/diffcov-capture'
import type { Counts } from '../hooks/diffcov-classify'
import { register } from '../hooks/register'
import { ANSWERS, PROJECT, REPORT_PATH, ROOT, runLifecycle, violations } from './diffcov-e2e-harness'
import type { Outcome, Run, Scenario, TreeFile } from './diffcov-e2e-harness'
import { E2E_GOLDEN } from './diffcov-e2e-fixtures'
import { JEST_V8, SOURCES, VITEST_V8 } from './diffcov-fixtures'

// Diff coverage, Phase 1.6: the whole evidence lifecycle, end to end, on synthetic in-memory data. Each scenario is a
// small world (the changed files, the observed calls, what happened afterwards) run through every pure step by the
// test-only harness; each says what it expects, and every one of them must hold the same ten properties. Nothing here
// starts a process, reads a file or runs Git, and nothing registers the coverage layer.

// --- The fixture most scenarios share: one small source, and what a statement tool (Vitest, Jest's babel provider)
// reports for it after a test that called price(2, 3) only. Lines 1, 4, 7 and 9 get no entry (a declaration, a brace,
// a continued statement), line 5 is blank, line 3 never ran.
const PRICE = [
  'export function price(qty: number, unit: number): number {',
  '  if (qty <= 0) {',
  '    return 0',
  '  }',
  '',
  '  const total =',
  '    qty * unit',
  '  return total',
  '}',
].join('\n') + '\n'
const PRICE_EDITED = PRICE.replace('qty * unit', 'qty * unit * 2')
const record = (sf: string, da: string) => `TN:\nSF:${sf}\n${da.split(' ').map(d => `DA:${d}\n`).join('')}end_of_record\n`
const PRICE_LCOV = 'TN:\nSF:src/price.ts\nFN:1,price\nFNDA:1,price\nFNF:1\nFNH:1\nDA:2,1\nDA:3,0\nDA:6,1\nDA:8,1\nLF:4\nLH:3\nend_of_record\n'
const price = (over: Partial<TreeFile> = {}): TreeFile => ({ path: 'src/price.ts', status: 'untracked', text: PRICE, ...over })
const npmTest = (report: string | Uint8Array | null = PRICE_LCOV, over: Partial<Run> = {}): Run => ({ command: 'npm test', answer: ANSWERS.ok(), report, ...over })

type Expected = {
  /** The evidence as classified: bound and parsed, bound but refused by the parser, not bound, or no report at all. */
  evidence: 'BOUND' | 'REJECTED' | 'UNBOUND' | 'UNAVAILABLE'
  /** The binding's or the report's reason, where there is one. */
  why?: string
  /** What each call came to: a label recorded, or the skip that left no record. */
  calls?: string[]
  counts?: Partial<Counts>
  rows?: Record<string, string>
  uncounted?: number
  refused?: Record<string, number>
  notes?: string[]
  /** Words the rendered report must hold, each read with its whitespace folded. */
  says?: string[]
  /** Text the rendered report must not hold (a path too wide to show whole, say). */
  absent?: string[]
  /** How many records the store gives back after the runs. */
  kept?: number
}

type Case = Scenario & { expected: Expected }

const SCENARIOS: Case[] = [
  // --- Observed runs that bind
  {
    name: 'observed run, report matches',
    about: 'npm test succeeds in the foreground from the root and writes the report; nothing changes afterwards.',
    tree: [price()],
    runs: [npmTest()],
    expected: { evidence: 'BOUND', calls: ['npm test'], counts: { covered: 3, uncovered: 1, nonExecutable: 1, unavailable: 4, untrusted: 0, excluded: 0 }, says: ['Evidence: MATCHED:', 'changed during an observed run: npm test (ok)', 'COVERED 3 reported as run', 'UNCOVERED 1 reported as not run', '4 no line entry', 'src/price.ts:3 UNCOVERED reported as not run; 1 line'] },
  },
  {
    name: 'tracked change, only its changed lines',
    about: 'A modified file: only the added and modified lines Git names are classified, and the report is asked for those alone.',
    tree: [price({ status: 'modified', modified: [3, 7], added: [6] })],
    runs: [npmTest()],
    expected: { evidence: 'BOUND', counts: { covered: 1, uncovered: 1, unavailable: 1, nonExecutable: 0 }, says: ['Changed: 1 added, 2 modified, 0 deleted'] },
  },
  {
    name: 'two coverage tools, the same change',
    about: 'The measured Vitest v8 and Jest v8 reports for one fixture: a line with no entry is UNAVAILABLE under one and UNCOVERED under the other, never NON-EXECUTABLE.',
    tree: [{ path: 'src/multi.ts', status: 'untracked', text: SOURCES['src/multi.ts']! }],
    runs: [npmTest(VITEST_V8)],
    expected: { evidence: 'BOUND', counts: { uncovered: 3, unavailable: 7, nonExecutable: 0, covered: 0 } },
  },
  {
    name: 'the same change under Jest v8',
    about: 'Jest v8 gives every line an entry, so the function that never ran is UNCOVERED throughout.',
    tree: [{ path: 'src/multi.ts', status: 'untracked', text: SOURCES['src/multi.ts']! }],
    runs: [{ command: 'npx jest', answer: ANSWERS.ok(), report: JEST_V8 }],
    expected: { evidence: 'BOUND', calls: ['npx jest'], counts: { uncovered: 10, unavailable: 0 } },
  },
  {
    name: 'a rerun after an edit left identical bytes',
    about: 'The source is edited between two runs and the second run rewrites the same bytes: MATCHED to the second run, with the note that the bytes did not change.',
    tree: [price()],
    runs: [npmTest(), npmTest(PRICE_LCOV, { editsBefore: { path: 'src/price.ts', text: PRICE_EDITED } })],
    expected: { evidence: 'BOUND', calls: ['npm test', 'npm test'], notes: ['BYTES_UNCHANGED_BY_RUN'], says: ['Note: The run left the report\'s bytes as they were'] },
  },
  // --- Stale evidence
  {
    name: 'source edited after the run',
    about: 'The run is recorded, then a source changes: the report describes another source and is not used.',
    tree: [price()],
    runs: [npmTest()],
    after: { editSource: { path: 'src/price.ts', text: PRICE_EDITED } },
    expected: { evidence: 'UNBOUND', why: 'SOURCE_CHANGED_SINCE_RUN', counts: { covered: 0, uncovered: 0, unavailable: 8, nonExecutable: 1 }, says: ['NOT USED: the source changed after the run.', 'No changed line is counted as run or not run.', 'Run the tests again in this session'] },
  },
  {
    name: 'source edited during the run',
    about: 'The command itself changes a source while it runs: the run is not recorded at all.',
    tree: [price()],
    runs: [npmTest(PRICE_LCOV, { editsDuringRun: { path: 'src/price.ts', text: PRICE_EDITED } })],
    expected: { evidence: 'UNBOUND', why: 'RUN_NOT_OBSERVED', calls: ['SOURCE_CHANGED_DURING_RUN'] },
  },
  {
    name: 'source moved while the report was made',
    about: 'The source identity measured after the report\'s reads differs from the one before them.',
    tree: [price()],
    runs: [npmTest()],
    after: { sourceMovesDuringReport: true },
    expected: { evidence: 'UNBOUND', why: 'SOURCE_CHANGED_DURING_REPORT', says: ['the source changed while this report was made'] },
  },
  {
    name: 'report rewritten after the run',
    about: 'Something writes the report again after the observed run, claiming line 3 ran: those bytes were never measured.',
    tree: [price()],
    runs: [npmTest()],
    after: { rewriteReport: PRICE_LCOV.replace('DA:3,0', 'DA:3,1') },
    expected: { evidence: 'UNBOUND', why: 'REPORT_CHANGED_SINCE_RUN', counts: { covered: 0, uncovered: 0 }, says: ['the report changed after the run'] },
  },
  {
    name: 'a failed run after a good one',
    about: 'A later run fails but still writes a report: the failure leaves no record, and the report it left is not the recorded one.',
    tree: [price()],
    runs: [npmTest(), npmTest(PRICE_LCOV.replace('DA:3,0', 'DA:3,1'), { answer: ANSWERS.failed() })],
    expected: { evidence: 'UNBOUND', why: 'REPORT_CHANGED_SINCE_RUN', calls: ['npm test', 'DID_NOT_SUCCEED'] },
  },
  {
    name: 'a flood of runs pushes the matching record out',
    about: `${CAPTURES_KEPT + 1} recorded runs, each leaving different bytes; then the first run's bytes are written back. Only ${CAPTURES_KEPT} records are kept, so none holds them.`,
    tree: [price()],
    runs: Array.from({ length: CAPTURES_KEPT + 1 }, (_, k) => npmTest(`# run ${k}\n${PRICE_LCOV}`)),
    after: { rewriteReport: `# run 0\n${PRICE_LCOV}` },
    expected: { evidence: 'UNBOUND', why: 'REPORT_CHANGED_SINCE_RUN', kept: CAPTURES_KEPT },
  },
  // --- Runs that are never recorded
  {
    name: 'no observed run',
    about: 'A report is present but no test run was observed in this session.',
    tree: [price()],
    runs: [],
    after: { rewriteReport: PRICE_LCOV },
    expected: { evidence: 'UNBOUND', why: 'RUN_NOT_OBSERVED', says: ['NOT USED: no observed test run changed this report.', 'Run the tests in this session, from the repository root'] },
  },
  {
    name: 'commands that are not recorded',
    about: 'Each command writes the report and succeeds, but none is a plain, listed test command that keeps its root.',
    tree: [price()],
    runs: ['make test', 'vitest; cp old.info coverage/lcov.info', 'npm run build', 'npm test --prefix=sub', 'CI=1 npm test', 'c8 node --test'].map(command => npmTest(PRICE_LCOV, { command })),
    expected: { evidence: 'UNBOUND', why: 'RUN_NOT_OBSERVED', calls: ['NOT_A_LISTED_TEST_PROGRAM', 'NOT_PLAIN_WORDS', 'NOT_A_TEST_COMMAND', 'MOVES_THE_TOOL_ROOT', 'NOT_A_LISTED_TEST_PROGRAM', 'NOT_A_LISTED_TEST_PROGRAM'] },
  },
  {
    name: 'a failed run',
    about: 'The tests fail; the report they wrote is not evidence of anything Cockpit observed succeed.',
    tree: [price()],
    runs: [npmTest(PRICE_LCOV, { answer: ANSWERS.failed() })],
    expected: { evidence: 'UNBOUND', why: 'RUN_NOT_OBSERVED', calls: ['DID_NOT_SUCCEED'] },
  },
  {
    name: 'an interrupted run',
    about: 'The person interrupts the tests partway.',
    tree: [price()],
    runs: [npmTest(PRICE_LCOV, { answer: ANSWERS.interrupted() })],
    expected: { evidence: 'UNBOUND', why: 'RUN_NOT_OBSERVED', calls: ['INTERRUPTED'] },
  },
  {
    name: 'backgrounded runs',
    about: 'One call asks for the background; another is moved there by the host after it started.',
    tree: [price()],
    runs: [npmTest(PRICE_LCOV, { call: { run_in_background: true } }), npmTest(PRICE_LCOV, { answer: ANSWERS.backgrounded() })],
    expected: { evidence: 'UNBOUND', why: 'RUN_NOT_OBSERVED', calls: ['BACKGROUND', 'BACKGROUNDED'] },
  },
  {
    name: 'timed out, refused, unrecognised, a helper, outside the root',
    about: 'Five more ways a call is not a successful foreground run of the main session in the repository root.',
    tree: [price()],
    runs: [
      npmTest(PRICE_LCOV, { answer: ANSWERS.timedOut() }), npmTest(PRICE_LCOV, { answer: ANSWERS.refused() }), npmTest(PRICE_LCOV, { answer: ANSWERS.unrecognised() }),
      npmTest(PRICE_LCOV, { call: { agentId: 'helper-1' } }), npmTest(PRICE_LCOV, { cwd: `${ROOT}/src` }),
    ],
    expected: { evidence: 'UNBOUND', why: 'RUN_NOT_OBSERVED', calls: ['TIMED_OUT', 'REFUSED', 'RESULT_UNRECOGNISED', 'HELPER_AGENT', 'OUTSIDE_REPOSITORY_ROOT'] },
  },
  {
    name: 'a run that wrote no report',
    about: 'The tests succeed but write no coverage: nothing to record, and nothing at the report path.',
    tree: [price()],
    runs: [npmTest(null)],
    expected: { evidence: 'UNBOUND', why: 'REPORT_MISSING', calls: ['REPORT_MISSING'], says: ['there is no report at the configured path', 'Check the coverageDiffReport path'] },
  },
  // --- Reports that cannot be read or parsed
  {
    name: 'report cut short',
    about: 'The recorded run left a report that ends inside a record: refused whole, never read in part.',
    tree: [price()],
    runs: [npmTest('TN:\nSF:src/price.ts\nDA:2,1\nDA:3,0\n')],
    columns: 64,
    expected: { evidence: 'REJECTED', why: 'UNTERMINATED_RECORD', counts: { covered: 0, uncovered: 0, unavailable: 8 }, says: ['the report was refused (a record that does not end, line 4)', 'it may have been cut short'] },
  },
  {
    name: 'report with a damaged line',
    about: 'A line that is not LCOV in an otherwise good report.',
    tree: [price()],
    runs: [npmTest(PRICE_LCOV.replace('DA:6,1\n', 'DA:6,1\ngarbage\n'))],
    expected: { evidence: 'REJECTED', why: 'MALFORMED', says: ['a malformed line, line 10'] },
  },
  {
    name: 'report that is not UTF-8',
    about: 'A path in the report holds a byte that is not UTF-8.',
    tree: [price()],
    runs: [npmTest(new Uint8Array([...new TextEncoder().encode('TN:\nSF:src/pr'), 0xe9, ...new TextEncoder().encode('ce.ts\nDA:1,1\nend_of_record\n')]))],
    expected: { evidence: 'REJECTED', why: 'NOT_UTF8' },
  },
  {
    name: 'report with a bad line entry',
    about: 'A DA line numbering line 0.',
    tree: [price()],
    runs: [npmTest(PRICE_LCOV.replace('DA:2,1', 'DA:0,1'))],
    expected: { evidence: 'REJECTED', why: 'BAD_DA' },
  },
  ...(['link', 'hard-linked', 'changes-while-read', 'linked-parent'] as const).map((kind): Case => ({
    name: `the reader refuses the report: ${kind}`,
    about: 'What a no-follow stat finds at the report path, before and after the read, decides whether its bytes may be parsed.',
    tree: [price()],
    runs: [npmTest()],
    after: { reportKind: kind },
    expected: { evidence: 'UNBOUND', why: { link: 'REPORT_NOT_A_REGULAR_FILE', 'hard-linked': 'REPORT_HARD_LINKED', 'changes-while-read': 'REPORT_CHANGED_WHILE_READ', 'linked-parent': 'REPORT_LINKED_DIRECTORY' }[kind] },
  })),
  // --- Paths and files
  {
    name: 'report paths outside the repository',
    about: 'Records whose paths leave the root, use another host or scheme, a Windows path or .git are refused and counted; one of them claims line 3 ran and changes nothing.',
    tree: [price(), { path: 'src/other.ts', status: 'untracked', text: 'export const other = 1\n' }],
    runs: [npmTest([
      PRICE_LCOV, record('/elsewhere/src/price.ts', '3,1'), record('../outside/x.ts', '1,1'), record('src/../../etc/x.ts', '1,1'), record('/elsewhere/src/other.ts', '1,1'),
      record('file://host/work/repo/src/price.ts', '3,1'), record('C:\\work\\repo\\src\\price.ts', '3,1'), record('https://example.com/src/price.ts', '3,1'), record('.git/hooks/pre-commit.js', '1,1'),
    ].join(''))],
    expected: { evidence: 'BOUND', counts: { covered: 3, uncovered: 1, unavailable: 5 }, refused: { SF_OUTSIDE_REPOSITORY: 4, SF_URL_NOT_LOCAL: 1, SF_WINDOWS_PATH: 1, SF_SCHEME: 1, SF_IN_GIT_DIRECTORY: 1 }, says: ['src/other.ts:1 UNAVAILABLE no record for this file in the report', 'Records not used:'] },
  },
  {
    name: 'generated, excluded and out-of-scope files',
    about: 'A marker, an attribute, the exclusion option and a Markdown file each exclude every changed line of their file, though the report claims them all run.',
    tree: [
      price(),
      { path: 'src/schema.gen.ts', status: 'untracked', text: '// Code generated by protoc. DO NOT EDIT.\nexport const schema = 1\n' },
      { path: 'src/client.ts', status: 'untracked', text: 'export const client = 1\n', generatedByAttribute: true },
      { path: 'test/price.test.ts', status: 'untracked', text: 'price(2, 3)\n' },
      { path: 'docs/notes.md', status: 'untracked', text: 'notes\n' },
    ],
    runs: [npmTest(PRICE_LCOV + record('src/schema.gen.ts', '1,1 2,1') + record('src/client.ts', '1,1') + record('test/price.test.ts', '1,1'))],
    exclude: 'test/',
    expected: { evidence: 'BOUND', counts: { covered: 3, excluded: 5 }, rows: { 'src/schema.gen.ts': 'GENERATED_MARKER', 'src/client.ts': 'GENERATED_ATTRIBUTE', 'test/price.test.ts': 'CONFIGURED_EXCLUSION', 'docs/notes.md': 'FILE_TYPE_OUT_OF_SCOPE' }, says: ['a generated-file marker on this line excludes every changed line of the file'] },
  },
  {
    name: 'deleted and untracked files',
    about: 'A deleted file has removed lines and nothing to measure; an untracked file is all changed lines; a changed link has a row and no lines.',
    tree: [
      price({ status: 'modified', modified: [3], added: [6] }),
      { path: 'src/old.ts', status: 'deleted', deletedLines: 4 },
      { path: 'src/new.ts', status: 'untracked', text: 'export const n = (): number => 1\n' },
      { path: 'bin/tool', status: 'modified', kind: 'symlink', text: '../scripts/tool.sh' },
    ],
    runs: [npmTest(PRICE_LCOV + record('src/new.ts', '1,0'))],
    expected: { evidence: 'BOUND', counts: { covered: 1, uncovered: 2 }, rows: { 'src/old.ts': 'DELETED', 'src/new.ts': 'CLASSIFIED', 'bin/tool': 'SYMLINK' }, says: ['Changed: 2 added, 1 modified, 4 deleted'] },
  },
  {
    name: 'source that is not UTF-8',
    about: 'A Latin-1 file and a file with a NUL byte Git compared as text: neither is read, both are named in Uncounted, and the report\'s claim about one is never used. A real binary stays binary.',
    tree: [
      price(),
      { path: 'src/legacy.ts', status: 'modified', modified: [1], bytes: new Uint8Array([0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]) },
      { path: 'src/blob.ts', status: 'modified', modified: [1], bytes: new Uint8Array([0x78, 0x00, 0x0a]) },
      { path: 'img/logo.png', status: 'modified', binaryPatch: true, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]) },
    ],
    runs: [npmTest(PRICE_LCOV + record('src/legacy.ts', '1,1'))],
    expected: { evidence: 'BOUND', counts: { covered: 3 }, uncounted: 2, rows: { 'src/legacy.ts': 'SOURCE_NOT_UTF8', 'src/blob.ts': 'SOURCE_HAS_NUL', 'img/logo.png': 'BINARY' }, says: ['Uncounted: 2 files whose changed lines could not be classified', 'NOT COUNTED not read: not UTF-8 text'] },
  },
  {
    name: 'a report in doubt',
    about: 'The report names one file only by different letter case, gives another lines past its end, and names a third two ways: their lines are UNTRUSTED, never measured.',
    tree: [price(), { path: 'src/b.ts', status: 'untracked', text: 'x\ny\n' }, { path: 'src/c.ts', status: 'untracked', text: 'a\nb\n' }],
    runs: [npmTest(record('src/Price.ts', '2,1 3,1') + record('src/b.ts', '1,1 9,1') + record('src/c.ts', '1,1') + record(`${ROOT}/src/c.ts`, '2,1'))],
    expected: { evidence: 'BOUND', counts: { covered: 0, uncovered: 0, untrusted: 12, nonExecutable: 1 }, says: ['the report names this file with different letter case', 'the report has lines this file does not have', 'the report names this file two ways'] },
  },
  // --- The store
  ...([
    ['a field no record has', (s: { captures: Record<string, unknown>[] }) => { s.captures[0]!['command'] = 'npm test'; return s }],
    ['a hash in capitals', (s: { captures: Record<string, unknown>[] }) => { (s.captures[0]!['report'] as Record<string, unknown>)['sha256'] = String((s.captures[0]!['report'] as Record<string, unknown>)['sha256']).toUpperCase(); return s }],
    ['another project', (s: { captures: Record<string, unknown>[] }) => { s.captures[0]!['project'] = 'f'.repeat(32); return s }],
    ['a time past 2100', (s: { captures: Record<string, unknown>[] }) => { s.captures[0]!['at'] = Date.UTC(2200, 0, 1); return s }],
    ['an outcome other than ok', (s: { captures: Record<string, unknown>[] }) => { s.captures[0]!['outcome'] = 'failed'; return s }],
    ['an identity that is not a hash', (s: { captures: Record<string, unknown>[] }) => { s.captures[0]!['identity'] = 'unknown'; return s }],
    ['a store of another version', (s: { v: unknown }) => { s.v = 2; return s }],
    ['captures that are not a list', (s: { captures: unknown }) => { s.captures = { 0: s.captures }; return s }],
  ] as const).map(([what, tamper]): Case => ({
    name: `stored record damaged: ${what}`,
    about: 'A record read back from the store that is not exactly what captureRecordOf writes is dropped, never repaired: binding fails closed.',
    tree: [price()],
    runs: [npmTest()],
    after: { tamperStore: tamper as (stored: { v: unknown; captures: Record<string, unknown>[] }) => unknown },
    expected: { evidence: 'UNBOUND', why: 'RUN_NOT_OBSERVED' },
  })),
  {
    name: 'stored records: a damaged older one beside a good newer one',
    about: 'Dropping is per record: the newer, intact record still binds.',
    tree: [price()],
    runs: [npmTest(`# first\n${PRICE_LCOV}`), npmTest()],
    after: { tamperStore: s => { s.captures[1]!['command'] = 'npm test'; return s } },
    expected: { evidence: 'BOUND', calls: ['npm test', 'npm test'], kept: 1 },
  },
  // --- Output bounds and limits
  {
    name: 'wide characters, a narrow terminal, page 2',
    about: 'Twenty-five files under CJK, fullwidth and emoji names, drawn at 50 columns: the second page of each list.',
    tree: Array.from({ length: 25 }, (_, k) => ({ path: `src/\u{6a21}\u{5757}-${String(k).padStart(2, '0')}/\u{30c6}\u{30b9}\u{30c8}\u{2705}\u{ff21}\u{1F680}.ts`, status: 'untracked' as const, text: 'export const v = 1\n' })),
    runs: [npmTest(Array.from({ length: 25 }, (_, k) => record(`src/\u{6a21}\u{5757}-${String(k).padStart(2, '0')}/\u{30c6}\u{30b9}\u{30c8}\u{2705}\u{ff21}\u{1F680}.ts`, `1,${k % 2}`)).join(''))],
    columns: 50,
    page: 2,
    expected: { evidence: 'BOUND', counts: { covered: 12, uncovered: 13 }, says: ['Page 2 of 2', 'Files: 25 files; 21 to 25 on this page', 'REVIEW REQUIRED: 13 entries, all on page 1'] },
  },
  {
    name: 'a wide path wider than the terminal',
    about: 'A path of sixty columns of CJK characters, drawn at 50 columns: shortened in the middle in the review list and in Files, never past the edge.',
    tree: [{ path: `src/${'\u{6df1}\u{5c42}'.repeat(15)}/\u{1F680}.ts`, status: 'untracked', text: 'export const deep = 1\n' }],
    runs: [npmTest(record(`src/${'\u{6df1}\u{5c42}'.repeat(15)}/\u{1F680}.ts`, '1,0'))],
    columns: 50,
    expected: { evidence: 'BOUND', counts: { uncovered: 1 }, says: ['\u{2026}', 'UNCOVERED reported as not run; 1 line'], absent: [`src/${'\u{6df1}\u{5c42}'.repeat(15)}`] },
  },
  {
    name: 'workload past the changed-line limit',
    about: 'More changed lines than the limit (lowered to 8 here; its real value has its own tests): nothing is classified, and the report says why, in the words of the production limit it names.',
    tree: [price()],
    runs: [npmTest()],
    limits: { maxChangedLines: 8 },
    expected: { evidence: 'UNAVAILABLE', why: 'TOO_MANY_LINES', says: ['Coverage: UNAVAILABLE: over 200,000 changed lines.', 'No changed line is counted or listed.'] },
  },
  {
    name: 'workload past the path limit',
    about: 'More changed paths than the limit (lowered to 1 here).',
    tree: [price(), { path: 'src/b.ts', status: 'untracked', text: 'x\n' }],
    runs: [npmTest()],
    limits: { maxFiles: 1 },
    expected: { evidence: 'UNAVAILABLE', why: 'TOO_MANY_FILES' },
  },
  {
    name: 'one file past the per-file line limit',
    about: 'A file over the per-file limit (lowered to 5 here) is not read; the rest of the change is classified.',
    tree: [price(), { path: 'src/b.ts', status: 'untracked', text: 'x\n' }],
    runs: [npmTest(PRICE_LCOV + record('src/b.ts', '1,1'))],
    limits: { maxSourceLines: 5 },
    expected: { evidence: 'BOUND', counts: { covered: 1 }, uncounted: 1, rows: { 'src/price.ts': 'SOURCE_TOO_MANY_LINES' } },
  },
  {
    name: 'an exclusion option that is not a plain prefix',
    about: 'The person\'s coverageDiffExclude leaves the repository: refused whole, never repaired.',
    tree: [price()],
    runs: [npmTest()],
    exclude: 'test/,../outside',
    expected: { evidence: 'UNAVAILABLE', why: 'EXCLUDE_REFUSED', says: ['coverageDiffExclude holds an entry that is not a plain repository-relative prefix'] },
  },
]

const fold = (text: string) => text.replace(/\s+/g, ' ')
const callOf = (call: Outcome['calls'][number]): string =>
  'skip' in call.before ? call.before.skip : call.after !== null && 'skip' in call.after ? call.after.skip : call.record !== null && 'skip' in call.record ? call.record.skip : call.before.label

/** One outcome per scenario, computed once: every describe below reads the same runs. */
const outcomes = new Map<string, Promise<Outcome>>()
const outcome = (s: Case) => { if (!outcomes.has(s.name)) outcomes.set(s.name, runLifecycle(s)); return outcomes.get(s.name)! }

describe('every scenario, step by step: what each call came to, how the report bound, and what was counted', () => {
  test('the scenarios are distinct and each is described', () => {
    expect(new Set(SCENARIOS.map(s => s.name)).size).toBe(SCENARIOS.length)
    for (const s of SCENARIOS) expect([s.name, s.about.length > 20]).toEqual([s.name, true])
  })
  for (const s of SCENARIOS) {
    test(s.name, async () => {
      const o = await outcome(s)
      const e = s.expected
      const state = o.view.state === 'UNAVAILABLE' ? 'UNAVAILABLE' : o.evidence.state
      const why = o.view.state === 'UNAVAILABLE' ? o.view.why : o.evidence.state === 'UNBOUND' ? o.evidence.why : o.evidence.state === 'REJECTED' ? o.evidence.code : undefined
      expect([s.name, state, e.why === undefined ? undefined : why]).toEqual([s.name, e.evidence, e.why])
      if (e.calls !== undefined) expect([s.name, o.calls.map(callOf)]).toEqual([s.name, e.calls])
      if (e.counts !== undefined) expect([s.name, o.view.counts]).toEqual([s.name, expect.objectContaining(e.counts)])
      if (e.rows !== undefined) for (const [path, reason] of Object.entries(e.rows)) expect([s.name, path, o.view.files.find(f => f.path === path)?.reason]).toEqual([s.name, path, reason])
      if (e.uncounted !== undefined) expect([s.name, /^Uncounted: {2}(\d+) /m.exec(o.text)?.[1]]).toEqual([s.name, String(e.uncounted)])
      if (e.refused !== undefined) expect([s.name, o.view.refusedRecords]).toEqual([s.name, e.refused])
      if (e.notes !== undefined) expect([s.name, o.binding.state === 'BOUND' ? o.binding.notes : null]).toEqual([s.name, e.notes])
      for (const words of e.says ?? []) expect([s.name, fold(o.text).includes(words)]).toEqual([s.name, true])
      for (const words of e.absent ?? []) expect([s.name, o.text.includes(words)]).toEqual([s.name, false])
      if (e.kept !== undefined) expect([s.name, o.kept.length]).toEqual([s.name, e.kept])
    })
  }
})

describe('every scenario holds every property (P1 to P10)', () => {
  for (const s of SCENARIOS) test(s.name, async () => expect([s.name, await violations(await outcome(s))]).toEqual([s.name, []]))
})

describe('properties that cut across the scenarios', () => {
  test('the scenarios reach every evidence state, every call outcome and every file rule they claim to', async () => {
    const all = await Promise.all(SCENARIOS.map(outcome))
    const states = new Set(all.map(o => (o.view.state === 'UNAVAILABLE' ? 'UNAVAILABLE' : o.evidence.state)))
    expect([...states].sort()).toEqual(['BOUND', 'REJECTED', 'UNAVAILABLE', 'UNBOUND'])
    const calls = new Set(all.flatMap(o => o.calls.map(callOf)))
    for (const skip of ['DID_NOT_SUCCEED', 'INTERRUPTED', 'BACKGROUND', 'BACKGROUNDED', 'TIMED_OUT', 'REFUSED', 'RESULT_UNRECOGNISED', 'HELPER_AGENT', 'OUTSIDE_REPOSITORY_ROOT', 'NOT_PLAIN_WORDS', 'NOT_A_LISTED_TEST_PROGRAM', 'NOT_A_TEST_COMMAND', 'MOVES_THE_TOOL_ROOT', 'SOURCE_CHANGED_DURING_RUN', 'REPORT_MISSING']) expect([skip, calls.has(skip)]).toEqual([skip, true])
    const reasons = new Set<string>(all.flatMap(o => o.view.files.map(f => f.reason)))
    for (const reason of ['CLASSIFIED', 'DELETED', 'SYMLINK', 'BINARY', 'SOURCE_NOT_UTF8', 'SOURCE_HAS_NUL', 'SOURCE_TOO_MANY_LINES', 'GENERATED_MARKER', 'GENERATED_ATTRIBUTE', 'CONFIGURED_EXCLUSION', 'FILE_TYPE_OUT_OF_SCOPE']) expect([reason, reasons.has(reason)]).toEqual([reason, true])
    const categories = new Set(all.flatMap(o => (o.classification !== null && !('refuse' in o.classification) ? o.classification.lines.map(v => v.category) : [])))
    expect([...categories].sort()).toEqual(['COVERED', 'EXCLUDED', 'NON_EXECUTABLE', 'UNAVAILABLE', 'UNCOVERED', 'UNTRUSTED'])
  })
  test('evidence that is not used never reads as measured: no figure, no MATCHED, and "-" where a count would stand', async () => {
    for (const s of SCENARIOS) {
      const o = await outcome(s)
      if (o.evidence.state === 'BOUND' && o.view.state === 'REPORTED') continue
      expect([s.name, o.view.counts.covered, o.view.counts.uncovered, /MATCHED|reported as run|changed during an observed run/.test(o.text)]).toEqual([s.name, 0, 0, false])
      if (o.view.state === 'REPORTED') expect([s.name, /^COVERED +- {2}not measured$/m.test(o.text)]).toEqual([s.name, true])
    }
  })
  test('the same world gives the same report: every scenario run twice, from scratch, is identical', async () => {
    for (const s of SCENARIOS) {
      const [one, two] = [await runLifecycle(s), await runLifecycle(s)]
      expect([s.name, two.text, two.storedJson, JSON.stringify(two.view)]).toEqual([s.name, one.text, one.storedJson, JSON.stringify(one.view)])
    }
  })
  test('a record holds the closed label only: a script name, an argument or output never reaches the store', async () => {
    const o = await runLifecycle({ name: 'script', about: 'npm run with a script name and arguments', tree: [price()], runs: [{ command: 'npm run test:unit -- --coverage --reporter=dot', answer: ANSWERS.ok(), report: PRICE_LCOV }] })
    expect(o.calls.map(callOf)).toEqual(['npm run (a script)'])
    expect(o.binding.state).toBe('BOUND')
    for (const text of ['test:unit', '--coverage', '--reporter', '12 passed', 'DA:', 'price.ts']) expect([text, o.storedJson.includes(text)]).toEqual([text, false])
    expect(JSON.parse(o.storedJson).captures[0].label).toBe('npm run (a script)')
  })
})

/** The lifecycles pinned whole, by fixture key: the scenario each renders. */
const PINNED: Record<string, string> = {
  'observed-run-80': 'observed run, report matches',
  'source-edited-80': 'source edited after the run',
  'report-cut-short-64': 'report cut short',
  'not-utf8-80': 'source that is not UTF-8',
  'wide-page-2-50': 'wide characters, a narrow terminal, page 2',
  'workload-80': 'workload past the changed-line limit',
}
describe('golden end-to-end renderings: the whole report of a few lifecycles, line for line', () => {
  const pinned = PINNED
  test('each pinned lifecycle renders exactly as pinned', async () => {
    expect(Object.keys(E2E_GOLDEN).sort()).toEqual(Object.keys(pinned).sort())
    for (const [key, name] of Object.entries(pinned)) {
      const o = await outcome(SCENARIOS.find(s => s.name === name)!)
      const want = E2E_GOLDEN[key]!.split('\n'), got = o.text.split('\n')
      for (let k = 0; k < Math.max(want.length, got.length); k++) expect([key, k + 1, got[k]]).toEqual([key, k + 1, want[k]])
    }
  })
})

describe('the advisory layer stays outside the runtime', () => {
  // Cockpit's own registration, against a stub `on`, as tests/compliance.test.ts reads it. A deliberate tripwire: the day
  // Phase 3 registers the layer (or anything else names coverage), this test must change with it, by decision
  const registered = (options: Record<string, unknown>): string[] => {
    const seen: string[] = []
    const on = ((pattern: string, arg2?: unknown) => {
      seen.push(`${pattern} ${typeof arg2 === 'function' ? '' : JSON.stringify(arg2) ?? ''}`)
      return { catch: () => {} }
    }) as never
    register(on, options as never)
    return seen.sort()
  }
  test('no registration names the coverage layer, and its planned options change nothing that registers', () => {
    const plain = registered({})
    expect(plain.length).toBeGreaterThan(0)
    expect(plain.filter(entry => /coverage|diffcov/i.test(entry))).toEqual([])
    // the Phase 3 options do not exist yet: passing them registers exactly what not passing them does
    expect(registered({ coverageDiff: true, coverageDiffReport: REPORT_PATH, coverageDiffExclude: 'test/' })).toEqual(plain)
    for (const options of [{ orchestration: true }, { cobaltStrict: true }]) expect(registered(options).filter(entry => /coverage|diffcov/i.test(entry))).toEqual([])
  })
  test('the lifecycle hands back a report and nothing else: no gate, DONE, review or release field anywhere in it', async () => {
    const o = await outcome(SCENARIOS[0]!)
    const keys = new Set<string>()
    const walk = (value: unknown) => { if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v) } }
    walk(o.view)
    walk(JSON.parse(o.storedJson))
    expect([...keys].filter(k => /gate|done|review(?!$)|release|verdict|pass/i.test(k))).toEqual([])
    expect(o.storedJson.includes(PROJECT)).toBe(true)
  })
})
