// Read-only Git inspection for subagents (v0.6.1): which shell commands count as inspection, and the command that is run.
//
// Two rules, for two kinds of ownership.
//
//   WILDCARD (`*`). The task may read the whole repository. A command is accepted when every command in it is a plain
//   `git diff|status|log|show|ls-files|rev-parse|grep` and none of its options is on the refusal list (output files,
//   external diff and textconv drivers, pagers, signature verification, custom formats). This is the v0.6.0 rule with
//   one correction: the `--` that separates revisions from paths is accepted, and what follows it is never an option.
//
//   SCOPED (named paths). The task may read only what it owns, and a read-only command does not widen that. Here the
//   rule is an allowlist: one plain git command; a subcommand from a short list; every option from that subcommand's own
//   list; revisions that are plain names (the caller then verifies each one is a commit, so none can address a tree or a
//   file); and an explicit `--` followed by literal paths, each of which the caller checks against the task's ownership.
//
// Neither rule runs the text the agent typed. `rebuildGit` writes the command again from the parsed words, every one in
// single quotes, behind `git --no-pager` and the safe flags, so a quoted argument stays data whatever it contains.
// Nothing here calls a process, reads a file or holds state; the caller canonicalizes paths and applies ownership.
//
// v0.6.6: neither rule lets a command examine a submodule (no submodule option is accepted; the rebuilt command ignores them
// and carries settings that keep any transport from running), and every rebuilt command, wildcard ones too, runs in the
// directory the caller verified, whatever directory the helper's own shell is in.

import { GIT_OVERRIDES, GIT_SAFE, HELPER_PINS } from './git-integrity'
import { parseShell, unwrap } from './shell'
import type { Simple } from './shell'

const WILDCARD_SUBCOMMANDS: readonly string[] = ['diff', 'status', 'log', 'show', 'ls-files', 'rev-parse', 'grep']
const NAMED_UNSAFE = /--(?:output|ext-diff|textconv)|--no-index/
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/
const REVISION_BRACES = /[@^]\{[A-Za-z0-9_ :\/+-]*(?:\.[A-Za-z0-9_ :\/+-]+)*\}/g

/** The text outside single quotes, with each quoted run reduced to `''`; null when a quote never closes. */
const outsideSingleQuotes = (command: string): string | null => {
  let out = ''
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string
    if (char === '\\') {
      out += command.slice(i, i + 2)
      i++
    } else if (char === '"') {
      let end = i + 1
      while (end < command.length && command[end] !== '"') end += command[end] === '\\' ? 2 : 1
      if (end >= command.length) return null
      out += command.slice(i, end + 1)
      i = end
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return null
      out += "''"
      i = end
    } else out += char
  }

  return out
}

/**
 * No redirection, substitution, expansion or second line. With `quotedLiterals`, `$ < >` and a backtick are allowed
 * inside single quotes, where a shell reads them as text: that is only sound for a command that is rebuilt before it
 * runs, so the commander's own commands, which run as typed, are judged without it.
 */
