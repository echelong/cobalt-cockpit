// Diff coverage (v0.7.0, Phase 1: not registered, nothing calls it yet). Paths a coverage report names are keys, never
// files to open: each `SF:` value is normalised by its text alone and either matched, exactly, against the paths Git
// listed as changed, or refused with a reason. Nothing here touches the file system, so a hostile report can make a
// record unmatched or refused, never make Cockpit read, stat or resolve anything it names.
//
// Also the person-only options' path values (the one report path, the exclusion prefixes), and the escaping every
// repository-chosen text gets before it is shown.

/** Why an `SF:` value was not used. Each is counted by reason; none is shown with the value itself. */
export type SfRefusal =
  | 'SF_URL_NOT_LOCAL'
  | 'SF_URL_ENCODED_SEPARATOR'
  | 'SF_URL_MALFORMED'
  | 'SF_WINDOWS_PATH'
  | 'SF_SCHEME'
  | 'SF_BACKSLASH'
  | 'SF_CONTROL_CHARACTER'
  | 'SF_OUTSIDE_REPOSITORY'
  | 'SF_IN_GIT_DIRECTORY'

/**
 * Where a report's paths are resolved: the verified repository root, absolute and normalised, and other absolute
 * spellings of it the session itself established (the session directory before `realpath`, say). Relative `SF:` values
 * resolve against the root only: `$.session.cwd()` follows the shell's `cd`, while `npm` runs a script from the package
 * root and writes paths relative to it (measured), so no other directory can be told apart from a guess.
 */
export type Place = { root: string; aliases?: readonly string[] }

/** What the parser does with one record: keep its entries for a changed path, refuse it, mark a case-only match, or ignore it. */
export type SfMatch = { key: string; wanted: ReadonlySet<number> } | { refuse: SfRefusal } | { caseOf: readonly string[] } | null

/**
 * `path.posix.normalize` for an absolute path, by text alone: `.` and empty segments dropped, `..` taking one segment
 * off, never above `/`. No file system call, so a link in the path is not followed (and cannot be).
 */
export const normalizeAbsolute = (path: string): string => {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }

  return `/${out.join('/')}`
}

/** A root a place can hold: absolute, already normalised, not `/` itself. */
const isRoot = (path: string): boolean => path.startsWith('/') && path !== '/' && normalizeAbsolute(path) === path

const CONTROL = /[\u0000-\u001f\u007f]/
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

/**
 * One `SF:` value as a repository-relative path, or why it is refused. The rules apply in order and the first that
 * applies decides (docs/design-v0.7.0-diff-aware-verification.md, "Paths in a report").
 */
export const resolveSf = (sf: string, place: Place): { rel: string } | { refuse: SfRefusal } => {
  const roots = [place.root, ...(place.aliases ?? [])]
  // a place that is not a clean absolute root resolves nothing: every record is refused, never matched by accident
  if (!roots.every(isRoot)) return { refuse: 'SF_OUTSIDE_REPOSITORY' }
  let path = sf
  if (/^file:/i.test(path)) {
    if (!path.startsWith('file:///')) return { refuse: 'SF_URL_NOT_LOCAL' }
    if (/%(?:00|2f|5c)/i.test(path)) return { refuse: 'SF_URL_ENCODED_SEPARATOR' }
    // a query or fragment is not part of a path, and a stray `%` is not an escape: neither is guessed at
    if (/[?#]/.test(path)) return { refuse: 'SF_URL_MALFORMED' }
    try {
      path = decodeURIComponent(path.slice('file://'.length))
    } catch {
      return { refuse: 'SF_URL_MALFORMED' }
    }
  } else if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('//')) {
    return { refuse: 'SF_WINDOWS_PATH' }
  } else if (SCHEME.test(path)) {
    // webpack://, node:, data:, http:, and a drive-relative `c:x`
    return { refuse: 'SF_SCHEME' }
  }
  if (path.includes('\\')) return { refuse: 'SF_BACKSLASH' }
  // reachable through percent-decoding only: the parser refuses a raw control byte in any line
  if (CONTROL.test(path)) return { refuse: 'SF_CONTROL_CHARACTER' }
  let absolute: string
  if (path.startsWith('/')) {
    const normal = normalizeAbsolute(path)
    const root = roots.find(r => normal === r || normal.startsWith(`${r}/`))
    if (root === undefined) return { refuse: 'SF_OUTSIDE_REPOSITORY' }
    absolute = place.root + normal.slice(root.length)
  } else {
    absolute = normalizeAbsolute(`${place.root}/${path}`)
  }
  if (absolute === place.root || !absolute.startsWith(`${place.root}/`)) return { refuse: 'SF_OUTSIDE_REPOSITORY' }
  const rel = absolute.slice(place.root.length + 1)
  if (rel.split('/').some(part => part.toLowerCase() === '.git')) return { refuse: 'SF_IN_GIT_DIRECTORY' }

  return { rel }
}

/**
 * The parser's match for a set of changed files (path to its changed line numbers): an exact key, a refusal, the
 * changed paths a value names only by different letter case, or nothing (an unchanged file, built output).
 */
export const sfMatcher = (changed: ReadonlyMap<string, ReadonlySet<number>>, place: Place): ((sf: string) => SfMatch) => {
  const byLower = new Map<string, string[]>()
  for (const path of changed.keys()) {
    const lower = path.toLowerCase()
    byLower.set(lower, [...(byLower.get(lower) ?? []), path])
  }

  return (sf: string): SfMatch => {
    const resolved = resolveSf(sf, place)
    if ('refuse' in resolved) return resolved
    const wanted = changed.get(resolved.rel)
    if (wanted !== undefined) return { key: resolved.rel, wanted }
    const cased = byLower.get(resolved.rel.toLowerCase())

    return cased === undefined ? null : { caseOf: cased }
  }
}

/** A configured repository-relative path the layer may use: why it cannot, when it cannot. */
export type OptionPathRefusal = 'PATH_UNSET' | 'PATH_REFUSED'

/** Bytes of a path in UTF-8, without a decoder or `Buffer` (neither is part of the host's declared API). */
export const utf8Length = (text: string): number => {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }

  return bytes
}

