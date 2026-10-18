// The repository as the HUD shows it: branch, HEAD, dirty count and
// ahead/behind, read from `git status --porcelain=v2 --branch`.

import type { GitState } from '../types'
import { REPO_REFUSAL_SHORT } from './git-integrity'

export type GitRead = Omit<GitState, 'startSha' | 'at' | 'project' | 'isRepo'>

/** Reads the header and entry lines of `git status --porcelain=v2 --branch`. */
export const parseStatus = (stdout: string): GitRead => {
  const read: GitRead = { branch: null, isDetached: false, sha: null, dirty: 0, ahead: null, behind: null }
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim()
      read.sha = oid === '(initial)' ? null : oid
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      read.isDetached = head === '(detached)'
      read.branch = read.isDetached ? null : head
    } else if (line.startsWith('# branch.ab ')) {
      const counts = /\+(\d+) -(\d+)/.exec(line)
      if (counts !== null) {
        read.ahead = Number(counts[1])
        read.behind = Number(counts[2])
      }
    } else if (/^[12u?] /.test(line)) {
      read.dirty += 1
    }
  }

  return read
}

export const shortSha = (sha: string | null): string => (sha === null ? '-------' : sha.slice(0, 7))

export const projectOf = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '')

  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/'
}

/** v0.6.6: why a repository was not read, in a word or two. */
const REFUSED_LABEL: Readonly<Record<NonNullable<GitState['refused']>, string>> = { inputs: 'unsafe Git inputs', submodule: REPO_REFUSAL_SHORT.submodule, 'partial-clone': REPO_REFUSAL_SHORT['partial-clone'], unreadable: REPO_REFUSAL_SHORT.unreadable, filter: 'active filter' }
/** Why a repository was not read, in a word or two; null when it was read (or is no repository). */
export const refusedReason = (git: GitState | null): string | null => (git === null || !git.isRepo || git.refused === undefined ? null : REFUSED_LABEL[git.refused])
/** Whether the HUD has something to warn about in the working tree: changes, or a repository it did not read (v0.6.6). */
export const treeNeedsAttention = (git: GitState | null): boolean => git !== null && git.isRepo && (git.refused !== undefined || git.dirty > 0)
/** `3 changed`, `clean`, `no repo`, or `not measured (submodule)`: the working tree in a word or two. A repository Cockpit did not read is never `clean`. */
export const dirtyLabel = (git: GitState | null): string => {
  if (git === null) return ''
  if (!git.isRepo) return 'no repo'
  if (git.refused !== undefined) return `not measured (${refusedReason(git)})`

  return git.dirty === 0 ? 'clean' : `${git.dirty} changed`
}

/** `↑1 ↓2`, or nothing where the branch has no upstream or is level with it. */
export const aheadBehindLabel = (git: GitState | null): string => {
  if (git === null || !git.isRepo || git.ahead === null || git.behind === null) return ''
  if (git.ahead === 0 && git.behind === 0) return ''

  return [git.ahead > 0 ? `↑${git.ahead}` : '', git.behind > 0 ? `↓${git.behind}` : '']
    .filter(Boolean)
    .join(' ')
}

/** `a1b2c3d → e4f5a6b` once HEAD has moved from where it started, else the one SHA. */
export const shaLabel = (start: string | null, current: string | null): string => {
  if (current === null && start === null) return ''
  if (start === null || start === current) return shortSha(current)

  return `${shortSha(start)}→${shortSha(current)}`
}

export const branchLabel = (git: GitState | null): string => {
  if (git === null || !git.isRepo) return ''
  if (git.isDetached) return 'detached'

  return git.branch ?? 'no branch'
}

/** NUL config records are key + newline + value. Git emits repeated values in precedence order. */
export const filterCommands = (stdout: string): Set<string> | null => {
  if (stdout !== '' && !stdout.endsWith('\0')) return null
  const effective = new Map<string, string>()
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const split = entry.indexOf('\n')
    if (split < 0) return null
    const key = entry.slice(0, split)
    if (!/^filter\..+\.(clean|process)$/.test(key)) return null
    effective.set(key, entry.slice(split + 1))
  }
  return new Set([...effective].filter(([, command]) => command.trim() !== '').map(([key]) => key.slice(7, key.lastIndexOf('.'))))
}
/** A malformed/incomplete attributes response is no proof; true means an active external clean/process filter. */
export const activeFilter = (stdout: string, drivers: Set<string>, paths: string): boolean | null => {
  if (stdout !== '' && !stdout.endsWith('\0')) return null
  const fields = stdout.split('\0'); fields.pop()
  const expected = paths.split('\0'); expected.pop()
  if (fields.length !== expected.length * 3) return null
  for (let i = 0; i < fields.length; i += 3) {
    if (fields[i] !== expected[i / 3] || fields[i + 1] !== 'filter' || !fields[i + 2]) return null
    if (drivers.has(fields[i + 2]!)) return true
  }
  return false
}