const isLexicallyPlain = (command: string, quotedLiterals: boolean): boolean => {
  // No second line and no control character at all (tab apart). A carriage return is a blank to the reader in ./shell
  // and a word character to bash, and a NUL can hide inside an option's name: neither is ever needed in an inspection.
  if (CONTROL.test(command) || NAMED_UNSAFE.test(command)) return false
  // As typed, bash expands braces, and it decides that on the text before quotes and backslashes are removed: a quoted
  // or escaped brace inside a group (`--{output=x\\},}`, `--{output=x,'{'}`) still leaves a group to expand. So no brace
  // at all is accepted in such a command, except a revision's own (`HEAD@{1}`, `stash@{0}`, `HEAD^{tree}`), which holds
  // no comma and no `..` and is left alone by bash.
  if (!quotedLiterals && /[{}]/.test(command.replace(REVISION_BRACES, ''))) return false
  const seen = quotedLiterals ? outsideSingleQuotes(command) : command

  return seen !== null && !/[<>`]/.test(seen) && !seen.includes('$')
}

// Long options that write a file, run a program, read outside the repository or print through a custom format.
// v0.6.6: and any that examines or recurses into a submodule, which could run what the submodule's own configuration names.
const REFUSED_LONG: readonly string[] = ['--output', '--open-files-in-pager', '--ext-diff', '--textconv', '--no-index', '--exec', '--help', '--show-signature', '--pretty', '--format', '--ignore-submodules', '--submodule', '--recurse-submodules']
/**
 * An option the wildcard rule refuses: it writes a file, runs a program or prints through a custom format.
 *
 * Git reads options more loosely than they are usually typed, and the refusal follows Git. A long option may be
 * abbreviated to any unambiguous prefix (`--op=sh` is `--open-files-in-pager=sh`), so a word is refused when its name is
 * a prefix of a refused option, or begins with one. Short options may be bundled, and `-O` takes the rest of its word as
 * a pager to run (git grep) or an order file to read (git diff), so `-nOsh` is `-n -Osh`: any one-dash word with an `O`
 * in it is refused, at the cost of refusing a harmless value that happens to contain the letter (`-SOWNER`).
 */
const isRefusedOption = (a: string): boolean => {
  if (a.includes('%G')) return true
  if (a.startsWith('--')) {
    const name = a.split('=')[0] as string

    return REFUSED_LONG.some(option => option.startsWith(name) || name.startsWith(option)) || a === '--exec' || a.startsWith('--open') || a.startsWith('--out') || a.startsWith('--ext') || a.startsWith('--text')
  }

  return a === '-c' || a === '-h' || (a.startsWith('-') && a.includes('O'))
}
// What only bash would do to a word, and the reader in ./shell does not model: a filename pattern that could become an
// option, either inside an option or at the start of a word (`*` matches a file called `--output=x` as readily as any
// other). A command that runs as typed must contain neither; a rebuilt one cannot, because every word of it is quoted
// again. A pattern after a directory (`hooks/*.ts`) expands only to names that begin with that directory, and is left
// alone. (Brace expansion is refused earlier, on the text itself: see `isLexicallyPlain`.)
const expandsInBash = (word: string): boolean => /^[*?[]/.test(word) || (word.startsWith('-') && /[*?[]/.test(word))

/** `git <subcommand> …` typed plainly: no wrapper, assignment, redirect or here-document. Its arguments, or null. */
const plainGitArgs = (c: Simple): string[] | null => {
  const r = unwrap(c.argv)
  if (r === null || r.program !== 'git' || r.wrappers.length > 0 || c.argv[0] !== 'git' || c.writes.length > 0 || c.heredoc !== null) return null

  return r.args
}

const isWildcardCommand = (c: Simple, isRebuilt: boolean): boolean => {
  const args = plainGitArgs(c)
  if (args === null || !WILDCARD_SUBCOMMANDS.includes(args[0] ?? '')) return false
  if (!isRebuilt && args.some(expandsInBash)) return false
  const separator = args.indexOf('--')
  const options = separator < 0 ? args : args.slice(0, separator)
  const paths = separator < 0 ? [] : args.slice(separator + 1)

  // What follows `--` is a path to Git unless an option before it swallowed the `--` as its value; a path that begins
  // with a dash is refused, so no word is left that could be read as an option without having been checked as one.
  return !options.some(isRefusedOption) && !paths.some(p => p.startsWith('-') || p.includes('%G'))
}

const isInspection = (command: string, quotedLiterals: boolean): boolean => {
  if (!isLexicallyPlain(command, quotedLiterals)) return false
  try {
    const parsed = parseShell(command)
    if (parsed.pipelines.length === 0 || parsed.substitutions.length > 0) return false

    return parsed.pipelines.every(p => p.commands.every(c => isWildcardCommand(c, quotedLiterals)))
  } catch { return false }
}

/** The commander's own command is read-only Git inspection: it runs as typed, so nothing quoted is taken on trust. */
export const readOnlyShell = (command: string): boolean => isInspection(command, false)
/** A wildcard subagent's command is read-only Git inspection. It is rebuilt before it runs (`rebuildGit`). */
export const agentInspection = (command: string): boolean => isInspection(command, true)

// ---------------------------------------------------------------------------
// The scoped rule.
// ---------------------------------------------------------------------------

export type ScopedSub = 'diff' | 'show' | 'log' | 'status' | 'grep' | 'ls-files'

type Spec = {
  /** Options that stand alone. Short ones may be bundled (`-ni`). */
  flags: ReadonlySet<string>
  /** Options written in one word with their value. */
  attached: readonly RegExp[]
  /** Options whose value is the next word, a small number. */
  counts: ReadonlySet<string>
  /** Options whose value is the next word, a search pattern. */
  patterns: ReadonlySet<string>
  /** Whether revisions may be named before `--`. */
  takesRevisions: boolean
}

// How a diff is displayed. None of these reads a file other than the ones the paths name: no -L (a line range of a named
// file), no -O (an order file), no --no-index, no copy detection (-C, --find-copies-harder), no --follow (which walks a
// file's history under the names it had before, wherever they were), no external driver.
const PATCH_FLAGS: readonly string[] = [
  '-p', '-u', '--patch', '-s', '--no-patch', '--stat', '--numstat', '--shortstat', '--summary', '--compact-summary', '--name-only', '--name-status',
  '-w', '--ignore-all-space', '-b', '--ignore-space-change', '--ignore-blank-lines', '--no-color', '--no-renames', '-M', '--find-renames',
  '--word-diff', '--full-index', '--abbrev-commit', '--minimal', '--patience', '--histogram',
]
const PATCH_ATTACHED: readonly RegExp[] = [/^-U\d{1,4}$/, /^--unified=\d{1,4}$/, /^--stat=\d{1,4}(?:,\d{1,4}){0,2}$/, /^--color=(?:never|always|auto)$/, /^--abbrev=\d{1,2}$/, /^--diff-filter=[A-Za-z*]{1,12}$/]
const DATE = /^--(?:since|until|after|before)=[\w .:,+\/-]{1,40}$/
const NONE: ReadonlySet<string> = new Set()

const SCOPED: Record<ScopedSub, Spec> = {
  diff: { flags: new Set([...PATCH_FLAGS, '--cached', '--staged', '--merge-base']), attached: PATCH_ATTACHED, counts: NONE, patterns: NONE, takesRevisions: true },
  show: { flags: new Set([...PATCH_FLAGS, '--oneline']), attached: PATCH_ATTACHED, counts: NONE, patterns: NONE, takesRevisions: true },
  log: {
    flags: new Set([...PATCH_FLAGS, '--oneline', '--no-merges', '--merges', '--first-parent', '--reverse', '--graph', '--decorate', '--no-decorate', '--all', '--date-order', '--topo-order']),
    attached: [...PATCH_ATTACHED, /^-\d{1,4}$/, /^--max-count=\d{1,4}$/, /^--skip=\d{1,6}$/, DATE, /^--author=[^\n]{1,120}$/, /^--grep=[^\n]{1,200}$/, /^--date=(?:short|iso|iso-strict|relative|local|default|unix|rfc|human)$/, /^-S[^\n]{1,200}$/],
    counts: new Set(['-n']), patterns: NONE, takesRevisions: true,
  },
  status: { flags: new Set(['-s', '--short', '-b', '--branch', '--porcelain', '--long', '--no-renames', '-uno', '-unormal', '-uall']), attached: [/^--porcelain=v[12]$/, /^--untracked-files=(?:no|normal|all)$/], counts: NONE, patterns: NONE, takesRevisions: false },
  grep: {
    flags: new Set(['-n', '--line-number', '-i', '--ignore-case', '-l', '--files-with-matches', '--name-only', '-w', '--word-regexp', '-F', '--fixed-strings', '-E', '--extended-regexp', '-I', '-r', '--recursive', '--untracked', '--cached', '--count', '-o', '--only-matching', '-v', '--invert-match', '--heading', '--break', '--and', '--or', '--not', '--all-match', '--column', '--no-color']),
    attached: [/^-[ABC]\d{1,3}$/, /^--max-count=\d{1,4}$/, /^--max-depth=\d{1,2}$/],
    counts: new Set(['-A', '-B', '-C', '-m']), patterns: new Set(['-e']), takesRevisions: true,
  },
  'ls-files': { flags: new Set(['--cached', '-m', '--modified', '-o', '--others', '--exclude-standard', '-d', '--deleted', '-s', '--stage', '--full-name']), attached: [], counts: NONE, patterns: NONE, takesRevisions: false },
}

export const SCOPED_SUBCOMMANDS = Object.keys(SCOPED) as ScopedSub[]
/** The most paths and revisions one scoped command may name: each costs the caller a check. */
export const SCOPED_MAX_PATHS = 32
export const SCOPED_MAX_COMMITS = 8

// A revision name without `:` (which addresses a file or a tree inside a commit) and without braces (`^{tree}`, `@{…}`).
const REV_NAME = /^[A-Za-z0-9@][A-Za-z0-9_.\/~^@-]{0,199}$/
/** The commits a revision word names (`a`, `^a`, `a..b`, `a...b`, `a..`), or null when it is not a plain revision. */
const endpointsOf = (word: string): string[] | null => {
  const isExcluded = word.startsWith('^')
  const body = isExcluded ? word.slice(1) : word
  const parts = body.includes('...') ? body.split('...') : body.includes('..') ? body.split('..') : [body]
  if (parts.length > 2 || (isExcluded && parts.length !== 1)) return null
  const names = parts.filter(p => p !== '')

  return names.length > 0 && names.every(n => REV_NAME.test(n) && !n.includes('..')) ? names : null
}
/** A path as Git stores it, relative to the repository root: no leading slash or dash, no `.`/`..` step, nothing a pattern would use. */
const isTreePath = (path: string): boolean => path !== '' && !/^[\/~:-]/.test(path) && !/[*?\[\]{}\\\n]/.test(path) && !path.split('/').some(part => part === '' || part === '.' || part === '..')
/** A path given after `--`: literal, not pathspec magic (`:(glob)`, `:!`), not home-relative, not an option look-alike. */
const isLiteralPath = (path: string): boolean => path !== '' && !/^[~:-]/.test(path) && !/[*?\[\]{}\n]/.test(path)

export type ScopedGit = {
  sub: ScopedSub
  /** The vetted words between the subcommand and `--`, as typed and in order: options, grep's pattern, revisions, objects. */
  words: string[]
  /** Every revision named, to be verified as a commit before the command runs. */
  commits: string[]
  /** `git show <rev>:<path>`: a file at a revision; `path` is relative to the repository root and must be owned. */
  objects: { rev: string; path: string }[]
  /** The paths after `--`, as typed; each must be owned. */
  paths: string[]
}
export type ScopedVerdict = { ok: true; git: ScopedGit } | { ok: false; isGit: boolean; reason: string }

export const SCOPED_FORM = 'git diff|show|log|status|grep|ls-files [options] [revisions] -- <path inside your scope>…'

/**
 * Reads a command under the scoped rule. `ok` says only that the command has the allowed shape: the caller must still
 * verify that every name in `commits` is a commit, that every path in `paths` and `objects` is inside the task's
 * owned resources, and must run `rebuildGit`'s output and never the original text.
 */
export const scopedGit = (command: string): ScopedVerdict => {
  const isGit = /^\s*git(?:\s|$)/.test(command)
  const refuse = (reason: string): ScopedVerdict => ({ ok: false, isGit, reason })
  if (!isLexicallyPlain(command, true)) return refuse(`a scoped Git inspection is one plain command: no redirect, substitution, variable, second line, output file or external driver. Form: ${SCOPED_FORM}`)
  let args: string[] | null = null
  try {
    const parsed = parseShell(command)
    const only = parsed.substitutions.length === 0 && parsed.pipelines.length === 1 && parsed.pipelines[0]!.commands.length === 1 ? parsed.pipelines[0]!.commands[0] : undefined
    args = only === undefined ? null : plainGitArgs(only)
  } catch { args = null }
  if (args === null) return refuse(`a scoped Git inspection is one plain git command: no pipe, chain, wrapper or assignment. Form: ${SCOPED_FORM}`)
  const sub = args[0] ?? ''
  if (!(SCOPED_SUBCOMMANDS as string[]).includes(sub)) return refuse(`"git ${sub.slice(0, 24)}" is not available under a narrow scope; the subcommand comes first and is one of ${SCOPED_SUBCOMMANDS.join(', ')}. Use Read for a file you own`)
  const spec = SCOPED[sub as ScopedSub]
  const rest = args.slice(1)
  const options: string[] = []
  const positionals: { word: string; at: number }[] = []
  const words: string[] = []
  const paths: string[] = []
  let hasPatternOption = false
  let separator = -1
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] as string
    if (word === '--') { separator = i; break }
    if (!word.startsWith('-')) { positionals.push({ word, at: words.length }); words.push(word); continue }
    const isBundle = /^-[A-Za-z]{2,6}$/.test(word) && [...word.slice(1)].every(letter => spec.flags.has(`-${letter}`))
    if (spec.flags.has(word) || isBundle || spec.attached.some(shape => shape.test(word))) { options.push(word); words.push(word); continue }
    if (spec.counts.has(word) || spec.patterns.has(word)) {
      const value = rest[i + 1]
      // a value that begins with a dash could be an option to Git, or the `--` itself: neither is taken as a value
      if (value === undefined || value.startsWith('-')) return refuse(`${word} needs a value that does not begin with a dash`)
      if (spec.counts.has(word) && !/^\d{1,4}$/.test(value)) return refuse(`${word} takes a small number`)
      if (spec.patterns.has(word)) hasPatternOption = true
      options.push(word); words.push(word, value); i++
      continue
    }

    return refuse(`"${word.slice(0, 40)}" is not on the list of options git ${sub} may take under a narrow scope (a fixed list of display and search options; nothing that names another file, an output, a format or a program). Drop it, or ask the commander for a wildcard read scope if the work needs it`)
  }
  if (separator >= 0) paths.push(...rest.slice(separator + 1))
  if (paths.length > SCOPED_MAX_PATHS) return refuse(`at most ${SCOPED_MAX_PATHS} paths in one command`)
  const badPath = paths.find(p => !isLiteralPath(p))
  if (badPath !== undefined) return refuse(`"${badPath.slice(0, 60)}" is not a literal path: no wildcard, pathspec magic (a leading ":"), "~" or leading dash. Name the files or directories themselves`)

  const commits: string[] = []
  const objects: { rev: string; path: string }[] = []
  let plainRevisions = 0
  // with -e, every positional word of git grep is a revision; without it the first one is the pattern
  const patternAt = sub === 'grep' && !hasPatternOption ? positionals[0]?.at ?? -1 : -1
  if (sub === 'grep' && !hasPatternOption && positionals.length === 0) return refuse('git grep needs a pattern')
  for (const { word, at } of positionals) {
    if (at === patternAt) continue
    if (!spec.takesRevisions) return refuse(`git ${sub} takes no revision here; "${word.slice(0, 40)}" must come after "--" if it is a path`)
    const object = sub === 'show' ? /^([^:]+):([^:]+)$/.exec(word) : null
    if (object !== null) {
      const rev = endpointsOf(object[1] as string)
      if (rev === null || rev.length !== 1 || rev[0] !== object[1] || !isTreePath(object[2] as string)) return refuse(`"${word.slice(0, 60)}" is not <revision>:<path> with a plain revision and a path from the repository root`)
      commits.push(rev[0] as string)
      objects.push({ rev: rev[0] as string, path: object[2] as string })
      continue
    }
    const named = endpointsOf(word)
    if (named === null) return refuse(`"${word.slice(0, 60)}" is not a plain revision. Under a narrow scope a revision is a branch, tag or commit id, optionally a range (a..b, a...b); ":" and "{}" forms address trees and files outside the scope. ${sub === 'show' ? 'To read one file at a revision: git show <revision>:<path inside your scope>' : 'If it is a path, put it after "--"'}`)
    commits.push(...named)
    plainRevisions++
  }
  if (commits.length > SCOPED_MAX_COMMITS) return refuse(`at most ${SCOPED_MAX_COMMITS} revisions in one command`)
  // a file at a revision names its own path; everything else shows only what the paths after `--` select
  const needsPaths = !(sub === 'show' && objects.length > 0 && plainRevisions === 0)
  if (needsPaths && paths.length === 0) return refuse(`name what to read: end the command with "--" and one or more paths inside your scope. Form: ${SCOPED_FORM}`)

  return { ok: true, git: { sub: sub as ScopedSub, words, commits: [...new Set(commits)], objects, paths } }
}

