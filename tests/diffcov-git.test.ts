import { describe, expect, test } from 'claude-code/testing'
import { DiffParseError, coverageConfigOf, isSafeGitPath, mergePatches, parseGeneratedAttributes, parseGitChanges, parsePatch, parseUntracked, reportStatOf, sourceIdentityOf } from '../hooks/diffcov-git'

const oid = (c: string) => c.repeat(40)
const rawRecord = (oldMode: string, newMode: string, status: string, paths: string[]) =>
  `:${oldMode} ${newMode} ${oid('a')} ${oid('b')} ${status}\0${paths.join('\0')}\0`

describe('Git selection parsers', () => {
  test('the NUL-delimited raw list preserves status, rename and deleted paths', () => {
    const raw = rawRecord('100644', '100644', 'M', ['src/a.ts']) + rawRecord('000000', '100644', 'A', ['src/new.ts']) + rawRecord('100644', '000000', 'D', ['src/old.ts']) + rawRecord('100644', '100644', 'R100', ['src/from.ts', 'src/to.ts'])
    const got = parseGitChanges(raw)
    expect(got.map(f => [f.path, f.status, f.kind, f.oldPath])).toEqual([
      ['src/a.ts', 'modified', 'file', null],
      ['src/new.ts', 'added', 'file', null],
      ['src/old.ts', 'deleted', 'none', null],
      ['src/to.ts', 'modified', 'file', 'src/from.ts'],
    ])
  })
  test('an unsafe, duplicate, unmerged or unterminated path refuses the whole list', () => {
    for (const raw of [
      rawRecord('100644', '100644', 'M', ['../outside']),
      rawRecord('100644', '100644', 'M', ['src/a.ts']) + rawRecord('100644', '100644', 'M', ['src/a.ts']),
      rawRecord('100644', '100644', 'U', ['src/a.ts']),
      rawRecord('100644', '100644', 'M', ['src/a.ts']).slice(0, -1),
    ]) expect(() => parseGitChanges(raw)).toThrow(DiffParseError)
  })
  test('untracked paths are all added and unsafe entries are refused', () => {
    const one = parseUntracked('src/new.ts\0')
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ path: 'src/new.ts', status: 'untracked' })
    expect(() => parseUntracked('src/../outside\0')).toThrow(DiffParseError)
  })
  test('a repository path is a key, never a path to follow', () => {
    for (const path of ['/abs', '../up', 'a/./b', 'a//b', '.git/hooks/pre-commit', 'src/*.ts', 'src/a\\b', 'src/\u0000x']) expect(isSafeGitPath(path)).toBe(false)
    for (const path of ['src/a.ts', 'src/日本語/🚀.ts', 'a/b-c_d.ts']) expect(isSafeGitPath(path)).toBe(true)
  })
})

describe('zero-context patch parser', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    '',
  ].join('\n')
  test('added and modified lines are on the new side, removed lines are counted', () => {
    const hunk = parsePatch(patch, 1)[0]!
    expect([hunk.modified, hunk.added, hunk.deletedLines, hunk.binary]).toEqual([[2, 3], [], 1, false])
    const merged = mergePatches(parseGitChanges(rawRecord('100644', '100644', 'M', ['src/a.ts'])), [hunk])
    expect(merged[0]).toMatchObject({ added: [], modified: [2, 3], deletedLines: 1, modeOnly: false })
  })
  test('a new file hunk is added even without a new-file header', () => {
    const hunk = parsePatch(['diff --git a/b b/b', '--- /dev/null', '+++ b/b', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n'), 1)[0]!
    expect([hunk.added, hunk.modified]).toEqual([[1, 2], []])
  })
  test('binary and mode-only blocks are named, not read', () => {
    const binary = parsePatch(['diff --git a/i b/i', 'new file mode 100644', 'Binary files /dev/null and b/i differ', ''].join('\n'), 1)[0]!
    expect(binary.binary).toBe(true)
    const mode = parsePatch(['diff --git a/x b/x', 'old mode 100644', 'new mode 100755', ''].join('\n'), 1)[0]!
    expect(mode.added.length + mode.modified.length + mode.deletedLines).toBe(0)
  })
  test('a block count that disagrees with the raw list refuses the whole patch', () => {
    expect(() => parsePatch(patch, 2)).toThrow(DiffParseError)
    expect(() => parsePatch('', 1)).toThrow(DiffParseError)
    expect(() => parsePatch('not a patch', 0)).toThrow(DiffParseError)
  })
  test('a hunk that claims more lines than it holds refuses', () => {
    const bad = ['diff --git a/a b/a', '@@ -1,1 +1,2 @@', '+a', ''].join('\n')
    expect(() => parsePatch(bad, 1)).toThrow(DiffParseError)
  })
})

