import { describe, expect, test } from 'claude-code/testing'
import { displayText, excludePrefixesOf, isUnderPrefix, normalizeAbsolute, reportPathOf, resolveSf, sfMatcher, utf8Length } from '../hooks/diffcov-paths'

// Diff coverage, Phase 1: a coverage report's paths are keys. These pin how every spelling resolves or is refused, by
// text alone, and how repository-chosen text is escaped before anything shows it.

const ROOT = '/work/repo'
const place = { root: ROOT, aliases: ['/link/repo'] }
const each = (cases: readonly (readonly [string, unknown])[]) => { for (const [sf, want] of cases) expect([sf, resolveSf(sf, place)]).toEqual([sf, want]) }

describe('SF values resolve to repository-relative keys or are refused', () => {
  test('the archived matrix of hostile and ordinary spellings (N20)', () => each([
    ['src/a.ts', { rel: 'src/a.ts' }],
    ['./src/a.ts', { rel: 'src/a.ts' }],
    ['src/./b/../a.ts', { rel: 'src/a.ts' }],
    ['/work/repo/src/a.ts', { rel: 'src/a.ts' }],
    ['/work/repo//src///a.ts', { rel: 'src/a.ts' }],
    ['/link/repo/src/a.ts', { rel: 'src/a.ts' }],
    ['file:///work/repo/src/a.ts', { rel: 'src/a.ts' }],
    ['file:///work/repo/src/sp%20ace.ts', { rel: 'src/sp ace.ts' }],
    ['../../../../etc/passwd', { refuse: 'SF_OUTSIDE_REPOSITORY' }],
    ['src/../../outside.ts', { refuse: 'SF_OUTSIDE_REPOSITORY' }],
    ['/etc/shadow', { refuse: 'SF_OUTSIDE_REPOSITORY' }],
    ['/work/repo/../etc/passwd', { refuse: 'SF_OUTSIDE_REPOSITORY' }],
    ['/work/repository/src/a.ts', { refuse: 'SF_OUTSIDE_REPOSITORY' }],
    ['/work/repo', { refuse: 'SF_OUTSIDE_REPOSITORY' }],
    ['.', { refuse: 'SF_OUTSIDE_REPOSITORY' }],
    ['file://host/work/repo/src/a.ts', { refuse: 'SF_URL_NOT_LOCAL' }],
    ['file:///work/repo/src%2Fa.ts', { refuse: 'SF_URL_ENCODED_SEPARATOR' }],
    ['file:///work/repo/src%5ca.ts', { refuse: 'SF_URL_ENCODED_SEPARATOR' }],
    ['file:///work/repo/a%00.ts', { refuse: 'SF_URL_ENCODED_SEPARATOR' }],
    ['file:///work/repo/src/a%07.ts', { refuse: 'SF_CONTROL_CHARACTER' }],
    ['file:///work/repo/a%zz.ts', { refuse: 'SF_URL_MALFORMED' }],
    ['file:///work/repo/a.ts?x=1', { refuse: 'SF_URL_MALFORMED' }],
    ['C:\\work\\repo\\a.ts', { refuse: 'SF_WINDOWS_PATH' }],
    ['C:/work/repo/a.ts', { refuse: 'SF_WINDOWS_PATH' }],
    ['\\\\server\\share\\a.ts', { refuse: 'SF_WINDOWS_PATH' }],
    ['//server/share/a.ts', { refuse: 'SF_WINDOWS_PATH' }],
    ['webpack:///src/a.ts', { refuse: 'SF_SCHEME' }],
    ['node:internal/x', { refuse: 'SF_SCHEME' }],
    ['data:text/plain,x', { refuse: 'SF_SCHEME' }],
    ['https://example.invalid/a.ts', { refuse: 'SF_SCHEME' }],
    ['c:a.ts', { refuse: 'SF_SCHEME' }],
    ['src\\a.ts', { refuse: 'SF_BACKSLASH' }],
    ['.git/config', { refuse: 'SF_IN_GIT_DIRECTORY' }],
    ['sub/.GIT/hooks/pre-commit', { refuse: 'SF_IN_GIT_DIRECTORY' }],
    ['/work/repo/.git/config', { refuse: 'SF_IN_GIT_DIRECTORY' }],
  ]))
  test('a relative path resolves against the root, never the shell directory: npm writes paths relative to the package root (measured)', () => {
    // a run from a subdirectory is not captured at all; here, the same text always means the same key
    expect(resolveSf('src/math.ts', { root: ROOT })).toEqual({ rel: 'src/math.ts' })
    expect(resolveSf('src/math.ts', { root: `${ROOT}/sub` })).toEqual({ rel: 'src/math.ts' })
  })
  test('a machine-wide preload outside the repository, as Node 22 writes it, is refused (measured on a real host)', () => {
    expect(resolveSf('../../../../../../opt/example/preload.cjs', place)).toEqual({ refuse: 'SF_OUTSIDE_REPOSITORY' })
  })
  test('a place that is not a clean absolute root resolves nothing', () => {
    for (const root of ['', '/', 'work/repo', '/work/repo/', '/work/./repo', '/work/x/../repo']) expect(resolveSf('src/a.ts', { root })).toEqual({ refuse: 'SF_OUTSIDE_REPOSITORY' })
    expect(resolveSf('src/a.ts', { root: ROOT, aliases: ['relative'] })).toEqual({ refuse: 'SF_OUTSIDE_REPOSITORY' })
  })
  test('aliases nested in the root, or the root in an alias, resolve nothing: they would map one directory onto another', () => {
    expect(resolveSf('/a/c/x.ts', { root: '/a/b', aliases: ['/a'] })).toEqual({ refuse: 'SF_OUTSIDE_REPOSITORY' })
    expect(resolveSf('src/x.ts', { root: '/a/b', aliases: ['/a/b/c'] })).toEqual({ refuse: 'SF_OUTSIDE_REPOSITORY' })
    expect(resolveSf('/a/b/src/x.ts', { root: '/a/b', aliases: ['/a/b'] })).toEqual({ rel: 'src/x.ts' })
  })
  test('C1 controls, NEL and the line and paragraph separators are refused, raw or percent-encoded', () => {
    for (const code of [0x80, 0x85, 0x9f, 0x2028, 0x2029]) expect(resolveSf(`src/a${String.fromCodePoint(code)}.ts`, place)).toEqual({ refuse: 'SF_CONTROL_CHARACTER' })
    expect(resolveSf('file:///work/repo/a%C2%85.ts', place)).toEqual({ refuse: 'SF_CONTROL_CHARACTER' })
    expect(resolveSf('file:///work/repo/a%E2%80%A8.ts', place)).toEqual({ refuse: 'SF_CONTROL_CHARACTER' })
  })
  test('lexical normalisation never climbs above the root of the file system', () => {
    expect(normalizeAbsolute('/../../a')).toBe('/a')
    expect(normalizeAbsolute('/a/b/../../..')).toBe('/')
    expect(normalizeAbsolute('//a//b/./c/')).toBe('/a/b/c')
  })
})

