// Diff coverage (v0.7.0, Phase 2). Pure parsers for the data Git is allowed to hand Cockpit: a NUL-delimited raw change
// list, zero-context patch hunks, the generated-file attribute, untracked paths and a no-follow stat. Nothing here starts
// a process, reads a file or asks the host for a capability; register.tsx runs the bounded commands and hands the bytes in.
//
// Git is a repository-controlled program. Its output is therefore treated as untrusted: paths are keys, hunk counts must
// agree with the raw list, a truncated or contradictory answer refuses whole, and a Git path that is absolute, walks up,
// enters .git, contains a control or is not UTF-8 is refused rather than repaired.

import type { ChangedFile, SourceFacts } from './diffcov-classify'
import { kindOfMode } from './git-integrity'
import type { ReportStat } from './diffcov-lcov'
import { excludePrefixesOf, reportPathOf } from './diffcov-paths'

export type GitStatus = ChangedFile['status']
export type GitKind = ChangedFile['kind']

/** A changed path from `git diff --raw -z`, before its working-tree bytes are read. */
export type GitChange = {
  path: string
  oldPath: string | null
  status: GitStatus
  oldMode: string
  newMode: string
  kind: GitKind
  modeOnly: boolean
  binaryPatch: boolean
  added: number[]
  modified: number[]
  deletedLines: number
  generatedByAttribute: boolean
  source: SourceFacts | null
}

export class DiffParseError extends Error {
  readonly code: 'DIFF_MALFORMED' | 'DIFF_INCONSISTENT' | 'PATH_NOT_UTF8'
  constructor(code: DiffParseError['code'], detail: string) {
    super(detail)
    this.code = code
    this.name = 'DiffParseError'
  }
}

const MODE = /^[0-7]{6}$/
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const RAW = /^:([0-7]{6}) ([0-7]{6}) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ([A-Z][0-9]*)$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** A Git path as Cockpit may use it: relative, clean, UTF-8 text, never inside .git or shaped like a pathspec/option. */
export const isSafeGitPath = (path: string): boolean => {
  if (path === '' || path.startsWith('/') || path.startsWith('-') || path.includes('\\') || path.includes('\uFFFD') || CONTROL.test(path)) return false
  if (/^[A-Za-z]:/.test(path) || /[*?[\]{}]/.test(path)) return false
  const parts = path.split('/')
  return parts.every(part => part !== '' && part !== '.' && part !== '..') && !parts.some(part => part.toLowerCase() === '.git')
}

const kindOf = (mode: string, status: GitStatus): GitKind => {
  if (status === 'deleted') return 'none'
  if (mode === '120000') return 'symlink'
  if (mode === '160000') return 'submodule'
  return 'file'
}

const statusOf = (word: string): GitStatus => {
  const code = word[0]
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'T') return 'type-changed'
  if (code === 'M' || code === 'R' || code === 'C') return 'modified'
  throw new DiffParseError('DIFF_INCONSISTENT', `unmerged or unknown Git status ${word.slice(0, 12)}`)
}

/** Parses `git diff --raw -z --no-abbrev`; the order is Git's and is preserved. */
export const parseGitChanges = (raw: string): GitChange[] => {
  if (raw !== '' && !raw.endsWith('\0')) throw new DiffParseError('DIFF_MALFORMED', 'the raw change list does not end')
  const tokens = raw.split('\0')
  if (tokens.at(-1) === '') tokens.pop()
  const out: GitChange[] = []
  const seen = new Set<string>()
  for (let i = 0; i < tokens.length;) {
    const head = tokens[i++]
    if (head === undefined) break
    const match = RAW.exec(head)
    if (match === null) throw new DiffParseError('DIFF_MALFORMED', 'a malformed raw change record')
    const [, oldMode, newMode, , , word] = match
    const status = statusOf(word)
    const names = status === 'modified' && (word![0] === 'R' || word![0] === 'C') ? 2 : 1
    const paths = tokens.slice(i, i + names)
    if (paths.length !== names) throw new DiffParseError('DIFF_MALFORMED', 'a raw change record has no path')
    i += names
    const path = paths.at(-1)!
    const oldPath = names === 2 ? paths[0]! : null
    if (!isSafeGitPath(path) || (oldPath !== null && !isSafeGitPath(oldPath))) throw new DiffParseError('PATH_NOT_UTF8', 'a changed path is not a usable repository-relative path')
    if (seen.has(path)) throw new DiffParseError('DIFF_INCONSISTENT', 'the raw change list names a path twice')
    seen.add(path)
    out.push({
      path,
      oldPath,
      status,
      oldMode: oldMode!,
      newMode: newMode!,
      kind: kindOf(newMode!, status),
      modeOnly: false,
      binaryPatch: false,
      added: [],
      modified: [],
      deletedLines: 0,
      generatedByAttribute: false,
      source: null,
    })
  }
  return out
}