const MAX_PATH_BYTES = 4096

/**
 * A repository-relative path as a person may configure it: relative, no `.`, `..` or empty segment, no backslash, no
 * control character, no glob, never inside `.git`, at most 4,096 bytes. Anything else is refused, never repaired.
 */
const optionPath = (value: string, isPrefix: boolean): { rel: string } | { refuse: OptionPathRefusal } => {
  if (value === '') return { refuse: 'PATH_UNSET' }
  if (utf8Length(value) > MAX_PATH_BYTES || value.startsWith('/') || value.includes('\\') || CONTROL.test(value) || /[*?[\]{}]/.test(value)) return { refuse: 'PATH_REFUSED' }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value !== value.trim()) return { refuse: 'PATH_REFUSED' }
  const parts = (isPrefix && value.endsWith('/') ? value.slice(0, -1) : value).split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')) return { refuse: 'PATH_REFUSED' }

  return { rel: value }
}

/** The one LCOV report the layer reads, from its person-only option. Unset means none: the layer has nothing to read. */
export const reportPathOf = (configured: string): { rel: string } | { refuse: OptionPathRefusal } => optionPath(configured, false)

/** The exclusion option: comma-separated path prefixes (not globs). Any refused entry refuses the whole option. */
export const excludePrefixesOf = (configured: string): { prefixes: string[] } | { refuse: 'PATH_REFUSED' } => {
  if (configured.trim() === '') return { prefixes: [] }
  const prefixes: string[] = []
  for (const entry of configured.split(',')) {
    const one = optionPath(entry.trim(), true)
    if ('refuse' in one) return { refuse: 'PATH_REFUSED' }
    prefixes.push(one.rel)
  }

  return { prefixes }
}

/** Whether a configured prefix covers a path: a whole segment (`test/` or `test`) or the path itself, never a partial name. */
export const isUnderPrefix = (path: string, prefix: string): boolean => {
  const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix

  return path === bare || path.startsWith(`${bare}/`)
}

// Characters shown as they are: letters, marks, numbers, punctuation, symbols and the plain space. Within those, the
// ones below are invisible or blank, and are escaped too (variation selectors, tag characters, the combining grapheme
// joiner, Khmer inherent vowels, the braille blank, the Hangul fillers).
const SHOWN = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u
const HIDDEN = /^[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\u{FE00}-\u{FE0F}\u{180B}-\u{180D}\u{034F}\u{17B4}\u{17B5}\u{2800}\u{3164}\u{115F}\u{1160}\u{FFA0}]$/u

/**
 * Repository-chosen text made safe to print, on one line: everything outside the shown classes becomes `\u{…}`, and so
 * does the backslash itself, so an escape cannot be forged. That covers controls, ESC, bidirectional controls,
 * zero-width and tag characters, U+2028/U+2029 and lone surrogates. Text longer than `max` code points is shortened in
 * the middle, by code point, never inside a surrogate pair or an escape.
 */
export const displayText = (text: string, max = 160): string => {
  const pieces = Array.from(text, char => (SHOWN.test(char) && char !== '\\' && !HIDDEN.test(char) ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`))
  const length = pieces.reduce((sum, piece) => sum + Array.from(piece).length, 0)
  if (length <= max) return pieces.join('')
  // whole pieces from each end, so no escape is cut: the front half first, then as much of the end as still fits
  const size = (piece: string) => Array.from(piece).length
  const budget = Math.max(2, max - 1)
  const head: string[] = [], tail: string[] = []
  let used = 0, i = 0
  while (i < pieces.length && used + size(pieces[i]!) <= Math.floor(budget / 2)) {
    head.push(pieces[i]!)
    used += size(pieces[i]!)
    i++
  }
  for (let j = pieces.length - 1; j >= i && used + size(pieces[j]!) <= budget; j--) {
    tail.unshift(pieces[j]!)
    used += size(pieces[j]!)
  }

  return `${head.join('')}…${tail.join('')}`
}
