// Repository deltas only. Never keep tool commands or entire large Write files.
export const REPLAY_MAX = 24
export const REPLAY_BYTES = 96_000
export const STEP_BYTES = 12_000
import type { ReplayStep } from '../types'
export type { ReplayStep } from '../types'
export const safeText = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
export const secretText = (text: string): boolean => /(?:-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY|(?:api[_-]?key|access[_-]?(?:token|key)(?:[_-]?id)?|token|password|secret|authorization)["']?\s*[=:]\s*["']?[^\s"']+|\bBearer\s+[A-Za-z0-9._~-]{8,}|\b(?:sk-ant-|sk-live-|sk_live_|sk_test_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i.test(text)
export const safeFile = (path: unknown): string => {
  if (typeof path !== 'string' || secretText(path)) return 'unknown'
  const clean = safeText(path).slice(0, 240)
  return /(?:^|\/)(?:\.ssh|\.aws|\.config\/gcloud)(?:\/|$)/i.test(clean) ? 'unknown' : /(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|key)|\.npmrc|\.netrc|.*(?:credentials|secrets).*)$/i.test(clean) ? 'unknown' : clean
}
export const replayStep = (step: ReplayStep): ReplayStep => {
  step = { ...step, file: safeFile(step.file) }
  const unsafe = step.file === 'unknown' || secretText(step.before) || secretText(step.after)
  const huge = step.before.length + step.after.length > STEP_BYTES
  return unsafe || huge ? { ...step, before: '', after: '', omitted: true } : { ...step, before: safeText(step.before), after: safeText(step.after) }
}
export const appendReplay = (steps: ReplayStep[], step: ReplayStep): ReplayStep[] => {
  if (steps.some(s => s.id === step.id)) return steps
  const out = [...steps, replayStep(step)].slice(-REPLAY_MAX)
  while (JSON.stringify(out).length > REPLAY_BYTES && out.length > 1) out.shift()
  return out
}
export const diffLines = (step: ReplayStep): string[] => {
  if (step.omitted) return ['snapshot omitted: sensitive, unavailable, or large content']
  const a = step.before.split('\n'), b = step.after.split('\n')
  let head = 0, tail = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return [`@@ ${step.scope} delta · line ${head + 1} @@`, ...a.slice(head, a.length - tail).map(s => `- ${s}`), ...b.slice(head, b.length - tail).map(s => `+ ${s}`)].slice(0, 240)
}

/** A common bounded timeline preserves v1 deltas and adds lifecycle explanations. */
export const replayTimeline = (ledger: import('../types').Ledger): { at:number; title:string; lines:string[] }[] => [
  ...ledger.replay.map(step => ({ at:step.at, title:`${step.kind} · ${step.file}`, lines:diffLines(step) })),
  ...(ledger.swarm?.events ?? []).map(e => {
    const task = ledger.swarm?.tasks.find(t=>t.id===e.taskId)
    return { at:e.at, title:`${e.kind.toUpperCase()} · ${e.taskId ?? e.wave}`, lines:[
      `agent ${e.agentId ?? 'unknown'} · wave ${e.wave}`, e.detail,
      ...(task ? [`${task.tier} · ${task.role} · why ${task.spawnReason}`, `objective ${task.objective}`, `ownership ${task.mode}: ${task.owned.join(', ')}`, `dependencies ${task.dependencies.join(', ') || 'none'}`, `current outcome ${task.state} · verification ${task.verification}`, `result ${task.result?.conclusion ?? 'unknown'}`] : []),
    ].map(line => secretText(line) ? 'unknown' : safeText(line)) }
  }),
].sort((a,b)=>a.at-b.at).slice(-280)
