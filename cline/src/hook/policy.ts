// Pure tool policy for Cline workers. No I/O: the hook and the tests call decide().
import { posix } from 'node:path'

export type Policy = {
  workdir: string
  /** Repository-relative owned paths in engine form ('/src/app', or '*' for the whole tree). */
  owned: string[]
  mode: 'read' | 'write'
  allowedTools: string[]
}
export type Verdict = { allow: boolean; reason: string }

/** Commands a worker may never run: other agents and launchers (recursive spawning),
 * privilege and sandbox tools, schedulers that start processes outside the sandbox,
 * and Git operations the supervisor alone performs. */
const DENY: { re: RegExp; why: string }[] = [
  { re: /(^|[\s;&|(`]|\$\()(?:npx\s+|bunx\s+|pnpm\s+dlx\s+)?(cline|cockpit-cline|claude|codex|aider|opencode|gemini|goose|cursor-agent)(\s|$)/, why: 'launching another agent is not allowed; request delegation through Cockpit instead' },
  { re: /(^|[\s;&|(`]|\$\()(sudo|su|doas|pkexec|bwrap|unshare|nsenter|chroot|setpriv|capsh)(\s|$)/, why: 'privilege and sandbox tools are not allowed' },
  { re: /(^|[\s;&|(`]|\$\()(systemd-run|at|batch|crontab|loginctl|launchctl)(\s|$)/, why: 'schedulers that start processes outside the sandbox are not allowed' },
  { re: /(^|[\s;&|(`]|\$\()git\s+(?:-C\s+\S+\s+)?(commit|push|pull|fetch|reset|checkout|switch|restore|clean|stash|rebase|merge|cherry-pick|revert|tag|branch|worktree|remote|config|update-ref|filter-branch|replace|am|apply\s+--index)\b/, why: 'Git history and refs are the supervisor\'s; workers edit files only' },
]
const PROTECTED = [/^\.git(\/|$)/, /^\.clinerules\/hooks(\/|$)/, /^\.cline\/hooks(\/|$)/, /(^|\/)\.git\/hooks(\/|$)/]

const pathsOf = (params: Record<string, unknown>): string[] => {
  const out: string[] = []
  for (const k of ['path', 'file_path', 'filePath', 'target', 'destination']) if (typeof params[k] === 'string') out.push(params[k] as string)
  for (const k of ['paths', 'files']) if (Array.isArray(params[k])) for (const v of params[k] as unknown[]) { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object' && typeof (v as { path?: unknown }).path === 'string') out.push((v as { path: string }).path) }
  return out
}

export const inside = (workdir: string, p: string): string | null => {
  const abs = posix.normalize(p.startsWith('/') ? p : posix.join(workdir, p))
  const root = posix.normalize(workdir).replace(/\/$/, '')
  if (abs === root) return ''
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null
}
export const ownedCovers = (owned: readonly string[], rel: string): boolean => owned.some(o => o === '*' || `/${rel}` === o || `/${rel}`.startsWith(`${o}/`))

export const decide = (policy: Policy, tool: string, params: Record<string, unknown>, guard: (cmd: string) => string[]): Verdict => {
  if (!tool) return { allow: false, reason: 'tool name missing' }
  if (!policy.allowedTools.includes(tool)) return { allow: false, reason: `tool "${tool}" is not allowed for this worker (allowed: ${policy.allowedTools.join(', ')})${/spawn|team_/.test(tool) ? '; sub-agents are admitted by Cockpit only' : ''}` }
  if (tool === 'editor') {
    if (policy.mode !== 'write') return { allow: false, reason: 'this task is read-only' }
    const paths = pathsOf(params)
    if (!paths.length) return { allow: false, reason: 'editor call names no path' }
    for (const p of paths) {
      const rel = inside(policy.workdir, p)
      if (rel === null) return { allow: false, reason: `"${p}" is outside the task worktree` }
      if (PROTECTED.some(re => re.test(rel))) return { allow: false, reason: `"${rel}" is protected (Git metadata or agent hooks)` }
      if (!ownedCovers(policy.owned, rel)) return { allow: false, reason: `"${rel}" is outside this task's ownership (${policy.owned.join(', ')})` }
    }
    return { allow: true, reason: 'edit inside owned paths' }
  }
  if (tool === 'run_commands') {
    const cmds = Array.isArray(params.commands) ? params.commands : typeof params.command === 'string' ? [params.command] : []
    if (!cmds.length) return { allow: false, reason: 'run_commands names no command' }
    for (const c of cmds) {
      if (typeof c !== 'string') return { allow: false, reason: 'command is not text' }
      for (const d of DENY) if (d.re.test(c)) return { allow: false, reason: `${d.why}: ${c.slice(0, 120)}` }
      const findings = guard(c)
      if (findings.length) return { allow: false, reason: `Cockpit guard: ${findings.join('; ')}` }
    }
    return { allow: true, reason: 'commands passed policy and guard' }
  }
  return { allow: true, reason: `${tool} is allowed` }
}