/** One `diff --git` block's changed lines. */
export type PatchHunk = {
  added: number[]
  modified: number[]
  deletedLines: number
  binary: boolean
  isNewFile: boolean
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parses a unified patch with zero context. `expected` is the number of raw change records the patch was asked to
 * describe; a block count that differs from it refuses the whole patch, because that would attach hunks to the wrong
 * files. Paths are not read from the patch: the raw list is the authority, and the block order is checked against it.
 */
export const parsePatch = (patch: string, expected: number): PatchHunk[] => {
  if (expected === 0) {
    if (patch.trim() !== '') throw new DiffParseError('DIFF_INCONSISTENT', 'a patch arrived for no changed path')
    return []
  }
  const lines = patch.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const blocks: PatchHunk[] = []
  let current: PatchHunk | null = null
  let inHunk = false
  let newFile = false
  let oldLine = 0
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0
  let startsEmpty = false
  const finish = () => {
    if (oldLeft > 0 || newLeft > 0) throw new DiffParseError('DIFF_INCONSISTENT', 'a patch hunk ends before the lines it declared')
    if (current !== null) blocks.push(current)
    current = null
    inHunk = false
    newFile = false
    startsEmpty = false
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) throw new DiffParseError('DIFF_MALFORMED', 'a combined or merge diff is not supported')
      finish()
      current = { added: [], modified: [], deletedLines: 0, binary: false, isNewFile: false }
      continue
    }
    if (current === null) {
      if (line === '') continue
      throw new DiffParseError('DIFF_MALFORMED', 'patch text outside a file block')
    }
    if (!inHunk) {
      if (line.startsWith('new file mode ')) { newFile = true; current.isNewFile = true; continue }
      if (line.startsWith('deleted file mode ')) continue
      if (line.startsWith('old mode ') || line.startsWith('new mode ') || line.startsWith('similarity index ') || line.startsWith('rename from ') || line.startsWith('rename to ') || line.startsWith('copy from ') || line.startsWith('copy to ')) continue
      if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') { current.binary = true; continue }
      const hunk = HUNK.exec(line)
      if (hunk === null) throw new DiffParseError('DIFF_MALFORMED', 'a malformed patch header')
      oldLine = Number(hunk[1])
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLine = Number(hunk[3])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      startsEmpty = oldLeft === 0
      inHunk = true
      continue
    }
    if (line.startsWith('@@')) {
      const hunk = HUNK.exec(line)
      if (hunk === null) throw new DiffParseError('DIFF_MALFORMED', 'a malformed patch hunk')
      oldLine = Number(hunk[1])
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLine = Number(hunk[3])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      startsEmpty = oldLeft === 0
      continue
    }
    if (line.startsWith('diff --git ')) throw new DiffParseError('DIFF_MALFORMED', 'a file block ended inside a hunk')
    if (line === '\\ No newline at end of file') continue
    // A blank line is a separator between file blocks, never a context line: a context line is a single space.
    if (line === '') continue
    const tag = line[0]
    if (tag === '+') {
      if (newLeft <= 0) throw new DiffParseError('DIFF_INCONSISTENT', 'a patch hunk has more added lines than it declared')
      if (newFile || startsEmpty) current.added.push(newLine)
      else current.modified.push(newLine)
      newLine++
      newLeft--
    } else if (tag === '-') {
      if (oldLeft <= 0) throw new DiffParseError('DIFF_INCONSISTENT', 'a patch hunk has more removed lines than it declared')
      current.deletedLines++
      oldLine++
      oldLeft--
    } else if (tag === ' ') {
      if (oldLeft <= 0 || newLeft <= 0) throw new DiffParseError('DIFF_INCONSISTENT', 'a patch hunk has more context lines than it declared')
      oldLine++
      newLine++
      oldLeft--
      newLeft--
    } else {
      throw new DiffParseError('DIFF_MALFORMED', 'a line inside a patch hunk has no +/-/space tag')
    }
    if (oldLeft === 0 && newLeft === 0) inHunk = false
  }
  finish()
  if (blocks.length !== expected) throw new DiffParseError('DIFF_INCONSISTENT', `the patch has ${blocks.length} file blocks for ${expected} changed paths`)
  return blocks
}

