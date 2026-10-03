// The repository as the HUD shows it: branch, HEAD, dirty count and
// ahead/behind, read from `git status --porcelain=v2 --branch`.

import type { GitState } from '../types'

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

/** `3 changed`, `clean`, `no repo`: the working tree in a word or two. */
export const dirtyLabel = (git: GitState | null): string => {
  if (git === null) return ''
  if (!git.isRepo) return 'no repo'

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