describe('the matcher answers with exact keys only', () => {
  const changed = new Map([['src/a.ts', new Set([1, 2])], ['src/Readme.ts', new Set([3])], ['src/readme.ts', new Set([4])]])
  const match = sfMatcher(changed, place)
  test('an exact path, a refusal, a case-only match naming every candidate, and nothing for an unchanged file', () => {
    expect(match('src/a.ts')).toEqual({ key: 'src/a.ts', wanted: new Set([1, 2]) })
    expect(match('/work/repo/src/a.ts')).toEqual({ key: 'src/a.ts', wanted: new Set([1, 2]) })
    expect(match('../x.ts')).toEqual({ refuse: 'SF_OUTSIDE_REPOSITORY' })
    expect(match('src/A.ts')).toEqual({ caseOf: ['src/a.ts'] })
    expect(match('src/README.ts')).toEqual({ caseOf: ['src/Readme.ts', 'src/readme.ts'] })
    expect(match('src/unchanged.ts')).toBeNull()
    expect(match('dist/a.js')).toBeNull()
  })
})

describe('the person-only options take repository-relative paths only', () => {
  test('the report path: unset is none, and anything but a plain relative path is refused, never repaired', () => {
    expect(reportPathOf('')).toEqual({ refuse: 'PATH_UNSET' })
    expect(reportPathOf('coverage/lcov.info')).toEqual({ rel: 'coverage/lcov.info' })
    for (const bad of ['-coverage.info', '--output=x', '/abs/lcov.info', '../lcov.info', 'coverage/../lcov.info', './coverage/lcov.info', 'coverage//lcov.info', 'coverage/', 'coverage\\lcov.info', 'coverage/*.info', 'cov?.info', 'cov[1].info', '{a,b}.info', '.git/lcov.info', 'x/.Git/y', ' coverage/lcov.info', 'file:lcov.info', 'a\u0007b', 'x'.repeat(4097)]) expect([bad, reportPathOf(bad)]).toEqual([bad, { refuse: 'PATH_REFUSED' }])
  })
  test('the exclusion prefixes: comma-separated, whole segments, one bad entry refuses the option', () => {
    expect(excludePrefixesOf('')).toEqual({ prefixes: [] })
    expect(excludePrefixesOf('test/, scripts')).toEqual({ prefixes: ['test/', 'scripts'] })
    expect(excludePrefixesOf('test/,../x')).toEqual({ refuse: 'PATH_REFUSED' })
    expect(excludePrefixesOf('test/,')).toEqual({ refuse: 'PATH_REFUSED' })
    expect(isUnderPrefix('test/a.ts', 'test/')).toBe(true)
    expect(isUnderPrefix('test/a.ts', 'test')).toBe(true)
    expect(isUnderPrefix('test', 'test/')).toBe(true)
    expect(isUnderPrefix('testing/a.ts', 'test')).toBe(false)
    expect(isUnderPrefix('src/test/a.ts', 'test/')).toBe(false)
  })
  test('byte length counts UTF-8 without a decoder', () => {
    expect(utf8Length('a')).toBe(1)
    expect(utf8Length('\u00e9')).toBe(2)
    expect(utf8Length('\u20ac')).toBe(3)
    expect(utf8Length('\u{1F600}')).toBe(4)
  })
})

