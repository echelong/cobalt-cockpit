// Git operations. Only the supervisor runs these; workers cannot (read-only git dir,
// policy refuses git mutations). Nothing here touches the person's branch or main:
// work lands on the mission branch cockpit/<mission>, and only after verification.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export type Git = (args: string[], opts?: { cwd?: string; env?: Record<string, string>; allowFail?: boolean; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>

export const git: Git = (args, opts = {}) => new Promise(res => {
  execFile('git', args, { cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env }, maxBuffer: 64 << 20, timeout: opts.timeoutMs ?? 120_000 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
    if (code !== 0 && !opts.allowFail) res({ code, stdout, stderr: stderr || String(err) })
    else res({ code, stdout, stderr })
  })
})
const must = async (args: string[], cwd: string, env?: Record<string, string>): Promise<string> => {
  const r = await git(args, { cwd, env })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim().slice(0, 400)}`)
  return r.stdout.trim()
}

export type RepoInfo = { root: string; commonDir: string; head: string; branch: string | null; dirty: boolean }
export const repoInfo = async (dir: string): Promise<RepoInfo> => {
  const root = await must(['rev-parse', '--show-toplevel'], dir)
  const common = await must(['rev-parse', '--git-common-dir'], root)
  const head = await must(['rev-parse', 'HEAD'], root)
  const b = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, allowFail: true })
  const st = await must(['status', '--porcelain', '--untracked-files=normal'], root)
  return { root, commonDir: isAbsolute(common) ? common : resolve(root, common), head, branch: b.code === 0 ? b.stdout.trim() : null, dirty: st.length > 0 }
}

/**
 * Host-side git on a worktree a worker wrote to. The repository's config and the
 * worktree's admin dir are read-only to workers, and these options keep host git
 * from running anything the working tree can name: no fsmonitor, no hooks, no
 * optional locks, and the git dir pinned instead of discovered from the tree.
 */
export const pinned = (dir: string, admin: string | null): string[] => [...(admin ? ['--git-dir', admin, '--work-tree', dir] : []), '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-optional-locks']

/** The worktree's .git link must still name its own admin dir. */
export const gitLinkProblem = (dir: string, admin: string | null): string | null => {
  if (!admin) return null
  try {
    const st = lstatSync(join(dir, '.git'))
    if (!st.isFile()) return '.git is no longer a file'
    const text = readFileSync(join(dir, '.git'), 'utf8').trim()
    if (!text.startsWith('gitdir: ')) return `.git is not a gitdir link (${text.slice(0, 120)})`
    // compared by real path: relative worktree links (worktree.useRelativePaths) and symlinked repos are the same dir
    const target = text.slice('gitdir: '.length)
    let a: string, b: string
    try { a = realpathSync(isAbsolute(target) ? target : resolve(dir, target)); b = realpathSync(admin) } catch { return `.git now points to ${target.slice(0, 200)} (unresolvable)` }
    if (a !== b) return `.git now points to ${target.slice(0, 200)}`
    return null
  } catch (e) { return `.git unreadable: ${(e as Error).message}` }
}

export const missionBranch = (missionId: string): string => `cockpit/${missionId}`

/** Creates the mission branch at `base` (never moves an existing ref) and its integration worktree. */
export const createIntegration = async (repo: RepoInfo, missionId: string, base: string, dir: string): Promise<void> => {
  const ref = `refs/heads/${missionBranch(missionId)}`
  const exists = await git(['show-ref', '--verify', '--quiet', ref], { cwd: repo.root, allowFail: true })
  if (exists.code === 0) throw new Error(`branch ${missionBranch(missionId)} already exists; refusing to reuse it`)
  await must(['branch', missionBranch(missionId), base], repo.root)
  await must(['worktree', 'add', dir, missionBranch(missionId)], repo.root)
}
export const addTaskWorktree = async (repo: RepoInfo, dir: string, base: string): Promise<{ adminDir: string }> => {
  await must(['worktree', 'add', '--detach', dir, base], repo.root)
  const gitFile = await must(['rev-parse', '--git-dir'], dir)
  return { adminDir: isAbsolute(gitFile) ? gitFile : resolve(dir, gitFile) }
}
export const headOf = (dir: string): Promise<string> => must(['rev-parse', 'HEAD'], dir)

export type Change = { path: string; status: string }
/** Every tracked and untracked change in a worktree relative to its HEAD (ignored files excluded). */
export const changesOf = async (dir: string, admin: string | null = null): Promise<Change[]> => {
  // Not trimmed: a porcelain entry starts with a status column that may be a space (" M path").
  const r = await git([...pinned(dir, admin), 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: dir })
  if (r.code !== 0) throw new Error(`git status: ${r.stderr.trim().slice(0, 400)}`)
  const out = r.stdout
  const parts = out.split('\0').filter(Boolean); const changes: Change[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i].slice(0, 2); const path = parts[i].slice(3)
    changes.push({ path, status })
    // A rename or copy names its source next; the source is changed too and must be owned.
    if ((status.startsWith('R') || status.startsWith('C')) && parts[i + 1] !== undefined) { i++; if (status.startsWith('R')) changes.push({ path: parts[i], status: 'D ' }) }
  }
  return changes
}

export type ScopeProblem = { path: string; why: string }
/** Structural checks on a worktree's changes: ownership, Git metadata, gitlinks, escaping symlinks, hook injection. */
export const scopeProblems = async (dir: string, changes: Change[], covers: (rel: string) => boolean, admin: string | null = null): Promise<ScopeProblem[]> => {
  const problems: ScopeProblem[] = []
  for (const c of changes) {
    const p = c.path.replace(/\/$/, '')
    if (!covers(p)) problems.push({ path: p, why: 'outside task ownership' })
    if (/(^|\/)\.git(\/|$)/.test(p)) problems.push({ path: p, why: 'touches Git metadata' })
    if (/^\.clinerules\/hooks(\/|$)|^\.cline\/hooks(\/|$)|^\.githooks(\/|$)|^\.husky(\/|$)/.test(p)) problems.push({ path: p, why: 'adds or changes agent or Git hooks' })
    const abs = join(dir, p)
    try {
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) { const t = readlinkSync(abs); const target = isAbsolute(t) ? t : resolve(dir, p, '..', t); if (!target.startsWith(`${dir}/`)) problems.push({ path: p, why: `symlink points outside the worktree (${t})` }) }
      if (st.isDirectory() && existsSync(join(abs, '.git'))) problems.push({ path: p, why: 'nested repository or gitlink' })
    } catch { /* deleted path */ }
  }
  const ls = await git([...pinned(dir, admin), 'ls-files', '-s'], { cwd: dir })
  for (const line of ls.stdout.split('\n')) if (line.startsWith('160000 ')) problems.push({ path: line.split('\t')[1] ?? '?', why: 'gitlink (submodule) in index' })
  return problems
}

export const diffText = async (dir: string, admin: string | null = null): Promise<string> => {
  await must([...pinned(dir, admin), 'add', '-A', '--', '.'], dir)
  return must([...pinned(dir, admin), 'diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD'], dir)
}

/** Commits the staged worktree changes as the person's own Git identity; no tool attribution is added. */
export const commitTask = async (dir: string, message: string, admin: string | null = null): Promise<string> => {
  await must([...pinned(dir, admin), 'add', '-A', '--', '.'], dir)
  await must([...pinned(dir, admin), '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message], dir)
  return must([...pinned(dir, admin), 'rev-parse', 'HEAD'], dir)
}

/** Serial integration onto the mission branch. A conflict aborts the pick and reports it. */
export const integrate = async (integrationDir: string, commit: string): Promise<{ ok: true; head: string } | { ok: false; conflict: string }> => {
  // the picked tree is worker-authored: host git runs no hooks or fsmonitor it could name
  const r = await git([...pinned(integrationDir, null), '-c', 'commit.gpgsign=false', 'cherry-pick', '--allow-empty', '-x', commit], { cwd: integrationDir, allowFail: true })
  if (r.code === 0) return { ok: true, head: await headOf(integrationDir) }
  await git([...pinned(integrationDir, null), 'cherry-pick', '--abort'], { cwd: integrationDir, allowFail: true })
  return { ok: false, conflict: (r.stderr || r.stdout).trim().slice(0, 600) }
}

/** The mission-branch commit (base..HEAD) whose subject carries this task's `[taskId]` tag, if any. */
export const integratedCommitFor = async (integrationDir: string, base: string, taskId: string): Promise<string | null> => {
  const out = await must(['log', '--format=%H%x00%s', `${base}..HEAD`], integrationDir)
  for (const line of out.split('\n')) { const [sha, subject] = line.split('\x00'); if (subject?.endsWith(`[${taskId}]`)) return sha }
  return null
}

export const removeWorktree = async (repoRoot: string, dir: string): Promise<void> => { await git(['worktree', 'remove', '--force', dir], { cwd: repoRoot, allowFail: true }) }