const quote = (word: string): string => `'${word.replace(/'/g, "'\\''")}'`
const NO_DRIVERS: readonly string[] = ['diff', 'show', 'log']
/** v0.6.6: subcommands that would otherwise compare a submodule. No helper word can ask for one (REFUSED_LONG), so this one stands. */
const NO_SUBMODULES: readonly string[] = ['diff', 'show', 'log', 'status']
const hardened = (sub: string, before: readonly string[], rest: readonly string[]): string =>
  ['git', '--no-pager', ...GIT_SAFE, ...GIT_OVERRIDES, ...HELPER_PINS, ...before, sub, ...(NO_DRIVERS.includes(sub) ? ['--no-ext-diff', '--no-textconv'] : []), ...(NO_SUBMODULES.includes(sub) ? ['--ignore-submodules=all'] : []), ...rest].map(quote).join(' ')

/** Where a scoped command runs and what it may read: the verified session directory and the canonical, owned paths. */
export type ScopedPin = { git: ScopedGit; dir: string; paths: readonly string[] }

/**
 * The command that runs in place of an accepted inspection: every word single-quoted, behind `--no-pager` and the safe
 * flags, external diff and textconv switched off, repository hooks and a configured diff order file overridden (v0.6.4),
 * submodules ignored and no transport allowed (v0.6.6). Every command is pinned with `-C` to `dir`, the directory the caller
 * verified (v0.6.6; before, only a scoped one was): a passing check of one directory says nothing about another. A scoped
 * command is given its paths as the canonical absolute ones that were checked, after an explicit `--`.
 */
export const rebuildGit = (command: string, dir: string, pin?: ScopedPin): string => {
  if (pin !== undefined) return hardened(pin.git.sub, ['-C', pin.dir], [...pin.git.words, '--', ...pin.paths])

  return parseShell(command).pipelines.map(p => {
    const pipeline = p.commands.map(c => hardened(c.argv[1] as string, ['-C', dir], c.argv.slice(2))).join(' | ')

    return pipeline + (p.next === null ? '' : ` ${p.next} `)
  }).join('')
}