describe('repository-chosen text is escaped before it is shown (W11)', () => {
  test('controls, format and invisible characters, and the backslash, become \\u{…}; ordinary names do not change', () => {
    expect(displayText('src/ünï café.ts')).toBe('src/ünï café.ts')
    expect(displayText('x\nEvidence: MATCHED.ts')).toBe('x\\u{a}Evidence: MATCHED.ts')
    expect(displayText('a\u001b[31mred')).toBe('a\\u{1b}[31mred')
    expect(displayText('a\u202Eb')).toBe('a\\u{202e}b')
    expect(displayText('a\u200Bb')).toBe('a\\u{200b}b')
    expect(displayText('a\u2028b\u2029c')).toBe('a\\u{2028}b\\u{2029}c')
    expect(displayText('a\u{E0041}b')).toBe('a\\u{e0041}b')
    expect(displayText('a\u{E0100}b\uFE0Fc')).toBe('a\\u{e0100}b\\u{fe0f}c')
    expect(displayText('a\u034Fb\u17B4c\u2800d\u3164e')).toBe('a\\u{34f}b\\u{17b4}c\\u{2800}d\\u{3164}e')
    expect(displayText('a\uFEFFb')).toBe('a\\u{feff}b')
    expect(displayText('lone\uD800x')).toBe('lone\\u{d800}x')
    // a literal escape in a name cannot pass for one Cockpit made
    expect(displayText('a\\u{1b}b')).toBe('a\\u{5c}u{1b}b')
  })
  test('right-to-left letters are escaped, so a path:line reads as stored; and U+180F', () => {
    const he = String.fromCodePoint(0x5d0), ar = String.fromCodePoint(0x627), presentation = String.fromCodePoint(0xfb1d)
    expect(displayText(`a${he}.ts:12`)).toBe('a\\u{5d0}.ts:12')
    expect(displayText(`${ar}${ar}/x.ts`)).toBe('\\u{627}\\u{627}/x.ts')
    expect(displayText(`x${presentation}`)).toBe('x\\u{fb1d}')
    expect(displayText(`a${String.fromCodePoint(0x180f)}b`)).toBe('a\\u{180f}b')
    expect(displayText(String.fromCodePoint(0x10800))).toBe('\\u{10800}')
  })
  test('long text is shortened in the middle by code point, never inside a surrogate pair or an escape', () => {
    const emoji = '\u{1F600}'.repeat(200)
    const short = displayText(emoji)
    expect(Array.from(short).length).toBeLessThanOrEqual(160)
    expect(short).toContain('…')
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(short)).toBe(false)
    const escapes = displayText('\u0007'.repeat(100), 40)
    expect(Array.from(escapes).length).toBeLessThanOrEqual(40)
    expect(escapes.replace('…', '')).toMatch(/^(?:\\u\{7\})+$/)
    expect(displayText('a'.repeat(160))).toBe('a'.repeat(160))
  })
})