/** Adds the hunk facts to the raw list. The raw list and the patch must have the same order and length. */
export const mergePatches = (changes: readonly GitChange[], hunks: readonly PatchHunk[]): GitChange[] => {
  if (changes.length !== hunks.length) throw new DiffParseError('DIFF_INCONSISTENT', 'the raw and patch change lists differ in length')
  return changes.map((change, i) => {
    const hunk = hunks[i]!
    const lineChanges = hunk.added.length + hunk.modified.length + hunk.deletedLines
    return {
      ...change,
      added: [...new Set(hunk.added)].sort((a, b) => a - b),
      modified: [...new Set(hunk.modified)].sort((a, b) => a - b),
      deletedLines: hunk.deletedLines,
      binaryPatch: hunk.binary,
      modeOnly: change.oldMode !== change.newMode && lineChanges === 0 && !hunk.binary,
    }
  })
}

/** Parses `git ls-files --others --exclude-standard -z`; a duplicate or unsafe path refuses the listing. */
export const parseUntracked = (raw: string): GitChange[] => {
  if (raw !== '' && !raw.endsWith('\0')) throw new DiffParseError('DIFF_MALFORMED', 'the untracked list does not end')
  const out: GitChange[] = []
  for (const path of raw.split('\0').filter(Boolean)) {
    if (!isSafeGitPath(path)) throw new DiffParseError('PATH_NOT_UTF8', 'an untracked path is not a usable repository-relative path')
    out.push({ path, oldPath: null, status: 'untracked', oldMode: '000000', newMode: '000000', kind: 'file', modeOnly: false, binaryPatch: false, added: [], modified: [], deletedLines: 0, generatedByAttribute: false, source: null })
  }
  return out
}

/** `git check-attr -z --stdin linguist-generated`: path, attribute, value triples. */
export const parseGeneratedAttributes = (raw: string): Set<string> => {
  if (raw !== '' && !raw.endsWith('\0')) throw new DiffParseError('DIFF_MALFORMED', 'the attribute answer does not end')
  const fields = raw.split('\0')
  if (fields.at(-1) === '') fields.pop()
  if (fields.length % 3 !== 0) throw new DiffParseError('DIFF_MALFORMED', 'the attribute answer is not path/attribute/value triples')
  const out = new Set<string>()
  for (let i = 0; i < fields.length; i += 3) {
    const [path, name, value] = [fields[i]!, fields[i + 1]!, fields[i + 2]!]
    if (!isSafeGitPath(path) || name !== 'linguist-generated') throw new DiffParseError('DIFF_MALFORMED', 'a malformed attribute answer')
    if (value === 'set' || value === 'true') out.add(path)
  }
  return out
}

/** The no-follow stat format: mode, size, links, inode, mtime, ctime, name (NUL terminated). */
export const REPORT_STAT_GNU = '%f %s %h %i %.9Y %.9Z %n\\0'
const REPORT_STAT = /^([0-9a-f]+) (\d+) (\d+) (\d+) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) ([\s\S]+)$/

/** One GNU `stat --printf` record for a path, or null for a malformed one. */
export const reportStatOf = (record: string): (ReportStat & { name: string }) | null => {
  const match = REPORT_STAT.exec(record)
  if (match === null) return null
  const mode = parseInt(match[1]!, 16)
  const kind = kindOfMode(mode)
  const size = Number(match[2])
  const links = Number(match[3])
  if (kind === null || !Number.isSafeInteger(size) || !Number.isSafeInteger(links)) return null
  return { kind, size, links, identity: `${match[1]} ${match[2]} ${match[3]} ${match[4]} ${match[5]} ${match[6]}`, name: match[7]!.replace(/\0$/, '') }
}

/** A path's content identity as Git's object id, or `deleted` for a path with no working-tree bytes. */
export type IdentityEntry = { path: string; status: GitStatus; mode: string; blob: string }

/**
 * The source identity: SHA-256 of a canonical, path-sorted list of every changed path, its status, its mode and the
 * object id of its working-tree bytes. Git's object ids are content addresses, so this moves when a byte changes and
 * does not depend on timestamps. The caller must give `deleted` only for a path with no content.
 */
export const sourceIdentityOf = async (entries: readonly IdentityEntry[]): Promise<string> => {
  const sorted = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const text = sorted.map(e => `${e.path}\u0000${e.status}\u0000${e.mode}\u0000${e.blob}\n`).join('')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** The Phase 3 options, read once at registration. Nothing here starts work; `enabled` is the only gate. */
export type CoverageConfig = {
  enabled: boolean
  report: string
  reportPath: ReturnType<typeof reportPathOf>
  exclude: ReturnType<typeof excludePrefixesOf>
}
export const coverageConfigOf = (options: Readonly<Record<string, unknown>>): CoverageConfig => {
  const report = typeof options['coverageDiffReport'] === 'string' ? options['coverageDiffReport'] : ''
  const exclude = typeof options['coverageDiffExclude'] === 'string' ? options['coverageDiffExclude'] : ''
  return { enabled: options['coverageDiff'] === true, report, reportPath: reportPathOf(report), exclude: excludePrefixesOf(exclude) }
}
