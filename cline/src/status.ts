// Execution lifecycle and outcome, kept apart. A mission can be FINISHED while its outcome is
// PARTIAL; only a DONE verdict (every acceptance and verification condition passed) reads VERIFIED.
// Everything here is derived from the live supervisor state; nothing is estimated.
import type { Live } from './supervisor.ts'

export type Lifecycle = 'RUNNING' | 'RETRYING' | 'WAITING' | 'BLOCKED' | 'FINISHED' | 'READY'
export type Outcome = 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED' | 'BLOCKED' | 'FAILED' | 'STOPPED' | null
export type Status = { lifecycle: Lifecycle; outcome: Outcome; label: string; counts: { running: number; retrying: number; waiting: number; held: number } }

export const statusOf = (live: Live, now = Date.now()): Status => {
  const tasks = Object.values(live.tasks)
  const running = tasks.filter(t => t.attempts.some(a => a.phase === 'reserved' || a.phase === 'dispatching' || a.phase === 'running')).length
  const held = tasks.filter(t => t.state === 'held').length
  const retrying = tasks.filter(t => t.state === 'queued' && (t.retryAt ?? 0) > now).length
  const waiting = tasks.filter(t => (t.state === 'queued' && !((t.retryAt ?? 0) > now)) || t.state === 'verifying').length
  const counts = { running, retrying, waiting, held }
  const extra = (s: string[]): string => s.length ? ` · ${s.join(' · ')}` : ''
  if (running) return { lifecycle: 'RUNNING', outcome: null, label: `RUNNING ${running}${extra([retrying ? `${retrying} retrying` : '', waiting ? `${waiting} waiting` : '', held ? `${held} BLOCKED` : ''].filter(Boolean))}`, counts }
  if (retrying) return { lifecycle: 'RETRYING', outcome: null, label: `RETRYING ${retrying}${extra([waiting ? `${waiting} waiting` : '', held ? `${held} BLOCKED` : ''].filter(Boolean))}`, counts }
  if (held) return { lifecycle: 'BLOCKED', outcome: 'BLOCKED', label: `BLOCKED · ${held} task(s) hold ownership until recovery`, counts }
  if (waiting) return { lifecycle: 'WAITING', outcome: null, label: `WAITING ${waiting}`, counts }
  const v = live.verdict
  if (v) {
    const outcome: Outcome = v.state === 'DONE' ? 'VERIFIED' : v.state
    return { lifecycle: 'FINISHED', outcome, label: `FINISHED · ${outcome}`, counts }
  }
  return { lifecycle: 'READY', outcome: null, label: 'READY', counts }
}
