// Cockpit PreToolUse hook for Cline workers (runs inside the worker's sandbox).
// Protocol (Cline 3.0.74 hooks-dir, observed): JSON on stdin with preToolUse{toolName,
// parameters}; the last JSON on stdout answers. {"cancel":true} aborts the whole run,
// which is the intended effect: a worker that breaks policy is stopped, not argued with.
// Every error path cancels. This hook is a policy layer; bubblewrap is the boundary.
import { appendFileSync, readFileSync } from 'node:fs'
import { assessCommand } from '../core/engine.ts'
import { decide } from './policy.ts'
import type { Policy } from './policy.ts'

const answer = (cancel: boolean, message?: string): void => {
  process.stdout.write(`${JSON.stringify(cancel ? { cancel: true, errorMessage: message ?? 'COCKPIT: refused' } : { cancel: false })}\n`)
}
const log = (file: string | undefined, entry: unknown): void => { if (!file) return; try { appendFileSync(file, `${JSON.stringify(entry)}\n`) } catch { /* log is best effort */ } }

const main = (): void => {
  let input: { preToolUse?: { toolName?: unknown; parameters?: unknown }; agent_id?: unknown }
  let policy: Policy
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}') as typeof input
    policy = JSON.parse(readFileSync(process.env.COCKPIT_POLICY ?? '', 'utf8')) as Policy
  } catch (e) { answer(true, `COCKPIT: hook could not read its input or policy (${(e as Error).message}); refusing`); return }
  const tool = typeof input.preToolUse?.toolName === 'string' ? input.preToolUse.toolName : ''
  const params = (input.preToolUse?.parameters ?? {}) as Record<string, unknown>
  const verdict = decide(policy, tool, params, cmd => assessCommand(cmd, { cwd: policy.workdir }).map(f => `${f.rule}: ${f.title}`))
  log(process.env.COCKPIT_HOOK_LOG, { at: new Date().toISOString(), tool, allow: verdict.allow, reason: verdict.reason, agent: input.agent_id ?? null })
  answer(!verdict.allow, verdict.allow ? undefined : `COCKPIT POLICY: ${verdict.reason}`)
}

try { main() } catch (e) { answer(true, `COCKPIT: hook failed (${(e as Error).message}); refusing`) }