describe('generated attribute and no-follow stat', () => {
  test('only an explicitly set linguist-generated attribute marks a path', () => {
    const got = parseGeneratedAttributes('src/a.ts\0linguist-generated\0set\0src/b.ts\0linguist-generated\0unspecified\0src/c.ts\0linguist-generated\0true\0')
    expect([...got].sort()).toEqual(['src/a.ts', 'src/c.ts'])
    expect(() => parseGeneratedAttributes('src/a.ts\0linguist-generated\0')).toThrow(DiffParseError)
  })
  test('a GNU stat record is a regular file with a hard-link count and a moving identity', () => {
    const got = reportStatOf('81a4 12 1 123 1.000000000 2.000000000 src/report.info\0')
    expect(got).toMatchObject({ kind: 'file', size: 12, links: 1, name: 'src/report.info' })
    expect(got?.identity).toBe('81a4 12 1 123 1.000000000 2.000000000')
    expect(reportStatOf('not a stat record')).toBeNull()
  })
})

describe('coverage options', () => {
  test('all three default off or empty, and a valid report path alone does not enable capture', () => {
    expect(coverageConfigOf({})).toMatchObject({ enabled: false, report: '', reportPath: { refuse: 'PATH_UNSET' }, exclude: { prefixes: [] } })
    expect(coverageConfigOf({ coverageDiffReport: 'coverage/lcov.info' })).toMatchObject({ enabled: false, reportPath: { rel: 'coverage/lcov.info' } })
    expect(coverageConfigOf({ coverageDiff: true })).toMatchObject({ enabled: true, reportPath: { refuse: 'PATH_UNSET' } })
  })
  test('the three options are exact: a non-boolean does not enable, and a bad path refuses whole', () => {
    expect(coverageConfigOf({ coverageDiff: 'true' }).enabled).toBe(false)
    expect(coverageConfigOf({ coverageDiff: true, coverageDiffReport: '../outside' }).reportPath).toEqual({ refuse: 'PATH_REFUSED' })
    expect(coverageConfigOf({ coverageDiff: true, coverageDiffExclude: 'test/,../outside' }).exclude).toEqual({ refuse: 'PATH_REFUSED' })
    expect(coverageConfigOf({ coverageDiff: true, coverageDiffExclude: 'test/,generated/' }).exclude).toEqual({ prefixes: ['test/', 'generated/'] })
  })
})

describe('source identity', () => {
  test('is content-, status- and mode-addressed, and independent of list order', async () => {
    const a = { path: 'src/a.ts', status: 'modified' as const, mode: '100644', blob: oid('a') }
    const b = { path: 'src/b.ts', status: 'added' as const, mode: '100644', blob: oid('b') }
    const one = await sourceIdentityOf([a, b])
    expect(one).toMatch(/^[0-9a-f]{64}$/)
    expect(await sourceIdentityOf([b, a])).toBe(one)
    expect(await sourceIdentityOf([a, { ...b, blob: oid('c') }])).not.toBe(one)
    expect(await sourceIdentityOf([a, { ...b, status: 'untracked' }])).not.toBe(one)
  })
})
