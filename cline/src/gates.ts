// Verification gates, run by the supervisor after the worker has ended, never by the model.
// Command gates run in a fresh sandbox without network. The GIT gate checks the change's
// scope structurally; the SECURITY gate scans the added lines for credentials. A worker's
// claim of success is never a gate result.
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { secretText } from './core/engine.ts'
import { launch } from './sandbox.ts'
import { terminate } from './proc.ts'
import { changesOf, diffText, gitLinkProblem, scopeProblems } from './git.ts'
import type { Change } from './git.ts'

export type GateSpec = { name: string; command: string; required: boolean }
export type GateResult = { name: string; kind: 'command' | 'git' | 'security'; state: 'pass' | 'fail' | 'error'; command?: string; exitCode?: number | null; durationMs: number; evidence: string; outputSha256?: string }

export type GateEnv = { hide: string[]; shareDirs: { from: string; to: string }[]; timeoutSeconds: number; gitCommonDir: string | null }

export const runCommandGate = async (g: GateSpec, workdir: string, outDir: string, env: GateEnv, id: string): Promise<GateResult> => {
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const t0 = Date.now(); const file = join(outDir, `${g.name}.log`)
  const marker = `gate-${id}-${g.name}`
  const { child, identity } = launch({ workdir, writable: true, gitCommonDir: env.gitCommonDir, gitAdminDir: null, readOnly: [], readWrite: [], hide: env.hide, network: false, marker, env: {}, binds: env.shareDirs }, ['bash', '-c', g.command])
  const out = createWriteStream(file, { mode: 0o600 })
  child.stdout?.pipe(out); child.stderr?.pipe(out)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; void identity.then(i => terminate({ initPid: i.initPid, initStart: i.initStart, pidNs: i.pidNs, marker: i.marker, since: i.since })) }, env.timeoutSeconds * 1000)
  const code = await new Promise<number | null>(res => { child.on('exit', c => res(c)); child.on('error', () => res(null)) })
  clearTimeout(timer)
  const id2 = await identity
  await terminate({ initPid: id2.initPid, initStart: id2.initStart, pidNs: id2.pidNs, marker: id2.marker, since: id2.since }, true, 3000)
  await new Promise(r => out.end(r))
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const tail = text.split('\n').slice(-25).join('\n').slice(-2000)
  return { name: g.name, kind: 'command', command: g.command, exitCode: code, durationMs: Date.now() - t0, state: timedOut ? 'error' : code === 0 ? 'pass' : 'fail', evidence: timedOut ? `timed out after ${env.timeoutSeconds}s` : `exit ${code}${tail ? `\n${tail}` : ''}`, outputSha256: createHash('sha256').update(text).digest('hex') }
}

export const gitGate = async (workdir: string, covers: (rel: string) => boolean, mode: 'read' | 'write', admin: string | null = null, label = 'GIT'): Promise<{ result: GateResult; changes: Change[] }> => {
  const t0 = Date.now()
  try {
    const link = gitLinkProblem(workdir, admin)
    if (link) return { changes: [], result: { name: label, kind: 'git', state: 'fail', durationMs: Date.now() - t0, evidence: `worktree git link tampered: ${link}` } }
    const changes = await changesOf(workdir, admin)
    if (mode === 'read' && changes.length) return { changes, result: { name: label, kind: 'git', state: 'fail', durationMs: Date.now() - t0, evidence: `read-only task changed ${changes.length} path(s): ${changes.slice(0, 5).map(c => c.path).join(', ')}` } }
    const problems = await scopeProblems(workdir, changes, covers, admin)
    return { changes, result: { name: label, kind: 'git', state: problems.length ? 'fail' : 'pass', durationMs: Date.now() - t0, evidence: problems.length ? problems.slice(0, 8).map(p => `${p.path}: ${p.why}`).join('; ') : `${changes.length} changed path(s), all inside ownership; no gitlinks, escaping symlinks or hook files` } }
  } catch (e) { return { changes: [], result: { name: label, kind: 'git', state: 'error', durationMs: Date.now() - t0, evidence: `git inspection failed: ${(e as Error).message}` } } }
}

/** Scans added lines in chunks the engine's narrow credential patterns accept. */
export const securityGate = async (workdir: string, admin: string | null = null, label = 'SECURITY'): Promise<GateResult> => {
  const t0 = Date.now()
  try {
    const diff = await diffText(workdir, admin)
    const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1))
    const hits: number[] = []; let chunk: string[] = []; let size = 0; let start = 0
    const flush = (at: number): void => { if (chunk.length && secretText(chunk.join('\n'))) hits.push(start); chunk = []; size = 0; start = at }
    added.forEach((l, i) => { if (size + l.length > 15_000) flush(i); chunk.push(l.slice(0, 15_000)); size += l.length })
    flush(added.length)
    return { name: label, kind: 'security', state: hits.length ? 'fail' : 'pass', durationMs: Date.now() - t0, evidence: hits.length ? `credential-like text in added lines (chunks starting at added line ${hits.slice(0, 5).join(', ')})` : `${added.length} added line(s) scanned; no credential pattern` }
  } catch (e) { return { name: label, kind: 'security', state: 'error', durationMs: Date.now() - t0, evidence: `scan failed: ${(e as Error).message}` } }
}

/**
 * Files a gate's own command runs or reads its definition from. When a worker changed one,
 * the gate passing is the worker's word about itself, not independent evidence.
 */
export const gateDefinitionFiles = (g: GateSpec): string[] => {
  const files = new Set<string>()
  if (/\b(?:npm|pnpm|yarn|bun|npx)\b/.test(g.command)) files.add('package.json')
  if (/\bmake\b/.test(g.command)) files.add('Makefile')
  for (const tok of g.command.split(/[\s;&|()'"]+/)) if (/^[\w./-]+\.(?:m?[jt]sx?|c?js|py|sh|rb|go|json|toml|ya?ml|cfg|ini)$/.test(tok) && !tok.startsWith('/') && !tok.includes('..')) files.add(tok.replace(/^\.\//, ''))
  return [...files]
}

/** package.json scripts that exist become gates; nothing is invented when none exist. */
export const detectGates = (root: string): GateSpec[] => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return ['typecheck', 'lint', 'test', 'build'].filter(s => pkg.scripts?.[s]).map(s => ({ name: s, command: `npm run --silent ${s}`, required: true }))
  } catch { return [] }
}
